/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthUser, unauthorized } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const DOWNLOAD_TOKEN_TTL_SEC = 60 * 60 * 6;
const ELEVENLABS_DUBBING_NAME_MAX = 100;
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

class RequestValidationError extends Error {
  status = 400;
}

type StartBody = {
  action: "start";
  video_url?: unknown;
  output_language?: unknown;
  output_type?: unknown;
  source_language?: unknown;
  source_content_type?: unknown;
  source_media_type?: unknown;
  source_name?: unknown;
  speaker_num?: unknown;
  project_id?: unknown;
  source_storage_bucket?: unknown;
  source_storage_path?: unknown;
  consent?: unknown;
};

type StatusBody = {
  action: "status";
  job_id?: unknown;
  dubbing_id?: unknown;
  output_language?: unknown;
};

type RequestBody = StartBody | StatusBody | { action?: unknown };

type DownloadTokenPayload = {
  dubbing_id: string;
  language_code: string;
  user_id: string;
  job_id?: string;
  output_type?: "audio" | "video";
  exp: number;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function serviceSupabase() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, serviceRole);
}

function getElevenLabsKey(): string {
  const key = Deno.env.get("ELEVENLABS_API_KEY")?.trim() || Deno.env.get("ELEVEN_API_KEY")?.trim();
  if (!key) {
    throw new Error("ElevenLabs is not configured. Set ELEVENLABS_API_KEY or ELEVEN_API_KEY.");
  }
  return key;
}

function elevenLabsDubbingWatermark(): boolean {
  return false;
}

function elevenLabsAllowWatermarkedVideo(): boolean {
  const raw = Deno.env.get("ELEVENLABS_DUBBING_ALLOW_WATERMARKED_VIDEO")?.trim().toLowerCase();
  return raw ? ["true", "1", "yes", "on"].includes(raw) : false;
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
    // Fall through to the raw compact text below.
  }
  return trimmed.replace(/\s+/g, " ").slice(0, 320);
}

