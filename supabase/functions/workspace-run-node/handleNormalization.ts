/* ═══════════════════════════════════════════════════════════
   HANDLE NORMALIZATION SCHEMA
   Maps UI targetHandle names → standardized internal param keys
   per provider. This is the SINGLE SOURCE OF TRUTH for edge mapping.
   Adding a new provider? Just add a new entry here.
   ═══════════════════════════════════════════════════════════ */

export type DataType = "image" | "video" | "audio" | "text";

export interface HandleDef {
  internal_key: string;   // The standardized key the executor reads
  data_type: DataType;    // Expected data type for validation
}

export const HANDLE_SCHEMA: Record<string, Record<string, HandleDef>> = {
  kling: {
    start_frame:   { internal_key: "image_url",       data_type: "image" },
    ref_image:     { internal_key: "ref_image_url",   data_type: "image" },
    image_input:   { internal_key: "image_url",       data_type: "image" },
    image:         { internal_key: "image_url",       data_type: "image" },
    end_frame:     { internal_key: "image_tail_url",  data_type: "image" },
    ref_video:     { internal_key: "video_url",       data_type: "video" },
    // Kling Omni v3 only — accepts objects, not URL strings. Marked
    // "text" so validateEdgeValue skips the URL regex check; the V2
    // handler then passes the object/array through verbatim.
    elements:      { internal_key: "elements",        data_type: "text" },
  },
  kling_extension: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    ref_video:     { internal_key: "video_url",      data_type: "video" },
  },
  motion_control: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
  },
  banana: {
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    context_text:  { internal_key: "context_text",   data_type: "text" },
  },
  // Mirror banana: gpt-image-2 reads the same param keys (image_url +
  // mention_image_urls), built up by the V2 entry handler from
  // edgeImageUrls. Without this entry normalizeHandle returns null
  // and ref values get parked under the raw `ref_image` key, where
  // executeOpenAIImage2 never finds them — same bug fixed in the
  // main project's execute-pipeline-step HANDLE_SCHEMA.
  openai: {
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
  },
  seedream: {
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
  },
  chat_ai: {
    context_text:  { internal_key: "context_text",   data_type: "text" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
  },
  remove_bg: {
    image:         { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
  },
  upscale_image: {
    image:         { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
  },
  merge_audio: {
    video:         { internal_key: "video_url",      data_type: "video" },
    audio:         { internal_key: "audio_url",      data_type: "text" }, // 'text' = pass-through URL string
  },
  video_understanding: {
    video:         { internal_key: "video_url",      data_type: "video" },
    ref_video:     { internal_key: "video_url",      data_type: "video" },
  },
  seedance: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    end_frame:     { internal_key: "image_tail_url", data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
    reference_image: { internal_key: "reference_image_urls", data_type: "image" },
    ref_video:     { internal_key: "reference_video_urls", data_type: "video" },
    ref_audio:     { internal_key: "reference_audio_urls", data_type: "audio" },
  },
  replicate_video: {
    start_frame:   { internal_key: "image_url",      data_type: "image" },
    end_frame:     { internal_key: "image_tail_url", data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    image:         { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "reference_image_urls", data_type: "image" },
    reference_image: { internal_key: "reference_image_urls", data_type: "image" },
    ref_video:     { internal_key: "reference_video_urls", data_type: "video" },
    ref_audio:     { internal_key: "reference_audio_urls", data_type: "audio" },
  },
  tripo3d: {
    image:         { internal_key: "image_url",      data_type: "image" },
    image_input:   { internal_key: "image_url",      data_type: "image" },
    ref_image:     { internal_key: "image_url",      data_type: "image" },
  },
};

/** Resolve a targetHandle to the correct internal param key for a given provider */
export function normalizeHandle(provider: string, targetHandle: string): HandleDef | null {
  const providerSchema = HANDLE_SCHEMA[provider];
  if (!providerSchema) return null;
  return providerSchema[targetHandle] ?? null;
}

export function normalizeHandleForModel(
  provider: string,
  targetHandle: string,
  modelName?: string,
): HandleDef | null {
  const model = String(modelName ?? "").toLowerCase();
  if (provider === "kling" && targetHandle === "ref_image" && model === "kling-v3-omni") {
    return { internal_key: "ref_image_urls", data_type: "image" };
  }
  if (provider === "kling" && targetHandle === "ref_image" && model.includes("motion")) {
    return HANDLE_SCHEMA.motion_control.ref_image;
  }
  if (
    provider === "seedance" &&
    targetHandle === "ref_image" &&
    (model.startsWith("seedance-2-0") || model.startsWith("dreamina-seedance-2-0"))
  ) {
    return HANDLE_SCHEMA.seedance.reference_image;
  }
  return normalizeHandle(provider, targetHandle);
}

/* ─── URL validation helper ─── */
const VALID_URL_REGEX = /^(https?:\/\/|data:)/i;

export function isValidMediaUrl(value: string): boolean {
  return VALID_URL_REGEX.test(value);
}

export function validateEdgeValue(value: string, expectedType: DataType, targetHandle: string): void {
  if (expectedType === "text") return; // text can be anything
  // For image/video, must be a URL or data URI
  if (!isValidMediaUrl(value)) {
    throw new Error(
      `Invalid input: Expected a ${expectedType} URL for handle "${targetHandle}", but received non-URL data. ` +
      `Value starts with: "${value.substring(0, 50)}..."`
    );
  }
}

export function appendUniqueStringParam(
  params: Record<string, unknown>,
  key: string,
  values: string[],
  max: number,
): void {
  const existing = Array.isArray(params[key])
    ? (params[key] as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
    : typeof params[key] === "string"
      ? [params[key] as string]
      : [];
  params[key] = Array.from(new Set([...existing, ...values])).slice(0, max);
}
