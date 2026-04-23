import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logApiUsage } from "../_shared/posthogCapture.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ─── Kling API Model Mapping ─── */
interface ModelMapping {
  model: string;
  mode?: string;
  supports_camera_control: boolean;
  is_motion_control: boolean;
  is_omni?: boolean;
  endpoint_override?: string;
}

const KLING_MODEL_MAP: Record<string, ModelMapping> = {
  "kling-v1-pro":         { model: "kling-v1",         mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v1-5-pro":       { model: "kling-v1-5",       mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v1-6-pro":       { model: "kling-v1-6",       mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v2-master":      { model: "kling-v2-master",   mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v2-1-pro":       { model: "kling-v2-1",       mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v2-1-master":    { model: "kling-v2-1-master", mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v2-5-turbo":     { model: "kling-v2-5-turbo", mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v2-6-pro":       { model: "kling-v2-6",       mode: "pro", supports_camera_control: false, is_motion_control: false },
  "kling-v3-pro":         { model: "kling-v3",         mode: "pro", supports_camera_control: false, is_motion_control: false },
  
  "kling-v3-omni":        { model: "kling-v3-omni",    mode: "pro", supports_camera_control: false, is_motion_control: false, is_omni: true },
  "kling-v2-6-motion-pro": { model: "kling-v2-6",      mode: "pro", supports_camera_control: false, is_motion_control: true, endpoint_override: "/v1/videos/motion-control" },
  "kling-v3-motion-pro":   { model: "kling-v3",        mode: "pro", supports_camera_control: false, is_motion_control: true, endpoint_override: "/v1/videos/motion-control" },
};

/* ─── Camera Control Types ─── */
interface CameraControl {
  type: "simple" | "down_back" | "forward_up" | "right_turn_forward" | "left_turn_forward";
  config?: {
    horizontal?: number;
    vertical?: number;
    pan?: number;
    tilt?: number;
    roll?: number;
    zoom?: number;
  };
}

/* ─── JWT Token Generation ─── */
async function generateKlingJWT(accessKeyId: string, secretKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKeyId, exp: now + 1800, nbf: now - 5, iat: now };

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${signingInput}.${sigB64}`;
}

/* ─── Convert camera_control to text description (fallback) ─── */
function cameraControlToText(cc: CameraControl): string {
  const parts: string[] = [];

  if (cc.type !== "simple") {
    const typeMap: Record<string, string> = {
      down_back: "camera moves down and pulls back",
      forward_up: "camera moves forward and up",
      right_turn_forward: "camera turns right while moving forward",
      left_turn_forward: "camera turns left while moving forward",
    };
    parts.push(typeMap[cc.type] || "");
  }

  if (cc.config) {
    const { horizontal, vertical, pan, tilt, roll, zoom } = cc.config;
    if (pan && pan !== 0) parts.push(`camera pans ${pan > 0 ? "right" : "left"} ${pan > 0 ? "" : ""}(intensity ${Math.abs(pan)}/10)`);
    if (tilt && tilt !== 0) parts.push(`camera tilts ${tilt > 0 ? "up" : "down"} (intensity ${Math.abs(tilt)}/10)`);
    if (zoom && zoom !== 0) parts.push(`camera ${zoom > 0 ? "zooms in" : "zooms out"} (intensity ${Math.abs(zoom)}/10)`);
    if (roll && roll !== 0) parts.push(`camera rolls ${roll > 0 ? "clockwise" : "counter-clockwise"} (intensity ${Math.abs(roll)}/10)`);
    if (horizontal && horizontal !== 0) parts.push(`horizontal movement ${horizontal > 0 ? "right" : "left"} (intensity ${Math.abs(horizontal)}/10)`);
    if (vertical && vertical !== 0) parts.push(`vertical movement ${vertical > 0 ? "up" : "down"} (intensity ${Math.abs(vertical)}/10)`);
  }

  return parts.length > 0 ? `. Camera: ${parts.join(", ")}` : "";
}

/* ─── Validate Camera Control ─── */
function validateCameraControl(cc: CameraControl): string | null {
  const validTypes = ["simple", "down_back", "forward_up", "right_turn_forward", "left_turn_forward"];
  if (!validTypes.includes(cc.type)) return `Invalid camera_control type: ${cc.type}`;

  if (cc.config) {
    const fields = ["horizontal", "vertical", "pan", "tilt", "roll", "zoom"] as const;
    for (const field of fields) {
      const val = cc.config[field];
      if (val !== undefined && (typeof val !== "number" || val < -10 || val > 10)) {
        return `camera_control.config.${field} must be a number between -10 and 10`;
      }
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  let loggedUserId: string | null = null;
  let loggedModelId: string | null = null;
  let loggedSupabase: ReturnType<typeof createClient> | null = null;
  try {
    const KLING_ACCESS_KEY_ID = Deno.env.get("KLING_ACCESS_KEY_ID");
    const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!KLING_ACCESS_KEY_ID || !KLING_SECRET_KEY) {
      throw new Error("Kling API credentials not configured");
    }

    // Auth check
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    loggedSupabase = supabase;
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    loggedUserId = user.id;

    const body = await req.json();
    loggedModelId = (body?.model as string | undefined) ?? "kling-2-6-pro";
    const {
      prompt,
      model: modelId = "kling-2-6-pro",
      duration = 5,
      aspect_ratio = "16:9",
      image_url,
      image_tail_url,    // End frame image for I2V
      video_url,         // For motion control models
      negative_prompt,
      camera_control,
      cfg_scale,
      character_orientation, // For motion control: "video" | "image"
      keep_original_sound,   // For motion control: "yes" | "no"
    } = body;

    if (!prompt && !image_url) {
      return new Response(JSON.stringify({ error: "prompt or image_url is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate camera_control if provided
    if (camera_control) {
      const ccError = validateCameraControl(camera_control);
      if (ccError) {
        return new Response(JSON.stringify({ error: ccError }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Map model ID
    const mapping = KLING_MODEL_MAP[modelId];
    if (!mapping) {
      return new Response(JSON.stringify({ error: `Unknown model: ${modelId}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Motion control models require video_url + image_url
    if (mapping.is_motion_control && (!image_url || !video_url)) {
      return new Response(JSON.stringify({ error: "Motion control models require both image_url and video_url" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate JWT
    const jwtToken = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);

    // Determine endpoint
    let endpoint: string;
    if (mapping.is_omni) {
      endpoint = "https://api.klingai.com/v1/videos/omni-video";
    } else if (mapping.is_motion_control) {
      endpoint = `https://api.klingai.com${mapping.endpoint_override}`;
    } else if (image_url) {
      endpoint = "https://api.klingai.com/v1/videos/image2video";
    } else {
      endpoint = "https://api.klingai.com/v1/videos/text2video";
    }

    // Build prompt — inject camera description if model doesn't support native camera_control
    let finalPrompt = prompt || "";
    let usedNativeCameraControl = false;

    if (camera_control && !mapping.is_omni) {
      if (mapping.supports_camera_control) {
        usedNativeCameraControl = true;
      } else {
        const cameraText = cameraControlToText(camera_control);
        if (cameraText) {
          finalPrompt = `${finalPrompt}${cameraText}`;
          console.log(`[generate-video] camera_control fallback to text: "${cameraText}"`);
        }
      }
    }

    // Build request body
    const klingBody: Record<string, unknown> = {
      model_name: mapping.model,
      mode: mapping.mode,
    };

    if (mapping.is_omni) {
      // ── Omni: image_list + video_list + duration slider ──
      klingBody.duration = String(duration);
      klingBody.aspect_ratio = aspect_ratio;

      // image_list
      const imageList: Array<Record<string, string>> = [];
      if (image_url) imageList.push({ url: image_url, type: "first_frame" });
      if (image_tail_url) imageList.push({ url: image_tail_url, type: "end_frame" });
      if (imageList.length > 0) klingBody.image_list = imageList;

      // video_list
      if (video_url) klingBody.video_list = [{ url: video_url }];

      // Audio
      if (body.has_audio === "true" || body.has_audio === true) klingBody.sound = true;
      if (video_url && keep_original_sound) klingBody.keep_original_sound = keep_original_sound;

      // Multi-shot director mode
      const isMultiShot = body.multi_shot === "true" || body.multi_shot === true;
      if (isMultiShot && body.multi_prompt) {
        klingBody.multi_shot = true;
        klingBody.shot_type = "customize";
        let shots: Array<{ prompt: string; duration: number }>;
        if (typeof body.multi_prompt === "string") {
          try { shots = JSON.parse(body.multi_prompt); } catch { throw new Error("multi_prompt must be valid JSON"); }
        } else {
          shots = body.multi_prompt as Array<{ prompt: string; duration: number }>;
        }
        klingBody.multi_prompt = shots.map((s, i) => ({
          index: i + 1,
          prompt: s.prompt,
          duration: String(s.duration),
        }));
      } else {
        if (finalPrompt) klingBody.prompt = finalPrompt;
      }

      if (negative_prompt) klingBody.negative_prompt = negative_prompt;

      console.log(`[generate-video] User ${user.id} | OMNI model: ${modelId} (${mapping.model}/${mapping.mode}) | duration=${duration}s | images=${(klingBody.image_list as unknown[])?.length ?? 0} | videos=${video_url ? 1 : 0} | multi_shot=${isMultiShot}`);

    } else if (mapping.is_motion_control) {
      klingBody.prompt = finalPrompt;
      klingBody.image_url = image_url;
      klingBody.video_url = video_url;
      if (character_orientation) klingBody.character_orientation = character_orientation;
      if (keep_original_sound) klingBody.keep_original_sound = keep_original_sound;

      console.log(`[generate-video] User ${user.id} | MOTION model: ${modelId} (${mapping.model}/${mapping.mode})`);

    } else {
      klingBody.prompt = finalPrompt;
      klingBody.duration = String(duration);
      klingBody.aspect_ratio = aspect_ratio;

      if (image_url) {
        klingBody.image = image_url;
        if (image_tail_url) klingBody.image_tail = image_tail_url;
      }
      if (negative_prompt) klingBody.negative_prompt = negative_prompt;
      if (cfg_scale !== undefined) klingBody.cfg_scale = cfg_scale;
      if (usedNativeCameraControl) klingBody.camera_control = camera_control;

      console.log(`[generate-video] User ${user.id} | model: ${modelId} (${mapping.model}/${mapping.mode}) | motion: false | I2V: ${!!image_url} | camera: ${usedNativeCameraControl ? "native" : camera_control ? "text-fallback" : "none"}`);
    }

    // Call Kling API
    const klingResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify(klingBody),
    });

    const klingResult = await klingResponse.json();

    if (!klingResponse.ok || klingResult.code !== 0) {
      console.error("[generate-video] Kling API error:", JSON.stringify(klingResult));
      await logApiUsage(supabase, {
        user_id: user.id,
        endpoint: "generate-video",
        feature: "video_dispatch:kling",
        model: modelId,
        status: "error",
        duration_ms: Date.now() - startTime,
        error_message: String(klingResult.message || `HTTP ${klingResponse.status}`).substring(0, 500),
        request_metadata: { kling_code: klingResult.code, http_status: klingResponse.status, is_i2v: !!image_url },
      });
      return new Response(
        JSON.stringify({
          error: "Video generation failed",
          details: klingResult.message || "Unknown error from provider",
        }),
        {
          status: klingResponse.status >= 400 ? klingResponse.status : 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const taskId = klingResult.data?.task_id;

    await logApiUsage(supabase, {
      user_id: user.id,
      endpoint: "generate-video",
      feature: "video_dispatch:kling",
      model: modelId,
      status: "success",
      duration_ms: Date.now() - startTime,
      request_metadata: {
        task_id: taskId,
        kling_model: mapping.model,
        mode: mapping.mode,
        is_motion: mapping.is_motion_control,
        is_omni: !!mapping.is_omni,
        is_i2v: !!image_url,
      },
    });

    return new Response(
      JSON.stringify({
        task_id: taskId,
        model: modelId,
        status: "processing",
        poll_endpoint: "generate-video",
        camera_control_mode: usedNativeCameraControl ? "native" : camera_control ? "text_fallback" : "none",
        prompt_used: finalPrompt,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("[generate-video] Error:", e);
    try {
      const logClient = loggedSupabase ?? createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      );
      await logApiUsage(logClient, {
        user_id: loggedUserId ?? "system",
        endpoint: "generate-video",
        feature: "video_dispatch:kling",
        model: loggedModelId ?? undefined,
        status: "error",
        duration_ms: Date.now() - startTime,
        error_message: (e instanceof Error ? e.message : String(e)).substring(0, 500),
        request_metadata: { error_type: "top_level_catch" },
      });
    } catch (_) { /* best-effort */ }
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
