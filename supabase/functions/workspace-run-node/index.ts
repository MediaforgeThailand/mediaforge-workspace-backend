/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";
import {
  fetchFeatureMultipliers,
  lookupBaseCost,
  PricingConfigError,
  refundCreditsAtomic,
  type FeatureMultipliers,
  type ProviderDef,
  type ProviderKey,
} from "../_shared/pricing.ts";
import { logApiUsage } from "../_shared/posthogCapture.ts";
import {
  executeWithInlineBudget,
  INLINE_BUDGET_ATTEMPTS,
  enqueueRetryJob,
  classifyError,
  TOTAL_MAX_RETRIES,
} from "../_shared/providerRetry.ts";
import { recordGenerationEvent } from "../_shared/analytics.ts";
import {
  SEEDANCE_BASE,
  SEEDANCE_TASKS_PATH,
  SEEDANCE_MODEL_MAP,
  buildSeedanceContent,
  loadSeedanceCredentials,
  pollSeedanceOnce,
  submitSeedanceTask,
} from "../_shared/seedance.ts";
import {
  SEEDREAM_MODEL_MAP,
  generateSeedreamImage,
} from "../_shared/seedream.ts";
import {
  HYPER3D_BASE,
  HYPER3D_TASKS_PATH,
  HYPER3D_MODEL_MAP,
  buildHyper3dContent,
  pickHyper3dModelUrl,
  pollHyper3dOnce,
  submitHyper3dTask,
} from "../_shared/hyper3d.ts";

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
    // Kling Omni v3 only — accepts objects, not URL strings. Marked
    // "text" so validateEdgeValue skips the URL regex check; the V2
    // handler then passes the object/array through verbatim.
    elements:      { internal_key: "elements",        data_type: "text" },
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
  // Mirror banana: gpt-image-2 reads the same param keys (image_url +
  // mention_image_urls), built up by the V2 entry handler from
  // edgeImageUrls. Without this entry normalizeHandle returns null
  // and ref values get parked under the raw `ref_image` key, where
  // executeOpenAIImage2 never finds them — same bug fixed in the
  // main project's execute-pipeline-step HANDLE_SCHEMA.
  openai: {
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
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
  video_understanding: {
    video:         { internal_key: "video_url",      data_type: "video" },
    ref_video:     { internal_key: "video_url",      data_type: "video" },
  },
  tripo3d: {
    image:         { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
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
  output_type: "video_url" | "image_url" | "text" | "audio_url" | "model_3d";
  provider_meta?: Record<string, unknown>;
  /** Number of distinct media units produced this run. Default 1.
   *  Set by executors that can emit multiple outputs per call (e.g.
   *  Banana / GPT-Image with n>1) so usage logging records the true
   *  unit count instead of undercounting cost. */
  output_count?: number;
}

/* ═══════════════════════════════════════════════════════════
   Generation-analytics recorder
   ───────────────────────────────────────────────────────────
   Helpers (classifyOutputTier, deriveAnalyticsFromRun,
   recordGenerationEvent) live in ../_shared/analytics.ts so the
   dispatcher source stays small enough to round-trip through the
   MCP deploy tool. The recordGenerationEvent call site is
   unchanged — see the post-execution block in serve().
   ═══════════════════════════════════════════════════════════ */

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

async function executeKling(
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
    let out = val.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_full, label) => label);
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
  return await executeKlingStandard(params, mapping, modelSlug, jwtToken);
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
async function pollKlingVideo(
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
      mode: mapping.mode,
      is_motion_control: true,
      poll_endpoint: ENDPOINT,
    },
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
async function executeKlingOmni(
  params: Record<string, unknown>,
  mapping: { model: string; mode: string },
  modelSlug: string,
  jwtToken: string,
  supabaseClient: ReturnType<typeof createClient>,
  mentioned: MentionedAssetSrv[] = [],
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
  if (refImageUrl) imageSourceUrls.push(refImageUrl);

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
      mode: mapping.mode,
      is_omni: true,
      has_video_ref: videoList.length > 0,
      has_image_ref: imageList.length > 0,
      poll_endpoint: ENDPOINT,
    },
  };
}

/* ═══════════════════════════════════════════════════════════
   Seedance (Bytedance / Volcengine Ark) video executor
   ───────────────────────────────────────────────────────────
   Async submit → poll. POST returns a task_id; the frontend then
   hits action="poll_seedance" on this same function until status
   flips to "succeeded". Same UX shape as Kling so the existing
   polling hook in the frontend video node picker works without
   model-aware branching.
   ═══════════════════════════════════════════════════════════ */
async function executeSeedance(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const { apiKey } = loadSeedanceCredentials();

  const modelSlug = String(params.model_name ?? params.model ?? "seedance-1-5-pro-251215");
  const entry = SEEDANCE_MODEL_MAP[modelSlug];
  if (!entry) {
    throw new Error(
      `Unknown Seedance model: ${modelSlug}. ` +
        `Available: ${Object.keys(SEEDANCE_MODEL_MAP).join(", ")}`,
    );
  }

  const prompt = String(params.prompt ?? "").trim();
  if (!prompt && !params.image_url) {
    throw new Error("Seedance requires either a prompt or a start_frame image.");
  }

  // Coerce string-y param values (the frontend serialises everything
  // through select dropdowns that hand us strings).
  const ratio = (params.ratio ?? params.aspect_ratio) as string | undefined;
  const resolution = params.resolution as string | undefined;
  const durationRaw = params.duration as string | number | undefined;
  const duration =
    typeof durationRaw === "number"
      ? durationRaw
      : durationRaw
        ? parseInt(String(durationRaw), 10) || 5
        : 5;
  const generateAudioRaw = params.generate_audio ?? params.has_audio;
  const generateAudio = entry.supportsAudio
    ? generateAudioRaw === true || generateAudioRaw === "true"
    : false;
  const cameraFixedRaw = params.camera_fixed;
  const cameraFixed =
    cameraFixedRaw === undefined
      ? undefined
      : cameraFixedRaw === true || cameraFixedRaw === "true";
  const seedRaw = params.seed;
  const seed =
    typeof seedRaw === "number"
      ? seedRaw
      : seedRaw
        ? parseInt(String(seedRaw), 10) || undefined
        : undefined;
  const startFrameUrl = (params.image_url ?? params.start_frame) as string | undefined;
  const endFrameUrl = (params.image_tail_url ?? params.end_frame) as string | undefined;

  const content = buildSeedanceContent({
    prompt,
    ratio: ratio === "Auto" ? undefined : ratio,
    resolution,
    duration,
    generateAudio,
    cameraFixed,
    seed,
    watermark: false,
    startFrameUrl,
    endFrameUrl,
  });

  console.log(
    `[seedance] submit model=${entry.model} duration=${duration}s ` +
      `resolution=${resolution ?? "default"} ratio=${ratio ?? "default"} ` +
      `audio=${generateAudio} i2v=${!!startFrameUrl}`,
  );

  const taskId = await submitSeedanceTask(
    { model: entry.model, content },
    apiKey,
  );

  return {
    task_id: taskId,
    outputs: {
      output_video: "",
      output_start_frame: startFrameUrl ?? "",
      output_last_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      provider: "seedance",
      model: modelSlug,
      provider_model_id: entry.model,
      tier: entry.tier,
      duration_seconds: duration,
      resolution,
      ratio,
      has_audio: generateAudio,
      is_image2video: !!startFrameUrl,
      poll_endpoint: `${SEEDANCE_BASE}${SEEDANCE_TASKS_PATH}`,
    },
  };
}

/**
 * Seedream image-gen executor (BytePlus ModelArk, sync).
 *
 * One POST returns the rendered image URL — no polling. Mirrors the
 * shape of executeBanana / executeOpenAIImage2 so downstream consumers
 * (analytics recorder, response formatter) treat it identically.
 *
 * Same BytePlus Ark API key powers Seedance / Seedream / Hyper3D, so
 * we lean on loadSeedanceCredentials() rather than introducing a
 * separate SEEDREAM_API_KEY env var.
 */
async function executeSeedream(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const { apiKey } = loadSeedanceCredentials();

  const modelSlug = String(params.model_name ?? params.model ?? "seedream-5-0");
  const entry = SEEDREAM_MODEL_MAP[modelSlug];
  if (!entry) {
    throw new Error(
      `Unknown Seedream model: ${modelSlug}. ` +
        `Available: ${Object.keys(SEEDREAM_MODEL_MAP).join(", ")}`,
    );
  }

  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Seedream requires a prompt.");
  }

  // Size — accept either an explicit "WxH" string or a {width,height}
  // pair the schema sometimes hands us.
  const sizeRaw = params.size ?? params.image_size;
  let size: string | undefined;
  if (typeof sizeRaw === "string" && /^\d+x\d+$/i.test(sizeRaw)) {
    size = sizeRaw;
  } else if (typeof params.width === "number" && typeof params.height === "number") {
    size = `${params.width}x${params.height}`;
  } else {
    size = "1024x1024";
  }

  const seedRaw = params.seed;
  const seed =
    typeof seedRaw === "number"
      ? seedRaw
      : seedRaw
        ? parseInt(String(seedRaw), 10) || undefined
        : undefined;

  // Image-to-image hint (some Seedream variants accept it). The
  // workspace shell passes ref images via image_url / mention_image_urls.
  const refImage =
    (params.image_url as string | undefined) ??
    (Array.isArray(params.mention_image_urls)
      ? (params.mention_image_urls as string[])[0]
      : undefined);

  const negativePrompt =
    typeof params.negative_prompt === "string" ? params.negative_prompt : undefined;

  console.log(
    `[seedream] generate model=${entry.model} size=${size} seed=${seed ?? "auto"} ` +
      `i2i=${!!refImage}`,
  );

  const items = await generateSeedreamImage(
    {
      model: entry.model,
      prompt,
      size,
      response_format: "url",
      n: 1,
      ...(seed !== undefined ? { seed } : {}),
      ...(refImage ? { image: refImage } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    },
    apiKey,
  );

  const url = items[0]?.url;
  if (!url) {
    throw new Error("Seedream returned no URL in the first image item.");
  }

  return {
    outputs: {
      output_image: url,
    },
    output_type: "image_url",
    provider_meta: {
      provider: "seedream",
      model: modelSlug,
      provider_model_id: entry.model,
      tier: entry.tier,
      size,
      revised_prompt: items[0]?.revised_prompt,
      has_reference_image: !!refImage,
    },
  };
}

/**
 * Hyper3D image-to-3D executor (BytePlus ModelArk, async).
 *
 * Submit/poll pipeline mirrors Seedance — we POST a task, return the
 * task_id, and let the frontend drive the `poll_hyper3d` action. The
 * provider_meta echoes the Tripo3D shape (`output_model` / `model_3d`)
 * so the existing 3D node renderer can keep its happy path.
 */
