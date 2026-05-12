/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  bytesToBase64,
  extractImageDimensions,
  fetchImageBuffer,
  findClosestAspectRatio,
  imageUrlToBase64,
} from "./imageUtils.ts";
import { isProviderBillingLike } from "./providerErrors.ts";
import type { MentionedAssetSrv } from "./mentions.ts";
import type { ProviderResult } from "./providerResult.ts";

export const KLING_MODEL_MAP: Record<string, { model: string; mode: string; isMotion?: boolean; isOmni?: boolean }> = {
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

/**
 * Format a Kling API error body into a user-friendly message.
 *
 * Kling validation failures arrive as JSON like:
 *   { code: 1201, message: "prompt: size must be between 0 and 2500", request_id: "..." }
 * Surfacing the raw payload (with JSON braces and request_id) in the
 * UI toast makes the error unreadable. Map known codes to clean
 * messages and otherwise extract `message` from the JSON when present.
 *
 * Code 1201 = prompt-size violation. We DO want this to reach the
 * client (it's an actionable user error, not a transient provider
 * fault), so do NOT classify it as PROVIDER_BILLING_ERROR.
 */
export function formatKlingApiError(label: string, status: number, errText: string): string {
  try {
    const parsed = JSON.parse(errText) as { code?: number; message?: string };
    if (typeof parsed?.message === "string" && parsed.message) {
      const base = `${label} (HTTP ${status}): ${parsed.message}`;
      // Code 1201 is Kling's generic "request parameter error" — it covers
      // mode/model mismatches, missing fields, and prompt-length issues
      // alike. Only append the prompt-shortening hint when the message
      // actually looks length-related; otherwise it misleads users with
      // 100-character prompts who hit a different parameter problem.
      const looksLengthRelated = /character|length|too long|exceed|2500/i.test(parsed.message);
      if (parsed.code === 1201 && looksLengthRelated) {
        return `${base} (Kling caps prompts at 2500 characters — try shortening.)`;
      }
      return base;
    }
  } catch {
    // not JSON — fall through to the raw substring fallback
  }
  return `${label} (HTTP ${status}): ${errText.substring(0, 200)}`;
}

export async function generateKlingJWT(accessKeyId: string, secretKey: string): Promise<string> {
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

export async function executeKling(
  params: Record<string, unknown>,
  supabaseClient: ReturnType<typeof createClient>,
  mentioned: MentionedAssetSrv[] = [],
): Promise<ProviderResult> {
  // Accept several common naming variants — workspace dev was set up
  // by hand and the secret names sometimes drift from the live project.
  const KLING_ACCESS_KEY_ID =
    Deno.env.get("KLING_ACCESS_KEY_ID") ??
    Deno.env.get("KLING_AK") ??
    Deno.env.get("KLING_ACCESS_KEY");
  const KLING_SECRET_KEY =
    Deno.env.get("KLING_SECRET_KEY") ??
    Deno.env.get("KLING_SK") ??
    Deno.env.get("KLING_SECRET");
  if (!KLING_ACCESS_KEY_ID || !KLING_SECRET_KEY) {
    throw new Error(
      "Kling credentials missing — set KLING_ACCESS_KEY_ID + KLING_SECRET_KEY in Supabase project secrets (workspace dev)."
    );
  }

  const modelSlug = String(params.model_name ?? params.model ?? "kling-v2-6-pro");
  const mapping = KLING_MODEL_MAP[modelSlug];
  if (!mapping) throw new Error(`Unknown Kling model: ${modelSlug}`);

  const jwtToken = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);

  // ── Omni models: separate endpoint & array-based payload ──
  if (mapping.isOmni) {
    return await executeKlingOmni(params, mapping, modelSlug, jwtToken, supabaseClient, mentioned);
  }

  // ── Non-Omni paths (Standard I2V/T2V, Motion Control) don't have an
  //    array-indexed image_list, so positional `@Element{N}`/`@Image{N}`
  //    syntax doesn't apply. Strip raw `@[Label](nodeId)` and plain
  //    `@<label>` tokens to bare label so the model just reads natural
  //    language. Same behaviour the old `rewriteMentionsInline` had
  //    for non-OpenAI providers, kept here so the V2 dispatcher can
  //    safely skip its generic rewrite for the entire kling family.
  for (const [key, val] of Object.entries(params)) {
    if (typeof val !== "string" || !val.includes("@")) continue;
    let out = val.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (full, label, nodeId) => {
      if (modelSlug === "kling-v3-pro") {
        const hit = mentioned.find((m) => m.nodeId === nodeId);
        if (hit?.kind === "element") return full;
      }
      return label;
    });
    out = out.replace(/@([^\s@[]+)/g, (full, name) => {
      const hit = mentioned.find(
        (m) => m.label === name && m.kind !== "element",
      );
      return hit ? name : full;
    });
    params[key] = out;
  }

  // ── Motion Control: completely separate endpoint & payload ──
  if (mapping.isMotion) {
    return await executeKlingMotionControl(params, mapping, modelSlug, jwtToken);
  }

  // ── Standard Image-to-Video / Text-to-Video ──
  return await executeKlingStandard(params, mapping, modelSlug, jwtToken, mentioned);
}

export function normalizeDirectKlingMode(
  _params: Record<string, unknown>,
  fallbackMode: string,
): "std" | "pro" {
  // The function used to read `params.mode` / `quality_mode` / `resolution`
  // from the caller, but every workspace-app entry point already encodes
  // the correct mode in the slug → KLING_MODEL_MAP mapping (every current
  // entry is `pro`), and the param channels were a silent downgrade path:
  // a stale `resolution: "720p"` left on the canvas after switching from
  // Seedance turned a Pro selection into Standard, then Kling rejected
  // image_tail with a confusing 1201. Honour only the mapping default.
  const raw = String(fallbackMode).toLowerCase();
  return raw === "std" || raw === "standard" ? "std" : "pro";
}

/**
 * Poll a Kling task until it completes. Workspace V2 runs inline so the
 * caller is waiting on an open HTTP request — we burn wall-clock here
 * instead of returning a half-formed result the frontend has to babysit.
 *
 * `endpointBase` MUST be the same URL as the POST that created the task,
 * e.g. ".../v1/videos/omni-video" → poll at ".../v1/videos/omni-video/{id}".
 *
 * Supabase Edge Functions cap CPU/wall-clock around 400s; we stop at 320s
 * to leave room for the response trip back. Most Kling jobs land in 30-90s.
 */
export async function pollKlingVideo(
  taskId: string,
  jwtToken: string,
  endpointBase: string,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<{ url: string; raw: Record<string, unknown> }> {
  const timeoutMs = opts.timeoutMs ?? 320_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const label = opts.label ?? "kling";
  const url = `${endpointBase}/${encodeURIComponent(taskId)}`;
  const started = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) {
      throw new Error(
        `[${label}] Polling timed out after ${Math.round(elapsed / 1000)}s (task_id=${taskId}). ` +
          `Job may still complete on Kling's side — check the dashboard.`,
      );
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${jwtToken}` },
      });
    } catch (netErr) {
      console.warn(`[${label}] poll attempt ${attempt} network error, retrying:`, netErr);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // 5xx / transient — keep polling. 4xx — give up.
      if (res.status >= 500) {
        console.warn(`[${label}] poll attempt ${attempt} HTTP ${res.status}: ${errText.substring(0, 200)}`);
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      throw new Error(`[${label}] Status check failed (HTTP ${res.status}): ${errText.substring(0, 200)}`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await res.json();
    } catch {
      console.warn(`[${label}] poll attempt ${attempt} unparseable JSON, retrying`);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    const data = (payload?.data ?? {}) as Record<string, unknown>;
    const status = String(data.task_status ?? "").toLowerCase();
    const statusMsg = String(data.task_status_msg ?? payload?.message ?? "");

    if (status === "succeed" || status === "success") {
      const taskResult = (data.task_result ?? {}) as Record<string, unknown>;
      const videos = Array.isArray(taskResult.videos) ? (taskResult.videos as Array<Record<string, unknown>>) : [];
      const videoUrl = videos.length > 0 ? String(videos[0]?.url ?? "") : "";
      if (!videoUrl) {
        throw new Error(`[${label}] Task succeeded but response had no video URL (task_id=${taskId})`);
      }
      console.log(`[${label}] Task ${taskId} succeeded after ${Math.round(elapsed / 1000)}s (${attempt} polls)`);
      return { url: videoUrl, raw: payload };
    }

    if (status === "failed" || status === "fail") {
      throw new Error(`[${label}] Task failed: ${statusMsg || "no detail"} (task_id=${taskId})`);
    }

    // submitted / processing / queued → keep waiting
    if (attempt === 1 || attempt % 6 === 0) {
      console.log(`[${label}] Task ${taskId} status=${status || "(empty)"} elapsed=${Math.round(elapsed / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Motion Control endpoint: POST /v1/videos/motion-control
 * Requires image_url + video_url. Duration is auto-determined by the video.
 * Does NOT accept duration or aspect_ratio params.
 */
export async function executeKlingMotionControl(
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
  const characterOrientation = String(params.character_orientation ?? "video");
  const mode = normalizeDirectKlingMode(params, mapping.mode);

  const body: Record<string, unknown> = {
    model_name: mapping.model,
    mode,
    image_url: imagePayload,
    video_url: rawVideoUrl,
    keep_original_sound: keepOriginalSound,
    character_orientation: characterOrientation,
  };

  // Prompt is optional for motion control
  const prompt = String(params.prompt ?? "").trim();
  if (prompt) body.prompt = prompt;

  if (modelSlug === "kling-v3-motion-pro" && Array.isArray(params.elements)) {
    const elementList: Array<Record<string, unknown>> = [];
    for (const rawElement of params.elements) {
      if (!rawElement || typeof rawElement !== "object") continue;
      const e = rawElement as Record<string, unknown>;
      const name = String(e.name ?? "element");
      const refs = Array.isArray(e.reference_image_urls)
        ? (e.reference_image_urls as unknown[]).filter(
            (u): u is string => typeof u === "string" && u.length > 0,
          )
        : [];
      const frontal = typeof e.frontal_image_url === "string" ? e.frontal_image_url : undefined;
      const refsB64: string[] = [];
      for (const u of refs.slice(0, 4)) {
        try {
          const bytes = await fetchImageBuffer(u);
          refsB64.push(bytesToBase64(bytes));
        } catch {
          refsB64.push(u);
        }
      }
      let frontalB64: string | undefined;
      if (frontal) {
        try {
          const bytes = await fetchImageBuffer(frontal);
          frontalB64 = bytesToBase64(bytes);
        } catch {
          frontalB64 = frontal;
        }
      }
      if (refsB64.length === 0 && !frontalB64) continue;
      const entry: Record<string, unknown> = { name };
      if (refsB64.length > 0) entry.reference_image_urls = refsB64;
      if (frontalB64) entry.frontal_image_url = frontalB64;
      elementList.push(entry);
      if (elementList.length >= 1) break;
    }
    if (elementList.length > 0) body.elements = elementList;
  }

  console.log(`[kling-motion] POST ${ENDPOINT} model=${mapping.model} mode=${mode} orientation=${characterOrientation}`);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[kling-motion] API HTTP ${res.status}: ${errText.substring(0, 500)}`);
    if (isProviderBillingLike(res.status, errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(formatKlingApiError("Kling Motion API error", res.status, errText));
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
    if (isProviderBillingLike(0, message)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(message || "Kling Motion API error");
  }

  const taskId = String((result?.data as Record<string, unknown>)?.task_id ?? "");
  if (!taskId) {
    throw new Error("Kling Motion API did not return a task_id");
  }

  // Async — frontend polls via action="poll_kling" until task succeeds.
  return {
    task_id: taskId,
    outputs: {
      output_video: "",
      output_start_frame: rawImageUrl || "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      model: modelSlug,
      mode,
      is_motion_control: true,
      poll_endpoint: ENDPOINT,
    },
  };
}

/**
 * Standard I2V / T2V endpoints
 */
export async function executeKlingStandard(
  params: Record<string, unknown>,
  mapping: { model: string; mode: string },
  modelSlug: string,
  jwtToken: string,
  mentioned: MentionedAssetSrv[] = [],
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
  if (rawTailUrl && !rawImageUrl) {
    throw new Error("Validation: End frame requires a start frame.");
  }
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

  const initialMode = normalizeDirectKlingMode(params, mapping.mode);
  // image_tail (end-frame) is only valid in pro mode on Kling v2.6+. The
  // mode normalizer above already forces pro when a tail is present, so
  // landing on std here means the mapping itself was std (no current
  // KLING_MODEL_MAP entry maps to std, but guard anyway). Fail fast with
  // a clear message — letting Kling reject loses the user the wait time.
  if (rawTailUrl && initialMode !== "pro") {
    throw new Error(
      "Validation: End frame requires Kling Pro mode — pick a Pro model variant or remove the end frame.",
    );
  }
  let durationValue = parseInt(String(params.duration ?? 5), 10) || 5;
  if (mapping.model === "kling-v3") {
    durationValue = Math.max(3, Math.min(durationValue, 15));
  }

  const body: Record<string, unknown> = {
    model_name: mapping.model,
    mode: initialMode,
    duration: String(durationValue),
    aspect_ratio: resolvedAspect,
  };

  // Strip any data-URI prefix from base64 strings (Kling rejects prefixed base64)
  const stripBase64Prefix = (b64: string) => b64.replace(/^data:image\/\w+;base64,/, "");

  if (imageBase64) body.image = stripBase64Prefix(imageBase64);
  else if (rawImageUrl) body.image = rawImageUrl;
  if (rawTailUrl) body.image_tail = tailImageBase64 ? stripBase64Prefix(tailImageBase64) : rawTailUrl;
  if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
  // ── Native audio toggle ──
  // Kling 2.6 / 3.0 standard image2video / text2video accept the
  // `enable_audio` boolean (per Kling's native API + every wrapper
  // surfacing the v2.6 native-audio feature). The earlier code sent
  // `sound: true` here — that's the OMNI endpoint's field name and
  // is silently dropped by Standard, so audio never generated.
  // Omni keeps using `sound: "on"|"off"` in executeKlingOmni below.
  if (params.has_audio === "true" || params.has_audio === true) {
    body.enable_audio = true;
  }

  type StandardElementEntry = {
    name: string;
    reference_image_urls: string[];
    frontal_image_url?: string;
    brand_element_id?: string;
  };
  const standardElements: StandardElementEntry[] = [];
  const pushElement = (entry: StandardElementEntry) => {
    if (entry.reference_image_urls.length === 0 && !entry.frontal_image_url) return;
    const existing = standardElements.findIndex(
      (e) =>
        (entry.brand_element_id && e.brand_element_id === entry.brand_element_id) ||
        e.name === entry.name,
    );
    if (existing >= 0) return;
    standardElements.push(entry);
  };
  if (modelSlug === "kling-v3-pro" && Array.isArray(params.elements)) {
    for (const rawElement of params.elements) {
      if (!rawElement || typeof rawElement !== "object") continue;
      const e = rawElement as Record<string, unknown>;
      const refs = Array.isArray(e.reference_image_urls)
        ? (e.reference_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
        : [];
      pushElement({
        name: String(e.name ?? "element"),
        reference_image_urls: refs.slice(0, 4),
        frontal_image_url: typeof e.frontal_image_url === "string" ? e.frontal_image_url : undefined,
        brand_element_id: typeof e.brand_element_id === "string" ? e.brand_element_id : undefined,
      });
      if (standardElements.length >= 4) break;
    }
  }
  if (modelSlug === "kling-v3-pro") {
    for (const m of mentioned) {
      if (m.kind !== "element") continue;
      pushElement({
        name: m.name ?? m.label ?? "element",
        reference_image_urls: (m.reference_image_urls ?? []).slice(0, 4),
        frontal_image_url: m.frontal_image_url,
        brand_element_id: m.brand_element_id,
      });
      if (standardElements.length >= 4) break;
    }
  }

  const mentionByNodeId = new Map<string, number>();
  const mentionByLabel = new Map<string, number>();
  for (const m of mentioned) {
    if (m.kind !== "element") continue;
    const name = m.name ?? m.label ?? "element";
    const idx = standardElements.findIndex(
      (e) =>
        (m.brand_element_id && e.brand_element_id === m.brand_element_id) ||
        e.name === name,
    );
    if (idx < 0) continue;
    if (m.nodeId) mentionByNodeId.set(m.nodeId, idx);
    if (m.label) mentionByLabel.set(m.label, idx);
    if (m.name) mentionByLabel.set(m.name, idx);
  }
  const rewriteStandardKlingTokens = (s: string): string => {
    if (!s || !s.includes("@")) return s;
    let out = s.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_full, label: string, nodeId: string) => {
      const idx = mentionByNodeId.get(nodeId);
      return typeof idx === "number" ? `@Element${idx + 1}` : label;
    });
    out = out.replace(/@([^\s@[]+)/g, (full: string, name: string) => {
      const idx = mentionByLabel.get(name);
      return typeof idx === "number" ? `@Element${idx + 1}` : full;
    });
    return out;
  };

  const isMultiShot = (params.multi_shot === "true" || params.multi_shot === true) && modelSlug === "kling-v3-pro";
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
    body.multi_prompt = shots.map((shot, index) => ({
      index: index + 1,
      prompt: rewriteStandardKlingTokens(String(shot.prompt ?? "")),
      duration: String(Number(shot.duration) || 0),
    }));
  } else {
    const prompt = rewriteStandardKlingTokens(finalPrompt);
    if (prompt) body.prompt = prompt;
  }

  if (standardElements.length > 0) {
    const elementList: Array<Record<string, unknown>> = [];
    for (const e of standardElements) {
      const refsB64: string[] = [];
      for (const u of e.reference_image_urls.slice(0, 4)) {
        try {
          const bytes = await fetchImageBuffer(u);
          refsB64.push(bytesToBase64(bytes));
        } catch {
          refsB64.push(u);
        }
      }
      let frontalB64: string | undefined;
      if (e.frontal_image_url) {
        try {
          const bytes = await fetchImageBuffer(e.frontal_image_url);
          frontalB64 = bytesToBase64(bytes);
        } catch {
          frontalB64 = e.frontal_image_url;
        }
      }
      const entry: Record<string, unknown> = { name: e.name };
      if (refsB64.length > 0) entry.reference_image_urls = refsB64;
      if (frontalB64) entry.frontal_image_url = frontalB64;
      elementList.push(entry);
    }
    if (elementList.length > 0) body.elements = elementList;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[kling] API HTTP ${res.status}: ${errText.substring(0, 500)}`);
    if (isProviderBillingLike(res.status, errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(formatKlingApiError("Kling API error", res.status, errText));
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
    if (isProviderBillingLike(0, message)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(message || "Kling API error");
  }

  const taskId = String((result?.data as Record<string, unknown>)?.task_id ?? "");
  if (!taskId) {
    throw new Error("Kling API did not return a task_id");
  }

  // Async — frontend polls via action="poll_kling" until task succeeds.
  return {
    task_id: taskId,
    outputs: {
      output_video: "",
      output_start_frame: rawImageUrl || "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      model: modelSlug,
      mode: initialMode,
      is_image2video: !!rawImageUrl,
      aspect_ratio: resolvedAspect,
      poll_endpoint: endpoint,
    },
  };
}

/**
 * Omni Video endpoint: POST /v1/videos/omni-video
 * Supports image_list (array), video_list (array), flexible duration (3-15s),
 * multi_shot director mode, and combined audio controls.
 */
export async function executeKlingOmni(
  params: Record<string, unknown>,
  mapping: { model: string; mode: string },
  modelSlug: string,
  jwtToken: string,
  _supabaseClient: ReturnType<typeof createClient>,
  mentioned: MentionedAssetSrv[] = [],
): Promise<ProviderResult> {
  const ENDPOINT = "https://api.klingai.com/v1/videos/omni-video";

  const rawDuration = parseInt(String(params.duration ?? 5), 10) || 5;
  const duration = Math.max(3, Math.min(15, rawDuration));
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
  if (rawTailUrl && !rawImageUrl) {
    throw new Error("Validation: End frame requires a start frame.");
  }
  if (rawTailUrl) {
    let tailPayload = rawTailUrl;
    try {
      tailPayload = await imageUrlToBase64(rawTailUrl);
    } catch (convErr) {
      console.error(`[kling-omni] end_frame fetch failed:`, convErr);
    }
    imageList.push({ image_url: tailPayload, type: "end_frame" });
    // Wiring the SAME upstream node into both start + end ports is a
    // LEGITIMATE creative intent — the user wants motion that loops
    // back to the original shot (e.g. a 360° camera spin returning
    // to the start angle, a pendulum swing). An earlier version of
    // this code deduped the duplicate URL and dropped end_frame, but
    // that broke the loop-back use case (creatives wanted "ขยับแล้ว
    // กลับมาที่เดิม", not "no end_frame"). Keep both frames as-is and
    // rely on the prompt to drive the in-between motion. Log the
    // case so we can correlate with low-motion outputs in dashboard.
    if (rawImageUrl && rawTailUrl === rawImageUrl) {
      console.log(
        `[kling-omni] start_frame === end_frame — loop-back intent. ` +
          `Motion comes from prompt. URL=${
            rawImageUrl.length > 80 ? rawImageUrl.slice(0, 80) + "…" : rawImageUrl
          }`,
      );
    }
  }

  // Additional ref_image (no type constraint — general reference)
  const refImageUrls = [
    ...(Array.isArray(params.ref_image_urls)
      ? (params.ref_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
      : []),
    ...(typeof params.ref_image_url === "string" && params.ref_image_url.length > 0
      ? [params.ref_image_url]
      : []),
  ];
  for (const refImageUrl of Array.from(new Set(refImageUrls)).slice(0, 7)) {
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

  // ─────────────────────────────────────────────────────────────────
  // Kling Omni positional-mention rewrite
  // ─────────────────────────────────────────────────────────────────
  // Kling docs ([Freepik / Scenario]) say prompts reference attached
  // refs by 1-based index, NOT by the user-typed name:
  //   • elements[]    →  `@Element1`, `@Element2`, …
  //   • image_list[]  →  `@Image1`,   `@Image2`,   …
  //   • video_list[0] →  `@Video`
  //
  // The frontend ships every `@<chip>` it found as a `mentioned_assets`
  // entry tagged `kind: "asset" | "element"`. Below we:
  //   1. Pre-load elements that were wired through the explicit
  //      `elements` port (params.elements) so their indices come first.
  //   2. Walk mentions, dedupe against what's already wired (by URL for
  //      images, by brand_element_id|name for elements), and append.
  //   3. Stash a `nodeId → @Token` map so the prompt rewrite can pick
  //      the right anchor for each `@[Label](nodeId)` token.
  //
  // Order matters — `@Image1` is whatever sits at image_list[0], which
  // is the start_frame if one was wired. The rewrite below is the only
  // place that decides the mapping; the executor used to call the
  // legacy `resolveMentionsInPrompt`, which is DB-bound and silently
  // failed in V2. Removed in this pass.

  type MentionTarget = { kind: "element" | "image" | "video"; idx: number };

  // Track raw image-list source URLs (parallel to imageList[].image_url
  // which is base64 by now) so we can dedupe mentions against entries
  // that were already added via explicit edges.
  const imageSourceUrls: Array<string | undefined> = [];
  if (rawImageUrl) imageSourceUrls.push(rawImageUrl);
  if (rawTailUrl) imageSourceUrls.push(rawTailUrl);
  for (const refImageUrl of refImageUrls) imageSourceUrls.push(refImageUrl);

  type ElementEntry = {
    name: string;
    reference_image_urls: string[];
    frontal_image_url?: string;
    brand_element_id?: string;
  };
  const elementsPool: ElementEntry[] = [];
  const rawElementsParam = params.elements;
  if (Array.isArray(rawElementsParam)) {
    for (const e of rawElementsParam) {
      if (!e || typeof e !== "object") continue;
      const ee = e as Record<string, unknown>;
      const name = String(ee.name ?? "element");
      const refs = Array.isArray(ee.reference_image_urls)
        ? (ee.reference_image_urls as unknown[]).filter(
            (u): u is string => typeof u === "string" && !!u,
          )
        : [];
      const frontal = typeof ee.frontal_image_url === "string" ? ee.frontal_image_url : undefined;
      const beId = typeof ee.brand_element_id === "string" ? ee.brand_element_id : undefined;
      if (refs.length === 0 && !frontal) continue;
      elementsPool.push({
        name,
        reference_image_urls: refs,
        frontal_image_url: frontal,
        brand_element_id: beId,
      });
    }
  }

  const mentionByNodeId = new Map<string, MentionTarget>();
  const mentionByLabel = new Map<string, MentionTarget>();
  const newImageMentionUrls: string[] = [];

  for (const m of mentioned) {
    if (m.kind === "element" && (m.reference_image_urls?.length || m.frontal_image_url)) {
      // Dedupe against pool by brand_element_id (saved elements wired
      // via Asset Panel) or by name (creator-mode elements).
      const elName = m.name ?? m.label ?? "element";
      const existingIdx = elementsPool.findIndex(
        (e) =>
          (m.brand_element_id && e.brand_element_id === m.brand_element_id) ||
          e.name === elName,
      );
      let idx: number;
      if (existingIdx >= 0) {
        idx = existingIdx;
      } else {
        elementsPool.push({
          name: elName,
          reference_image_urls: m.reference_image_urls ?? [],
          frontal_image_url: m.frontal_image_url,
          brand_element_id: m.brand_element_id,
        });
        idx = elementsPool.length - 1;
      }
      const tgt: MentionTarget = { kind: "element", idx };
      if (m.nodeId) mentionByNodeId.set(m.nodeId, tgt);
      if (m.label) mentionByLabel.set(m.label, tgt);
      continue;
    }
    if (m.kind !== "asset") continue;
    if (m.fieldType === "image" && typeof m.url === "string" && m.url) {
      const existingIdx = imageSourceUrls.indexOf(m.url);
      let idx: number;
      if (existingIdx >= 0) {
        idx = existingIdx;
      } else {
        imageSourceUrls.push(m.url);
        newImageMentionUrls.push(m.url);
        idx = imageSourceUrls.length - 1;
      }
      const tgt: MentionTarget = { kind: "image", idx };
      if (m.nodeId) mentionByNodeId.set(m.nodeId, tgt);
      if (m.label) mentionByLabel.set(m.label, tgt);
      continue;
    }
    if (m.fieldType === "video" && typeof m.url === "string" && m.url) {
      // Kling Omni accepts at most one video. If a video was already
      // wired through `ref_video`, the mention reuses index 0; else we
      // push the mention's URL as the sole entry.
      if (videoList.length === 0) {
        videoList.push({
          video_url: m.url,
          refer_type: "feature",
          keep_original_sound: "no",
        });
      }
      const tgt: MentionTarget = { kind: "video", idx: 0 };
      if (m.nodeId) mentionByNodeId.set(m.nodeId, tgt);
      if (m.label) mentionByLabel.set(m.label, tgt);
    }
  }

  // Base64-encode mention images and append to image_list (no `type`
  // field — these are generic refs, not first/end frames).
  for (const url of newImageMentionUrls) {
    let payload = url;
    try {
      const bytes = await fetchImageBuffer(url);
      payload = bytesToBase64(bytes);
    } catch (err) {
      console.warn(`[kling-omni] mention image base64 failed, using URL:`, err);
    }
    imageList.push({ image_url: payload });
    console.log(
      `[kling-omni] Appended mention image #${imageList.length} → @Image${imageSourceUrls.indexOf(url) + 1}`,
    );
  }

  /** Replace `@[Label](nodeId)` (and plain `@<label>` fallbacks) with
   *  Kling positional anchors. Unresolved mentions strip down to the
   *  bare label so the prompt stays grammatical. */
  const rewriteKlingTokens = (s: string): string => {
    if (!s || !s.includes("@")) return s;
    let out = s.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_full, label: string, nodeId: string) => {
      const t = mentionByNodeId.get(nodeId);
      if (!t) return label;
      if (t.kind === "element") return `@Element${t.idx + 1}`;
      if (t.kind === "image") return `@Image${t.idx + 1}`;
      return `@Video`;
    });
    out = out.replace(/@([^\s@[]+)/g, (full: string, name: string) => {
      const t = mentionByLabel.get(name);
      if (!t) return full;
      if (t.kind === "element") return `@Element${t.idx + 1}`;
      if (t.kind === "image") return `@Image${t.idx + 1}`;
      return `@Video`;
    });
    return out;
  };

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
  const mode = normalizeDirectKlingMode(params, mapping.mode);
  const body: Record<string, unknown> = {
    model_name: mapping.model,
    mode,
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

    // Each scene prompt is rewritten through the Kling positional
    // helper built above — `@[Label](nodeId)` → `@Element1` /
    // `@Image1` / `@Video` based on the per-mention position map.
    // Note: `#[Label](nodeId)` text variables are a workspace-only
    // feature that doesn't apply to V2 yet (no graph_nodes context),
    // so we leave those tokens to fall back to bare labels.
    const resolvedShots: Array<{ index: number; prompt: string; duration: string }> = [];
    for (let i = 0; i < shots.length; i++) {
      const scenePrompt = rewriteKlingTokens(shots[i].prompt ?? "");
      resolvedShots.push({
        index: i + 1,
        prompt: scenePrompt,
        duration: String(shots[i].duration),
      });
    }
    body.multi_prompt = resolvedShots;
  } else {
    // Standard single-prompt mode — same positional rewrite.
    const finalPrompt = rewriteKlingTokens(prompt);
    if (finalPrompt) body.prompt = finalPrompt;
  }

  if (negativePrompt) body.negative_prompt = negativePrompt;
  if (imageList.length > 0) body.image_list = imageList;
  if (videoList.length > 0) body.video_list = videoList;

  // ── Element refs (character / object identity for Omni v3) ──
  // `elementsPool` was built above from BOTH explicit `elements`-port
  // wires AND `mentioned_assets[].kind === "element"`. The order in
  // the pool is the order in body.elements — and that order drives
  // the `@Element{N}` index already baked into `body.prompt` /
  // `body.multi_prompt` by `rewriteKlingTokens`.
  // We base64-encode the URLs (Kling reads bytes more reliably than
  // signed URLs whose TTL might expire mid-render).
  if (elementsPool.length > 0) {
    const elementList: Array<Record<string, unknown>> = [];
    for (const e of elementsPool) {
      const refsB64: string[] = [];
      for (const u of e.reference_image_urls) {
        try {
          const bytes = await fetchImageBuffer(u);
          refsB64.push(bytesToBase64(bytes));
        } catch (err) {
          console.warn(`[kling-omni] element "${e.name}" ref load failed, using URL:`, err);
          refsB64.push(u);
        }
      }
      let frontalB64: string | undefined;
      if (e.frontal_image_url) {
        try {
          const bytes = await fetchImageBuffer(e.frontal_image_url);
          frontalB64 = bytesToBase64(bytes);
        } catch (err) {
          console.warn(`[kling-omni] element "${e.name}" frontal load failed, using URL:`, err);
          frontalB64 = e.frontal_image_url;
        }
      }

      if (refsB64.length === 0 && !frontalB64) continue;
      const entry: Record<string, unknown> = { name: e.name };
      if (refsB64.length > 0) entry.reference_image_urls = refsB64;
      if (frontalB64) entry.frontal_image_url = frontalB64;
      elementList.push(entry);
    }
    if (elementList.length > 0) {
      body.elements = elementList;
      console.log(
        `[kling-omni] Added ${elementList.length} element(s) — @Element1..@Element${elementList.length}`,
      );
    }
  }

  console.log(`[kling-omni] POST ${ENDPOINT} model=${mapping.model} mode=${mode} duration=${duration}s images=${imageList.length} videos=${videoList.length} multi_shot=${isMultiShot}`);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[kling-omni] API HTTP ${res.status}: ${errText.substring(0, 500)}`);
    if (isProviderBillingLike(res.status, errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(formatKlingApiError("Kling Omni API error", res.status, errText));
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
    if (isProviderBillingLike(0, message)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(message || "Kling Omni API error");
  }

  const taskId = String((result?.data as Record<string, unknown>)?.task_id ?? "");
  if (!taskId) {
    throw new Error("Kling Omni API did not return a task_id");
  }

  // Async — Kling Omni renders take 60-180s which blows past Supabase
  // edge function compute budget if we poll inline. Frontend polls
  // workspace-run-node with `action="poll_kling"` until succeeds.
  return {
    task_id: taskId,
    outputs: {
      output_video: "",
      output_start_frame: rawImageUrl || "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      model: modelSlug,
      mode,
      is_omni: true,
      has_video_ref: videoList.length > 0,
      has_image_ref: imageList.length > 0,
      poll_endpoint: ENDPOINT,
    },
  };
}
