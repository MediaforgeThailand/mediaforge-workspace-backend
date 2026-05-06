/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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
  isNonRetryableQuotaError,
  TOTAL_MAX_RETRIES,
} from "../_shared/providerRetry.ts";
import { recordGenerationEvent } from "../_shared/analytics.ts";
import { acceptPendingOrgInviteForUser } from "../_shared/orgInvite.ts";
import { isPublicEmailDomain } from "../_shared/publicEmailDomains.ts";
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
import {
  VEO_BASE,
  VEO_MODEL_MAP,
  buildVeoRequest,
  extractVeoVideoUri,
  fetchImageAsInline,
  loadVeoApiKey,
  normalizeVeoOperationName,
  pollVeoOnce,
  submitVeoTask,
  type VeoApiKeyAlias,
  type VeoAspectRatio,
  type VeoDuration,
  type VeoImage,
  type VeoPersonGeneration,
  type VeoResolution,
} from "../_shared/veo.ts";

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

function isProviderBillingLike(status: number, text: string): boolean {
  // 429 ALWAYS stays transient — even when the body claims "exceeded your
  // current quota" or "check your plan and billing details". Google's
  // well-documented "ghost 429" / "free_tier_requests Limit 0" bugs return
  // billing-flavoured bodies on Tier-1 paid keys (esp. for the Pro image
  // models like gemini-3-pro-image-preview), and refunding the user
  // permanently for a Google-side glitch is wrong. The durable queue will
  // retry on its normal backoff; if it really IS exhausted the queue's
  // dead-letter budget will eventually catch it.
  if (status === 429) return false;
  // 402 Payment Required is the only HTTP code Google + most providers use
  // for genuine billing exhaustion.
  if (status === 402) return true;
  // Body-keyword fallback for providers that don't use 402 (Kling, Replicate,
  // Shotstack, etc.). Keep this list TIGHT — generic words like "billing" or
  // "quota exceeded" can appear in transient errors too. Only match phrases
  // that unambiguously mean "the account ran out of credit".
  return /account balance not enough|insufficient balance|payment required|prepaid|top[ -]?up/i.test(text);
}

function summarizeProviderErrorBody(text: string, limit = 700): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === "string" ? error.message : "";
    const status = typeof error?.status === "string" ? error.status : "";
    const code = typeof error?.code === "number" || typeof error?.code === "string"
      ? String(error.code)
      : "";
    const detail = [code ? `code ${code}` : "", status, message]
      .filter(Boolean)
      .join(" ");
    if (detail) return detail.slice(0, limit);
  } catch {
    // Fall through to plain-text/html cleanup.
  }
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

const MAGNIFIC_BASE =
  Deno.env.get("FREEPIK_API_BASE")?.trim().replace(/\/+$/, "") ||
  Deno.env.get("MAGNIFIC_API_BASE")?.trim().replace(/\/+$/, "") ||
  "https://api.freepik.com/v1";

function loadMagnificApiKey(): string {
  const rawKey =
    Deno.env.get("MAGNIFIC_API_KEY") ??
    Deno.env.get("FREEPIK_API_KEY") ??
    Deno.env.get("MAGNIFIC_KEY");
  const key = rawKey?.trim().replace(/[\u0000-\u001F\u007F-\uFFFF]/g, "");
  if (!key) {
    throw new Error(
      "Freepik/Magnific video fallback is not configured. Set MAGNIFIC_API_KEY or FREEPIK_API_KEY.",
    );
  }
  return key;
}

function shouldPreferMagnificVeo(): boolean {
  const value = String(
    Deno.env.get("VEO_PROVIDER") ??
      Deno.env.get("VEO_BACKEND") ??
      Deno.env.get("VEO_FALLBACK_PROVIDER") ??
      "",
  ).trim().toLowerCase();
  return value === "freepik" || value === "magnific" || value === "freepik_veo";
}

function shouldPreferReplicateVeo(): boolean {
  const value = String(
    Deno.env.get("VEO_PROVIDER") ??
      Deno.env.get("VEO_BACKEND") ??
      Deno.env.get("VEO_FALLBACK_PROVIDER") ??
      "",
  ).trim().toLowerCase();
  return value === "replicate" || value === "replicate_veo";
}

function canUseMagnificVeo(): boolean {
  return Boolean(
    Deno.env.get("MAGNIFIC_API_KEY") ??
      Deno.env.get("FREEPIK_API_KEY") ??
      Deno.env.get("MAGNIFIC_KEY"),
  );
}

function canUseMagnificImage(): boolean {
  return canUseMagnificVeo();
}

function canUseMagnificVideo(): boolean {
  return canUseMagnificVeo();
}

// Magnific's current public docs list Seedance Pro/Lite endpoints, not
// Dreamina Seedance 2.0. Keep this off unless the operator explicitly accepts
// that the fallback changes provider/model semantics.
function shouldUseMagnificSeedanceFallback(): boolean {
  const value = String(
    Deno.env.get("SEEDANCE_REAL_PERSON_FALLBACK_PROVIDER") ??
      Deno.env.get("SEEDANCE_FALLBACK_PROVIDER") ??
      "",
  ).trim().toLowerCase();
  return value === "magnific" || value === "freepik" || value === "freepik_seedance";
}

function canUseReplicateVeo(): boolean {
  return Boolean(Deno.env.get("REPLICATE_API_TOKEN"));
}

function truthyParam(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function enforcePrimaryProviderParams(provider: string, params?: Record<string, unknown>): void {
  if (!params) return;
  if (provider === "veo") {
    // Google Veo 3.1 always returns audio. Do not reinterpret a no-audio
    // request as permission to spend on wrapper providers.
    params.generate_audio = "true";
    params.has_audio = "true";
    delete params.replicate_generate_audio;
  }
}

function shouldGenerateFallbackVeoAudio(params: Record<string, unknown>): boolean {
  const envValue = String(Deno.env.get("REPLICATE_VEO_GENERATE_AUDIO") ?? "").trim().toLowerCase();
  if (envValue === "1" || envValue === "true" || envValue === "yes" || envValue === "on" || envValue === "force") {
    return true;
  }
  if (envValue === "0" || envValue === "false" || envValue === "no" || envValue === "off" || envValue === "never") {
    return false;
  }
  return (
    truthyParam(params.replicate_generate_audio) ||
    truthyParam(params.generate_audio) ||
    truthyParam(params.has_audio)
  );
}

function canUseGemini2Veo(): boolean {
  return Boolean(Deno.env.get("GEMINI2_API_KEY"));
}

function shouldFallbackVeoQuota(errMsg: string): boolean {
  return (
    isNonRetryableQuotaError(errMsg) ||
    /HTTP 429|RESOURCE_EXHAUSTED|exceeded your current quota|rate-limits|ai\.dev\/rate-limit/i.test(errMsg)
  );
}

function summarizeProviderErrorText(raw: string, maxLength = 500): string {
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const source = title ?? raw;
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function fetchWithAttemptTimeout(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: init.signal ?? aborter.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

type DataType = "image" | "video" | "audio" | "text";

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
  seedream: {
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
  seedance: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    end_frame:     { internal_key: "image_tail_url", data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    reference_image: { internal_key: "reference_image_urls", data_type: "image" },
    ref_video:     { internal_key: "reference_video_urls", data_type: "video" },
    ref_audio:     { internal_key: "reference_audio_urls", data_type: "audio" },
  },
  replicate_video: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    end_frame:     { internal_key: "image_tail_url", data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "reference_image_urls", data_type: "image" },
    reference_image: { internal_key: "reference_image_urls", data_type: "image" },
    ref_video:     { internal_key: "reference_video_urls", data_type: "video" },
    ref_audio:     { internal_key: "reference_audio_urls", data_type: "audio" },
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

function normalizeHandleForModel(
  provider: string,
  targetHandle: string,
  modelName?: string,
): HandleDef | null {
  const model = String(modelName ?? "").toLowerCase();
  if (provider === "kling" && targetHandle === "ref_image" && model === "kling-v3-omni") {
    return { internal_key: "ref_image_urls", data_type: "image" };
  }
  if (provider === "kling" && targetHandle === "ref_image" && model.includes("motion")) {
    return HANDLE_SCHEMA.motion_control.ref_image;
  }
  if (
    provider === "seedance" &&
    targetHandle === "ref_image" &&
    (model.startsWith("seedance-2-0") || model.startsWith("dreamina-seedance-2-0"))
  ) {
    return HANDLE_SCHEMA.seedance.reference_image;
  }
  return normalizeHandle(provider, targetHandle);
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

function appendUniqueStringParam(
  params: Record<string, unknown>,
  key: string,
  values: string[],
  max: number,
): void {
  const existing = Array.isArray(params[key])
    ? (params[key] as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
    : typeof params[key] === "string"
      ? [params[key] as string]
      : [];
  params[key] = Array.from(new Set([...existing, ...values])).slice(0, max);
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
  const characterOrientation = String(params.character_orientation ?? "video");

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

  console.log(`[kling-motion] POST ${ENDPOINT} model=${mapping.model} mode=${mapping.mode} orientation=${characterOrientation}`);

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

  const initialMode = String((params.mode as string) ?? mapping.mode).toLowerCase() === "std" ? "std" : "pro";
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
async function executeKlingOmni(
  params: Record<string, unknown>,
  mapping: { model: string; mode: string },
  modelSlug: string,
  jwtToken: string,
  supabaseClient: ReturnType<typeof createClient>,
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
    if (isProviderBillingLike(res.status, errText)) {
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
function isSeedanceRealPersonPolicyError(message: string): boolean {
  return /Seedance rejected the reference media|SensitiveContentDetected|PrivacyInformation|real person|privacy-sensitive|input image may contain real person/i.test(
    message,
  );
}

function normalizeMagnificVideoAspectRatio(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  switch (raw) {
    case "21:9":
    case "film_horizontal_21_9":
      return "film_horizontal_21_9";
    case "16:9":
    case "widescreen_16_9":
      return "widescreen_16_9";
    case "4:3":
    case "classic_4_3":
      return "classic_4_3";
    case "1:1":
    case "square_1_1":
      return "square_1_1";
    case "3:4":
    case "traditional_3_4":
      return "traditional_3_4";
    case "9:16":
    case "social_story_9_16":
      return "social_story_9_16";
    case "9:21":
    case "film_vertical_9_21":
      return "film_vertical_9_21";
    default:
      return "widescreen_16_9";
  }
}

function magnificSeedanceEndpointSlug(modelSlug: string, resolution?: string): string {
  const model = modelSlug.toLowerCase();
  const res =
    resolution === "480p"
      ? "480p"
      : resolution === "1080p"
        ? "1080p"
        : "720p";
  const tier = model.includes("lite") || model.includes("fast") ? "lite" : "pro";
  return `seedance-${tier}-${res}`;
}

function normalizeMagnificSeedanceDuration(value: number): "5" | "10" {
  return value <= 7 ? "5" : "10";
}

async function submitMagnificSeedanceTask(args: {
  modelSlug: string;
  providerModelId: string;
  prompt: string;
  imageUrl: string;
  duration: number;
  resolution?: string;
  ratio?: string;
  cameraFixed?: boolean;
  seed?: number;
  fallbackReason: string;
  sourceInputMode: "start_frame" | "end_frame" | "reference_image";
  referenceImageCount: number;
  hadEndFrame: boolean;
}): Promise<ProviderResult> {
  if (!/^https?:\/\//i.test(args.imageUrl) && !/^data:image\//i.test(args.imageUrl)) {
    throw new Error("Freepik/Magnific Seedance fallback requires an image URL or data image.");
  }
  const apiKey = loadMagnificApiKey();
  const endpointSlug = magnificSeedanceEndpointSlug(args.modelSlug, args.resolution);
  const endpoint = `${MAGNIFIC_BASE}/ai/image-to-video/${endpointSlug}`;
  const endpointHost = new URL(endpoint).hostname;
  const authHeaderName = endpointHost.includes("magnific.com")
    ? "x-magnific-api-key"
    : "x-freepik-api-key";

  let imagePayload = args.imageUrl;
  if (/^https?:\/\//i.test(args.imageUrl)) {
    try {
      imagePayload = bytesToBase64(await fetchImageBuffer(args.imageUrl));
      console.log(`[seedance-magnific] converted fallback image to base64 (${Math.round(imagePayload.length / 1024)}KB)`);
    } catch (err) {
      console.warn("[seedance-magnific] image base64 conversion failed, using URL:", err);
    }
  }

  const payload: Record<string, unknown> = {
    prompt: args.prompt || "Animate the reference image naturally.",
    image: imagePayload,
    duration: normalizeMagnificSeedanceDuration(args.duration),
    camera_fixed: Boolean(args.cameraFixed),
    frames_per_second: 24,
  };
  if (args.ratio && args.ratio !== "Auto") {
    payload.aspect_ratio = normalizeMagnificVideoAspectRatio(args.ratio);
  }
  if (typeof args.seed === "number" && Number.isFinite(args.seed)) {
    payload.seed = Math.max(-1, Math.min(4_294_967_295, Math.trunc(args.seed)));
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [authHeaderName]: apiKey,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Freepik/Magnific Seedance submit failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Freepik/Magnific Seedance submit returned non-JSON: ${text.slice(0, 200)}`);
  }
  const data = parsed.data && typeof parsed.data === "object"
    ? (parsed.data as Record<string, unknown>)
    : parsed;
  const generated = Array.isArray(data.generated)
    ? data.generated
    : Array.isArray(parsed.generated)
      ? parsed.generated
      : [];
  const immediateUrl = extractProviderMediaUrl(generated);
  const providerMeta = {
    provider: "freepik_seedance",
    source_provider: "magnific",
    fallback_for: "seedance",
    fallback_reason: args.fallbackReason,
    model: args.modelSlug,
    provider_model_id: args.providerModelId,
    provider_endpoint: endpoint,
    endpoint_slug: endpointSlug,
    duration_seconds: Number(payload.duration),
    requested_duration_seconds: args.duration,
    resolution: args.resolution,
    aspect_ratio: payload.aspect_ratio ?? "auto",
    source_input_mode: args.sourceInputMode,
    reference_image_count: args.referenceImageCount,
    unsupported_end_frame: args.hadEndFrame,
    poll_endpoint: endpoint,
  };
  if (immediateUrl) {
    return {
      result_url: immediateUrl,
      outputs: { output_video: immediateUrl },
      output_type: "video_url",
      provider_meta: { ...providerMeta, immediate_result: true },
    };
  }
  const taskId = String(data.task_id ?? data.id ?? "").trim();
  if (!taskId) {
    throw new Error("Freepik/Magnific Seedance submit succeeded but no task_id returned");
  }
  console.warn(
    `[seedance-magnific] submitted fallback task=${taskId} endpoint=${endpointSlug} reason=${args.fallbackReason}`,
  );
  return {
    task_id: taskId,
    outputs: {
      output_video: "",
      output_start_frame: args.imageUrl,
      output_last_frame: "",
    },
    output_type: "video_url",
    provider_meta: providerMeta,
  };
}

async function executeSeedance(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const modelSlug = String(params.model_name ?? params.model ?? "seedance-1-5-pro-251215");
  const entry = SEEDANCE_MODEL_MAP[modelSlug];
  if (!entry) {
    throw new Error(
      `Unknown Seedance model: ${modelSlug}. ` +
        `Available: ${Object.keys(SEEDANCE_MODEL_MAP).join(", ")}`,
    );
  }
  const isV2 = entry.model.startsWith("dreamina-seedance-2-0");
  const { apiKey } = loadSeedanceCredentials({ v2: isV2 });

  const prompt = String(params.prompt ?? "").trim();

  // Coerce string-y param values (the frontend serialises everything
  // through select dropdowns that hand us strings).
  const ratio = (params.ratio ?? params.aspect_ratio) as string | undefined;
  let resolution = params.resolution as string | undefined;
  const durationRaw = params.duration as string | number | undefined;
  let duration =
    typeof durationRaw === "number"
      ? durationRaw
      : durationRaw
        ? parseInt(String(durationRaw), 10) || 5
        : 5;
  // Per-model duration windows. BytePlus returns
  // `InvalidParameter — the parameter duration specified in the
  // request is not valid for model <slug>` for any value outside
  // its model's accepted range. We clamp server-side as a safety
  // net for older frontend builds and direct-API callers; the
  // schema-driven UI already enforces these ranges.
  //
  //   dreamina-seedance-2-0 / -2-0-fast      → 4..15
  //   seedance-1-5-pro                       → 4..12  (discrete in UI)
  //   seedance-1-0-pro / -1-0-pro-fast       → 2..12
  //   seedance-1-0-lite                      → 5 or 10 only
  //
  // Note: `entry.model` is the BytePlus-mapped slug (dreamina-* for
  // 2.0, seedance-* for 1.x), so we check the underlying mapped name
  // rather than the user-facing slug.
  const mapped = entry.model;
  if (mapped.startsWith("dreamina-seedance")) {
    if (!Number.isFinite(duration) || duration < 4) duration = 4;
    else if (duration > 15) duration = 15;
  } else if (mapped.startsWith("seedance-1-5")) {
    if (!Number.isFinite(duration) || duration < 4) duration = 4;
    else if (duration > 12) duration = 12;
  } else if (mapped.startsWith("seedance-1-0-lite")) {
    // Lite has only two valid values — snap to the nearer one.
    duration = duration <= 7 ? 5 : 10;
  } else if (mapped.startsWith("seedance-")) {
    if (!Number.isFinite(duration) || duration < 2) duration = 2;
    else if (duration > 12) duration = 12;
  }
  if (mapped.startsWith("dreamina-seedance-2-0") && resolution === "1080p") {
    resolution = "720p";
  }
  const generateAudioRaw = params.generate_audio ?? params.has_audio;
  const generateAudio = entry.supportsAudio
    ? generateAudioRaw === true || generateAudioRaw === "true"
    : undefined;
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
  const collectReferenceImageUrls = (): string[] => {
    const acc: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === "string" && v.length > 0) acc.push(v);
    };
    const pushMany = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(push);
      else push(v);
    };
    pushMany(params.reference_image_urls);
    pushMany(params.reference_image_url);
    pushMany(params.reference_image);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const url of acc) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out.slice(0, 9);
  };
  const referenceImageUrls = collectReferenceImageUrls();
  const collectReferenceVideoUrls = (): string[] => {
    const acc: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === "string" && v.length > 0) acc.push(v);
    };
    const pushMany = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(push);
      else push(v);
    };
    pushMany(params.reference_video_urls);
    pushMany(params.reference_video_url);
    pushMany(params.video_urls);
    pushMany(params.video_url);
    pushMany(params.ref_video);
    return Array.from(new Set(acc)).slice(0, 3);
  };
  const referenceVideoUrls = collectReferenceVideoUrls();
  // Optional Seedance 2.0 multimodal reference audio (the v2 spec
  // accepts an audio_url with role="reference_audio" alongside
  // ref images / video).
  const collectReferenceAudioUrls = (): string[] => {
    const acc: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === "string" && v.length > 0) acc.push(v);
    };
    const pushMany = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(push);
      else push(v);
    };
    pushMany(params.reference_audio_urls);
    pushMany(params.reference_audio_url);
    pushMany(params.audio_urls);
    pushMany(params.audio_url);
    pushMany(params.ref_audio);
    return Array.from(new Set(acc)).slice(0, 3);
  };
  const referenceAudioUrls = collectReferenceAudioUrls();
  if (!prompt && !startFrameUrl && referenceImageUrls.length === 0 && referenceVideoUrls.length === 0 && referenceAudioUrls.length === 0) {
    throw new Error("Seedance requires a prompt, start_frame image, reference_image, ref_video, or ref_audio.");
  }
  if ((startFrameUrl || endFrameUrl) && (referenceImageUrls.length > 0 || referenceVideoUrls.length > 0 || referenceAudioUrls.length > 0)) {
    throw new Error("Seedance cannot mix start/end frame mode with reference media mode.");
  }
  if (referenceImageUrls.length > 0 && !entry.supportsVideoReference) {
    throw new Error(`Seedance model ${modelSlug} does not support reference image input.`);
  }
  if (referenceVideoUrls.length > 0 && !entry.supportsVideoReference) {
    throw new Error(`Seedance model ${modelSlug} does not support reference video input.`);
  }
  if (referenceAudioUrls.length > 0 && !entry.supportsVideoReference) {
    throw new Error(`Seedance model ${modelSlug} does not support reference audio input.`);
  }

  const built = buildSeedanceContent(
    {
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
      referenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
    },
    { v2: isV2 },
  );

  console.log(
    `[seedance] submit model=${entry.model} v2=${isV2} duration=${duration}s ` +
      `resolution=${resolution ?? "default"} ratio=${ratio ?? "default"} ` +
      `audio=${!!generateAudio} i2v=${!!startFrameUrl} vrefs=${referenceVideoUrls.length} ` +
      `irefs=${referenceImageUrls.length} arefs=${referenceAudioUrls.length}`,
  );

  let taskId: string;
  try {
    taskId = await submitSeedanceTask(
      { model: entry.model, ...built },
      apiKey,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isV2 && isSeedanceRealPersonPolicyError(message)) {
      console.warn(
        "[seedance] BytePlus real-person policy rejected image input; cross-provider fallback is disabled",
      );
    }
    throw err;
  }

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
      has_audio: !!generateAudio,
      is_image2video: !!startFrameUrl,
      has_image_ref: referenceImageUrls.length > 0,
      reference_image_count: referenceImageUrls.length,
      has_video_ref: referenceVideoUrls.length > 0,
      reference_video_count: referenceVideoUrls.length,
      has_audio_ref: referenceAudioUrls.length > 0,
      reference_audio_count: referenceAudioUrls.length,
      poll_endpoint: `${SEEDANCE_BASE}${SEEDANCE_TASKS_PATH}`,
    },
  };
}

