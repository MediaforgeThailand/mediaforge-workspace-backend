/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bytesToBase64, fetchImageBuffer } from "./imageUtils.ts";
import { isProviderBillingLike, summarizeProviderErrorBody } from "./providerErrors.ts";
import { shouldFastFallbackProviderError } from "./providerRetry.ts";
import type { ProviderResult } from "./providerResult.ts";
import {
  WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS,
  workspaceAiMediaPipelinePath,
} from "./storageUrl.ts";

const BANANA_MODEL_MAP: Record<string, string> = {
  "nano-banana-pro": "nano-banana-pro",
  "nano-banana-2":   "nano-banana-2",
};

const GEMINI_IMAGE_MODELS: Record<string, { gemini_model: string }> = {
  "nano-banana-pro": { gemini_model: "gemini-3-pro-image-preview" },
  "nano-banana-2":   { gemini_model: "gemini-3.1-flash-image-preview" },
};

type GeminiImageApiKeyAlias = "primary" | "gemini2";

function loadGeminiImageApiKey(alias: GeminiImageApiKeyAlias = "primary"): string {
  if (alias === "gemini2") {
    const key = Deno.env.get("GEMINI2_API_KEY");
    if (!key) {
      throw new Error("Gemini image: GEMINI2_API_KEY is not configured in Supabase project secrets.");
    }
    return key;
  }
  const key = Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
  if (!key) {
    throw new Error("Gemini image: GOOGLE_AI_STUDIO_KEY (or GEMINI_API_KEY) is not configured in Supabase project secrets.");
  }
  return key;
}

/** Whether a secondary Gemini API key is configured. Used by executors
 *  to decide whether to attempt a fallback retry after the primary
 *  key fails — same pattern as the Veo executor. */
function hasGeminiImageFallbackKey(): boolean {
  return Boolean(Deno.env.get("GEMINI2_API_KEY"));
}