async function executeHyper3D(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const { apiKey } = loadSeedanceCredentials();

  const modelSlug = String(params.model_name ?? params.model ?? "hyper3d-gen2");
  const entry = HYPER3D_MODEL_MAP[modelSlug];
  if (!entry) {
    throw new Error(
      `Unknown Hyper3D model: ${modelSlug}. ` +
        `Available: ${Object.keys(HYPER3D_MODEL_MAP).join(", ")}`,
    );
  }

  // Resolve the reference image (image-to-3D requires one).
  const imageUrl =
    (params.image_url as string | undefined) ??
    (params.image as string | undefined) ??
    (Array.isArray(params.mention_image_urls)
      ? (params.mention_image_urls as string[])[0]
      : undefined);
  if (!imageUrl) {
    throw new Error(
      "Hyper3D Gen2 requires an image input — wire an asset / generation into the `image` port.",
    );
  }

  const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
  const formatRaw = params.format ?? params.output_format;
  const format =
    formatRaw === "obj" || formatRaw === "fbx" || formatRaw === "glb"
      ? (formatRaw as "obj" | "fbx" | "glb")
      : "glb";
  const textureRaw = params.texture ?? params.bake_texture;
  const texture =
    textureRaw === undefined ? true : textureRaw === true || textureRaw === "true";
  const seedRaw = params.seed;
  const seed =
    typeof seedRaw === "number"
      ? seedRaw
      : seedRaw
        ? parseInt(String(seedRaw), 10) || undefined
        : undefined;

  const content = buildHyper3dContent({
    imageUrl,
    prompt,
    format,
    texture,
    seed,
  });

  console.log(
    `[hyper3d] submit model=${entry.model} format=${format} texture=${texture}`,
  );

  const taskId = await submitHyper3dTask(
    { model: entry.model, content },
    apiKey,
  );

  return {
    task_id: taskId,
    outputs: {
      output_model: "",
      output_image: imageUrl,
    },
    output_type: "model_3d",
    provider_meta: {
      provider: "hyper3d",
      model: modelSlug,
      provider_model_id: entry.model,
      tier: entry.tier,
      format,
      texture,
      poll_endpoint: `${HYPER3D_BASE}${HYPER3D_TASKS_PATH}`,
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
  // Workspace dev names this secret `GEMINI_API_KEY`; live editor uses
  // `GOOGLE_AI_STUDIO_KEY`. Accept either so the same code base runs in
  // both environments without a migration.
  const GOOGLE_AI_STUDIO_KEY =
    Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
  if (!GOOGLE_AI_STUDIO_KEY) {
    throw new Error(
      "Neither GOOGLE_AI_STUDIO_KEY nor GEMINI_API_KEY is configured",
    );
  }

  const rawModel = String(params.model_name ?? params.model ?? "nano-banana-pro");
  const modelId = BANANA_MODEL_MAP[rawModel] ?? rawModel;
  const modelConfig = GEMINI_IMAGE_MODELS[modelId];
  if (!modelConfig) throw new Error(`Unknown Banana model: ${modelId}. Available: ${Object.keys(GEMINI_IMAGE_MODELS).join(", ")}`);

  const prompt = String(params.prompt ?? "");
  const aspectRatio = String(params.aspect_ratio ?? "Auto");
  /* Output resolution. Maps to Gemini's `imageConfig.imageSize`:
   *   "1K" / "2K" — Banana 2 (Flash Image)
   *   "1K" / "2K" / "4K" — Banana Pro (Pro Image)
   * Empty / "auto" leaves the field off entirely so Gemini picks
   * the model's default resolution. */
  const imageSize = String(params.image_size ?? "").trim();
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

  // Build generationConfig — both aspectRatio and imageSize live
  // under `imageConfig`. We only include keys the user actually
  // set so Gemini's default kicks in for the others.
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  const imageConfig: Record<string, unknown> = {};
  if (aspectRatio && aspectRatio !== "Auto") {
    imageConfig.aspectRatio = aspectRatio;
  }
  if (imageSize && imageSize.toLowerCase() !== "auto") {
    imageConfig.imageSize = imageSize;
  }
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig;
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

  /* ── Hard client-side timeout ─────────────────────────────
   * Supabase edge functions die with WORKER_RESOURCE_LIMIT once
   * total CPU time crosses ~150s (default tier). Gemini Pro Image
   * with Flex queueing or many ref images can blow past that, so
   * we abort the fetch at ~120s — leaving enough headroom for the
   * upload + JSON-parse work below to finish before the platform
   * pulls the plug. The caller gets a friendly error instead of a
   * generic platform 500. */
  const ABORT_MS = 120_000;
  const aborter = new AbortController();
  const abortTimer = setTimeout(() => aborter.abort(), ABORT_MS);
  const modelLabel = modelId === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2";

  let aiResponse: Response;
  try {
    aiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Tell Gemini to wait up to 280s before returning a 504, matching
        // what the legacy editor uses for long Banana generations.
        "X-Server-Timeout": "280",
      },
      body: geminiRequestBody,
      signal: aborter.signal,
    });
  } catch (fetchErr) {
    clearTimeout(abortTimer);
    if ((fetchErr as { name?: string })?.name === "AbortError") {
      console.error(`[banana-direct] Gemini fetch aborted after ${ABORT_MS}ms`);
      throw new Error(
        `${modelLabel} ใช้เวลานานเกิน ${Math.round(ABORT_MS / 1000)} วินาที — ลองลดจำนวน reference images ` +
          `หรือทำ prompt ให้สั้นลง แล้วกด Run ใหม่`,
      );
    }
    throw fetchErr;
  }
  clearTimeout(abortTimer);

  if (!aiResponse.ok) {
    const statusCode = aiResponse.status;
    const errorText = await aiResponse.text();
    console.error(`[banana-direct] Gemini API error: ${statusCode}`, errorText.substring(0, 500));
    if (statusCode === 429 || (statusCode < 500 && /billing|quota|exceeded|resource exhausted/i.test(errorText))) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
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
  // Captured per-provider so analytics can record cost-driving token
  // counts. Both OpenAI Chat Completions and Gemini generateContent
  // return usage metadata — fold whichever shape the provider gives us
  // into a normalized {tokens_in, tokens_out, tokens_total} shape.
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let tokensTotal: number | null = null;

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
    // Gemini usage shape: usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}
    const usage = data.usageMetadata as
      | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
      | undefined;
    if (usage) {
      if (typeof usage.promptTokenCount === "number") tokensIn = usage.promptTokenCount;
      if (typeof usage.candidatesTokenCount === "number") tokensOut = usage.candidatesTokenCount;
      if (typeof usage.totalTokenCount === "number") tokensTotal = usage.totalTokenCount;
    }
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
    // OpenAI usage shape: usage.{prompt_tokens, completion_tokens, total_tokens}
    const usage = data.usage as
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number") tokensIn = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") tokensOut = usage.completion_tokens;
      if (typeof usage.total_tokens === "number") tokensTotal = usage.total_tokens;
    }
  } else {
    throw new Error(`Unsupported model: ${model}`);
  }

  const providerMeta: Record<string, unknown> = { model };
  if (tokensIn !== null) providerMeta.tokens_in = tokensIn;
  if (tokensOut !== null) providerMeta.tokens_out = tokensOut;
  if (tokensTotal !== null) providerMeta.tokens_total = tokensTotal;

  return {
    result_url: content,
    outputs: { output_text: content },
    output_type: "text",
    provider_meta: providerMeta,
  };
}

/* ═══════════════════════════════════════════════════════════
   Tripo3D — Image to 3D Model (ASYNC pattern)
   ═══════════════════════════════════════════════════════════
 *
 * Tripo3D image_to_model jobs commonly take 60-300s — well past
 * the ~150s edge-function CPU budget. We follow the same pattern
 * as Kling: the executor SUBMITS the task and returns the
 * task_id + poll_endpoint immediately. The frontend then polls
 * via `action="poll_tripo3d"` (one short edge-fn call per check)
 * until the job lands a GLB URL or fails. Each poll is cheap so
 * we never run into the worker resource limit.
 *
 * Env vars (either name works — the user's secret is `TRIO_API_KEY`,
 * Tripo's own naming convention is `TRIPO_API_KEY`):
 *   - TRIO_API_KEY
 *   - TRIPO_API_KEY
 */
/* Tripo3D `model_version` strings — pulled directly from the
 * official docs at platform.tripo3d.ai/docs/generation. The
 * date suffix is part of the contract; without it the API
 * returns code 2017 "version invalid".
 *
 * Default is `v3.1-20260211` (gold standard, what Freepik /
 * Pikaso label as "Tripo v3.1"). `P1-20260311` is even newer
 * but still flagged as preview; expose it as an option only.
 *
 * Last verified against the docs: 2026-04-28. */
const TRIPO3D_MODEL_VERSIONS: Record<string, string> = {
  "tripo3d-p1":     "P1-20260311",
  "tripo3d-v3.1":   "v3.1-20260211",
  "tripo3d-v3.0":   "v3.0-20250812",
  "tripo3d-turbo":  "Turbo-v1.0-20250506",
  "tripo3d-v2.5":   "v2.5-20250123",
  "tripo3d-v2.0":   "v2.0-20240919",
  "tripo3d-v1.4":   "v1.4-20240625",
};

const TRIPO3D_POLL_ENDPOINT = "https://api.tripo3d.ai/v2/openapi/task";

