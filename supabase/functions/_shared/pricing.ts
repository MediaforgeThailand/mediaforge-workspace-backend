/// <reference lib="deno.ns" />
/// <reference lib="dom" />
/**
 * Shared Pricing Module — Single Source of Truth for credit cost calculation.
 * Used by: quote-flow, run-flow-init, execute-pipeline-step
 *
 * STRICT MODE: No hardcoded fallbacks. If a price row is missing from
 * `credit_costs`, the function throws `PricingConfigError` which callers
 * must surface as a user-facing 400 error.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ─── Custom error so callers can distinguish pricing gaps from bugs ─── */

export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingConfigError";
  }
}

export type ProviderKey =
  | "kling"
  | "seedance"
  | "banana"
  | "openai"
  | "seedream"
  | "chat_ai"
  | "remove_bg"
  | "merge_audio"
  | "mp3_input"
  | "tripo3d"
  | "hyper3d"
  | "google_tts"
  | "gemini_tts"
  | "video_understanding";
export type OutputType = "video_url" | "image_url" | "text" | "audio_url" | "model_3d";

export interface ProviderDef {
  provider: ProviderKey;
  feature: string;
  output_type: OutputType;
  is_async: boolean;
}

export const NODE_TYPE_REGISTRY: Record<string, ProviderDef> = {
  klingVideoNode:        { provider: "kling",     feature: "generate_freepik_video", output_type: "video_url", is_async: true },
  videoGenNode:          { provider: "kling",     feature: "generate_freepik_video", output_type: "video_url", is_async: true },
  bananaProNode:         { provider: "banana",    feature: "generate_freepik_image", output_type: "image_url", is_async: false },
  imageGenNode:          { provider: "banana",    feature: "generate_freepik_image", output_type: "image_url", is_async: false },
  chatAiNode:            { provider: "chat_ai",   feature: "chat_ai",                output_type: "text",      is_async: false },
  removeBackgroundNode:  { provider: "remove_bg", feature: "remove_background",      output_type: "image_url", is_async: false },
  mergeAudioNode:        { provider: "merge_audio", feature: "merge_audio_video",    output_type: "video_url", is_async: true },
  mp3InputNode:          { provider: "mp3_input", feature: "mp3_input",              output_type: "audio_url", is_async: false },
  audioGenNode:          { provider: "google_tts", feature: "text_to_speech",         output_type: "audio_url", is_async: false },
  imageTo3dNode:         { provider: "tripo3d",    feature: "model_3d",               output_type: "model_3d", is_async: true },
  videoToPromptNode:     { provider: "video_understanding", feature: "video_to_prompt", output_type: "text", is_async: false },
};

/* ─── Default model slugs when params don't specify one ─── */
const DEFAULT_IMAGE_MODEL = "nano-banana-pro";
const DEFAULT_CHAT_MODEL = "google/gemini-3.1-pro-preview";
const DEFAULT_VIDEO_MODEL = "kling-v2-6-pro";
const DEFAULT_INFRASTRUCTURE_BUFFER_PERCENT = 40;
const DEFAULT_WORKSPACE_MULTIPLIER = 1 + DEFAULT_INFRASTRUCTURE_BUFFER_PERCENT / 100;

function normaliseResolutionTier(size: string): "1k" | "2k" | "3k" | "4k" | "auto" {
  const s = size.toLowerCase().trim();
  if (!s || s === "auto") return "auto";
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) {
    if (s.includes("4k")) return "4k";
    if (s.includes("3k")) return "3k";
    if (s.includes("2k")) return "2k";
    return "1k";
  }
  const maxEdge = Math.max(Number(m[1]), Number(m[2]));
  if (maxEdge >= 3600) return "4k";
  if (maxEdge >= 2800) return "3k";
  if (maxEdge >= 1900) return "2k";
  return "1k";
}

function openAiImagePriceKeys(params: Record<string, unknown>): string[] {
  const baseModel = String(params.model_name ?? params.model ?? "gpt-image-2").toLowerCase();
  const rawQuality = String(params.quality ?? "medium").toLowerCase();
  const quality = ["low", "medium", "high"].includes(rawQuality) ? rawQuality : "medium";
  const rawSize = String(params.size ?? "1024x1024").toLowerCase();
  const size = rawSize === "auto" ? "1024x1024" : rawSize;
  const tier = normaliseResolutionTier(size);

  return Array.from(new Set([
    `${baseModel}:${size}:${quality}`,
    `${baseModel}:${tier}:${quality}`,
    `${baseModel}-${quality}`,
    baseModel,
  ]));
}