/**
 * Google Veo 3.1 (Standard) video-gen executor.
 *
 * Async submit → predictLongRunning returns an operation name; the
 * frontend polls via the workspace-run-node `poll_veo` action until
 * the operation reports `done: true`. Audio is always generated
 * (Veo 3.1 spec) — no toggle.
 *
 * Veo's video endpoint accepts embedded base64 bytes for start/end
 * frames, so any upstream URL (image gen output, uploaded asset) is
 * fetched here and converted on the fly.
 */
async function fetchVeoFrameAsInline(
  url: string,
  supabaseClient?: ReturnType<typeof createClient>,
): Promise<VeoImage> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const parsedStorageUrl = supabaseUrl ? parseSupabaseStorageUrl(url, supabaseUrl) : null;

  if (parsedStorageUrl && supabaseClient) {
    const { data, error } = await supabaseClient.storage
      .from(parsedStorageUrl.bucket)
      .download(parsedStorageUrl.path);
    if (!error && data) {
      const bytes = new Uint8Array(await data.arrayBuffer());
      return {
        mimeType: data.type?.split(";")[0]?.trim() || "image/png",
        data: bytesToBase64(bytes),
      };
    }
    console.warn(
      `[veo] storage download failed for ${parsedStorageUrl.bucket}/${parsedStorageUrl.path}: ` +
        `${error?.message ?? "no data"}`,
    );
  }

  return await fetchImageAsInline(url);
}

async function executeVeo(
  params: Record<string, unknown>,
  supabaseClient?: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  const modelSlug = String(
    params.model_name ?? params.model ?? "veo-3.1-generate-preview",
  );
  const entry = VEO_MODEL_MAP[modelSlug];
  if (!entry) {
    throw new Error(
      `Unknown Veo model: ${modelSlug}. Available: ${Object.keys(VEO_MODEL_MAP).join(", ")}`,
    );
  }

  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Veo requires a prompt.");
  }

  // Aspect ratio — Veo 3.1 only accepts "16:9" or "9:16". The shared
  // workspace dropdown also exposes "Auto", "1:1", and "4:3" for
  // Kling/Seedance; coerce any unsupported value to the default.
  const rawAspect = String(params.aspect_ratio ?? params.ratio ?? "16:9");
  const aspectRatio: VeoAspectRatio = rawAspect === "9:16" ? "9:16" : "16:9";

  // Resolution — only "720p" / "1080p" are accepted by Veo 3.1; "4k"
  // is gated behind preview access we don't surface to users yet.
  const rawRes = String(params.resolution ?? "720p");
  let resolution: VeoResolution = rawRes === "1080p" ? "1080p" : "720p";

  // Duration — discrete 4 | 6 | 8. The slider used for other
  // providers may hand us numbers — coerce + snap to nearest valid.
  const rawDuration = params.duration;
  const durationNum =
    typeof rawDuration === "number"
      ? rawDuration
      : parseInt(String(rawDuration ?? "8"), 10) || 8;
  const durationSeconds: VeoDuration =
    durationNum <= 4 ? 4 : durationNum <= 6 ? 6 : 8;
  if (resolution === "1080p" && durationSeconds !== 8) {
    console.warn(
      `[veo] downgrading resolution to 720p because 1080p only supports 8s ` +
        `(requested=${durationSeconds}s)`,
    );
    resolution = "720p";
  }

  const startFrameUrl = (params.start_frame ?? params.image_url) as
    | string
    | undefined;
  const endFrameUrl = (params.end_frame ?? params.image_tail_url) as
    | string
    | undefined;
  if (!shouldGenerateFallbackVeoAudio(params)) {
    console.warn("[veo] no-audio request ignored; Google Veo 3.1 is the primary provider and always returns audio");
  }
  if (shouldPreferReplicateVeo() || shouldPreferMagnificVeo()) {
    console.warn("[veo] wrapper provider override is treated as final fallback; Google keys are tried first");
  }

  const startFrame = startFrameUrl ? await fetchVeoFrameAsInline(startFrameUrl, supabaseClient) : undefined;
  const endFrame = endFrameUrl ? await fetchVeoFrameAsInline(endFrameUrl, supabaseClient) : undefined;
  const hasFrameInput = Boolean(startFrame || endFrame);

  // Veo 3.1 accepts different personGeneration values by mode:
  // text-to-video only supports allow_all, while image-to-video /
  // interpolation only supports allow_adult. The shared UI stores a
  // single default, so enforce the valid API value here.
  const personGeneration: VeoPersonGeneration = hasFrameInput
    ? "allow_adult"
    : "allow_all";

  const requestParams = {
    prompt,
    startFrame,
    endFrame,
    aspectRatio,
    resolution,
    durationSeconds,
    personGeneration,
  };

  const submitReplicateFallback = async (fallbackFrom: string): Promise<ProviderResult> => {
    console.warn(`[veo] submitting Replicate fallback after ${fallbackFrom}`);
    return await submitReplicateVeoTask({
      prompt,
      negativePrompt: String(params.negative_prompt ?? "").trim() || undefined,
      startFrameUrl,
      endFrameUrl,
      aspectRatio,
      resolution,
      durationSeconds,
      modelSlug,
      providerModelId: entry.model,
      generateAudio: shouldGenerateFallbackVeoAudio(params),
      fallbackFrom,
    });
  };

  const body = buildVeoRequest(requestParams);

  console.log(
    `[veo] submit model=${entry.model} duration=${durationSeconds}s ` +
      `resolution=${resolution} aspect=${aspectRatio} ` +
      `i2v=${hasFrameInput} endFrame=${!!endFrameUrl} personGeneration=${personGeneration}`,
  );

  let operationName: string;
  let veoApiKeyAlias: VeoApiKeyAlias =
    String(params.veo_api_key_alias ?? params.api_key_alias ?? "") === "gemini2"
      ? "gemini2"
      : "primary";
  try {
    const apiKey = loadVeoApiKey(veoApiKeyAlias);
    operationName = await submitVeoTask(entry.model, body, apiKey);
  } catch (err) {
    const firstMessage = err instanceof Error ? err.message : String(err);
    let recoveredFromSubmitError = false;
    if (veoApiKeyAlias !== "gemini2" && shouldFallbackVeoQuota(firstMessage) && canUseGemini2Veo()) {
      console.warn("[veo] primary Google quota exhausted; retrying with GEMINI2_API_KEY");
      try {
        veoApiKeyAlias = "gemini2";
        operationName = await submitVeoTask(entry.model, body, loadVeoApiKey(veoApiKeyAlias));
        recoveredFromSubmitError = true;
      } catch (gemini2Err) {
        const gemini2Message = gemini2Err instanceof Error ? gemini2Err.message : String(gemini2Err);
        if (canUseReplicateVeo()) {
          return await submitReplicateFallback(`primary_quota_then_gemini2_failed: ${gemini2Message.slice(0, 160)}`);
        }
        throw gemini2Err;
      }
    }
    if (!recoveredFromSubmitError && shouldFallbackVeoQuota(firstMessage) && canUseReplicateVeo()) {
      return await submitReplicateFallback(`primary_quota: ${firstMessage.slice(0, 160)}`);
    }
    if (!recoveredFromSubmitError && (startFrame || endFrame) && firstMessage.includes("`bytesBase64Encoded` isn't supported")) {
      console.warn("[veo] bytesBase64Encoded rejected; retrying inlineData payload");
      try {
        const apiKey = loadVeoApiKey(veoApiKeyAlias);
        operationName = await submitVeoTask(
          entry.model,
          buildVeoRequest(requestParams, "inlineData"),
          apiKey,
        );
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(
          "Veo image input was rejected by Gemini API. " +
            "Try text-to-video without a start/end image while Veo image access is checked. " +
            retryMessage,
        );
      }
    } else if (!recoveredFromSubmitError) {
      throw err;
    }
  }

  return {
    task_id: operationName,
    outputs: {
      output_video: "",
      output_start_frame: startFrameUrl ?? "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      provider: "veo",
      model: modelSlug,
      provider_model_id: entry.model,
      api_key_alias: veoApiKeyAlias,
      tier: entry.tier,
      duration_seconds: durationSeconds,
      resolution,
      aspect_ratio: aspectRatio,
      has_audio: true, // Veo 3.1 always generates audio
      is_image2video: !!startFrameUrl,
      // The frontend uses `poll_endpoint` to drive the per-poll URL.
      // Veo polls against the operation name (returned in task_id)
      // appended to the v1beta base — host-whitelist check in the
      // poll handler matches generativelanguage.googleapis.com.
      poll_endpoint: VEO_BASE,
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
  } else if (typeof sizeRaw === "string" && sizeRaw.toLowerCase() === "2k") {
    size = "2048x2048";
  } else if (typeof sizeRaw === "string" && sizeRaw.toLowerCase() === "3k") {
    size = "3072x3072";
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

  // Image-to-image / image-edit references — BytePlus ModelArk
  // Seedream 4.5 + 5.0 take an `image_urls` ARRAY (max 14). The
  // canvas writes wired ref-image edges into `ref_image` (single
  // URL when one connection, array when many). Standalone tool
  // calls historically used `image_url` (singular). Mention path
  // hands us `mention_image_urls`. Accept all three and normalise
  // to an array, capped at the API's 14-image limit.
  //
  // Until 2026-04 this executor was sending `{ image: <url> }`
  // (singular) — the 4.5 / 5.0 endpoint silently dropped that
  // field, so wired refs had no effect. Switching to `image_urls`
  // matches the published BytePlus spec.
  const collectRefUrls = (): string[] => {
    const acc: string[] = [];
    const push = (v: unknown) => {
      if (typeof v === "string" && v.length > 0) acc.push(v);
    };
    const refRaw = params.ref_image;
    if (Array.isArray(refRaw)) refRaw.forEach(push);
    else push(refRaw);
    push(params.image_url);
    push(params.image);
    if (Array.isArray(params.mention_image_urls)) {
      (params.mention_image_urls as unknown[]).forEach(push);
    }
    // Dedupe while preserving order — BytePlus indexes references
    // semantically ("Image 1", "Image 2" in the prompt), so the
    // order matters and we can't union into an unordered set.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of acc) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out.slice(0, 14);
  };
  const refUrls = collectRefUrls();

  const negativePrompt =
    typeof params.negative_prompt === "string" ? params.negative_prompt : undefined;

  console.log(
    `[seedream] generate model=${entry.model} size=${size} seed=${seed ?? "auto"} ` +
      `refs=${refUrls.length}`,
  );

  const items = await generateSeedreamImage(
    {
      model: entry.model,
      prompt,
      size,
      response_format: "url",
      n: 1,
      ...(seed !== undefined ? { seed } : {}),
      ...(refUrls.length > 0 ? { image_urls: refUrls } : {}),
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
      reference_image_count: refUrls.length,
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
  // Output format selection isn't documented as a flag on the BytePlus
  // path — Hyper3D Gen2 returns a single GLB regardless. Keep the
  // `format` knob in metadata only so the UI's selector is still
  // honoured downstream (e.g. file extension hints) without us
  // forwarding an undocumented `--format` flag that the model would
  // either ignore or reject.
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

  // buildHyper3dContent returns { content, seed? } — spread both
  // into the wire body so `seed` lands at the top level (per the
  // BytePlus curl example), not inside the prompt as a flag.
  const built = buildHyper3dContent({
    imageUrl,
    prompt,
    texture,
    seed,
  });

  console.log(
    `[hyper3d] submit model=${entry.model} texture=${texture} seed=${seed ?? "auto"}`,
  );

  const taskId = await submitHyper3dTask(
    { model: entry.model, ...built },
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

type GeminiImageApiKeyAlias = "primary" | "gemini2";

function loadGeminiImageApiKey(alias: GeminiImageApiKeyAlias = "primary"): string {
  if (alias === "gemini2") {
    const key = Deno.env.get("GEMINI2_API_KEY");
    if (!key) {
      throw new Error("Gemini image: GEMINI2_API_KEY is not configured in Supabase project secrets.");
    }
    return key;
  }
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    throw new Error("Gemini image: GOOGLE_AI_STUDIO_KEY (or GEMINI_API_KEY) is not configured in Supabase project secrets.");
  }
  return key;
}

/** Whether a secondary Gemini API key is configured. Used by executors
 *  to decide whether to attempt a fallback retry after the primary
 *  key fails — same pattern as the Veo executor. */
function hasGeminiImageFallbackKey(): boolean {
  return Boolean(Deno.env.get("GEMINI2_API_KEY"));
}

function extractProviderMediaUrl(value: unknown): string {
  if (typeof value === "string") {
    return /^https:\/\//i.test(value) ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractProviderMediaUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    for (const key of ["url", "image", "image_url", "output", "download_url"]) {
      const found = extractProviderMediaUrl(row[key]);
      if (found) return found;
    }
    for (const nested of Object.values(row)) {
      const found = extractProviderMediaUrl(nested);
      if (found) return found;
    }
  }
  return "";
}

async function executeBanana(
  params: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  // Banana must stay on the primary Gemini image key. Do not silently route
  // to secondary keys or wrapper providers; this keeps failures attributable
  // to one provider path and prevents hidden cost drift.
  loadGeminiImageApiKey("primary");

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
  let resolvedReferenceCount = 0;
  let failedReferenceCount = 0;
  let totalReferenceBytes = 0;
  const referenceByteSummaries: string[] = [];
  const hasReferenceImages = imageUrls.length > 0;
  if (hasReferenceImages) {
    for (const url of imageUrls) {
      try {
        const bytes = await fetchImageBuffer(url);
        totalReferenceBytes += bytes.byteLength;
        const base64 = bytesToBase64(bytes);
        // Detect mime from first bytes
        let mime = "image/png";
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = "image/jpeg";
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = "image/webp";
        referenceByteSummaries.push(`${mime}:${Math.round(bytes.byteLength / 1024)}KB`);
        parts.push({ inlineData: { mimeType: mime, data: base64 } });
        resolvedReferenceCount += 1;
      } catch (imgErr) {
        failedReferenceCount += 1;
        console.warn(`[banana-direct] Failed to resolve image: ${imgErr}`);
      }
    }
    console.log(
      `[banana-direct] Added ${resolvedReferenceCount}/${imageUrls.length} reference images` +
        ` (${Math.round(totalReferenceBytes / 1024)}KB raw: ${referenceByteSummaries.join(", ")})` +
        (failedReferenceCount > 0 ? ` (${failedReferenceCount} failed to load)` : ""),
    );
    if (resolvedReferenceCount === 0) {
      throw new Error(
        `Reference images could not be loaded for this attempt (${failedReferenceCount}/${imageUrls.length} failed). ` +
          "The background worker will retry automatically.",
      );
    }
  }

  console.log(
    `[banana-direct] Requesting ${modelId} (${modelConfig.gemini_model}), ` +
      `ref_images: ${resolvedReferenceCount}/${imageUrls.length}`,
  );

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
      // Flex is cheaper but can sit in Google's queue longer than an Edge
      // invocation can stay alive. Reference-image jobs are especially prone
      // to short abort loops because each retry re-submits a fresh request,
      // so keep those on Standard for user-facing workspace generation.
      useFlex = !hasReferenceImages;
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

  /* ── Hard client-side timeout ─────────────────────────────
   * Supabase edge functions die with WORKER_RESOURCE_LIMIT once
   * total CPU time crosses ~150s (default tier). Gemini Pro Image
   * with Flex queueing or many ref images can blow past that, so
   * we abort the fetch at ~120s — leaving enough headroom for the
   * upload + JSON-parse work below to finish before the platform
   * pulls the plug. The caller gets a friendly error instead of a
   * generic platform 500. */
  // Keep this just under Supabase Edge's ~150s request idle timeout. Google
  // image models can spend more than two minutes in prefill; the previous 115s
  // server hint caused Gemini to return DEADLINE_EXCEEDED before it had a fair
  // chance to finish.
  const ABORT_MS = 148_000;
  const modelLabel = modelId === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2";

  async function callGeminiImage(apiKeyAlias: GeminiImageApiKeyAlias): Promise<Response> {
    const apiKey = loadGeminiImageApiKey(apiKeyAlias);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.gemini_model}:generateContent?key=${apiKey}`;
    console.log(`[banana-direct] Calling model: ${modelConfig.gemini_model} key=${apiKeyAlias}`);
    const aborter = new AbortController();
    const abortTimer = setTimeout(() => aborter.abort(), ABORT_MS);
    try {
      return await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Ask Gemini to return before the Edge gateway idle timeout.
          "X-Server-Timeout": "145",
        },
        body: geminiRequestBody,
        signal: aborter.signal,
      });
    } catch (fetchErr) {
      if ((fetchErr as { name?: string })?.name === "AbortError") {
        console.error(`[banana-direct] Gemini fetch aborted after ${ABORT_MS}ms key=${apiKeyAlias}`);
        const refSummary =
          imageUrls.length > 0
            ? `refs loaded ${resolvedReferenceCount}/${imageUrls.length}`
            : "no refs";
        return new Response(
          `${modelLabel} timed out after ${Math.round(ABORT_MS / 1000)}s on this attempt (${refSummary}). ` +
            "This is provider latency/queue timeout, not a reference-image format error; the queue will retry with a longer Banana backoff to protect Gemini quota.",
          { status: 504 },
        );
      }
      throw fetchErr;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  let apiKeyAlias: GeminiImageApiKeyAlias = "primary";
  let aiResponse = await callGeminiImage(apiKeyAlias);

  if (!aiResponse.ok) {
    let statusCode = aiResponse.status;
    let errorText = await aiResponse.text();
    console.error(`[banana-direct] Gemini API error key=${apiKeyAlias}: ${statusCode}`, errorText.substring(0, 500));

    // Fallback to GEMINI2_API_KEY once when the primary key fails AND a
    // secondary key is configured. Mirrors the Veo executor pattern. The
    // common case we're solving is Google's "ghost 429" / Tier-1 lockout
    // bug where one paid project's key is throttled while another paid
    // project's key still has headroom. We retry on:
    //   - any 5xx (provider hiccup)
    //   - 429 (rate limit / ghost-429)
    //   - 401/403 (key-side auth issue, separate project might work)
    // We DO NOT retry on 4xx/safety errors that look prompt-related —
    // those would just fail again on the second key.
    const shouldFallback =
      hasGeminiImageFallbackKey() &&
      (statusCode === 429 ||
        statusCode === 401 ||
        statusCode === 403 ||
        statusCode >= 500);

    if (shouldFallback) {
      console.warn(`[banana-direct] retrying with gemini2 key after HTTP ${statusCode}`);
      apiKeyAlias = "gemini2";
      aiResponse = await callGeminiImage(apiKeyAlias);
      if (!aiResponse.ok) {
        statusCode = aiResponse.status;
        errorText = await aiResponse.text();
        console.error(`[banana-direct] Gemini API error key=${apiKeyAlias}: ${statusCode}`, errorText.substring(0, 500));
      }
    }

    if (!aiResponse.ok) {
      if (isProviderBillingLike(statusCode, errorText)) {
        throw new Error("PROVIDER_BILLING_ERROR");
      }
      // Google's Pro image model occasionally returns 504
      // DEADLINE_EXCEEDED when its render queue can't finish within
      // the X-Server-Timeout we send (145s — just under the
      // Supabase Edge gateway's idle limit). Both keys hit it when
      // Google's backend itself is slow that minute. Surface a
      // clearer message to the user so they understand the queue
      // retries are bounded by Google's latency, not our code, and
      // they can proactively switch to nano-banana-2 (Flash) for a
      // faster result.
      const isDeadlineExceeded =
        statusCode === 504 || /DEADLINE_EXCEEDED/i.test(errorText);
      if (isDeadlineExceeded) {
        throw new Error(
          `${modelLabel} timed out on Google's side (HTTP 504 DEADLINE_EXCEEDED, key=${apiKeyAlias}). ` +
            "Pro image rendering is heavy; this usually clears within a few minutes when Google's queue catches up. " +
            "If it keeps failing, try a shorter prompt, fewer reference images, or Nano Banana 2 (Flash) for a quicker render.",
        );
      }
      const providerDetail = summarizeProviderErrorBody(errorText);
      throw new Error(
        `${modelLabel} failed (HTTP ${statusCode}, key=${apiKeyAlias}): ` +
          (providerDetail || "Provider returned no error body."),
      );
    }
  }

  const aiResult = await aiResponse.json();
  const firstCandidate = Array.isArray(aiResult.candidates) ? aiResult.candidates[0] : null;
  const responseParts = firstCandidate?.content?.parts || [];

  // Extract image from response
  let imageBase64: string | null = null;
  let imageMime = "image/png";
  const textParts: string[] = [];

  for (const part of responseParts) {
    const inlineData = part.inlineData ?? part.inline_data;
    if (inlineData?.data) {
      imageBase64 = inlineData.data;
      imageMime = inlineData.mimeType ?? inlineData.mime_type ?? "image/png";
    }
    if (typeof part.text === "string" && part.text.trim()) {
      textParts.push(part.text.trim());
    }
  }

  if (!imageBase64) {
    const finishReason = String(firstCandidate?.finishReason ?? firstCandidate?.finish_reason ?? "").toUpperCase();
    const finishMessage = String(firstCandidate?.finishMessage ?? firstCandidate?.finish_message ?? "");
    const promptBlockReason = String(aiResult.promptFeedback?.blockReason ?? aiResult.prompt_feedback?.block_reason ?? "");
    const providerText = textParts.join(" ").slice(0, 220);
    const safetyHint = `${finishReason} ${finishMessage} ${promptBlockReason} ${providerText}`;
    console.warn(
      `[banana-direct] Gemini returned no image. finish=${finishReason || "empty"} ` +
        `block=${promptBlockReason || "none"} text=${providerText || "none"} ` +
        `parts=${responseParts.length}`,
    );
    if (/SAFETY|BLOCK|PROHIBITED|RECITATION|SPII/i.test(safetyHint)) {
      throw new Error(
        `${modelLabel} blocked this prompt by content policy. Please adjust the prompt or references.`,
      );
    }
    throw new Error(
      `${modelLabel} provider returned an empty image response on this attempt. ` +
        "This can happen during provider pressure; the background worker will retry automatically.",
    );
  }

  // Upload to storage
  const ext = imageMime.split("/")[1] || "png";
  const fileName = `pipeline/mediaforge_${Date.now()}.${ext}`;
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
    provider_meta: {
      model: modelId,
      api_key_alias: apiKeyAlias,
      reference_image_count: resolvedReferenceCount,
      reference_image_requested_count: imageUrls.length,
      reference_image_failed_count: failedReferenceCount,
    },
  };
}

