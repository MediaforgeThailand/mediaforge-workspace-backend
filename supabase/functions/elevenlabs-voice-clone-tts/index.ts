/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthUser, unauthorized } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";
const MAX_SAMPLE_BYTES = 50 * 1024 * 1024;
const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

type StartBody = {
  source_url?: unknown;
  source_storage_bucket?: unknown;
  source_storage_path?: unknown;
  source_content_type?: unknown;
  source_name?: unknown;
  project_id?: unknown;
  text?: unknown;
  consent?: unknown;
  remove_background_noise?: unknown;
  cleanup_voice?: unknown;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return fallback;
}

function serviceSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
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
      ].filter(Boolean).join(" ");
    }
  } catch {
    // Keep compact raw text below.
  }
  return trimmed.replace(/\s+/g, " ").slice(0, 320);
}

function safeFileName(sourceName: string, contentType: string): string {
  const base = sourceName
    .split(/[?#]/)[0]
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (base && /\.[A-Za-z0-9]{2,5}$/.test(base)) return base;
  const ext =
    contentType.includes("mpeg") || contentType.includes("mp3")
      ? "mp3"
      : contentType.includes("wav")
        ? "wav"
        : contentType.includes("mp4")
          ? "m4a"
          : "wav";
  return `${base || "voice-sample"}.${ext}`;
}

async function createTempVoice(args: {
  apiKey: string;
  sampleBytes: Uint8Array;
  sampleName: string;
  sampleContentType: string;
  removeBackgroundNoise: boolean;
}): Promise<{ voiceId: string; requiresVerification: boolean }> {
  const form = new FormData();
  form.append("name", `MediaForge temp clone ${Date.now()}`);
  form.append(
    "description",
    "Temporary Instant Voice Clone created by MediaForge local TTS prototype.",
  );
  form.append("remove_background_noise", args.removeBackgroundNoise ? "true" : "false");
  form.append(
    "files[]",
    new Blob([args.sampleBytes], {
      type: args.sampleContentType || "audio/wav",
    }),
    args.sampleName,
  );

  const res = await fetch(`${ELEVENLABS_API_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": args.apiKey, Accept: "application/json" },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ElevenLabs IVC failed (HTTP ${res.status}). ${compactProviderError(text)}`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const voiceId = textValue(data.voice_id);
  if (!voiceId) throw new Error("ElevenLabs IVC did not return a voice_id.");
  return {
    voiceId,
    requiresVerification: data.requires_verification === true,
  };
}

async function synthesizeTts(args: {
  apiKey: string;
  voiceId: string;
  text: string;
}): Promise<Uint8Array> {
  const res = await fetch(
    `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(args.voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": args.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: args.text,
        model_id: DEFAULT_TTS_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.85,
          style: 0.15,
          use_speaker_boost: true,
        },
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (HTTP ${res.status}). ${compactProviderError(text)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function deleteVoice(apiKey: string, voiceId: string): Promise<boolean> {
  const res = await fetch(
    `${ELEVENLABS_API_BASE}/voices/${encodeURIComponent(voiceId)}`,
    {
      method: "DELETE",
      headers: { "xi-api-key": apiKey, Accept: "application/json" },
    },
  );
  return res.ok;
}

async function updateJob(args: {
  jobId: string;
  userId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
}) {
  const supabase = serviceSupabase();
  await supabase
    .from("workspace_generation_jobs")
    .update({
      status: args.status,
      result: args.result ?? null,
      error: args.error ?? null,
      last_error: args.error ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.jobId)
    .eq("user_id", args.userId);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const supabase = serviceSupabase();
  let jobId = "";
  let tempVoiceId = "";
  let voiceDeleted = false;

  try {
    const body = (await req.json().catch(() => ({}))) as StartBody;
    const sourceUrl = textValue(body.source_url);
    const sourceStorageBucket = textValue(body.source_storage_bucket);
    const sourceStoragePath = textValue(body.source_storage_path);
    const sourceContentType = textValue(body.source_content_type) || "audio/wav";
    const sourceName = textValue(body.source_name);
    const projectId = textValue(body.project_id);
    const text = textValue(body.text);
    const consent = boolValue(body.consent);
    const removeBackgroundNoise = boolValue(body.remove_background_noise);
    const cleanupVoice = boolValue(body.cleanup_voice, true);

    if (!consent) return json({ error: "Voice cloning requires explicit user consent." }, 400);
    if (!projectId) return json({ error: "project_id is required." }, 400);
    if (!text) return json({ error: "TTS text is required." }, 400);
    if (text.length > 2500) return json({ error: "TTS text is too long for this local prototype." }, 400);

    const projectCheck = await supabase
      .from("workspace_projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();
    if (projectCheck.error) {
      return json({ error: `Could not verify project: ${projectCheck.error.message}` }, 500);
    }
    if (!projectCheck.data?.id) return json({ error: "Project not found." }, 400);

    let providerSourceUrl = sourceUrl;
    if (sourceStorageBucket && sourceStoragePath) {
      const signed = await supabase.storage
        .from(sourceStorageBucket)
        .createSignedUrl(sourceStoragePath, 60 * 60);
      if (signed.error || !signed.data?.signedUrl) {
        return json(
          { error: `Could not prepare source sample: ${signed.error?.message ?? "missing signed URL"}` },
          400,
        );
      }
      providerSourceUrl = signed.data.signedUrl;
    }
    if (!/^https:\/\//i.test(providerSourceUrl)) {
      return json({ error: "source sample must be a HTTPS URL." }, 400);
    }

    const jobInsert = await supabase
      .from("workspace_generation_jobs")
      .insert({
        user_id: user.id,
        workspace_id: null,
        project_id: projectId,
        canvas_id: `standalone:${projectId}`,
        node_id: `elevenlabs-ivc-tts-${crypto.randomUUID()}`,
        node_type: "voiceTranslateNode",
        provider: "elevenlabs_ivc_tts",
        model: "elevenlabs-ivc-tts-demo",
        request: {
          action: "elevenlabs_ivc_tts",
          params: {
            model_name: "elevenlabs-ivc-tts-demo",
            source_url: sourceUrl,
            source_storage_bucket: sourceStorageBucket || null,
            source_storage_path: sourceStoragePath || null,
            source_content_type: sourceContentType,
            source_name: sourceName || null,
            project_id: projectId,
            text_length: text.length,
            cleanup_voice: cleanupVoice,
          },
        },
        status: "running",
        attempts: 1,
        max_attempts: 1,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (jobInsert.error || !jobInsert.data?.id) {
      return json(
        { error: `Could not create voice clone TTS job: ${jobInsert.error?.message ?? "missing job id"}` },
        500,
      );
    }
    jobId = String(jobInsert.data.id);

    const sampleRes = await fetch(providerSourceUrl);
    if (!sampleRes.ok) {
      throw new Error(`Could not fetch source sample (HTTP ${sampleRes.status}).`);
    }
    const contentLength = Number(sampleRes.headers.get("content-length") ?? 0);
    if (contentLength > MAX_SAMPLE_BYTES) {
      throw new Error("Source sample is too large for the local prototype. Use a shorter MP3/WAV sample.");
    }
    const sampleBytes = new Uint8Array(await sampleRes.arrayBuffer());
    if (sampleBytes.byteLength > MAX_SAMPLE_BYTES) {
      throw new Error("Source sample is too large for the local prototype. Use a shorter MP3/WAV sample.");
    }

    const apiKey = getElevenLabsKey();
    const sampleName = safeFileName(sourceName, sourceContentType);
    const voice = await createTempVoice({
      apiKey,
      sampleBytes,
      sampleName,
      sampleContentType: sourceContentType,
      removeBackgroundNoise,
    });
    tempVoiceId = voice.voiceId;

    const mp3Bytes = await synthesizeTts({
      apiKey,
      voiceId: voice.voiceId,
      text,
    });

    if (cleanupVoice) {
      voiceDeleted = await deleteVoice(apiKey, voice.voiceId);
    }

    const storagePath = `${user.id}/voice-clone-tts/mediaforge_${Date.now()}.mp3`;
    const upload = await supabase.storage
      .from("user_assets")
      .upload(storagePath, mp3Bytes, {
        contentType: "audio/mpeg",
        upsert: true,
      });
    if (upload.error) throw new Error(`Could not save TTS audio: ${upload.error.message}`);

    const signedOutput = await supabase.storage
      .from("user_assets")
      .createSignedUrl(storagePath, 60 * 60 * 24 * 365);
    if (signedOutput.error || !signedOutput.data?.signedUrl) {
      throw new Error(`Could not sign TTS audio: ${signedOutput.error?.message ?? "missing signed URL"}`);
    }

    const outputUrl = signedOutput.data.signedUrl;
    await supabase.from("user_assets").insert({
      user_id: user.id,
      name: `IVC TTS: ${text.slice(0, 40)}${text.length > 40 ? "..." : ""}`,
      file_url: outputUrl,
      file_type: "audio",
      source: "ai_generated",
      metadata: {
        provider: "elevenlabs_ivc_tts",
        model: DEFAULT_TTS_MODEL,
        project_id: projectId,
        source_name: sourceName || null,
        text_length: text.length,
        temp_voice_deleted: voiceDeleted,
        requires_verification: voice.requiresVerification,
      },
    });

    const result = {
      type: "audio",
      url: outputUrl,
      outputs: {
        audio_url: outputUrl,
        output_audio: outputUrl,
        provider_audio_url: outputUrl,
      },
      provider_meta: {
        provider: "elevenlabs_ivc_tts",
        model: DEFAULT_TTS_MODEL,
        voice_id: voice.voiceId,
        voice_deleted: voiceDeleted,
        requires_verification: voice.requiresVerification,
        source_name: sourceName || null,
        source_content_type: sourceContentType,
      },
    };

    await updateJob({
      jobId,
      userId: user.id,
      status: "completed",
      result,
    });

    return json({
      job_id: jobId,
      status: "completed",
      audio_url: outputUrl,
      voice_id: voice.voiceId,
      voice_deleted: voiceDeleted,
      requires_verification: voice.requiresVerification,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[elevenlabs-voice-clone-tts]", message);
    if (tempVoiceId && !voiceDeleted) {
      try {
        voiceDeleted = await deleteVoice(getElevenLabsKey(), tempVoiceId);
      } catch (deleteErr) {
        console.warn(
          "[elevenlabs-voice-clone-tts] temp voice cleanup failed",
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        );
      }
    }
    if (jobId) {
      await updateJob({
        jobId,
        userId: user.id,
        status: "failed",
        error: message,
        result: {
          type: "audio",
          provider_meta: {
            provider: "elevenlabs_ivc_tts",
            voice_id: tempVoiceId || null,
            voice_deleted: voiceDeleted,
          },
        },
      });
    }
    return json({ error: message, job_id: jobId || undefined }, 502);
  }
});