async function firstCostByModelKeys(
  supabase: ReturnType<typeof createClient>,
  feature: string,
  keys: string[],
): Promise<{ cost: number; pricing_type?: string | null } | null> {
  const { data, error } = await supabase
    .from("credit_costs")
    .select("cost, pricing_type, model")
    .eq("feature", feature)
    .in("model", keys);
  if (error) throw new PricingConfigError(`Pricing read failed for ${feature}: ${error.message}`);
  const rows = (data ?? []) as Array<{ cost: number; pricing_type?: string | null; model?: string | null }>;
  for (const key of keys) {
    const match = rows.find((row) => row.model === key);
    if (match) return match;
  }
  return null;
}

/* ─── Base cost lookup from credit_costs table — STRICT, no fallbacks ─── */

export async function lookupBaseCost(
  supabase: ReturnType<typeof createClient>,
  providerDef: ProviderDef,
  params: Record<string, unknown>,
): Promise<number> {

  /* ── Image (Banana / Freepik) ── */
  if (providerDef.provider === "banana") {
    const model = String(params.model_name ?? params.model ?? DEFAULT_IMAGE_MODEL);
    const imageSize = String(params.image_size ?? params.resolution ?? "").toLowerCase();
    const keys = imageSize ? [`${model}:${imageSize}`, model] : [model];
    const match = await firstCostByModelKeys(supabase, "generate_freepik_image", keys);

    if (!match) {
      throw new PricingConfigError(
        `Pricing configuration missing for image model: ${model}`
      );
    }
    return match.cost;
  }

  /* ── Image (OpenAI gpt-image-2 / DALL-E) ── */
  if (providerDef.provider === "openai") {
    const keys = openAiImagePriceKeys(params);
    const match = await firstCostByModelKeys(supabase, "generate_openai_image", keys);

    if (!match) {
      throw new PricingConfigError(
        `Pricing configuration missing for OpenAI image model: ${keys[0]}`
      );
    }
    return match.cost;
  }

  /* ── Image (SeedDream / future port) ── */
  if (providerDef.provider === "seedream") {
    const model = String(params.model_name ?? params.model ?? "seedream-5-0-260128");
    const size = String(params.size ?? params.resolution ?? "2K").toLowerCase();
    const keys = [`${model}:${size}`, model];
    const match = await firstCostByModelKeys(supabase, "generate_seedream_image", keys);

    if (!match) {
      throw new PricingConfigError(
        `Pricing configuration missing for SeedDream image model: ${model}`
      );
    }
    return match.cost;
  }

  /* ── Image to 3D (Tripo3D / Hyper3D) ── */
  if (providerDef.provider === "tripo3d" || providerDef.provider === "hyper3d") {
    const model = String(params.model_name ?? params.model ?? "tripo3d-v3.1");
    const { data } = await supabase
      .from("credit_costs").select("cost")
      .eq("feature", "model_3d")
      .eq("model", model)
      .limit(1).maybeSingle();

    if (!data) {
      throw new PricingConfigError(
        `Pricing configuration missing for 3D model: ${model}`
      );
    }
    return data.cost;
  }

  /* ── Text to speech ── */
  if (providerDef.provider === "google_tts" || providerDef.provider === "gemini_tts") {
    const model = String(params.model_name ?? params.model ?? "google-tts-studio");
    const { data } = await supabase
      .from("credit_costs").select("cost, pricing_type")
      .eq("feature", "text_to_speech")
      .eq("model", model)
      .limit(1).maybeSingle();

    if (!data) {
      throw new PricingConfigError(
        `Pricing configuration missing for text-to-speech model: ${model}`
      );
    }
    if (data.pricing_type === "per_1k_chars") {
      const text = String(params.prompt ?? params.text ?? params.script ?? "");
      return Math.max(1, Math.ceil(data.cost * Math.max(text.length, 1) / 1000));
    }
    return data.cost;
  }

  /* ── Video to Prompt / video understanding ── */
  if (providerDef.provider === "video_understanding") {
    const model = String(params.model_name ?? params.model ?? "gemini-video-understanding");
    const { data } = await supabase
      .from("credit_costs").select("cost")
      .eq("feature", "video_to_prompt")
      .eq("model", model)
      .limit(1).maybeSingle();

    if (!data) {
      throw new PricingConfigError(
        `Pricing configuration missing for video-to-prompt model: ${model}`
      );
    }
    return data.cost;
  }

  /* ── MP3 Input (pure source — zero cost) ── */
  if (providerDef.provider === "mp3_input") {
    return 0;
  }

  /* ── Merge Audio + Video (Shotstack) ── */
  if (providerDef.provider === "merge_audio") {
    const model = String(params.model_name ?? params.model ?? "shotstack");
    const { data } = await supabase
      .from("credit_costs").select("cost")
      .eq("feature", "merge_audio_video")
      .eq("model", model)
      .limit(1).maybeSingle();

    if (!data) {
      throw new PricingConfigError(
        `Pricing configuration missing for merge_audio_video model: ${model}`
      );
    }
    return data.cost;
  }

  /* ── Background Removal (Replicate) ── */
  if (providerDef.provider === "remove_bg") {
    const model = String(params.model_name ?? params.model ?? "replicate-birefnet");
    const { data } = await supabase
      .from("credit_costs").select("cost")
      .eq("feature", "remove_background")
      .eq("model", model)
      .limit(1).maybeSingle();

    if (!data) {
      throw new PricingConfigError(
        `Pricing configuration missing for remove_background model: ${model}`
      );
    }
    return data.cost;
  }

  /* ── Chat AI ── */
  if (providerDef.provider === "chat_ai") {
    const model = String(params.model_name ?? params.model ?? DEFAULT_CHAT_MODEL);
    const { data } = await supabase
      .from("credit_costs").select("cost")
      .eq("feature", "chat_ai")
      .eq("model", model)
      .limit(1).maybeSingle();

    if (!data) {
      throw new PricingConfigError(
        `Pricing configuration missing for chat model: ${model}`
      );
    }
    return data.cost;
  }

  /* ── Video (Kling — unified: I2V, Extension, Motion Control, Omni) ── */
  const model = String(params.model_name ?? params.model ?? DEFAULT_VIDEO_MODEL);
  const isMotion = model.includes("motion");
  const isOmni = model === "kling-v3-omni";

  // For motion models, duration comes from ref_video (passed as ref_video_duration).
  // For Omni models, duration comes from the slider (3-15s).
  // For standard models, use the explicit duration param.
  const duration = isMotion
    ? (parseInt(String(params.ref_video_duration ?? "0"), 10) || 0)
    : (parseInt(String(params.duration ?? "5"), 10) || 5);

  const hasAudio = params.has_audio === true || params.has_audio === "true";

  // ── Omni: check for video-ref tier pricing ──
  if (isOmni) {
    const hasRefVideo = params._has_ref_video === true || params._has_ref_video === "true";
    const pricingModel = hasRefVideo ? `${model}-video-ref` : model;

    // Try the tier-specific model first
    const { data: tierRow } = await supabase
      .from("credit_costs").select("cost, pricing_type")
      .eq("feature", "generate_freepik_video")
      .eq("model", pricingModel)
      .limit(1).maybeSingle();

    if (tierRow) {
      if (tierRow.pricing_type === "per_second") {
        return Math.ceil(tierRow.cost * duration);
      }
      return tierRow.cost;
    }

    // Fallback to standard model if video-ref row doesn't exist
    if (hasRefVideo) {
      const { data: stdRow } = await supabase
        .from("credit_costs").select("cost, pricing_type")
        .eq("feature", "generate_freepik_video")
        .eq("model", model)
        .limit(1).maybeSingle();

      if (stdRow) {
        if (stdRow.pricing_type === "per_second") {
          return Math.ceil(stdRow.cost * duration);
        }
        return stdRow.cost;
      }
    }

    throw new PricingConfigError(
      `Pricing configuration missing for Omni model: ${pricingModel} (duration=${duration}s)`
    );
  }

  const { data: perSecondExact } = await supabase
    .from("credit_costs").select("cost, pricing_type")
    .eq("feature", "generate_freepik_video")
    .eq("model", model)
    .eq("pricing_type", "per_second")
    .eq("has_audio", hasAudio)
    .limit(1).maybeSingle();

  if (perSecondExact) {
    const effectiveDuration = isMotion && duration <= 0 ? 5 : duration;
    return Math.ceil(perSecondExact.cost * effectiveDuration);
  }

  const { data: exactMatchLate } = await supabase
    .from("credit_costs").select("cost")
    .eq("feature", "generate_freepik_video")
    .eq("model", model)
    .eq("pricing_type", "fixed")
    .eq("duration_seconds", duration)
    .eq("has_audio", hasAudio)
    .limit(1).maybeSingle();

  if (exactMatchLate) return exactMatchLate.cost;

  const { data: durationMatchLate } = await supabase
    .from("credit_costs").select("cost")
    .eq("feature", "generate_freepik_video")
    .eq("model", model)
    .eq("pricing_type", "fixed")
    .eq("duration_seconds", duration)
    .limit(1).maybeSingle();

  if (durationMatchLate) return durationMatchLate.cost;

  const { data } = await supabase
    .from("credit_costs").select("cost, pricing_type")
    .eq("feature", "generate_freepik_video")
    .eq("model", model)
    .limit(1).maybeSingle();

  if (!data) {
    throw new PricingConfigError(
      `Pricing configuration missing for video model: ${model} (duration=${duration}s, audio=${hasAudio})`
    );
  }

  /* ── CRITICAL: per_second billing multiplier ── */
  if (data.pricing_type === "per_second") {
    // For motion models without an uploaded ref_video yet (quote-time),
    // fall back to a default 5s estimate. Execution-time pricing will
    // recalculate using the actual ref_video_duration.
    const effectiveDuration = isMotion && duration <= 0 ? 5 : duration;
    return Math.ceil(data.cost * effectiveDuration);
  }

  /* ── Fixed pricing: try exact duration+audio match first ── */
  const { data: exactMatch } = await supabase
    .from("credit_costs").select("cost")
    .eq("feature", "generate_freepik_video")
    .eq("model", model)
    .eq("duration_seconds", duration)
    .eq("has_audio", hasAudio)
    .limit(1).maybeSingle();

  if (exactMatch) return exactMatch.cost;

  /* ── Fallback to duration-only match (no audio filter) ── */
  const { data: durationMatch } = await supabase
    .from("credit_costs").select("cost")
    .eq("feature", "generate_freepik_video")
    .eq("model", model)
    .eq("duration_seconds", duration)
    .limit(1).maybeSingle();

  if (durationMatch) return durationMatch.cost;

  /* ── Last resort: use the base row cost (already fetched above) ── */
  return data.cost;
}