async function executeChatAi(params: Record<string, unknown>): Promise<ProviderResult> {
  const requestedModel = String(params.model_name ?? "google/gemini-3-pro-preview");
  const model = requestedModel.startsWith("gemini-")
    ? `google/${requestedModel}`
    : requestedModel;
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
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
    if (!GOOGLE_KEY) throw new Error("GEMINI_API_KEY (or GOOGLE_AI_STUDIO_KEY) is not configured");
    const geminiModelMap: Record<string, string> = {
      "google/gemini-3-pro-preview": "gemini-3-pro-preview",
      // Legacy alias from the initial Workspace pricing sheet.
      "google/gemini-3.1-pro-preview": "gemini-3-pro-preview",
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
      if (isProviderBillingLike(res.status, errText)) throw new Error("PROVIDER_BILLING_ERROR");
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
      if (isProviderBillingLike(res.status, errText)) throw new Error("PROVIDER_BILLING_ERROR");
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

const TRIPO3D_MULTIVIEW_MODEL_KEYS = new Set([
  "tripo3d-v3.1",
  "tripo3d-v3.0",
  "tripo3d-v2.5",
  "tripo3d-v2.0",
]);

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

  const modelKey = String(params.model_name ?? "tripo3d-v3.1");
  const modelVersion = TRIPO3D_MODEL_VERSIONS[modelKey] ?? TRIPO3D_MODEL_VERSIONS["tripo3d-v3.1"];
  const supportsMultiview = TRIPO3D_MULTIVIEW_MODEL_KEYS.has(modelKey);
  const imageUrls = collectTripoImageUrls(params).slice(0, supportsMultiview ? 4 : 1);
  const imageUrl = imageUrls[0];
  if (!imageUrl) {
    throw new Error("Image to 3D needs an image input — wire an asset / generation into the `image` port.");
  }

  const texture = String(params.texture ?? "true") === "true";
  const pbr = String(params.pbr ?? "true") === "true";
  const autoSize = String(params.auto_size ?? "true") === "true";

  const taskType = supportsMultiview && imageUrls.length >= 2
    ? "multiview_to_model"
    : "image_to_model";
  const submitBody: Record<string, unknown> =
    taskType === "multiview_to_model"
      ? {
          type: taskType,
          files: imageUrls.map((url) => ({ type: "url", url })),
          model_version: modelVersion,
          texture,
          pbr,
          auto_size: autoSize,
        }
      : {
          type: taskType,
          file: { type: "url", url: imageUrl },
          model_version: modelVersion,
          texture,
          pbr,
          auto_size: autoSize,
        };

  console.log(
    `[tripo3d] Submitting ${taskType} task (model=${modelVersion}, ` +
      `images=${imageUrls.length}, texture=${texture}, pbr=${pbr})`,
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
    if (isProviderBillingLike(submitRes.status, errText)) {
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
      task_type: taskType,
      input_image_count: imageUrls.length,
      poll_endpoint: TRIPO3D_POLL_ENDPOINT,
      task_id: taskId,
    },
  };
}

function collectTripoImageUrls(params: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      urls.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(push);
    }
  };

  push(params.image_urls);
  push(params.ref_image);
  push(params.image_url);
  push(params.image);
  push(params.mention_image_urls);

  return Array.from(new Set(urls));
}

/**
 * executeRemoveBg — calls our remove-background edge function (Replicate BiRefNet).
 */
async function executeRemoveBg(
  params: Record<string, unknown>,
  supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
): Promise<ProviderResult> {
  const imageUrl = String(params.image_url ?? "");
  if (!imageUrl) {
    throw new Error("Remove Background requires an image input.");
  }
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Remove Background service credentials are not configured.");
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
  const apiKey =
    Deno.env.get("GOOGLE_TTS_API_KEY")?.trim() ||
    Deno.env.get("GOOGLE_CLOUD_TTS_API_KEY")?.trim() ||
    Deno.env.get("GOOGLE_API_KEY")?.trim();
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

  const speakingRate = clampNum(params.speaking_rate ?? params.speakingRate, 0.25, 2.0, 1.0);
  const pitch = clampNum(params.pitch, -20.0, 20.0, 0);
  const volumeGainDb = clampNum(params.volume_gain_db ?? params.volumeGainDb, -96.0, 16.0, 0);

  // Optional style hint → SSML <prosody>. Conservative mapping —
  // recognise a handful of keywords ("calm", "fast", "slow", "warm").
  //
  // HOWEVER: Google's Studio voices REJECT every SSML tag (including
  // <prosody>) with `400 INVALID_ARGUMENT: SSML markup is not
  // supported for Studio voices`. The voice catalog the workspace
  // ships is Studio-only, so wrapping the text in <prosody> on the
  // back of a `style_prompt` was silently failing every Studio
  // request the moment the user typed any style hint.
  //
  // Fix: gate the SSML wrap on the voice tier. Studio voices fall
  // through to plain text input — the speakingRate / pitch knobs the
  // API also accepts cover the same expressive range without SSML.
  // Standard / Wavenet / Neural2 voices keep the SSML path so the
  // style hint still has an effect there.
  const styleHint = String(params.style_prompt ?? "").trim().toLowerCase();
  const isStudioVoice = /-Studio-/i.test(voiceId);
  let inputBody: { text?: string; ssml?: string };
  if (styleHint && !isStudioVoice) {
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
    // Studio voices OR no style hint → plain text. Studio voices
    // also tend to ignore `pitch`, but accepting it as 0 doesn't
    // 400 so we leave the request shape consistent. The speaking
    // rate is honoured.
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
          speakingRate,
          pitch,
          ...(volumeGainDb !== 0 ? { volumeGainDb } : {}),
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

  const fileName = `${userId}/tts/mediaforge_${Date.now()}_${voiceId}.mp3`;
  const { error: uploadErr } = await supabaseClient.storage
    .from("user_assets")
    .upload(fileName, bytes, { contentType: "audio/mpeg", upsert: true });
  if (uploadErr) {
    console.error("[google-tts] upload error:", uploadErr);
    throw new Error("Failed to save audio. Please try again.");
  }

  const { data: signedData, error: signErr } = await supabaseClient.storage
    .from("user_assets")
    .createSignedUrl(fileName, 60 * 60 * 24 * 365);
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
      speaking_rate: speakingRate,
      pitch,
      volume_gain_db: volumeGainDb,
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
      speaking_rate: speakingRate,
      pitch,
      volume_gain_db: volumeGainDb,
    },
  };
}

/** Coerce `params[key]` to a number clamped to [min,max]; falls back
 *  to `def` for anything that isn't a finite number in range. Used by
 *  the ElevenLabs executor to keep slider knobs within the API's
 *  documented bounds (e.g. stability 0–1, speed 0.7–1.2). */
function clampNum(
  raw: unknown,
  min: number,
  max: number,
  def: number,
): number {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Resolve a default ElevenLabs voice id when the request didn't
 *  specify one. We prefer the user's actual account voices via
 *  GET /v1/voices, falling back to the canonical "Rachel" preset
 *  (21m00Tcm4TlvDq8ikWAM) — that voice ships with every ElevenLabs
 *  account so it's safe as a last resort. */
async function pickDefaultElevenLabsVoice(apiKey: string): Promise<string> {
  const FALLBACK = "21m00Tcm4TlvDq8ikWAM"; // Rachel
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: { "xi-api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) return FALLBACK;
    const json = (await res.json()) as {
      voices?: Array<{ voice_id?: string; category?: string }>;
    };
    const voices = json.voices ?? [];
    // Prefer non-cloned (premade / professional) voices for the
    // default — those are guaranteed to have audio samples.
    const premade = voices.find((v) => v.category !== "cloned" && v.voice_id);
    return premade?.voice_id ?? voices[0]?.voice_id ?? FALLBACK;
  } catch (_err) {
    return FALLBACK;
  }
}

function getElevenLabsApiKey(): string | undefined {
  for (const name of ["ELEVEN_API_KEY", "ELEVENLABS_API_KEY"]) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * executeElevenLabsTts — ElevenLabs Text-to-Speech.
 *
 * Mirrors executeGoogleTts: synth → upload MP3 → register the row
 * in user_assets → return signed URL. Differs from Google TTS in
 * three ways:
 *
 *  • Auth — ElevenLabs uses an `xi-api-key` header, not a query
 *    param. The key can be stored as `ELEVEN_API_KEY` or
 *    `ELEVENLABS_API_KEY` in Supabase project secrets.
 *  • Voice ids — opaque 20-char tokens (e.g. `21m00Tcm4TlvDq8ikWAM`)
 *    rather than language-coded strings, so we don't try to infer
 *    a `languageCode` field from them.
 *  • Models — the ElevenLabs API distinguishes "model" (acoustic
 *    weights, like `eleven_turbo_v2_5`) from "voice" (the speaker).
 *    Our `model_name` param chooses the underlying acoustic model;
 *    `voice` picks the speaker.
 *
 * Style prompts aren't supported by ElevenLabs the same way Google's
 * SSML <prosody> works — instead, ElevenLabs offers per-request
 * `voice_settings` (stability / similarity_boost / style /
 * use_speaker_boost). We map a couple of common style hints onto
 * those numeric knobs so the UX feels parallel to the other
 * providers without exposing 4 sliders.
 */
async function executeElevenLabsTts(
  params: Record<string, unknown>,
  supabaseClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<ProviderResult> {
  // Accept either env var name and trim pasted secret values.
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) {
    throw new Error(
      "ElevenLabs not configured — set ELEVEN_API_KEY or ELEVENLABS_API_KEY in Supabase project secrets.",
    );
  }

  const text = String(params.prompt ?? params.text ?? "").trim();
  if (!text) throw new Error("Audio Generation requires a script (prompt).");
  if (text.length > 5000) {
    throw new Error("Script too long — max 5,000 characters per audio gen.");
  }

  // Voice id resolution. The canvas audio node no longer surfaces a
  // picker (the hardcoded preset list was removed), and the
  // standalone tool only fills `voice` when the user clicks one of
  // the live /v1/voices tiles. So an empty voice is normal — fall
  // back to the first account voice via /v1/voices, or to the
  // canonical default ElevenLabs preset id (21m00Tcm4TlvDq8ikWAM,
  // "Rachel") if the listing call also fails.
  let voiceId = String(params.voice ?? "").trim();
  if (!voiceId) {
    voiceId = await pickDefaultElevenLabsVoice(apiKey);
  } else if (!/^[A-Za-z0-9_-]{8,}$/.test(voiceId)) {
    throw new Error(
      "Validation: ElevenLabs `voice` id must be an opaque token (e.g. 21m00Tcm4TlvDq8ikWAM).",
    );
  }

  // Map our model slug to ElevenLabs model_id. Anything starting with
  // `elevenlabs-` is an in-house alias; we accept the API names too
  // (e.g. `eleven_multilingual_v2`) for flexibility.
  const requestedModel = String(params.model_name ?? params.model ?? "elevenlabs-multilingual-v2");
  const ELEVEN_MODEL_MAP: Record<string, string> = {
    "elevenlabs-multilingual-v2": "eleven_multilingual_v2",
    "elevenlabs-turbo-v2-5":      "eleven_turbo_v2_5",
  };
  const elevenModelId = ELEVEN_MODEL_MAP[requestedModel] ?? requestedModel;

  // ── Per-call ElevenLabs voice_settings ─────────────────────────
  // The frontend exposes 4 sliders that map 1:1 onto the ElevenLabs
  // voice_settings keys. We accept either explicit numeric params
  // (`stability`, `similarity_boost`, `style`, `use_speaker_boost`)
  // OR a free-form `voice_style` enum from the picker — which we
  // map onto the official three style presets ElevenLabs documents:
  //   "expressive" → high style + low stability
  //   "neutral"    → balanced (the API defaults)
  //   "consistent" → low style + high stability
  // Numeric knobs always win when both forms are present.
  const stylePreset = String(params.voice_style ?? "neutral").toLowerCase();
  const presetDefaults =
    stylePreset === "expressive"
      ? { stability: 0.30, similarity_boost: 0.75, style: 0.65, use_speaker_boost: true }
      : stylePreset === "consistent"
        ? { stability: 0.85, similarity_boost: 0.85, style: 0.10, use_speaker_boost: true }
        : { stability: 0.55, similarity_boost: 0.75, style: 0.30, use_speaker_boost: true };

  const stability = clampNum(params.stability, 0, 1, presetDefaults.stability);
  const similarityBoost = clampNum(
    params.similarity_boost ?? params.similarity,
    0,
    1,
    presetDefaults.similarity_boost,
  );
  const style = clampNum(params.style, 0, 1, presetDefaults.style);
  const useSpeakerBoost =
    params.use_speaker_boost === undefined
      ? presetDefaults.use_speaker_boost
      : params.use_speaker_boost === true || params.use_speaker_boost === "true";

  // `speed` lives with the rest of the request-level `voice_settings`
  // in ElevenLabs' TTS API. Valid range in our UI: 0.7–1.2.
  const speed = clampNum(params.speed, 0.7, 1.2, 1.0);
  const styleHint = String(params.style_prompt ?? "").trim();

  console.log(
    `[elevenlabs-tts] voice=${voiceId} model=${elevenModelId} stab=${stability} sim=${similarityBoost} style=${style} speed=${speed} chars=${text.length}`,
  );

  const requestBody: Record<string, unknown> = {
    text,
    model_id: elevenModelId,
    voice_settings: {
      stability,
      similarity_boost: similarityBoost,
      style,
      use_speaker_boost: useSpeakerBoost,
      ...(speed !== 1.0 ? { speed } : {}),
    },
  };

  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!ttsRes.ok) {
    const errText = await ttsRes.text();
    console.error(`[elevenlabs-tts] HTTP ${ttsRes.status} body=${errText.slice(0, 500)}`);
    if (ttsRes.status === 400) {
      throw new Error(`Validation: ElevenLabs rejected the request — ${errText.slice(0, 200)}`);
    }
    if (ttsRes.status === 401 || ttsRes.status === 403) {
      throw new Error(`ElevenLabs authentication failed — check ELEVEN_API_KEY or ELEVENLABS_API_KEY (HTTP ${ttsRes.status}).`);
    }
    if (ttsRes.status === 402) {
      throw new Error(`ElevenLabs account has insufficient provider credits/quota. Top up ElevenLabs billing or switch voice provider. (${errText.slice(0, 200)})`);
    }
    if (ttsRes.status === 422) {
      throw new Error(`Validation: ElevenLabs voice or model invalid — ${errText.slice(0, 200)}`);
    }
    if (ttsRes.status === 429) {
      throw new Error(`ElevenLabs rate-limited — slow down and retry. (${errText.slice(0, 200)})`);
    }
    throw new Error(`ElevenLabs TTS failed (HTTP ${ttsRes.status})`);
  }

  const buf = await ttsRes.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength === 0) {
    throw new Error("ElevenLabs returned no audio content.");
  }

  const fileName = `${userId}/tts/mediaforge_${Date.now()}_eleven_${voiceId.slice(0, 8)}.mp3`;
  const { error: uploadErr } = await supabaseClient.storage
    .from("user_assets")
    .upload(fileName, bytes, { contentType: "audio/mpeg", upsert: true });
  if (uploadErr) {
    console.error("[elevenlabs-tts] upload error:", uploadErr);
    throw new Error("Failed to save audio. Please try again.");
  }

  const { data: signedData, error: signErr } = await supabaseClient.storage
    .from("user_assets")
    .createSignedUrl(fileName, 60 * 60 * 24 * 365);
  if (signErr || !signedData?.signedUrl) {
    console.error("[elevenlabs-tts] signed URL error:", signErr);
    throw new Error("Failed to save audio. Please try again.");
  }

  const audioUrl = signedData.signedUrl;

  await supabaseClient.from("user_assets").insert({
    user_id: userId,
    name: `TTS (ElevenLabs): ${text.slice(0, 40)}${text.length > 40 ? "..." : ""}`,
    file_url: audioUrl,
    file_type: "audio",
    source: "ai_generated",
    metadata: {
      voice: voiceId,
      provider: "elevenlabs_tts",
      model: elevenModelId,
      text_length: text.length,
      style_prompt: styleHint || null,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        style,
        speed,
        use_speaker_boost: useSpeakerBoost,
      },
    },
  });

  return {
    result_url: audioUrl,
    outputs: { audio_url: audioUrl },
    output_type: "audio_url" as const,
    provider_meta: {
      provider: "elevenlabs_tts",
      voice: voiceId,
      model: elevenModelId,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
        style,
        speed,
        use_speaker_boost: useSpeakerBoost,
      },
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
const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GEMINI_TTS_VOICE = "Kore";
const GEMINI_TTS_MODELS = new Set([
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
]);
const GEMINI_TTS_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-preview-flash-tts": "gemini-3.1-flash-tts-preview",
  "gemini-3.1-flash-preview-tts": "gemini-3.1-flash-tts-preview",
  "gemini-3-flash-tts-preview": "gemini-3.1-flash-tts-preview",
};
const GEMINI_TTS_VOICES = new Set([
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
]);

function getGeminiTtsApiKey(): string | undefined {
  for (const name of ["GOOGLE_AI_STUDIO_KEY", "GEMINI_API_KEY"]) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeGeminiTtsModel(raw: unknown): string {
  const value = String(raw ?? DEFAULT_GEMINI_TTS_MODEL).trim() || DEFAULT_GEMINI_TTS_MODEL;
  const mapped = GEMINI_TTS_MODEL_ALIASES[value] ?? value;
  if (!GEMINI_TTS_MODELS.has(mapped)) {
    throw new Error(`Validation: unsupported Gemini TTS model "${value}".`);
  }
  return mapped;
}

function normalizeGeminiTtsVoice(raw: unknown): string {
  const value = String(raw ?? DEFAULT_GEMINI_TTS_VOICE).trim() || DEFAULT_GEMINI_TTS_VOICE;
  if (!GEMINI_TTS_VOICES.has(value)) {
    throw new Error(`Validation: unsupported Gemini TTS voice "${value}".`);
  }
  return value;
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function pcmToWav(
  pcmData: Uint8Array,
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number,
): Uint8Array {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + dataSize);
  const view = new DataView(wav.buffer);

  wav.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + dataSize, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8);
  wav.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, dataSize, true);
  wav.set(pcmData, headerSize);

  return wav;
}

