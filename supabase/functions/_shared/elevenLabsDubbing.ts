import type { ProviderResult } from "./providerResult.ts";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const ELEVENLABS_DUBBING_NAME_MAX = 100;
const DOWNLOAD_TOKEN_TTL_SEC = 60 * 60 * 6;

export const ELEVENLABS_DUBBING_MODEL = "elevenlabs-dubbing-voice-clone";

const ELEVENLABS_DUBBING_LANGUAGE_NAMES =
  "English, Hindi, Portuguese, Chinese, Spanish, French, German, Japanese, Arabic, Russian, Korean, Indonesian, Italian, Dutch, Turkish, Polish, Swedish, Filipino, Malay, Romanian, Ukrainian, Greek, Czech, Danish, Finnish, Bulgarian, Croatian, Slovak, or Tamil";

const ELEVENLABS_DUBBING_LANGUAGE_CODES = new Set([
  "en",
  "hi",
  "pt",
  "zh",
  "es",
  "fr",
  "de",
  "ja",
  "ar",
  "ru",
  "ko",
  "id",
  "it",
  "nl",
  "tr",
  "pl",
  "sv",
  "fil",
  "ms",
  "ro",
  "uk",
  "el",
  "cs",
  "da",
  "fi",
  "bg",
  "hr",
  "sk",
  "ta",
]);

type DownloadTokenPayload = {
  dubbing_id: string;
  language_code: string;
  user_id: string;
  output_type?: "audio" | "video";
  exp: number;
};

class DubbingValidationError extends Error {
  status = 400;
}

function getElevenLabsKey(): string {
  const key =
    Deno.env.get("ELEVENLABS_API_KEY")?.trim() ||
    Deno.env.get("ELEVEN_API_KEY")?.trim();
  if (!key) {
    throw new Error("ElevenLabs is not configured. Set ELEVENLABS_API_KEY or ELEVEN_API_KEY.");
  }
  return key;
}

function elevenLabsDubbingWatermark(): boolean {
  const raw = Deno.env.get("ELEVENLABS_DUBBING_WATERMARK")?.trim().toLowerCase();
  if (!raw) return false;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  return false;
}

function elevenLabsAllowWatermarkedVideo(): boolean {
  const raw = Deno.env.get("ELEVENLABS_DUBBING_ALLOW_WATERMARKED_VIDEO")?.trim().toLowerCase();
  return raw ? ["true", "1", "yes", "on"].includes(raw) : false;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return fallback;
}

function optionalPositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(1, Math.round(parsed));
}

