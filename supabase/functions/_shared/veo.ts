/// <reference lib="deno.ns" />
/**
 * Google Veo 3.1 (Standard) video-generation client.
 *
 * Veo 3.1 ships through the Gemini API at
 * `https://generativelanguage.googleapis.com/v1beta/`. Authentication
 * is the same `GOOGLE_AI_STUDIO_KEY` (alias `GEMINI_API_KEY`) the rest
 * of the workspace already uses for chat / Banana / video-to-prompt —
 * no new secret required.
 *
 * Async submit/poll flow:
 *   1. POST /models/veo-3.1-generate-preview:predictLongRunning
 *      → { name: "operations/<opaque-id>" }
 *   2. GET  /<operations/...>
 *      → { done: false }                                  (still running)
 *      → { done: true, response: { generateVideoResponse: {
 *            generatedSamples: [{ video: { uri } }] } } } (success)
 *      → { done: true, error: { code, message } }         (failure)
 *
 * Generated videos live on Google's storage for ~2 days; the URI must
 * be downloaded with the API key appended as `?key=`. The frontend
 * polls via the `poll_veo` action in workspace-run-node.
 *
 * Real Veo 3.1 parameters (verified against
 * https://ai.google.dev/gemini-api/docs/video, May 2026):
 *
 *   instances[].prompt            string (required, up to 1024 tokens)
 *   instances[].image             { bytesBase64Encoded, mimeType } — optional start frame
 *   instances[].lastFrame         { bytesBase64Encoded, mimeType } — optional end frame
 *   instances[].referenceImages   array — up to 3, NOT compatible with 9:16
 *   parameters.aspectRatio        "16:9" | "9:16"        (default 16:9)
 *   parameters.durationSeconds    4 | 6 | 8              (default 8;
 *                                                         must be 8
 *                                                         for 1080p/4k
 *                                                         or refs)
 *   parameters.resolution         "720p" | "1080p" | "4k" (default 720p)
 *   parameters.personGeneration   "allow_all" | "allow_adult"
 *
 * Audio is always generated and not configurable. negativePrompt is
 * NOT documented for veo-3.1 — do not send it.
 */

export const VEO_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const VEO_OPERATIONS_PREFIX = "operations/";

/** UI slug → Gemini API model identifier. Standard only — Lite/Fast
 *  are intentionally omitted because the user only wants Standard. */
export const VEO_MODEL_MAP: Record<string, { model: string; tier: "standard" }> = {
  "veo-3.1-generate-preview": { model: "veo-3.1-generate-preview", tier: "standard" },
  // Backward-compatible alias for saved nodes created while the UI briefly
  // used a GA-looking slug. Gemini API still exposes Veo 3.1 as preview.
  "veo-3.1-generate-001": { model: "veo-3.1-generate-preview", tier: "standard" },
};

export type VeoAspectRatio = "16:9" | "9:16";
export type VeoResolution = "720p" | "1080p";
export type VeoDuration = 4 | 6 | 8;
export type VeoPersonGeneration = "allow_all" | "allow_adult";

export interface VeoImage {
  /** "image/png" | "image/jpeg" | "image/webp". */
  mimeType: string;
  /** Raw base64 (no data: prefix). */
  data: string;
}

export interface VeoSubmitParams {
  prompt: string;
  startFrame?: VeoImage;
  /** Veo 3.1 calls this `lastFrame`. Same shape as start. */
  endFrame?: VeoImage;
  aspectRatio?: VeoAspectRatio;
  resolution?: VeoResolution;
  durationSeconds?: VeoDuration;
  personGeneration?: VeoPersonGeneration;
}

export type VeoImageEncoding = "bytesBase64Encoded" | "inlineData";

interface VeoOperationName {
  /** "operations/abc123…" or "models/<model>/operations/abc123…" */
  name: string;
  error?: { code?: number; message?: string };
}

export interface VeoOperationStatus {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string } }>;
    };
  };
}

export function loadVeoApiKey(): string {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    throw new Error(
      "Veo: GOOGLE_AI_STUDIO_KEY (or GEMINI_API_KEY) is not configured in Supabase project secrets.",
    );
  }
  return key;
}

/** Fetch a remote image and convert to base64 inlineData payload.
 *  Veo's REST API does not accept public URLs — images must be
 *  embedded inline. Caller passes a signed/public URL (e.g. the
 *  upstream node's output_image) and we pull the bytes here. */
