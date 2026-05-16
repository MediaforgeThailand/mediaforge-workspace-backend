/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  coerceOpenAIEditSize,
  detectOpenAIImageFile,
  fetchImageBuffer,
  openAIReferenceImageError,
  OPENAI_IMAGE_MAX_BYTES,
  toSupabaseRenderUrlForOpenAI,
} from "./imageUtils.ts";
import { prepareReferenceImage } from "./imageValidation.ts";
import {
  fetchWithAttemptTimeout,
  isProviderBillingLike,
  summarizeProviderErrorText,
} from "./providerErrors.ts";
import type { ProviderResult } from "./providerResult.ts";

/**
 * OpenAI gpt-image-2 executor.
 *
 * Mirrors the spec used by the legacy product:
 *   - `/v1/images/edits` when ref images are present (multipart with
 *     repeated `image` parts — OpenAI SDK convention, NOT `image[]`)
 *   - `/v1/images/generations` when text-only (JSON body)
 *   - Conservative param set on /edits (no background, no
 *     output_format) to dodge the 403s the legacy editor was seeing.
 *   - Surfaces OpenAI's verbatim error message — they're the most
 *     useful diagnostic for billing / safety / quota issues.
 */
const OPENAI_IMAGE_2_ATTEMPT_TIMEOUT_MS = 145_000;
const GPT_IMAGE_2_ENHANCE_PROMPT =
  "Enhance and upscale the provided image while preserving the original composition, subject identity, colors, camera angle, and aspect ratio. Improve sharpness, clarity, texture, and fine detail without adding new objects or changing the scene.";