function compactProviderError(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const detail = parsed.detail;
    if (detail && typeof detail === "object") {
      const info = detail as Record<string, unknown>;
      return [
        typeof info.message === "string" ? info.message : "",
        typeof info.status === "string" ? `status=${info.status}` : "",
        typeof info.code === "string" ? `code=${info.code}` : "",
        typeof info.request_id === "string" ? `request_id=${info.request_id}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
  } catch {
    // Fall through to compact raw text.
  }
  return trimmed.replace(/\s+/g, " ").slice(0, 320);
}

function truncateProviderText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return value;
  if (maxLength <= 3) return chars.slice(0, maxLength).join("");
  return `${chars.slice(0, maxLength - 3).join("").trimEnd()}...`;
}

function cleanProviderNamePart(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  const fileLike = withoutQuery.split(/[\\/]/).filter(Boolean).pop() ?? withoutQuery;
  let decoded = fileLike;
  try {
    decoded = decodeURIComponent(fileLike);
  } catch {
    // Keep original text if it is not URL encoded.
  }
  return decoded
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function elevenLabsDubbingName(sourceName: string, outputLanguage: string): string {
  const cleanedSource = cleanProviderNamePart(sourceName);
  const cleanedLanguage = cleanProviderNamePart(outputLanguage);
  const suffix = cleanedSource || cleanedLanguage || "media";
  return truncateProviderText(`MediaForge Translate - ${suffix}`, ELEVENLABS_DUBBING_NAME_MAX);
}

function outputTypeForMedia(contentType: string, url = "", explicitType = ""): "audio" | "video" {
  const lowerExplicit = explicitType.trim().toLowerCase();
  if (lowerExplicit === "audio" || lowerExplicit === "mp3") return "audio";
  if (lowerExplicit === "video" || lowerExplicit === "mp4") return "video";
  const lowerContentType = contentType.trim().toLowerCase();
  const lowerUrl = url.split(/[?#]/)[0].toLowerCase();
  if (
    lowerContentType.startsWith("audio/") ||
    /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|weba)$/i.test(lowerUrl)
  ) {
    return "audio";
  }
  return "video";
}

function requestedOutputType(value: unknown, fallback: "audio" | "video"): "audio" | "video" {
  const requested = textValue(value).toLowerCase();
  return requested === "audio" || requested === "video" ? requested : fallback;
}

function languageCode(value: string, role: "source" | "target" = "target"): string {
  const normalised = value.trim().toLowerCase();
  const map: Record<string, string> = {
    english: "en",
    hindi: "hi",
    portuguese: "pt",
    chinese: "zh",
    spanish: "es",
    french: "fr",
    german: "de",
    japanese: "ja",
    arabic: "ar",
    russian: "ru",
    korean: "ko",
    indonesian: "id",
    italian: "it",
    dutch: "nl",
    turkish: "tr",
    polish: "pl",
    swedish: "sv",
    filipino: "fil",
    malay: "ms",
    romanian: "ro",
    ukrainian: "uk",
    greek: "el",
    czech: "cs",
    danish: "da",
    finnish: "fi",
    bulgarian: "bg",
    croatian: "hr",
    slovak: "sk",
    tamil: "ta",
  };
  const code = ELEVENLABS_DUBBING_LANGUAGE_CODES.has(normalised)
    ? normalised
    : map[normalised];
  if (!code) {
    throw new DubbingValidationError(
      `ElevenLabs dubbing does not support ${role} language "${value}". Supported languages: ${ELEVENLABS_DUBBING_LANGUAGE_NAMES}.`,
    );
  }
  return code;
}

function normaliseDubbingStatus(status: string, hasOutput = false): "submitted" | "processing" | "succeed" | "failed" {
  const s = status.trim().toLowerCase();
  if (hasOutput || s === "dubbed" || s === "completed" || s === "complete" || s === "done") return "succeed";
  if (s === "failed" || s === "error" || s === "errored") return "failed";
  if (s === "dubbing" || s === "preparing" || s === "processing" || s === "running") return "processing";
  return "submitted";
}

async function elevenLabsJson(
  path: string,
  init: { method: "GET" | "POST"; body?: BodyInit },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${ELEVENLABS_API_BASE}${path}`, {
    method: init.method,
    headers: {
      "xi-api-key": getElevenLabsKey(),
      Accept: "application/json",
    },
    ...(init.body ? { body: init.body } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const detail = compactProviderError(text);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `ElevenLabs authorization or source media access failed (HTTP ${res.status}).${detail ? ` ${detail}` : ""}`,
      );
    }
    if (res.status === 402) {
      throw new Error(
        `ElevenLabs quota exceeded for this media.${detail ? ` ${detail}` : " Add ElevenLabs credits or use a shorter source file."}`,
      );
    }
    if (res.status === 422 || res.status === 400) {
      throw new Error(`ElevenLabs rejected the dubbing request.${detail ? ` ${detail}` : ""}`);
    }
    if (res.status === 429) {
      throw new Error(`ElevenLabs rate-limited the dubbing request.${detail ? ` ${detail}` : ""}`);
    }
    throw new Error(`ElevenLabs dubbing failed (HTTP ${res.status}).${detail ? ` ${detail}` : ""}`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function downloadSecret(): string {
  return (
    Deno.env.get("ELEVENLABS_DUBBING_DOWNLOAD_SECRET")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    getElevenLabsKey()
  );
}

function base64UrlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(downloadSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

async function signDownloadToken(payload: DownloadTokenPayload): Promise<string> {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacHex(encoded);
  return `${encoded}.${signature}`;
}

function buildDownloadUrl(req: Request, token: string): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim().replace(/\/+$/, "");
  const url = supabaseUrl
    ? new URL(`${supabaseUrl}/functions/v1/elevenlabs-dubbing`)
    : new URL(req.url);
  url.searchParams.set("action", "download");
  url.searchParams.set("token", token);
  return url.toString();
}

export function elevenLabsDubbingStatusCode(err: unknown): number {
  return err instanceof DubbingValidationError ? err.status : 502;
}

export async function executeElevenLabsDubbing(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const mediaUrl = firstString(params.media_url, params.video_url, params.audio_url, params.source_url);
  if (!mediaUrl) {
    throw new DubbingValidationError("Connect an MP3 or MP4 input before running Dubbing.");
  }
  if (!/^https:\/\//i.test(mediaUrl)) {
    throw new DubbingValidationError("Dubbing source media must be a public HTTPS URL.");
  }

  const outputLanguage = firstString(params.output_language, params.target_language, "English");
  const targetLang = languageCode(outputLanguage, "target");
  const sourceLanguage = firstString(params.source_language, params.source_lang);
  const sourceLang =
    !sourceLanguage || sourceLanguage.toLowerCase() === "auto"
      ? "auto"
      : languageCode(sourceLanguage, "source");
  const sourceContentType = firstString(params.source_content_type);
  const sourceMediaType = outputTypeForMedia(
    sourceContentType,
    mediaUrl,
    firstString(params.media_type, params.source_media_type),
  );
  const outputType = requestedOutputType(params.output_type, sourceMediaType);
  const speakerNum = optionalPositiveInt(params.speaker_num);
  const consent = boolValue(params.consent);
  const watermark = outputType === "video" ? elevenLabsDubbingWatermark() : false;
  if (!consent) {
    throw new DubbingValidationError("Voice clone dubbing requires user consent.");
  }
  if (outputType === "video" && watermark && !elevenLabsAllowWatermarkedVideo()) {
    throw new DubbingValidationError(
      "Watermarked MP4 dubbing is disabled for this ElevenLabs account. Use non-watermarked Creator output or route audio-only media to MP3.",
    );
  }

  const form = new FormData();
  form.append("source_url", mediaUrl);
  form.append("target_lang", targetLang);
  form.append("source_lang", sourceLang);
  form.append("name", elevenLabsDubbingName(firstString(params.source_name, mediaUrl), outputLanguage));
  form.append("num_speakers", String(speakerNum ?? 0));
  if (outputType === "video") {
    form.append("watermark", watermark ? "true" : "false");
  }
  form.append("highest_resolution", "false");
  form.append("drop_background_audio", boolValue(params.drop_background_audio) ? "true" : "false");
  form.append("disable_voice_cloning", boolValue(params.disable_voice_cloning) ? "true" : "false");
  form.append("mode", "automatic");

  const providerResponse = await elevenLabsJson("/dubbing", {
    method: "POST",
    body: form,
  });
  const dubbingId = firstString(providerResponse.dubbing_id, providerResponse.id);
  if (!dubbingId) {
    throw new Error("ElevenLabs did not return a dubbing_id.");
  }

  return {
    task_id: dubbingId,
    outputs: {},
    output_type: outputType === "audio" ? "audio_url" : "video_url",
    provider_meta: {
      provider: "elevenlabs_dubbing",
      poll_endpoint: `${ELEVENLABS_API_BASE}/dubbing`,
      model: ELEVENLABS_DUBBING_MODEL,
      dubbing_id: dubbingId,
      output_language: outputLanguage,
      target_lang: targetLang,
      source_lang: sourceLang,
      source_content_type: sourceContentType || null,
      source_media_type: sourceMediaType,
      output_type: outputType,
      voice_cloning: !boolValue(params.disable_voice_cloning),
      disable_voice_cloning: boolValue(params.disable_voice_cloning),
      watermark,
      provider_response: providerResponse,
    },
  };
}

export async function pollElevenLabsDubbing(args: {
  req: Request;
  userId: string;
  taskId: string;
  pollEndpoint: string;
  targetLang: string;
  outputLanguage: string;
  outputType: "audio" | "video";
}): Promise<{
  status: string;
  task_id: string;
  url?: string;
  message?: string;
  output_type: "audio" | "video";
  provider_response?: Record<string, unknown>;
}> {
  const taskId = args.taskId.trim();
  const pollEndpoint = args.pollEndpoint.trim();
  if (!taskId || !pollEndpoint) {
    throw new DubbingValidationError("task_id and poll_endpoint required for poll_elevenlabs_dubbing");
  }
  let pollUrlOk = false;
  try {
    const u = new URL(pollEndpoint);
    pollUrlOk =
      u.protocol === "https:" &&
      u.hostname === "api.elevenlabs.io" &&
      u.pathname.replace(/\/+$/, "") === "/v1/dubbing";
  } catch {
    pollUrlOk = false;
  }
  if (!pollUrlOk) {
    throw new DubbingValidationError("Unsupported ElevenLabs dubbing poll endpoint.");
  }

  const providerResponse = await elevenLabsJson(`/dubbing/${encodeURIComponent(taskId)}`, {
    method: "GET",
  });
  const rawStatus = firstString(providerResponse.status);
  const errorMessage = firstString(providerResponse.error);
  const status = normaliseDubbingStatus(rawStatus);
  if (status !== "succeed") {
    return {
      status,
      task_id: taskId,
      message: status === "failed" ? errorMessage || "ElevenLabs dubbing failed." : rawStatus,
      output_type: args.outputType,
      provider_response: providerResponse,
    };
  }

  const targetLang = firstString(args.targetLang, args.outputLanguage ? languageCode(args.outputLanguage) : "");
  if (!targetLang) throw new DubbingValidationError("target language is required for ElevenLabs download.");
  const token = await signDownloadToken({
    dubbing_id: taskId,
    language_code: targetLang,
    user_id: args.userId,
    output_type: args.outputType,
    exp: Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SEC,
  });

  return {
    status: "succeed",
    task_id: taskId,
    url: buildDownloadUrl(args.req, token),
    output_type: args.outputType,
    provider_response: providerResponse,
  };
}
