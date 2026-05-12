/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bytesToBase64, fetchImageBuffer } from "./imageUtils.ts";
import {
  canUseReplicateVeo,
  loadMagnificApiKey,
  MAGNIFIC_BASE,
  shouldPreferMagnificVeo,
  shouldPreferReplicateVeo,
} from "./magnific.ts";
import {
  audioPreferenceParam,
  canUseGemini2Veo,
  shouldFallbackVeoQuota,
  shouldGenerateFallbackVeoAudio,
} from "./providerParams.ts";
import { shouldFastFallbackProviderError } from "./providerRetry.ts";
import type { ProviderResult } from "./providerResult.ts";
import { parseSupabaseStorageUrl } from "./storageUrl.ts";
import {
  buildVeoRequest,
  fetchImageAsInline,
  loadVeoApiKey,
  submitVeoTask,
  VEO_BASE,
  VEO_MODEL_MAP,
  type VeoApiKeyAlias,
  type VeoAspectRatio,
  type VeoDuration,
  type VeoImage,
  type VeoPersonGeneration,
  type VeoResolution,
} from "./veo.ts";

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

export async function executeVeo(
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
  let durationSeconds: VeoDuration =
    durationNum <= 4 ? 4 : durationNum <= 6 ? 6 : 8;

  const startFrameUrl = (params.start_frame ?? params.image_url) as
    | string
    | undefined;
  const endFrameUrl = (params.end_frame ?? params.image_tail_url) as
    | string
    | undefined;
  if (endFrameUrl && !startFrameUrl) {
    throw new Error("Veo end_frame requires a start_frame.");
  }
  if (endFrameUrl && durationSeconds !== 8) {
    console.warn(
      `[veo] forcing duration to 8s because Veo interpolation ` +
        `(start_frame + end_frame) only supports 8s (requested=${durationSeconds}s)`,
    );
    durationSeconds = 8;
  }
  if (resolution === "1080p" && durationSeconds !== 8) {
    console.warn(
      `[veo] downgrading resolution to 720p because 1080p only supports 8s ` +
        `(requested=${durationSeconds}s)`,
    );
    resolution = "720p";
  }
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

  let operationName = "";
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
        if (shouldFastFallbackProviderError(gemini2Message) && canUseReplicateVeo()) {
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
 * executeRemoveBgReplicate_legacy — original Replicate BiRefNet path.
 * Kept available for rollback. Not wired in the dispatcher.
 *
 * To re-enable: change the `case "remove_bg":` branches below to call
 * executeRemoveBgReplicate_legacy(params, ...) instead of executeRemoveBg.
 */
async function executeRemoveBgReplicate_legacy(
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

  console.log(`[remove-bg-pipeline] (legacy) Calling remove-background edge fn`);

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

export function extractReplicateOutputUrl(value: unknown): string {
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

export async function executeReplicateVeo(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Replicate Veo 3.1 requires a prompt.");
  }

  const rawAspect = String(params.aspect_ratio ?? params.ratio ?? "16:9");
  const aspectRatio: VeoAspectRatio = rawAspect === "9:16" ? "9:16" : "16:9";
  const rawRes = String(params.resolution ?? "720p");
  let resolution: VeoResolution = rawRes === "1080p" ? "1080p" : "720p";
  const rawDuration = params.duration;
  const durationNum =
    typeof rawDuration === "number"
      ? rawDuration
      : parseInt(String(rawDuration ?? "8"), 10) || 8;
  const durationSeconds: VeoDuration =
    durationNum <= 4 ? 4 : durationNum <= 6 ? 6 : 8;
  if (resolution === "1080p" && durationSeconds !== 8) {
    resolution = "720p";
  }

  return await submitReplicateVeoTask({
    prompt,
    negativePrompt: String(params.negative_prompt ?? "").trim() || undefined,
    startFrameUrl: (params.start_frame ?? params.image_url) as string | undefined,
    endFrameUrl: (params.end_frame ?? params.image_tail_url) as string | undefined,
    aspectRatio,
    resolution,
    durationSeconds,
    modelSlug: REPLICATE_VEO_MODEL_SLUG,
    providerModelId: "google/veo-3.1",
    generateAudio: shouldGenerateFallbackVeoAudio(params),
    fallbackFrom: String(params.fallback_from ?? "direct_replicate_model"),
  });
}

export const REPLICATE_SEEDANCE_MODEL_SLUG = "replicate-seedance-2-0";
const REPLICATE_SEEDANCE_PROVIDER_MODEL_ID = "bytedance/seedance-2.0";
export const REPLICATE_VEO_MODEL_SLUG = "replicate-veo-3-1";
const REPLICATE_PREDICTIONS_ENDPOINT = "https://api.replicate.com/v1/predictions";

const REPLICATE_KLING_VIDEO_MODELS: Record<string, { providerModelId: string; sourceModel: string }> = {
  "replicate-kling-v3-pro": {
    providerModelId: "kwaivgi/kling-v3-video",
    sourceModel: "kling-v3-pro",
  },
  "replicate-kling-v3-omni": {
    providerModelId: "kwaivgi/kling-v3-omni-video",
    sourceModel: "kling-v3-omni",
  },
  "replicate-kling-v3-motion-pro": {
    providerModelId: "kwaivgi/kling-v3-motion-control",
    sourceModel: "kling-v3-motion-pro",
  },
};

const REPLICATE_IMAGE_MODELS: Record<string, { providerModelId: string; sourceModel: string; family: "gpt-image-2" | "banana-pro" | "banana-2" }> = {
  "replicate-gpt-image-2": {
    providerModelId: "openai/gpt-image-2",
    sourceModel: "gpt-image-2",
    family: "gpt-image-2",
  },
  "replicate-nano-banana-pro": {
    providerModelId: "google/nano-banana-pro",
    sourceModel: "nano-banana-pro",
    family: "banana-pro",
  },
  "replicate-nano-banana-2": {
    providerModelId: "google/nano-banana",
    sourceModel: "nano-banana-2",
    family: "banana-2",
  },
};

function loadReplicateApiToken(label = "Replicate"): string {
  const apiToken = Deno.env.get("REPLICATE_API_TOKEN")?.trim();
  if (!apiToken) {
    throw new Error(`${label} is not configured. Set REPLICATE_API_TOKEN.`);
  }
  return apiToken;
}

async function submitReplicatePrediction(
  providerModelId: string,
  input: Record<string, unknown>,
  label: string,
): Promise<string> {
  const apiToken = loadReplicateApiToken(label);
  const res = await fetch(
    `https://api.replicate.com/v1/models/${providerModelId}/predictions`,
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
    throw new Error(`${label} submit failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 300)}`);
  }
  const predictionId = String(parsed.id ?? "").trim();
  if (!predictionId) {
    throw new Error(`${label} returned no prediction id: ${text.slice(0, 300)}`);
  }
  return predictionId;
}

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

function normalizeReplicateKlingMode(params: Record<string, unknown>, motion = false): string {
  const raw = String(params.mode ?? params.quality_mode ?? params.resolution ?? "").toLowerCase();
  if (motion) return raw === "std" || raw === "standard" || raw === "720p" ? "std" : "pro";
  if (raw === "4k" || raw === "2160p") return "4k";
  if (raw === "standard" || raw === "std" || raw === "720p") return "standard";
  return "pro";
}

function normalizeReplicateKlingAspectRatio(value: unknown): string {
  const raw = String(value ?? "16:9");
  return ["16:9", "9:16", "1:1"].includes(raw) ? raw : "16:9";
}

function parseReplicateKlingDuration(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : parseInt(String(value ?? "5"), 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(15, Math.max(3, Math.round(parsed)));
}

function boolParam(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  return value === true || value === "true" || value === "1" || value === 1;
}

async function executeReplicateKlingVideo(
  modelSlug: string,
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const entry = REPLICATE_KLING_VIDEO_MODELS[modelSlug];
  if (!entry) throw new Error(`Unknown Replicate Kling model: ${modelSlug}`);

  const prompt = String(params.prompt ?? "").trim();
  const startFrameUrl = String(params.image_url ?? params.start_frame ?? params.image ?? "").trim();
  const endFrameUrl = String(params.image_tail_url ?? params.end_frame ?? "").trim();
  const referenceImageUrls = collectStringUrls(
    params,
    ["ref_image_urls", "reference_image_urls", "reference_image_url", "reference_image", "ref_image"],
    7,
  );
  const referenceVideoUrls = collectStringUrls(
    params,
    ["reference_video_urls", "reference_video_url", "video_urls", "video_url", "ref_video"],
    1,
  );
  const duration = parseReplicateKlingDuration(params.duration);

  const input: Record<string, unknown> = {
    prompt: prompt || "Generate a cinematic video from the provided references.",
  };

  if (modelSlug === "replicate-kling-v3-motion-pro") {
    const motionVideo = referenceVideoUrls[0] ?? String(params.video ?? "").trim();
    if (!startFrameUrl) throw new Error("Replicate Kling 3.0 Motion requires a reference image.");
    if (!motionVideo) throw new Error("Replicate Kling 3.0 Motion requires a reference video.");
    input.mode = normalizeReplicateKlingMode(params, true);
    input.image = startFrameUrl;
    input.video = motionVideo;
    input.keep_original_sound = boolParam(params.keep_original_sound, true);
    const orientation = String(params.character_orientation ?? "image");
    input.character_orientation = orientation === "video" ? "video" : "image";
  } else {
    input.mode = normalizeReplicateKlingMode(params);
    input.duration = duration;
    input.aspect_ratio = normalizeReplicateKlingAspectRatio(params.aspect_ratio ?? params.ratio);
    input.generate_audio = boolParam(params.generate_audio ?? params.has_audio, false);
    if (params.negative_prompt) input.negative_prompt = String(params.negative_prompt);
    if (params.multi_prompt) input.multi_prompt = String(params.multi_prompt);
    if (startFrameUrl) input.start_image = startFrameUrl;
    if (endFrameUrl) input.end_image = endFrameUrl;

    if (modelSlug === "replicate-kling-v3-omni") {
      if (referenceImageUrls.length > 0) input.reference_images = referenceImageUrls;
      if (referenceVideoUrls[0]) input.reference_video = referenceVideoUrls[0];
      if (referenceVideoUrls[0]) {
        input.keep_original_sound = boolParam(params.keep_original_sound, true);
        const videoReferenceType = String(params.video_reference_type ?? "feature");
        input.video_reference_type = videoReferenceType === "base" ? "base" : "feature";
        delete input.generate_audio;
      }
    }
  }

  console.log(
    `[replicate-kling] submit model=${entry.providerModelId} duration=${input.duration ?? "provider"} ` +
      `mode=${input.mode} start=${!!startFrameUrl} end=${!!endFrameUrl} ` +
      `refs=${referenceImageUrls.length} videoRef=${referenceVideoUrls.length}`,
  );

  const predictionId = await submitReplicatePrediction(
    entry.providerModelId,
    input,
    `Replicate Kling ${modelSlug}`,
  );

  return {
    task_id: predictionId,
    outputs: {
      output_video: "",
      output_start_frame: startFrameUrl,
      output_end_frame: endFrameUrl,
    },
    output_type: "video_url",
    provider_meta: {
      provider: "replicate_video",
      source_provider: "replicate",
      model: modelSlug,
      fallback_for: entry.sourceModel,
      provider_model_id: entry.providerModelId,
      poll_endpoint: REPLICATE_PREDICTIONS_ENDPOINT,
      duration_seconds: input.duration ?? null,
      mode: input.mode,
      aspect_ratio: input.aspect_ratio ?? null,
      has_audio: Boolean(input.generate_audio),
      is_image2video: Boolean(startFrameUrl),
      has_end_frame: Boolean(endFrameUrl),
      reference_image_count: referenceImageUrls.length,
      reference_video_count: referenceVideoUrls.length,
    },
  };
}

export async function executeReplicateVideo(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const modelSlug = String(params.model_name ?? params.model ?? REPLICATE_SEEDANCE_MODEL_SLUG);
  if (REPLICATE_KLING_VIDEO_MODELS[modelSlug]) {
    return await executeReplicateKlingVideo(modelSlug, params);
  }
  if (modelSlug !== REPLICATE_SEEDANCE_MODEL_SLUG) {
    throw new Error(`Unknown Replicate video model: ${modelSlug}`);
  }

  loadReplicateApiToken("Replicate video");

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
  const generateAudio = audioPreferenceParam(params, false);
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

  const predictionId = await submitReplicatePrediction(
    REPLICATE_SEEDANCE_PROVIDER_MODEL_ID,
    input,
    "Replicate Seedance 2.0",
  );

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

function normalizeReplicateImageAspectRatio(params: Record<string, unknown>, family: "gpt-image-2" | "banana-pro" | "banana-2"): string {
  const raw = String(params.aspect_ratio ?? params.ratio ?? "").trim();
  const size = String(params.size ?? params.image_size ?? "").trim().toLowerCase();
  if (family === "gpt-image-2") {
    if (["1:1", "3:2", "2:3"].includes(raw)) return raw;
    if (size === "1536x1024" || size === "3:2") return "3:2";
    if (size === "1024x1536" || size === "2:3") return "2:3";
    return "1:1";
  }
  const allowed = ["match_input_image", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
  if (allowed.includes(raw)) return raw;
  if (raw && raw !== "Auto") return "1:1";
  return "match_input_image";
}

function normalizeReplicateBananaResolution(value: unknown): "1K" | "2K" | "4K" {
  const raw = String(value ?? "2K").trim().toUpperCase();
  if (raw === "1K" || raw === "2K" || raw === "4K") return raw;
  return "2K";
}

export async function executeReplicateImage(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const modelSlug = String(params.model_name ?? params.model ?? "replicate-gpt-image-2");
  const entry = REPLICATE_IMAGE_MODELS[modelSlug];
  if (!entry) throw new Error(`Unknown Replicate image model: ${modelSlug}`);

  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) {
    throw new Error(`Replicate ${entry.providerModelId} requires a prompt.`);
  }
  const imageInputs = collectStringUrls(
    params,
    ["mention_image_urls", "image_input", "input_images", "image_url", "image", "ref_image", "reference_image_urls"],
    entry.family === "banana-pro" ? 14 : 10,
  );

  const outputFormatRaw = String(params.output_format ?? (entry.family === "gpt-image-2" ? "webp" : "jpg")).toLowerCase();
  const outputFormat =
    entry.family === "gpt-image-2"
      ? (["png", "jpeg", "webp"].includes(outputFormatRaw) ? outputFormatRaw : "webp")
      : (outputFormatRaw === "png" ? "png" : "jpg");

  const input: Record<string, unknown> = { prompt };
  if (entry.family === "gpt-image-2") {
    const qualityRaw = String(params.quality ?? "auto").toLowerCase();
    input.quality = ["low", "medium", "high", "auto"].includes(qualityRaw) ? qualityRaw : "auto";
    input.aspect_ratio = normalizeReplicateImageAspectRatio(params, entry.family);
    input.input_images = imageInputs;
    input.number_of_images = 1;
    input.output_format = outputFormat;
    const backgroundRaw = String(params.background ?? "auto").toLowerCase();
    input.background = ["auto", "transparent", "opaque"].includes(backgroundRaw) ? backgroundRaw : "auto";
    const moderationRaw = String(params.moderation ?? "auto").toLowerCase();
    input.moderation = moderationRaw === "low" ? "low" : "auto";
    const compression = Number(params.output_compression ?? 90);
    input.output_compression = Number.isFinite(compression)
      ? Math.max(0, Math.min(100, Math.round(compression)))
      : 90;
  } else {
    input.image_input = imageInputs;
    const bananaAspectRatio = normalizeReplicateImageAspectRatio(params, entry.family);
    input.aspect_ratio = bananaAspectRatio === "match_input_image" && imageInputs.length === 0
      ? "1:1"
      : bananaAspectRatio;
    input.output_format = outputFormat;
    if (entry.family === "banana-pro") {
      input.resolution = normalizeReplicateBananaResolution(params.image_size ?? params.resolution);
      const safetyRaw = String(params.safety_filter_level ?? "block_only_high");
      input.safety_filter_level = [
        "block_low_and_above",
        "block_medium_and_above",
        "block_only_high",
      ].includes(safetyRaw) ? safetyRaw : "block_only_high";
      // Keep model semantics explicit. Replicate's schema can fall back to
      // Seedream 5 when Pro is at capacity; we disable it so our own route
      // plan remains the only fallback decision-maker.
      input.allow_fallback_model = false;
    }
  }

  console.log(
    `[replicate-image] submit model=${entry.providerModelId} refs=${imageInputs.length} ` +
      `format=${outputFormat} aspect=${input.aspect_ratio ?? "default"}`,
  );

  const predictionId = await submitReplicatePrediction(
    entry.providerModelId,
    input,
    `Replicate image ${modelSlug}`,
  );

  return {
    task_id: predictionId,
    outputs: { output_image: "" },
    output_type: "image_url",
    provider_meta: {
      provider: "replicate_image",
      source_provider: "replicate",
      model: modelSlug,
      fallback_for: entry.sourceModel,
      provider_model_id: entry.providerModelId,
      poll_endpoint: REPLICATE_PREDICTIONS_ENDPOINT,
      reference_image_count: imageInputs.length,
      output_format: outputFormat,
      aspect_ratio: input.aspect_ratio ?? null,
      quality: input.quality ?? null,
      resolution: input.resolution ?? null,
    },
  };
}
