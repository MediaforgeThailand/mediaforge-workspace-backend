/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderResult } from "./providerResult.ts";
import { clampNum } from "./providerParams.ts";

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

export async function executeGoogleTts(
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
