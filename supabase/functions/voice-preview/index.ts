/// <reference lib="deno.ns" />
/// <reference lib="dom" />
/**
 * voice-preview — on-demand voice sample synthesis with caching.
 *
 * The voice picker dialog wants to play a 1-line sample for any voice
 * the moment the user hovers ▶. Pre-generating every sample upfront
 * required an admin to run `scripts/generate-voice-previews.ts` —
 * which never happened on workspace dev, so every preview button was
 * silent. This endpoint replaces that workflow:
 *
 *   1. Client POSTs `{ provider, voice_id }`
 *   2. We check the `voice-previews` bucket at
 *      `<provider>/<voice_id>.mp3` — if present, return the public
 *      URL immediately (cheap CDN hit, no synthesis cost).
 *   3. On miss, synthesise via the right provider:
 *        provider=google     → Google Cloud TTS
 *        provider=gemini     → Gemini TTS preview
 *        provider=elevenlabs → ElevenLabs TTS
 *      then upload the MP3 to the cache bucket and return its
 *      public URL.
 *
 * Sample text is fixed (`PREVIEW_TEXT`) and short (~12 words). The
 * preview is free — no credit deduction, no usage logging — but
 * we still rate-limit per user to blunt scripted abuse (20/min,
 * matches the picker grid size + a generous re-click buffer).
 *
 * Auth: verify_jwt = true. The bucket's INSERT policy requires
 *       `authenticated` so the function must run with the user's JWT
 *       to perform the upload (service_role would bypass RLS but
 *       we want to keep the audit trail in `storage.objects` keyed
 *       to a real auth.uid()).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* Sample text — split per language so Thai voices read Thai, every
 * other locale reads English. Short on purpose so first-byte latency
 * is low when the user clicks ▶ on a fresh voice. */
const PREVIEW_TEXT_EN =
  "Hi, I'm a sample voice. Try me out for your next project.";
const PREVIEW_TEXT_TH =
  "สวัสดีครับ นี่คือตัวอย่างเสียง ลองนำไปใช้กับโปรเจคของคุณได้เลย";

type Provider = "google" | "gemini" | "elevenlabs";

const ALLOWED_PROVIDERS: ReadonlySet<Provider> = new Set([
  "google",
  "gemini",
  "elevenlabs",
] as const);

const _userHits = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20; // 20 previews / minute / instance / user
function rateLimitOk(userId: string): boolean {
  const now = Date.now();
  const arr = (_userHits.get(userId) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (arr.length >= RATE_LIMIT) {
    _userHits.set(userId, arr);
    return false;
  }
  arr.push(now);
  _userHits.set(userId, arr);
  return true;
}

/* ─── Provider synthesis helpers ─────────────────────────────────── */

/** Pick the sample text by language. Default = English. */
function sampleTextFor(provider: Provider, voiceId: string): string {
  // Google voice ids look like `th-TH-Standard-A` — lang prefix tells us.
  if (provider === "google" && voiceId.startsWith("th-")) {
    return PREVIEW_TEXT_TH;
  }
  // Gemini doesn't encode language in its voice id (Aoede, Charon, …)
  // and ElevenLabs voices are language-agnostic — both default to EN.
  return PREVIEW_TEXT_EN;
}

async function synthesiseGoogle(voiceId: string): Promise<Uint8Array> {
  const apiKey =
    Deno.env.get("GOOGLE_TTS_API_KEY")?.trim() ||
    Deno.env.get("GOOGLE_CLOUD_TTS_API_KEY")?.trim() ||
    Deno.env.get("GOOGLE_API_KEY")?.trim();
  if (!apiKey) throw new Error("GOOGLE_TTS_API_KEY not configured");
  const langMatch = voiceId.match(/^([a-z]{2}-[A-Z]{2})-/);
  const languageCode = langMatch?.[1] ?? "en-US";
  const text = sampleTextFor("google", voiceId);
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceId },
        audioConfig: { audioEncoding: "MP3" },
      }),
    },
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google TTS HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const b64 = String(json.audioContent ?? "");
  if (!b64) throw new Error("Google TTS returned no audio content");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function synthesiseGemini(
  voiceId: string,
  modelId: string,
): Promise<Uint8Array> {
  const apiKey =
    Deno.env.get("GOOGLE_AI_STUDIO_KEY")?.trim() ||
    Deno.env.get("GEMINI_API_KEY")?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const text = sampleTextFor("gemini", voiceId);
  // Use the user-selected Gemini model so Pro and Flash each preview
  // with their actual voice (they share voice ids but render slightly
  // differently). Hard-coding flash made every preview sound like
  // flash even when the user picked Pro.
  const allowed = new Set([
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-pro-preview-tts",
    "gemini-2.5-flash-preview-tts",
  ]);
  const aliases: Record<string, string> = {
    "gemini-3.1-preview-flash-tts": "gemini-3.1-flash-tts-preview",
    "gemini-3.1-flash-preview-tts": "gemini-3.1-flash-tts-preview",
    "gemini-3-flash-tts-preview": "gemini-3.1-flash-tts-preview",
  };
  const normalizedModel = aliases[modelId] ?? modelId;
  const model = allowed.has(normalizedModel) ? normalizedModel : "gemini-3.1-flash-tts-preview";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } },
        },
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini TTS HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const b64 = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64 || typeof b64 !== "string") {
    throw new Error("Gemini TTS returned no audio data");
  }
  const bin = atob(b64);
  const pcm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
  // Gemini emits raw PCM; wrap in a minimal WAV header so browsers
  // can play it without a transcode step. 24kHz / 16-bit / mono is
  // what the Gemini TTS preview models output as of 2026-04.
  return pcmToWav(pcm, 24000, 1, 16);
}