/* ─── Pricing calculation ─── */

export interface PricingResult {
  deduction: number;
  transaction_type: string;
  rev_share_amount: number;
  base_cost: number;
  discount_applied: number;
  discount_percent: number;
  markup_multiplier: number;
  raw_price: number;
}

export function calculatePricing(
  baseCost: number,
  markupMultiplier: number,
  isOwner: boolean,
  discountPercent: number = 0,
): PricingResult {
  const rawPrice = Math.ceil(baseCost * markupMultiplier);
  if (isOwner) {
    return {
      deduction: rawPrice, transaction_type: "test_run", rev_share_amount: 0,
      base_cost: baseCost, discount_applied: 0, discount_percent: 0,
      markup_multiplier: markupMultiplier, raw_price: rawPrice,
    };
  }
  const discountAmount = discountPercent > 0 ? Math.floor(rawPrice * (discountPercent / 100)) : 0;
  const finalPrice = Math.max(rawPrice - discountAmount, 1);
  const revShare = Math.floor((finalPrice - baseCost) * 0.20);
  return {
    deduction: finalPrice, transaction_type: "consumer_run",
    rev_share_amount: Math.max(revShare, 0), base_cost: baseCost,
    discount_applied: discountAmount, discount_percent: discountPercent,
    markup_multiplier: markupMultiplier, raw_price: rawPrice,
  };
}

