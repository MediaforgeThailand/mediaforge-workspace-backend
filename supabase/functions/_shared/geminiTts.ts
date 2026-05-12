/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderResult } from "./providerResult.ts";
import { fetchWithAttemptTimeout } from "./providerErrors.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export async function executeGeminiTts(
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