async function executeTripo3D(
  params: Record<string, unknown>,
  _supabase: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  const KEY =
    Deno.env.get("TRIO_API_KEY") ??
    Deno.env.get("TRIPO_API_KEY") ??
    Deno.env.get("TRIPO3D_API_KEY");
  if (!KEY) {
    throw new Error(
      "TRIO_API_KEY (or TRIPO_API_KEY) is not configured — set it in Supabase project secrets.",
    );
  }

  // Resolve image: prefer a wired `image` input, else a mention.
  const imageUrl =
    (params.image_url as string | undefined) ??
    (params.image as string | undefined) ??
    (Array.isArray(params.mention_image_urls)
      ? (params.mention_image_urls as string[])[0]
      : undefined);
  if (!imageUrl) {
    throw new Error("Image to 3D needs an image input — wire an asset / generation into the `image` port.");
  }

  const modelKey = String(params.model_name ?? "tripo3d-v3.1");
  const modelVersion = TRIPO3D_MODEL_VERSIONS[modelKey] ?? TRIPO3D_MODEL_VERSIONS["tripo3d-v3.1"];

  const texture = String(params.texture ?? "true") === "true";
  const pbr = String(params.pbr ?? "true") === "true";
  const autoSize = String(params.auto_size ?? "true") === "true";

  const submitBody: Record<string, unknown> = {
    type: "image_to_model",
    file: { type: "url", url: imageUrl },
    model_version: modelVersion,
    texture,
    pbr,
    auto_size: autoSize,
  };

  console.log(
    `[tripo3d] Submitting image_to_model task (model=${modelVersion}, ` +
      `texture=${texture}, pbr=${pbr})`,
  );

  const submitRes = await fetch(TRIPO3D_POLL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitRes.ok) {
    const errText = (await submitRes.text()).substring(0, 500);
    console.error(`[tripo3d] submit ${submitRes.status}:`, errText);
    if (submitRes.status === 401 || submitRes.status === 403) {
      throw new Error(
        `Tripo3D authentication failed (HTTP ${submitRes.status}) — check TRIO_API_KEY.`,
      );
    }
    if (submitRes.status === 429 || /billing|quota|insufficient/i.test(errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    // Surface invalid-version specifically so the user knows to pick a
    // different model in the dropdown — Tripo3D rejects unrecognised
    // version strings with code 2017.
    if (/version value is invalid|code"?\s*:\s*2017/i.test(errText)) {
      throw new Error(
        `Tripo3D ปฏิเสธ version "${modelVersion}" — เลือก model อื่นใน dropdown ` +
          `(v2.5 / Turbo / v2.0 / v1.4 ตามที่ระบบรองรับ)`,
      );
    }
    throw new Error(`Tripo3D submit failed (HTTP ${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json() as {
    code?: number;
    data?: { task_id?: string };
    message?: string;
  };
  if (submitData.code !== undefined && submitData.code !== 0) {
    throw new Error(`Tripo3D returned error code ${submitData.code}: ${submitData.message ?? "no detail"}`);
  }
  const taskId = String(submitData?.data?.task_id ?? "").trim();
  if (!taskId) {
    throw new Error("Tripo3D didn't return a task_id");
  }

  console.log(`[tripo3d] task submitted task_id=${taskId.slice(0, 8)}…`);

  /* Async hand-off — frontend polls via action="poll_tripo3d" until
   * the job lands. Each poll is one quick edge-fn call (no risk of
   * worker timeout) so even multi-minute jobs finish reliably. */
  return {
    task_id: taskId,
    outputs: {},
    output_type: "image_url" as const,
    provider_meta: {
      provider: "tripo3d",
      model_version: modelVersion,
      poll_endpoint: TRIPO3D_POLL_ENDPOINT,
      task_id: taskId,
    },
  };
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
   Audio gen — Google Cloud Text-to-Speech provider
   ───────────────────────────────────────────────────────────

   Two providers feed `audioGenNode`:

     1. google_tts → executeGoogleTts (default, this section).
        Calls texttospeech.googleapis.com directly with the
        user-picked voice id (e.g. en-US-Studio-O). Studio /
        Neural2 / WaveNet are differentiated by the `model_name`
        param ONLY for billing — the voice id alone tells Google
        which family to render. The `model_name` flag controls
        which voices the picker exposes; the API treats them all
        the same.

     2. gemini_tts → executeGeminiTts (legacy fallback). Proxies
        to the existing `text-to-speech` edge function which
        wraps Gemini 2.5 TTS. Kept available so the legacy
        Gemini star-name catalog still works as an "advanced"
        toggle when the user picks a `gemini-2.5-*-tts` model.

   Output: an `audio_url` pointing at a public-read MP3 stored in
   the `user_assets` Supabase bucket. The frontend renders this
   URL directly in an <audio> element on the node body and via
   the NodePreviewLightbox dialog.
   ═══════════════════════════════════════════════════════════ */

async function executeGoogleTts(
  params: Record<string, unknown>,
  supabaseClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<ProviderResult> {
  const apiKey = Deno.env.get("GOOGLE_TTS_API_KEY");
  if (!apiKey) {
    // Surface a clear missing-key message so the frontend's
    // permanent-error matcher sees `not configured` and stops the
    // 30-min retry loop. Without that match the user would wait
    // half an hour before getting an error toast.
    throw new Error(
      "Google Cloud TTS not configured — set GOOGLE_TTS_API_KEY in Supabase project secrets (workspace dev).",
    );
  }

  const text = String(params.prompt ?? params.text ?? "").trim();
  if (!text) throw new Error("Audio Generation requires a script (prompt).");
  if (text.length > 5000) {
    throw new Error("Script too long — max 5,000 characters per audio gen.");
  }

  const voiceId = String(params.voice ?? "en-US-Studio-O");

  // Infer language code from the voice id ("en-US-Studio-O" → "en-US").
  // Google requires both the languageCode AND the voice name; if they
  // disagree the API 400s. Splitting from the id avoids the user
  // needing to pick the language separately.
  const langMatch = voiceId.match(/^([a-z]{2}-[A-Z]{2})-/);
  const languageCode = langMatch?.[1] ?? "en-US";

  // Optional style hint → SSML <prosody>. Conservative mapping —
  // recognise a handful of keywords ("calm", "fast", "slow", "warm").
  // Anything else gets passed as a plain raw <speak> wrapper without
  // prosody so the Google TTS request stays valid.
  const styleHint = String(params.style_prompt ?? "").trim().toLowerCase();
  let inputBody: { text?: string; ssml?: string };
  if (styleHint) {
    const rate = /\bslow\b/.test(styleHint) ? "slow"
      : /\bfast\b/.test(styleHint) ? "fast"
      : "medium";
    const pitch = /\b(deep|low)\b/.test(styleHint) ? "-2st"
      : /\b(high|bright|youthful)\b/.test(styleHint) ? "+2st"
      : "0st";
    // Escape XML special chars so user text can't break the SSML.
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
    inputBody = {
      ssml: `<speak><prosody rate="${rate}" pitch="${pitch}">${escaped}</prosody></speak>`,
    };
  } else {
    inputBody = { text };
  }

  // Audio encoding — MP3 is universally supported and small. WAV is
  // available but ~10x larger for no perceptible quality gain at
  // speech bitrates. The frontend's <audio> element renders MP3
  // natively on every modern browser.
  const ttsRes = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: inputBody,
        voice: { languageCode, name: voiceId },
        audioConfig: {
          audioEncoding: "MP3",
          // Google's defaults are tuned for broadcast read; keep
          // them unless the style hint already adjusted prosody.
          speakingRate: 1.0,
          pitch: 0,
        },
      }),
    },
  );

  if (!ttsRes.ok) {
    const errText = await ttsRes.text();
    console.error(`[google-tts] HTTP ${ttsRes.status} body=${errText.slice(0, 500)}`);
    // Translate common Google API errors into the frontend's
    // permanent-error patterns where possible. INVALID_ARGUMENT
    // usually means a stale voice id; surface it as Validation.
    if (ttsRes.status === 400) {
      throw new Error(`Validation: Google TTS rejected the request — ${errText.slice(0, 200)}`);
    }
    if (ttsRes.status === 401 || ttsRes.status === 403) {
      throw new Error(`Google TTS authentication failed — check GOOGLE_TTS_API_KEY (HTTP ${ttsRes.status}).`);
    }
    throw new Error(`Google TTS failed (HTTP ${ttsRes.status})`);
  }

  const json = await ttsRes.json();
  const audioContentB64 = String(json.audioContent ?? "");
  if (!audioContentB64) {
    throw new Error("Google TTS returned no audio content.");
  }

  // Decode base64 → Uint8Array → upload as MP3.
  const binary = atob(audioContentB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const fileName = `tts/${userId}/${Date.now()}_${voiceId}.mp3`;
  const { error: uploadErr } = await supabaseClient.storage
    .from("user_assets")
    .upload(fileName, bytes, { contentType: "audio/mpeg", upsert: true });
  if (uploadErr) {
    console.error("[google-tts] upload error:", uploadErr);
    throw new Error("Failed to save audio. Please try again.");
  }

  const { data: signedData, error: signErr } = await supabaseClient.storage
    .from("user_assets")
    .createSignedUrl(fileName, 86400); // 24h
  if (signErr || !signedData?.signedUrl) {
    console.error("[google-tts] signed URL error:", signErr);
    throw new Error("Failed to save audio. Please try again.");
  }

  const audioUrl = signedData.signedUrl;

  // Mirror the legacy text-to-speech edge fn's user_assets row so
  // the asset library + downstream Merge Audio nodes pick it up.
  await supabaseClient.from("user_assets").insert({
    user_id: userId,
    name: `TTS: ${text.slice(0, 40)}${text.length > 40 ? "..." : ""}`,
    file_url: audioUrl,
    file_type: "audio",
    source: "ai_generated",
    metadata: {
      voice: voiceId,
      language: languageCode,
      provider: "google_tts",
      text_length: text.length,
      style_prompt: styleHint || null,
    },
  });

  return {
    result_url: audioUrl,
    outputs: { audio_url: audioUrl },
    output_type: "audio_url" as const,
    provider_meta: {
      provider: "google_tts",
      voice: voiceId,
      language: languageCode,
      model: String(params.model_name ?? "google-tts-studio"),
    },
  };
}

/**
 * executeGeminiTts — legacy fallback for the gemini-2.5-*-tts
 * models. Proxies to the existing `text-to-speech` edge function
 * which already handles the Gemini API call + WAV encoding +
 * storage upload + credit consumption.
 *
 * We pass through the user's auth header so the downstream
 * function sees the SAME user (and bills SAME credits) the
 * workspace-run-node call would have. Service-role bypass would
 * skip the credit check.
 */
async function executeGeminiTts(
  params: Record<string, unknown>,
  authHeader: string,
): Promise<ProviderResult> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const text = String(params.prompt ?? params.text ?? "").trim();
  if (!text) throw new Error("Audio Generation requires a script (prompt).");

  const voice = String(params.voice ?? "Charon");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/text-to-speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ text, voice }),
  });

  const json = await res.json();
  if (!res.ok) {
    const errMsg = String(json?.error || `text-to-speech failed (${res.status})`);
    throw new Error(errMsg);
  }

  const audioUrl = String(json.audioUrl ?? "");
  if (!audioUrl) throw new Error("text-to-speech returned no audio URL.");

  return {
    result_url: audioUrl,
    outputs: { audio_url: audioUrl },
    output_type: "audio_url" as const,
    provider_meta: {
      provider: "gemini_tts",
      voice,
      model: String(params.model_name ?? "gemini-2.5-flash-preview-tts"),
    },
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
   WORKSPACE V2 ENTRY HANDLER
   ───────────────────────────────────────────────────────────
   Lifted from execute-pipeline-step. The legacy serve() at the
   bottom of the original file walked DB rows (pipeline_executions
   + pipeline_steps) and orchestrated multi-step pipelines with
   credit refund / retry queue. Workspace V2 is a sandbox: every
   Run is a single, stateless node call — no DB rows, no credit
   ledger, no retries. We re-use the per-provider executors above
   verbatim (executeBanana / executeKling / executeChatAi /
   executeRemoveBg / executeMergeAudio) so the model-side
   behaviour stays identical to the legacy editor.

   Request body shape (sent by the workspace frontend):
     {
       node_type:    "bananaProNode" | "imageGenNode" | "klingVideoNode"
                    | "videoGenNode" | "removeBackgroundNode"
                    | "mergeAudioNode" | "chatAiNode",
       params:       Record<string, unknown>,
       inputs:       Record<string, unknown>,
       mentioned_assets?: Array<{ label, nodeId, url, fieldType }>,
     }

   Response shape:
     { type, url, outputs, prompt_used, prompt_source, provider_meta }
     OR { error: string }
   ═══════════════════════════════════════════════════════════ */

/**
 * Resolve the provider from node_type AND the picked model.
 *
 * The unified `imageGenNode` / `videoGenNode` exposes models from
 * multiple providers in a single dropdown (e.g. nano-banana-* and
 * seedream-* both live under imageGenNode). So the dispatch must look
 * at `model_name` first, falling back to node_type for legacy keys.
 *
 * Provider keys must match HANDLE_SCHEMA above.
 */
/**
 * Video-to-Prompt — Gemini 3.x video understanding.
 *
 * Pulls bytes from a signed video URL, attaches as inlineData to a
 * Gemini multimodal call, and asks the model to break the clip into
 * scenes using professional photo + film terminology. Returns the
 * model's text reply.
 *
 * Inline data has a hard ~20 MB cap on Gemini's REST endpoint. For
 * larger files we'd want the Files API (resumable upload → fileUri).
 * Workspace V2 wireframe stays on inline for simplicity — short test
 * clips only.
 */
async function executeVideoToPrompt(params: Record<string, unknown>): Promise<ProviderResult> {
  const KEY =
    Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
  if (!KEY) {
    throw new Error("GEMINI_API_KEY (or GOOGLE_AI_STUDIO_KEY) is not configured");
  }

  const model = String(params.model_name ?? "gemini-3.1-pro-preview");
  const videoUrl = String(params.video_url ?? "");
  if (!videoUrl) {
    throw new Error("Video to Prompt requires a video input.");
  }
  const userExtra = String(params.prompt ?? "").trim();
  const language = String(params.language ?? "th").toLowerCase();
  const langName = language === "en" ? "English" : "Thai";

  // Fetch + base64-encode the video bytes (reusing the image helper —
  // it's a generic byte fetcher, not image-specific).
  const bytes = await fetchImageBuffer(videoUrl);
  if (bytes.byteLength > 20 * 1024 * 1024) {
    throw new Error(
      `Video is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Gemini inline cap is 20 MB. Use a shorter clip or wait for the Files API path.`,
    );
  }
  const base64 = bytesToBase64(bytes);

  // MIME from URL extension (good enough for the common cases).
  let mime = "video/mp4";
  const lower = videoUrl.toLowerCase();
  if (lower.includes(".webm")) mime = "video/webm";
  else if (lower.includes(".mov") || lower.includes(".quicktime")) mime = "video/quicktime";
  else if (lower.includes(".m4v")) mime = "video/x-m4v";
  else if (lower.includes(".mkv")) mime = "video/x-matroska";

  // System prompt — keep this short and direct. Gemini follows
  // structured instructions well; over-prompting hurts more than it
  // helps for a multimodal task like this.
  const systemPrompt =
    `You are a professional cinematographer and photography director analysing a short video clip.\n\n` +
    `Watch the attached video carefully and break it down scene-by-scene. A "scene" is a continuous shot or a cohesive group of shots that share the same setup; cut whenever the camera, subject, or location changes substantially.\n\n` +
    `For each scene, describe (use proper photography + film terminology — shot size, camera angle, camera movement, lens feel, lighting setup, key/fill ratio, time of day, colour palette, mood, framing principles like rule-of-thirds or leading lines, depth-of-field, composition):\n` +
    `  • Subject + composition\n` +
    `  • Camera (shot size, angle, movement)\n` +
    `  • Lens feel (wide / standard / telephoto, approx focal length impression)\n` +
    `  • Lighting + colour grading\n` +
    `  • Action / motion\n` +
    `  • Mood / atmosphere\n\n` +
    `Output format: numbered scenes with short headers. End with a one-sentence overall stylistic summary the user could re-use as a prompt for an image / video generator.\n\n` +
    `Respond in ${langName}.`;

  const userTurn = userExtra
    ? `${userExtra}\n\n(Default analysis above applies if the instruction above doesn't override it.)`
    : "Analyse this video.";

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: `${systemPrompt}\n\n---\n\n${userTurn}` },
          { inlineData: { mimeType: mime, data: base64 } },
        ],
      },
    ],
    generationConfig: { responseModalities: ["TEXT"] },
  };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`;
  console.log(`[video-to-prompt] Calling ${model}, video=${(bytes.byteLength / 1024).toFixed(0)}KB`);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Server-Timeout": "280",
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errText = (await resp.text()).substring(0, 500);
    console.error(`[video-to-prompt] Gemini ${resp.status}:`, errText);
    if (resp.status === 429 || /billing|quota|exceeded/i.test(errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(`Video to Prompt failed (HTTP ${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no text — try a shorter clip or different model.");
  }

  return {
    outputs: { text },
    output_type: "text" as const,
    provider_meta: { model, video_bytes: bytes.byteLength, mime },
  };
}

function getProviderForNodeType(
  nodeType: string,
  modelName?: string,
): string {
  const m = String(modelName ?? "").toLowerCase();

  if (nodeType === "bananaProNode" || nodeType === "imageGenNode") {
    if (m.startsWith("seedream")) return "seedream";
    if (m.startsWith("gpt-image") || m.startsWith("dall-e")) return "openai";
    return "banana";
  }
  if (nodeType === "klingVideoNode" || nodeType === "videoGenNode") {
    if (m.startsWith("seedance") || m.startsWith("dreamina-seedance")) return "seedance";
    return "kling";
  }
  if (nodeType === "seedDreamNode") return "seedream";
  if (nodeType === "seedDanceNode") return "seedance";
  if (nodeType === "removeBackgroundNode") return "remove_bg";
  if (nodeType === "mergeAudioNode") return "merge_audio";
  if (nodeType === "chatAiNode") return "chat_ai";
  if (nodeType === "videoToPromptNode") return "video_understanding";
  // 3D nodes: Hyper3D rides BytePlus ModelArk; Tripo3D is its own API.
  // Route by model slug so a single node type can serve both providers.
  if (nodeType === "imageTo3dNode") {
    if (m.startsWith("hyper3d")) return "hyper3d";
    return "tripo3d";
  }

  // Audio generation — provider chosen by model_name. Default to
  // google_tts (Studio / Neural2 / WaveNet); fall back to the legacy
  // gemini_tts proxy when the user picks a `gemini-2.5-*-tts` model.
  if (nodeType === "audioGenNode") {
    if (m.startsWith("gemini-")) return "gemini_tts";
    return "google_tts";
  }

  throw new Error(`Workspace: no provider mapping for node_type "${nodeType}"`);
}

function workspaceProviderDef(
  nodeType: string,
  provider: string,
): ProviderDef {
  const p = provider as ProviderKey;
  const output: ProviderDef["output_type"] =
    p === "kling" || p === "seedance" || p === "merge_audio"
      ? "video_url"
      : p === "tripo3d" || p === "hyper3d"
        ? "model_3d"
      : p === "chat_ai" || p === "video_understanding"
        ? "text"
        : p === "google_tts" || p === "gemini_tts" || p === "mp3_input"
          ? "audio_url"
          : "image_url";
  const feature =
    p === "openai" ? "generate_openai_image" :
    p === "seedream" ? "generate_seedream_image" :
    p === "banana" ? "generate_freepik_image" :
    p === "kling" || p === "seedance" ? "generate_freepik_video" :
    p === "remove_bg" ? "remove_background" :
    p === "merge_audio" ? "merge_audio_video" :
    p === "chat_ai" ? "chat_ai" :
    p === "tripo3d" || p === "hyper3d" ? "model_3d" :
    p === "google_tts" || p === "gemini_tts" ? "text_to_speech" :
    p === "video_understanding" ? "video_to_prompt" :
    nodeType;
  return {
    provider: p,
    feature,
    output_type: output,
    is_async: p === "kling" || p === "seedance" || p === "tripo3d" || p === "hyper3d" || p === "merge_audio",
  };
}

function shouldChargeWorkspaceProvider(provider: string): boolean {
  // Gemini TTS proxies to text-to-speech, which still owns its legacy
  // credit deduction. Charging here too would double-bill.
  return provider !== "gemini_tts" && provider !== "mp3_input";
}

function workspaceMultiplierForProvider(
  def: ProviderDef,
  multipliers: FeatureMultipliers,
): number {
  switch (def.provider) {
    case "banana":
    case "openai":
    case "seedream":
    case "remove_bg":
    case "tripo3d":
    case "hyper3d":
      return multipliers.image;
    case "kling":
    case "seedance":
    case "merge_audio":
      return multipliers.video;
    case "chat_ai":
    case "video_understanding":
      return multipliers.chat;
    case "google_tts":
    case "gemini_tts":
    case "mp3_input":
      return multipliers.audio ?? multipliers.chat;
    default:
      return multipliers.chat;
  }
}

type WorkspaceCreditCharge = {
  amount: number;
  teamId: string | null;
  referenceId: string;
  feature: string;
};

function buildChargeParams(
  body: WorkspaceRunBody,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(body.params ?? {}) };
  const inputs = body.inputs ?? {};
  if (
    typeof inputs.text === "string" &&
    !String(params.prompt ?? "").trim()
  ) {
    params.prompt = inputs.text;
  }
  return params;
}

