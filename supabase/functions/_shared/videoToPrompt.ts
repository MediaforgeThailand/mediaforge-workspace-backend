/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import type { ProviderResult } from "./providerResult.ts";
import { bytesToBase64, fetchImageBuffer } from "./imageUtils.ts";
import { fetchWithAttemptTimeout, isProviderBillingLike } from "./providerErrors.ts";

export async function executeVideoToPrompt(params: Record<string, unknown>): Promise<ProviderResult> {
  const KEY =
    Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
  if (!KEY) {
    throw new Error("GEMINI_API_KEY (or GOOGLE_AI_STUDIO_KEY) is not configured");
  }

  const requestedModel = String(params.model_name ?? "gemini-3-pro-preview");
  const model =
    requestedModel === "gemini-3.1-pro-preview"
      ? "gemini-3-pro-preview"
      : requestedModel;
  const videoUrl = String(params.video_url ?? "");
  if (!videoUrl) {
    throw new Error("Video to Prompt requires a video input.");
  }
  const userExtra = String(params.prompt ?? "").trim();
  const language = String(params.language ?? "th").toLowerCase();
  const langName = language === "en" ? "English" : "Thai";

  // Fetch + base64-encode the video bytes (reusing the image helper —
  // it's a generic byte fetcher, not image-specific).
  const bytes = await fetchImageBuffer(videoUrl);
  if (bytes.byteLength > 20 * 1024 * 1024) {
    throw new Error(
      `Video is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Gemini inline cap is 20 MB. Use a shorter clip or wait for the Files API path.`,
    );
  }
  const base64 = bytesToBase64(bytes);

  // MIME from URL extension (good enough for the common cases).
  let mime = "video/mp4";
  const lower = videoUrl.toLowerCase();
  if (lower.includes(".webm")) mime = "video/webm";
  else if (lower.includes(".mov") || lower.includes(".quicktime")) mime = "video/quicktime";
  else if (lower.includes(".m4v")) mime = "video/x-m4v";
  else if (lower.includes(".mkv")) mime = "video/x-matroska";

  // System prompt — keep this short and direct. Gemini follows
  // structured instructions well; over-prompting hurts more than it
  // helps for a multimodal task like this.
  const systemPrompt =
    `You are a professional cinematographer and photography director analysing a short video clip.\n\n` +
    `Watch the attached video carefully and break it down scene-by-scene. A "scene" is a continuous shot or a cohesive group of shots that share the same setup; cut whenever the camera, subject, or location changes substantially.\n\n` +
    `For each scene, describe (use proper photography + film terminology — shot size, camera angle, camera movement, lens feel, lighting setup, key/fill ratio, time of day, colour palette, mood, framing principles like rule-of-thirds or leading lines, depth-of-field, composition):\n` +
    `  • Subject + composition\n` +
    `  • Camera (shot size, angle, movement)\n` +
    `  • Lens feel (wide / standard / telephoto, approx focal length impression)\n` +
    `  • Lighting + colour grading\n` +
    `  • Action / motion\n` +
    `  • Mood / atmosphere\n\n` +
    `Output format: numbered scenes with short headers. End with a one-sentence overall stylistic summary the user could re-use as a prompt for an image / video generator.\n\n` +
    `Respond in ${langName}.`;

  const userTurn = userExtra
    ? `${userExtra}\n\n(Default analysis above applies if the instruction above doesn't override it.)`
    : "Analyse this video.";

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: `${systemPrompt}\n\n---\n\n${userTurn}` },
          { inlineData: { mimeType: mime, data: base64 } },
        ],
      },
    ],
    generationConfig: { responseModalities: ["TEXT"] },
  };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`;
  console.log(`[video-to-prompt] Calling ${model}, video=${(bytes.byteLength / 1024).toFixed(0)}KB`);

  const resp = await fetchWithAttemptTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Timeout": "110",
      },
      body: JSON.stringify(requestBody),
    },
    105_000,
    "Video to Prompt",
  );

  if (!resp.ok) {
    const errText = (await resp.text()).substring(0, 500);
    console.error(`[video-to-prompt] Gemini ${resp.status}:`, errText);
    if (isProviderBillingLike(resp.status, errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(`Video to Prompt failed (HTTP ${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no text — try a shorter clip or different model.");
  }

  return {
    outputs: { text },
    output_type: "text" as const,
    provider_meta: { model, video_bytes: bytes.byteLength, mime },
  };
}