export async function executeOpenAIImage2(
  params: Record<string, unknown>,
  supabase: ReturnType<typeof createClient>,
): Promise<ProviderResult> {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

  const requestedModel = String(params.model_name ?? params.model ?? "gpt-image-2");
  const isEnhanceMode =
    requestedModel.toLowerCase() === "gpt-image-2-enhance" ||
    String(params.mode ?? "").toLowerCase() === "enhance";
  const prompt = String(params.prompt ?? (isEnhanceMode ? GPT_IMAGE_2_ENHANCE_PROMPT : ""));
  if (!prompt) throw new Error("A prompt is required.");

  const model = isEnhanceMode ? "gpt-image-2" : requestedModel;
  const requestedQuality = String(params.quality ?? "medium").toLowerCase();
  const quality =
    requestedQuality === "low" || requestedQuality === "medium" || requestedQuality === "high"
      ? requestedQuality
      : "medium";
  // Coerce to one of OpenAI's four supported sizes. Frontends
  // sometimes pass arbitrary aspect ratios (1024x1280 etc.) which
  // gpt-image-1 rejects with `Invalid size '...'` — surfaced to the
  // user as a generic provider error.
  const size = coerceOpenAIEditSize(String(params.size ?? "1024x1024"));
  const outputFormat = String(params.output_format ?? "png");
  const rawOutputCompression = Number(params.output_compression ?? 100);
  const outputCompression = Number.isFinite(rawOutputCompression)
    ? Math.max(0, Math.min(100, Math.round(rawOutputCompression)))
    : 100;
  // `background` accepts "auto" | "transparent" | "opaque". Transparent
  // requires the output format to be png or webp; OpenAI rejects it
  // with jpeg, so we silently force-fallback to "auto" in that case
  // rather than letting the user hit an error from the provider.
  const rawBackground = String(params.background ?? "auto");
  const background =
    rawBackground === "transparent" && outputFormat === "jpeg"
      ? "auto"
      : rawBackground;
  const moderation = String(params.moderation ?? "auto");

  const refUrls: string[] =
    (params.mention_image_urls as string[] | undefined) ??
    (params.image_url ? [String(params.image_url)] : []);

  const useEdits = refUrls.length > 0;
  let response: Response;

  if (useEdits) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("quality", quality);
    form.append("size", size);
    form.append("n", "1");

    // OpenAI's /v1/images/edits multipart convention:
    //   - 1 image  → field name `image`     (singular)
    //   - 2+ images → field name `image[]`  (array syntax)
    //
    // Repeated `image` parts (without []) trips the new API guard:
    //   "Duplicate parameter: 'image'. You provided multiple values
    //    for this parameter, whereas only one is allowed."
    // The recommended fix in their error is the `image[]` form, which
    // we apply once we know how many refs we're shipping.
    const fieldName = refUrls.length > 1 ? "image[]" : "image";
    let loaded = 0;
    for (let i = 0; i < refUrls.length; i++) {
      try {
        // Route Supabase Storage JPEGs through /render/image — imgproxy
        // bakes EXIF orientation into pixels and strips metadata, which
        // OpenAI's decoder requires (iPhone JPEGs with orientation=6
        // fail validation otherwise). Non-Supabase URLs pass through.
        const fetchUrl = toSupabaseRenderUrlForOpenAI(refUrls[i]);
        const rawBytes = await fetchImageBuffer(fetchUrl);
        if (rawBytes.byteLength > OPENAI_IMAGE_MAX_BYTES) {
          throw openAIReferenceImageError(i, "file is larger than 50MB. Please upload a smaller PNG, JPG, or WEBP image.");
        }
        const detected = detectOpenAIImageFile(rawBytes);
        if (!detected) {
          throw openAIReferenceImageError(
            i,
            "file is not a supported PNG, JPG, or WEBP image. It may be a video, GIF, AVIF/HEIC, SVG, expired HTML response, or a corrupt image.",
          );
        }
        // Defense-in-depth for refs the render route didn't touch
        // (non-Supabase URLs, or PNG/WEBP that still carry oddities).
        // Detects + re-encodes JPEGs with EXIF orientation, progressive
        // encoding, CMYK, or oversize dimensions.
        const prepared = await prepareReferenceImage(rawBytes, detected, i);
        const blob = new Blob([prepared.bytes], { type: prepared.mime });
        form.append(fieldName, blob, `ref_${i}.${prepared.ext}`);
        loaded++;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Reference image ")) {
          throw err;
        }
        throw openAIReferenceImageError(
          i,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (loaded === 0) {
      throw new Error("All reference images failed to load");
    }
    console.log(`[openai-image-2] edit request refs=${loaded} mode=${isEnhanceMode ? "enhance" : "edit"}`);

    response = await fetchWithAttemptTimeout(
      "https://api.openai.com/v1/images/edits",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      },
      OPENAI_IMAGE_2_ATTEMPT_TIMEOUT_MS,
      "OpenAI Image 2 edit",
    );
  } else {
    response = await fetchWithAttemptTimeout(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          size,
          quality,
          output_format: outputFormat,
          ...(outputFormat === "jpeg" || outputFormat === "webp"
            ? { output_compression: outputCompression }
            : {}),
          background,
          moderation,
        }),
      },
      OPENAI_IMAGE_2_ATTEMPT_TIMEOUT_MS,
      "OpenAI Image 2 generation",
    );
  }

  if (!response.ok) {
    const status = response.status;
    const errorText = await response.text();
    let errorMsg = summarizeProviderErrorText(errorText) || errorText.substring(0, 500);
    try {
      const errJson = JSON.parse(errorText);
      errorMsg = (errJson as { error?: { message?: string } })?.error?.message ?? errorMsg;
    } catch { /* keep summarized text */ }

    console.error(`[openai-image-2] HTTP ${status}: ${errorMsg.substring(0, 200)}`);

    if (isProviderBillingLike(status, errorText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    if (status === 401 || status === 403) {
      throw new Error(`OpenAI ${status}: ${errorMsg}`);
    }
    if (status >= 500) {
      throw new Error(`OpenAI ${status}: temporary upstream error${errorMsg ? ` - ${errorMsg}` : ""}`);
    }
    throw new Error(`GPT Image 2 failed (HTTP ${status}): ${errorMsg}`);
  }

  const result = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = result.data?.[0];
  const b64 = item?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data");
  }

  const ext = outputFormat === "jpeg" ? "jpg" : outputFormat;
  const mime = `image/${outputFormat === "jpg" ? "jpeg" : outputFormat}`;
  const fileName = `pipeline/mediaforge_${Date.now()}.${ext}`;
  const binaryData = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  let publicUrl = `data:${mime};base64,${b64}`;

  const { error: uploadError } = await supabase.storage
    .from("ai-media")
    .upload(fileName, binaryData, { contentType: mime, upsert: true });

  if (uploadError) {
    console.error("[openai-image-2] Upload error:", uploadError);
  } else {
    const { data: urlData, error: signError } = await supabase.storage
      .from("ai-media")
      .createSignedUrl(fileName, 60 * 60 * 24 * 7);
    if (!signError && urlData?.signedUrl) {
      publicUrl = urlData.signedUrl;
    } else {
      const { data: pubData } = supabase.storage.from("ai-media").getPublicUrl(fileName);
      publicUrl = pubData.publicUrl;
    }
  }

  return {
    result_url: publicUrl,
    outputs: { output_image: publicUrl },
    output_type: "image_url" as const,
    provider_meta: {
      model,
      requested_model: requestedModel,
      mode: isEnhanceMode ? "enhance" : (useEdits ? "edit" : "generate"),
    },
  };
}