async function resolveWorkspaceTeamId(
  supabase: ReturnType<typeof createClient>,
  workspaceId?: string | null,
): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const { data, error } = await supabase.rpc("workspace_team_id", {
      p_workspace_id: workspaceId,
    });
    if (error) {
      console.warn("[workspace-credits] workspace_team_id skipped:", error.message);
      return null;
    }
    return typeof data === "string" && data ? data : null;
  } catch (err) {
    console.warn(
      "[workspace-credits] workspace_team_id unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function consumeWorkspaceCredits(args: {
  supabase: ReturnType<typeof createClient>;
  userId: string;
  body: WorkspaceRunBody;
  nodeType: string;
  provider: string;
  params: Record<string, unknown>;
}): Promise<WorkspaceCreditCharge | null> {
  if (args.body.skip_credit_charge || !shouldChargeWorkspaceProvider(args.provider)) {
    return null;
  }
  const def = workspaceProviderDef(args.nodeType, args.provider);
  const baseAmount = await lookupBaseCost(args.supabase, def, args.params);
  const multipliers = await fetchFeatureMultipliers(args.supabase);
  const amount = Math.max(1, Math.ceil(baseAmount * workspaceMultiplierForProvider(def, multipliers)));
  if (amount <= 0) return null;

  const teamId = await resolveWorkspaceTeamId(args.supabase, args.body.workspace_id ?? null);
  const referenceId = String(
    args.body.job_id ??
      args.body.node_id ??
      crypto.randomUUID(),
  );
  const description = `${args.nodeType} ${String(args.params.model_name ?? args.params.model ?? args.provider)}`;
  const { data, error } = await args.supabase.rpc("consume_credits_for", {
    p_user_id: args.userId,
    p_team_id: teamId,
    p_amount: amount,
    p_feature: def.feature,
    p_description: description,
    p_reference_id: referenceId,
    p_workspace_id: args.body.workspace_id ?? null,
    p_canvas_id: args.body.canvas_id ?? null,
  });
  if (error) {
    if (/function .*consume_credits_for/i.test(error.message)) {
      const fallback = await args.supabase.rpc("consume_credits", {
        p_user_id: args.userId,
        p_amount: amount,
        p_feature: def.feature,
        p_description: description,
        p_reference_id: referenceId,
      });
      if (fallback.error) {
        throw new Error(`Credit deduction failed: ${fallback.error.message}`);
      }
      if (fallback.data !== true) {
        throw new Error("INSUFFICIENT_CREDITS");
      }
    } else {
      throw new Error(`Credit deduction failed: ${error.message}`);
    }
  } else if (data !== true) {
    throw new Error("INSUFFICIENT_CREDITS");
  }

  console.log(
    `[workspace-credits] charged ${amount} credits user=${args.userId} team=${teamId ?? "personal"} ref=${referenceId}`,
  );
  return { amount, teamId, referenceId, feature: def.feature };
}