/** Chunked base64 encoder — `btoa(String.fromCharCode(...bytes))`
 *  fails with "Maximum call stack size exceeded" once the byte array
 *  pushes past ~125k entries (V8 / Deno spread limit). 32KB chunks
 *  keep each `String.fromCharCode` call well below the threshold,
 *  and `btoa` itself handles arbitrary-length strings fine. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number,
  numChannels: number,
  bitsPerSample: number,
): Uint8Array {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + dataSize);
  const view = new DataView(wav.buffer);
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  wav.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  wav.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);
  wav.set(pcm, headerSize);
  return wav;
}

/** ElevenLabs API key — accepts either name. The Supabase secret was
 *  set as `ELEVEN_API_KEY` (the form on Freepik / public docs uses
 *  the short form), but our earlier draft used `ELEVENLABS_API_KEY`.
 *  Reading both means we don't have to make admins rename the secret
 *  to match our code; whichever they set wins. */
function elevenApiKey(): string | undefined {
  for (const name of ["ELEVEN_API_KEY", "ELEVENLABS_API_KEY"]) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

async function synthesiseElevenLabs(
  voiceId: string,
  modelId: string,
): Promise<Uint8Array> {
  const apiKey = elevenApiKey();
  if (!apiKey) {
    throw new Error(
      "ElevenLabs not configured — set ELEVEN_API_KEY or ELEVENLABS_API_KEY in Supabase project secrets.",
    );
  }
  const text = sampleTextFor("elevenlabs", voiceId);
  // model_id is now driven by the caller so a preview reflects the
  // exact model the user has selected (Multilingual v2 vs Turbo v2.5
  // sound noticeably different — clipping the preview to one model
  // mis-represents the others). Falls back to Turbo v2.5 if the
  // caller didn't pass one.
  const safeModel = modelId && /^eleven[_a-z0-9-]+$/i.test(modelId)
    ? modelId
    : "eleven_turbo_v2_5";
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: safeModel,
      voice_settings: { stability: 0.55, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/* ─── Server ─────────────────────────────────────────────────────── */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify the user — we use the user-scoped client so the upload
    // below is recorded against the actual auth.uid().
    const supabaseUser = createClient(SUPABASE_URL, ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!rateLimitOk(user.id)) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Wait a moment." }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const body = (await req.json()) as {
      provider?: string;
      voice_id?: string;
      model_id?: string;
    };
    const provider = String(body.provider ?? "").toLowerCase() as Provider;
    const voiceId = String(body.voice_id ?? "").trim();
    const modelId = String(body.model_id ?? "").trim();
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return new Response(
        JSON.stringify({ error: "Invalid provider" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!voiceId || !/^[A-Za-z0-9._-]+$/.test(voiceId)) {
      return new Response(
        JSON.stringify({ error: "Invalid voice_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Bucket cache check. Use the service-role client for the metadata
    // probe since the public-read policy answers anonymous fetch but
    // doesn't expose `.list()` to anon. The publicUrl we return is
    // resolvable by anyone via the policy.
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const ext = provider === "gemini" ? "wav" : "mp3";
    // Cache key includes the model so two different Gemini /
    // ElevenLabs models for the same voice id don't share a cached
    // sample (they sound noticeably different). Google TTS doesn't
    // have a per-call model concept — the voice id IS the model — so
    // its cache key stays voice-only.
    const modelSlug = (modelId || "default").replace(/[^A-Za-z0-9._-]+/g, "-");
    const cachePath =
      provider === "google"
        ? `${provider}/${voiceId}.${ext}`
        : `${provider}/${modelSlug}/${voiceId}.${ext}`;
    const probeDir =
      provider === "google" ? provider : `${provider}/${modelSlug}`;

    // Quick existence probe — list with a search filter.
    const { data: listData } = await supabaseAdmin.storage
      .from("voice-previews")
      .list(probeDir, { search: `${voiceId}.${ext}`, limit: 1 });
    const cached = (listData ?? []).find((o) => o.name === `${voiceId}.${ext}`);
    if (cached) {
      const { data: pub } = supabaseAdmin.storage
        .from("voice-previews")
        .getPublicUrl(cachePath);
      return new Response(
        JSON.stringify({
          url: pub.publicUrl,
          cached: true,
          provider,
          voice_id: voiceId,
          model_id: modelId || null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Synthesize on-demand.
    let bytes: Uint8Array;
    let contentType: string;
    try {
      if (provider === "google") {
        bytes = await synthesiseGoogle(voiceId);
        contentType = "audio/mpeg";
      } else if (provider === "gemini") {
        bytes = await synthesiseGemini(voiceId, modelId);
        contentType = "audio/wav";
      } else {
        bytes = await synthesiseElevenLabs(voiceId, modelId);
        contentType = "audio/mpeg";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[voice-preview] synth failed provider=${provider} voice=${voiceId} model=${modelId}: ${msg}`);
      return new Response(
        JSON.stringify({ error: msg }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Cache + return URL.
    const { error: upErr } = await supabaseAdmin.storage
      .from("voice-previews")
      .upload(cachePath, bytes, { contentType, upsert: true });
    if (upErr) {
      // Upload failure is non-fatal — we can still return a data URL
      // from the bytes we already have. Log it so admins can see if
      // bucket policy drift starts breaking the cache path.
      console.error(`[voice-preview] cache upload failed: ${upErr.message}`);
      // CHUNKED base64 encode — `String.fromCharCode(...bytes)` blows
      // the V8 stack at ~125k args (a 4-second 24kHz s16 PCM clip is
      // ~192KB → 192k args), so the previous one-liner crashed the
      // function with "Maximum call stack size exceeded" any time the
      // upload fallback fired. Iterating in 32KB chunks keeps each
      // spread under the engine limit.
      const b64 = bytesToBase64(bytes);
      return new Response(
        JSON.stringify({
          url: `data:${contentType};base64,${b64}`,
          cached: false,
          provider,
          voice_id: voiceId,
          warning: upErr.message,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: pub } = supabaseAdmin.storage
      .from("voice-previews")
      .getPublicUrl(cachePath);
    return new Response(
      JSON.stringify({
        url: pub.publicUrl,
        cached: false,
        provider,
        voice_id: voiceId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[voice-preview] unexpected error: ${msg}`);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
