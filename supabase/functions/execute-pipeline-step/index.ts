/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { refundCreditsAtomic } from "../_shared/pricing.ts";
import { logApiUsage } from "../_shared/posthogCapture.ts";
import {
  executeWithInlineBudget,
  INLINE_BUDGET_ATTEMPTS,
  enqueueRetryJob,
  classifyError,
  TOTAL_MAX_RETRIES,
} from "../_shared/providerRetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ═══════════════════════════════════════════════════════════
   Helpers (duplicated from run-flow-init — shared module would be ideal)
   ═══════════════════════════════════════════════════════════ */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageBuffer(url: string): Promise<Uint8Array> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:[^;]+;base64,(.+)$/);
    if (match) {
      const bin = atob(match[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    throw new Error("Invalid data URI");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function imageUrlToBase64(url: string): Promise<string> {
  return bytesToBase64(await fetchImageBuffer(url));
}

/* ─── Image dimension extraction (lightweight header parsing) ─── */

interface ImageDimensions { width: number; height: number }

function extractImageDimensions(buf: Uint8Array): ImageDimensions | null {
  try {
    // PNG: bytes 0-7 = signature, IHDR at byte 8
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
      const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
      return { width, height };
    }
    // JPEG: scan for SOF marker
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xFF) { offset++; continue; }
        const marker = buf[offset + 1];
        if (marker >= 0xC0 && marker <= 0xC3 && marker !== 0xC1) {
          const height = (buf[offset + 5] << 8) | buf[offset + 6];
          const width = (buf[offset + 7] << 8) | buf[offset + 8];
          return { width, height };
        }
        const segLen = (buf[offset + 2] << 8) | buf[offset + 3];
        offset += 2 + segLen;
      }
    }
    // WebP
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
        const width = ((buf[26] | (buf[27] << 8)) & 0x3FFF);
        const height = ((buf[28] | (buf[29] << 8)) & 0x3FFF);
        return { width, height };
      }
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4C) {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        const width = 1 + (((b1 & 0x3F) << 8) | b0);
        const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 >> 6) & 0x03));
        return { width, height };
      }
    }
  } catch (e) {
    console.warn("[aspect-ratio] Header parse error:", e);
  }
  return null;
}

/* ─── Closest aspect ratio matching ─── */

const KLING_SUPPORTED_RATIOS: Array<{ label: string; value: number }> = [
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "1:1",  value: 1 },
];

function findClosestAspectRatio(width: number, height: number): string {
  const actual = width / height;
  let bestLabel = "16:9";
  let bestDiff = Infinity;
  for (const r of KLING_SUPPORTED_RATIOS) {
    const diff = Math.abs(actual - r.value);
    if (diff < bestDiff) { bestDiff = diff; bestLabel = r.label; }
  }
  console.log(`[aspect-ratio] Image ${width}×${height} (ratio=${actual.toFixed(4)}) → matched "${bestLabel}" (diff=${bestDiff.toFixed(4)})`);
  return bestLabel;
}

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

/* ─── Model mappings ─── */

const KLING_MODEL_MAP: Record<string, { model: string; mode: string; isMotion?: boolean; isOmni?: boolean }> = {
  "kling-v1-pro":             { model: "kling-v1",          mode: "pro" },
  "kling-v1-5-pro":           { model: "kling-v1-5",        mode: "pro" },
  "kling-v1-6-pro":           { model: "kling-v1-6",        mode: "pro" },
  "kling-v2-master":          { model: "kling-v2-master",    mode: "pro" },
  "kling-v2-1-pro":           { model: "kling-v2-1",        mode: "pro" },
  "kling-v2-1-master":        { model: "kling-v2-1-master",  mode: "pro" },
  "kling-v2-5-turbo":         { model: "kling-v2-5-turbo",  mode: "pro" },
  "kling-v2-6-pro":           { model: "kling-v2-6",        mode: "pro" },
  "kling-v2-6-motion-pro":    { model: "kling-v2-6",        mode: "pro", isMotion: true },
  "kling-v3-pro":             { model: "kling-v3",          mode: "pro" },
  "kling-v3-motion-pro":      { model: "kling-v3",          mode: "pro", isMotion: true },
  
  "kling-v3-omni":            { model: "kling-v3-omni",     mode: "pro", isOmni: true },
};

const BANANA_MODEL_MAP: Record<string, string> = {
  "nano-banana-pro": "nano-banana-pro",
  "nano-banana-2":   "nano-banana-2",
};

/* ═══════════════════════════════════════════════════════════
   HANDLE NORMALIZATION SCHEMA
   Maps UI targetHandle names → standardized internal param keys
   per provider. This is the SINGLE SOURCE OF TRUTH for edge mapping.
   Adding a new provider? Just add a new entry here.
   ═══════════════════════════════════════════════════════════ */

type DataType = "image" | "video" | "text";

interface HandleDef {
  internal_key: string;   // The standardized key the executor reads
  data_type: DataType;    // Expected data type for validation
}

const HANDLE_SCHEMA: Record<string, Record<string, HandleDef>> = {
  kling: {
    start_frame:   { internal_key: "image_url",       data_type: "image" },
    ref_image:     { internal_key: "ref_image_url",   data_type: "image" },
    image_input:   { internal_key: "image_url",       data_type: "image" },
    image:         { internal_key: "image_url",       data_type: "image" },
    end_frame:     { internal_key: "image_tail_url",  data_type: "image" },
    ref_video:     { internal_key: "video_url",       data_type: "video" },
  },
  kling_extension: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    ref_video:     { internal_key: "video_url",      data_type: "video" },
  },
  motion_control: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
  },
  banana: {
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    context_text:  { internal_key: "context_text",   data_type: "text" },
  },
  chat_ai: {
    context_text:  { internal_key: "context_text",   data_type: "text" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
  },
  remove_bg: {
    image:         { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
  },
  merge_audio: {
    video:         { internal_key: "video_url",      data_type: "video" },
    audio:         { internal_key: "audio_url",      data_type: "text" }, // 'text' = pass-through URL string
  },
};

/** Resolve a targetHandle to the correct internal param key for a given provider */
function normalizeHandle(provider: string, targetHandle: string): HandleDef | null {
  const providerSchema = HANDLE_SCHEMA[provider];
  if (!providerSchema) return null;
  return providerSchema[targetHandle] ?? null;
}

/* ─── URL validation helper ─── */
const VALID_URL_REGEX = /^(https?:\/\/|data:)/i;

function isValidMediaUrl(value: string): boolean {
  return VALID_URL_REGEX.test(value);
}

function validateEdgeValue(value: string, expectedType: DataType, targetHandle: string): void {
  if (expectedType === "text") return; // text can be anything
  // For image/video, must be a URL or data URI
  if (!isValidMediaUrl(value)) {
    throw new Error(
      `Invalid input: Expected a ${expectedType} URL for handle "${targetHandle}", but received non-URL data. ` +
      `Value starts with: "${value.substring(0, 50)}..."`
    );
  }
}

/* ═══════════════════════════════════════════════════════════
   Provider Executors
   ═══════════════════════════════════════════════════════════ */

interface ProviderResult {
  task_id?: string;
  result_url?: string;
  /** Structured outputs dict — each key is a named output handle */
  outputs: Record<string, string>;
  output_type: "video_url" | "image_url" | "text";
  provider_meta?: Record<string, unknown>;
}

/**
 * Extract end frame from a video URL.
 * TODO: Implement actual frame extraction (FFmpeg or provider API).
 * For now returns cover_image if available, otherwise null.
 */
function extractEndFrame(_videoUrl: string, coverImage?: string): string | null {
  if (coverImage) return coverImage;
  // TODO: Implement actual frame extraction via FFmpeg or external service
  return null;
}

async function executeKling(params: Record<string, unknown>, supabaseClient: ReturnType<typeof createClient>): Promise<ProviderResult> {
  const KLING_ACCESS_KEY_ID = Deno.env.get("KLING_ACCESS_KEY_ID")!;
  const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY")!;

  const modelSlug = String(params.model_name ?? params.model ?? "kling-v2-6-pro");
  const mapping = KLING_MODEL_MAP[modelSlug];
  if (!mapping) throw new Error(`Unknown Kling model: ${modelSlug}`);

  const jwtToken = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);

  // ── Omni models: separate endpoint & array-based payload ──
  if (mapping.isOmni) {
    return await executeKlingOmni(params, mapping, modelSlug, jwtToken, supabaseClient);
  }

  // ── Motion Control: completely separate endpoint & payload ──
  if (mapping.isMotion) {
    return await executeKlingMotionControl(params, mapping, modelSlug, jwtToken);
  }

  // ── Standard Image-to-Video / Text-to-Video ──
  return await executeKlingStandard(params, mapping, modelSlug, jwtToken);
}

/**
 * Motion Control endpoint: POST /v1/videos/motion-control
 * Requires image_url + video_url. Duration is auto-determined by the video.
 * Does NOT accept duration or aspect_ratio params.
 */