async function refundWorkspaceCredits(args: {
  supabase: ReturnType<typeof createClient>;
  userId: string;
  charge: WorkspaceCreditCharge | null;
  reason: string;
  workspaceId?: string | null;
  canvasId?: string | null;
}): Promise<void> {
  if (!args.charge || args.charge.amount <= 0) return;
  try {
    const { error } = await args.supabase.rpc("refund_credits_for", {
      p_user_id: args.userId,
      p_team_id: args.charge.teamId,
      p_amount: args.charge.amount,
      p_reason: args.reason,
      p_reference_id: args.charge.referenceId,
      p_workspace_id: args.workspaceId ?? null,
      p_canvas_id: args.canvasId ?? null,
    });
    if (!error) return;
    if (!/function .*refund_credits_for/i.test(error.message)) {
      throw error;
    }
    await refundCreditsAtomic(
      args.supabase,
      args.userId,
      args.charge.amount,
      args.reason,
      args.charge.referenceId,
    );
  } catch (err) {
    console.error(
      "[workspace-credits] refund failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function refundWorkspaceJobCharge(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  reason: string;
}): Promise<void> {
  const charged = Number(args.job.credits_charged ?? 0);
  const refunded = Number(args.job.credits_refunded ?? 0);
  const remaining = charged - refunded;
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  await refundWorkspaceCredits({
    supabase: args.supabase,
    userId: args.job.user_id,
    charge: {
      amount: remaining,
      teamId: args.job.credit_team_id ?? null,
      referenceId: args.job.id,
      feature: String(args.job.provider ?? args.job.node_type),
    },
    reason: args.reason,
    workspaceId: args.job.workspace_id ?? null,
    canvasId: args.job.canvas_id ?? null,
  });
  await args.supabase
    .from("workspace_generation_jobs")
    .update({ credits_refunded: refunded + remaining })
    .eq("id", args.job.id);
}

/**
 * Provider-aware @-mention rewriter for the workspace V2 handler.
 *
 * The frontend tokenises mentions as plain `@<label>` (not the legacy
 * `@[Label](nodeId)` form) and passes the resolved assets in the
 * payload's `mentioned_assets` array. This helper:
 *   - Rewrites tokens inline (provider-specific format)
 *   - Appends a `[Context: …]` block at the end of the prompt
 *
 * For Banana the inline tokens are stripped and the context block
 * speaks naturally about each attached image. For OpenAI gpt-image-2
 * the tokens become `Image N (Label)` so the model can address each
 * reference by index — matching OpenAI's prompting guide.
 *
 * Stateless on purpose — the legacy `resolveMentionsInPrompt` depends
 * on graph rows + pipeline_executions which V2 doesn't have.
 */
/**
 * The mention token format used everywhere in the workspace —
 * produced by the legacy PromptMentionTextarea (atomic blue chips).
 *
 *   @[Label](nodeId)
 */
const MENTION_REGEX = /@\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Role-aware context instructions per provider — ported from the main
 * project's `getBananaRoleInstruction` / `getOpenAIImageRoleInstruction`
 * (mediaforge-backend execute-pipeline-step v18+). Roles come from
 * the asset node's `referenceType` field — creator picks one of:
 *   subject | scene | style | object | pose | general
 * "general" is the default and matches the pre-role behaviour.
 */
function getBananaRoleInstruction(role: string): string {
  switch (role) {
    case "subject":
      return "SUBJECT reference — preserve the face, identity, body type, and clothing from this image with maximum fidelity. This is the primary subject of the generated image.";
    case "scene":
      return "SCENE/BACKGROUND reference — use ONLY for the setting, environment, lighting, atmosphere, and composition behind the subject. Do NOT copy any people, faces, or characters from this image.";
    case "style":
      return "STYLE reference — use ONLY for the visual style, color palette, mood, lighting tone, and artistic aesthetic. Do NOT copy any specific subjects, faces, scenes, or compositions from this image.";
    case "object":
      return "OBJECT/PRODUCT reference — include this exact item in the generated image. Preserve its shape, colors, branding, and proportions accurately. Do NOT change the object's design.";
    case "pose":
      return "POSE/COMPOSITION reference — copy ONLY the body posture, hand placement, camera angle, and framing from this image. Do NOT copy the face, identity, clothing, or background.";
    case "general":
    default:
      return "use as visual reference";
  }
}

function getOpenAIImageRoleInstruction(role: string): string {
  switch (role) {
    case "subject":
      return "[SUBJECT] Preserve the face, identity, body type, and clothing from this image exactly. This is the primary subject of the generated image — do NOT alter facial features.";
    case "scene":
      return "[BACKGROUND] Use ONLY for setting, environment, lighting, atmosphere, and composition. Do NOT copy any people, faces, or characters from this image.";
    case "style":
      return "[STYLE] Use ONLY for the visual style, color palette, mood, and artistic aesthetic. Do NOT copy specific subjects, faces, scenes, or compositions.";
    case "object":
      return "[OBJECT] Include this exact item in the generated image. Preserve shape, colors, branding, and proportions accurately. Do NOT alter the object's design.";
    case "pose":
      return "[POSE] Copy ONLY the body posture, hand placement, camera angle, and framing. Do NOT copy the face, identity, clothing, or background.";
    case "general":
    default:
      return "use as reference";
  }
}

/**
 * Inline-only mention rewriter. Replaces `@[Label](nodeId)` and plain
 * `@<label>` tokens with provider-specific position references —
 * **without** appending the `[Context: …]` block.
 *
 * Use this on every string param that may carry mentions. Legacy
 * executeOneStep scans `Object.entries(stepParams)` and runs an
 * equivalent loop — V2 mirrors that pattern so multi-prompt nodes
 * (negative_prompt, system_prompt, etc.) stay consistent.
 */
function rewriteMentionsInline(
  text: string,
  mentioned: Array<{ label?: string; nodeId?: string; url?: string | null; fieldType?: "image" | "video" | null; role?: string }>,
  provider: string,
): string {
  if (!text) return text;
  const imageMentions = mentioned.filter(
    (m) => m && m.fieldType === "image" && typeof m.url === "string" && m.url,
  );
  if (imageMentions.length === 0) {
    return text.replace(MENTION_REGEX, (_full, label) => label);
  }
  const indexByNodeId = new Map<string, number>();
  imageMentions.forEach((m, i) => {
    if (m.nodeId) indexByNodeId.set(m.nodeId, i);
  });
  const indexByLabel = new Map<string, number>();
  imageMentions.forEach((m, i) => {
    if (m.label) indexByLabel.set(m.label, i);
  });
  let out = text.replace(MENTION_REGEX, (_full, label: string, nodeId: string) => {
    const idx = indexByNodeId.get(nodeId);
    if (idx === undefined) return label;
    return provider === "openai" ? `Image ${idx + 1} (${label})` : `[${label}]`;
  });
  out = out.replace(/@([^\s@[]+)/g, (full, name: string) => {
    const idx = indexByLabel.get(name);
    if (idx === undefined) return full;
    return provider === "openai" ? `Image ${idx + 1} (${name})` : `[${name}]`;
  });
  return out;
}

/**
 * Append the `[Context: …]` block once, on the primary prompt field.
 * Banana names attachments by `[Label]` (matches the inline anchors
 * `rewriteMentionsInline` placed in the prompt). OpenAI names them
 * by `Image N (Label)` because gpt-image-2's multipart form keeps
 * text and attachments in separate fields.
 *
 * Each line ends with a role-specific instruction so the model knows
 * how to USE each attachment (subject vs scene vs style vs object vs
 * pose). Defaults to a generic "use as reference" when role is not
 * set — matches pre-role behaviour.
 */
function appendMentionContext(
  text: string,
  mentioned: Array<{ label?: string; nodeId?: string; url?: string | null; fieldType?: "image" | "video" | null; role?: string }>,
  provider: string,
): string {
  const imageMentions = mentioned.filter(
    (m) => m && m.fieldType === "image" && typeof m.url === "string" && m.url,
  );
  if (imageMentions.length === 0) return text;
  const lines = imageMentions.map((m, i) => {
    const role = (m.role ?? "general").toLowerCase();
    if (provider === "openai") {
      const ri = getOpenAIImageRoleInstruction(role);
      return `Image ${i + 1} = "${m.label ?? ""}" — ${ri}`;
    }
    const ri = getBananaRoleInstruction(role);
    return `[${m.label ?? ""}] = image ${i + 1} (attached) — ${ri}`;
  });
  // Squash any double-spaces left over from earlier strip cases, then
  // append. Mirror the legacy whitespace cleanup at the same spot.
  const cleaned = text.replace(/\s{2,}/g, " ").trim();
  return `${cleaned}\n\n[Context: ${lines.join(". ")}.]`;
}

// Note: the old `applyMentionContext` wrapper has been removed —
// callers now use `rewriteMentionsInline` (per-string) +
// `appendMentionContext` (once on prompt) so role-aware context can
// be threaded through without re-walking every param.

/**
 * OpenAI gpt-image-2 executor.
 *
 * Mirrors the spec used by the legacy product:
 *   - `/v1/images/edits` when ref images are present (multipart with
 *     repeated `image` parts — OpenAI SDK convention, NOT `image[]`)
 *   - `/v1/images/generations` when text-only (JSON body)
 *   - Conservative param set on /edits (no background, no
 *     output_format) to dodge the 403s the legacy editor was seeing.
 *   - Surfaces OpenAI's verbatim error message — they're the most
 *     useful diagnostic for billing / safety / quota issues.
 */
async function executeOpenAIImage2(
  params: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const prompt = String(params.prompt ?? "");
  if (!prompt) throw new Error("A prompt is required.");

  const model = String(params.model_name ?? params.model ?? "gpt-image-2");
  const quality = String(params.quality ?? "medium");
  const size = String(params.size ?? "1024x1024");
  const outputFormat = String(params.output_format ?? "png");
  // `background` accepts "auto" | "transparent" | "opaque". Transparent
  // requires the output format to be png or webp; OpenAI rejects it
  // with jpeg, so we silently force-fallback to "auto" in that case
  // rather than letting the user hit an error from the provider.
  const rawBackground = String(params.background ?? "auto");
  const background =
    rawBackground === "transparent" && outputFormat === "jpeg"
      ? "auto"
      : rawBackground;
  const moderation = String(params.moderation ?? "auto");

  const refUrls: string[] =
    (params.mention_image_urls as string[] | undefined) ??
    (params.image_url ? [String(params.image_url)] : []);

  const useEdits = refUrls.length > 0;
  let response: Response;

  if (useEdits) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("quality", quality);
    form.append("size", size);
    form.append("n", "1");

    // OpenAI's /v1/images/edits multipart convention:
    //   - 1 image  → field name `image`     (singular)
    //   - 2+ images → field name `image[]`  (array syntax)
    //
    // Repeated `image` parts (without []) trips the new API guard:
    //   "Duplicate parameter: 'image'. You provided multiple values
    //    for this parameter, whereas only one is allowed."
    // The recommended fix in their error is the `image[]` form, which
    // we apply once we know how many refs we're shipping.
    const fieldName = refUrls.length > 1 ? "image[]" : "image";
    let loaded = 0;
    for (let i = 0; i < refUrls.length; i++) {
      try {
        const bytes = await fetchImageBuffer(refUrls[i]);
        let mime = "image/png";
        let ext = "png";
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) { mime = "image/jpeg"; ext = "jpg"; }
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) { mime = "image/webp"; ext = "webp"; }
        const blob = new Blob([bytes], { type: mime });
        form.append(fieldName, blob, `ref_${i}.${ext}`);
        loaded++;
      } catch (err) {
        console.warn(`[openai-image-2] Failed to load ref ${i}:`, err);
      }
    }
    if (loaded === 0) {
      throw new Error("All reference images failed to load");
    }

    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        quality,
        output_format: outputFormat,
        background,
        moderation,
      }),
    });
  }

  if (!response.ok) {
    const status = response.status;
    const errorText = await response.text();
    let errorMsg = errorText.substring(0, 500);
    try {
      const errJson = JSON.parse(errorText);
      errorMsg = (errJson as { error?: { message?: string } })?.error?.message ?? errorMsg;
    } catch { /* keep raw text */ }

    console.error(`[openai-image-2] HTTP ${status}: ${errorMsg.substring(0, 200)}`);

    if (status === 429 || /billing|quota|exceeded|insufficient/i.test(errorText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    if (status === 401 || status === 403) {
      throw new Error(`OpenAI ${status}: ${errorMsg}`);
    }
    if (status >= 500) {
      throw new Error(`OpenAI ${status}: temporary upstream error — ${errorMsg}`);
    }
    throw new Error(`GPT Image 2 failed: ${errorMsg}`);
  }

  const result = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = result.data?.[0];
  const b64 = item?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data");
  }

  const ext = outputFormat === "jpeg" ? "jpg" : outputFormat;
  const mime = `image/${outputFormat === "jpg" ? "jpeg" : outputFormat}`;
  const fileName = `pipeline/${Date.now()}-openai.${ext}`;
  const binaryData = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  let publicUrl = `data:${mime};base64,${b64}`;

  const { error: uploadError } = await supabase.storage
    .from("ai-media")
    .upload(fileName, binaryData, { contentType: mime, upsert: true });

  if (uploadError) {
    console.error("[openai-image-2] Upload error:", uploadError);
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

  return {
    result_url: publicUrl,
    outputs: { output_image: publicUrl },
    output_type: "image_url" as const,
    provider_meta: { model },
  };
}

/** Server-side mirror of the frontend `MentionedAsset` shape. */
export interface MentionedAssetSrv {
  /** "asset" = AssetNode (image/video); "element" = saved/creator
   *  ElementNode resolved to a Kling Omni element entry. */
  kind?: "asset" | "element";
  label?: string;
  nodeId?: string;
  /** Asset-only. */
  url?: string | null;
  fieldType?: "image" | "video" | "audio" | null;
  role?: string;
  /** Element-only. */
  name?: string;
  reference_image_urls?: string[];
  frontal_image_url?: string;
  brand_element_id?: string;
}

interface WorkspaceRunBody {
  node_type?: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  mentioned_assets?: MentionedAssetSrv[];
  /** Async-poll mode (Kling video tasks, Tripo3D 3D-model tasks).
   *  Frontend resends after the initial Run returned a `task_id`
   *  and an empty URL. Each provider has its own action so we can
   *  whitelist the upstream URL per provider. */
  action?:
    | "enqueue_workspace_job"
    | "get_workspace_job"
    | "poll_kling"
    | "poll_seedance"
    | "poll_hyper3d"
    | "poll_tripo3d"
    | "mirror_tripo_url";
  job_id?: string;
  task_id?: string;
  poll_endpoint?: string;
  /** For action="mirror_tripo_url": the Tripo3D CDN URL to mirror
   *  into Supabase storage so model-viewer can fetch it across
   *  CORS. Used to migrate generations that were created before
   *  the inline mirror was deployed in poll_tripo3d. */
  url?: string;
  /** Optional context the frontend may pass for analytics attribution.
   *  Recorded in workspace_generation_events alongside user_id. None of
   *  these affect generation behaviour — they're informational only. */
  workspace_id?: string;
  project_id?: string;
  canvas_id?: string;
  node_id?: string;
  /** Internal: background jobs are charged once at enqueue time, so
   *  the worker replays the request with charging disabled. */
  skip_credit_charge?: boolean;
  precharged_credits?: number;
}

const WORKSPACE_JOB_MAX_MS = 30 * 60_000;
const WORKSPACE_JOB_ATTEMPT_TIMEOUT_MS = 140_000;
const WORKSPACE_JOB_BACKOFF_MS = [3_000, 5_000, 10_000, 15_000, 30_000, 60_000];

type WorkspaceJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "permanent_failed";

type WorkspaceJobRow = {
  id: string;
  user_id: string;
  project_id?: string | null;
  workspace_id?: string | null;
  canvas_id?: string | null;
  node_id?: string | null;
  node_type: string;
  provider?: string | null;
  model?: string | null;
  request: WorkspaceRunBody;
  status: WorkspaceJobStatus;
  attempts: number;
  max_attempts: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
  last_error?: string | null;
  credits_charged?: number | null;
  credits_refunded?: number | null;
  credit_team_id?: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isPermanentWorkspaceJobError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    classifyError(msg) === "permanent" ||
    /authentication|unauthor(ized|ised)|invalid.*api.?key/i.test(msg) ||
    /content[\s_-]*polic|moderation|blocked|safety system/i.test(msg) ||
    /unsupported node type|No executor for provider/i.test(msg) ||
    /\bnot configured\b|missing.*key|credentials missing/i.test(msg) ||
    /is not defined|is not a function|cannot read prop(?:erty|erties) of (?:undefined|null)/i.test(msg) ||
    /ReferenceError|TypeError|SyntaxError/i.test(msg) ||
    /HTTP 4\d\d/i.test(msg) ||
    /(prompt|input|argument).*required|Validation/i.test(msg)
  );
}

async function readJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text };
  }
}