function buildGeminiTtsPrompt(text: string, stylePrompt: string): string {
  if (!stylePrompt) return text;
  return [
    "Voice direction:",
    stylePrompt,
    "",
    "Read only the transcript below. Do not say these instructions.",
    "",
    "Transcript:",
    text,
  ].join("\n");
}

function extractGeminiTtsAudio(result: Record<string, unknown>): string | null {
  const candidates = result.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as { parts?: Array<Record<string, unknown>> } | undefined;
  for (const part of content?.parts ?? []) {
    const inlineData = part.inlineData as { data?: unknown } | undefined;
    if (typeof inlineData?.data === "string" && inlineData.data.length > 0) {
      return inlineData.data;
    }
  }
  return null;
}

async function executeGeminiTts(
  params: Record<string, unknown>,
  supabaseClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<ProviderResult> {
  const apiKey = getGeminiTtsApiKey();
  if (!apiKey) {
    throw new Error("Gemini TTS not configured - set GEMINI_API_KEY or GOOGLE_AI_STUDIO_KEY in Supabase project secrets.");
  }

  const text = String(params.prompt ?? params.text ?? "").trim();
  if (!text) throw new Error("Audio Generation requires a script (prompt).");
  if (text.length > 5000) {
    throw new Error("Script too long - max 5,000 characters per audio gen.");
  }

  const voice = normalizeGeminiTtsVoice(params.voice);
  const model = normalizeGeminiTtsModel(params.model_name ?? params.model);
  const stylePrompt = String(params.style_prompt ?? "").trim();
  const spokenPrompt = buildGeminiTtsPrompt(text, stylePrompt);
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let audioBase64: string | null = null;
  let lastError = "Gemini returned no audio data.";
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchWithAttemptTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: spokenPrompt }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
          },
        }),
      },
      120_000,
      "Gemini TTS",
    );

    const bodyText = await res.text();
    if (!res.ok) {
      lastError = `Gemini TTS HTTP ${res.status}: ${bodyText.slice(0, 500)}`;
      console.error(`[gemini-tts] attempt=${attempt} ${lastError}`);
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(res.status === 400 ? `Validation: ${bodyText.slice(0, 300)}` : "Gemini TTS failed. Please try again.");
    }

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(bodyText) as Record<string, unknown>;
    } catch (_err) {
      lastError = "Gemini TTS returned invalid JSON.";
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(lastError);
    }

    audioBase64 = extractGeminiTtsAudio(result);
    if (audioBase64) break;

    const finishReason =
      (result.candidates as Array<{ finishReason?: string }> | undefined)?.[0]?.finishReason ?? "unknown";
    lastError = `Gemini TTS returned no audio data (finishReason=${finishReason}).`;
    console.warn(`[gemini-tts] attempt=${attempt} ${lastError} body=${bodyText.slice(0, 500)}`);
    if (attempt < maxAttempts) {
      await sleep(1000 * attempt);
    }
  }

  if (!audioBase64) {
    throw new Error(`${lastError} Retried ${maxAttempts} times.`);
  }

  const wavData = pcmToWav(base64ToBytes(audioBase64), 24000, 1, 16);
  const fileName = `${userId}/tts/mediaforge_${Date.now()}_gemini_${model.replace(/[^a-z0-9_-]/gi, "_")}.wav`;
  const { error: uploadErr } = await supabaseClient.storage
    .from("user_assets")
    .upload(fileName, wavData, { contentType: "audio/wav", upsert: true });
  if (uploadErr) {
    console.error("[gemini-tts] upload error:", uploadErr);
    throw new Error("Failed to save audio. Please try again.");
  }

  const { data: signedData, error: signErr } = await supabaseClient.storage
    .from("user_assets")
    .createSignedUrl(fileName, 60 * 60 * 24 * 365);
  if (signErr || !signedData?.signedUrl) {
    console.error("[gemini-tts] signed URL error:", signErr);
    throw new Error("Failed to save audio. Please try again.");
  }

  const audioUrl = signedData.signedUrl;
  await supabaseClient.from("user_assets").insert({
    user_id: userId,
    name: `TTS (Gemini): ${text.slice(0, 40)}${text.length > 40 ? "..." : ""}`,
    file_url: audioUrl,
    file_type: "audio",
    source: "ai_generated",
    metadata: {
      voice,
      provider: "gemini_tts",
      model,
      text_length: text.length,
      style_prompt: stylePrompt || null,
    },
  });

  return {
    result_url: audioUrl,
    outputs: { audio_url: audioUrl },
    output_type: "audio_url" as const,
    provider_meta: {
      provider: "gemini_tts",
      voice,
      model,
      style_prompt: stylePrompt || null,
    },
  };
}

function extractReplicateOutputUrl(value: unknown): string {
  if (typeof value === "string") {
    return /^https:\/\//i.test(value) ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractReplicateOutputUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    for (const key of ["url", "video", "video_url", "output", "download_url"]) {
      const found = extractReplicateOutputUrl(row[key]);
      if (found) return found;
    }
    for (const nested of Object.values(row)) {
      const found = extractReplicateOutputUrl(nested);
      if (found) return found;
    }
  }
  return "";
}

async function submitMagnificVeoTask(args: {
  prompt: string;
  negativePrompt?: string;
  startFrameUrl?: string;
  endFrameUrl?: string;
  aspectRatio: VeoAspectRatio;
  resolution: VeoResolution;
  durationSeconds: VeoDuration;
  modelSlug: string;
  providerModelId: string;
  generateAudio: boolean;
}): Promise<ProviderResult> {
  const apiKey = loadMagnificApiKey();
  const hasImageInput = Boolean(args.startFrameUrl);
  if (args.endFrameUrl) {
    console.warn("[veo-magnific] end frame is not supported by the fallback API; submitting start frame only");
  }
  const endpoint = hasImageInput
    ? `${MAGNIFIC_BASE}/ai/image-to-video/veo-3-1`
    : `${MAGNIFIC_BASE}/ai/text-to-video/veo-3-1`;
  const endpointHost = new URL(endpoint).hostname;
  const authHeaderName = endpointHost.includes("magnific.com")
    ? "x-magnific-api-key"
    : "x-freepik-api-key";
  let imagePayload = args.startFrameUrl;
  if (hasImageInput && args.startFrameUrl) {
    try {
      imagePayload = bytesToBase64(await fetchImageBuffer(args.startFrameUrl));
      console.log(`[veo-freepik] Converted start frame to base64 (${Math.round(imagePayload.length / 1024)}KB)`);
    } catch (err) {
      console.warn("[veo-freepik] start frame base64 conversion failed, using URL:", err);
    }
  }
  const payload: Record<string, unknown> = {
    prompt: args.prompt,
    duration: args.durationSeconds,
    resolution: args.resolution,
    aspect_ratio: args.aspectRatio,
    generate_audio: args.generateAudio,
  };
  if (args.negativePrompt) payload.negative_prompt = args.negativePrompt;
  if (hasImageInput) payload.image = imagePayload;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [authHeaderName]: apiKey,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Freepik/Magnific Veo submit failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Freepik/Magnific Veo submit returned non-JSON: ${text.slice(0, 200)}`);
  }
  const data = parsed.data && typeof parsed.data === "object"
    ? (parsed.data as Record<string, unknown>)
    : parsed;
  const taskId = String(data.task_id ?? data.id ?? "").trim();
  if (!taskId) {
    throw new Error("Freepik/Magnific Veo submit succeeded but no task_id returned");
  }

  console.log(
    `[veo-magnific] submit task=${taskId} mode=${hasImageInput ? "i2v" : "t2v"} ` +
      `duration=${args.durationSeconds}s resolution=${args.resolution} aspect=${args.aspectRatio}`,
  );

  return {
    task_id: taskId,
    outputs: {
      output_video: "",
      output_start_frame: args.startFrameUrl ?? "",
      output_end_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      provider: "freepik_veo",
      source_provider: "magnific",
      fallback_for: "veo",
      model: args.modelSlug,
      provider_model_id: args.providerModelId,
      provider_endpoint: endpoint,
      tier: "standard",
      duration_seconds: args.durationSeconds,
      resolution: args.resolution,
      aspect_ratio: args.aspectRatio,
      has_audio: args.generateAudio,
      is_image2video: hasImageInput,
      unsupported_end_frame: Boolean(args.endFrameUrl),
      poll_endpoint: endpoint,
    },
  };
}


/* ═══════════════════════════════════════════════════════════
   @mention resolver — Provider-Aware
   ═══════════════════════════════════════════════════════════ */

async function submitReplicateVeoTask(args: {
  prompt: string;
  negativePrompt?: string;
  startFrameUrl?: string;
  endFrameUrl?: string;
  aspectRatio: VeoAspectRatio;
  resolution: VeoResolution;
  durationSeconds: VeoDuration;
  modelSlug: string;
  providerModelId: string;
  generateAudio: boolean;
  fallbackFrom?: string;
}): Promise<ProviderResult> {
  const apiToken = Deno.env.get("REPLICATE_API_TOKEN")?.trim();
  if (!apiToken) {
    throw new Error("Replicate Veo fallback is not configured. Set REPLICATE_API_TOKEN.");
  }

  const input: Record<string, unknown> = {
    prompt: args.prompt,
    aspect_ratio: args.aspectRatio,
    duration: args.durationSeconds,
    resolution: args.resolution,
    generate_audio: args.generateAudio,
  };
  if (args.negativePrompt) input.negative_prompt = args.negativePrompt;
  if (args.startFrameUrl) input.image = args.startFrameUrl;
  if (args.endFrameUrl) input.last_frame = args.endFrameUrl;

  const res = await fetch("https://api.replicate.com/v1/models/google/veo-3.1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Replicate Veo submit failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Replicate Veo returned invalid JSON: ${text.slice(0, 300)}`);
  }
  const predictionId = String(parsed.id ?? "").trim();
  if (!predictionId) {
    throw new Error(`Replicate Veo returned no prediction id: ${text.slice(0, 300)}`);
  }

  return {
    task_id: predictionId,
    outputs: {
      output_video: "",
      output_start_frame: args.startFrameUrl ?? "",
      output_end_frame: args.endFrameUrl ?? "",
    },
    output_type: "video_url",
    provider_meta: {
      provider: "replicate_veo",
      model: args.modelSlug,
      provider_model_id: "google/veo-3.1",
      google_provider_model_id: args.providerModelId,
      fallback_from: args.fallbackFrom ?? "google_veo",
      poll_endpoint: "https://api.replicate.com/v1/predictions",
      duration_seconds: args.durationSeconds,
      resolution: args.resolution,
      aspect_ratio: args.aspectRatio,
      has_audio: args.generateAudio,
      is_image2video: Boolean(args.startFrameUrl),
      has_end_frame: Boolean(args.endFrameUrl),
    },
  };
}

const REPLICATE_SEEDANCE_MODEL_SLUG = "replicate-seedance-2-0";
const REPLICATE_SEEDANCE_PROVIDER_MODEL_ID = "bytedance/seedance-2.0";
const REPLICATE_PREDICTIONS_ENDPOINT = "https://api.replicate.com/v1/predictions";

function collectStringUrls(params: Record<string, unknown>, keys: string[], max: number): string[] {
  const values: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  };
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) value.forEach(push);
    else push(value);
  }
  return Array.from(new Set(values)).slice(0, max);
}

function parseReplicateSeedanceDuration(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : parseInt(String(value ?? "5"), 10);
  if (parsed === -1) return -1;
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(15, Math.max(1, parsed));
}