export async function executeBanana(
  params: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
  userId?: string | null,
): Promise<ProviderResult> {
  // Banana must stay on the primary Gemini image key. Do not silently route
  // to secondary keys or wrapper providers; this keeps failures attributable
  // to one provider path and prevents hidden cost drift.
  loadGeminiImageApiKey("primary");

  const rawModel = String(params.model_name ?? params.model ?? "nano-banana-pro");
  const modelId = BANANA_MODEL_MAP[rawModel] ?? rawModel;
  const modelConfig = GEMINI_IMAGE_MODELS[modelId];
  if (!modelConfig) throw new Error(`Unknown Banana model: ${modelId}. Available: ${Object.keys(GEMINI_IMAGE_MODELS).join(", ")}`);

  const prompt = String(params.prompt ?? "");
  const aspectRatio = String(params.aspect_ratio ?? "Auto");
  /* Output resolution. Maps to Gemini's `imageConfig.imageSize`:
   *   "1K" / "2K" — Banana 2 (Flash Image)
   *   "1K" / "2K" / "4K" — Banana Pro (Pro Image)
   * Empty / "auto" leaves the field off entirely so Gemini picks
   * the model's default resolution. */
  const imageSize = String(params.image_size ?? "").trim();
  const imageUrl = params.image_url as string | undefined;
  const mentionImageUrls = params.mention_image_urls as string[] | undefined;

  if (!prompt) throw new Error("A prompt is required.");

  // Build Gemini API request parts
  const parts: Array<Record<string, unknown>> = [];
  parts.push({ text: prompt });

  // Resolve reference images to base64 inline data for Gemini
  const imageUrls: string[] = mentionImageUrls ?? (imageUrl ? [imageUrl] : []);
  let resolvedReferenceCount = 0;
  let failedReferenceCount = 0;
  let totalReferenceBytes = 0;
  const referenceByteSummaries: string[] = [];
  const hasReferenceImages = imageUrls.length > 0;
  if (hasReferenceImages) {
    for (const url of imageUrls) {
      try {
        const bytes = await fetchImageBuffer(url);
        totalReferenceBytes += bytes.byteLength;
        const base64 = bytesToBase64(bytes);
        // Detect mime from first bytes
        let mime = "image/png";
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = "image/jpeg";
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = "image/webp";
        referenceByteSummaries.push(`${mime}:${Math.round(bytes.byteLength / 1024)}KB`);
        parts.push({ inlineData: { mimeType: mime, data: base64 } });
        resolvedReferenceCount += 1;
      } catch (imgErr) {
        failedReferenceCount += 1;
        console.warn(`[banana-direct] Failed to resolve image: ${imgErr}`);
      }
    }
    console.log(
      `[banana-direct] Added ${resolvedReferenceCount}/${imageUrls.length} reference images` +
        ` (${Math.round(totalReferenceBytes / 1024)}KB raw: ${referenceByteSummaries.join(", ")})` +
        (failedReferenceCount > 0 ? ` (${failedReferenceCount} failed to load)` : ""),
    );
    if (resolvedReferenceCount === 0) {
      throw new Error(
        `Reference images could not be loaded for this attempt (${failedReferenceCount}/${imageUrls.length} failed). ` +
          "The background worker will retry automatically.",
      );
    }
  }

  console.log(
    `[banana-direct] Requesting ${modelId} (${modelConfig.gemini_model}), ` +
      `ref_images: ${resolvedReferenceCount}/${imageUrls.length}`,
  );

  // Build generationConfig — both aspectRatio and imageSize live
  // under `imageConfig`. We only include keys the user actually
  // set so Gemini's default kicks in for the others.
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  const imageConfig: Record<string, unknown> = {};
  if (aspectRatio && aspectRatio !== "Auto") {
    imageConfig.aspectRatio = aspectRatio;
  }
  if (imageSize && imageSize.toLowerCase() !== "auto") {
    imageConfig.imageSize = imageSize;
  }
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig;
  }

  // ── Global Nano Banana tier override (admin-controlled throttle) ──
  // subscription_settings.nano_banana_tier_override:
  //   'auto'           → honour params.service_tier (current behavior)
  //   'force_standard' → strip service_tier (always Standard)
  //   'force_flex'     → set service_tier="flex" (cheaper but slower/queued)
  // NOTE: Gemini Developer API REST contract requires snake_case "service_tier"
  // at the root of the request body with lowercase value "flex" — NOT
  // camelCase "serviceTier" with "FLEX". The previous payload was rejected
  // with HTTP 400 every time, which is what made every Banana Pro request
  // fail right after Force Flex was applied.
  // Ref: https://ai.google.dev/gemini-api/docs/flex-inference  (REST tab)
  let useFlex = false;
  try {
    const { data: tierRow } = await supabase
      .from("subscription_settings")
      .select("value")
      .eq("key", "nano_banana_tier_override")
      .maybeSingle();
    const override = (tierRow?.value as string | undefined) ?? "auto";
    if (override === "force_flex") {
      // Flex is cheaper but can sit in Google's queue longer than an Edge
      // invocation can stay alive. Reference-image jobs are especially prone
      // to short abort loops because each retry re-submits a fresh request,
      // so keep those on Standard for user-facing workspace generation.
      useFlex = !hasReferenceImages;
    } else if (override === "force_standard") {
      useFlex = false;
    } else {
      const fromParam = String(params.service_tier ?? "").toLowerCase();
      useFlex = fromParam === "flex";
    }
    console.log(`[banana-direct] Tier override='${override}', resolved=${useFlex ? "FLEX" : "STANDARD"}`);
  } catch (tierErr) {
    console.warn(`[banana-direct] Failed to read tier override, defaulting to Standard:`, tierErr);
  }

  const requestPayload: Record<string, unknown> = {
    contents: [{ parts }],
    generationConfig,
  };
  if (useFlex) {
    // REST contract: snake_case key + lowercase value
    requestPayload.service_tier = "flex";
  }
  const geminiRequestBody = JSON.stringify(requestPayload);

  /* ── Hard client-side timeout ─────────────────────────────
   * Supabase edge functions die with WORKER_RESOURCE_LIMIT once
   * total CPU time crosses ~150s (default tier). Gemini Pro Image
   * with Flex queueing or many ref images can blow past that, so
   * we abort the fetch at ~120s — leaving enough headroom for the
   * upload + JSON-parse work below to finish before the platform
   * pulls the plug. The caller gets a friendly error instead of a
   * generic platform 500. */
  // Keep this just under Supabase Edge's ~150s request idle timeout. Google
  // image models can spend more than two minutes in prefill; the previous 115s
  // server hint caused Gemini to return DEADLINE_EXCEEDED before it had a fair
  // chance to finish.
  const ABORT_MS = 148_000;
  const modelLabel = modelId === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2";

  async function callGeminiImage(apiKeyAlias: GeminiImageApiKeyAlias): Promise<Response> {
    const apiKey = loadGeminiImageApiKey(apiKeyAlias);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.gemini_model}:generateContent?key=${apiKey}`;
    console.log(`[banana-direct] Calling model: ${modelConfig.gemini_model} key=${apiKeyAlias}`);
    const aborter = new AbortController();
    const abortTimer = setTimeout(() => aborter.abort(), ABORT_MS);
    try {
      return await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Ask Gemini to return before the Edge gateway idle timeout.
          "X-Server-Timeout": "145",
        },
        body: geminiRequestBody,
        signal: aborter.signal,
      });
    } catch (fetchErr) {
      if ((fetchErr as { name?: string })?.name === "AbortError") {
        console.error(`[banana-direct] Gemini fetch aborted after ${ABORT_MS}ms key=${apiKeyAlias}`);
        const refSummary =
          imageUrls.length > 0
            ? `refs loaded ${resolvedReferenceCount}/${imageUrls.length}`
            : "no refs";
        return new Response(
          `${modelLabel} timed out after ${Math.round(ABORT_MS / 1000)}s on this attempt (${refSummary}). ` +
            "This is provider latency/queue timeout, not a reference-image format error; the queue will retry with a longer Banana backoff to protect Gemini quota.",
          { status: 504 },
        );
      }
      throw fetchErr;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  let apiKeyAlias: GeminiImageApiKeyAlias = "primary";
  let aiResponse = await callGeminiImage(apiKeyAlias);

  if (!aiResponse.ok) {
    let statusCode = aiResponse.status;
    let errorText = await aiResponse.text();
    console.error(`[banana-direct] Gemini API error key=${apiKeyAlias}: ${statusCode}`, errorText.substring(0, 500));

    // Fallback to GEMINI2_API_KEY only for quota/rate-limit/billing-like
    // failures. Busy/high-demand 5xx should stay on the same key and let the
    // durable queue back off; otherwise the backup quota drains too quickly.
    const shouldFallback =
      hasGeminiImageFallbackKey() &&
      shouldFastFallbackProviderError(`HTTP ${statusCode}: ${errorText}`);

    if (shouldFallback) {
      console.warn(`[banana-direct] retrying with gemini2 key after HTTP ${statusCode}`);
      apiKeyAlias = "gemini2";
      aiResponse = await callGeminiImage(apiKeyAlias);
      if (!aiResponse.ok) {
        statusCode = aiResponse.status;
        errorText = await aiResponse.text();
        console.error(`[banana-direct] Gemini API error key=${apiKeyAlias}: ${statusCode}`, errorText.substring(0, 500));
      }
    }

    if (!aiResponse.ok) {
      if (isProviderBillingLike(statusCode, errorText)) {
        throw new Error("PROVIDER_BILLING_ERROR");
      }
      // Google's Pro image model occasionally returns 504
      // DEADLINE_EXCEEDED when its render queue can't finish within
      // the X-Server-Timeout we send (145s — just under the
      // Supabase Edge gateway's idle limit). Both keys hit it when
      // Google's backend itself is slow that minute. Surface a
      // clearer message to the user so they understand the queue
      // retries are bounded by Google's latency, not our code, and
      // they can proactively switch to nano-banana-2 (Flash) for a
      // faster result.
      const isDeadlineExceeded =
        statusCode === 504 || /DEADLINE_EXCEEDED/i.test(errorText);
      if (isDeadlineExceeded) {
        throw new Error(
          `${modelLabel} timed out on Google's side (HTTP 504 DEADLINE_EXCEEDED, key=${apiKeyAlias}). ` +
            "Pro image rendering is heavy; this usually clears within a few minutes when Google's queue catches up. " +
            "If it keeps failing, try a shorter prompt, fewer reference images, or Nano Banana 2 (Flash) for a quicker render.",
        );
      }
      const providerDetail = summarizeProviderErrorBody(errorText);
      throw new Error(
        `${modelLabel} failed (HTTP ${statusCode}, key=${apiKeyAlias}): ` +
          (providerDetail || "Provider returned no error body."),
      );
    }
  }

  const aiResult = await aiResponse.json();
  const firstCandidate = Array.isArray(aiResult.candidates) ? aiResult.candidates[0] : null;
  const responseParts = firstCandidate?.content?.parts || [];

  // Extract image from response
  let imageBase64: string | null = null;
  let imageMime = "image/png";
  const textParts: string[] = [];

  for (const part of responseParts) {
    const inlineData = part.inlineData ?? part.inline_data;
    if (inlineData?.data) {
      imageBase64 = inlineData.data;
      imageMime = inlineData.mimeType ?? inlineData.mime_type ?? "image/png";
    }
    if (typeof part.text === "string" && part.text.trim()) {
      textParts.push(part.text.trim());
    }
  }

  if (!imageBase64) {
    const finishReason = String(firstCandidate?.finishReason ?? firstCandidate?.finish_reason ?? "").toUpperCase();
    const finishMessage = String(firstCandidate?.finishMessage ?? firstCandidate?.finish_message ?? "");
    const promptBlockReason = String(aiResult.promptFeedback?.blockReason ?? aiResult.prompt_feedback?.block_reason ?? "");
    const providerText = textParts.join(" ").slice(0, 220);
    const safetyHint = `${finishReason} ${finishMessage} ${promptBlockReason} ${providerText}`;
    console.warn(
      `[banana-direct] Gemini returned no image. finish=${finishReason || "empty"} ` +
        `block=${promptBlockReason || "none"} text=${providerText || "none"} ` +
        `parts=${responseParts.length}`,
    );
    if (/SAFETY|BLOCK|PROHIBITED|RECITATION|SPII/i.test(safetyHint)) {
      throw new Error(
        `${modelLabel} blocked this prompt by content policy. Please adjust the prompt or references.`,
      );
    }
    throw new Error(
      `${modelLabel} provider returned an empty image response on this attempt. ` +
        "This can happen during provider pressure; the background worker will retry automatically.",
    );
  }

  // Upload to storage
  const ext = imageMime.split("/")[1] || "png";
  const fileName = workspaceAiMediaPipelinePath(
    userId,
    `mediaforge_${Date.now()}.${ext}`,
  );
  const binaryData = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));

  let publicUrl = `data:${imageMime};base64,${imageBase64}`;

  const { error: uploadError } = await supabase.storage
    .from("ai-media")
    .upload(fileName, binaryData, { contentType: imageMime, upsert: true });

  if (uploadError) {
    console.error("[banana-direct] Upload error:", uploadError);
  } else {
    const { data: urlData, error: signError } = await supabase.storage
      .from("ai-media")
      .createSignedUrl(fileName, WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS);
    if (!signError && urlData?.signedUrl) {
      publicUrl = urlData.signedUrl;
    } else {
      const { data: pubData } = supabase.storage.from("ai-media").getPublicUrl(fileName);
      publicUrl = pubData.publicUrl;
    }
  }

  console.log(`[banana-direct] Success — image uploaded to storage`);

  return {
    result_url: publicUrl,
    outputs: { output_image: publicUrl },
    output_type: "image_url" as const,
    provider_meta: {
      model: modelId,
      api_key_alias: apiKeyAlias,
      reference_image_count: resolvedReferenceCount,
      reference_image_requested_count: imageUrls.length,
      reference_image_failed_count: failedReferenceCount,
      storage_bucket: "ai-media",
      storage_path: fileName,
      signed_url_ttl_seconds: WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS,
    },
  };
}