/* ─── Calculate total cost for a full flow graph ─── */

export interface FlowQuoteResult {
  total_base_cost: number;
  price: number;
  discount: number;
  discount_percent: number;
  markup_multiplier: number;
  is_owner: boolean;
  per_node_costs: Array<{ node_id: string; node_type: string; cost: number; markup: number }>;
  pricing: PricingResult;
}

/** Feature-level multipliers from platform settings */
export interface FeatureMultipliers {
  image: number;
  video: number;
  chat: number;
  audio?: number;
}

function getMultiplierForNode(nodeType: string, featureMultipliers?: FeatureMultipliers): number {
  if (!featureMultipliers) return DEFAULT_WORKSPACE_MULTIPLIER;
  const def = NODE_TYPE_REGISTRY[nodeType];
  if (!def) return DEFAULT_WORKSPACE_MULTIPLIER;
  switch (def.provider) {
    case "banana": return featureMultipliers.image;
    case "openai": return featureMultipliers.image;
    case "seedream": return featureMultipliers.image;
    case "kling": return featureMultipliers.video;
    case "seedance": return featureMultipliers.video;
    case "chat_ai": return featureMultipliers.chat;
    case "remove_bg": return featureMultipliers.image;
    case "merge_audio": return featureMultipliers.video;
    case "tripo3d": return featureMultipliers.image;
    case "hyper3d": return featureMultipliers.image;
    case "google_tts": return featureMultipliers.audio ?? 1.0;
    case "gemini_tts": return featureMultipliers.audio ?? 1.0;
    case "video_understanding": return featureMultipliers.chat;
    case "mp3_input": return featureMultipliers.audio ?? DEFAULT_WORKSPACE_MULTIPLIER;
    default: return DEFAULT_WORKSPACE_MULTIPLIER;
  }
}

