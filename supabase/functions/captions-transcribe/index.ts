/**
 * captions-transcribe edge function
 *
 * Proxies the OpenAI Whisper API for caption / subtitle generation in
 * OpenReel Video. Receives a multipart form-data POST with the audio blob
 * (extracted client-side) plus optional `language` and `prompt` fields.
 * Returns Whisper's verbose_json shape including word-level timestamps so
 * the client can render karaoke-style word highlight captions.
 *
 * Auth: requires a valid Supabase user JWT.
 * Secrets: OPENAI_API_KEY must be set via `supabase secrets set`.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getAuthUser, unauthorized } from "../_shared/auth.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = {
  "Content-Type": "application/json",
  ...corsHeaders,
};

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens?: number[];
  temperature?: number;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}

interface WhisperVerboseResponse {
  task?: string;
  language?: string;
  duration?: number;
  text?: string;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  // Verify caller JWT (verify_jwt=true at the gateway also enforces this,
  // but we double-check so the caller's identity is available for logging).
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  if (!OPENAI_KEY) {
    return new Response(
      JSON.stringify({
        error: "Captions transcription is not configured (missing OPENAI_API_KEY)",
      }),
      { status: 500, headers: jsonHeaders },
    );
  }

  // Parse the multipart form. The Whisper API only accepts audio under
  // 25 MB so we reject anything bigger up front.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Invalid form data: ${(err as Error).message}` }),
      { status: 400, headers: jsonHeaders },
    );
  }

  const audio = formData.get("audio") as File | null;
  if (!audio) {
    return new Response(JSON.stringify({ error: "Missing audio file" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  // 25 MB is OpenAI Whisper's hard cap.
  const MAX_SIZE = 25 * 1024 * 1024;
  if (audio.size > MAX_SIZE) {
    return new Response(
      JSON.stringify({
        error: `Audio too large (${(audio.size / 1024 / 1024).toFixed(1)}MB). Whisper accepts up to 25MB.`,
      }),
      { status: 413, headers: jsonHeaders },
    );
  }

  const language = (formData.get("language") as string | null) || "auto";
  const prompt = formData.get("prompt") as string | null;
  // Word-level timestamps are the whole point — always request them but allow
  // the caller to disable via `granularity=segment` if they don't want them.
  const granularity = (formData.get("granularity") as string | null) || "word";

  // Build the OpenAI request
  const openaiForm = new FormData();
  // Preserve original filename if present, otherwise default to audio.wav.
  const filename = audio.name || "audio.wav";
  openaiForm.append("file", audio, filename);
  openaiForm.append("model", "whisper-1");
  openaiForm.append("response_format", "verbose_json");
  if (granularity === "word") {
    openaiForm.append("timestamp_granularities[]", "word");
  }
  if (language && language !== "auto") {
    openaiForm.append("language", language);
  }
  if (prompt) {
    openaiForm.append("prompt", prompt);
  }

  const startedAt = Date.now();
  let resp: Response;
  try {
    resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: openaiForm,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `OpenAI request failed: ${(err as Error).message}`,
      }),
      { status: 502, headers: jsonHeaders },
    );
  }

  if (!resp.ok) {
    const errorText = await resp.text();
    let errorBody: unknown;
    try {
      errorBody = JSON.parse(errorText);
    } catch {
      errorBody = errorText;
    }
    return new Response(
      JSON.stringify({
        error: "OpenAI Whisper API error",
        status: resp.status,
        details: errorBody,
      }),
      { status: resp.status, headers: jsonHeaders },
    );
  }

  let data: WhisperVerboseResponse;
  try {
    data = await resp.json();
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `Failed to parse Whisper response: ${(err as Error).message}`,
      }),
      { status: 502, headers: jsonHeaders },
    );
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[captions-transcribe] user=${user.id} duration=${data.duration ?? 0}s lang=${data.language ?? "?"} words=${data.words?.length ?? 0} elapsed=${elapsed}ms`,
  );

  return new Response(
    JSON.stringify({
      words: data.words ?? [],
      segments: data.segments ?? [],
      language: data.language,
      text: data.text,
      duration: data.duration,
    }),
    { headers: jsonHeaders },
  );
});