async function executeKlingMotionControl(
  params: Record<string, unknown>,
  mapping: { model: string; mode: string },
  modelSlug: string,
  jwtToken: string,
): Promise<ProviderResult> {
  const ENDPOINT = "https://api.klingai.com/v1/videos/motion-control";

  const rawImageUrl = params.image_url as string | undefined;
  const rawVideoUrl = params.video_url as string | undefined;

  if (!rawImageUrl) throw new Error("Motion Control requires an image_url (reference image)");
  if (!rawVideoUrl) throw new Error("Motion Control requires a video_url (reference video that dictates motion & duration)");

  // Convert image to base64 for reliability (same pattern as standard I2V)
  let imagePayload: string = rawImageUrl;
  try {
    const imageBytes = await fetchImageBuffer(rawImageUrl);
    imagePayload = bytesToBase64(imageBytes);
    console.log(`[kling-motion] Converted image_url to base64 (${Math.round(imagePayload.length / 1024)}KB)`);
  } catch (convErr) {
    console.error(`[kling-motion] image fetch failed, using raw URL:`, convErr);
  }

  const keepOriginalSound = String(params.keep_original_sound ?? "no");
  const characterOrientation = String(params.character_orientation ?? "image");

  const body: Record<string, unknown> = {
    model_name: mapping.model,
    mode: mapping.mode,
    image_url: imagePayload,
    video_url: rawVideoUrl,
    keep_original_sound: keepOriginalSound,
    character_orientation: characterOrientation,
  };

  // Prompt is optional for motion control
  const prompt = String(params.prompt ?? "").trim();
  if (prompt) body.prompt = prompt;

  console.log(`[kling-motion] POST ${ENDPOINT} model=${mapping.model} mode=${mapping.mode} orientation=${characterOrientation}`);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[kling-motion] API HTTP ${res.status}: ${errText.substring(0, 500)}`);
    if (res.status === 402 || res.status === 429 || /account balance not enough|insufficient balance|quota exceeded|billing/i.test(errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(`Kling Motion API error (HTTP ${res.status}): ${errText.substring(0, 200)}`);
  }

  let result: Record<string, unknown>;
  try {
    result = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    console.error(`[kling-motion] Failed to parse JSON: ${text.substring(0, 500)}`);
    throw new Error("Kling Motion API returned invalid JSON response");
  }

  const message = String(result?.message ?? "Kling Motion API error");
  if (result?.code !== 0) {
    if (/account balance not enough|insufficient balance|quota exceeded|billing/i.test(message)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(message || "Kling Motion API error");
  }

  return {
    task_id: result?.data?.task_id,
    outputs: {
      output_video: "",
      output_start_frame: rawImageUrl || "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: { model: modelSlug, mode: mapping.mode, is_motion_control: true },
  };
}

/**
 * Standard I2V / T2V endpoints
 */
async function executeKlingStandard(
  params: Record<string, unknown>,
  mapping: { model: string; mode: string },
  modelSlug: string,
  jwtToken: string,
): Promise<ProviderResult> {
  const finalPrompt = String(params.prompt ?? "");

  const rawImageUrl = params.image_url as string | undefined;
  const endpoint = rawImageUrl
    ? "https://api.klingai.com/v1/videos/image2video"
    : "https://api.klingai.com/v1/videos/text2video";

  // Fetch image buffer once — reused for base64 AND dimension extraction
  let imageBytes: Uint8Array | undefined;
  let imageBase64: string | undefined;
  if (rawImageUrl) {
    try {
      imageBytes = await fetchImageBuffer(rawImageUrl);
      imageBase64 = bytesToBase64(imageBytes);
      console.log(`[kling] Converted image_url to base64 (${Math.round(imageBase64.length / 1024)}KB)`);
    } catch (convErr) {
      console.error(`[kling] image fetch failed, using raw URL:`, convErr);
    }
  }

  const rawTailUrl = params.image_tail_url as string | undefined;
  let tailImageBase64: string | undefined;
  if (rawTailUrl) {
    try {
      tailImageBase64 = await imageUrlToBase64(rawTailUrl);
    } catch (tailErr) {
      console.error(`[kling] tail image base64 conversion failed:`, tailErr);
    }
  }

  // ── Runtime aspect ratio resolution ──
  const rawAspect = params.aspect_ratio as string | undefined;
  let resolvedAspect: string;
  if (!rawAspect || rawAspect === "Auto") {
    if (imageBytes) {
      const dims = extractImageDimensions(imageBytes);
      if (dims) {
        resolvedAspect = findClosestAspectRatio(dims.width, dims.height);
      } else {
        console.warn("[aspect-ratio] Could not parse image dimensions, falling back to 16:9");
        resolvedAspect = "16:9";
      }
    } else {
      resolvedAspect = "16:9";
    }
  } else {
    resolvedAspect = rawAspect;
  }

  const initialMode = String((params.mode as string) ?? mapping.mode).toLowerCase() === "std" ? "std" : "pro";

  const body: Record<string, unknown> = {
    model_name: mapping.model,
    mode: initialMode,
    prompt: finalPrompt,
    duration: String(params.duration ?? 5),
    aspect_ratio: resolvedAspect,
  };

  // Strip any data-URI prefix from base64 strings (Kling rejects prefixed base64)
  const stripBase64Prefix = (b64: string) => b64.replace(/^data:image\/\w+;base64,/, "");

  if (imageBase64) body.image = stripBase64Prefix(imageBase64);
  else if (rawImageUrl) body.image = rawImageUrl;
  if (rawTailUrl) body.image_tail = tailImageBase64 ? stripBase64Prefix(tailImageBase64) : rawTailUrl;
  if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
  // Kling API uses "sound" (not "has_audio") to enable audio generation
  if (params.has_audio === "true" || params.has_audio === true) body.sound = true;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[kling] API HTTP ${res.status}: ${errText.substring(0, 500)}`);
    if (res.status === 402 || res.status === 429 || /account balance not enough|insufficient balance|quota exceeded|billing/i.test(errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(`Kling API error (HTTP ${res.status}): ${errText.substring(0, 200)}`);
  }

  let result: Record<string, unknown>;
  try {
    result = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    console.error(`[kling] Failed to parse JSON response: ${text.substring(0, 500)}`);
    throw new Error("Kling API returned invalid JSON response");
  }

  const message = String(result?.message ?? "Kling API error");
  if (result?.code !== 0) {
    if (/account balance not enough|insufficient balance|quota exceeded|billing/i.test(message)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(message || "Kling API error");
  }

  return {
    task_id: result?.data?.task_id,
    outputs: {
      output_video: "",
      output_start_frame: rawImageUrl || "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: { model: modelSlug, mode: initialMode, is_image2video: !!rawImageUrl, aspect_ratio: resolvedAspect },
  };
}

/**
 * Omni Video endpoint: POST /v1/videos/omni-video
 * Supports image_list (array), video_list (array), flexible duration (3-15s),
 * multi_shot director mode, and combined audio controls.
 */
async function executeKlingOmni(
  params: Record<string, unknown>,
  mapping: { model: string; mode: string },
  modelSlug: string,
  jwtToken: string,
  supabaseClient: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  const ENDPOINT = "https://api.klingai.com/v1/videos/omni-video";

  const duration = parseInt(String(params.duration ?? 5), 10) || 5;
  const prompt = String(params.prompt ?? "").trim();
  const negativePrompt = String(params.negative_prompt ?? "").trim();

  // ── Build image_list array ──
  // Kling API spec: each item uses key `image_url` (NOT `url`)
  const imageList: Array<Record<string, string>> = [];

  const rawImageUrl = params.image_url as string | undefined;
  let startFrameBytes: Uint8Array | undefined;
  if (rawImageUrl) {
    let imagePayload = rawImageUrl;
    try {
      startFrameBytes = await fetchImageBuffer(rawImageUrl);
      imagePayload = bytesToBase64(startFrameBytes);
      console.log(`[kling-omni] Converted start_frame to base64 (${Math.round(imagePayload.length / 1024)}KB)`);
    } catch (convErr) {
      console.error(`[kling-omni] start_frame fetch failed, using raw URL:`, convErr);
    }
    imageList.push({ image_url: imagePayload, type: "first_frame" });
  }

  const rawTailUrl = params.image_tail_url as string | undefined;
  if (rawTailUrl) {
    let tailPayload = rawTailUrl;
    try {
      tailPayload = await imageUrlToBase64(rawTailUrl);
    } catch (convErr) {
      console.error(`[kling-omni] end_frame fetch failed:`, convErr);
    }
    imageList.push({ image_url: tailPayload, type: "end_frame" });
  }

  // Additional ref_image (no type constraint — general reference)
  const refImageUrl = params.ref_image_url as string | undefined;
  if (refImageUrl) {
    let refPayload = refImageUrl;
    try {
      const refBytes = await fetchImageBuffer(refImageUrl);
      refPayload = bytesToBase64(refBytes);
      console.log(`[kling-omni] Converted ref_image to base64 (${Math.round(refPayload.length / 1024)}KB)`);
    } catch (convErr) {
      console.error(`[kling-omni] ref_image fetch failed:`, convErr);
    }
    imageList.push({ image_url: refPayload });
  }

  // ── Build video_list array ──
  // Kling API spec: each item uses key `video_url` (NOT `url`),
  // plus `refer_type` (feature|base) and `keep_original_sound` (yes|no) inside the item.
  const videoList: Array<Record<string, string>> = [];
  const rawVideoUrl = params.video_url as string | undefined;
  if (rawVideoUrl) {
    const referType = String(params.refer_type ?? "base"); // base = video edit, feature = video reference
    const keepSound = String(params.keep_original_sound ?? "no");
    videoList.push({ video_url: rawVideoUrl, refer_type: referType, keep_original_sound: keepSound });
  }

  // ── Aspect ratio resolution (reuse startFrameBytes from above) ──
  const rawAspect = params.aspect_ratio as string | undefined;
  let resolvedAspect: string;
  if (!rawAspect || rawAspect === "Auto") {
    if (startFrameBytes) {
      const dims = extractImageDimensions(startFrameBytes);
      resolvedAspect = dims ? findClosestAspectRatio(dims.width, dims.height) : "16:9";
    } else {
      resolvedAspect = "16:9";
    }
  } else {
    resolvedAspect = rawAspect;
  }

  // ── Build body ──
  const body: Record<string, unknown> = {
    model_name: mapping.model,
    mode: mapping.mode,
    duration: String(duration),
    aspect_ratio: resolvedAspect,
  };

  // Audio (Kling spec: sound = "on" | "off", string enum — NOT boolean)
  // When a reference video is present, sound MUST be "off".
  const wantsSound = params.has_audio === "true" || params.has_audio === true;
  body.sound = (wantsSound && videoList.length === 0) ? "on" : "off";

  // Note: keep_original_sound is a per-video field already set inside video_list above.
  // Do NOT set it at the top level — Kling rejects unknown root params.

  // ── Multi-shot director mode — resolve @mentions and #textvars per scene ──
  const isMultiShot = params.multi_shot === "true" || params.multi_shot === true;
  if (isMultiShot && params.multi_prompt) {
    body.multi_shot = true;
    body.shot_type = "customize";

    let shots: Array<{ prompt: string; duration: number }>;
    if (typeof params.multi_prompt === "string") {
      try {
        shots = JSON.parse(params.multi_prompt);
      } catch {
        throw new Error("multi_prompt must be a valid JSON array of {prompt, duration} objects");
      }
    } else {
      shots = params.multi_prompt as Array<{ prompt: string; duration: number }>;
    }

    // Validate total duration
    const totalShotDuration = shots.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
    if (totalShotDuration !== duration) {
      console.warn(`[kling-omni] Shot durations sum (${totalShotDuration}) ≠ total duration (${duration}). API may reject.`);
    }

    // Resolve @mentions and #textvars in each scene prompt
    const resolvedShots: Array<{ index: number; prompt: string; duration: string }> = [];
    for (let i = 0; i < shots.length; i++) {
      let scenePrompt = shots[i].prompt;

      // Resolve #[Label](nodeId) text variables
      if (scenePrompt.includes("#[")) {
        // Build outputs dict from step results for pipeline context
        const graphNodes = (params._graph_nodes ?? undefined) as Array<{ id: string; type: string; data: Record<string, unknown> }> | undefined;
        scenePrompt = resolveTextVariablesInPrompt(scenePrompt, graphNodes);
      }

      // Resolve @[Label](nodeId) mentions
      if (scenePrompt.includes("@[")) {
        const graphNodes = (params._graph_nodes ?? undefined) as Array<{ id: string; type: string; data: Record<string, unknown> }> | undefined;
        const { resolvedPrompt, mentionedImageUrls } = await resolveMentionsInPrompt(
          scenePrompt, graphNodes, supabaseClient, "kling",
        );
        scenePrompt = resolvedPrompt;
        // Add mention images to image_list (Kling key = `image_url`)
        for (const url of mentionedImageUrls) {
          const alreadyAdded = imageList.some((img) => img.image_url === url);
          if (!alreadyAdded) {
            try {
              const imgBytes = await fetchImageBuffer(url);
              const b64 = bytesToBase64(imgBytes);
              imageList.push({ image_url: b64 });
            } catch {
              imageList.push({ image_url: url });
            }
            console.log(`[kling-omni] Added multi_shot mention image to image_list`);
          }
        }
      }

      resolvedShots.push({
        index: i + 1,
        prompt: scenePrompt,
        duration: String(shots[i].duration),
      });
    }
    body.multi_prompt = resolvedShots;
  } else {
    // Standard single-prompt mode
    if (prompt) body.prompt = prompt;
  }

  if (negativePrompt) body.negative_prompt = negativePrompt;
  if (imageList.length > 0) body.image_list = imageList;
  if (videoList.length > 0) body.video_list = videoList;

  console.log(`[kling-omni] POST ${ENDPOINT} model=${mapping.model} mode=${mapping.mode} duration=${duration}s images=${imageList.length} videos=${videoList.length} multi_shot=${isMultiShot}`);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[kling-omni] API HTTP ${res.status}: ${errText.substring(0, 500)}`);
    if (res.status === 402 || res.status === 429 || /account balance not enough|insufficient balance|quota exceeded|billing/i.test(errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(`Kling Omni API error (HTTP ${res.status}): ${errText.substring(0, 200)}`);
  }

  let result: Record<string, unknown>;
  try {
    result = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    console.error(`[kling-omni] Failed to parse JSON: ${text.substring(0, 500)}`);
    throw new Error("Kling Omni API returned invalid JSON response");
  }

  const message = String(result?.message ?? "Kling Omni API error");
  if (result?.code !== 0) {
    if (/account balance not enough|insufficient balance|quota exceeded|billing/i.test(message)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(message || "Kling Omni API error");
  }

  return {
    task_id: result?.data?.task_id,
    outputs: {
      output_video: "",
      output_start_frame: rawImageUrl || "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      model: modelSlug,
      mode: mapping.mode,
      is_omni: true,
      has_video_ref: videoList.length > 0,
      has_image_ref: imageList.length > 0,
    },
  };
}


const GEMINI_IMAGE_MODELS: Record<string, { gemini_model: string }> = {
  "nano-banana-pro": { gemini_model: "gemini-3-pro-image-preview" },
  "nano-banana-2":   { gemini_model: "gemini-3.1-flash-image-preview" },
};

async function executeBanana(
  params: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  const GOOGLE_AI_STUDIO_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!GOOGLE_AI_STUDIO_KEY) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");

  const rawModel = String(params.model_name ?? params.model ?? "nano-banana-pro");
  const modelId = BANANA_MODEL_MAP[rawModel] ?? rawModel;
  const modelConfig = GEMINI_IMAGE_MODELS[modelId];
  if (!modelConfig) throw new Error(`Unknown Banana model: ${modelId}. Available: ${Object.keys(GEMINI_IMAGE_MODELS).join(", ")}`);

  const prompt = String(params.prompt ?? "");
  const aspectRatio = String(params.aspect_ratio ?? "Auto");
  const imageUrl = params.image_url as string | undefined;
  const mentionImageUrls = params.mention_image_urls as string[] | undefined;

  if (!prompt) throw new Error("A prompt is required.");

  // Build Gemini API request parts
  const parts: Array<Record<string, unknown>> = [];
  parts.push({ text: prompt });

  // Resolve reference images to base64 inline data for Gemini
  const imageUrls: string[] = mentionImageUrls ?? (imageUrl ? [imageUrl] : []);
  if (imageUrls.length > 0) {
    for (const url of imageUrls) {
      try {
        const bytes = await fetchImageBuffer(url);
        const base64 = bytesToBase64(bytes);
        // Detect mime from first bytes
        let mime = "image/png";
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = "image/jpeg";
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = "image/webp";
        parts.push({ inlineData: { mimeType: mime, data: base64 } });
      } catch (imgErr) {
        console.warn(`[banana-direct] Failed to resolve image: ${imgErr}`);
      }
    }
    console.log(`[banana-direct] Added ${imageUrls.length} reference images`);
  }

  console.log(`[banana-direct] Requesting ${modelId} (${modelConfig.gemini_model}), ref_images: ${imageUrls.length}`);

  // Build generationConfig with aspectRatio support
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (aspectRatio && aspectRatio !== "Auto") {
    generationConfig.imageConfig = { aspectRatio };
  }

  // ── Global Nano Banana tier override (admin-controlled throttle) ──
  // subscription_settings.nano_banana_tier_override:
  //   'auto'           → honour params.service_tier (current behavior)
  //   'force_standard' → strip service_tier (always Standard)
  //   'force_flex'     → set service_tier="flex" (cheaper but slower/queued)
  // NOTE: Gemini Developer API REST contract requires snake_case "service_tier"
  // at the root of the request body with lowercase value "flex" — NOT
  // camelCase "serviceTier" with "FLEX". The previous payload was rejected
  // with HTTP 400 every time, which is what made every Banana Pro request
  // fail right after Force Flex was applied.
  // Ref: https://ai.google.dev/gemini-api/docs/flex-inference  (REST tab)
  let useFlex = false;
  try {
    const { data: tierRow } = await supabase
      .from("subscription_settings")
      .select("value")
      .eq("key", "nano_banana_tier_override")
      .maybeSingle();
    const override = (tierRow?.value as string | undefined) ?? "auto";
    if (override === "force_flex") {
      useFlex = true;
    } else if (override === "force_standard") {
      useFlex = false;
    } else {
      const fromParam = String(params.service_tier ?? "").toLowerCase();
      useFlex = fromParam === "flex";
    }
    console.log(`[banana-direct] Tier override='${override}', resolved=${useFlex ? "FLEX" : "STANDARD"}`);
  } catch (tierErr) {
    console.warn(`[banana-direct] Failed to read tier override, defaulting to Standard:`, tierErr);
  }

  const requestPayload: Record<string, unknown> = {
    contents: [{ parts }],
    generationConfig,
  };
  if (useFlex) {
    // REST contract: snake_case key + lowercase value
    requestPayload.service_tier = "flex";
  }
  const geminiRequestBody = JSON.stringify(requestPayload);

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.gemini_model}:generateContent?key=${GOOGLE_AI_STUDIO_KEY}`;
  console.log(`[banana-direct] Calling model: ${modelConfig.gemini_model}`);

  const aiResponse = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: geminiRequestBody,
  });

  if (!aiResponse.ok) {
    const statusCode = aiResponse.status;
    const errorText = await aiResponse.text();
    console.error(`[banana-direct] Gemini API error: ${statusCode}`, errorText.substring(0, 500));
    if (statusCode === 429 || (statusCode < 500 && /billing|quota|exceeded|resource exhausted/i.test(errorText))) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    const modelLabel = modelId === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2";
    throw new Error(`${modelLabel} failed (HTTP ${statusCode}). Please try again.`);
  }

  const aiResult = await aiResponse.json();
  const candidate = aiResult.candidates?.[0]?.content;
  const responseParts = candidate?.parts || [];

  // Extract image from response
  let imageBase64: string | null = null;
  let imageMime = "image/png";

  for (const part of responseParts) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      imageMime = part.inlineData.mimeType || "image/png";
    }
  }

  if (!imageBase64) {
    throw new Error("No image was generated. Try a different prompt.");
  }

  // Upload to storage
  const ext = imageMime.split("/")[1] || "png";
  const fileName = `pipeline/${Date.now()}.${ext}`;
  const binaryData = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));

  let publicUrl = `data:${imageMime};base64,${imageBase64}`;

  const { error: uploadError } = await supabase.storage
    .from("ai-media")
    .upload(fileName, binaryData, { contentType: imageMime, upsert: true });

  if (uploadError) {
    console.error("[banana-direct] Upload error:", uploadError);
  } else {
    const { data: urlData, error: signError } = await supabase.storage
      .from("ai-media")
      .createSignedUrl(fileName, 60 * 60 * 24 * 7);
    if (!signError && urlData?.signedUrl) {
      publicUrl = urlData.signedUrl;
    } else {
      const { data: pubData } = supabase.storage.from("ai-media").getPublicUrl(fileName);
      publicUrl = pubData.publicUrl;
    }
  }

  console.log(`[banana-direct] Success — image uploaded to storage`);

  return {
    result_url: publicUrl,
    outputs: { output_image: publicUrl },
    output_type: "image_url" as const,
    provider_meta: { model: modelId },
  };
}