function downloadSecret(): string {
  return (
    Deno.env.get("ELEVENLABS_DUBBING_DOWNLOAD_SECRET")?.trim() ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ||
    getElevenLabsKey()
  );
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    // Keep the original text if it is not valid URL-encoded input.
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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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

function standaloneCanvasId(projectId: string): string {
  return `standalone:${projectId}`;
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
  const code = ELEVENLABS_DUBBING_LANGUAGE_CODES.has(normalised) ? normalised : map[normalised];
  if (!code) {
    throw new RequestValidationError(
      `ElevenLabs dubbing does not support ${role} language "${value}". Supported languages: ${ELEVENLABS_DUBBING_LANGUAGE_NAMES}.`,
    );
  }
  return code;
}

function normaliseDubbingStatus(status: string, hasOutput = false): "submitted" | "processing" | "completed" | "failed" {
  const s = status.trim().toLowerCase();
  if (hasOutput || s === "dubbed" || s === "completed" || s === "complete" || s === "done") return "completed";
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
    if (res.status === 401 || res.status === 403) {
      const detail = compactProviderError(text);
      throw new Error(
        `ElevenLabs authorization or source media access failed (HTTP ${res.status}).${detail ? ` ${detail}` : ""}`,
      );
    }
    if (res.status === 402) {
      const detail = compactProviderError(text);
      throw new Error(
        `ElevenLabs quota exceeded for this media.${detail ? ` ${detail}` : " Add ElevenLabs credits or use a shorter source file."}`,
      );
    }
    if (res.status === 422 || res.status === 400) {
      const detail = compactProviderError(text);
      throw new Error(`ElevenLabs rejected the dubbing request.${detail ? ` ${detail}` : ""}`);
    }
    if (res.status === 429) {
      const detail = compactProviderError(text);
      throw new Error(`ElevenLabs rate-limited the dubbing request.${detail ? ` ${detail}` : ""}`);
    }
    const detail = compactProviderError(text);
    throw new Error(`ElevenLabs dubbing failed (HTTP ${res.status}).${detail ? ` ${detail}` : ""}`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function base64UrlEncode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
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

async function verifyDownloadToken(token: string): Promise<DownloadTokenPayload> {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new Error("Invalid download token.");
  const expected = await hmacHex(encoded);
  if (signature !== expected) throw new Error("Invalid download token signature.");
  const payload = JSON.parse(base64UrlDecode(encoded)) as DownloadTokenPayload;
  if (!payload.dubbing_id || !payload.language_code || !payload.user_id) {
    throw new Error("Invalid download token payload.");
  }
  if (Date.now() / 1000 > Number(payload.exp ?? 0)) {
    throw new Error("Download token expired.");
  }
  return payload;
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

function dubbedDownloadFilename(payload: DownloadTokenPayload): string {
  const ext = payload.output_type === "video" ? "mp4" : "mp3";
  const safeId = payload.dubbing_id.replace(/[^a-z0-9_-]+/gi, "").slice(0, 24) || "dubbing";
  return `mediaforge_translate_${safeId}.${ext}`;
}

async function updateTranslateJob(args: {
  jobId: string;
  userId: string;
  status: "running" | "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
}) {
  const supabase = serviceSupabase();
  const patch: Record<string, unknown> = {
    status: args.status,
    ...(args.result ? { result: args.result } : {}),
    error: args.error ?? null,
    last_error: args.error ?? null,
    ...(args.status === "completed" || args.status === "failed"
      ? { completed_at: new Date().toISOString() }
      : {}),
  };
  await supabase
    .from("workspace_generation_jobs")
    .update(patch)
    .eq("id", args.jobId)
    .eq("user_id", args.userId);
}

async function streamDubbedFile(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const downloadIntent = url.searchParams.get("download") === "1";
  const payload = await verifyDownloadToken(token);
  const upstreamHeaders: Record<string, string> = {
    "xi-api-key": getElevenLabsKey(),
    Accept: "video/mp4,audio/mpeg,*/*",
  };
  const range = req.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  const upstream = await fetch(
    `${ELEVENLABS_API_BASE}/dubbing/${encodeURIComponent(payload.dubbing_id)}/audio/${encodeURIComponent(payload.language_code)}`,
    { method: "GET", headers: upstreamHeaders },
  );
  const headers = new Headers(corsHeaders);
  for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  if (!headers.has("content-type")) {
    headers.set("Content-Type", payload.output_type === "video" ? "video/mp4" : "audio/mpeg");
  }
  if (downloadIntent) {
    headers.set("Content-Disposition", `attachment; filename="${dubbedDownloadFilename(payload)}"`);
  }
  headers.set("Cache-Control", "private, max-age=300");
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || `ElevenLabs download failed (HTTP ${upstream.status})`, {
      status: upstream.status,
      headers,
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("action") === "download") {
    try {
      return await streamDubbedFile(req);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 401);
    }
  }

  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const action = textValue(body.action);
    if (action === "start") {
      const start = body as StartBody;
      const videoUrl = textValue(start.video_url);
      const outputLanguage = textValue(start.output_language);
      if (!outputLanguage) return json({ error: "output_language is required." }, 400);
      const targetLang = languageCode(outputLanguage, "target");
      const sourceLanguage = textValue(start.source_language);
      const sourceLang = sourceLanguage ? languageCode(sourceLanguage, "source") : "auto";
      const sourceContentType = textValue(start.source_content_type);
      const sourceMediaTypeHint = textValue(start.source_media_type);
      const sourceName = textValue(start.source_name);
      const sourceMediaType = outputTypeForMedia(sourceContentType, videoUrl, sourceMediaTypeHint);
      const outputType = requestedOutputType(start.output_type, sourceMediaType);
      const speakerNum = optionalPositiveInt(start.speaker_num);
      const projectId = textValue(start.project_id);
      const sourceStorageBucket = textValue(start.source_storage_bucket);
      const sourceStoragePath = textValue(start.source_storage_path);
      const consent = boolValue(start.consent);
      const watermark = outputType === "video" ? elevenLabsDubbingWatermark() : false;

      if (!consent) return json({ error: "Voice clone dubbing requires user consent." }, 400);
      if (!projectId) return json({ error: "project_id is required." }, 400);
      if (outputType === "video" && watermark && !elevenLabsAllowWatermarkedVideo()) {
        return json(
          {
            error:
              "Watermarked MP4 dubbing is disabled for this ElevenLabs account. Use non-watermarked Creator output or choose MP3 / audio output.",
          },
          400,
        );
      }

      const supabase = serviceSupabase();
      let providerSourceUrl = videoUrl;
      if (sourceStorageBucket && sourceStoragePath) {
        const signedSource = await supabase.storage
          .from(sourceStorageBucket)
          .createSignedUrl(sourceStoragePath, 60 * 60 * 24);
        if (signedSource.error || !signedSource.data?.signedUrl) {
          return json(
            {
              error: `Could not prepare source media for ElevenLabs: ${
                signedSource.error?.message ?? "missing signed URL"
              }`,
            },
            400,
          );
        }
        providerSourceUrl = signedSource.data.signedUrl;
      }
      if (!/^https:\/\//i.test(providerSourceUrl)) {
        return json({ error: "source media must be a public HTTPS URL." }, 400);
      }

      const requestPayload = {
        action: "elevenlabs_dubbing",
        params: {
          model_name: "elevenlabs-dubbing-voice-clone",
          video_url: providerSourceUrl,
          original_video_url: videoUrl,
          output_language: outputLanguage,
          target_lang: targetLang,
          source_lang: sourceLang,
          source_content_type: sourceContentType || null,
          source_media_type: sourceMediaType,
          output_type: outputType,
          source_name: sourceName || null,
          speaker_num: speakerNum ?? 0,
          project_id: projectId,
          source_storage_bucket: sourceStorageBucket || null,
          source_storage_path: sourceStoragePath || null,
          translate_engine: "elevenlabs_dubbing_clone",
          disable_voice_cloning: false,
          watermark,
          highest_resolution: false,
        },
        inputs: { video_url: providerSourceUrl },
      };

      const projectCheck = await supabase
        .from("workspace_projects")
        .select("id")
        .eq("id", projectId)
        .maybeSingle();
      if (projectCheck.error) {
        return json({ error: `Could not verify project before dubbing: ${projectCheck.error.message}` }, 500);
      }
      if (!projectCheck.data?.id) {
        return json({ error: "Project not found for ElevenLabs voice clone dubbing." }, 400);
      }

      const jobInsert = await supabase
        .from("workspace_generation_jobs")
        .insert({
          user_id: user.id,
          workspace_id: null,
          project_id: projectId,
          canvas_id: standaloneCanvasId(projectId),
          node_id: `elevenlabs-dubbing-${crypto.randomUUID()}`,
          node_type: "voiceTranslateNode",
          provider: "elevenlabs_dubbing",
          model: "elevenlabs-dubbing-voice-clone",
          request: requestPayload,
          status: "running",
          attempts: 1,
          max_attempts: 120,
          started_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (jobInsert.error || !jobInsert.data?.id) {
        return json(
          { error: `Could not create ElevenLabs dubbing job: ${jobInsert.error?.message ?? "missing job id"}` },
          500,
        );
      }
      const jobId = String(jobInsert.data.id);

      const form = new FormData();
      form.append("source_url", providerSourceUrl);
      form.append("target_lang", targetLang);
      form.append("source_lang", sourceLang);
      form.append("name", elevenLabsDubbingName(sourceName, outputLanguage));
      form.append("num_speakers", String(speakerNum ?? 0));
      if (outputType === "video") {
        form.append("watermark", watermark ? "true" : "false");
      }
      form.append("highest_resolution", "false");
      form.append("drop_background_audio", "false");
      form.append("disable_voice_cloning", "false");
      form.append("mode", "automatic");

      let providerResponse: Record<string, unknown>;
      try {
        providerResponse = await elevenLabsJson("/dubbing", {
          method: "POST",
          body: form,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updateTranslateJob({
          jobId,
          userId: user.id,
          status: "failed",
          error: message,
          result: { provider_error: message },
        });
        return json({ error: message }, 502);
      }

      const dubbingId = firstString(providerResponse.dubbing_id, providerResponse.id);
      if (!dubbingId) {
        const message = "ElevenLabs did not return a dubbing_id.";
        await updateTranslateJob({
          jobId,
          userId: user.id,
          status: "failed",
          error: message,
          result: { provider_response: providerResponse },
        });
        return json({ error: message, provider_response: providerResponse }, 502);
      }

      const pendingResult = {
        type: outputType,
        task_id: dubbingId,
        outputs: {},
        provider_meta: {
          provider: "elevenlabs_dubbing",
          dubbing_id: dubbingId,
          output_language: outputLanguage,
          target_lang: targetLang,
          source_lang: sourceLang,
          source_content_type: sourceContentType || null,
          output_type: outputType,
          voice_cloning: true,
          disable_voice_cloning: false,
          watermark,
          source_storage_bucket: sourceStorageBucket || null,
          source_storage_path: sourceStoragePath || null,
        },
        provider_response: providerResponse,
      };

      await supabase
        .from("workspace_generation_jobs")
        .update({
          request: {
            ...requestPayload,
            provider_task_id: dubbingId,
          },
          result: pendingResult,
          last_error: null,
          error: null,
        })
        .eq("id", jobId)
        .eq("user_id", user.id);

      return json({
        job_id: jobId,
        dubbing_id: dubbingId,
        status: "submitted",
        output_language: outputLanguage,
        target_lang: targetLang,
        output_type: outputType,
        voice_cloning: true,
        watermark,
        provider_response: providerResponse,
      });
    }

    if (action === "status") {
      const statusBody = body as StatusBody;
      const supabase = serviceSupabase();
      const jobId = textValue(statusBody.job_id);
      let job: Record<string, unknown> | null = null;
      if (jobId) {
        const jobRes = await supabase
          .from("workspace_generation_jobs")
          .select("*")
          .eq("id", jobId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (jobRes.error) return json({ error: jobRes.error.message }, 500);
        if (!jobRes.data) return json({ error: "ElevenLabs dubbing job not found." }, 404);
        job = jobRes.data as Record<string, unknown>;
      }

      const jobRequest = objectValue(job?.request);
      const jobParams = objectValue(jobRequest.params);
      const jobResult = objectValue(job?.result);
      const jobProviderMeta = objectValue(jobResult.provider_meta);
      const dubbingId = firstString(
        statusBody.dubbing_id,
        jobRequest.provider_task_id,
        jobResult.task_id,
        jobProviderMeta.dubbing_id,
      );
      if (!dubbingId) return json({ error: "dubbing_id is required." }, 400);

      const outputLanguage = firstString(
        statusBody.output_language,
        jobParams.output_language,
        jobProviderMeta.output_language,
      );
      const targetLang = firstString(
        jobParams.target_lang,
        jobProviderMeta.target_lang,
        outputLanguage ? languageCode(outputLanguage) : "",
      );
      if (!targetLang) return json({ error: "target language is required." }, 400);

      const providerResponse = await elevenLabsJson(`/dubbing/${encodeURIComponent(dubbingId)}`, {
        method: "GET",
      });
      const mediaMetadata = objectValue(providerResponse.media_metadata);
      const sourceContentType = firstString(
        mediaMetadata.content_type,
        jobParams.source_content_type,
      );
      const sourceMediaType = outputTypeForMedia(
        sourceContentType,
        firstString(jobParams.original_video_url, jobParams.video_url),
        firstString(jobParams.source_media_type),
      );
      const outputType = requestedOutputType(jobParams.output_type, sourceMediaType);
      const watermark = outputType === "video" ? boolValue(jobParams.watermark, elevenLabsDubbingWatermark()) : false;
      const rawStatus = firstString(providerResponse.status);
      const errorMessage = firstString(providerResponse.error);
      const status = normaliseDubbingStatus(rawStatus);
      let outputUrl = "";
      if (status === "completed") {
        const token = await signDownloadToken({
          dubbing_id: dubbingId,
          language_code: targetLang,
          user_id: user.id,
          job_id: jobId || undefined,
          output_type: outputType,
          exp: Math.floor(Date.now() / 1000) + DOWNLOAD_TOKEN_TTL_SEC,
        });
        outputUrl = buildDownloadUrl(req, token);
      }

      const outputs =
        outputType === "audio"
          ? {
              audio_url: outputUrl,
              output_audio: outputUrl,
              provider_audio_url: outputUrl,
            }
          : {
              video_url: outputUrl,
              output_video: outputUrl,
              provider_video_url: outputUrl,
            };

      const result = {
        type: outputType,
        url: outputUrl || undefined,
        task_id: dubbingId,
        outputs,
        provider_meta: {
          provider: "elevenlabs_dubbing",
          dubbing_id: dubbingId,
          provider_status: rawStatus,
          output_language: outputLanguage,
          target_lang: targetLang,
          source_content_type: sourceContentType || null,
          output_type: outputType,
          voice_cloning: true,
          disable_voice_cloning: false,
          watermark,
          source_language: firstString(providerResponse.source_language),
          target_languages: Array.isArray(providerResponse.target_languages)
            ? providerResponse.target_languages
            : [],
        },
        provider_response: providerResponse,
      };

      if (jobId) {
        if (status === "completed") {
          await updateTranslateJob({ jobId, userId: user.id, status: "completed", result });
        } else if (status === "failed") {
          await updateTranslateJob({
            jobId,
            userId: user.id,
            status: "failed",
            result,
            error: errorMessage || "ElevenLabs dubbing failed.",
          });
        } else {
          await updateTranslateJob({ jobId, userId: user.id, status: "running", result });
        }
      }

      return json({
        job_id: jobId || undefined,
        dubbing_id: dubbingId,
        status,
        provider_status: rawStatus,
        output_url: outputUrl,
        output_type: outputType,
        error: status === "failed" ? errorMessage : undefined,
        voice_cloning: true,
        provider_response: providerResponse,
      });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[elevenlabs-dubbing]", message);
    return json({ error: message }, err instanceof RequestValidationError ? err.status : 500);
  }
});
