/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderResult } from "./providerResult.ts";
import { clampNum } from "./providerParams.ts";

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
export async function executeElevenLabsTts(
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