async function executeChatAi(params: Record<string, unknown>): Promise<ProviderResult> {
  const model = String(params.model_name ?? "google/gemini-3.1-pro-preview");
  const systemPrompt = String(params.system_prompt ?? "You are a helpful AI assistant.");
  const userPrompt = String(params.prompt ?? "");
  const temperature = Number(params.temperature ?? 0.7);
  const maxTokens = parseInt(String(params.max_tokens ?? "1024"), 10);
  const context = params.context_text as string | undefined;

  if (!userPrompt && !context) throw new Error("Prompt is required");

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];
  if (context) {
    messages.push({ role: "user", content: `Context:\n${context}\n\n${userPrompt}` });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  let content: string;

  if (model.startsWith("google/")) {
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
    if (!GOOGLE_KEY) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");
    const geminiModelMap: Record<string, string> = {
      "google/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
      "google/gemini-3-flash-preview": "gemini-3-flash-preview",
    };
    const geminiModel = geminiModelMap[model] ?? model.replace("google/", "");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GOOGLE_KEY}`;
    const geminiContents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const msg of messages) {
      if (msg.role === "system") continue;
      geminiContents.push({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] });
    }
    const res = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 || (res.status < 500 && /billing|quota|exceeded|resource exhausted/i.test(errText))) throw new Error("PROVIDER_BILLING_ERROR");
      throw new Error(`Google AI API error (${res.status})`);
    }
    const data = await res.json();
    content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } else if (model.startsWith("openai/")) {
    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not configured");
    const openaiModel = model.replace("openai/", "");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: openaiModel, messages, temperature, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 || res.status === 402 || /billing|quota|insufficient_quota|rate limit/i.test(errText)) throw new Error("PROVIDER_BILLING_ERROR");
      throw new Error(`OpenAI API error (${res.status})`);
    }
    const data = await res.json();
    content = data.choices?.[0]?.message?.content ?? "";
  } else {
    throw new Error(`Unsupported model: ${model}`);
  }

  return { result_url: content, outputs: { output_text: content }, output_type: "text", provider_meta: { model } };
}

/**
 * executeRemoveBg — calls our remove-background edge function (Replicate BiRefNet).
 */
async function executeRemoveBg(params: Record<string, unknown>, supabaseUrl: string, serviceRoleKey: string): Promise<ProviderResult> {
  const imageUrl = String(params.image_url ?? "");
  if (!imageUrl) {
    throw new Error("Remove Background requires an image input.");
  }

  console.log(`[remove-bg-pipeline] Calling remove-background edge fn`);

  const res = await fetch(`${supabaseUrl}/functions/v1/remove-background`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  const json = await res.json();
  if (!res.ok) {
    const errMsg = String(json?.error || `remove-background failed (${res.status})`);
    if (errMsg === "PROVIDER_BILLING_ERROR") throw new Error("PROVIDER_BILLING_ERROR");
    throw new Error(errMsg);
  }

  const url = String(json.result_url ?? json.outputs?.output_image ?? "");
  if (!url) throw new Error("remove-background returned no URL");

  return {
    result_url: url,
    outputs: { output_image: url },
    output_type: "image_url" as const,
    provider_meta: json.provider_meta ?? { model: "replicate-birefnet" },
  };
}

/**
 * executeMergeAudio — proxies to merge-audio-video edge fn (Shotstack).
 * Reads video_url + audio_url from inputs, returns the muxed video URL.
 */
async function executeMergeAudio(params: Record<string, unknown>): Promise<ProviderResult> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const videoUrl = String(params.video_url ?? "");
  const audioUrl = String(params.audio_url ?? "");
  if (!videoUrl) throw new Error("Merge Audio requires a video input.");
  if (!audioUrl) throw new Error("Merge Audio requires an audio input.");

  console.log(`[merge-audio-pipeline] Calling merge-audio-video edge fn`);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/merge-audio-video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      video_url: videoUrl,
      audio_url: audioUrl,
      audio_mode: params.audio_mode ?? "replace",
      audio_volume: params.audio_volume ?? 1,
    }),
  });

  const json = await res.json();
  if (!res.ok) {
    const errMsg = String(json?.error || `merge-audio-video failed (${res.status})`);
    if (errMsg === "PROVIDER_BILLING_ERROR") throw new Error("PROVIDER_BILLING_ERROR");
    throw new Error(errMsg);
  }

  const url = String(json.result_url ?? json.outputs?.output_video ?? "");
  if (!url) throw new Error("merge-audio-video returned no URL");

  return {
    result_url: url,
    outputs: { output_video: url },
    output_type: "video_url" as const,
    provider_meta: json.provider_meta ?? { provider: "shotstack" },
  };
}


/* ═══════════════════════════════════════════════════════════
   @mention resolver — Provider-Aware
   ═══════════════════════════════════════════════════════════ */

interface MentionResolution {
  resolvedPrompt: string;
  mentionedImageUrls: string[];
}

/**
 * Resolve @[Label](nodeId) tokens in a prompt string.
 * Step 1: Extract all mentions and resolve nodeId → real URL.
 * Step 2: Format the prompt text differently per provider.
 */
async function resolveMentionsInPrompt(
  prompt: string,
  graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }> | undefined,
  supabase: ReturnType<typeof createClient>,
  provider?: string,
  stepResults?: Array<{ step_index: number; status: string; result_url?: string; outputs?: Record<string, string> }>,
  steps?: Array<{ node_id: string }>,
): Promise<MentionResolution> {
  if (!prompt.includes("@[")) return { resolvedPrompt: prompt, mentionedImageUrls: [] };

  const mentions = [...prompt.matchAll(/@\[([^\]]+)\]\(([^)]+)\)/g)];
  if (mentions.length === 0) return { resolvedPrompt: prompt, mentionedImageUrls: [] };

  // ── Step 1: Resolve every nodeId → URL ──
  const resolvedUrls: Array<{ fullMatch: string; label: string; url: string | null }> = [];

  for (const match of mentions) {
    const fullMatch = match[0];
    const label = match[1];
    const nodeId = match[2];
    let resolvedUrl: string | null = null;

    // 1a. Try step_results (output of a previous action node)
    if (!resolvedUrl && stepResults && steps) {
      const sourceIdx = steps.findIndex((s) => s.node_id === nodeId);
      if (sourceIdx >= 0) {
        const sr = stepResults.find((r) => r.step_index === sourceIdx && r.status === "completed");
        if (sr) {
          resolvedUrl = sr.result_url || (sr.outputs ? Object.values(sr.outputs).find(Boolean) : undefined) || null;
        }
      }
    }

    // 1b. Try graph_nodes (input node with uploaded asset)
    if (!resolvedUrl && graphNodes) {
      const node = graphNodes.find((n) => n.id === nodeId);
      if (node) {
        const data = node.data || {};
        const uploadedUrl = data.uploadedUrl as string | undefined;
        if (uploadedUrl) {
          resolvedUrl = uploadedUrl;
        } else {
          const storagePath = data.storagePath as string | undefined;
          if (storagePath) {
            const { data: signedData } = await supabase.storage.from("ai-media").createSignedUrl(storagePath, 3600);
            if (signedData?.signedUrl) resolvedUrl = signedData.signedUrl;
          }
          if (!resolvedUrl) {
            resolvedUrl = (data.previewUrl as string | undefined) || null;
          }
        }
      }
    }

    resolvedUrls.push({ fullMatch, label, url: resolvedUrl });
  }

  // Collect unique resolved image URLs
  const mentionedImageUrls = resolvedUrls.map((r) => r.url).filter(Boolean) as string[];

  // ── Step 2: Provider-aware prompt formatting with AI context instructions ──
  let result = prompt;
  const p = (provider || "").toLowerCase();
  const contextInstructions: string[] = [];

  if (p === "kling" || p === "kling_extension" || p === "motion_control") {
    // Kling: replace with @image_N placeholder, pass URLs separately
    for (let i = 0; i < resolvedUrls.length; i++) {
      const r = resolvedUrls[i];
      if (r.url) {
        const placeholder = `@image_${i + 1}`;
        result = result.replace(r.fullMatch, placeholder);
        contextInstructions.push(`${placeholder} refers to the attached image "${r.label}"`);
      } else {
        result = result.replace(r.fullMatch, `[${r.label}]`);
      }
    }
  } else if (p === "banana") {
    // Banana/Gemini multimodal: strip tokens, images injected as inline parts
    // Append structured context so AI knows what each attached image represents
    for (let i = 0; i < resolvedUrls.length; i++) {
      const r = resolvedUrls[i];
      if (r.url) {
        result = result.replace(r.fullMatch, "");
        contextInstructions.push(`Reference the attached image "${r.label}" (image ${i + 1}) for visual context`);
      } else {
        result = result.replace(r.fullMatch, `[${r.label}]`);
      }
    }
  } else if (p === "chat_ai") {
    // Chat AI: embed URL inline for context with semantic label
    for (const r of resolvedUrls) {
      if (r.url) {
        result = result.replace(r.fullMatch, `[Image: ${r.label}]`);
        contextInstructions.push(`"${r.label}" refers to the resource at: ${r.url}`);
      } else {
        result = result.replace(r.fullMatch, `[${r.label}]`);
      }
    }
  } else {
    // Legacy / unknown: strip tokens completely, first URL goes to image_url param
    for (const r of resolvedUrls) {
      result = result.replace(r.fullMatch, "");
    }
  }

  // Clean up whitespace artifacts
  result = result.replace(/\s{2,}/g, " ").trim();

  // Append context instructions block if any mentions were resolved
  if (contextInstructions.length > 0) {
    result = `${result}\n\n[Context: ${contextInstructions.join(". ")}.]\n`;
  }

  console.log(`[mention-resolver] Provider="${provider}", resolved ${mentionedImageUrls.length} image(s), instructions=${contextInstructions.length}, prompt length=${result.length}`);
  return { resolvedPrompt: result, mentionedImageUrls };
}

/**
 * Resolves #[Label](nodeId) text variable tokens via direct string replacement.
 */
function resolveTextVariablesInPrompt(
  prompt: string,
  graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }> | undefined,
  outputs?: Record<string, Record<string, string>>,
): string {
  if (!graphNodes || !prompt.includes("#[")) return prompt;
  const textVarRegex = /#\[([^\]]+)\]\(([^)]+)\)/g;
  return prompt.replace(textVarRegex, (_fullMatch, _label, nodeId) => {
    if (outputs) {
      const nodeOutputs = outputs[nodeId];
      if (nodeOutputs) {
        const textValue = nodeOutputs.output_text || nodeOutputs.text || Object.values(nodeOutputs)[0];
        if (textValue) return `"${textValue}"`;
      }
    }
    const node = graphNodes.find((n) => n.id === nodeId);
    if (node) {
      const data = node.data || {};
      const textValue = (data.textValue as string) || (data.text as string);
      if (textValue) return `"${textValue}"`;
    }
    return "";
  });
}

/* ═══════════════════════════════════════════════════════════
   Provider Health Probe
   ═══════════════════════════════════════════════════════════ */

async function probeProviderHealth(provider: string): Promise<{ healthy: boolean; reason: string }> {
  try {
    if (provider === "kling" || provider === "kling_extension" || provider === "motion_control") {
      const KLING_ACCESS_KEY_ID = Deno.env.get("KLING_ACCESS_KEY_ID");
      const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY");
      if (!KLING_ACCESS_KEY_ID || !KLING_SECRET_KEY) return { healthy: false, reason: "credentials missing" };
      const jwt = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);
      // GET on text2video listing — lightweight, returns 200 if service up
      const res = await fetch("https://api.klingai.com/v1/videos/text2video?pageNum=1&pageSize=1", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return { healthy: res.ok || res.status === 404, reason: `HTTP ${res.status}` };
    }
    if (provider === "banana" || provider === "chat_ai") {
      const KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
      if (!KEY) return { healthy: false, reason: "credentials missing" };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${KEY}`);
      return { healthy: res.ok, reason: `HTTP ${res.status}` };
    }
    if (provider === "remove_bg") {
      const REPLICATE = Deno.env.get("REPLICATE_API_TOKEN");
      if (!REPLICATE) return { healthy: false, reason: "credentials missing" };
      const res = await fetch("https://api.replicate.com/v1/account", {
        headers: { Authorization: `Bearer ${REPLICATE}` },
      });
      await res.body?.cancel();
      return { healthy: res.ok, reason: `HTTP ${res.status}` };
    }
    if (provider === "merge_audio") {
      const KEY = Deno.env.get("SHOTSTACK_API_KEY");
      if (!KEY) return { healthy: false, reason: "credentials missing" };
      // Shotstack /render GET requires an id; just check API root reachability via probe endpoint.
      const res = await fetch("https://api.shotstack.io/edit/v1/probe/probe", {
        headers: { "x-api-key": KEY },
      });
      await res.body?.cancel();
      // Shotstack probe returns 4xx on bad input but 200/401 on auth check
      return { healthy: res.status !== 401 && res.status !== 403, reason: `HTTP ${res.status}` };
    }
    if (provider === "mp3_input") {
      return { healthy: true, reason: "passthrough" };
    }
    return { healthy: true, reason: "unknown provider, assumed healthy" };
  } catch (err) {
    return { healthy: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/* ═══════════════════════════════════════════════════════════
   Single-step executor (extracted for parallel reuse)
   Builds params, runs retries, performs health probe, returns outcome.
   Does NOT update DB — caller aggregates results.
   ═══════════════════════════════════════════════════════════ */

interface StepOutcome {
  step_index: number;
  node_id: string;
  node_type: string;
  provider: string;
  status: "completed" | "running" | "failed" | "skipped" | "queued_for_retry";
  result_url?: string;
  outputs?: Record<string, string>;
  task_id?: string;
  output_type: string;
  provider_meta?: Record<string, unknown>;
  error?: string;
  is_async: boolean;
  health_probe?: { healthy: boolean; reason: string };
  retry_job_id?: string; // set when status = 'queued_for_retry'
}

// Inline budget = INLINE_BUDGET_ATTEMPTS (4) + queue worker retries 14 = TOTAL_MAX_RETRIES (18)
void TOTAL_MAX_RETRIES;

async function executeOneStep(
  supabase: ReturnType<typeof createClient>,
  execution: Record<string, unknown>,
  stepIndex: number,
  steps: Array<{
    node_id: string; node_type: string; provider: string; is_async: boolean;
    output_type: string; params: Record<string, unknown>;
    input_edges: Array<{ source_node_id: string; target_handle: string; source_handle: string }>;
    level?: number;
  }>,
  priorResults: Array<{
    step_index: number; status: string; node_id?: string; result_url?: string;
    outputs?: Record<string, string>; task_id?: string; output_type: string;
    provider_meta?: Record<string, unknown>;
  }>,
  SUPABASE_URL: string,
  token: string,
): Promise<StepOutcome> {
  const stepDef = steps[stepIndex];
  if (!stepDef) {
    return {
      step_index: stepIndex, node_id: "?", node_type: "?", provider: "?",
      status: "failed", output_type: "image_url", is_async: false,
      error: "Step definition not found",
    };
  }

  // ─── Skip cascade: if any upstream dependency failed/skipped, skip this node ───
  for (const edge of stepDef.input_edges ?? []) {
    const upstreamIdx = steps.findIndex((s) => s.node_id === edge.source_node_id);
    if (upstreamIdx < 0) continue; // upstream is an input node, not a step
    const upstreamResult = priorResults.find((r) => r.step_index === upstreamIdx);
    if (upstreamResult && (upstreamResult.status === "failed" || upstreamResult.status === "skipped")) {
      console.warn(`[step-executor] Step ${stepIndex} (${stepDef.node_id}) SKIPPED — upstream ${edge.source_node_id} ${upstreamResult.status}`);
      return {
        step_index: stepIndex, node_id: stepDef.node_id, node_type: stepDef.node_type,
        provider: stepDef.provider, status: "skipped", output_type: stepDef.output_type,
        is_async: stepDef.is_async,
        error: `Skipped: upstream node "${edge.source_node_id}" ${upstreamResult.status}`,
      };
    }
  }

  // ─── Build step params with @mentions, #vars, edge mapping ───
  const stepParams = { ...stepDef.params };
  const graphNodes = (execution.pricing_info as Record<string, unknown>)?.graph_nodes as Array<{ id: string; type: string; data: Record<string, unknown> }> | undefined;
  const allMentionedImageUrls: string[] = [];

  for (const [key, val] of Object.entries(stepParams)) {
    if (typeof val === "string" && val.includes("@[")) {
      const { resolvedPrompt, mentionedImageUrls } = await resolveMentionsInPrompt(
        val, graphNodes, supabase, stepDef.provider, priorResults, steps,
      );
      stepParams[key] = resolvedPrompt;
      allMentionedImageUrls.push(...mentionedImageUrls);
    }
    if (typeof stepParams[key] === "string" && (stepParams[key] as string).includes("#[")) {
      stepParams[key] = resolveTextVariablesInPrompt(stepParams[key] as string, graphNodes, priorResults);
    }
  }

  if (allMentionedImageUrls.length > 0) {
    const p = stepDef.provider.toLowerCase();
    if (p === "kling" || p === "kling_extension" || p === "motion_control") {
      if (!stepParams.image_url) stepParams.image_url = allMentionedImageUrls[0];
    } else if (p === "banana") {
      stepParams.mention_image_urls = allMentionedImageUrls;
      if (!stepParams.image_url) stepParams.image_url = allMentionedImageUrls[0];
    } else {
      if (!stepParams.image_url) stepParams.image_url = allMentionedImageUrls[0];
    }
  }

  // ─── Edge-based parameter mapping ───
  const edgeImageUrls: string[] = [];
  if (stepDef.input_edges && stepDef.input_edges.length > 0) {
    for (const edge of stepDef.input_edges) {
      let rawValue: string | undefined;
      const sourceStepResult = priorResults.find((r) => {
        const sourceStep = steps.findIndex((s) => s.node_id === edge.source_node_id);
        return r.step_index === sourceStep && r.status === "completed";
      });
      if (sourceStepResult) {
        const outputKey = edge.source_handle || "output_video";
        rawValue = sourceStepResult.outputs?.[outputKey] ?? sourceStepResult.result_url;
      }
      if (!rawValue) {
        const inputUrls = (execution.pricing_info as Record<string, unknown>)?.input_urls as Record<string, string> | undefined;
        if (inputUrls?.[edge.source_node_id]) rawValue = inputUrls[edge.source_node_id];
      }
      if (!rawValue || !edge.target_handle) continue;

      const handleDef = normalizeHandle(stepDef.provider, edge.target_handle);
      if (handleDef) {
        validateEdgeValue(rawValue, handleDef.data_type, edge.target_handle);
        if (handleDef.internal_key === "image_url" && handleDef.data_type === "image") {
          edgeImageUrls.push(rawValue);
          if (!stepParams[handleDef.internal_key]) stepParams[handleDef.internal_key] = rawValue;
        } else {
          stepParams[handleDef.internal_key] = rawValue;
        }
      } else {
        stepParams[edge.target_handle] = rawValue;
      }
    }
  }

  const existingMentionUrls = (stepParams.mention_image_urls as string[] | undefined) ?? [];
  const allAggregatedImages = [...new Set([...allMentionedImageUrls, ...edgeImageUrls, ...existingMentionUrls])];
  if (allAggregatedImages.length > 0) {
    stepParams.mention_image_urls = allAggregatedImages;
    if (!stepParams.image_url) stepParams.image_url = allAggregatedImages[0];
  }

  console.log(
    `[step-executor] Executing step ${stepIndex} (${stepDef.node_type}/${stepDef.provider}) ` +
    `with inline budget (${INLINE_BUDGET_ATTEMPTS} attempts) → enqueue on exhaustion`,
  );

  // ─── Execute with inline budget (4 attempts, ~90s) ───────────────
  const runOnce = async (): Promise<ProviderResult> => {
    switch (stepDef.provider) {
      case "kling":
      case "kling_extension":
      case "motion_control":
        return await executeKling(stepParams);
      case "banana":
        return await executeBanana(stepParams, SUPABASE_URL, token);
      case "chat_ai":
        return await executeChatAi(stepParams);
      case "remove_bg":
        return await executeRemoveBg(stepParams);
      case "merge_audio":
        return await executeMergeAudio(stepParams);
      case "mp3_input":
        return {
          result_url: String(stepParams.audio_url ?? stepParams.previewUrl ?? ""),
          outputs: { output_audio: String(stepParams.audio_url ?? stepParams.previewUrl ?? "") },
          output_type: "video_url" as const,
          provider_meta: { provider: "mp3_input", passthrough: true },
        };
      default:
        throw new Error(`No executor for provider: ${stepDef.provider}`);
    }
  };

  const inlineOutcome = await executeWithInlineBudget<ProviderResult>(
    runOnce,
    `[step-executor ${stepIndex} ${stepDef.provider}]`,
  );

  console.log(
    `[step-executor] Step ${stepIndex} inline outcome: classification=${inlineOutcome.classification}, ` +
    `attempts=${inlineOutcome.attempts}/${INLINE_BUDGET_ATTEMPTS}`,
  );

  // ── SUCCESS path ─────────────────────────────────────────────────
  if (inlineOutcome.classification === "success" && inlineOutcome.result) {
    const stepResult = inlineOutcome.result;
    const isAsync = stepDef.is_async && !!stepResult.task_id;
    return {
      step_index: stepIndex, node_id: stepDef.node_id, node_type: stepDef.node_type,
      provider: stepDef.provider,
      status: isAsync ? "running" : "completed",
      result_url: stepResult.result_url ?? undefined,
      outputs: stepResult.outputs,
      task_id: stepResult.task_id ?? undefined,
      output_type: stepResult.output_type,
      provider_meta: stepResult.provider_meta,
      is_async: isAsync,
    };
  }

  // ── PERMANENT path — refund immediately ──────────────────────────
  if (inlineOutcome.classification === "permanent") {
    const errMsg = inlineOutcome.error?.message || "Unknown permanent error";
    console.error(`[step-executor] Step ${stepIndex} PERMANENT: ${errMsg}`);
    return {
      step_index: stepIndex, node_id: stepDef.node_id, node_type: stepDef.node_type,
      provider: stepDef.provider, status: "failed",
      output_type: stepDef.output_type, is_async: stepDef.is_async,
      error: `${errMsg} (permanent error — content/billing/safety, not retried)`,
    };
  }

  // ── EXHAUSTED_INLINE path — enqueue for worker ───────────────────
  // Only enqueue if part of a flow_run. Stand-alone executions → fail.
  const flowRunId = execution.flow_run_id as string | undefined;
  if (!flowRunId) {
    const errMsg = inlineOutcome.error?.message || "Unknown error";
    console.warn(`[step-executor] Step ${stepIndex} no flow_run_id, skipping queue: ${errMsg}`);
    return {
      step_index: stepIndex, node_id: stepDef.node_id, node_type: stepDef.node_type,
      provider: stepDef.provider, status: "failed",
      output_type: stepDef.output_type, is_async: stepDef.is_async,
      error: `${errMsg} (inline budget exhausted, no flow_run_id to queue)`,
    };
  }

  const resumePayload = {
    execution_id: execution.id,
    step_index: stepIndex,
    user_id: execution.user_id,
    flow_id: execution.flow_id,
    enqueued_at: new Date().toISOString(),
    first_error: inlineOutcome.error?.message?.substring(0, 500) ?? null,
  };

  const jobId = await enqueueRetryJob({
    supabase: supabase as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    },
    flow_run_id: flowRunId,
    step_index: stepIndex,
    node_id: stepDef.node_id,
    provider: stepDef.provider,
    node_type: stepDef.node_type,
    resume_payload: resumePayload,
    last_error: inlineOutcome.error?.message ?? "Unknown transient error",
  });

  if (!jobId) {
    console.error(`[step-executor] Step ${stepIndex} enqueue FAILED, returning as failed`);
    return {
      step_index: stepIndex, node_id: stepDef.node_id, node_type: stepDef.node_type,
      provider: stepDef.provider, status: "failed",
      output_type: stepDef.output_type, is_async: stepDef.is_async,
      error: `${inlineOutcome.error?.message} (inline budget exhausted + enqueue failed)`,
    };
  }

  console.log(`[step-executor] Step ${stepIndex} ENQUEUED for retry — job_id=${jobId}`);
  return {
    step_index: stepIndex, node_id: stepDef.node_id, node_type: stepDef.node_type,
    provider: stepDef.provider, status: "queued_for_retry",
    output_type: stepDef.output_type, is_async: stepDef.is_async,
    retry_job_id: jobId,
    error: `Transient error, queued for async retry (job ${jobId.substring(0, 8)}...)`,
  };
}

/* ═══════════════════════════════════════════════════════════
   Per-node refund + DB persistence
   ═══════════════════════════════════════════════════════════ */

async function persistStepOutcomes(
  supabase: ReturnType<typeof createClient>,
  execution: Record<string, unknown>,
  outcomes: StepOutcome[],
  steps: Array<{ node_id: string; node_type: string }>,
  userId: string,
): Promise<{ totalRefunded: number; refundedNodes: string[] }> {
  // Re-fetch latest step_results to merge atomically
  const { data: latest } = await supabase
    .from("pipeline_executions")
    .select("step_results, status")
    .eq("id", execution.id as string)
    .maybeSingle();

  const existing = (latest?.step_results ?? []) as Array<Record<string, unknown>>;
  const existingByIdx = new Map(existing.map((r) => [r.step_index as number, r]));

  // Track previous status per step for idempotent refund (only refund on transition INTO failed)
  const prevStatusByIdx = new Map<number, string | undefined>();
  for (const r of existing) {
    prevStatusByIdx.set(r.step_index as number, r.status as string | undefined);
  }

  for (const out of outcomes) {
    existingByIdx.set(out.step_index, {
      step_index: out.step_index,
      node_id: out.node_id,
      status: out.status,
      result_url: out.result_url,
      outputs: out.outputs,
      task_id: out.task_id,
      output_type: out.output_type,
      provider_meta: out.provider_meta,
      error: out.error,
      health_probe: out.health_probe,
      retry_job_id: out.retry_job_id,
    });
  }
  const merged = Array.from(existingByIdx.values()).sort(
    (a, b) => (a.step_index as number) - (b.step_index as number),
  );

  // Per-node refund for failed/skipped nodes — IDEMPOTENT GUARD:
  // Only refund on transition INTO failed/skipped. If the previous status was
  // already failed/skipped, the refund was already issued — skip.
  const perNodeCostMap = ((execution.pricing_info as Record<string, unknown>)?.per_node_cost_map ?? {}) as Record<string, number>;
  const credits_deducted = (execution.credits_deducted as number) ?? 0;
  let totalRefunded = 0;
  const refundedNodes: string[] = [];

  for (const out of outcomes) {
    if (out.status !== "failed" && out.status !== "skipped") continue;
    const prevStatus = prevStatusByIdx.get(out.step_index);
    if (prevStatus === "failed" || prevStatus === "skipped") {
      console.log(`[step-executor] Step ${out.step_index} already in terminal state (${prevStatus}), skipping refund (idempotent)`);
      continue;
    }
    const refundAmount = perNodeCostMap[out.node_id] ?? 0;
    if (refundAmount <= 0) {
      console.warn(`[step-executor] No cost found for node ${out.node_id}, skipping refund`);
      continue;
    }
    try {
      await refundCreditsAtomic(
        supabase, userId, refundAmount,
        `Refund: node "${out.node_id}" (${out.provider}) ${out.status} - ${(out.error ?? "").substring(0, 80)}`,
        (execution.flow_run_id as string) || (execution.flow_id as string),
      );
      totalRefunded += refundAmount;
      refundedNodes.push(out.node_id);
      console.log(`[step-executor] Refunded ${refundAmount} credits for node ${out.node_id}`);
    } catch (refundErr) {
      console.error(`[step-executor] Refund failed for node ${out.node_id}:`, refundErr);
    }
  }

  // Recompute pipeline status: completed/running/failed/partial
  const totalSteps = (execution.total_steps as number) ?? merged.length;
  const allDone = merged.length === totalSteps;
  const anyRunning = merged.some((r) => r.status === "running");
  const anyQueued = merged.some((r) => r.status === "queued_for_retry");
  const anyFailed = merged.some((r) => r.status === "failed" || r.status === "skipped");
  const allFailed = allDone && merged.every((r) => r.status === "failed" || r.status === "skipped");

  let pipelineStatus: string;
  if (anyRunning || anyQueued) pipelineStatus = "running";
  else if (allDone && allFailed) pipelineStatus = "failed_refunded";
  else if (allDone && anyFailed) pipelineStatus = "completed_partial";
  else if (allDone) pipelineStatus = "completed";
  else pipelineStatus = "running";

  if (anyQueued) {
    console.log(`[step-executor] Flow has queued_for_retry step(s) — keeping pipeline status as 'running'`);
  }

  await supabase
    .from("pipeline_executions")
    .update({
      status: pipelineStatus,
      step_results: merged,
      updated_at: new Date().toISOString(),
      ...(totalRefunded > 0 ? { credits_refunded: ((execution.credits_refunded as number) ?? 0) + totalRefunded } : {}),
    })
    .eq("id", execution.id as string);

  // Update flow_run aggregate when terminal
  if ((pipelineStatus === "completed" || pipelineStatus === "completed_partial" || pipelineStatus === "failed_refunded") && execution.flow_run_id) {
    const aggregatedByNode: Record<string, unknown> = {};
    for (const sr of merged) {
      const nodeId = (sr.node_id || `step_${sr.step_index}`) as string;
      aggregatedByNode[nodeId] = {
        result_url: sr.result_url ?? undefined,
        outputs: sr.outputs ?? undefined,
        output_type: sr.output_type ?? undefined,
        status: sr.status ?? undefined,
        error: sr.error ?? undefined,
      };
    }
    const lastCompleted = [...merged].reverse().find((r) => r.status === "completed");
    const finalRunStatus = pipelineStatus === "failed_refunded"
      ? "failed_refunded"
      : (pipelineStatus === "completed_partial" ? "completed_partial" : "completed");

    await supabase
      .from("flow_runs")
      .update({
        status: finalRunStatus,
        outputs: {
          result_url: (lastCompleted?.result_url as string | undefined) ?? null,
          output_type: (lastCompleted?.output_type as string | undefined) ?? null,
          credit_cost: credits_deducted,
          credits_refunded: totalRefunded,
          pipeline_steps: steps.map((s) => s.node_type),
          by_node: aggregatedByNode,
          partial_failure: pipelineStatus === "completed_partial",
        },
        ...(totalRefunded > 0 ? { error_message: `Partial failure: refunded ${totalRefunded} credits across ${refundedNodes.length} node(s)` } : {}),
        completed_at: new Date().toISOString(),
      })
      .eq("id", execution.flow_run_id as string);

    // Auto-save successful results
    for (const sr of merged) {
      if (sr.status !== "completed" || !sr.result_url) continue;
      const fileType = (sr.output_type as string) === "image_url" ? "image"
        : (sr.output_type as string) === "video_url" ? "video" : "image";
      try {
        await supabase.from("user_assets").insert({
          user_id: userId,
          name: `workflow-${fileType}-${Date.now()}`,
          file_url: sr.result_url as string,
          file_type: fileType,
          source: "workflow",
          category: "generated",
          metadata: { flow_id: execution.flow_id, flow_run_id: execution.flow_run_id, node_id: sr.node_id },
        });
      } catch (assetErr) {
        console.warn("[step-executor] Failed to auto-save asset:", assetErr);
      }
    }
  }

  return { totalRefunded, refundedNodes };
}

/* ═══════════════════════════════════════════════════════════
   Main Handler — supports two modes:
   1. { execution_id, step_index } — legacy single-step (backward compatible)
   2. { execution_id, step_indices: number[] } — NEW parallel level execution
   ═══════════════════════════════════════════════════════════ */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  let loggedUserId: string | null = null;
  let loggedExecutionId: string | null = null;
  let loggedStepIndex: number | string | null = null;
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ─── Read body ONCE up front (resume mode + normal mode both need it) ──
    const url = new URL(req.url);
    const rawBody = await req.text();
    let parsedBody: Record<string, unknown> = {};
    try { parsedBody = rawBody ? JSON.parse(rawBody) : {}; } catch { /* ignore */ }
    const mode = (parsedBody.mode as string | undefined) ?? url.searchParams.get("mode") ?? undefined;

    // ═══════════════════════════════════════════════════════════════
    // RESUME MODE — called by retry-worker via x-cron-secret
    // ═══════════════════════════════════════════════════════════════
    if (mode === "resume") {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      const providedSecret = req.headers.get("x-cron-secret");
      const { data: expectedSecret, error: secretErr } = await supabase.rpc("get_retry_worker_cron_secret");
      if (secretErr || !expectedSecret || providedSecret !== expectedSecret) {
        console.warn("[resume-mode] missing or invalid x-cron-secret");
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const jobId = (parsedBody.job_id as string | undefined) ?? url.searchParams.get("job_id") ?? undefined;
      if (!jobId) {
        return new Response(JSON.stringify({ error: "job_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: job, error: jobErr } = await supabase
        .from("provider_retry_queue")
        .select("*")
        .eq("id", jobId)
        .maybeSingle();
      if (jobErr || !job) {
        console.error("[resume-mode] job not found:", jobId, jobErr);
        return new Response(JSON.stringify({ error: "job_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (job.status !== "processing") {
        console.warn(`[resume-mode] job ${jobId} not in processing state (actual: ${job.status})`);
        return new Response(JSON.stringify({ error: "job_not_processing", status: job.status }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const payload = job.resume_payload as {
        execution_id: string; step_index: number; user_id: string; flow_id?: string;
      };

      const { data: execution, error: execErr } = await supabase
        .from("pipeline_executions")
        .select("*")
        .eq("id", payload.execution_id)
        .maybeSingle();

      if (execErr || !execution) {
        console.error("[resume-mode] execution not found");
        await supabase.rpc("fail_retry_job", {
          p_job_id: jobId,
          p_error: "execution_not_found_at_resume",
          p_classification: "permanent",
        });
        return new Response(JSON.stringify({ error: "execution_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const steps = execution.steps as Array<{
        node_id: string; node_type: string; provider: string; is_async: boolean;
        output_type: string; params: Record<string, unknown>;
        input_edges: Array<{ source_node_id: string; target_handle: string; source_handle: string }>;
        level?: number;
      }>;
      const priorResults = (execution.step_results ?? []) as Array<{
        step_index: number; status: string; node_id?: string; result_url?: string;
        outputs?: Record<string, string>; task_id?: string; output_type: string;
        provider_meta?: Record<string, unknown>;
      }>;

      const stepIndex = payload.step_index;
      console.log(`[resume-mode] Retrying step ${stepIndex} (job ${jobId}, attempt ${job.attempt})`);

      try {
        // Pass service role as token — Banana executor uses it for internal calls.
        const outcome = await executeOneStep(
          supabase as ReturnType<typeof createClient>,
          execution,
          stepIndex,
          steps,
          priorResults,
          SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY,
        );

        // SUCCESS
        if (outcome.status === "completed" || outcome.status === "running") {
          console.log(`[resume-mode] Step ${stepIndex} SUCCEEDED on retry`);
          await supabase.rpc("complete_retry_job", { p_job_id: jobId });
          await persistStepOutcomes(
            supabase as ReturnType<typeof createClient>,
            execution,
            [outcome],
            steps,
            payload.user_id,
          );
          return new Response(JSON.stringify({ success: true, status: outcome.status }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // queued_for_retry inside resume → would loop; treat as transient fail.
        if (outcome.status === "queued_for_retry") {
          console.error(`[resume-mode] Step ${stepIndex} returned queued_for_retry unexpectedly`);
          await supabase.rpc("fail_retry_job", {
            p_job_id: jobId,
            p_error: "unexpected_requeue_during_resume",
            p_classification: "transient",
          });
          return new Response(JSON.stringify({ success: false, status: "requeued" }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // FAILED / SKIPPED → fail_retry_job handles backoff + dead-letter
        const errMsg = outcome.error ?? "Unknown error";
        const classification = classifyError(errMsg) === "permanent" ? "permanent" : "transient";
        console.warn(`[resume-mode] Step ${stepIndex} failed: ${errMsg} (classification=${classification})`);

        const { data: failResult } = await supabase.rpc("fail_retry_job", {
          p_job_id: jobId, p_error: errMsg, p_classification: classification,
        });
        const finalStatus =
          (failResult as Array<{ final_status: string }> | null)?.[0]?.final_status ?? "pending";

        // Terminal → persist final failure + refund (idempotent guard handles re-entry)
        if (finalStatus === "failed" || finalStatus === "dead") {
          console.log(`[resume-mode] Job ${jobId} reached terminal state: ${finalStatus}`);
          await persistStepOutcomes(
            supabase as ReturnType<typeof createClient>,
            execution,
            [{ ...outcome, status: "failed" }],
            steps,
            payload.user_id,
          );
        }

        return new Response(JSON.stringify({ success: false, finalStatus, error: errMsg }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[resume-mode] Unhandled error:`, errMsg);
        await supabase.rpc("fail_retry_job", {
          p_job_id: jobId, p_error: errMsg, p_classification: "transient",
        });
        return new Response(JSON.stringify({ error: errMsg }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // NORMAL MODE — JWT auth + execute steps
    // ═══════════════════════════════════════════════════════════════
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    loggedUserId = user.id;

    const { execution_id, step_index, step_indices } = parsedBody as {
      execution_id: string;
      step_index?: number;
      step_indices?: number[];
    };

    if (!execution_id) {
      return new Response(JSON.stringify({ error: "execution_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Determine step index list (single-step OR level mode)
    let indices: number[];
    if (Array.isArray(step_indices) && step_indices.length > 0) {
      indices = [...step_indices];
    } else if (typeof step_index === "number") {
      indices = [step_index];
    } else {
      return new Response(JSON.stringify({ error: "step_index or step_indices required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    loggedExecutionId = execution_id;
    loggedStepIndex = indices.length === 1 ? indices[0] : indices.join(",");

    // Fetch execution
    const { data: execution, error: execErr } = await supabase
      .from("pipeline_executions")
      .select("*")
      .eq("id", execution_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (execErr || !execution) {
      return new Response(JSON.stringify({ error: "Execution not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (execution.status === "failed_refunded") {
      return new Response(JSON.stringify({ error: "Execution already failed", status: execution.status }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const steps = execution.steps as Array<{
      node_id: string; node_type: string; provider: string; is_async: boolean;
      output_type: string; params: Record<string, unknown>;
      input_edges: Array<{ source_node_id: string; target_handle: string; source_handle: string }>;
      level?: number;
    }>;
    const priorResults = (execution.step_results ?? []) as Array<{
      step_index: number; status: string; node_id?: string; result_url?: string;
      outputs?: Record<string, string>; task_id?: string; output_type: string;
      provider_meta?: Record<string, unknown>;
    }>;

    // Validate indices
    for (const idx of indices) {
      if (idx < 0 || idx >= execution.total_steps) {
        return new Response(JSON.stringify({ error: `Step index ${idx} out of range` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Update status to running
    await supabase
      .from("pipeline_executions")
      .update({ status: "running", current_step: indices[0], updated_at: new Date().toISOString() })
      .eq("id", execution_id);

    console.log(`[step-executor] Running ${indices.length} step(s) in parallel: [${indices.join(",")}]`);

    // Execute all steps in parallel — Promise.allSettled isolates failures
    const settled = await Promise.allSettled(
      indices.map((idx) => executeOneStep(supabase, execution, idx, steps, priorResults, SUPABASE_URL, token)),
    );

    const outcomes: StepOutcome[] = settled.map((res, i) => {
      if (res.status === "fulfilled") return res.value;
      const idx = indices[i];
      const stepDef = steps[idx];
      return {
        step_index: idx,
        node_id: stepDef?.node_id ?? "?",
        node_type: stepDef?.node_type ?? "?",
        provider: stepDef?.provider ?? "?",
        status: "failed",
        output_type: stepDef?.output_type ?? "image_url",
        is_async: stepDef?.is_async ?? false,
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      };
    });

    // Persist + per-node refund
    const { totalRefunded, refundedNodes } = await persistStepOutcomes(
      supabase, execution, outcomes, steps, user.id,
    );

    // Logging
    for (const out of outcomes) {
      await logApiUsage(supabase, {
        user_id: user.id,
        endpoint: "execute-pipeline-step",
        feature: `flow_run:${out.provider}`,
        model: String(steps[out.step_index]?.params?.model_name ?? out.node_type),
        status: out.status === "failed" || out.status === "skipped" ? "error" : "success",
        credits_used: 0,
        credits_refunded: out.status === "failed" || out.status === "skipped"
          ? (((execution.pricing_info as Record<string, unknown>)?.per_node_cost_map as Record<string, number> | undefined)?.[out.node_id] ?? 0)
          : 0,
        duration_ms: Date.now() - startTime,
        error_message: out.error?.substring(0, 500),
        request_metadata: {
          execution_id, flow_id: execution.flow_id, flow_run_id: execution.flow_run_id,
          step_index: out.step_index, node_id: out.node_id, node_type: out.node_type,
          provider: out.provider, parallel_batch_size: indices.length,
        },
      });
    }

    return new Response(
      JSON.stringify({
        execution_id,
        outcomes: outcomes.map((o) => ({
          step_index: o.step_index, node_id: o.node_id, status: o.status,
          result_url: o.result_url ?? null, outputs: o.outputs ?? null,
          task_id: o.task_id ?? null, output_type: o.output_type,
          is_async: o.is_async, error: o.error ?? null,
        })),
        total_refunded: totalRefunded,
        refunded_nodes: refundedNodes,
        run_id: execution.flow_run_id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[step-executor] Top-level error:", e);
    try {
      const logClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await logApiUsage(logClient, {
        user_id: loggedUserId ?? "system",
        endpoint: "execute-pipeline-step",
        feature: "flow_run:unhandled_crash",
        status: "error",
        duration_ms: Date.now() - startTime,
        error_message: (e instanceof Error ? e.message : String(e)).substring(0, 500),
        request_metadata: { execution_id: loggedExecutionId, step_index: loggedStepIndex },
      });
    } catch (_) { /* best-effort */ }
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