export async function fetchImageAsInline(url: string): Promise<VeoImage> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Veo: failed to fetch start/end frame (${res.status})`);
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const buffer = new Uint8Array(await res.arrayBuffer());
  // Convert to base64 without the data: prefix.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return { mimeType, data: btoa(binary) };
}

/** Build the JSON body for the predictLongRunning call. The "8s
 *  required for 1080p/refs" constraint is enforced here — we
 *  silently coerce duration to "8" when the resolution forces it,
 *  because the API otherwise responds with an opaque 400. */
function veoImagePayload(image: VeoImage, encoding: VeoImageEncoding): Record<string, unknown> {
  if (encoding === "bytesBase64Encoded") {
    return { bytesBase64Encoded: image.data, mimeType: image.mimeType };
  }
  return { inlineData: image };
}

export function buildVeoRequest(
  p: VeoSubmitParams,
  imageEncoding: VeoImageEncoding = "bytesBase64Encoded",
): Record<string, unknown> {
  let duration = p.durationSeconds ?? 8;
  if ((p.resolution === "1080p") && duration !== 8) {
    duration = 8;
  }

  const instance: Record<string, unknown> = { prompt: p.prompt };
  if (p.startFrame) instance.image = veoImagePayload(p.startFrame, imageEncoding);
  if (p.endFrame) instance.lastFrame = veoImagePayload(p.endFrame, imageEncoding);

  const parameters: Record<string, unknown> = {
    aspectRatio: p.aspectRatio ?? "16:9",
    resolution: p.resolution ?? "720p",
    durationSeconds: duration,
  };
  if (p.personGeneration) parameters.personGeneration = p.personGeneration;

  return {
    instances: [instance],
    parameters,
  };
}

/** Submit a Veo 3.1 video generation. Returns the operation name —
 *  what the frontend polls against. Throws on non-2xx HTTP. */
export async function submitVeoTask(
  modelId: string,
  body: Record<string, unknown>,
  apiKey: string,
): Promise<string> {
  const url = `${VEO_BASE}/models/${encodeURIComponent(modelId)}:predictLongRunning`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Veo submit failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  let parsed: VeoOperationName;
  try {
    parsed = JSON.parse(text) as VeoOperationName;
  } catch {
    throw new Error(`Veo submit returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (parsed.error?.message) {
    throw new Error(`Veo submit error: ${parsed.error.message}`);
  }
  if (!parsed.name) {
    throw new Error("Veo submit succeeded but no operation name returned");
  }
  return parsed.name;
}

export function normalizeVeoOperationName(raw: string): string {
  const value = raw.trim();
  if (!value) return "";

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "generativelanguage.googleapis.com"
      ) {
        return "";
      }
      return url.pathname
        .replace(/^\/+/, "")
        .replace(/^v1beta\/+/, "")
        .trim();
    } catch {
      return "";
    }
  }

  const withoutSlash = value.replace(/^\/+/, "");
  if (
    withoutSlash.startsWith("operations/") ||
    /^models\/[^/]+\/operations\/[^/]+/.test(withoutSlash)
  ) {
    return withoutSlash;
  }

  return "";
}

/** Poll the operation once. Returns the raw status object — caller
 *  interprets `done` + `error` + `response.generateVideoResponse`. */
export async function pollVeoOnce(
  operationName: string,
  apiKey: string,
): Promise<VeoOperationStatus> {
  const normalizedOperationName = normalizeVeoOperationName(operationName);
  if (!normalizedOperationName) {
    throw new Error("Veo poll requires a Gemini operation name.");
  }
  const url = `${VEO_BASE}/${normalizedOperationName}`;
  const res = await fetch(url, {
    headers: { "x-goog-api-key": apiKey },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Veo poll failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as VeoOperationStatus;
  } catch {
    throw new Error(`Veo poll returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Pull the final video URI out of a successful operation response.
 *  Returns undefined when the operation hasn't surfaced a sample yet
 *  (rare race — successful done=true with empty samples is treated by
 *  callers as a failure, not a retry). */
export function extractVeoVideoUri(status: VeoOperationStatus): string | undefined {
  const sample = status.response?.generateVideoResponse?.generatedSamples?.[0];
  return sample?.video?.uri;
}