async function invokeWorkspaceRunOnce(args: {
  functionUrl: string;
  authHeader: string;
  body: WorkspaceRunBody;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKSPACE_JOB_ATTEMPT_TIMEOUT_MS);
  const gatewayApiKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    "";
  try {
    const res = await fetch(args.functionUrl, {
      method: "POST",
      headers: {
        authorization: args.authHeader,
        ...(gatewayApiKey ? { apikey: gatewayApiKey } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
    const payload = await readJsonSafe(res);
    if (!res.ok || payload.error) {
      throw new Error(String(payload.error ?? `workspace-run-node HTTP ${res.status}`));
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function pollWorkspaceAsyncResult(args: {
  functionUrl: string;
  authHeader: string;
  response: Record<string, unknown>;
  budgetEndsAt: number;
}): Promise<Record<string, unknown>> {
  const taskId = String(args.response.task_id ?? "").trim();
  const providerMeta =
    args.response.provider_meta && typeof args.response.provider_meta === "object"
      ? (args.response.provider_meta as Record<string, unknown>)
      : {};
  const pollEndpoint = String(providerMeta.poll_endpoint ?? "").trim();
  if (!taskId || args.response.url || !pollEndpoint) return args.response;

  const provider = String(providerMeta.provider ?? "kling").toLowerCase();
  const pollAction =
    provider === "tripo3d"
      ? "poll_tripo3d"
      : provider === "hyper3d"
        ? "poll_hyper3d"
      : provider === "seedance"
        ? "poll_seedance"
        : "poll_kling";
  const intervalMs = provider === "tripo3d" ? 4_000 : provider === "hyper3d" ? 6_000 : 5_000;
  const successStatuses = new Set([
    "succeed",
    "success",
    "succeeded",
    "completed",
    "complete",
    "done",
  ]);
  const failedStatuses = new Set([
    "failed",
    "fail",
    "error",
    "errored",
    "cancelled",
    "canceled",
  ]);
  let lastStatus = "submitted";
  let lastMessage = "";

  while (Date.now() + intervalMs < args.budgetEndsAt) {
    await sleep(intervalMs);
    const pollResp = await invokeWorkspaceRunOnce({
      functionUrl: args.functionUrl,
      authHeader: args.authHeader,
      body: {
        action: pollAction,
        task_id: taskId,
        poll_endpoint: pollEndpoint,
      } as WorkspaceRunBody,
    });
    lastStatus = String(pollResp.status ?? "").toLowerCase();
    lastMessage = String(pollResp.message ?? "");
    if (lastStatus === "polling_error") continue;

    if (successStatuses.has(lastStatus)) {
      const url = String(pollResp.url ?? "");
      if (!url) {
        throw new Error(`${provider} task succeeded but returned no URL`);
      }
      const nextProviderMeta = {
        ...providerMeta,
        ...(pollResp.model_url ? { model_url: pollResp.model_url } : {}),
        ...(pollResp.preview_image ? { rendered_image: pollResp.preview_image } : {}),
      };
      return {
        ...args.response,
        url,
        provider_meta: nextProviderMeta,
      };
    }

    if (failedStatuses.has(lastStatus)) {
      throw new Error(`${provider} task failed: ${lastMessage || "no detail"}`);
    }
  }

  throw new Error(`${provider} polling timed out (last status: ${lastStatus || "empty"})`);
}

async function processWorkspaceGenerationJob(args: {
  supabase: any;
  jobId: string;
  userId: string;
  functionUrl: string;
  authHeader: string;
}): Promise<void> {
  const { data: jobRaw, error: jobErr } = await args.supabase
    .from("workspace_generation_jobs")
    .select("*")
    .eq("id", args.jobId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (jobErr || !jobRaw) {
    console.error("[workspace-job] missing job", args.jobId, jobErr);
    return;
  }

  const job = jobRaw as WorkspaceJobRow;
  const request = job.request ?? {};
  const startedAt = Date.now();
  const budgetEndsAt = startedAt + WORKSPACE_JOB_MAX_MS;
  let attempt = Number(job.attempts ?? 0);
  let lastError = "";

  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", job.id);

  while (Date.now() < budgetEndsAt && attempt < (job.max_attempts || 18)) {
    attempt += 1;
    await args.supabase
      .from("workspace_generation_jobs")
      .update({ status: "running", attempts: attempt })
      .eq("id", job.id);

    try {
      const initial = await invokeWorkspaceRunOnce({
        functionUrl: args.functionUrl,
        authHeader: args.authHeader,
        body: request,
      });
      const finalResult = await pollWorkspaceAsyncResult({
        functionUrl: args.functionUrl,
        authHeader: args.authHeader,
        response: initial,
        budgetEndsAt,
      });
      const charged = Number(job.credits_charged ?? 0);
      const finalResultWithCredits = {
        ...finalResult,
        credits_spent: Number.isFinite(charged) ? charged : 0,
      };

      await args.supabase
        .from("workspace_generation_jobs")
        .update({
          status: "completed",
          result: finalResultWithCredits,
          error: null,
          last_error: null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      console.log(`[workspace-job] completed job=${job.id} attempts=${attempt}`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const permanent = isPermanentWorkspaceJobError(lastError);
      await args.supabase
        .from("workspace_generation_jobs")
        .update({
          status: permanent ? "permanent_failed" : "running",
          last_error: lastError.substring(0, 1000),
          ...(permanent
            ? {
                error: lastError.substring(0, 1000),
                completed_at: new Date().toISOString(),
              }
            : {}),
        })
        .eq("id", job.id);
      if (permanent) {
        console.warn(`[workspace-job] permanent failure job=${job.id}: ${lastError}`);
        await refundWorkspaceJobCharge({
          supabase: args.supabase,
          job: { ...job, attempts: attempt, last_error: lastError },
          reason: `workspace job failed: ${lastError.substring(0, 160)}`,
        });
        return;
      }

      const remaining = budgetEndsAt - Date.now();
      const backoff = WORKSPACE_JOB_BACKOFF_MS[
        Math.min(attempt - 1, WORKSPACE_JOB_BACKOFF_MS.length - 1)
      ];
      if (remaining < backoff + 1_000) break;
      await sleep(backoff);
    }
  }

  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "failed",
      error:
        lastError.substring(0, 1000) ||
        `Generation timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
      last_error: lastError.substring(0, 1000) || null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);
  await refundWorkspaceJobCharge({
    supabase: args.supabase,
    job: { ...job, attempts: attempt, last_error: lastError },
    reason:
      lastError.substring(0, 160) ||
      `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
  });
  console.warn(`[workspace-job] failed job=${job.id} attempts=${attempt}: ${lastError}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const orgBlock = await rejectIfOrgUser(req);
  if (orgBlock) return orgBlock;

  const startTime = Date.now();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let activeCreditCharge: WorkspaceCreditCharge | null = null;
  let activeUserId: string | null = null;
  let activeBody: WorkspaceRunBody | null = null;

  try {
    /* ─── Auth ─────────────────────────────────────────────── */
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    activeUserId = user.id;

    /* ─── Parse body ───────────────────────────────────────── */
    const body = (await req.json()) as WorkspaceRunBody;
    activeBody = body;

    if (body.action === "get_workspace_job") {
      const jobId = String(body.job_id ?? "").trim();
      if (!jobId) {
        return new Response(
          JSON.stringify({ error: "job_id required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: job, error } = await supabase
        .from("workspace_generation_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!job) {
        return new Response(
          JSON.stringify({ error: "job not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ job }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "enqueue_workspace_job") {
      const nodeType = String(body.node_type ?? "").trim();
      if (!nodeType) {
        return new Response(
          JSON.stringify({ error: "node_type is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { action: _action, job_id: _jobId, ...runRequest } = body;
      const provider = getProviderForNodeType(
        nodeType,
        runRequest.params?.model_name as string | undefined,
      );
      if (provider === "seedream") {
        return new Response(
          JSON.stringify({
            error:
              "SeedDream is not available in Workspace runtime yet. Pick Banana, GPT Image 2, Kling, Seedance, TTS, or 3D for now.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const model = String(
        runRequest.params?.model_name ??
          runRequest.params?.model ??
          nodeType,
      );
      let jobCharge: WorkspaceCreditCharge | null = null;
      try {
        jobCharge = await consumeWorkspaceCredits({
          supabase,
          userId: user.id,
          body: runRequest,
          nodeType,
          provider,
          params: buildChargeParams(runRequest),
        });
      } catch (chargeErr) {
        const msg = chargeErr instanceof Error ? chargeErr.message : String(chargeErr);
        const status = msg === "INSUFFICIENT_CREDITS" ? 402 : 400;
        return new Response(
          JSON.stringify({
            error:
              msg === "INSUFFICIENT_CREDITS"
                ? "เครดิตไม่พอสำหรับการเจนนี้"
                : msg,
          }),
          { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: inserted, error: insertErr } = await supabase
        .from("workspace_generation_jobs")
        .insert({
          user_id: user.id,
          project_id: runRequest.project_id ?? null,
          workspace_id: runRequest.workspace_id ?? null,
          canvas_id: runRequest.canvas_id ?? null,
          node_id: runRequest.node_id ?? null,
          node_type: nodeType,
          provider,
          model,
          request: {
            ...runRequest,
            skip_credit_charge: true,
            precharged_credits: jobCharge?.amount ?? 0,
          },
          status: "queued",
          max_attempts: 18,
          credits_charged: jobCharge?.amount ?? 0,
          credit_team_id: jobCharge?.teamId ?? null,
        })
        .select("id")
        .single();
      if (insertErr || !inserted?.id) {
        await refundWorkspaceCredits({
          supabase,
          userId: user.id,
          charge: jobCharge,
          reason: "workspace job insert failed",
          workspaceId: runRequest.workspace_id ?? null,
          canvasId: runRequest.canvas_id ?? null,
        });
        return new Response(
          JSON.stringify({ error: insertErr?.message ?? "failed to create job" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const jobId = String(inserted.id);
      const bgTask = processWorkspaceGenerationJob({
        supabase,
        jobId,
        userId: user.id,
        functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
        authHeader,
      }).catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[workspace-job] bg crash job=${jobId}: ${msg}`);
        const { data: crashedJob } = await supabase
          .from("workspace_generation_jobs")
          .select("*")
          .eq("id", jobId)
          .maybeSingle();
        if (crashedJob) {
          await refundWorkspaceJobCharge({
            supabase,
            job: crashedJob as WorkspaceJobRow,
            reason: `workspace job crashed: ${msg.substring(0, 160)}`,
          });
        }
        await supabase
          .from("workspace_generation_jobs")
          .update({
            status: "failed",
            error: msg.substring(0, 1000),
            last_error: msg.substring(0, 1000),
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      });
      const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(bgTask);
      else bgTask.catch((e) => console.error("[workspace-job][bg-fallback]", e));

      return new Response(
        JSON.stringify({
          job_id: jobId,
          status: "queued",
          background: true,
          node_type: nodeType,
          provider,
          model,
          credits_spent: jobCharge?.amount ?? 0,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── On-demand Tripo URL mirror ──────────────────────────
     *
     * Tripo3D's CDN (`tripo-data.*.tripo3d.com`) does NOT send
     * `Access-Control-Allow-Origin`, so the browser blocks
     * model-viewer's WebGL fetch — the GLB never loads, only the
     * still poster image renders. The poll_tripo3d action mirrors
     * GLB+PNG into Supabase storage at task-completion time, but
     * generations created BEFORE that fix was deployed kept the
     * raw Tripo URLs and stay broken.
     *
     * This endpoint is the migration path: hand it any Tripo URL
     * and it returns a Supabase signed URL for the same asset. The
     * frontend caches the mapping per session via a hook so a tile
     * triggers ONE mirror call and reuses the result everywhere.
     *
     * Hard-whitelisted to *.tripo3d.com hosts so this can't be
     * abused as a generic open proxy. */
    if (body.action === "mirror_tripo_url") {
      const srcUrl = String(body.url ?? "").trim();
      if (!srcUrl) {
        return new Response(
          JSON.stringify({ error: "url required for mirror_tripo_url" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let hostOk = false;
      try {
        const u = new URL(srcUrl);
        hostOk =
          u.protocol === "https:" &&
          (u.hostname.endsWith(".tripo3d.com") || u.hostname === "tripo3d.com");
      } catch {
        hostOk = false;
      }
      if (!hostOk) {
        return new Response(
          JSON.stringify({ error: "Only tripo3d.com URLs may be mirrored" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Pick the extension off the path (signed URLs append a
      // long query string we want to ignore).
      const pathOnly = srcUrl.split("?")[0].split("#")[0];
      const m = pathOnly.match(/\.(glb|gltf|usdz|obj|fbx|png|jpe?g|webp|avif)$/i);
      const ext = (m?.[1] ?? "glb").toLowerCase();
      const contentType =
        ext === "gltf" ? "model/gltf+json"
        : ext === "usdz" ? "model/vnd.usdz+zip"
        : ext === "glb" ? "model/gltf-binary"
        : ext === "obj" ? "model/obj"
        : ext === "fbx" ? "application/octet-stream"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
        : ext === "avif" ? "image/avif"
        : ext === "png" ? "image/png"
        : "application/octet-stream";

      try {
        const r = await fetch(srcUrl);
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              error: `Tripo fetch failed (HTTP ${r.status})`,
              http_status: r.status,
            }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        // User-scoped path so the asset is owned by THIS user's
        // bucket policy. Uniqueness via timestamp + a hash of the
        // source URL keeps re-mirrors from clobbering each other.
        const hashInput = new TextEncoder().encode(srcUrl);
        const hashBuf = await crypto.subtle.digest("SHA-1", hashInput);
        const hashHex = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 16);
        const fileName = `tripo3d-mirror/${user.id}/${hashHex}.${ext}`;

        const { error: upErr } = await supabase.storage
          .from("ai-media")
          .upload(fileName, buf, { contentType, upsert: true });
        if (upErr) {
          console.warn(`[tripo3d-mirror] upload err: ${upErr.message}`);
          return new Response(
            JSON.stringify({ error: `Storage upload failed: ${upErr.message}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const { data: signed, error: signErr } = await supabase.storage
          .from("ai-media")
          .createSignedUrl(fileName, 60 * 60 * 24 * 365);
        if (signErr || !signed?.signedUrl) {
          return new Response(
            JSON.stringify({ error: `Sign URL failed: ${signErr?.message ?? "unknown"}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        console.log(`[tripo3d-mirror] ok ${ext} bytes=${buf.byteLength} path=${fileName}`);
        return new Response(
          JSON.stringify({
            url: signed.signedUrl,
            storage_path: fileName,
            bytes: buf.byteLength,
            content_type: contentType,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tripo3d-mirror] threw: ${msg}`);
        return new Response(
          JSON.stringify({ error: `Mirror failed: ${msg}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    /* ─── Async poll path (Kling video tasks) ──────────────── */
    if (body.action === "poll_kling") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_kling" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Whitelist Kling host AND constrain the path EXACTLY so this
      // can't be abused as an open proxy. The previous regex matched
      // only the prefix, so a poll_endpoint like
      // `https://api.klingai.com/v1/videos/../../foo` could in theory
      // pass (URL-normalisation-dependent). Tighten to: only the four
      // known endpoints. taskId is appended by THIS handler (line
      // below), not the caller, so the endpoint here must be exactly
      // 3 path segments.
      const ALLOWED_KIND = new Set([
        "omni-video",
        "image2video",
        "text2video",
        "motion-control",
      ]);
      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        const segs = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
        // Expected: ["v1","videos","<kind>"] — exactly 3 segments.
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === "api.klingai.com" &&
          segs.length === 3 &&
          segs[0] === "v1" &&
          segs[1] === "videos" &&
          ALLOWED_KIND.has(segs[2]);
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Kling video endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const KLING_AK =
        Deno.env.get("KLING_ACCESS_KEY_ID") ??
        Deno.env.get("KLING_AK") ??
        Deno.env.get("KLING_ACCESS_KEY");
      const KLING_SK =
        Deno.env.get("KLING_SECRET_KEY") ??
        Deno.env.get("KLING_SK") ??
        Deno.env.get("KLING_SECRET");
      if (!KLING_AK || !KLING_SK) {
        return new Response(
          JSON.stringify({ error: "Kling credentials missing on server" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const jwt = await generateKlingJWT(KLING_AK, KLING_SK);
      const pollUrl = `${pollEndpoint}/${encodeURIComponent(taskId)}`;
      const r = await fetch(pollUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return new Response(
          JSON.stringify({
            status: "polling_error",
            http_status: r.status,
            message: errText.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const payload = await r.json().catch(() => ({} as Record<string, unknown>));
      const data = (payload?.data ?? {}) as Record<string, unknown>;
      const status = String(data.task_status ?? "").toLowerCase();
      const statusMsg = String(data.task_status_msg ?? payload?.message ?? "");
      let videoUrl = "";
      if (status === "succeed" || status === "success") {
        const tr = (data.task_result ?? {}) as Record<string, unknown>;
        const videos = Array.isArray(tr.videos) ? (tr.videos as Array<Record<string, unknown>>) : [];
        videoUrl = videos.length > 0 ? String(videos[0]?.url ?? "") : "";
      }
      return new Response(
        JSON.stringify({
          status,             // "submitted" | "processing" | "succeed" | "failed"
          task_id: taskId,
          url: videoUrl,
          message: statusMsg,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Seedance / Volcengine Ark video tasks) ──
     * Bytedance Seedance jobs typically land in 30-180s. Like Kling we
     * return immediately on submit and let the frontend re-fire this
     * action every few seconds. Whitelisted host so the action can't
     * be abused as an open proxy. */
    if (body.action === "poll_seedance") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_seedance" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        // Volcengine Ark host is allowed; path must be exactly the
        // tasks endpoint (we append /{taskId} below).
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === "ark.cn-beijing.volces.com" ||
            u.hostname.endsWith(".byteplusapi.com")) &&
          u.pathname.replace(/\/+$/, "") === SEEDANCE_TASKS_PATH;
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Seedance tasks endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let creds;
      try {
        creds = loadSeedanceCredentials();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let statusObj;
      try {
        statusObj = await pollSeedanceOnce(taskId, creds.apiKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const rawStatus = String(statusObj.status ?? "").toLowerCase();
      // Normalise Volcengine status terms to the same vocabulary as
      // poll_kling so the frontend can use one polling hook.
      const normalised =
        rawStatus === "succeeded" || rawStatus === "success"
          ? "succeed"
          : rawStatus === "failed" || rawStatus === "fail" || rawStatus === "cancelled"
            ? "failed"
            : rawStatus === "running"
              ? "processing"
              : rawStatus || "submitted";
      const videoUrl =
        normalised === "succeed" ? String(statusObj.content?.video_url ?? "") : "";
      const message =
        statusObj.error?.message ?? (normalised === "failed" ? "Task failed" : "");
      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: videoUrl,
          message,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Hyper3D / BytePlus Ark 3D tasks) ───
     * Same short-poll pattern as Seedance, but the terminal payload
     * carries a model URL instead of a video URL. */
    if (body.action === "poll_hyper3d") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_hyper3d" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        const allowedBase = new URL(HYPER3D_BASE);
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === allowedBase.hostname &&
          u.pathname.replace(/\/+$/, "") === HYPER3D_TASKS_PATH;
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Hyper3D tasks endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let creds;
      try {
        creds = loadSeedanceCredentials();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let statusObj;
      try {
        statusObj = await pollHyper3dOnce(taskId, creds.apiKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const rawStatus = String(statusObj.status ?? "").toLowerCase();
      const normalised =
        rawStatus === "succeeded" || rawStatus === "success"
          ? "succeed"
          : rawStatus === "failed" || rawStatus === "fail" || rawStatus === "cancelled"
            ? "failed"
            : rawStatus === "running"
              ? "processing"
              : rawStatus || "submitted";
      const modelUrl = normalised === "succeed" ? pickHyper3dModelUrl(statusObj) : "";
      const previewImage =
        normalised === "succeed" ? String(statusObj.content?.rendered_image_url ?? "") : "";
      const message =
        statusObj.error?.message ?? (normalised === "failed" ? "Task failed" : "");

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: previewImage || modelUrl,
          model_url: modelUrl,
          preview_image: previewImage,
          message,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Tripo3D 3D-model tasks) ──────────
     * Each call is one quick GET to api.tripo3d.ai/v2/openapi/task
     * — no risk of edge-fn worker timeout even on multi-minute
     * jobs. Frontend re-fires this every 4-5s until status flips
     * to success / failed. */
    if (body.action === "poll_tripo3d") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_tripo3d" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Whitelist Tripo3D host so this can't be abused as an open
      // proxy. Path must be exactly `/v2/openapi/task` (we append
      // `/{taskId}` here on the server).
      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === "api.tripo3d.ai" &&
          u.pathname.replace(/\/+$/, "") === "/v2/openapi/task";
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be the Tripo3D /v2/openapi/task endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const KEY =
        Deno.env.get("TRIO_API_KEY") ??
        Deno.env.get("TRIPO_API_KEY") ??
        Deno.env.get("TRIPO3D_API_KEY");
      if (!KEY) {
        return new Response(
          JSON.stringify({ error: "Tripo3D credentials missing on server" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const pollUrl = `${pollEndpoint}/${encodeURIComponent(taskId)}`;
      const r = await fetch(pollUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${KEY}` },
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return new Response(
          JSON.stringify({
            status: "polling_error",
            http_status: r.status,
            message: errText.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const payload = (await r.json().catch(() => ({}))) as {
        code?: number;
        data?: Record<string, unknown>;
      };
      const data = (payload?.data ?? {}) as Record<string, unknown>;
      const status = String(data.status ?? "").toLowerCase();
      const progress = Number(data.progress ?? 0);
      const block = (data.output ?? data.result ?? {}) as Record<string, unknown>;

      // Dump the raw output object so we can see EXACTLY what fields
      // Tripo3D returns. Crucial for debugging when the user reports
      // "got a webm not a GLB" — the offending field is right here.
      // Truncate to keep edge-fn logs readable.
      console.log(
        `[tripo3d] task=${taskId.slice(0, 8)} status=${status} progress=${progress} ` +
          `output_keys=${Object.keys(block).join(",")} ` +
          `output_preview=${JSON.stringify(block).slice(0, 600)}`,
      );

      const extractUrl = (v: unknown): string => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "url" in (v as Record<string, unknown>)) {
          const inner = (v as Record<string, unknown>).url;
          if (typeof inner === "string") return inner;
        }
        return "";
      };

      /* Strict GLB filter — Tripo3D's `output` object contains a
       * MIX of asset URLs. Some fields point to GLB / GLTF (3D
       * meshes), others to PNG / WebM (preview thumbnails or
       * turntable videos). model-viewer can ONLY render mesh
       * formats; hand it a webm and it silently shows the poster,
       * which looks like the previous "static image" bug.
       *
       * We extract every candidate URL, then pick the first one
       * whose extension is a known 3D mesh format. Anything else
       * lands in the preview-image fallback path. */
      const isMeshUrl = (u: string): boolean =>
        /\.(glb|gltf|usdz|obj|fbx)(\?|#|$)/i.test(u);
      const isImageUrl = (u: string): boolean =>
        /\.(png|jpe?g|webp|avif)(\?|#|$)/i.test(u);

      // Pull every URL the response carries — under every common
      // field name we've seen Tripo3D use.
      const candidateFields = [
        "pbr_model",
        "model",
        "base_model",
        "glb",
        "gltf",
        "usdz",
        "rendered_image",
        "preview_image",
        "thumbnail_image",
        "image",
        "video_thumbnail",
        "rendered_video",
      ];
      const candidates: string[] = [];
      for (const k of candidateFields) {
        const u = extractUrl(block[k]);
        if (u) candidates.push(u);
      }
      // Also walk any unknown string-valued fields — Tripo could
      // rename a field on a future model version and we'd miss it.
      for (const [k, v] of Object.entries(block)) {
        if (candidateFields.includes(k)) continue;
        const u = extractUrl(v);
        if (u && !candidates.includes(u)) candidates.push(u);
      }

      const tripoModelUrl = candidates.find(isMeshUrl) ?? "";
      const tripoRenderedImage = candidates.find(isImageUrl) ?? "";

      /* Mirror Tripo3D outputs into our own storage —
       * Tripo's CDN (`tripo-data.cdn.bcebos.com`) doesn't serve the
       * `Access-Control-Allow-Origin` header that <model-viewer>
       * needs for its WebGL fetch, so the GLB silently fails to
       * load and the user sees only the poster image. Re-hosting in
       * Supabase storage solves both CORS and URL expiry in one
       * shot, the same way we already mirror OpenAI / Kling outputs.
       *
       * Mirror only fires on the terminal "succeed" status so we
       * don't waste bandwidth on every progress poll. If mirroring
       * fails (network blip, oversize file, etc.) we silently fall
       * back to the raw Tripo URL — model-viewer will use the
       * poster as before, but at least the GLB stays downloadable. */
      let modelUrl = tripoModelUrl;
      let renderedImage = tripoRenderedImage;
      const isTerminalSuccess = status === "succeed" || status === "success";
      if (isTerminalSuccess) {
        const mirror = async (
          srcUrl: string,
          ext: string,
          contentType: string,
        ): Promise<string | null> => {
          try {
            const r = await fetch(srcUrl);
            if (!r.ok) {
              console.warn(`[tripo3d] mirror ${ext} fetch ${r.status}`);
              return null;
            }
            const buf = new Uint8Array(await r.arrayBuffer());
            const fileName = `tripo3d/${taskId}/${Date.now()}.${ext}`;
            const { error: upErr } = await supabase.storage
              .from("ai-media")
              .upload(fileName, buf, { contentType, upsert: true });
            if (upErr) {
              console.warn(`[tripo3d] mirror ${ext} upload err: ${upErr.message}`);
              return null;
            }
            const { data: signed, error: signErr } = await supabase.storage
              .from("ai-media")
              .createSignedUrl(fileName, 60 * 60 * 24 * 365); // 1 year
            if (signErr || !signed?.signedUrl) {
              console.warn(`[tripo3d] mirror ${ext} sign err: ${signErr?.message}`);
              return null;
            }
            return signed.signedUrl;
          } catch (err) {
            console.warn(`[tripo3d] mirror ${ext} threw:`, err);
            return null;
          }
        };

        if (tripoModelUrl) {
          // Pick the actual extension from the URL so we keep .glb /
          // .gltf / .usdz semantics intact for model-viewer.
          const m = tripoModelUrl.match(/\.(glb|gltf|usdz|obj|fbx)(?=\?|#|$)/i);
          const ext = (m?.[1] ?? "glb").toLowerCase();
          const contentType = ext === "gltf" ? "model/gltf+json"
            : ext === "usdz" ? "model/vnd.usdz+zip"
            : "model/gltf-binary"; // .glb default; .obj/.fbx fall through
          const mirrored = await mirror(tripoModelUrl, ext, contentType);
          if (mirrored) modelUrl = mirrored;
        }
        if (tripoRenderedImage) {
          const m = tripoRenderedImage.match(/\.(png|jpe?g|webp|avif)(?=\?|#|$)/i);
          const ext = (m?.[1] ?? "png").toLowerCase();
          const contentType =
            ext === "jpg" || ext === "jpeg" ? "image/jpeg"
            : ext === "webp" ? "image/webp"
            : ext === "avif" ? "image/avif"
            : "image/png";
          const mirrored = await mirror(tripoRenderedImage, ext, contentType);
          if (mirrored) renderedImage = mirrored;
        }
        console.log(
          `[tripo3d] mirror done glb=${modelUrl !== tripoModelUrl ? "ok" : "passthru"} ` +
            `img=${renderedImage !== tripoRenderedImage ? "ok" : "passthru"}`,
        );
      }

      // Surface a normalised payload — frontend treats `succeed` /
      // `success` as terminal-positive, `failed` as terminal-negative,
      // anything else as still-running.
      return new Response(
        JSON.stringify({
          status,           // queued | running | success | failed
          progress,
          task_id: taskId,
          // For UI parity with poll_kling we put the rendered image
          // URL here so the frontend can swap the placeholder for a
          // real preview the moment it lands.
          url: renderedImage || modelUrl,
          model_url: modelUrl,
          preview_image: renderedImage,
          message: payload?.data?.message ?? "",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const nodeType = String(body.node_type ?? "");
    const rawParams = body.params ?? {};
    const inputs = body.inputs ?? {};
    const mentioned = body.mentioned_assets ?? [];

    if (!nodeType) {
      return new Response(
        JSON.stringify({ error: "node_type is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const provider = getProviderForNodeType(
      nodeType,
      rawParams.model_name as string | undefined,
    );

    /* ─── Build resolved params ───────────────────────────── */
    // Start from caller params, then overlay edge-resolved inputs
    // (mapped through HANDLE_SCHEMA so e.g. ref_image → image_url)
    // and mention URLs as a fallback ref_image / mention_image_urls.
    const params: Record<string, unknown> = { ...rawParams };

    // Did the caller provide a text prompt via an upstream Text edge?
    // Used to populate the response's prompt_source field.
    const textInputUsed =
      typeof inputs.text === "string" ||
      typeof inputs.context === "string" ||
      typeof inputs.context_text === "string";
    // Prefer the upstream Text wire whenever the node's own Prompt
    // field is empty OR whitespace-only. The previous truthy check
    // let prompts of "\n" (or " ") through, which both made
    // executeBanana receive a literal newline AND skipped the
    // @[mention](id) tokens that lived in `inputs.text` — the model
    // then saw context block but no instruction, and just remixed
    // the refs randomly.
    const promptParamIsBlank = !String(params.prompt ?? "").trim();
    if (typeof inputs.text === "string" && promptParamIsBlank) {
      params.prompt = inputs.text;
    }
    const contextParamIsBlank = !String(params.context_text ?? "").trim();
    if (typeof inputs.context === "string" && contextParamIsBlank) {
      params.context_text = inputs.context;
    }

    // Edge inputs → internal_key via HANDLE_SCHEMA.
    // Frontend may send a single value OR an array of values per
    // targetHandle (when the user wires multiple sources into the same
    // image port — e.g. 14 refs into Banana). Normalise to array first.
    const edgeImageUrls: string[] = [];
    for (const [targetHandle, value] of Object.entries(inputs)) {
      // text/context already mapped above
      if (targetHandle === "text" || targetHandle === "context") continue;

      const values = Array.isArray(value) ? value : [value];

      // Object/array values bypass the URL string path entirely —
      // they're complex payloads (e.g. ElementNode → Kling Omni
      // `elements`: [{name, reference_image_urls, frontal_image_url}]).
      // Map through HANDLE_SCHEMA when the handle is registered, else
      // pass through to params verbatim.
      const objectVals = values.filter(
        (v): v is Record<string, unknown> =>
          v !== null && typeof v === "object" && !Array.isArray(v),
      );
      if (objectVals.length > 0 && objectVals.length === values.length) {
        const handleDef = normalizeHandle(provider, targetHandle);
        const key = handleDef?.internal_key ?? targetHandle;
        const existing = params[key];
        const merged = Array.isArray(existing)
          ? [...(existing as unknown[]), ...objectVals]
          : objectVals;
        params[key] = merged;
        continue;
      }

      const stringVals = values.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (stringVals.length === 0) continue;

      const handleDef = normalizeHandle(provider, targetHandle);
      if (handleDef) {
        for (const v of stringVals) {
          try {
            validateEdgeValue(v, handleDef.data_type, targetHandle);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return new Response(
              JSON.stringify({ error: msg }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          if (handleDef.internal_key === "image_url" && handleDef.data_type === "image") {
            edgeImageUrls.push(v);
          }
        }
        if (handleDef.internal_key === "image_url" && handleDef.data_type === "image") {
          // Use the first ref as the primary image_url; the rest live
          // in mention_image_urls (merged below) for multi-image
          // dispatchers (Banana, OpenAI gpt-image-2).
          if (!params[handleDef.internal_key]) {
            params[handleDef.internal_key] = stringVals[0];
          }
        } else {
          // Non-image keys: last value wins (uncommon for them to
          // duplicate; keep behaviour simple).
          params[handleDef.internal_key] = stringVals[stringVals.length - 1];
        }
      } else {
        // Unknown handle for this provider — pass through (array-ify
        // back to scalar when there's just one).
        params[targetHandle] = stringVals.length === 1 ? stringVals[0] : stringVals;
      }
    }

    // Mentioned assets → image_url / mention_image_urls fallback.
    // Kling owns its mentions inside executeKlingOmni (positional
    // `@Element{N}` / `@Image{N}` rewrite), so this fallback is for
    // banana / openai / chat_ai only.
    const mentionImageUrls = mentioned
      .filter(
        (m) =>
          m &&
          m.kind !== "element" &&
          m.fieldType === "image" &&
          typeof m.url === "string" &&
          m.url,
      )
      .map((m) => m.url as string);
    if (provider !== "kling" && mentionImageUrls.length > 0) {
      if (provider === "banana" || provider === "openai") {
        const merged = Array.from(new Set([
          ...((params.mention_image_urls as string[] | undefined) ?? []),
          ...mentionImageUrls,
          ...edgeImageUrls,
        ]));
        params.mention_image_urls = merged;
        if (!params.image_url) params.image_url = merged[0];
      } else {
        if (!params.image_url) params.image_url = mentionImageUrls[0];
      }
    }

    /* ─── Mention rewrite (mirrors legacy executeOneStep) ─── */
    // Kling owns its rewrite (positional indexing — different syntax
    // from Banana/OpenAI). Skip the generic helpers when provider is
    // kling to avoid stripping `@[Label](nodeId)` tokens before the
    // Kling executor can see them.
    if (provider !== "kling") {
      // Step 1: inline-rewrite tokens in EVERY string param so that
      // negative_prompt / system_prompt / context_text / etc. all get
      // their `@[Label](id)` anchors converted, not just `prompt`.
      // Legacy iterates `Object.entries(stepParams)` for the same reason.
      for (const [key, val] of Object.entries(params)) {
        if (typeof val !== "string") continue;
        if (!val.includes("@")) continue; // fast-path: no token at all
        params[key] = rewriteMentionsInline(val, mentioned, provider);
      }
      // Step 2: append the `[Context: …]` block once, on the primary
      // prompt. Banana / OpenAI both need the model to know which
      // attachment maps to which name; doing this per-param would
      // duplicate the block on every field.
      if (typeof params.prompt === "string") {
        params.prompt = appendMentionContext(params.prompt, mentioned, provider);
      }
    }

    /* ─── Dispatch ────────────────────────────────────────── */
    if (provider === "seedream") {
      throw new Error(
        `Provider "${provider}" not yet implemented in workspace-run-node. ` +
          `Pick a Banana / Kling / GPT Image 2 / Seedance model for now.`,
      );
    }

    activeCreditCharge = await consumeWorkspaceCredits({
      supabase,
      userId: user.id,
      body,
      nodeType,
      provider,
      params,
    });

    let result: ProviderResult;
    switch (provider) {
      case "banana":
        result = await executeBanana(params, supabase);
        break;
      case "kling":
        result = await executeKling(params, supabase, mentioned);
        break;
      case "chat_ai":
        result = await executeChatAi(params);
        break;
      case "remove_bg":
        result = await executeRemoveBg(params, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        break;
      case "merge_audio":
        result = await executeMergeAudio(params);
        break;
      case "openai":
        result = await executeOpenAIImage2(params, supabase);
        break;
      case "video_understanding":
        result = await executeVideoToPrompt(params);
        break;
      case "tripo3d":
        result = await executeTripo3D(params, supabase);
        break;
      case "hyper3d":
        result = await executeHyper3D(params);
        break;
      case "google_tts":
        // Pass the service-role supabase client + user id so the
        // executor can upload the MP3 and insert into user_assets
        // without going through another auth round-trip.
        result = await executeGoogleTts(params, supabase, user.id);
        break;
      case "gemini_tts":
        // Legacy path — proxies to the standalone text-to-speech
        // edge fn which handles its own auth + credit consumption.
        // Forward the user's auth header so credit billing follows
        // them, not the service role.
        result = await executeGeminiTts(params, authHeader);
        break;
      case "seedance":
        result = await executeSeedance(params);
        break;
      case "seedream":
        result = await executeSeedream(params);
        break;
      default:
        throw new Error(`No executor for provider "${provider}"`);
    }

    /* ─── Format response ─────────────────────────────────── */
    const responseType =
      result.output_type === "video_url" ? "video" :
      result.output_type === "text"      ? "text"  :
      result.output_type === "audio_url" ? "audio" :
      "image";

    const promptUsed = String(params.prompt ?? params.system_prompt ?? "");
    const promptSource = textInputUsed ? "text_input_edge" : "prompt_param";

    const durationMs = Date.now() - startTime;
    console.log(
      `[workspace-run-node] ${nodeType} (${provider}) done in ${durationMs}ms ` +
      `-> ${responseType}${result.task_id ? " task=" + result.task_id : ""}`,
    );

    // Record an analytics event. Wrapped helper is best-effort and never
    // throws — a failed insert must not fail the user's run. Logs every
    // output_type now (text included) so chat-AI usage gets billed for
    // CMO-agency seats. Helper maps text → feature="chat_ai" to align
    // with credit_costs naming, and pulls token counts out of
    // provider_meta when the executor exposes them.
    const creditsSpent =
      activeCreditCharge?.amount ??
      (Number.isFinite(Number(body.precharged_credits))
        ? Number(body.precharged_credits)
        : 0);
    await recordGenerationEvent({
      supabase,
      userId: user.id,
      provider,
      nodeType,
      params,
      result,
      projectId: body.project_id ?? null,
      workspaceId: body.workspace_id ?? null,
      canvasId: body.canvas_id ?? null,
      nodeId: body.node_id ?? null,
      creditsSpent,
    });

    // Surface text outputs at the top level so the frontend's `r.text`
    // path picks them up (used by Chat AI, Video to Prompt, etc.).
    const textOut =
      result.output_type === "text"
        ? (result.outputs?.text as string | undefined) ??
          (result.outputs ? Object.values(result.outputs)[0] : undefined)
        : undefined;

    return new Response(
      JSON.stringify({
        type: responseType,
        url: result.result_url,
        text: textOut,
        outputs: result.outputs,
        task_id: result.task_id,
        prompt_used: promptUsed,
        prompt_source: promptSource,
        provider_meta: result.provider_meta,
        node_type: nodeType,
        credits_spent: creditsSpent,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[workspace-run-node] error:", msg);
    if (activeCreditCharge && activeUserId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await refundWorkspaceCredits({
        supabase,
        userId: activeUserId,
        charge: activeCreditCharge,
        reason: `workspace run failed: ${msg.substring(0, 160)}`,
        workspaceId: activeBody?.workspace_id ?? null,
        canvasId: activeBody?.canvas_id ?? null,
      });
    }
    const status =
      msg === "INSUFFICIENT_CREDITS"
        ? 402
        : e instanceof PricingConfigError
          ? 400
          : 500;
    return new Response(
      JSON.stringify({
        error: msg === "INSUFFICIENT_CREDITS" ? "เครดิตไม่พอสำหรับการเจนนี้" : msg,
      }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