/** Fetch the Workspace infrastructure buffer as a feature multiplier. */
export async function fetchFeatureMultipliers(
  supabase: ReturnType<typeof createClient>,
): Promise<FeatureMultipliers> {
  const { data } = await supabase
    .from("subscription_settings")
    .select("key, value")
    .in("key", ["workspace_infrastructure_buffer_percent"]);

  const rawBuffer = (data || []).find((r: { key: string; value: string }) =>
    r.key === "workspace_infrastructure_buffer_percent"
  )?.value;
  const parsedBuffer = Number(rawBuffer);
  const bufferPercent = Number.isFinite(parsedBuffer) && parsedBuffer >= 0
    ? parsedBuffer
    : DEFAULT_INFRASTRUCTURE_BUFFER_PERCENT;
  const multiplier = 1 + bufferPercent / 100;
  return {
    image: multiplier,
    video: multiplier,
    chat: multiplier,
    audio: multiplier,
  };
}

export async function quoteFlowCost(
  supabase: ReturnType<typeof createClient>,
  opts: {
    graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
    allNodeParams?: Record<string, Record<string, unknown>>;
    markupMultiplier: number;
    isOwner: boolean;
    discountPercent: number;
    featureMultipliers?: FeatureMultipliers;
  },
): Promise<FlowQuoteResult> {
  const { graphNodes, allNodeParams, markupMultiplier, isOwner, discountPercent, featureMultipliers } = opts;

  const actionNodes = graphNodes.filter((n) => NODE_TYPE_REGISTRY[n.type]);

  let totalBaseCost = 0;
  let totalWeightedPrice = 0;
  const perNodeCosts: Array<{ node_id: string; node_type: string; cost: number; markup: number }> = [];

  for (const node of actionNodes) {
    const providerDef = NODE_TYPE_REGISTRY[node.type];
    if (!providerDef) continue;
    const nodeParams = allNodeParams?.[node.id] ?? (node.data?.params as Record<string, unknown> ?? {});
    const nodeCost = await lookupBaseCost(supabase, providerDef, nodeParams);
    const nodeMultiplier = featureMultipliers
      ? getMultiplierForNode(node.type, featureMultipliers)
      : markupMultiplier;
    totalBaseCost += nodeCost;
    totalWeightedPrice += Math.ceil(nodeCost * nodeMultiplier);
    perNodeCosts.push({ node_id: node.id, node_type: node.type, cost: nodeCost, markup: nodeMultiplier });
  }

  // Use weighted price instead of flat multiplier
  const effectiveMultiplier = totalBaseCost > 0 ? totalWeightedPrice / totalBaseCost : markupMultiplier;
  const pricing = calculatePricing(totalBaseCost, effectiveMultiplier, isOwner, discountPercent);

  return {
    total_base_cost: totalBaseCost,
    price: pricing.deduction,
    discount: pricing.discount_applied,
    discount_percent: discountPercent,
    markup_multiplier: effectiveMultiplier,
    is_owner: isOwner,
    per_node_costs: perNodeCosts,
    pricing,
  };
}

/* ─── Atomic refund helper using the refund_credits RPC ─── */

export async function refundCreditsAtomic(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  amount: number,
  reason: string,
  referenceId?: string,
): Promise<void> {
  if (amount <= 0) return;
  const { error } = await supabase.rpc("refund_credits", {
    p_user_id: userId,
    p_amount: amount,
    p_reason: reason,
    p_reference_id: referenceId || null,
  });
  if (error) {
    console.error(`[pricing] refund_credits RPC error:`, error);
    throw new Error(`Refund failed: ${error.message}`);
  }
  console.log(`[pricing] Atomic refund: ${amount} credits to ${userId}: ${reason}`);
}