async function executeReplicateVideo(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const modelSlug = String(params.model_name ?? params.model ?? REPLICATE_SEEDANCE_MODEL_SLUG);
  if (modelSlug !== REPLICATE_SEEDANCE_MODEL_SLUG) {
    throw new Error(`Unknown Replicate video model: ${modelSlug}`);
  }

  const apiToken = Deno.env.get("REPLICATE_API_TOKEN")?.trim();
  if (!apiToken) {
    throw new Error("Replicate video is not configured. Set REPLICATE_API_TOKEN.");
  }

  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Replicate Seedance 2.0 requires a prompt.");
  }

  const startFrameUrl = String(params.image_url ?? params.start_frame ?? "").trim();
  const endFrameUrl = String(params.image_tail_url ?? params.end_frame ?? "").trim();
  const referenceImageUrls = collectStringUrls(
    params,
    ["reference_image_urls", "reference_image_url", "reference_image", "ref_image"],
    9,
  );
  const referenceVideoUrls = collectStringUrls(
    params,
    ["reference_video_urls", "reference_video_url", "video_urls", "video_url", "ref_video"],
    3,
  );
  const referenceAudioUrls = collectStringUrls(
    params,
    ["reference_audio_urls", "reference_audio_url", "audio_urls", "audio_url", "ref_audio"],
    3,
  );

  if (endFrameUrl && !startFrameUrl) {
    throw new Error("Replicate Seedance 2.0 last_frame_image requires a start_frame image.");
  }
  if ((startFrameUrl || endFrameUrl) && (referenceImageUrls.length > 0 || referenceVideoUrls.length > 0 || referenceAudioUrls.length > 0)) {
    throw new Error("Replicate Seedance 2.0 cannot mix start/end frame mode with reference media mode.");
  }
  if (referenceAudioUrls.length > 0 && referenceImageUrls.length === 0 && referenceVideoUrls.length === 0) {
    throw new Error("Replicate Seedance 2.0 reference_audios require at least one reference_image or ref_video.");
  }

  const resolutionRaw = String(params.resolution ?? "720p").toLowerCase();
  const resolution = ["480p", "720p", "1080p"].includes(resolutionRaw) ? resolutionRaw : "720p";
  const aspectRaw = String(params.aspect_ratio ?? params.ratio ?? "16:9");
  const aspectRatio = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "9:21", "adaptive"].includes(aspectRaw)
    ? aspectRaw
    : "16:9";
  const duration = parseReplicateSeedanceDuration(params.duration);
  const generateAudioRaw = params.generate_audio ?? params.has_audio;
  const generateAudio = generateAudioRaw === undefined
    ? true
    : generateAudioRaw === true || generateAudioRaw === "true";
  const seedRaw = params.seed;
  const seed = seedRaw === null || seedRaw === undefined || String(seedRaw).trim() === ""
    ? undefined
    : parseInt(String(seedRaw), 10);

  const input: Record<string, unknown> = {
    prompt,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    generate_audio: generateAudio,
  };
  if (startFrameUrl) input.image = startFrameUrl;
  if (endFrameUrl) input.last_frame_image = endFrameUrl;
  if (referenceImageUrls.length > 0) input.reference_images = referenceImageUrls;
  if (referenceVideoUrls.length > 0) input.reference_videos = referenceVideoUrls;
  if (referenceAudioUrls.length > 0) input.reference_audios = referenceAudioUrls;
  if (typeof seed === "number" && Number.isFinite(seed)) input.seed = seed;

  console.log(
    `[replicate-seedance] submit duration=${duration}s resolution=${resolution} ` +
      `aspect=${aspectRatio} audio=${generateAudio} i2v=${!!startFrameUrl} ` +
      `irefs=${referenceImageUrls.length} vrefs=${referenceVideoUrls.length} arefs=${referenceAudioUrls.length}`,
  );

  const res = await fetch(
    `https://api.replicate.com/v1/models/${REPLICATE_SEEDANCE_PROVIDER_MODEL_ID}/predictions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Replicate Seedance 2.0 submit failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Replicate Seedance 2.0 returned invalid JSON: ${text.slice(0, 300)}`);
  }

  const predictionId = String(parsed.id ?? "").trim();
  if (!predictionId) {
    throw new Error(`Replicate Seedance 2.0 returned no prediction id: ${text.slice(0, 300)}`);
  }

  return {
    task_id: predictionId,
    outputs: {
      output_video: "",
      output_start_frame: startFrameUrl,
      output_end_frame: endFrameUrl,
      output_last_frame: "",
    },
    output_type: "video_url",
    provider_meta: {
      provider: "replicate_video",
      source_provider: "replicate",
      model: modelSlug,
      provider_model_id: REPLICATE_SEEDANCE_PROVIDER_MODEL_ID,
      poll_endpoint: REPLICATE_PREDICTIONS_ENDPOINT,
      duration_seconds: duration,
      resolution,
      aspect_ratio: aspectRatio,
      has_audio: generateAudio,
      is_image2video: Boolean(startFrameUrl),
      has_image_ref: referenceImageUrls.length > 0,
      reference_image_count: referenceImageUrls.length,
      has_video_ref: referenceVideoUrls.length > 0,
      reference_video_count: referenceVideoUrls.length,
      has_audio_ref: referenceAudioUrls.length > 0,
      reference_audio_count: referenceAudioUrls.length,
    },
  };
}

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
    } else if (
      (p === "seedance" || p === "replicate_video") &&
      (String(stepParams.model_name ?? stepParams.model ?? "").startsWith("seedance-2-0") ||
        String(stepParams.model_name ?? stepParams.model ?? "").startsWith("dreamina-seedance-2-0") ||
        String(stepParams.model_name ?? stepParams.model ?? "").startsWith("replicate-seedance-2-0"))
    ) {
      const existing = Array.isArray(stepParams.reference_image_urls)
        ? (stepParams.reference_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
        : typeof stepParams.reference_image_urls === "string"
          ? [stepParams.reference_image_urls]
          : [];
      stepParams.reference_image_urls = Array.from(new Set([...existing, ...allMentionedImageUrls])).slice(0, 9);
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

      const handleDef = normalizeHandleForModel(
        stepDef.provider,
        edge.target_handle,
        String(stepParams.model_name ?? stepParams.model ?? ""),
      );
      if (handleDef) {
        validateEdgeValue(rawValue, handleDef.data_type, edge.target_handle);
        if (handleDef.internal_key === "image_url" && handleDef.data_type === "image") {
          edgeImageUrls.push(rawValue);
          if (!stepParams[handleDef.internal_key]) stepParams[handleDef.internal_key] = rawValue;
        } else if (handleDef.internal_key === "reference_image_urls" && handleDef.data_type === "image") {
          appendUniqueStringParam(stepParams, "reference_image_urls", [rawValue], 9);
        } else if (handleDef.internal_key === "ref_image_urls" && handleDef.data_type === "image") {
          appendUniqueStringParam(stepParams, "ref_image_urls", [rawValue], 7);
        } else if (handleDef.internal_key === "reference_video_urls" && handleDef.data_type === "video") {
          appendUniqueStringParam(stepParams, "reference_video_urls", [rawValue], 3);
        } else if (handleDef.internal_key === "reference_audio_urls" && handleDef.data_type === "audio") {
          appendUniqueStringParam(stepParams, "reference_audio_urls", [rawValue], 3);
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
    const p = stepDef.provider.toLowerCase();
    const isSeedanceV2 =
      (p === "seedance" || p === "replicate_video") &&
      (String(stepParams.model_name ?? stepParams.model ?? "").startsWith("seedance-2-0") ||
        String(stepParams.model_name ?? stepParams.model ?? "").startsWith("dreamina-seedance-2-0") ||
        String(stepParams.model_name ?? stepParams.model ?? "").startsWith("replicate-seedance-2-0"));
    if (isSeedanceV2) {
      const hasKeyframeInput = Boolean(
        stepParams.image_url ||
          stepParams.start_frame ||
          stepParams.image_tail_url ||
          stepParams.end_frame,
      );
      if (!hasKeyframeInput) {
        const existing = Array.isArray(stepParams.reference_image_urls)
          ? (stepParams.reference_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
          : typeof stepParams.reference_image_urls === "string"
            ? [stepParams.reference_image_urls]
            : [];
        stepParams.reference_image_urls = Array.from(new Set([...existing, ...allAggregatedImages])).slice(0, 9);
      }
    } else {
      stepParams.mention_image_urls = allAggregatedImages;
      if (!stepParams.image_url) stepParams.image_url = allAggregatedImages[0];
    }
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
      case "veo":
        return await executeVeo(stepParams, supabase);
      case "replicate_video":
        return await executeReplicateVideo(stepParams);
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
    const stepProviderMeta =
      stepResult.provider_meta && typeof stepResult.provider_meta === "object"
        ? (stepResult.provider_meta as Record<string, unknown>)
        : {};
    const isAsync = (stepDef.is_async || Boolean(stepProviderMeta.poll_endpoint)) && !!stepResult.task_id;
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

  const requestedModel = String(params.model_name ?? "gemini-3-pro-preview");
  const model =
    requestedModel === "gemini-3.1-pro-preview"
      ? "gemini-3-pro-preview"
      : requestedModel;
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

  const resp = await fetchWithAttemptTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Timeout": "110",
      },
      body: JSON.stringify(requestBody),
    },
    105_000,
    "Video to Prompt",
  );

  if (!resp.ok) {
    const errText = (await resp.text()).substring(0, 500);
    console.error(`[video-to-prompt] Gemini ${resp.status}:`, errText);
    if (isProviderBillingLike(resp.status, errText)) {
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
    if (m.startsWith("replicate-seedance")) return "replicate_video";
    if (m.startsWith("seedance") || m.startsWith("dreamina-seedance")) return "seedance";
    if (m.startsWith("veo-")) return "veo";
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
  // gemini_tts proxy when the user picks a `gemini-2.5-*-tts` model;
  // route to ElevenLabs when the model slug starts with `elevenlabs-`
  // or matches one of the raw ElevenLabs model_ids
  // (`eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`).
  if (nodeType === "audioGenNode") {
    if (m.startsWith("gemini-")) return "gemini_tts";
    if (m.startsWith("elevenlabs-") || m.startsWith("eleven_")) return "elevenlabs_tts";
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
    p === "kling" || p === "seedance" || p === "veo" || p === "replicate_video" || p === "merge_audio"
      ? "video_url"
      : p === "tripo3d" || p === "hyper3d"
        ? "model_3d"
      : p === "chat_ai" || p === "video_understanding"
        ? "text"
        : p === "google_tts" || p === "gemini_tts" ||
          p === "elevenlabs_tts" || p === "mp3_input"
          ? "audio_url"
          : "image_url";
  const feature =
    p === "openai" ? "generate_openai_image" :
    p === "seedream" ? "generate_seedream_image" :
    p === "banana" ? "generate_freepik_image" :
    p === "kling" || p === "seedance" || p === "veo" || p === "replicate_video" ? "generate_freepik_video" :
    p === "remove_bg" ? "remove_background" :
    p === "merge_audio" ? "merge_audio_video" :
    p === "chat_ai" ? "chat_ai" :
    p === "tripo3d" || p === "hyper3d" ? "model_3d" :
    p === "google_tts" || p === "gemini_tts" || p === "elevenlabs_tts" ? "text_to_speech" :
    p === "video_understanding" ? "video_to_prompt" :
    nodeType;
  return {
    provider: p,
    feature,
    output_type: output,
    is_async: p === "kling" || p === "seedance" || p === "veo" || p === "replicate_video" || p === "tripo3d" || p === "hyper3d" || p === "merge_audio",
  };
}

function shouldChargeWorkspaceProvider(provider: string): boolean {
  // Workspace-run-node owns charging for generation providers. MP3 input is a
  // utility/upload node and does not call a paid provider.
  return provider !== "mp3_input";
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
    case "veo":
    case "replicate_video":
    case "merge_audio":
      return multipliers.video;
    case "chat_ai":
    case "video_understanding":
      return multipliers.chat;
    case "google_tts":
    case "gemini_tts":
    case "elevenlabs_tts":
    case "mp3_input":
      return multipliers.audio ?? multipliers.chat;
    default:
      return multipliers.chat;
  }
}

type WorkspaceCreditCharge = {
  amount: number;
  scope: "user" | "organization" | "team" | "education_space";
  teamId: string | null;
  organizationId: string | null;
  classId: string | null;
  creditUserId: string | null;
  referenceId: string;
  feature: string;
};

const DEFAULT_EDUCATION_BLOCKED_MODELS = [
  "seedance-2-0-lite",
  "seedance-2-0-pro",
  "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0-fast-260128",
];

type WorkspaceCreditOwner =
  | {
      scope: "organization";
      organizationId: string;
      organizationName: string | null;
      poolDomain: string | null;
      email: string | null;
      organizationType?: string | null;
      classId?: string | null;
    }
  | {
      scope: "user";
      creditUserId: string;
      email: string | null;
      organizationId?: string | null;
      organizationName?: string | null;
      organizationType?: string | null;
      classId?: string | null;
      className?: string | null;
      classRole?: string | null;
    };

async function resolveWorkspaceEducationCreditScope(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{
  organizationId: string;
  organizationName: string | null;
  organizationType: string | null;
  classId: string | null;
  className: string | null;
  classRole: string | null;
} | null> {
  try {
    const { data, error } = await supabase.rpc("workspace_education_credit_scope", {
      p_user_id: userId,
    });
    if (error) {
      if (!/function .*workspace_education_credit_scope/i.test(error.message)) {
        console.warn("[workspace-credits] education credit scope skipped:", error.message);
      }
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.organization_id) return null;
    return {
      organizationId: String(row.organization_id),
      organizationName: row.organization_name ? String(row.organization_name) : null,
      organizationType: row.organization_type ? String(row.organization_type) : null,
      classId: row.class_id ? String(row.class_id) : null,
      className: row.class_name ? String(row.class_name) : null,
      classRole: row.class_role ? String(row.class_role) : null,
    };
  } catch (err) {
    console.warn(
      "[workspace-credits] education credit scope unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function resolveWorkspaceCreditOwner(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  email?: string | null,
): Promise<WorkspaceCreditOwner> {
  let resolvedEmail = email ?? null;
  if (!resolvedEmail) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (!error) resolvedEmail = data.user?.email ?? null;
    } catch (err) {
      console.warn(
        "[workspace-credits] shared pool email lookup skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (resolvedEmail) {
    try {
      await acceptPendingOrgInviteForUser(
        supabase,
        { id: userId, email: resolvedEmail },
        "workspace_run_node",
      );
    } catch (err) {
      console.warn(
        "[workspace-credits] pending org invite accept skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  try {
    const { data, error } = await supabase.rpc("workspace_org_credit_scope", {
      p_user_id: userId,
    });
    if (error && !/function .*workspace_org_credit_scope/i.test(error.message)) {
      console.warn("[workspace-credits] org credit scope lookup skipped:", error.message);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.organization_id) {
      const orgType = row.organization_type ? String(row.organization_type) : null;
      if (orgType === "school" || orgType === "university") {
        const edu = await resolveWorkspaceEducationCreditScope(supabase, userId);
        if (edu?.classRole === "student" && edu.classId) {
          return {
            scope: "user",
            creditUserId: userId,
            email: resolvedEmail,
            organizationId: edu.organizationId,
            organizationName: edu.organizationName,
            organizationType: edu.organizationType,
            classId: edu.classId,
            className: edu.className,
            classRole: edu.classRole,
          };
        }
        if (!edu?.classId) {
          return {
            scope: "user",
            creditUserId: userId,
            email: resolvedEmail,
            organizationId: String(row.organization_id),
            organizationName: row.organization_name ? String(row.organization_name) : null,
            organizationType: orgType,
            classId: null,
            className: null,
            classRole: null,
          };
        }
      }
      return {
        scope: "organization",
        organizationId: String(row.organization_id),
        organizationName: row.organization_name ? String(row.organization_name) : null,
        poolDomain: row.primary_domain ? String(row.primary_domain) : null,
        email: resolvedEmail,
        organizationType: orgType,
      };
    }
  } catch (err) {
    console.warn(
      "[workspace-credits] org credit scope unavailable:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Repair older profiles that signed in before the post-auth org trigger
  // existed. If their email domain is now verified, pin membership so future
  // calls resolve through workspace_org_credit_scope.
  const domain = String(resolvedEmail ?? "").toLowerCase().split("@")[1] ?? "";
  if (domain && !isPublicEmailDomain(domain)) {
    try {
      const { data: domainRow } = await supabase
        .from("organization_domains")
        .select("organization_id, domain")
        .eq("domain", domain)
        .not("verified_at", "is", null)
        .maybeSingle();
      if (domainRow?.organization_id) {
        const { data: org } = await supabase
          .from("organizations")
          .select("id, name, display_name, status, type")
          .eq("id", domainRow.organization_id)
          .eq("status", "active")
          .is("deleted_at", null)
          .maybeSingle();
        if (org?.id) {
          await supabase
            .from("profiles")
            .update({
              organization_id: org.id,
              account_type: "org_user",
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId)
            .is("organization_id", null);
          await supabase.from("organization_memberships").upsert(
            {
              organization_id: org.id,
              user_id: userId,
              role: "member",
              status: "active",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "organization_id,user_id" },
          );
          if (String((org as { type?: unknown }).type ?? "") === "school" || String((org as { type?: unknown }).type ?? "") === "university") {
            return {
              scope: "user",
              creditUserId: userId,
              organizationId: String(org.id),
              organizationName: String(org.display_name ?? org.name ?? ""),
              organizationType: String((org as { type?: unknown }).type ?? ""),
              classId: null,
              className: null,
              classRole: null,
              email: resolvedEmail,
            };
          }
          return {
            scope: "organization",
            organizationId: String(org.id),
            organizationName: String(org.display_name ?? org.name ?? ""),
            poolDomain: String(domainRow.domain ?? domain),
            email: resolvedEmail,
            organizationType: String((org as { type?: unknown }).type ?? ""),
          };
        }
      }
    } catch (err) {
      console.warn(
        "[workspace-credits] org membership repair skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    scope: "user",
    creditUserId: userId,
    email: resolvedEmail,
  };
}

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

function normalizedModelKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function educationBlockedModelsFromSettings(settings: unknown): string[] {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).blocked_model_ids
      : null;
  if (Array.isArray(raw)) {
    return raw.map(normalizedModelKey).filter(Boolean);
  }
  return DEFAULT_EDUCATION_BLOCKED_MODELS;
}

function educationModelMatchesBlock(model: string, blocked: string): boolean {
  if (!model || !blocked) return false;
  if (model === blocked) return true;
  if (model.includes(blocked) || blocked.includes(model)) return true;
  if (blocked.includes("seedance-2-0")) {
    return model.includes("seedance-2-0") || model.includes("dreamina-seedance-2-0");
  }
  return false;
}

async function assertEducationModelAllowed(args: {
  supabase: ReturnType<typeof createClient>;
  classId: string;
  modelId: string;
}): Promise<void> {
  const model = normalizedModelKey(args.modelId);
  if (!model) return;
  const { data, error } = await args.supabase
    .from("classes")
    .select("settings")
    .eq("id", args.classId)
    .maybeSingle();
  if (error) {
    throw new Error(`Class model policy lookup failed: ${error.message}`);
  }
  const blocked = educationBlockedModelsFromSettings((data as { settings?: unknown } | null)?.settings);
  if (blocked.some((blockedModel) => educationModelMatchesBlock(model, blockedModel))) {
    throw new Error("MODEL_BLOCKED_BY_CLASS");
  }
}

async function ensureSpendableUserCreditBatch(
  supabase: ReturnType<typeof createClient>,
  creditUserId: string,
  requiredAmount: number,
): Promise<void> {
  if (!creditUserId || requiredAmount <= 0) return;

  try {
    const nowIso = new Date().toISOString();
    const [creditsRes, batchesRes] = await Promise.all([
      supabase
        .from("user_credits")
        .select("balance")
        .eq("user_id", creditUserId)
        .maybeSingle(),
      supabase
        .from("credit_batches")
        .select("remaining")
        .eq("user_id", creditUserId)
        .gt("remaining", 0)
        .gt("expires_at", nowIso),
    ]);

    if (creditsRes.error) {
      console.warn("[workspace-credits] balance repair skipped:", creditsRes.error.message);
      return;
    }
    if (batchesRes.error) {
      console.warn("[workspace-credits] batch repair skipped:", batchesRes.error.message);
      return;
    }

    const scalarBalance = Math.max(0, Math.floor(Number(creditsRes.data?.balance ?? 0)));
    const activeBatchBalance = (batchesRes.data ?? []).reduce(
      (sum, row: { remaining?: number | null }) => sum + Math.max(0, Math.floor(Number(row.remaining ?? 0))),
      0,
    );

    if (activeBatchBalance >= requiredAmount || scalarBalance <= activeBatchBalance) {
      return;
    }

    const repairAmount = scalarBalance - activeBatchBalance;
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from("credit_batches").insert({
      user_id: creditUserId,
      amount: repairAmount,
      remaining: repairAmount,
      source_type: "topup",
      expires_at: expiresAt,
      reference_id: `balance-repair-${Date.now()}`,
    });

    if (error) {
      console.warn("[workspace-credits] balance repair insert failed:", error.message);
      return;
    }

    console.log(
      `[workspace-credits] repaired spendable batch user=${creditUserId} amount=${repairAmount} active_before=${activeBatchBalance} scalar=${scalarBalance}`,
    );
  } catch (err) {
    console.warn(
      "[workspace-credits] balance repair failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function consumeWorkspaceCredits(args: {
  supabase: ReturnType<typeof createClient>;
  userId: string;
  body: WorkspaceRunBody;
  nodeType: string;
  provider: string;
  params: Record<string, unknown>;
  userEmail?: string | null;
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
  const creditOwner = await resolveWorkspaceCreditOwner(args.supabase, args.userId, args.userEmail);
  const descriptionBase = `${args.nodeType} ${String(args.params.model_name ?? args.params.model ?? args.provider)}`;
  const description =
    creditOwner.scope === "organization"
      ? `${descriptionBase} (${creditOwner.organizationName ?? "org"} shared pool; actual user ${creditOwner.email ?? args.userId})`
      : descriptionBase;

  if (
    creditOwner.scope === "user" &&
    creditOwner.organizationType &&
    ["school", "university"].includes(String(creditOwner.organizationType)) &&
    creditOwner.classRole !== "teacher"
  ) {
    if (!creditOwner.classId) {
      throw new Error("EDUCATION_CLASS_REQUIRED");
    }
    if (!args.body.workspace_id) {
      throw new Error("EDUCATION_SPACE_REQUIRED");
    }
    const modelId = String(args.params.model_name ?? args.params.model ?? args.provider);
    await assertEducationModelAllowed({
      supabase: args.supabase,
      classId: creditOwner.classId,
      modelId,
    });
    const { data, error } = await args.supabase.rpc("consume_education_space_credits", {
      p_user_id: args.userId,
      p_workspace_id: args.body.workspace_id,
      p_amount: amount,
      p_feature: def.feature,
      p_description: description,
      p_reference_id: referenceId,
      p_canvas_id: args.body.canvas_id ?? null,
      p_model_id: modelId,
    });
    if (error) {
      throw new Error(error.message);
    }
    if (data !== true) {
      throw new Error("INSUFFICIENT_CREDITS");
    }
    console.log(
      `[workspace-credits] charged ${amount} education-space credits user=${args.userId} class=${creditOwner.classId} workspace=${args.body.workspace_id} ref=${referenceId}`,
    );
    return {
      amount,
      scope: "education_space",
      teamId: null,
      organizationId: creditOwner.organizationId ?? null,
      classId: creditOwner.classId,
      creditUserId: args.userId,
      referenceId,
      feature: def.feature,
    };
  }

  if (!teamId && creditOwner.scope === "organization") {
    const { data, error } = await args.supabase.rpc("consume_workspace_org_credits", {
      p_user_id: args.userId,
      p_organization_id: creditOwner.organizationId,
      p_amount: amount,
      p_feature: def.feature,
      p_description: description,
      p_reference_id: referenceId,
      p_workspace_id: args.body.workspace_id ?? null,
      p_canvas_id: args.body.canvas_id ?? null,
    });
    if (error) {
      // Shared-credit users must not silently fall back to personal billing.
      throw new Error(`Org credit deduction failed: ${error.message}`);
    } else {
      // Success path — actually charged from org pool.
      if (data !== true) {
        throw new Error("INSUFFICIENT_CREDITS");
      }
      console.log(
        `[workspace-credits] charged ${amount} credits user=${args.userId} org=${creditOwner.organizationId} ref=${referenceId}`,
      );
      return {
        amount,
        scope: "organization",
        teamId: null,
        organizationId: creditOwner.organizationId,
        classId: creditOwner.classId ?? null,
        creditUserId: null,
        referenceId,
        feature: def.feature,
      };
    }
  }

  const creditUserId = creditOwner.scope === "user" ? creditOwner.creditUserId : args.userId;

  if (!teamId) {
    await ensureSpendableUserCreditBatch(args.supabase, creditUserId, amount);
  }

  const { data, error } = await args.supabase.rpc("consume_credits_for", {
    p_user_id: creditUserId,
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
      if (teamId) {
        throw new Error(`Team credit deduction unavailable: ${error.message}`);
      }
      const fallback = await args.supabase.rpc("consume_credits", {
        p_user_id: creditUserId,
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
    `[workspace-credits] charged ${amount} credits user=${args.userId} credit_user=${creditUserId} team=${teamId ?? "personal"} ref=${referenceId}`,
  );
  return {
    amount,
    scope: teamId ? "team" : "user",
    teamId,
    organizationId: creditOwner.scope === "user" ? creditOwner.organizationId ?? null : null,
    classId: creditOwner.scope === "user" ? creditOwner.classId ?? null : null,
    creditUserId,
    referenceId,
    feature: def.feature,
  };
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
    if (args.charge.scope === "education_space") {
      const { error } = await args.supabase.rpc("refund_education_space_credits", {
        p_user_id: args.charge.creditUserId ?? args.userId,
        p_workspace_id: args.workspaceId ?? null,
        p_amount: args.charge.amount,
        p_reason: args.reason,
        p_reference_id: args.charge.referenceId,
        p_canvas_id: args.canvasId ?? null,
      });
      if (error) throw error;
      return;
    }

    if (args.charge.scope === "organization" && args.charge.organizationId) {
      const { error } = await args.supabase.rpc("refund_workspace_org_credits", {
        p_user_id: args.userId,
        p_organization_id: args.charge.organizationId,
        p_amount: args.charge.amount,
        p_reason: args.reason,
        p_reference_id: args.charge.referenceId,
        p_workspace_id: args.workspaceId ?? null,
        p_canvas_id: args.canvasId ?? null,
      });
      if (error) throw error;
      return;
    }

    const owner = args.charge.creditUserId
      ? null
      : await resolveWorkspaceCreditOwner(args.supabase, args.userId);
    const creditUserId = args.charge.creditUserId ??
      (owner?.scope === "user" ? owner.creditUserId : args.userId);
    const { error } = await args.supabase.rpc("refund_credits_for", {
      p_user_id: creditUserId,
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
      creditUserId,
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
      scope: (args.job.credit_scope as WorkspaceCreditCharge["scope"] | null) ??
        (args.job.credit_organization_id ? "organization" : args.job.credit_team_id ? "team" : "user"),
      teamId: args.job.credit_team_id ?? null,
      organizationId: args.job.credit_organization_id ?? null,
      classId: args.job.credit_class_id ?? null,
      creditUserId: null,
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
const OPENAI_IMAGE_2_ATTEMPT_TIMEOUT_MS = 118_000;

async function executeOpenAIImage2(
  params: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const prompt = String(params.prompt ?? "");
  if (!prompt) throw new Error("A prompt is required.");

  const model = String(params.model_name ?? params.model ?? "gpt-image-2");
  const requestedQuality = String(params.quality ?? "medium").toLowerCase();
  const quality =
    requestedQuality === "low" || requestedQuality === "medium" || requestedQuality === "high"
      ? requestedQuality
      : "medium";
  const size = String(params.size ?? "1024x1024");
  const outputFormat = String(params.output_format ?? "png");
  const rawOutputCompression = Number(params.output_compression ?? 100);
  const outputCompression = Number.isFinite(rawOutputCompression)
    ? Math.max(0, Math.min(100, Math.round(rawOutputCompression)))
    : 100;
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

    response = await fetchWithAttemptTimeout(
      "https://api.openai.com/v1/images/edits",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      },
      OPENAI_IMAGE_2_ATTEMPT_TIMEOUT_MS,
      "OpenAI Image 2 edit",
    );
  } else {
    response = await fetchWithAttemptTimeout(
      "https://api.openai.com/v1/images/generations",
      {
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
          ...(outputFormat === "jpeg" || outputFormat === "webp"
            ? { output_compression: outputCompression }
            : {}),
          background,
          moderation,
        }),
      },
      OPENAI_IMAGE_2_ATTEMPT_TIMEOUT_MS,
      "OpenAI Image 2 generation",
    );
  }

  if (!response.ok) {
    const status = response.status;
    const errorText = await response.text();
    let errorMsg = summarizeProviderErrorText(errorText) || errorText.substring(0, 500);
    try {
      const errJson = JSON.parse(errorText);
      errorMsg = (errJson as { error?: { message?: string } })?.error?.message ?? errorMsg;
    } catch { /* keep summarized text */ }

    console.error(`[openai-image-2] HTTP ${status}: ${errorMsg.substring(0, 200)}`);

    if (isProviderBillingLike(status, errorText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    if (status === 401 || status === 403) {
      throw new Error(`OpenAI ${status}: ${errorMsg}`);
    }
    if (status >= 500) {
      throw new Error(`OpenAI ${status}: temporary upstream error${errorMsg ? ` - ${errorMsg}` : ""}`);
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
  const fileName = `pipeline/mediaforge_${Date.now()}.${ext}`;
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
    | "poll_workspace_job"
    | "run_workspace_job_worker"
    | "poll_kling"
    | "poll_seedance"
    | "poll_veo"
    | "poll_replicate_veo"
    | "poll_replicate_video"
    | "poll_freepik_veo"
    | "poll_freepik_video"
    | "poll_freepik_image"
    | "poll_hyper3d"
    | "poll_tripo3d"
    | "mirror_tripo_url"
    | "refresh_storage_url"
    | "delete_workspace_asset";
  job_id?: string;
  asset_id?: string;
  asset_source?: "generation" | "user_asset" | "upload" | string;
  storage_bucket?: string;
  storage_path?: string;
  task_id?: string;
  poll_endpoint?: string;
  model?: string;
  provider_model_id?: string;
  api_key_alias?: string;
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
  credit_scope?: "user" | "organization" | "team" | "education_space";
  credit_organization_id?: string | null;
  credit_class_id?: string | null;
}

const WORKSPACE_JOB_MAX_MS = 60 * 60_000;
// Supabase Edge requests can be terminated by the platform well before
// long image providers return. Keep each synchronous provider attempt under
// that ceiling, then let the durable queue retry until the 60 minute deadline.
const WORKSPACE_JOB_ATTEMPT_TIMEOUT_MS = 150_000;
const WORKSPACE_JOB_BACKOFF_MS = [3_000, 5_000, 10_000, 15_000, 30_000, 60_000];
const BANANA_JOB_BACKOFF_MS = [60_000, 180_000, 300_000, 600_000, 900_000];
const WORKSPACE_JOB_WORKER_BATCH_SIZE = 8;
const WORKSPACE_JOB_LOCK_SEC = 360;
const WORKSPACE_JOB_HEARTBEAT_MS = 45_000;
const WORKSPACE_JOB_EXPIRE_SWEEP_LIMIT = 25;

function workspaceJobMaxAttempts(provider: string): number {
  // Gemini image sync calls consume request quota on every retry because there
  // is no task id to resume. Keep Banana conservative until it moves to Batch.
  return provider === "banana" ? 6 : 18;
}

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
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  run_after?: string | null;
  deadline_at?: string | null;
  locked_by?: string | null;
  lock_expires_at?: string | null;
  worker_heartbeat_at?: string | null;
  notification_sent_at?: string | null;
  credits_charged?: number | null;
  credits_refunded?: number | null;
  credit_team_id?: string | null;
  credit_organization_id?: string | null;
  credit_class_id?: string | null;
  credit_scope?: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasRecoverableAsyncResult(job: WorkspaceJobRow): boolean {
  const result =
    job.result && typeof job.result === "object"
      ? (job.result as Record<string, unknown>)
      : null;
  const providerMeta =
    result?.provider_meta && typeof result.provider_meta === "object"
      ? (result.provider_meta as Record<string, unknown>)
      : null;
  return Boolean(
    result?.task_id &&
      !result.url &&
      providerMeta?.poll_endpoint,
  );
}

function isPermanentWorkspaceJobError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    classifyError(msg) === "permanent" ||
    /authentication|unauthor(ized|ised)|invalid.*api.?key/i.test(msg) ||
    /content[\s_-]*polic|moderation|blocked|safety (?:system|filter)|privacy-sensitive|Seedance rejected the reference media/i.test(msg) ||
    /unsupported node type|No executor for provider/i.test(msg) ||
    /\bnot configured\b|missing.*key|credentials missing/i.test(msg) ||
    /is not defined|is not a function|cannot read prop(?:erty|erties) of (?:undefined|null)/i.test(msg) ||
    /ReferenceError|TypeError|SyntaxError/i.test(msg) ||
    /HTTP (?:400|401|403|404|422)\b/i.test(msg) ||
    /Veo: failed to fetch start\/end frame \((?:400|401|403|404|410)\)/i.test(msg) ||
    /(prompt|input|argument).*required|Validation/i.test(msg) ||
    /Seedance reference video is invalid|reference videos?.*(?:must|duration|invalid)|video duration.*(?:must|invalid|exceed)|total reference video duration|total duration of all videos/i.test(msg)
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

function safeJsonSnippet(value: unknown, maxLength = 1200): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return "";
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return String(value);
  }
}

function formatVeoPollFailure(statusObj: unknown): string {
  const status =
    statusObj && typeof statusObj === "object"
      ? (statusObj as Record<string, unknown>)
      : {};
  const rawError =
    status.error && typeof status.error === "object"
      ? (status.error as Record<string, unknown>)
      : null;
  if (rawError) {
    const code = rawError.code != null ? `code=${String(rawError.code)}` : "";
    const statusCode = rawError.status != null ? `status=${String(rawError.status)}` : "";
    const message = String(rawError.message ?? "").trim();
    const prefix = [code, statusCode].filter(Boolean).join(" ");
    if (message) {
      return `Veo operation failed${prefix ? ` (${prefix})` : ""}: ${message}`;
    }
    return `Veo operation failed${prefix ? ` (${prefix})` : ""}: ${safeJsonSnippet(rawError)}`;
  }
  return `Veo operation finished without a video URL: ${safeJsonSnippet(statusObj)}`;
}

async function invokeWorkspaceRunOnce(args: {
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
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
        ...(args.extraHeaders ?? {}),
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

function startWorkspaceJobHeartbeat(args: {
  supabase: ReturnType<typeof createClient>;
  jobId: string;
  workerId: string;
}): () => void {
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    const now = new Date();
    const { error } = await args.supabase
      .from("workspace_generation_jobs")
      .update({
        worker_heartbeat_at: now.toISOString(),
        lock_expires_at: new Date(now.getTime() + WORKSPACE_JOB_LOCK_SEC * 1000).toISOString(),
      })
      .eq("id", args.jobId)
      .eq("locked_by", args.workerId)
      .eq("status", "running");
    if (error) {
      console.warn("[workspace-job-worker] heartbeat failed", args.jobId, error.message);
    }
  };
  const timer = setInterval(() => void beat(), WORKSPACE_JOB_HEARTBEAT_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function pollWorkspaceAsyncResult(args: {
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
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

  const provider = inferAsyncPollProvider(providerMeta, taskId, pollEndpoint);
  const pollAction =
    provider === "tripo3d"
      ? "poll_tripo3d"
      : provider === "hyper3d"
        ? "poll_hyper3d"
      : provider === "seedance"
        ? "poll_seedance"
      : provider === "veo"
        ? "poll_veo"
      : provider === "replicate_veo"
        ? "poll_replicate_veo"
      : provider === "replicate_video"
        ? "poll_replicate_video"
      : provider === "freepik_veo" || provider === "freepik_seedance"
        ? "poll_freepik_video"
      : provider === "freepik_image"
        ? "poll_freepik_image"
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
      extraHeaders: args.extraHeaders,
      body: {
        action: pollAction,
        task_id: taskId,
        poll_endpoint: pollEndpoint,
        model: String(providerMeta.model ?? providerMeta.provider_model_id ?? ""),
        provider_model_id: String(providerMeta.provider_model_id ?? ""),
        api_key_alias: String(providerMeta.api_key_alias ?? ""),
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

type WorkspaceAsyncPollOnceResult =
  | { state: "not_async"; result: Record<string, unknown> }
  | { state: "pending"; status: string; message: string }
  | { state: "succeeded"; result: Record<string, unknown> }
  | { state: "failed"; message: string };

async function pollWorkspaceAsyncResultOnce(args: {
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
  response: Record<string, unknown>;
}): Promise<WorkspaceAsyncPollOnceResult> {
  const taskId = String(args.response.task_id ?? "").trim();
  const providerMeta =
    args.response.provider_meta && typeof args.response.provider_meta === "object"
      ? (args.response.provider_meta as Record<string, unknown>)
      : {};
  const pollEndpoint = String(providerMeta.poll_endpoint ?? "").trim();
  if (!taskId || args.response.url || !pollEndpoint) {
    return { state: "not_async", result: args.response };
  }

  const provider = inferAsyncPollProvider(providerMeta, taskId, pollEndpoint);
  const pollAction =
    provider === "tripo3d"
      ? "poll_tripo3d"
      : provider === "hyper3d"
        ? "poll_hyper3d"
      : provider === "seedance"
        ? "poll_seedance"
      : provider === "veo"
        ? "poll_veo"
      : provider === "replicate_veo"
        ? "poll_replicate_veo"
      : provider === "replicate_video"
        ? "poll_replicate_video"
      : provider === "freepik_veo" || provider === "freepik_seedance"
        ? "poll_freepik_video"
      : provider === "freepik_image"
        ? "poll_freepik_image"
        : "poll_kling";

  const pollResp = await invokeWorkspaceRunOnce({
    functionUrl: args.functionUrl,
    authHeader: args.authHeader,
    extraHeaders: args.extraHeaders,
    body: {
      action: pollAction,
      task_id: taskId,
      poll_endpoint: pollEndpoint,
      model: String(providerMeta.model ?? providerMeta.provider_model_id ?? ""),
      provider_model_id: String(providerMeta.provider_model_id ?? ""),
      api_key_alias: String(providerMeta.api_key_alias ?? ""),
    } as WorkspaceRunBody,
  });

  const status = String(pollResp.status ?? "").toLowerCase();
  const message = String(pollResp.message ?? "");
  if (status === "polling_error") {
    return { state: "pending", status, message };
  }

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

  if (successStatuses.has(status)) {
    const url = String(pollResp.url ?? "");
    if (!url) {
      return { state: "failed", message: `${provider} task succeeded but returned no URL` };
    }
    const nextProviderMeta = {
      ...providerMeta,
      ...(pollResp.model_url ? { model_url: pollResp.model_url } : {}),
      ...(pollResp.preview_image ? { rendered_image: pollResp.preview_image } : {}),
    };
    const currentOutputs =
      args.response.outputs && typeof args.response.outputs === "object"
        ? (args.response.outputs as Record<string, string>)
        : {};
    const responseType = String(args.response.type ?? args.response.output_type ?? "");
    const outputKey =
      responseType === "video" || responseType === "video_url"
        ? "output_video"
        : responseType === "audio" || responseType === "audio_url"
          ? "output_audio"
          : "output_image";
    return {
      state: "succeeded",
      result: {
        ...args.response,
        url,
        outputs: {
          ...currentOutputs,
          [outputKey]: url,
        },
        provider_meta: nextProviderMeta,
      },
    };
  }

  if (failedStatuses.has(status)) {
    return { state: "failed", message: message || `${provider} task failed` };
  }

  return { state: "pending", status: status || "submitted", message };
}

function inferAsyncPollProvider(
  providerMeta: Record<string, unknown>,
  taskId: string,
  pollEndpoint: string,
): string {
  const explicit = String(providerMeta.provider ?? "").toLowerCase();
  if (explicit) return explicit;
  const endpoint = pollEndpoint.toLowerCase();
  const task = taskId.toLowerCase();
  if (
    endpoint.includes("api.magnific.com") ||
    endpoint.includes("api.freepik.com")
  ) {
    if (endpoint.includes("/text-to-image/")) return "freepik_image";
    if (endpoint.includes("/seedance-")) return "freepik_seedance";
    return "freepik_veo";
  }
  if (endpoint.includes("api.replicate.com")) {
    const model = String(providerMeta.model ?? providerMeta.provider_model_id ?? "").toLowerCase();
    return model.includes("seedance") ? "replicate_video" : "replicate_veo";
  }
  if (
    endpoint.includes("generativelanguage.googleapis.com") ||
    task.startsWith("operations/") ||
    task.startsWith("models/")
  ) {
    return "veo";
  }
  if (
    endpoint.includes("byteplus") ||
    endpoint.includes("volces.com") ||
    endpoint.includes("/contents/generations/tasks")
  ) {
    return "seedance";
  }
  if (endpoint.includes("hyper3d")) return "hyper3d";
  if (endpoint.includes("tripo3d")) return "tripo3d";
  return "kling";
}

function workspaceJobDeadlineMs(job: WorkspaceJobRow): number {
  const explicitDeadline = Date.parse(String(job.deadline_at ?? ""));
  if (Number.isFinite(explicitDeadline)) return explicitDeadline;

  const started = Date.parse(String(job.started_at ?? ""));
  const created = Date.parse(String(job.created_at ?? ""));
  const base = Number.isFinite(started)
    ? started
    : Number.isFinite(created)
      ? created
      : Date.now();
  return base + WORKSPACE_JOB_MAX_MS;
}

function workspaceJobLink(job: WorkspaceJobRow): string {
  if (job.workspace_id) return `/app/workspace/${encodeURIComponent(job.workspace_id)}`;
  const section =
    job.node_type === "klingVideoNode" || job.node_type === "videoGenNode"
      ? "video_gen"
      : job.node_type === "googleTtsNode" || job.node_type === "geminiTtsNode"
        ? "voice_gen"
        : job.node_type === "tripo3dNode" || job.node_type === "hyper3dNode"
          ? "model_3d"
          : "image_gen";
  return `/app/workspace?section=${section}`;
}

function workspaceJobProviderLabel(job: WorkspaceJobRow): string {
  return String(job.model ?? job.provider ?? job.node_type ?? "generation");
}

function workspaceJobBackoffMs(attempt: number, provider?: string): number {
  const schedule = provider === "banana" ? BANANA_JOB_BACKOFF_MS : WORKSPACE_JOB_BACKOFF_MS;
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)];
}

function workspaceJobBackoffSeconds(attempt: number, provider?: string): number {
  const ms = workspaceJobBackoffMs(attempt, provider);
  return Math.max(5, Math.ceil(ms / 1000));
}

function workspaceJobPollDelaySeconds(result: Record<string, unknown>): number {
  const providerMeta =
    result.provider_meta && typeof result.provider_meta === "object"
      ? (result.provider_meta as Record<string, unknown>)
      : {};
  const provider = inferAsyncPollProvider(
    providerMeta,
    String(result.task_id ?? ""),
    String(providerMeta.poll_endpoint ?? ""),
  );
  if (provider === "tripo3d") return 8;
  if (provider === "hyper3d") return 10;
  return 5;
}

function workspaceWorkerHeaders(secret: string, userId: string): Record<string, string> {
  return {
    "x-cron-secret": secret,
    "x-workspace-worker-user-id": userId,
  };
}

async function getWorkspaceWorkerSecret(
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  const envSecret =
    Deno.env.get("WORKSPACE_WORKER_SECRET") ??
    Deno.env.get("CRON_SECRET") ??
    "";
  if (envSecret) return envSecret;

  try {
    const { data, error } = await supabase.rpc("get_retry_worker_cron_secret");
    if (!error && data) return String(data);
  } catch (err) {
    console.warn(
      "[workspace-job-worker] secret lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

async function verifyWorkspaceWorkerSecret(
  supabase: ReturnType<typeof createClient>,
  req: Request,
): Promise<string | null> {
  const provided =
    req.headers.get("x-cron-secret") ??
    req.headers.get("x-workspace-worker-secret") ??
    "";
  if (!provided) return null;

  const expected = await getWorkspaceWorkerSecret(supabase);
  return expected && provided === expected ? provided : null;
}

async function loadWorkspaceWorkerUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ id: string; email?: string | null } | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    console.error("[workspace-job-worker] user lookup failed", userId, error);
    return null;
  }
  return { id: data.user.id, email: data.user.email ?? null };
}

async function releaseWorkspaceJobLock(args: {
  supabase: ReturnType<typeof createClient>;
  jobId: string;
  workerId: string;
  runAfterSeconds: number;
}): Promise<void> {
  const { error } = await args.supabase.rpc("release_workspace_generation_job", {
    p_job_id: args.jobId,
    p_worker_id: args.workerId,
    p_run_after_seconds: args.runAfterSeconds,
  });
  if (error) {
    console.warn("[workspace-job-worker] release lock failed", args.jobId, error.message);
  }
}

async function notifyWorkspaceJobTerminal(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  status: "completed" | "failed" | "permanent_failed";
  message?: string;
}): Promise<void> {
  if (args.job.notification_sent_at) return;

  const { data: claimed, error: claimErr } = await args.supabase
    .from("workspace_generation_jobs")
    .update({ notification_sent_at: new Date().toISOString() })
    .eq("id", args.job.id)
    .is("notification_sent_at", null)
    .select("id")
    .maybeSingle();

  if (claimErr || !claimed) {
    if (claimErr) console.warn("[workspace-job] notification claim failed", claimErr.message);
    return;
  }

  const isSuccess = args.status === "completed";
  const providerLabel = workspaceJobProviderLabel(args.job);
  const title = isSuccess ? "Generation complete" : "Generation failed";
  const message = isSuccess
    ? `${providerLabel} is ready.`
    : (args.message?.trim() || `${providerLabel} could not finish. Credits were refunded.`);

  const { error } = await args.supabase.from("notifications").insert({
    user_id: args.job.user_id,
    type: isSuccess ? "workspace_generation_complete" : "workspace_generation_failed",
    title,
    message: message.substring(0, 300),
    icon: isSuccess ? "sparkles" : "alert-circle",
    link: workspaceJobLink(args.job),
    metadata: {
      job_id: args.job.id,
      project_id: args.job.project_id ?? null,
      workspace_id: args.job.workspace_id ?? null,
      canvas_id: args.job.canvas_id ?? null,
      node_id: args.job.node_id ?? null,
      provider: args.job.provider ?? null,
      model: args.job.model ?? null,
      status: args.status,
    },
  });
  if (error) {
    console.warn("[workspace-job] notification insert failed", args.job.id, error.message);
  }
}

async function completeWorkspaceJob(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  result: Record<string, unknown>;
}): Promise<WorkspaceJobRow | null> {
  const charged = Number(args.job.credits_charged ?? 0);
  const resultWithCredits = {
    ...args.result,
    credits_spent: Number.isFinite(charged) ? charged : 0,
  };
  const { data, error } = await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "completed",
      result: resultWithCredits,
      error: null,
      last_error: null,
      locked_by: null,
      lock_expires_at: null,
      run_after: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.job.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const updated = (data as WorkspaceJobRow | null) ?? { ...args.job, result: resultWithCredits, status: "completed" };
  await notifyWorkspaceJobTerminal({ supabase: args.supabase, job: updated, status: "completed" });
  return updated;
}

async function failWorkspaceJob(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  status?: "failed" | "permanent_failed";
  error: string;
  refundReason: string;
}): Promise<WorkspaceJobRow | null> {
  const msg = args.error;
  await refundWorkspaceJobCharge({
    supabase: args.supabase,
    job: args.job,
    reason: args.refundReason.substring(0, 300),
  });
  const { data, error } = await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: args.status ?? "failed",
      error: msg,
      last_error: msg,
      locked_by: null,
      lock_expires_at: null,
      run_after: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.job.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const updated = (data as WorkspaceJobRow | null) ?? {
    ...args.job,
    status: args.status ?? "failed",
    error: msg,
    last_error: msg,
  };
  await notifyWorkspaceJobTerminal({
    supabase: args.supabase,
    job: updated,
    status: args.status ?? "failed",
    message: msg,
  });
  return updated;
}

async function scheduleWorkspaceJobRetry(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  workerId: string;
  message: string;
  delaySeconds: number;
  result?: Record<string, unknown>;
}): Promise<void> {
  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      ...(args.result ? { result: args.result } : {}),
      error: null,
      last_error: args.message,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", args.job.id);
  await releaseWorkspaceJobLock({
    supabase: args.supabase,
    jobId: args.job.id,
    workerId: args.workerId,
    runAfterSeconds: args.delaySeconds,
  });
}

async function processWorkspaceGenerationJobTick(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  workerId: string;
  functionUrl: string;
  serviceRoleKey: string;
  workerSecret: string;
}): Promise<{ job_id: string; status: string; detail?: string }> {
  const job = args.job;
  const now = Date.now();
  const deadlineMs = workspaceJobDeadlineMs(job);
  if (now >= deadlineMs) {
    const msg = `Provider queue was busy for ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes. Generation timed out and credits were refunded.`;
    await failWorkspaceJob({
      supabase: args.supabase,
      job,
      status: "failed",
      error: msg,
      refundReason: `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
    });
    return { job_id: job.id, status: "failed", detail: "deadline" };
  }

  const authHeader = `Bearer ${args.serviceRoleKey}`;
  const extraHeaders = workspaceWorkerHeaders(args.workerSecret, job.user_id);
  const charged = Number(job.credits_charged ?? 0);
  const currentResult =
    job.result && typeof job.result === "object"
      ? (job.result as Record<string, unknown>)
      : null;
  const currentAttempts = Math.max(0, Number(job.attempts ?? 0) || 0);
  const maxAttempts = Math.max(1, Number(job.max_attempts ?? TOTAL_MAX_RETRIES) || TOTAL_MAX_RETRIES);

  if (!currentResult?.task_id && currentAttempts >= maxAttempts) {
    const msg =
      `${workspaceJobProviderLabel(job)} could not finish after ${maxAttempts} attempts. ` +
      `${job.last_error ? `Last provider error: ${job.last_error}` : "Credits were refunded."}`;
    await failWorkspaceJob({
      supabase: args.supabase,
      job,
      status: "failed",
      error: msg,
      refundReason: `workspace job exhausted attempts: ${String(job.last_error ?? "").substring(0, 160)}`,
    });
    return { job_id: job.id, status: "failed", detail: "max_attempts_exhausted" };
  }

  if (currentResult?.task_id && !currentResult.url) {
    try {
      const outcome = await pollWorkspaceAsyncResultOnce({
        functionUrl: args.functionUrl,
        authHeader,
        extraHeaders,
        response: currentResult,
      });

      if (outcome.state === "succeeded") {
        await completeWorkspaceJob({ supabase: args.supabase, job, result: outcome.result });
        return { job_id: job.id, status: "completed" };
      }
      if (outcome.state === "failed") {
        const msg = outcome.message || `${job.provider ?? "provider"} task failed`;
        await failWorkspaceJob({
          supabase: args.supabase,
          job,
          status: "failed",
          error: msg,
          refundReason: `workspace async task failed: ${msg.substring(0, 160)}`,
        });
        return { job_id: job.id, status: "failed", detail: msg.substring(0, 120) };
      }

      const delaySeconds = workspaceJobPollDelaySeconds(currentResult);
      await scheduleWorkspaceJobRetry({
        supabase: args.supabase,
        job,
        workerId: args.workerId,
        message: outcome.state === "pending"
          ? (outcome.message || `Provider status: ${outcome.status}`)
          : "Waiting for provider result",
        delaySeconds,
      });
      return { job_id: job.id, status: "running", detail: "provider_pending" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const permanent = isPermanentWorkspaceJobError(msg);
      if (permanent) {
        await failWorkspaceJob({
          supabase: args.supabase,
          job,
          status: "permanent_failed",
          error: msg,
          refundReason: `workspace async polling failed: ${msg.substring(0, 160)}`,
        });
        return { job_id: job.id, status: "permanent_failed", detail: msg.substring(0, 120) };
      }
      await scheduleWorkspaceJobRetry({
        supabase: args.supabase,
        job,
        workerId: args.workerId,
        message: msg,
        delaySeconds: 30,
      });
      return { job_id: job.id, status: "running", detail: "poll_retry" };
    }
  }

  const attempt = currentAttempts + 1;
  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      attempts: attempt,
      started_at: job.started_at ?? new Date().toISOString(),
      worker_heartbeat_at: new Date().toISOString(),
      error: null,
      last_error: null,
      run_after: null,
    })
    .eq("id", job.id);

  try {
    const stopHeartbeat = startWorkspaceJobHeartbeat({
      supabase: args.supabase,
      jobId: job.id,
      workerId: args.workerId,
    });
    let initial: Record<string, unknown>;
    try {
      initial = await invokeWorkspaceRunOnce({
        functionUrl: args.functionUrl,
        authHeader,
        extraHeaders,
        body: job.request,
      });
    } finally {
      stopHeartbeat();
    }
    const initialWithCredits = {
      ...initial,
      credits_spent: Number.isFinite(charged) ? charged : 0,
    };
    const providerMeta =
      initial.provider_meta && typeof initial.provider_meta === "object"
        ? (initial.provider_meta as Record<string, unknown>)
        : {};

    if (initial.task_id && providerMeta.poll_endpoint && !initial.url) {
      await scheduleWorkspaceJobRetry({
        supabase: args.supabase,
        job,
        workerId: args.workerId,
        message: "Provider accepted the job and is processing.",
        delaySeconds: workspaceJobPollDelaySeconds(initialWithCredits),
        result: initialWithCredits,
      });
      return { job_id: job.id, status: "running", detail: "async_submitted" };
    }

    await completeWorkspaceJob({ supabase: args.supabase, job, result: initialWithCredits });
    return { job_id: job.id, status: "completed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentWorkspaceJobError(msg);
    if (permanent) {
      await failWorkspaceJob({
        supabase: args.supabase,
        job: { ...job, attempts: attempt, last_error: msg },
        status: "permanent_failed",
        error: msg,
        refundReason: `workspace job failed: ${msg.substring(0, 160)}`,
      });
      return { job_id: job.id, status: "permanent_failed", detail: msg.substring(0, 120) };
    }
    if (attempt >= maxAttempts) {
      const finalMsg =
        `${workspaceJobProviderLabel(job)} could not finish after ${maxAttempts} attempts. ` +
        `Last provider error: ${msg}`;
      await failWorkspaceJob({
        supabase: args.supabase,
        job: { ...job, attempts: attempt, last_error: msg },
        status: "failed",
        error: finalMsg,
        refundReason: `workspace job exhausted attempts: ${msg.substring(0, 160)}`,
      });
      return { job_id: job.id, status: "failed", detail: "max_attempts_exhausted" };
    }

    const delaySeconds = workspaceJobBackoffSeconds(attempt, job.provider);
    await args.supabase
      .from("workspace_generation_jobs")
      .update({
        status: "running",
        attempts: attempt,
        last_error: msg,
        worker_heartbeat_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    await releaseWorkspaceJobLock({
      supabase: args.supabase,
      jobId: job.id,
      workerId: args.workerId,
      runAfterSeconds: delaySeconds,
    });
    return { job_id: job.id, status: "running", detail: `retry_in_${delaySeconds}s` };
  }
}

async function expireWorkspaceGenerationJobs(args: {
  supabase: ReturnType<typeof createClient>;
}): Promise<number> {
  const { data, error } = await args.supabase
    .from("workspace_generation_jobs")
    .select("*")
    .in("status", ["queued", "running"])
    .lte("deadline_at", new Date().toISOString())
    .order("deadline_at", { ascending: true })
    .limit(WORKSPACE_JOB_EXPIRE_SWEEP_LIMIT);

  if (error) {
    console.error("[workspace-job-worker] expire query failed", error.message);
    return 0;
  }

  const jobs = (data ?? []) as WorkspaceJobRow[];
  for (const job of jobs) {
    const msg = `Provider queue was busy for ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes. Generation timed out and credits were refunded.`;
    try {
      await failWorkspaceJob({
        supabase: args.supabase,
        job,
        status: "failed",
        error: msg,
        refundReason: `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
      });
    } catch (err) {
      console.error(
        "[workspace-job-worker] expire failed",
        job.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return jobs.length;
}

async function runWorkspaceGenerationWorker(args: {
  supabase: ReturnType<typeof createClient>;
  functionUrl: string;
  serviceRoleKey: string;
  workerSecret: string;
  requestedJobId?: string | null;
}): Promise<Record<string, unknown>> {
  const workerId = `workspace-worker-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const expired = await expireWorkspaceGenerationJobs({ supabase: args.supabase });

  let jobs: WorkspaceJobRow[] = [];
  if (args.requestedJobId) {
    const { data, error } = await args.supabase.rpc("claim_workspace_generation_job", {
      p_job_id: args.requestedJobId,
      p_worker_id: workerId,
      p_lock_duration_sec: WORKSPACE_JOB_LOCK_SEC,
    });
    if (error) throw error;
    if (data) jobs = [data as WorkspaceJobRow];
  } else {
    const { data, error } = await args.supabase.rpc("claim_workspace_generation_jobs", {
      p_worker_id: workerId,
      p_batch_size: WORKSPACE_JOB_WORKER_BATCH_SIZE,
      p_lock_duration_sec: WORKSPACE_JOB_LOCK_SEC,
    });
    if (error) throw error;
    jobs = (data ?? []) as WorkspaceJobRow[];
  }

  const settled = await Promise.allSettled(
    jobs.map((job) =>
      processWorkspaceGenerationJobTick({
        supabase: args.supabase,
        job,
        workerId,
        functionUrl: args.functionUrl,
        serviceRoleKey: args.serviceRoleKey,
        workerSecret: args.workerSecret,
      }),
    ),
  );

  const results = settled.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    return {
      job_id: jobs[index]?.id ?? null,
      status: "worker_error",
      detail: item.reason instanceof Error ? item.reason.message : String(item.reason),
    };
  });

  return {
    worker: workerId,
    expired,
    claimed: jobs.length,
    results,
    duration_ms: Date.now() - startedAt,
  };
}

async function processWorkspaceGenerationJob(args: {
  supabase: any;
  jobId: string;
  userId: string;
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
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
  const budgetEndsAt = workspaceJobDeadlineMs(job);
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
      .update({ status: "running", attempts: attempt, last_error: null, run_after: null })
      .eq("id", job.id);

    try {
      const initial = await invokeWorkspaceRunOnce({
        functionUrl: args.functionUrl,
        authHeader: args.authHeader,
        extraHeaders: args.extraHeaders,
        body: request,
      });
      const charged = Number(job.credits_charged ?? 0);
      const initialWithCredits = {
        ...initial,
        credits_spent: Number.isFinite(charged) ? charged : 0,
      };
      const providerMeta =
        initial.provider_meta && typeof initial.provider_meta === "object"
          ? (initial.provider_meta as Record<string, unknown>)
          : {};
      if (initial.task_id && providerMeta.poll_endpoint && !initial.url) {
        await args.supabase
          .from("workspace_generation_jobs")
          .update({
            status: "running",
            result: initialWithCredits,
            error: null,
            last_error: null,
          })
          .eq("id", job.id);
      }
      const finalResult = await pollWorkspaceAsyncResult({
        functionUrl: args.functionUrl,
        authHeader: args.authHeader,
        extraHeaders: args.extraHeaders,
        response: initialWithCredits,
        budgetEndsAt,
      });
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
          last_error: lastError,
          ...(permanent
            ? {
                error: lastError,
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
      const backoff = workspaceJobBackoffMs(attempt, job.provider);
      if (remaining < backoff + 1_000) break;
      if (job.provider === "banana") {
        await args.supabase
          .from("workspace_generation_jobs")
          .update({
            status: "running",
            attempts: attempt,
            last_error: lastError,
            run_after: new Date(Date.now() + backoff).toISOString(),
          })
          .eq("id", job.id);
        return;
      }
      await sleep(backoff);
    }
  }

  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "failed",
      error:
        lastError ||
        `Generation timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
      last_error: lastError || null,
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

function parseSupabaseStorageUrl(
  rawUrl: string,
  supabaseUrl: string,
): { bucket: string; path: string } | null {
  try {
    const url = new URL(rawUrl);
    const expectedHost = new URL(supabaseUrl).hostname;
    if (url.hostname !== expectedHost) return null;
    const match = url.pathname.match(
      /^\/storage\/v1\/object\/(?:sign|public)\/([^/]+)\/(.+)$/,
    );
    if (!match) return null;
    const bucket = decodeURIComponent(match[1]);
    const path = decodeURIComponent(match[2]);
    if (!bucket || !path || path.split("/").some((part) => part === "..")) {
      return null;
    }
    return { bucket, path };
  } catch {
    return null;
  }
}

function collectUrlStrings(value: unknown, output = new Set<string>(), depth = 0): Set<string> {
  if (depth > 4 || value == null) return output;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) output.add(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectUrlStrings(item, output, depth + 1);
    }
  }
  return output;
}

async function validateVeoFrameInputs(
  supabaseClient: ReturnType<typeof createClient>,
  inputs: unknown,
  supabaseUrl: string,
): Promise<string | null> {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return null;
  const frameInputs = inputs as Record<string, unknown>;
  for (const key of ["start_frame", "end_frame"]) {
    const raw = frameInputs[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value !== "string" || value.startsWith("data:")) continue;
      const parsed = parseSupabaseStorageUrl(value, supabaseUrl);
      if (!parsed) continue;
      const { data, error } = await supabaseClient.storage
        .from(parsed.bucket)
        .download(parsed.path);
      if (error || !data) {
        return "Reference image is no longer available. Please select or upload the image again before generating Veo.";
      }
    }
  }
  return null;
}

function isOwnWorkspaceStoragePath(bucket: string, path: string, userId: string): boolean {
  if (!bucket || !path || path.split("/").some((part) => part === "..")) return false;
  if (bucket === "user_assets") {
    return path.startsWith(`${userId}/`) || path.startsWith(`tts/${userId}/`);
  }
  if (bucket === "ai-media") {
    return path.startsWith(`${userId}/`) || path.startsWith(`tripo3d-mirror/${userId}/`);
  }
  return false;
}

function addStoragePointer(
  pointers: Map<string, string>,
  bucket: unknown,
  path: unknown,
  userId: string,
) {
  const b = String(bucket ?? "").trim();
  const p = String(path ?? "").trim().replace(/^\/+/, "");
  if (!isOwnWorkspaceStoragePath(b, p, userId)) return;
  pointers.set(`${b}:${p}`, `${b}\n${p}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let activeCreditCharge: WorkspaceCreditCharge | null = null;
  let activeUserId: string | null = null;
  let activeBody: WorkspaceRunBody | null = null;

  try {
    /* ─── Auth ─────────────────────────────────────────────── */
    let authHeader = req.headers.get("authorization") ?? "";
    if (
      !authHeader &&
      !req.headers.get("x-cron-secret") &&
      !req.headers.get("x-workspace-worker-secret")
    ) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = (await req.json()) as WorkspaceRunBody;
    activeBody = body;
    const workerSecret = await verifyWorkspaceWorkerSecret(supabase, req);

    if (body.action === "run_workspace_job_worker") {
      if (!workerSecret) {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const summary = await runWorkspaceGenerationWorker({
        supabase,
        functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
        workerSecret,
        requestedJobId: body.job_id ?? null,
      });
      return new Response(
        JSON.stringify(summary),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let user: { id: string; email?: string | null } | null = null;
    const workerUserId = req.headers.get("x-workspace-worker-user-id") ?? "";
    if (workerSecret && workerUserId) {
      user = await loadWorkspaceWorkerUser(supabase, workerUserId);
      authHeader = authHeader || `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    } else {
      const token = String(authHeader ?? "").replace("Bearer ", "");
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authUser) {
        return new Response(
          JSON.stringify({ error: "Invalid token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      user = { id: authUser.id, email: authUser.email ?? null };
    }
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Invalid worker user" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    activeUserId = user.id;

    /* ─── Parse body ───────────────────────────────────────── */
    if (body.action === "delete_workspace_asset") {
      const source = String(body.asset_source ?? "").trim();
      const assetId = String(body.asset_id ?? body.job_id ?? "")
        .trim()
        .replace(/^job-/, "")
        .replace(/^user-asset-/, "");
      const storagePointers = new Map<string, string>();
      addStoragePointer(storagePointers, body.storage_bucket, body.storage_path, user.id);
      const parsedBodyUrl = body.url ? parseSupabaseStorageUrl(String(body.url), SUPABASE_URL) : null;
      if (parsedBodyUrl) addStoragePointer(storagePointers, parsedBodyUrl.bucket, parsedBodyUrl.path, user.id);

      let deletedRows = 0;
      if (source === "generation") {
        if (!assetId) {
          return new Response(
            JSON.stringify({ error: "asset_id required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const { data: job, error: jobError } = await supabase
          .from("workspace_generation_jobs")
          .select("id,user_id,result")
          .eq("id", assetId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (jobError) {
          return new Response(
            JSON.stringify({ error: jobError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!job) {
          return new Response(
            JSON.stringify({ error: "Asset not found" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        for (const rawUrl of collectUrlStrings((job as { result?: unknown }).result)) {
          const parsed = parseSupabaseStorageUrl(rawUrl, SUPABASE_URL);
          if (parsed) addStoragePointer(storagePointers, parsed.bucket, parsed.path, user.id);
        }
        const { data: deleted, error: deleteError } = await supabase
          .from("workspace_generation_jobs")
          .delete()
          .eq("id", assetId)
          .eq("user_id", user.id)
          .select("id");
        if (deleteError) {
          return new Response(
            JSON.stringify({ error: deleteError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        deletedRows = deleted?.length ?? 0;
      } else if (source === "user_asset") {
        if (!assetId) {
          return new Response(
            JSON.stringify({ error: "asset_id required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const { data: row, error: rowError } = await supabase
          .from("user_assets")
          .select("*")
          .eq("id", assetId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (rowError) {
          return new Response(
            JSON.stringify({ error: rowError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!row) {
          return new Response(
            JSON.stringify({ error: "Asset not found" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        for (const rawUrl of collectUrlStrings(row)) {
          const parsed = parseSupabaseStorageUrl(rawUrl, SUPABASE_URL);
          if (parsed) addStoragePointer(storagePointers, parsed.bucket, parsed.path, user.id);
        }
        const { data: deleted, error: deleteError } = await supabase
          .from("user_assets")
          .delete()
          .eq("id", assetId)
          .eq("user_id", user.id)
          .select("id");
        if (deleteError) {
          return new Response(
            JSON.stringify({ error: deleteError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        deletedRows = deleted?.length ?? 0;
      } else if (source !== "upload") {
        return new Response(
          JSON.stringify({ error: "Unsupported asset source" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const removedStorage: Array<{ bucket: string; path: string }> = [];
      for (const value of storagePointers.values()) {
        const [bucket, path] = value.split("\n");
        const { error: removeError } = await supabase.storage.from(bucket).remove([path]);
        if (!removeError) removedStorage.push({ bucket, path });
      }

      return new Response(
        JSON.stringify({ ok: true, deleted_rows: deletedRows, removed_storage: removedStorage }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "refresh_storage_url") {
      const srcUrl = String(body.url ?? "").trim();
      const parsed = parseSupabaseStorageUrl(srcUrl, SUPABASE_URL);
      if (!parsed) {
        return new Response(
          JSON.stringify({ error: "A valid Supabase storage URL is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const ownUserAsset =
        parsed.bucket === "user_assets" &&
        (parsed.path.startsWith(`${user.id}/`) ||
          parsed.path.startsWith(`tts/${user.id}/`));
      const ownAiMedia =
        parsed.bucket === "ai-media" &&
        (parsed.path.startsWith(`${user.id}/`) ||
          parsed.path.startsWith(`tripo3d-mirror/${user.id}/`));

      if (!ownUserAsset && !ownAiMedia) {
        return new Response(
          JSON.stringify({ error: "Storage URL does not belong to this account." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: signed, error: signError } = await supabase.storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.path, 60 * 60 * 24 * 365);
      if (signError || !signed?.signedUrl) {
        return new Response(
          JSON.stringify({ error: signError?.message ?? "Could not refresh signed URL." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          url: signed.signedUrl,
          signed_url: signed.signedUrl,
          bucket: parsed.bucket,
          storage_path: parsed.path,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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

    if (body.action === "poll_workspace_job") {
      const jobId = String(body.job_id ?? "").trim();
      if (!jobId) {
        return new Response(
          JSON.stringify({ error: "job_id required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const loadJob = async () => {
        const { data: job, error } = await supabase
          .from("workspace_generation_jobs")
          .select("*")
          .eq("id", jobId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (error) throw error;
        return job as WorkspaceJobRow | null;
      };

      let job = await loadJob();
      if (!job) {
        return new Response(
          JSON.stringify({ error: "job not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (
        !["completed", "failed", "permanent_failed"].includes(job.status) &&
        Date.now() >= workspaceJobDeadlineMs(job)
      ) {
        const msg = `Provider queue was busy for ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes. Generation timed out and credits were refunded.`;
        await failWorkspaceJob({
          supabase,
          job,
          status: "failed",
          error: msg,
          refundReason: `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
        });
        job = await loadJob();
        if (!job) {
          return new Response(
            JSON.stringify({ error: "job not found" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      if (["completed", "failed", "permanent_failed"].includes(job.status)) {
        return new Response(
          JSON.stringify({ job }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const currentResult =
        job.result && typeof job.result === "object"
          ? (job.result as Record<string, unknown>)
          : null;
      if (!currentResult?.task_id) {
        return new Response(
          JSON.stringify({ job }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      try {
        const outcome = await pollWorkspaceAsyncResultOnce({
          functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
          authHeader,
          response: currentResult,
        });

        if (outcome.state === "succeeded") {
          const charged = Number(job.credits_charged ?? 0);
          await completeWorkspaceJob({
            supabase,
            job,
            result: {
              ...outcome.result,
              credits_spent: Number.isFinite(charged) ? charged : 0,
            },
          });
        } else if (outcome.state === "failed") {
          const msg = outcome.message;
          await failWorkspaceJob({
            supabase,
            job,
            status: "failed",
            error: msg,
            refundReason: `workspace async task failed: ${msg.substring(0, 160)}`,
          });
        } else if (outcome.state === "pending") {
          await supabase
            .from("workspace_generation_jobs")
            .update({
              status: "running",
              last_error: outcome.message
                ? outcome.message.substring(0, 1000)
                : `Provider status: ${outcome.status}`,
            })
            .eq("id", job.id);
        }

        job = await loadJob();
        return new Response(
          JSON.stringify({ job }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("workspace_generation_jobs")
          .update({
            status: "running",
            last_error: msg,
          })
          .eq("id", job.id);
        job = await loadJob();
        return new Response(
          JSON.stringify({ job, warning: msg.substring(0, 300) }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (body.action === "enqueue_workspace_job") {
      const nodeType = String(body.node_type ?? "").trim();
      if (!nodeType) {
        return new Response(
          JSON.stringify({ error: "node_type is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Rate limit check temporarily disabled — was added in the
      // security audit pass but caused intermittent 500s for some
      // users (root cause TBD; possibly an interaction with the
      // service-role-scoped RPC + RLS context). Provider billing
      // protection is now relying on:
      //   1. Client-side button-state debounce
      //   2. Per-user advisory_xact_lock inside consume_credits
      //   3. Stripe billing alerts on the provider side
      // Will re-introduce after a focused investigation — see audit
      // Tier-2 follow-ups list.

      const { action: _action, job_id: _jobId, ...runRequest } = body;
      const provider = getProviderForNodeType(
        nodeType,
        runRequest.params?.model_name as string | undefined,
      );
      const model = String(
        runRequest.params?.model_name ??
          runRequest.params?.model ??
          nodeType,
      );
      enforcePrimaryProviderParams(provider, runRequest.params);
      if (provider === "veo") {
        const frameInputError = await validateVeoFrameInputs(
          supabase,
          runRequest.inputs,
          SUPABASE_URL,
        );
        if (frameInputError) {
          return new Response(
            JSON.stringify({ error: frameInputError }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
      let jobCharge: WorkspaceCreditCharge | null = null;
      try {
        jobCharge = await consumeWorkspaceCredits({
          supabase,
          userId: user.id,
          userEmail: user.email ?? null,
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
            credit_scope: jobCharge?.scope ?? "user",
            credit_organization_id: jobCharge?.organizationId ?? null,
            credit_class_id: jobCharge?.classId ?? null,
          },
          status: "queued",
          run_after: new Date().toISOString(),
          deadline_at: new Date(Date.now() + WORKSPACE_JOB_MAX_MS).toISOString(),
          max_attempts: workspaceJobMaxAttempts(provider),
          credits_charged: jobCharge?.amount ?? 0,
          credit_team_id: jobCharge?.teamId ?? null,
          credit_organization_id: jobCharge?.organizationId ?? null,
          credit_class_id: jobCharge?.classId ?? null,
          credit_scope: jobCharge?.scope ?? "user",
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
      const immediateWorkerSecret = await getWorkspaceWorkerSecret(supabase);
      const bgTask = immediateWorkerSecret
        ? runWorkspaceGenerationWorker({
            supabase,
            functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
            serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
            workerSecret: immediateWorkerSecret,
            requestedJobId: jobId,
          })
        : processWorkspaceGenerationJob({
            supabase,
            jobId,
            userId: user.id,
            functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
            authHeader,
          });
      const guardedBgTask = bgTask.catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[workspace-job] bg crash job=${jobId}: ${msg}`);
        const { data: crashedJob } = await supabase
          .from("workspace_generation_jobs")
          .select("*")
          .eq("id", jobId)
          .maybeSingle();
        if (crashedJob) {
          const typedJob = crashedJob as WorkspaceJobRow;
          if (["completed", "failed", "permanent_failed"].includes(String(typedJob.status))) {
            return;
          }
          if (hasRecoverableAsyncResult(typedJob)) {
            await supabase
              .from("workspace_generation_jobs")
              .update({
                status: "running",
                error: null,
                last_error:
                  "Background worker stopped before the provider finished; durable worker will continue polling.",
                locked_by: null,
                lock_expires_at: null,
                run_after: new Date(Date.now() + 15_000).toISOString(),
              })
              .eq("id", jobId);
            return;
          }
          await refundWorkspaceJobCharge({
            supabase,
            job: typedJob,
            reason: `workspace job crashed: ${msg.substring(0, 160)}`,
          });
        }
        await supabase
          .from("workspace_generation_jobs")
          .update({
            status: "failed",
            error: msg,
            last_error: msg,
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      });
      const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(guardedBgTask);
      else guardedBgTask.catch((e) => console.error("[workspace-job][bg-fallback]", e));

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
        const fileName = `tripo3d-mirror/${user.id}/mediaforge_${hashHex}.${ext}`;

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
        const seedanceBaseHost = new URL(SEEDANCE_BASE).hostname;
        // Volcengine/BytePlus Ark hosts are allowed; path must be
        // exactly the tasks endpoint (we append /{taskId} below).
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === seedanceBaseHost ||
            u.hostname === "ark.cn-beijing.volces.com" ||
            u.hostname.endsWith(".bytepluses.com") ||
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
        const pollModel = String(body.model ?? body.provider_model_id ?? "").toLowerCase();
        const isV2Poll = pollModel.includes("seedance-2-0");
        creds = loadSeedanceCredentials({ v2: isV2Poll });
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

    /* ─── Async poll path (Freepik/Magnific Veo 3.1 tasks) ───
     * Used as a capacity fallback when direct Google Gemini Veo quota is
     * exhausted. Magnific returns { data: { status, generated[] } }; on
     * terminal success we mirror the provider URL into Supabase storage so
     * the browser sees the same signed-URL shape as direct Veo. */
    if (body.action === "poll_replicate_veo" || body.action === "poll_replicate_video") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      const isReplicateVeoPoll = body.action === "poll_replicate_veo";
      const replicateLabel = isReplicateVeoPoll ? "Replicate Veo" : "Replicate video";
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for Replicate polling" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === "api.replicate.com" &&
          /^\/v1\/predictions\/?$/.test(u.pathname);
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Replicate predictions endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const apiToken = Deno.env.get("REPLICATE_API_TOKEN")?.trim();
      if (!apiToken) {
        return new Response(
          JSON.stringify({ error: "REPLICATE_API_TOKEN is not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let payload: Record<string, unknown>;
      try {
        const r = await fetch(`${pollEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const text = await r.text();
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              status: "polling_error",
              message: `${replicateLabel} poll failed (HTTP ${r.status}): ${text.slice(0, 300)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
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

      const rawStatus = String(payload.status ?? "").toLowerCase();
      const providerVideoUrl = extractReplicateOutputUrl(payload.output);
      const normalised =
        rawStatus === "succeeded" || providerVideoUrl
          ? "succeed"
          : rawStatus === "failed" || rawStatus === "canceled" || rawStatus === "cancelled"
            ? "failed"
            : "processing";
      const errorMessage = String(payload.error ?? "");

      let publicUrl = "";
      if (normalised === "succeed" && providerVideoUrl) {
        try {
          const videoRes = await fetch(providerVideoUrl);
          if (!videoRes.ok) {
            throw new Error(`download HTTP ${videoRes.status}`);
          }
          const bytes = new Uint8Array(await videoRes.arrayBuffer());
          const contentType = videoRes.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const folder = isReplicateVeoPoll ? "veo-renders" : "replicate-video-renders";
          const path = `${user.id}/${folder}/replicate_${safeTaskId}.mp4`;
          const upload = await supabase.storage
            .from("user_assets")
            .upload(path, bytes, { contentType, upsert: true });
          if (upload.error) throw upload.error;
          const signed = await supabase.storage
            .from("user_assets")
            .createSignedUrl(path, 60 * 60 * 24 * 365);
          if (signed.error || !signed.data?.signedUrl) {
            throw signed.error ?? new Error("no signed URL");
          }
          publicUrl = signed.data.signedUrl;
        } catch (err) {
          console.error("[poll_replicate] rehost failed:", err);
          return new Response(
            JSON.stringify({
              status: "failed",
              task_id: taskId,
              url: "",
              message: `${replicateLabel} finished but the video couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
          message: normalised === "failed" ? errorMessage || `${replicateLabel} task failed` : rawStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "poll_freepik_veo" || body.action === "poll_freepik_video") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_freepik_video" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === "api.magnific.com" || u.hostname === "api.freepik.com") &&
          /^\/v1\/ai\/(?:text-to-video|image-to-video|reference-to-video)\/(?:veo-3-1(?:-fast)?|seedance-(?:pro|lite)-(?:480p|720p|1080p)|seedance-1-5-pro-(?:480p|720p|1080p))\/?$/.test(
            u.pathname,
          );
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Magnific/Freepik video endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let apiKey: string;
      try {
        apiKey = loadMagnificApiKey();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const pollUrl = `${pollEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`;
      let payload: Record<string, unknown>;
      try {
        const endpointHost = new URL(pollEndpoint).hostname;
        const authHeaderName = endpointHost.includes("magnific.com")
          ? "x-magnific-api-key"
          : "x-freepik-api-key";
        const r = await fetch(pollUrl, {
          method: "GET",
          headers: {
            [authHeaderName]: apiKey,
          },
        });
        const text = await r.text();
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              status: "polling_error",
              message: `Freepik/Magnific video poll failed (HTTP ${r.status}): ${text.slice(0, 300)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
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

      const data = payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : payload;
      const rawStatus = String(data.status ?? payload.status ?? "").toUpperCase();
      const generated = Array.isArray(data.generated)
        ? data.generated
        : Array.isArray(payload.generated)
          ? payload.generated
          : [];
      const providerVideoUrl = generated
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const row = item as Record<string, unknown>;
            return String(row.url ?? row.video_url ?? row.download_url ?? "").trim();
          }
          return "";
        })
        .find((url) => /^https:\/\//i.test(url)) ?? "";
      const errorMessage = String(
        data.error ??
          data.message ??
          payload.error ??
          payload.message ??
          "",
      );
      const normalised =
        rawStatus === "COMPLETED" || rawStatus === "DONE" || rawStatus === "SUCCEEDED" || providerVideoUrl
          ? "succeed"
          : rawStatus === "FAILED" || rawStatus === "ERROR" || rawStatus === "CANCELLED" || rawStatus === "CANCELED"
            ? "failed"
            : "processing";

      let publicUrl = "";
      if (normalised === "succeed" && providerVideoUrl) {
        try {
          const videoRes = await fetch(providerVideoUrl);
          if (!videoRes.ok) {
            throw new Error(`download HTTP ${videoRes.status}`);
          }
          const bytes = new Uint8Array(await videoRes.arrayBuffer());
          const contentType = videoRes.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const path = `${user.id}/video-renders/freepik_${safeTaskId}.mp4`;
          const upload = await supabase.storage
            .from("user_assets")
            .upload(path, bytes, { contentType, upsert: true });
          if (upload.error) throw upload.error;
          const signed = await supabase.storage
            .from("user_assets")
            .createSignedUrl(path, 60 * 60 * 24 * 365);
          if (signed.error || !signed.data?.signedUrl) {
            throw signed.error ?? new Error("no signed URL");
          }
          publicUrl = signed.data.signedUrl;
        } catch (err) {
          console.error("[poll_freepik_video] rehost failed:", err);
          return new Response(
            JSON.stringify({
              status: "failed",
              task_id: taskId,
              url: "",
              message: `Freepik/Magnific video finished but the video couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
          message: normalised === "failed" ? errorMessage || "Freepik/Magnific Veo task failed" : rawStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Google Veo 3.1 video tasks) ─────────
     * Veo's REST API is a long-running operation: we POSTed a task
     * and got back a Gemini operation name (returned to the frontend
     * in `task_id`). Each poll is a GET against generativelanguage
     * with the API key. The frontend uses the same polling hook as
     * Kling/Seedance — we normalise statuses and surface the video URL
     * once the operation reports `done: true`. */
    if (body.action === "poll_freepik_image") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_freepik_image" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === "api.magnific.com" || u.hostname === "api.freepik.com") &&
          /^\/v1\/ai\/text-to-image\/(?:nano-banana-pro|nano-banana-pro-flash)\/?$/.test(u.pathname);
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Magnific/Freepik Banana image endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let apiKey: string;
      try {
        apiKey = loadMagnificApiKey();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const pollUrl = `${pollEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`;
      let payload: Record<string, unknown>;
      try {
        const endpointHost = new URL(pollEndpoint).hostname;
        const authHeaderName = endpointHost.includes("magnific.com")
          ? "x-magnific-api-key"
          : "x-freepik-api-key";
        const r = await fetch(pollUrl, {
          method: "GET",
          headers: {
            [authHeaderName]: apiKey,
          },
        });
        const text = await r.text();
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              status: "polling_error",
              message: `Freepik/Magnific Banana poll failed (HTTP ${r.status}): ${text.slice(0, 300)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
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

      const data = payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : payload;
      const rawStatus = String(data.status ?? payload.status ?? "").toUpperCase();
      const generated = Array.isArray(data.generated)
        ? data.generated
        : Array.isArray(payload.generated)
          ? payload.generated
          : [];
      const providerImageUrl = extractProviderMediaUrl(generated);
      const errorMessage = String(
        data.error ??
          data.message ??
          payload.error ??
          payload.message ??
          "",
      );
      const normalised =
        rawStatus === "COMPLETED" || rawStatus === "DONE" || rawStatus === "SUCCEEDED" || providerImageUrl
          ? "succeed"
          : rawStatus === "FAILED" || rawStatus === "ERROR" || rawStatus === "CANCELLED" || rawStatus === "CANCELED"
            ? "failed"
            : "processing";

      let publicUrl = "";
      if (normalised === "succeed" && providerImageUrl) {
        try {
          const imageRes = await fetch(providerImageUrl);
          if (!imageRes.ok) {
            throw new Error(`download HTTP ${imageRes.status}`);
          }
          const bytes = new Uint8Array(await imageRes.arrayBuffer());
          const contentType = imageRes.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
          const ext =
            contentType.includes("jpeg") ? "jpg" :
            contentType.includes("webp") ? "webp" :
            contentType.includes("png") ? "png" :
            "png";
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const path = `pipeline/magnific_banana_${safeTaskId}.${ext}`;
          const upload = await supabase.storage
            .from("ai-media")
            .upload(path, bytes, { contentType, upsert: true });
          if (upload.error) throw upload.error;
          const signed = await supabase.storage
            .from("ai-media")
            .createSignedUrl(path, 60 * 60 * 24 * 7);
          if (signed.error || !signed.data?.signedUrl) {
            throw signed.error ?? new Error("no signed URL");
          }
          publicUrl = signed.data.signedUrl;
        } catch (err) {
          console.error("[poll_freepik_image] rehost failed:", err);
          return new Response(
            JSON.stringify({
              status: "failed",
              task_id: taskId,
              url: "",
              message: `Freepik/Magnific Banana finished but the image couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
          message: normalised === "failed" ? errorMessage || "Freepik/Magnific Banana task failed" : rawStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "poll_veo") {
      const taskId = normalizeVeoOperationName(String(body.task_id ?? ""));
      if (!taskId) {
        return new Response(
          JSON.stringify({
            error:
              "task_id must be a Veo operation name (operations/... or models/.../operations/...)",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let apiKey: string;
      try {
        const apiKeyAlias = String(body.api_key_alias ?? "") === "gemini2" ? "gemini2" : "primary";
        apiKey = loadVeoApiKey(apiKeyAlias);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let statusObj;
      try {
        statusObj = await pollVeoOnce(taskId, apiKey);
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
      const isDone = statusObj.done === true;
      const videoUri = extractVeoVideoUri(statusObj);
      const opError = statusObj.error ? formatVeoPollFailure(statusObj) : "";
      const normalised = !isDone
        ? "processing"
        : opError
          ? "failed"
          : videoUri
            ? "succeed"
            : "failed";

      // Veo's `video.uri` requires the API key as `?key=` to download.
      // We never want that key exposed to the browser, so on success
      // we fetch the bytes server-side and re-host into the
      // `user_assets` Supabase bucket. The frontend gets a 1-year
      // signed URL — same pattern Google TTS uses for synthesised
      // audio. The taskId (operations/<id>) gives us a stable,
      // collision-free path so a second poll after success doesn't
      // re-upload (upsert: false would 409, which is fine — the
      // existing object stays usable).
      let publicUrl = "";
      if (normalised === "succeed" && videoUri) {
        try {
          const downloadUrl = `${videoUri}${videoUri.includes("?") ? "&" : "?"}key=${apiKey}`;
          const videoRes = await fetch(downloadUrl);
          if (!videoRes.ok) {
            throw new Error(`download HTTP ${videoRes.status}`);
          }
          const bytes = new Uint8Array(await videoRes.arrayBuffer());
          const opId = taskId.replace(/^operations\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
          const path = `veo-renders/mediaforge_${opId}.mp4`;
          const upload = await supabase.storage
            .from("user_assets")
            .upload(path, bytes, { contentType: "video/mp4", upsert: true });
          if (upload.error) throw upload.error;
          const signed = await supabase.storage
            .from("user_assets")
            .createSignedUrl(path, 60 * 60 * 24 * 365);
          if (signed.error || !signed.data?.signedUrl) {
            throw signed.error ?? new Error("no signed URL");
          }
          publicUrl = signed.data.signedUrl;
        } catch (err) {
          console.error("[poll_veo] rehost failed:", err);
          return new Response(
            JSON.stringify({
              status: "failed",
              task_id: taskId,
              url: "",
              message: `Veo finished but the video couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      const message =
        opError || (normalised === "failed" ? formatVeoPollFailure(statusObj) : "");
      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
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
            const fileName = `tripo3d/${taskId}/mediaforge_${Date.now()}.${ext}`;
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
        const handleDef = normalizeHandleForModel(
          provider,
          targetHandle,
          String(params.model_name ?? params.model ?? ""),
        );
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

      const handleDef = normalizeHandleForModel(
        provider,
        targetHandle,
        String(params.model_name ?? params.model ?? ""),
      );
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
          if (provider === "tripo3d") {
            const existing = Array.isArray(params.image_urls)
              ? (params.image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
              : [];
            const merged = Array.from(new Set([...existing, ...stringVals]));
            params.image_urls = merged;
            if (!params[handleDef.internal_key]) {
              params[handleDef.internal_key] = merged[0];
            }
            continue;
          }
          if (!params[handleDef.internal_key]) {
            params[handleDef.internal_key] = stringVals[0];
          }
        } else if (handleDef.internal_key === "reference_image_urls" && handleDef.data_type === "image") {
          appendUniqueStringParam(params, "reference_image_urls", stringVals, 9);
        } else if (handleDef.internal_key === "ref_image_urls" && handleDef.data_type === "image") {
          appendUniqueStringParam(params, "ref_image_urls", stringVals, 7);
        } else if (handleDef.internal_key === "reference_video_urls" && handleDef.data_type === "video") {
          appendUniqueStringParam(params, "reference_video_urls", stringVals, 3);
        } else if (handleDef.internal_key === "reference_audio_urls" && handleDef.data_type === "audio") {
          appendUniqueStringParam(params, "reference_audio_urls", stringVals, 3);
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
    if (provider !== "kling" && (mentionImageUrls.length > 0 || edgeImageUrls.length > 0)) {
      if (provider === "banana" || provider === "openai") {
        const merged = Array.from(new Set([
          ...((params.mention_image_urls as string[] | undefined) ?? []),
          ...mentionImageUrls,
          ...edgeImageUrls,
        ]));
        params.mention_image_urls = merged;
        if (!params.image_url) params.image_url = merged[0];
      } else if (provider === "tripo3d") {
        const existing = Array.isArray(params.image_urls)
          ? (params.image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
          : [];
        const merged = Array.from(new Set([
          ...existing,
          ...mentionImageUrls,
          ...edgeImageUrls,
        ]));
        params.image_urls = merged;
        if (!params.image_url) params.image_url = merged[0];
      } else if (provider === "seedance" || provider === "replicate_video") {
        const model = String(params.model_name ?? params.model ?? "").toLowerCase();
        const isSeedanceV2 =
          model.startsWith("seedance-2-0") ||
          model.startsWith("dreamina-seedance-2-0") ||
          model.startsWith("replicate-seedance-2-0");
        if (isSeedanceV2) {
          const hasKeyframeInput = Boolean(
            params.image_url ||
              params.start_frame ||
              params.image_tail_url ||
              params.end_frame,
          );
          if (!hasKeyframeInput) {
            const existing = Array.isArray(params.reference_image_urls)
              ? (params.reference_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
              : typeof params.reference_image_urls === "string"
                ? [params.reference_image_urls]
                : [];
            const merged = Array.from(new Set([...existing, ...mentionImageUrls, ...edgeImageUrls])).slice(0, 9);
            if (merged.length > 0) params.reference_image_urls = merged;
          }
        } else if (!params.image_url) {
          params.image_url = mentionImageUrls[0] ?? edgeImageUrls[0];
        }
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
    enforcePrimaryProviderParams(provider, params);

    activeCreditCharge = await consumeWorkspaceCredits({
      supabase,
      userId: user.id,
      userEmail: user.email ?? null,
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
        result = await executeGeminiTts(params, supabase, user.id);
        break;
      case "elevenlabs_tts":
        // ElevenLabs TTS — direct call into ElevenLabs API,
        // mirrors executeGoogleTts in shape (synth → upload →
        // user_assets row). Requires ELEVEN_API_KEY or
        // ELEVENLABS_API_KEY in Supabase project secrets.
        result = await executeElevenLabsTts(params, supabase, user.id);
        break;
      case "seedance":
        result = await executeSeedance(params);
        break;
      case "replicate_video":
        result = await executeReplicateVideo(params);
        break;
      case "veo":
        result = await executeVeo(params, supabase);
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
      organizationId: activeCreditCharge?.organizationId ?? body.credit_organization_id ?? null,
      classId: activeCreditCharge?.classId ?? body.credit_class_id ?? null,
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
