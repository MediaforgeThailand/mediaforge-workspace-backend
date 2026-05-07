// admin_workspace_pricing — workspace-side credit-system admin reads + writes.
//
// Purpose
// -------
// The admin-hub has two pricing pages (Subscription Builder, Pricing Manager)
// that historically only spoke to the consumer project's bridge. When the
// operator flips the top-bar target pill to "Workspace" we want those pages
// to actually read and edit the workspace project's pricing tables.
//
// This function is the workspace-side equivalent of the consumer bridge.
// It exposes a tiny POST-action surface so the admin frontend has a single
// endpoint per project to talk to (matches the existing
// `admin_dashboard_stats` style — same auth model, same CORS, same shape).
//
// Auth
// ----
// `verify_jwt: false` (declared in supabase config when deployed). Same
// reason as `admin_dashboard_stats`: the admin user's JWT is signed by the
// admin DB project (`jonueleuisfarcepwkuo`) and would not verify here.
// Federating admin auth across projects is out of scope for this wave.
// The function returns aggregate / config rows only — no user PII, no
// message bodies — so the blast radius is the pricing surface, which the
// admin already has read access to in the consumer project too.
//
// Mutations
// ---------
// Mutations (`upsert_credit_cost`, `delete_credit_cost`,
// `set_markup_multipliers`, `recalculate_all_prices`) are now wired to
// real implementations using the service-role client. Each mutation
// returns a `{ data: ... }` envelope identical to the consumer bridge so
// the admin-hub doesn't have to branch.
//
// Storage shape note
// ------------------
// Markup multipliers live in `subscription_settings` under
// `markup_multiplier_<feature>` keys (image / video / chat / audio).
// The earlier read code stripped a `markup_` prefix (which would also
// match an unrelated `markup_xxx` key). We now strip the full
// `markup_multiplier_` prefix to match the actual storage convention.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAdminJwt, unauthorizedResponse } from "../_shared/adminAuth.ts";
import { acceptPendingOrgInviteForUser } from "../_shared/orgInvite.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-email, x-admin-auth-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Multiplier keys we accept on the wire. Centralised so the read + write
// paths stay in lock-step: if a new feature gets a multiplier later we
// only have to add it here.
const MULTIPLIER_KEYS = ["image", "video", "chat", "audio"] as const;
type MultiplierKey = (typeof MULTIPLIER_KEYS)[number];
const MULTIPLIER_PREFIX = "markup_multiplier_";
const BUFFER_SETTING_KEY = "workspace_infrastructure_buffer_percent";
const DEFAULT_BUFFER_PERCENT = 40;
const USD_TO_THB = 35;
const FLOW_CREDITS_PER_THB = 125;
const WORKSPACE_CREDITS_PER_THB = 50;
const FLOW_TO_WORKSPACE_RATIO = WORKSPACE_CREDITS_PER_THB / FLOW_CREDITS_PER_THB;
const REPLICATE_PRICE_FACTOR = 1;
type CreditCostWriteRow = {
  feature: string;
  model: string | null;
  label: string;
  cost: number;
  pricing_type: string | null;
  duration_seconds?: number | null;
  has_audio?: boolean | null;
  provider?: string | null;
  price_key?: string | null;
  resolution?: string | null;
  quality?: string | null;
  source?: string | null;
  source_url?: string | null;
  source_ratio?: number | null;
  provider_unit?: string | null;
  notes?: string | null;
  discount_percent?: number | null;
};

function creditsFromUsd(usd: number): number {
  return Math.max(1, Math.ceil((usd * USD_TO_THB * WORKSPACE_CREDITS_PER_THB) - 1e-9));
}

function creditsFromReplicateUsd(usd: number): number {
  return creditsFromUsd(usd * REPLICATE_PRICE_FACTOR);
}

function creditsFromThb(thb: number): number {
  return Math.max(1, Math.ceil(thb * WORKSPACE_CREDITS_PER_THB));
}

function gptImage2OutputTokens(width: number, height: number, quality: "low" | "medium" | "high"): number {
  const qualityBase = { low: 16, medium: 48, high: 96 }[quality];
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const shortQualityBase = Math.round((qualityBase * shortEdge) / longEdge);
  const widthBase = width >= height ? qualityBase : shortQualityBase;
  const heightBase = width >= height ? shortQualityBase : qualityBase;
  return Math.ceil(widthBase * heightBase * (2_000_000 + width * height) / 4_000_000);
}

function gptImage2Credits(width: number, height: number, quality: "low" | "medium" | "high"): number {
  return creditsFromUsd((gptImage2OutputTokens(width, height, quality) * 30) / 1_000_000);
}

type GptImage2Quality = "low" | "medium" | "high" | "auto";

const QUALITY_LABEL: Record<GptImage2Quality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  auto: "Auto",
};

const GPT_IMAGE_2_REPLICATE_USD: Record<GptImage2Quality, number> = {
  low: 0.012,
  medium: 0.047,
  high: 0.128,
  auto: 0.128,
};

const GPT_IMAGE_2_ROWS: CreditCostWriteRow[] = ([
  ["1k", 1024, 1024],
  ["2k", 2048, 2048],
  ["4k", 3840, 2160],
] as const).flatMap(([tier, width, height]) =>
  (["low", "medium", "high", "auto"] as const).map((quality) => ({
    feature: "generate_openai_image",
    model: `gpt-image-2:${tier}:${quality}`,
    label: `GPT Image 2 ${tier.toUpperCase()} ${QUALITY_LABEL[quality]}`,
    cost: creditsFromReplicateUsd(GPT_IMAGE_2_REPLICATE_USD[quality]),
    pricing_type: "per_operation",
    provider: "openai",
    price_key: `gpt-image-2:${tier}:${quality}`,
    resolution: tier.toUpperCase(),
    quality,
    source: "replicate_docs",
    source_url: "https://replicate.com/openai/gpt-image-2",
    source_ratio: REPLICATE_PRICE_FACTOR,
    provider_unit: "per image",
    notes: `Replicate openai/gpt-image-2 ${quality} is $${GPT_IMAGE_2_REPLICATE_USD[quality]}/image, converted at ${USD_TO_THB} THB/USD and ${WORKSPACE_CREDITS_PER_THB} credits/THB. Resolution tier ${width}x${height} is retained for runtime matching; Replicate bills this model by quality, not resolution.`,
  }))
);

const NANO_BANANA_ROWS: CreditCostWriteRow[] = [
  { model: "nano-banana-2", mappedModel: "gemini-3.1-flash-image-preview", label: "Nano Banana 2", prices: { "1k": 0.067, "2k": 0.101, "4k": 0.151 } },
  { model: "nano-banana-pro", mappedModel: "gemini-3-pro-image-preview", label: "Nano Banana Pro", prices: { "1k": 0.134, "2k": 0.134, "4k": 0.24 } },
].flatMap((def) =>
  Object.entries(def.prices).map(([tier, usd]) => ({
    feature: "generate_freepik_image",
    model: `${def.model}:${tier}`,
    label: `${def.label} ${tier.toUpperCase()}`,
    cost: creditsFromUsd(usd),
    pricing_type: "per_operation",
    provider: "google",
    price_key: `${def.mappedModel}:${tier}`,
    resolution: tier.toUpperCase(),
    quality: null,
    source: "official_docs",
    source_url: "https://ai.google.dev/gemini-api/docs/pricing",
    provider_unit: "per image",
    notes: `Workspace ${def.model} maps to Google ${def.mappedModel}; ${usd} USD/image -> ${USD_TO_THB} THB/USD -> ${WORKSPACE_CREDITS_PER_THB} credits/THB.`,
  }))
);

const NANO_BANANA_FALLBACK_ROWS: CreditCostWriteRow[] = [
  { model: "nano-banana-2", label: "Nano Banana 2 fallback", cost: creditsFromUsd(0.067), priceKey: "gemini-3.1-flash-image-preview:1k" },
  { model: "nano-banana-pro", label: "Nano Banana Pro fallback", cost: creditsFromUsd(0.134), priceKey: "gemini-3-pro-image-preview:1k" },
].map((row) => ({
  feature: "generate_freepik_image",
  model: row.model,
  label: row.label,
  cost: row.cost,
  pricing_type: "per_operation",
  provider: "google",
  price_key: row.priceKey,
  resolution: "1K",
  source: "official_docs",
  source_url: "https://ai.google.dev/gemini-api/docs/pricing",
  provider_unit: "per image",
  notes: "Runtime fallback row when the image node does not pass an explicit resolution.",
}));

const REPLICATE_BANANA_ROWS: CreditCostWriteRow[] = [
  { model: "replicate-nano-banana-2", label: "Nano Banana 2 (Replicate)", usd: 0.039, resolution: null, sourceUrl: "https://replicate.com/google/nano-banana" },
  { model: "replicate-nano-banana-2:1k", label: "Nano Banana 2 (Replicate) legacy 1K", usd: 0.039, resolution: "1K", sourceUrl: "https://replicate.com/google/nano-banana" },
  { model: "replicate-nano-banana-2:2k", label: "Nano Banana 2 (Replicate) legacy 2K", usd: 0.039, resolution: "2K", sourceUrl: "https://replicate.com/google/nano-banana" },
  { model: "replicate-nano-banana-pro", label: "Nano Banana Pro (Replicate) fallback", usd: 0.15, resolution: "2K", sourceUrl: "https://replicate.com/google/nano-banana-pro" },
  { model: "replicate-nano-banana-pro:1k", label: "Nano Banana Pro (Replicate) 1K", usd: 0.15, resolution: "1K", sourceUrl: "https://replicate.com/google/nano-banana-pro" },
  { model: "replicate-nano-banana-pro:2k", label: "Nano Banana Pro (Replicate) 2K", usd: 0.15, resolution: "2K", sourceUrl: "https://replicate.com/google/nano-banana-pro" },
  { model: "replicate-nano-banana-pro:4k", label: "Nano Banana Pro (Replicate) 4K", usd: 0.30, resolution: "4K", sourceUrl: "https://replicate.com/google/nano-banana-pro" },
].map((row) => ({
  feature: "generate_freepik_image",
  model: row.model,
  label: row.label,
  cost: creditsFromReplicateUsd(row.usd),
  pricing_type: "per_operation",
  provider: "replicate",
  price_key: row.model,
  resolution: row.resolution,
  source: "replicate_docs",
  source_url: row.sourceUrl,
  source_ratio: REPLICATE_PRICE_FACTOR,
  provider_unit: "per image",
  notes: `Replicate ${row.model.startsWith("replicate-nano-banana-pro") ? "google/nano-banana-pro" : "google/nano-banana"} costs $${row.usd}/image.`,
}));

const KLING_ROWS: CreditCostWriteRow[] = [
  { model: "kling-v2-6-pro", label: "Kling 2.6 Pro", cost: creditsFromThb(10), audio: false, source: "flow_erp_converted", notes: "Existing Flow ERP cost is 10 THB/second. Converted from 125 credits/THB to Workspace 50 credits/THB." },
  { model: "kling-v2-6-pro", label: "Kling 2.6 Pro + audio", cost: creditsFromThb(20), audio: true, source: "flow_erp_converted", notes: "Audio SKU uses the existing Flow convention of 2x video-only cost, converted to Workspace ratio." },
  { model: "kling-v2-6-motion-pro", label: "Kling 2.6 Motion Pro", cost: creditsFromThb(10), audio: false, source: "flow_erp_converted", notes: "Existing Flow ERP cost is 10 THB/second. Converted from 125 credits/THB to Workspace 50 credits/THB." },
  { model: "kling-v2-6-motion-pro", label: "Kling 2.6 Motion Pro + audio", cost: creditsFromThb(20), audio: true, source: "flow_erp_converted", notes: "Audio SKU uses the existing Flow convention of 2x video-only cost, converted to Workspace ratio." },
  { model: "kling-v3-pro", label: "Kling 3 Pro", cost: 185, audio: false, source: "master_pricing_sheet", notes: "Master Pricing Sheet: Kling 3 Pro 1080p no audio = 185 credits/sec." },
  { model: "kling-v3-pro", label: "Kling 3 Pro + audio", cost: 275, audio: true, source: "master_pricing_sheet", notes: "Master Pricing Sheet: Kling 3 Pro 1080p with audio = 275 credits/sec." },
  { model: "kling-v3-motion-pro", label: "Kling 3 Motion Pro", cost: 275, audio: false, source: "master_pricing_sheet", notes: "Master Pricing Sheet: Motion/pro tier recommended at 275 credits/sec." },
  { model: "kling-v3-omni", label: "Kling 3 Omni", cost: 280, audio: false, source: "master_pricing_sheet", notes: "Master Pricing Sheet: Kling 3 Omni no audio = 280 credits/sec." },
  { model: "kling-v3-omni", label: "Kling 3 Omni + audio", cost: 370, audio: true, source: "master_pricing_sheet", notes: "Master Pricing Sheet: Kling 3 Omni with audio = 370 credits/sec." },
  { model: "kling-v3-omni-video-ref", label: "Kling 3 Omni Video Reference", cost: 370, audio: false, source: "master_pricing_sheet", notes: "Master Pricing Sheet: video-reference default = 370 credits/sec. Omni disables audio when a reference video is present." },
].map((row) => ({
  feature: "generate_freepik_video",
  model: row.model,
  label: row.label,
  cost: row.cost,
  pricing_type: "per_second",
  has_audio: row.audio,
  provider: "kling",
  price_key: `${row.model}:${row.audio ? "audio" : "video"}`,
  source: row.source,
  source_url: row.source === "flow_erp_converted" ? "Flow ERP" : null,
  source_ratio: row.source === "flow_erp_converted" ? FLOW_TO_WORKSPACE_RATIO : null,
    provider_unit: "per second",
    discount_percent: 20,
    notes: row.notes,
}));

const KLING_REPLICATE_PARITY_ROWS: CreditCostWriteRow[] = [
  { model: "kling-v3-pro:720p", label: "Kling 3 Pro 720p", usd: 0.168, audio: false, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "kling-v3-pro:720p", label: "Kling 3 Pro 720p + audio", usd: 0.252, audio: true, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "kling-v3-pro:1080p", label: "Kling 3 Pro 1080p", usd: 0.224, audio: false, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "kling-v3-pro:1080p", label: "Kling 3 Pro 1080p + audio", usd: 0.336, audio: true, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "kling-v3-omni:720p", label: "Kling 3 Omni 720p", usd: 0.168, audio: false, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "kling-v3-omni:720p", label: "Kling 3 Omni 720p + audio", usd: 0.224, audio: true, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "kling-v3-omni:1080p", label: "Kling 3 Omni 1080p", usd: 0.224, audio: false, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "kling-v3-omni:1080p", label: "Kling 3 Omni 1080p + audio", usd: 0.28, audio: true, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "kling-v3-motion-pro:720p", label: "Kling 3 Motion 720p", usd: 0.07, audio: false, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-motion-control" },
  { model: "kling-v3-motion-pro:1080p", label: "Kling 3 Motion 1080p", usd: 0.12, audio: false, provider: "kling", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-motion-control" },
  { model: "replicate-kling-v3-pro:standard", label: "Kling 3 Pro Replicate 720p", usd: 0.168, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "replicate-kling-v3-pro:standard", label: "Kling 3 Pro Replicate 720p + audio", usd: 0.252, audio: true, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "replicate-kling-v3-pro:pro", label: "Kling 3 Pro Replicate 1080p", usd: 0.224, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "replicate-kling-v3-pro:pro", label: "Kling 3 Pro Replicate 1080p + audio", usd: 0.336, audio: true, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "replicate-kling-v3-pro:4k", label: "Kling 3 Pro Replicate 4K", usd: 0.42, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "replicate-kling-v3-pro:4k", label: "Kling 3 Pro Replicate 4K + audio", usd: 0.42, audio: true, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-video" },
  { model: "replicate-kling-v3-omni:standard", label: "Kling 3 Omni Replicate 720p", usd: 0.168, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "replicate-kling-v3-omni:standard", label: "Kling 3 Omni Replicate 720p + audio", usd: 0.224, audio: true, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "replicate-kling-v3-omni:pro", label: "Kling 3 Omni Replicate 1080p", usd: 0.224, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "replicate-kling-v3-omni:pro", label: "Kling 3 Omni Replicate 1080p + audio", usd: 0.28, audio: true, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "replicate-kling-v3-omni:4k", label: "Kling 3 Omni Replicate 4K", usd: 0.42, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "replicate-kling-v3-omni:4k", label: "Kling 3 Omni Replicate 4K + audio", usd: 0.42, audio: true, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-omni-video" },
  { model: "replicate-kling-v3-motion-pro:std", label: "Kling 3 Motion Replicate 720p", usd: 0.07, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-motion-control" },
  { model: "replicate-kling-v3-motion-pro:pro", label: "Kling 3 Motion Replicate 1080p", usd: 0.12, audio: false, provider: "replicate", sourceUrl: "https://replicate.com/kwaivgi/kling-v3-motion-control" },
].map((row) => ({
  feature: "generate_freepik_video",
  model: row.model,
  label: row.label,
  cost: creditsFromReplicateUsd(row.usd),
  pricing_type: "per_second",
  has_audio: row.audio,
  provider: row.provider,
  price_key: `${row.model}:${row.audio ? "audio" : "video"}`,
  resolution: row.model.endsWith(":4k")
    ? "4K"
    : row.model.endsWith(":standard") || row.model.endsWith(":std") || row.model.endsWith(":720p")
      ? "720p"
      : "1080p",
  source: "replicate_docs",
  source_url: row.sourceUrl,
  source_ratio: REPLICATE_PRICE_FACTOR,
  provider_unit: "per second",
  notes: `${row.label} uses Replicate parity pricing at $${row.usd}/sec.`,
}));

const SEEDANCE_ROWS: CreditCostWriteRow[] = [
  { model: "seedance-1-0-pro-250528", label: "Seedance 1.0 Pro 720p", cost: 90, resolution: "720p", audio: false, notes: "Master Pricing Sheet: 720p approx 90 credits/sec." },
  { model: "seedance-1-0-pro-250528", label: "Seedance 1.0 Pro 1080p", cost: 200, resolution: "1080p", audio: false, notes: "Master Pricing Sheet: 1080p approx 200 credits/sec." },
  { model: "seedance-1-0-pro-250528", label: "Seedance 1.0 Pro fallback", cost: 200, resolution: null, audio: false, notes: "Fallback when runtime receives no resolution; uses conservative 1080p rate." },
  { model: "seedance-1-0-pro-fast-251015", label: "Seedance 1.0 Pro Fast 720p", cost: 35, resolution: "720p", audio: false, notes: "Master Pricing Sheet: 720p approx 35 credits/sec." },
  { model: "seedance-1-0-pro-fast-251015", label: "Seedance 1.0 Pro Fast 1080p", cost: 80, resolution: "1080p", audio: false, notes: "Master Pricing Sheet: 1080p approx 80 credits/sec." },
  { model: "seedance-1-0-pro-fast-251015", label: "Seedance 1.0 Pro Fast fallback", cost: 80, resolution: null, audio: false, notes: "Fallback when runtime receives no resolution; uses conservative 1080p rate." },
  { model: "seedance-1-5-pro-251215", label: "Seedance 1.5 Pro 720p no audio", cost: 100, resolution: "720p", audio: false, notes: "Master Pricing Sheet: no audio approx 100 credits/sec." },
  { model: "seedance-1-5-pro-251215", label: "Seedance 1.5 Pro 720p + audio", cost: 200, resolution: "720p", audio: true, notes: "Master Pricing Sheet: with audio approx 200 credits/sec." },
  { model: "seedance-1-5-pro-251215", label: "Seedance 1.5 Pro 1080p no audio", cost: 100, resolution: "1080p", audio: false, notes: "Master Pricing Sheet: 1080p no audio approx 100 credits/sec." },
  { model: "seedance-1-5-pro-251215", label: "Seedance 1.5 Pro 1080p + audio", cost: 200, resolution: "1080p", audio: true, notes: "Master Pricing Sheet: 1080p with audio approx 200 credits/sec." },
  { model: "seedance-1-5-pro-251215", label: "Seedance 1.5 Pro fallback", cost: 100, resolution: null, audio: false, notes: "Fallback when runtime receives no resolution; uses no-audio base rate." },
  { model: "seedance-1-5-pro-251215", label: "Seedance 1.5 Pro + audio fallback", cost: 200, resolution: null, audio: true, notes: "Fallback when runtime receives audio without a resolution split." },
  { model: "seedance-2-0-lite", label: "Seedance 2.0 Fast 480p", cost: creditsFromReplicateUsd(0.08), resolution: "480p", audio: false, replicate: true, notes: "Replicate bytedance/seedance-2.0 non-video input 480p costs $0.08/sec; Workspace uses the Replicate price." },
  { model: "seedance-2-0-lite", label: "Seedance 2.0 Fast 720p", cost: creditsFromReplicateUsd(0.18), resolution: "720p", audio: false, replicate: true, notes: "Replicate bytedance/seedance-2.0 non-video input 720p costs $0.18/sec; Workspace uses the Replicate price." },
  { model: "seedance-2-0-lite", label: "Seedance 2.0 Fast fallback", cost: creditsFromReplicateUsd(0.18), resolution: null, audio: false, replicate: true, notes: "Fallback when runtime receives no resolution; uses the Replicate 720p non-video-input rate." },
  { model: "dreamina-seedance-2-0-fast-260128", label: "Seedance 2.0 Fast direct-id fallback", cost: creditsFromReplicateUsd(0.18), resolution: null, audio: false, replicate: true, notes: "Direct BytePlus model id alias for Seedance 2.0 Fast; uses the Replicate 720p non-video-input rate." },
  { model: "seedance-2-0-pro", label: "Seedance 2.0 Pro 480p", cost: creditsFromReplicateUsd(0.08), resolution: "480p", audio: false, replicate: true, notes: "Replicate bytedance/seedance-2.0 non-video input 480p costs $0.08/sec; Workspace uses the Replicate price." },
  { model: "seedance-2-0-pro", label: "Seedance 2.0 Pro 720p", cost: creditsFromReplicateUsd(0.18), resolution: "720p", audio: false, replicate: true, notes: "Replicate bytedance/seedance-2.0 non-video input 720p costs $0.18/sec; Workspace uses the Replicate price." },
  { model: "seedance-2-0-pro", label: "Seedance 2.0 Pro 1080p", cost: creditsFromReplicateUsd(0.45), resolution: "1080p", audio: false, replicate: true, notes: "Replicate bytedance/seedance-2.0 non-video input 1080p costs $0.45/sec; Workspace uses the Replicate price." },
  { model: "seedance-2-0-pro", label: "Seedance 2.0 Pro fallback", cost: creditsFromReplicateUsd(0.18), resolution: null, audio: false, replicate: true, notes: "Fallback when runtime receives no resolution; uses the Replicate 720p non-video-input rate." },
  { model: "dreamina-seedance-2-0-260128", label: "Seedance 2.0 Pro direct-id fallback", cost: creditsFromReplicateUsd(0.18), resolution: null, audio: false, replicate: true, notes: "Direct BytePlus model id alias for Seedance 2.0 Pro; uses the Replicate 720p non-video-input rate." },
].map((row) => ({
  feature: "generate_freepik_video",
  model: row.resolution ? `${row.model}:${row.resolution}` : row.model,
  label: row.label,
  cost: row.cost,
  pricing_type: "per_second",
  has_audio: row.audio,
  provider: "seedance",
  price_key: `${row.model}:${row.resolution ?? "default"}:${row.audio ? "audio" : "video"}`,
  resolution: row.resolution,
  source: row.replicate ? "replicate_docs" : "master_pricing_sheet",
  source_url: row.replicate ? "https://replicate.com/bytedance/seedance-2.0" : null,
  source_ratio: row.replicate ? REPLICATE_PRICE_FACTOR : null,
  provider_unit: "per second",
  notes: row.notes,
}));

const REPLICATE_SEEDANCE_2_ROWS: CreditCostWriteRow[] = ([
  { model: "replicate-seedance-2-0", label: "Seedance 2.0 Replicate 480p", resolution: "480p", usdPerSecond: 0.08, videoInput: false },
  { model: "replicate-seedance-2-0", label: "Seedance 2.0 Replicate 720p", resolution: "720p", usdPerSecond: 0.18, videoInput: false },
  { model: "replicate-seedance-2-0", label: "Seedance 2.0 Replicate 1080p", resolution: "1080p", usdPerSecond: 0.45, videoInput: false },
  { model: "replicate-seedance-2-0", label: "Seedance 2.0 Replicate fallback", resolution: null, usdPerSecond: 0.18, videoInput: false },
  { model: "replicate-seedance-2-0-video-ref", label: "Seedance 2.0 Replicate 480p + video ref", resolution: "480p", usdPerSecond: 0.10, videoInput: true },
  { model: "replicate-seedance-2-0-video-ref", label: "Seedance 2.0 Replicate 720p + video ref", resolution: "720p", usdPerSecond: 0.22, videoInput: true },
  { model: "replicate-seedance-2-0-video-ref", label: "Seedance 2.0 Replicate 1080p + video ref", resolution: "1080p", usdPerSecond: 0.55, videoInput: true },
  { model: "replicate-seedance-2-0-video-ref", label: "Seedance 2.0 Replicate video-ref fallback", resolution: null, usdPerSecond: 0.22, videoInput: true },
] as const).flatMap((row) =>
  ([false, true] as const).map((audio) => ({
    feature: "generate_freepik_video",
    model: row.resolution ? `${row.model}:${row.resolution}` : row.model,
    label: `${row.label}${audio ? " + audio" : ""}`,
    cost: creditsFromReplicateUsd(row.usdPerSecond),
    pricing_type: "per_second",
    has_audio: audio,
    provider: "replicate",
    price_key: `${row.model}:${row.resolution ?? "default"}:${row.videoInput ? "video_in" : "non_video_in"}:${audio ? "audio" : "silent"}`,
    resolution: row.resolution,
    source: "replicate_docs",
    source_url: "https://replicate.com/bytedance/seedance-2.0",
    source_ratio: REPLICATE_PRICE_FACTOR,
    provider_unit: "per second",
    notes: `Replicate bytedance/seedance-2.0 ${row.videoInput ? "video input" : "non-video input"} ${row.resolution ?? "default 720p"} costs $${row.usdPerSecond}/sec. Workspace uses the Replicate price; audio toggle does not change Replicate pricing, duplicate audio rows keep runtime cost lookup strict.`,
  }))
);

const VEO_ROWS: CreditCostWriteRow[] = ([
  { model: "veo-3.1-generate-001", label: "Google Veo 3.1 no audio", usdPerSecond: 0.20, audio: false },
  { model: "veo-3.1-generate-001", label: "Google Veo 3.1 + audio", usdPerSecond: 0.40, audio: true },
  { model: "veo-3.1-generate-preview", label: "Google Veo 3.1 legacy no audio", usdPerSecond: 0.20, audio: false },
  { model: "veo-3.1-generate-preview", label: "Google Veo 3.1 legacy + audio", usdPerSecond: 0.40, audio: true },
] as const).map((row) => ({
  feature: "generate_freepik_video",
  model: row.model,
  label: row.label,
  cost: creditsFromUsd(row.usdPerSecond),
  pricing_type: "per_second",
  has_audio: row.audio,
  provider: "veo",
  price_key: `${row.model}:${row.audio ? "with_audio" : "without_audio"}`,
  source: "replicate_docs",
  source_url: "https://replicate.com/google/veo-3.1/versions/a55204f92195a6c535170095e221116968f43614517d8ad32b338fa12ee4460b/api",
  provider_unit: "per second",
  notes: `Replicate google/veo-3.1 ${row.audio ? "with_audio" : "without_audio"} rate ${row.usdPerSecond} USD/sec -> ${USD_TO_THB} THB/USD -> ${WORKSPACE_CREDITS_PER_THB} credits/THB. Gemini API does not expose a no-audio parameter, so no-audio jobs are routed through fallback wrappers when available.`,
}));

const ELEVENLABS_TTS_ROWS: CreditCostWriteRow[] = [
  {
    model: "elevenlabs-multilingual-v2",
    apiModel: "eleven_multilingual_v2",
    label: "ElevenLabs Multilingual v2 / 1K chars",
    usdPer1k: 0.10,
    quality: "multilingual-v2",
    notes: "Estimated from ElevenLabs 1 credit per character for Multilingual v2; normalized through Workspace 50 credits/THB.",
  },
  {
    model: "eleven_multilingual_v2",
    apiModel: "eleven_multilingual_v2",
    label: "ElevenLabs Multilingual v2 API alias / 1K chars",
    usdPer1k: 0.10,
    quality: "multilingual-v2",
    notes: "Runtime alias for callers that pass the official ElevenLabs model_id.",
  },
  {
    model: "elevenlabs-turbo-v2-5",
    apiModel: "eleven_turbo_v2_5",
    label: "ElevenLabs Turbo v2.5 / 1K chars",
    usdPer1k: 0.05,
    quality: "turbo-v2.5",
    notes: "Estimated from ElevenLabs 0.5 credit per character for Turbo v2.5; normalized through Workspace 50 credits/THB.",
  },
  {
    model: "eleven_turbo_v2_5",
    apiModel: "eleven_turbo_v2_5",
    label: "ElevenLabs Turbo v2.5 API alias / 1K chars",
    usdPer1k: 0.05,
    quality: "turbo-v2.5",
    notes: "Runtime alias for callers that pass the official ElevenLabs model_id.",
  },
].map((row) => ({
  feature: "text_to_speech",
  model: row.model,
  label: row.label,
  cost: creditsFromUsd(row.usdPer1k),
  pricing_type: "per_1k_chars",
  provider: "elevenlabs",
  price_key: row.apiModel,
  resolution: "text",
  quality: row.quality,
  source: "official_docs_estimate",
  source_url: "https://elevenlabs.io/docs/models",
  provider_unit: "per 1K chars",
  notes: `${row.notes} ${row.usdPer1k} USD/1K chars -> ${USD_TO_THB} THB/USD -> ${WORKSPACE_CREDITS_PER_THB} credits/THB.`,
}));

const RECOMMENDED_WORKSPACE_PRICING: CreditCostWriteRow[] = [
  ...GPT_IMAGE_2_ROWS,
  ...NANO_BANANA_ROWS,
  ...NANO_BANANA_FALLBACK_ROWS,
  ...REPLICATE_BANANA_ROWS,
  ...KLING_ROWS,
  ...KLING_REPLICATE_PARITY_ROWS,
  ...SEEDANCE_ROWS,
  ...REPLICATE_SEEDANCE_2_ROWS,
  ...VEO_ROWS,
  { feature: "generate_seedream_image", model: "seedream-5-0-260128", label: "Seedream 5.0", cost: 60, pricing_type: "per_operation", provider: "byteplus", price_key: "seedream-5-0-260128", source: "master_pricing_sheet", source_url: "https://www.byteplus.com/en/product/modelark", provider_unit: "per image", notes: "Master Pricing Sheet: $0.035/image -> approx 60 credits/image at Workspace ratio." },
  { feature: "generate_seedream_image", model: "seedream-5-0", label: "Seedream 5.0 alias", cost: 60, pricing_type: "per_operation", provider: "byteplus", price_key: "seedream-5-0-260128", source: "master_pricing_sheet", source_url: "https://www.byteplus.com/en/product/modelark", provider_unit: "per image", notes: "Runtime alias for Seedream 5.0." },
  { feature: "generate_seedream_image", model: "seedream-5-0-lite-260128", label: "Seedream 5.0 Lite", cost: 60, pricing_type: "per_operation", provider: "byteplus", price_key: "seedream-5-0-lite-260128", source: "master_pricing_sheet", source_url: "https://www.byteplus.com/en/product/modelark", provider_unit: "per image", notes: "Master Pricing Sheet: Seedream 5.0 Lite official $0.035/image -> 60 credits/image." },
  { feature: "generate_seedream_image", model: "seedream-4-5-251128", label: "Seedream 4.5", cost: 60, pricing_type: "per_operation", provider: "byteplus", price_key: "seedream-4-5-251128", source: "needs_provider_invoice", provider_unit: "per image", notes: "Emergency pricing floor: previous placeholder was 1 credit and could undercharge. Keep aligned with Seedream 5.0 until the provider invoice/SKU rate is confirmed." },
  { feature: "chat_ai", model: "google/gemini-3-pro-preview", label: "Gemini 3 Pro Preview", cost: 100, pricing_type: "per_operation", provider: "google", price_key: "gemini-3-pro-preview", source: "official_docs", source_url: "https://ai.google.dev/gemini-api/docs/gemini-3", provider_unit: "per operation", notes: "Official Gemini 3 Pro Preview model code. Master Pricing Sheet fixed-operation placeholder: 100 credits/op." },
  { feature: "chat_ai", model: "google/gemini-3.1-pro-preview", label: "Gemini 3 Pro Preview (legacy 3.1 alias)", cost: 100, pricing_type: "per_operation", provider: "google", price_key: "gemini-3-pro-preview:legacy-3.1-alias", source: "legacy_alias", source_url: "https://ai.google.dev/gemini-api/docs/gemini-3", provider_unit: "per operation", notes: "Legacy Workspace alias retained so saved canvases using google/gemini-3.1-pro-preview still price and route to official gemini-3-pro-preview." },
  { feature: "chat_ai", model: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview", cost: 20, pricing_type: "per_operation", provider: "google", price_key: "gemini-3-flash-preview", source: "master_pricing_sheet", source_url: "https://ai.google.dev/gemini-api/docs/pricing", provider_unit: "per operation", notes: "Master Pricing Sheet fixed-operation placeholder: 20 credits/op. Token-price reference: input about 0.50 USD / 1M tokens, output about 3 USD / 1M tokens." },
  { feature: "text_to_speech", model: "gemini-3.1-flash-tts-preview", label: "Gemini 3.1 Flash Preview TTS / 1K chars", cost: 50, pricing_type: "per_1k_chars", provider: "google", price_key: "gemini-3.1-flash-tts-preview", source: "official_docs_estimate", source_url: "https://ai.google.dev/gemini-api/docs/speech-generation", provider_unit: "per 1K chars", notes: "Official Gemini TTS preview model. Runtime bills by text length until audio-token metering is implemented; retry is required because preview TTS can occasionally return text tokens instead of audio." },
  { feature: "text_to_speech", model: "gemini-2.5-flash-preview-tts", label: "Gemini 2.5 Flash Preview TTS / 1K chars", cost: 50, pricing_type: "per_1k_chars", provider: "google", price_key: "gemini-2.5-flash-preview-tts", source: "official_docs_estimate", source_url: "https://ai.google.dev/gemini-api/docs/pricing", provider_unit: "per 1K chars", notes: "Emergency estimate. Gemini lists Flash Preview TTS at $0.50/1M text input tokens and $10/1M audio output tokens; runtime bills by text length, so use a conservative per-1K-character floor until audio-token metering is implemented." },
  { feature: "text_to_speech", model: "gemini-2.5-pro-preview-tts", label: "Gemini 2.5 Pro Preview TTS / 1K chars", cost: 100, pricing_type: "per_1k_chars", provider: "google", price_key: "gemini-2.5-pro-preview-tts", source: "official_docs_estimate", source_url: "https://ai.google.dev/gemini-api/docs/pricing", provider_unit: "per 1K chars", notes: "Emergency estimate. Gemini Pro Preview TTS output audio is more expensive than Flash; runtime bills by text length, so use a conservative per-1K-character floor until audio-token metering is implemented." },
  ...ELEVENLABS_TTS_ROWS,
  { feature: "text_to_speech", model: "google-tts-studio", label: "Google Cloud TTS Studio / 1K chars", cost: 280, pricing_type: "per_1k_chars", provider: "google", price_key: "google-tts-studio", quality: "studio", source: "official_docs", source_url: "https://cloud.google.com/text-to-speech/pricing", provider_unit: "per 1K chars" },
  { feature: "text_to_speech", model: "google-tts-neural2", label: "Google Cloud TTS Neural2 / 1K chars", cost: 28, pricing_type: "per_1k_chars", provider: "google", price_key: "google-tts-neural2", quality: "neural2", source: "official_docs", source_url: "https://cloud.google.com/text-to-speech/pricing", provider_unit: "per 1K chars" },
  { feature: "text_to_speech", model: "google-tts-wavenet", label: "Google Cloud TTS WaveNet / 1K chars", cost: 7, pricing_type: "per_1k_chars", provider: "google", price_key: "google-tts-wavenet", quality: "wavenet", source: "official_docs", source_url: "https://cloud.google.com/text-to-speech/pricing", provider_unit: "per 1K chars" },
  { feature: "text_to_speech", model: "google-tts-chirp3-hd", label: "Google Cloud TTS Chirp 3 HD / 1K chars", cost: 53, pricing_type: "per_1k_chars", provider: "google", price_key: "google-tts-chirp3-hd", quality: "chirp3-hd", source: "official_docs", source_url: "https://cloud.google.com/text-to-speech/pricing", provider_unit: "per 1K chars" },
  { feature: "video_to_prompt", model: "gemini-video-understanding", label: "Video to Prompt (Gemini)", cost: 50, pricing_type: "per_operation", provider: "google", price_key: "gemini-video-understanding", source: "master_pricing_sheet", source_url: "https://ai.google.dev/gemini-api/docs/pricing", provider_unit: "per analysis", notes: "Master Pricing Sheet: fixed 50 credits/analysis for short to medium Flash video analysis until runtime supports token metering." },
  { feature: "video_to_prompt", model: "gemini-3-pro-preview", label: "Video to Prompt (Gemini 3 Pro)", cost: 50, pricing_type: "per_operation", provider: "google", price_key: "gemini-3-pro-preview:video", source: "official_docs", source_url: "https://ai.google.dev/gemini-api/docs/gemini-3", provider_unit: "per analysis", notes: "Matches workspace Video to Prompt model selector; fixed short/medium analysis price." },
  { feature: "video_to_prompt", model: "gemini-3.1-pro-preview", label: "Video to Prompt (Gemini 3 Pro legacy 3.1 alias)", cost: 50, pricing_type: "per_operation", provider: "google", price_key: "gemini-3-pro-preview:video:legacy-3.1-alias", source: "legacy_alias", source_url: "https://ai.google.dev/gemini-api/docs/gemini-3", provider_unit: "per analysis", notes: "Legacy Workspace alias retained so saved canvases using gemini-3.1-pro-preview still price and route to official gemini-3-pro-preview." },
  { feature: "video_to_prompt", model: "gemini-3-flash-preview", label: "Video to Prompt (Gemini 3 Flash)", cost: 50, pricing_type: "per_operation", provider: "google", price_key: "gemini-3-flash-preview:video", source: "master_pricing_sheet", source_url: "https://ai.google.dev/gemini-api/docs/pricing", provider_unit: "per analysis", notes: "Matches workspace Video to Prompt model selector; fixed short/medium analysis price." },
  { feature: "model_3d", model: "tripo3d-v3.1", label: "Tripo3D v3.1 Detailed", cost: 900, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-v3.1", quality: "detailed", source: "master_pricing_sheet", source_url: "https://www.tripo3d.ai/", provider_unit: "per model", notes: "Master Pricing Sheet: detailed/high-quality generation approx 900 credits/model." },
  { feature: "model_3d", model: "tripo3d-p1", label: "Tripo3D P1", cost: 850, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-p1", quality: "premium", source: "master_pricing_sheet", source_url: "https://www.tripo3d.ai/", provider_unit: "per model", notes: "Master Pricing Sheet: P1 approx 850 credits/model." },
  { feature: "model_3d", model: "tripo3d-turbo", label: "Tripo3D Turbo", cost: 500, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-turbo", quality: "fast", source: "master_pricing_sheet", source_url: "https://www.tripo3d.ai/", provider_unit: "per model", notes: "Master Pricing Sheet: Turbo approx 500 credits/model." },
  { feature: "model_3d", model: "tripo3d-v3.0", label: "Tripo3D v3.0", cost: 500, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-v3.0", source: "needs_provider_invoice", provider_unit: "per model", notes: "Emergency pricing floor: previous placeholder was 1 credit and could undercharge. Use the Turbo floor until the provider invoice/SKU rate is confirmed." },
  { feature: "model_3d", model: "tripo3d-v2.5", label: "Tripo3D v2.5", cost: 500, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-v2.5", source: "needs_provider_invoice", provider_unit: "per model", notes: "Emergency pricing floor: previous placeholder was 1 credit and could undercharge. Use the Turbo floor until the provider invoice/SKU rate is confirmed." },
  { feature: "model_3d", model: "tripo3d-v2.0", label: "Tripo3D v2.0", cost: 500, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-v2.0", source: "needs_provider_invoice", provider_unit: "per model", notes: "Emergency pricing floor: previous placeholder was 1 credit and could undercharge. Use the Turbo floor until the provider invoice/SKU rate is confirmed." },
  { feature: "model_3d", model: "tripo3d-v1.4", label: "Tripo3D v1.4", cost: 500, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-v1.4", source: "needs_provider_invoice", provider_unit: "per model", notes: "Emergency pricing floor: previous placeholder was 1 credit and could undercharge. Use the Turbo floor until the provider invoice/SKU rate is confirmed." },
  { feature: "remove_background", model: "replicate-birefnet", label: "Remove Background (BiRefNet)", cost: 20, pricing_type: "per_operation", provider: "replicate", price_key: "replicate-birefnet", source: "needs_provider_invoice", provider_unit: "per image", notes: "Emergency pricing floor: previous placeholder was 1 credit and could undercharge. Confirm Replicate deployment hardware/runtime cost before lowering." },
  { feature: "merge_audio_video", model: "shotstack", label: "Merge Audio + Video (Shotstack short clip)", cost: 100, pricing_type: "per_operation", provider: "shotstack", price_key: "shotstack:short-op", source: "master_pricing_sheet", provider_unit: "per short operation", notes: "Master Pricing Sheet: use 100 credits/op for short clips <=10s until runtime tracks media duration per minute." },
  { feature: "merge_audio_video", model: "shotstack:per-minute", label: "Merge Audio + Video (Shotstack per minute)", cost: 500, pricing_type: "per_minute", provider: "shotstack", price_key: "shotstack:per-minute", source: "master_pricing_sheet", provider_unit: "per minute", notes: "Master Pricing Sheet: Shotstack PAYG/subscription blended recommendation = 500 credits/minute." },
  { feature: "mp3_input", model: "mp3-input", label: "MP3 Input", cost: 1, pricing_type: "per_operation", provider: "internal", price_key: "mp3-input", source: "internal_metering", provider_unit: "per file", notes: "Infrastructure-only operation. No external generation API call." },
];

function pricingRowKey(row: Pick<CreditCostWriteRow, "feature" | "model" | "duration_seconds" | "has_audio">): string {
  return [
    row.feature,
    row.model ?? "",
    row.duration_seconds ?? "",
    row.has_audio ? "audio" : "video",
  ].join("::");
}

function isKlingPricingRow(row: Pick<CreditCostWriteRow, "feature" | "model" | "label" | "provider" | "price_key">): boolean {
  if (row.feature !== "generate_freepik_video") return false;
  const raw = [row.provider, row.model, row.label, row.price_key]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return raw.includes("kling");
}

const RECOMMENDED_WORKSPACE_PRICING_KEYS = new Set(
  RECOMMENDED_WORKSPACE_PRICING.map((row) => pricingRowKey(row)),
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Wrap a select() call so we can return a consistent envelope to the
// frontend — `{ data: [...] }` matches what the consumer admin-api
// returns, which keeps the React Query callsites identical regardless of
// which project is active.
async function listRows(
  client: SupabaseClient,
  table: string,
  order: { column: string; ascending?: boolean }[],
): Promise<{ data: unknown[] }> {
  let q = client.from(table).select("*");
  for (const o of order) {
    q = q.order(o.column, { ascending: o.ascending ?? true });
  }
  const { data, error } = await q;
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  return { data: data ?? [] };
}

// Pull markup_multiplier_* rows out of subscription_settings and shape
// them into the flat `{ image, video, chat, audio }` object the Pricing
// Manager UI expects. Storage shape is `key`/`value` text — we coerce
// to numbers here so the frontend doesn't have to know the table layout.
async function getMarkupMultipliers(
  client: SupabaseClient,
): Promise<{ data: Record<MultiplierKey, number> }> {
  const { data, error } = await client
    .from("subscription_settings")
    .select("key, value")
    .like("key", `${MULTIPLIER_PREFIX}%`);
  if (error) {
    throw new Error(`subscription_settings read failed: ${error.message}`);
  }

  const buffer = await getPricingBuffer(client);
  const defaultMultiplier = 1 + buffer.data.buffer_percent / 100;
  // Legacy compatibility: old admin pages expect per-feature multipliers,
  // while Workspace now uses one infrastructure buffer for every feature.
  const out: Record<MultiplierKey, number> = {
    image: defaultMultiplier,
    video: defaultMultiplier,
    chat: defaultMultiplier,
    audio: defaultMultiplier,
  };
  for (const row of data ?? []) {
    const key = String((row as { key: string }).key ?? "");
    const value = (row as { value: string }).value;
    const stripped = key.slice(MULTIPLIER_PREFIX.length);
    const num = Number(value);
    if (
      stripped &&
      Number.isFinite(num) &&
      (MULTIPLIER_KEYS as readonly string[]).includes(stripped)
    ) {
      out[stripped as MultiplierKey] = num;
    }
  }
  return { data: out };
}

async function getPricingBuffer(
  client: SupabaseClient,
): Promise<{ data: { buffer_percent: number; multiplier: number } }> {
  const { data, error } = await client
    .from("subscription_settings")
    .select("value")
    .eq("key", BUFFER_SETTING_KEY)
    .maybeSingle();
  if (error) {
    throw new Error(`subscription_settings read failed: ${error.message}`);
  }
  const parsed = Number((data as { value?: string } | null)?.value);
  const bufferPercent = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BUFFER_PERCENT;
  return { data: { buffer_percent: bufferPercent, multiplier: 1 + bufferPercent / 100 } };
}

async function setPricingBuffer(
  client: SupabaseClient,
  body: Record<string, unknown>,
  audit: { adminUserId: string | null },
): Promise<{ data: { buffer_percent: number; multiplier: number } }> {
  const raw = body.buffer_percent ?? body.infrastructure_buffer_percent ?? body.percent;
  const bufferPercent = Number(raw);
  if (!Number.isFinite(bufferPercent) || bufferPercent < 0 || bufferPercent > 500) {
    throw new Error("`buffer_percent` must be a number between 0 and 500");
  }
  const { error } = await client
    .from("subscription_settings")
    .upsert([{ key: BUFFER_SETTING_KEY, value: String(bufferPercent) }], { onConflict: "key" });
  if (error) {
    throw new Error(`subscription_settings upsert failed: ${error.message}`);
  }
  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "workspace_pricing_buffer.set",
    targetTable: "subscription_settings",
    details: { buffer_percent: bufferPercent },
  });
  return getPricingBuffer(client);
}

// Best-effort audit row. Skipped silently if the table is missing or the
// insert fails — pricing mutations must not be blocked by audit issues.
// admin_audit_logs.admin_user_id is NOT NULL uuid; we don't have a real
// admin user uuid here (cross-project, no JWT verification), so we skip
// the insert when no resolvable uuid is supplied. The frontend doesn't
// pass one yet — leaving the hook in place so it lights up the day we
// federate admin auth.
async function getWorkspaceCreditBalance(
  client: SupabaseClient,
  authHeader: string | null,
  body: Record<string, unknown> = {},
): Promise<{
  data: {
    balance: number;
    total_purchased: number;
    total_used: number;
    is_shared_pool: boolean;
    pool_domain: string | null;
    pool_user_id: string | null;
    organization_id?: string | null;
    organization_name?: string | null;
    organization_type?: string | null;
    credit_scope?: "user" | "organization" | "team" | "education_space";
    team_id?: string | null;
    team_name?: string | null;
    workspace_id?: string | null;
    personal_balance?: number;
    personal_total_purchased?: number;
    personal_total_used?: number;
    shared_balance?: number | null;
    shared_total?: number | null;
    shared_used?: number | null;
  };
}> {
  const token = String(authHeader ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Authorization required");

  const { data: authData, error: authError } = await client.auth.getUser(token);
  if (authError || !authData.user) throw new Error("Invalid token");

  try {
    await acceptPendingOrgInviteForUser(client, authData.user, "credit_balance");
  } catch (err) {
    console.warn(
      "admin_workspace_pricing: pending org invite accept skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }

  let educationScope: Record<string, unknown> | null = null;
  const creditUserId = authData.user.id;
  const { data: personalCredits, error: personalCreditError } = await client
    .from("user_credits")
    .select("balance,total_purchased,total_used")
    .eq("user_id", creditUserId)
    .maybeSingle();
  if (personalCreditError) throw new Error(`user_credits read failed: ${personalCreditError.message}`);

  const personalBalance = Number((personalCredits as { balance?: number } | null)?.balance ?? 0);
  const personalTotalPurchased = Number((personalCredits as { total_purchased?: number } | null)?.total_purchased ?? 0);
  const personalTotalUsed = Number((personalCredits as { total_used?: number } | null)?.total_used ?? 0);
  const requestedWorkspaceId = String(body.workspace_id ?? body.space_id ?? "").trim();

  if (requestedWorkspaceId) {
    try {
      const { data: space, error: spaceError } = await client
        .from("education_student_spaces")
        .select(`
          workspace_id,
          class_id,
          user_id,
          status,
          credits_balance,
          credits_lifetime_received,
          credits_lifetime_used,
          classes:class_id (
            id,
            name,
            code,
            organization_id,
            organizations:organization_id (id, name, display_name, type)
          )
        `)
        .eq("workspace_id", requestedWorkspaceId)
        .eq("user_id", authData.user.id)
        .maybeSingle();
      if (spaceError) throw spaceError;
      if (space?.workspace_id) {
        const cls = Array.isArray((space as any).classes) ? (space as any).classes[0] : (space as any).classes;
        const org = Array.isArray(cls?.organizations) ? cls.organizations[0] : cls?.organizations;
        const educationBalance = Number((space as any).credits_balance ?? 0);
        const educationReceived = Number((space as any).credits_lifetime_received ?? educationBalance);
        const educationUsed = Number((space as any).credits_lifetime_used ?? 0);
        return {
          data: {
            balance: educationBalance,
            total_purchased: educationReceived,
            total_used: educationUsed,
            is_shared_pool: true,
            pool_domain: cls?.code ? String(cls.code) : null,
            pool_user_id: null,
            organization_id: org?.id ? String(org.id) : cls?.organization_id ? String(cls.organization_id) : null,
            organization_name: org?.display_name ? String(org.display_name) : org?.name ? String(org.name) : null,
            organization_type: org?.type ? String(org.type) : null,
            credit_scope: "education_space",
            team_id: cls?.id ? String(cls.id) : null,
            team_name: cls?.name ? String(cls.name) : null,
            workspace_id: requestedWorkspaceId,
            personal_balance: personalBalance,
            personal_total_purchased: personalTotalPurchased,
            personal_total_used: personalTotalUsed,
            shared_balance: educationBalance,
            shared_total: educationReceived,
            shared_used: educationUsed,
          },
        };
      }
    } catch (err) {
      console.warn(
        "admin_workspace_pricing: workspace education credit lookup skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  try {
    const { data: eduScope, error: eduError } = await client.rpc("workspace_education_credit_scope", {
      p_user_id: authData.user.id,
    });
    if (eduError && !/function .*workspace_education_credit_scope/i.test(eduError.message)) {
      throw eduError;
    }
    const eduRow = Array.isArray(eduScope) ? eduScope[0] : eduScope;
    if (eduRow?.organization_id && eduRow?.class_role === "student") {
      educationScope = eduRow as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(
      "admin_workspace_pricing: education credit balance lookup skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const { data: orgScope, error: orgError } = await client.rpc("workspace_org_credit_scope", {
      p_user_id: authData.user.id,
    });
    if (orgError && !/function .*workspace_org_credit_scope/i.test(orgError.message)) {
      throw orgError;
    }
    const orgRow = Array.isArray(orgScope) ? orgScope[0] : orgScope;
    if (orgRow?.organization_id && !educationScope) {
      const balance = Number(orgRow.credit_balance ?? 0);
      let orgUsed = 0;
      try {
        const { data: txRows, error: txError } = await client
          .from("pool_transactions")
          .select("amount,reason")
          .eq("organization_id", orgRow.organization_id)
          .in("reason", ["org_node_run", "org_node_run_refund"])
          .limit(10000);
        if (txError) throw txError;
        orgUsed = (txRows ?? []).reduce((sum: number, tx: any) => {
          const amount = Number(tx.amount ?? 0);
          if (tx.reason === "org_node_run") return sum + Math.abs(Math.min(amount, 0));
          if (tx.reason === "org_node_run_refund") return Math.max(0, sum - Math.max(amount, 0));
          return sum;
        }, 0);
      } catch (err) {
        console.warn(
          "admin_workspace_pricing: org usage lookup skipped:",
          err instanceof Error ? err.message : String(err),
        );
      }
      let team: Record<string, unknown> | null = null;
      try {
        const { data: membership } = await client
          .from("organization_memberships")
          .select("team_id")
          .eq("user_id", authData.user.id)
          .eq("organization_id", orgRow.organization_id)
          .eq("status", "active")
          .not("team_id", "is", null)
          .order("joined_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (membership?.team_id) {
          const { data: teamRow } = await client
            .from("classes")
            .select("id,name,code,credit_pool,credit_pool_consumed")
            .eq("id", membership.team_id)
            .eq("organization_id", orgRow.organization_id)
            .is("deleted_at", null)
            .maybeSingle();
          if (teamRow?.id) {
            team = {
              ...teamRow,
              credit_available: Math.max(
                0,
                Number((teamRow as any).credit_pool ?? 0) - Number((teamRow as any).credit_pool_consumed ?? 0),
              ),
            };
          }
        }
      } catch (err) {
        console.warn(
          "admin_workspace_pricing: team credit balance lookup skipped:",
          err instanceof Error ? err.message : String(err),
        );
      }
      return {
        data: {
          balance: team ? Number((team as any).credit_available ?? 0) : balance,
          total_purchased: team ? Number((team as any).credit_pool ?? 0) : balance,
          total_used: team ? Number((team as any).credit_pool_consumed ?? 0) : orgUsed,
          is_shared_pool: true,
          pool_domain: orgRow.primary_domain ?? null,
          pool_user_id: null,
          organization_id: String(orgRow.organization_id),
          organization_name: orgRow.organization_name ?? null,
          organization_type: orgRow.organization_type ?? null,
          credit_scope: team ? "team" : "organization",
          team_id: team?.id ? String(team.id) : null,
          team_name: team?.name ? String(team.name) : null,
          personal_balance: personalBalance,
          personal_total_purchased: personalTotalPurchased,
          personal_total_used: personalTotalUsed,
          shared_balance: team ? Number((team as any).credit_available ?? 0) : balance,
          shared_total: team ? Number((team as any).credit_pool ?? 0) : balance + orgUsed,
          shared_used: team ? Number((team as any).credit_pool_consumed ?? 0) : orgUsed,
        },
      };
    }
  } catch (err) {
    console.warn(
      "admin_workspace_pricing: org credit balance lookup skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (educationScope) {
    const educationBalance = Number(educationScope.credit_balance ?? 0);
    const educationReceived = Number(educationScope.credits_lifetime_received ?? educationBalance);
    const educationUsed = Number(educationScope.credits_lifetime_used ?? 0);
    return {
      data: {
        balance: educationBalance,
        total_purchased: educationReceived,
        total_used: educationUsed,
        is_shared_pool: true,
        pool_domain: educationScope.class_code ? String(educationScope.class_code) : null,
        pool_user_id: null,
        organization_id: educationScope.organization_id ? String(educationScope.organization_id) : null,
        organization_name: educationScope.organization_name ? String(educationScope.organization_name) : null,
        organization_type: educationScope.organization_type ? String(educationScope.organization_type) : null,
        credit_scope: "education_space",
        team_id: educationScope.class_id ? String(educationScope.class_id) : null,
        team_name: educationScope.class_name ? String(educationScope.class_name) : null,
        personal_balance: personalBalance,
        personal_total_purchased: personalTotalPurchased,
        personal_total_used: personalTotalUsed,
        shared_balance: educationBalance,
        shared_total: educationReceived,
        shared_used: educationUsed,
      },
    };
  }

  return {
    data: {
      balance: personalBalance,
      total_purchased: personalTotalPurchased,
      total_used: personalTotalUsed,
      is_shared_pool: false,
      pool_domain: null,
      pool_user_id: null,
      organization_id: null,
      organization_name: null,
      organization_type: null,
      credit_scope: "user",
      team_id: null,
      team_name: null,
      personal_balance: personalBalance,
      personal_total_purchased: personalTotalPurchased,
      personal_total_used: personalTotalUsed,
      shared_balance: null,
      shared_total: null,
      shared_used: null,
    },
  };
}

async function tryAudit(
  client: SupabaseClient,
  args: {
    adminUserId: string | null;
    action: string;
    targetTable: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  if (!args.adminUserId) return;
  try {
    await client.from("admin_audit_logs").insert({
      admin_user_id: args.adminUserId,
      action: args.action,
      target_table: args.targetTable,
      details: args.details,
    });
  } catch (err) {
    // Don't fail the mutation just because audit logging hiccuped.
    console.warn(
      "admin_workspace_pricing: audit insert skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function saveCreditCostRow(
  client: SupabaseClient,
  row: CreditCostWriteRow,
): Promise<unknown> {
  const duration = row.duration_seconds ?? null;
  const hasAudio = row.has_audio ?? false;
  let query = client
    .from("credit_costs")
    .select("id, discount_percent")
    .eq("feature", row.feature)
    .limit(1);
  query = hasAudio
    ? query.eq("has_audio", true)
    : query.or("has_audio.is.null,has_audio.eq.false");
  query = row.model === null ? query.is("model", null) : query.eq("model", row.model);
  query = duration === null
    ? query.is("duration_seconds", null)
    : query.eq("duration_seconds", duration);
  const { data: existing, error: readErr } = await query.maybeSingle();
  if (readErr) throw new Error(`credit_costs lookup failed: ${readErr.message}`);

  const payload = {
    feature: row.feature,
    model: row.model,
    label: row.label,
    cost: row.cost,
    pricing_type: row.pricing_type,
    duration_seconds: duration,
    has_audio: hasAudio,
    provider: row.provider ?? null,
    price_key: row.price_key ?? null,
    resolution: row.resolution ?? null,
    quality: row.quality ?? null,
    source: row.source ?? null,
    source_url: row.source_url ?? null,
    source_ratio: row.source_ratio ?? null,
    provider_unit: row.provider_unit ?? null,
    notes: row.notes ?? null,
    discount_percent:
      row.discount_percent ??
      (isKlingPricingRow(row) ? 20 : (existing as { discount_percent?: number | null } | null)?.discount_percent ?? 0),
    updated_at: new Date().toISOString(),
  };

  if ((existing as { id?: string } | null)?.id) {
    const { data, error } = await client
      .from("credit_costs")
      .update(payload)
      .eq("id", (existing as { id: string }).id)
      .select()
      .single();
    if (error) throw new Error(`credit_costs update failed: ${error.message}`);
    return data;
  }

  const { data, error } = await client
    .from("credit_costs")
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(`credit_costs insert failed: ${error.message}`);
  return data;
}

async function cleanupLegacyPricingRows(client: SupabaseClient): Promise<number> {
  let deleted = 0;
  const staleDeletes = [
    client
      .from("credit_costs")
      .delete()
      .eq("feature", "generate_freepik_video")
      .in("model", ["kling-v2-6-pro", "kling-v2-6-motion-pro"])
      .eq("pricing_type", "fixed"),
    client
      .from("credit_costs")
      .delete()
      .eq("feature", "generate_freepik_video")
      .eq("model", "kling-v3-omni-video-ref")
      .eq("has_audio", true),
    client
      .from("credit_costs")
      .delete()
      .like("label", "[STUB]%"),
    client
      .from("credit_costs")
      .delete()
      .eq("feature", "generate_openai_image")
      .in("model", ["gpt-image-2-low", "gpt-image-2-medium", "gpt-image-2-high"]),
    client
      .from("credit_costs")
      .delete()
      .eq("feature", "generate_openai_image")
      .ilike("label", "%fallback%"),
  ];
  for (const deleteQuery of staleDeletes) {
    const { count, error } = await deleteQuery.select("id", { count: "exact", head: true });
    if (error) {
      console.warn("admin_workspace_pricing: legacy cleanup skipped:", error.message);
      continue;
    }
    deleted += count ?? 0;
  }
  return deleted;
}

async function seedWorkspacePricingCatalog(
  client: SupabaseClient,
  audit: { adminUserId: string | null },
): Promise<{ data: { written: number; deleted_legacy: number; ratio: number; rows: unknown[] } }> {
  const deletedLegacy = await cleanupLegacyPricingRows(client);
  const rows: unknown[] = [];
  for (const row of RECOMMENDED_WORKSPACE_PRICING) {
    rows.push(await saveCreditCostRow(client, row));
  }
  const buffer = await getPricingBuffer(client);
  if (buffer.data.buffer_percent === DEFAULT_BUFFER_PERCENT) {
    await client
      .from("subscription_settings")
      .upsert([{ key: BUFFER_SETTING_KEY, value: String(DEFAULT_BUFFER_PERCENT) }], { onConflict: "key" });
  }
  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "workspace_pricing_catalog.seed",
    targetTable: "credit_costs",
    details: { written: rows.length, deleted_legacy: deletedLegacy, ratio: FLOW_TO_WORKSPACE_RATIO, buffer_percent: buffer.data.buffer_percent },
  });
  return { data: { written: rows.length, deleted_legacy: deletedLegacy, ratio: FLOW_TO_WORKSPACE_RATIO, rows } };
}

async function importFlowCreditCosts(
  client: SupabaseClient,
  audit: { adminUserId: string | null },
): Promise<{ data: { imported: number; ratio: number; rows: unknown[] } }> {
  const bridgeUrl = Deno.env.get("MAIN_BRIDGE_URL") ?? "";
  const secret = Deno.env.get("ERP_BRIDGE_SECRET") ?? "";
  if (!bridgeUrl || !secret) {
    throw new Error("MAIN_BRIDGE_URL and ERP_BRIDGE_SECRET must be configured before importing Flow ERP pricing.");
  }
  const u = new URL(bridgeUrl);
  u.pathname = "/functions/v1/erp-bridge";
  const res = await fetch(u.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "x-erp-secret": secret,
    },
    body: JSON.stringify({ action: "fetch_credit_costs", secret, payload: {} }),
  });
  const raw = await res.text();
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!res.ok) {
    throw new Error(`Flow ERP import failed (${res.status}): ${raw.slice(0, 300)}`);
  }
  const maybe = parsed as { data?: unknown; ok?: boolean; error?: unknown };
  const sourceRows = Array.isArray(maybe.data)
    ? maybe.data
    : Array.isArray(parsed)
      ? parsed as unknown[]
      : [];
  if (maybe.ok === false) {
    throw new Error(typeof maybe.error === "string" ? maybe.error : "Flow ERP bridge returned failure");
  }

  const written: unknown[] = [];
  let skippedRecommended = 0;
  for (const rawRow of sourceRows) {
    const r = rawRow as Record<string, unknown>;
    const cost = Math.max(1, Math.ceil(Number(r.cost ?? 0) * FLOW_TO_WORKSPACE_RATIO));
    if (!r.feature || !Number.isFinite(cost)) continue;
    const candidateKey = pricingRowKey({
      feature: String(r.feature),
      model: r.model == null ? null : String(r.model),
      duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      has_audio: Boolean(r.has_audio),
    });
    if (RECOMMENDED_WORKSPACE_PRICING_KEYS.has(candidateKey)) {
      skippedRecommended += 1;
      continue;
    }
    written.push(await saveCreditCostRow(client, {
      feature: String(r.feature),
      model: r.model == null ? null : String(r.model),
      label: String(r.label ?? r.model ?? r.feature),
      cost,
      pricing_type: r.pricing_type == null ? "per_operation" : String(r.pricing_type),
      duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      has_audio: Boolean(r.has_audio),
      provider: r.provider == null ? null : String(r.provider),
      price_key: r.price_key == null ? null : String(r.price_key),
      resolution: r.resolution == null ? null : String(r.resolution),
      quality: r.quality == null ? null : String(r.quality),
      source: "flow_erp_converted",
      source_url: "Flow ERP",
      source_ratio: FLOW_TO_WORKSPACE_RATIO,
      provider_unit: r.provider_unit == null ? null : String(r.provider_unit),
      notes: `Imported from Flow ERP and converted ${FLOW_CREDITS_PER_THB}->${WORKSPACE_CREDITS_PER_THB} credits/THB.`,
    }));
  }
  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "flow_credit_costs.import",
    targetTable: "credit_costs",
    details: { imported: written.length, skipped_recommended: skippedRecommended, ratio: FLOW_TO_WORKSPACE_RATIO },
  });
  return { data: { imported: written.length, skipped_recommended: skippedRecommended, ratio: FLOW_TO_WORKSPACE_RATIO, rows: written } };
}

// ── Mutation handlers ────────────────────────────────────────────────

async function upsertCreditCost(
  client: SupabaseClient,
  body: Record<string, unknown>,
  audit: { adminUserId: string | null },
): Promise<{ data: unknown }> {
  // Pull only the columns we know about. Anything else in `body` is
  // silently ignored — this keeps the contract narrow and prevents the
  // admin UI from accidentally writing freeform columns.
  const id = typeof body.id === "string" && body.id ? body.id : null;
  const feature = String(body.feature ?? "").trim();
  const model =
    body.model === null || body.model === undefined
      ? null
      : String(body.model).trim() || null;
  const label = String(body.label ?? "").trim();
  const cost = Number(body.cost);
  const pricing_type =
    body.pricing_type === null || body.pricing_type === undefined
      ? null
      : String(body.pricing_type).trim() || null;
  const duration_seconds =
    body.duration_seconds === null || body.duration_seconds === undefined
      ? null
      : Number(body.duration_seconds);
  const has_audio = Boolean(body.has_audio);
  const optionalText = (key: string) =>
    body[key] === null || body[key] === undefined
      ? null
      : String(body[key]).trim() || null;
  const source_ratio =
    body.source_ratio === null || body.source_ratio === undefined
      ? null
      : Number(body.source_ratio);
  const explicitDiscountPercent =
    body.discount_percent === null || body.discount_percent === undefined
      ? null
      : Number(body.discount_percent);

  if (!feature) throw new Error("`feature` is required");
  if (!label) throw new Error("`label` is required");
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("`cost` must be a positive number");
  }
  if (
    duration_seconds !== null &&
    (!Number.isFinite(duration_seconds) || duration_seconds < 0)
  ) {
    throw new Error("`duration_seconds` must be a non-negative number");
  }
  if (
    explicitDiscountPercent !== null &&
    (!Number.isFinite(explicitDiscountPercent) || explicitDiscountPercent < 0 || explicitDiscountPercent > 100)
  ) {
    throw new Error("`discount_percent` must be a number between 0 and 100");
  }

  let existingQuery = client
    .from("credit_costs")
    .select("id, discount_percent")
    .eq("feature", feature)
    .limit(1);
  existingQuery = model === null ? existingQuery.is("model", null) : existingQuery.eq("model", model);
  existingQuery = duration_seconds === null
    ? existingQuery.is("duration_seconds", null)
    : existingQuery.eq("duration_seconds", duration_seconds);
  existingQuery = has_audio
    ? existingQuery.eq("has_audio", true)
    : existingQuery.or("has_audio.is.null,has_audio.eq.false");
  const { data: existingForNaturalKey, error: existingForNaturalKeyErr } =
    await existingQuery.maybeSingle();
  if (existingForNaturalKeyErr) {
    throw new Error(`credit_costs lookup failed: ${existingForNaturalKeyErr.message}`);
  }

  const provider = optionalText("provider");
  const price_key = optionalText("price_key");
  const rowDiscountPercent =
    explicitDiscountPercent ??
    (isKlingPricingRow({ feature, model, label, provider, price_key })
      ? 20
      : Number((existingForNaturalKey as { discount_percent?: number | null } | null)?.discount_percent ?? 0));

  const row = {
    feature,
    model,
    label,
    cost,
    pricing_type,
    duration_seconds,
    has_audio,
    provider,
    price_key,
    resolution: optionalText("resolution"),
    quality: optionalText("quality"),
    source: optionalText("source"),
    source_url: optionalText("source_url"),
    source_ratio: source_ratio !== null && Number.isFinite(source_ratio) ? source_ratio : null,
    provider_unit: optionalText("provider_unit"),
    notes: optionalText("notes"),
    discount_percent: rowDiscountPercent,
    updated_at: new Date().toISOString(),
  };

  const targetId = id ?? ((existingForNaturalKey as { id?: string } | null)?.id ?? null);

  if (targetId) {
    const { data, error } = await client
      .from("credit_costs")
      .update(row)
      .eq("id", targetId)
      .select()
      .single();
    if (error) throw new Error(`credit_costs update failed: ${error.message}`);
    await tryAudit(client, {
      adminUserId: audit.adminUserId,
      action: "credit_cost.update",
      targetTable: "credit_costs",
      details: { id: targetId, ...row },
    });
    return { data };
  }

  const { data, error } = await client
    .from("credit_costs")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`credit_costs insert failed: ${error.message}`);
  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "credit_cost.insert",
    targetTable: "credit_costs",
    details: { id: (data as { id?: string })?.id ?? null, ...row },
  });
  return { data };
}

async function deleteCreditCost(
  client: SupabaseClient,
  body: Record<string, unknown>,
  audit: { adminUserId: string | null },
): Promise<{ data: { id: string } }> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) throw new Error("`id` is required");

  const { error } = await client.from("credit_costs").delete().eq("id", id);
  if (error) throw new Error(`credit_costs delete failed: ${error.message}`);

  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "credit_cost.delete",
    targetTable: "credit_costs",
    details: { id },
  });
  return { data: { id } };
}

async function setMarkupMultipliers(
  client: SupabaseClient,
  body: Record<string, unknown>,
  audit: { adminUserId: string | null },
): Promise<{ data: Record<MultiplierKey, number> }> {
  // Build the upsert rows in storage shape (`markup_multiplier_<key>`).
  // We only touch the four canonical keys — anything else in the body is
  // silently ignored.
  const out: Record<MultiplierKey, number> = {
    image: 1 + DEFAULT_BUFFER_PERCENT / 100,
    video: 1 + DEFAULT_BUFFER_PERCENT / 100,
    chat: 1 + DEFAULT_BUFFER_PERCENT / 100,
    audio: 1 + DEFAULT_BUFFER_PERCENT / 100,
  };
  const rows: { key: string; value: string }[] = [];
  for (const k of MULTIPLIER_KEYS) {
    const raw = body[k];
    if (raw === undefined || raw === null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`Multiplier "${k}" must be a positive number`);
    }
    out[k] = num;
    rows.push({ key: `${MULTIPLIER_PREFIX}${k}`, value: String(num) });
  }

  if (rows.length === 0) {
    throw new Error(
      "Provide at least one of: image, video, chat, audio multipliers.",
    );
  }

  // ON CONFLICT(key) DO UPDATE — `subscription_settings.key` has a UNIQUE
  // constraint (subscription_settings_key_key) so this is a clean upsert.
  const { error } = await client
    .from("subscription_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) {
    throw new Error(`subscription_settings upsert failed: ${error.message}`);
  }

  // Re-read so the response reflects whatever's actually stored after
  // the upsert (in case other keys were already there with different
  // values that we didn't pass in this call).
  const fresh = await getMarkupMultipliers(client);
  const values = Object.values(fresh.data);
  if (values.length > 0 && values.every((value) => Math.abs(value - values[0]) < 0.0001)) {
    await setPricingBuffer(
      client,
      { buffer_percent: Math.max(0, Math.round((values[0] - 1) * 10000) / 100) },
      audit,
    );
  }

  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "markup_multipliers.set",
    targetTable: "subscription_settings",
    details: { written: out },
  });

  return fresh;
}

// Workspace doesn't have flow-level pricing baked into a `flows.credit_cost`
// column the way the consumer product does — node costs are evaluated at
// run time. There's nothing to recalculate here, but the admin UI fires
// this action on every save so we return a friendly no-op shape rather
// than 501.
function recalculateAllPrices(): { data: Record<string, unknown> } {
  return {
    data: {
      updated_count: 0,
      skipped: true,
      reason:
        "Workspace product runs nodes individually; no per-flow price to recalc.",
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed — use POST" }, 405);
  }

  // ── ADMIN-JWT GATE TEMPORARILY DISABLED ───────────────────────
  // Tier-0 audit added `verifyAdminJwt` here; that helper validates
  // the admin hub's Supabase session by calling THAT project's
  // /auth/v1/user endpoint, which requires its anon-key. The anon
  // key isn't yet configured as `ADMIN_AUTH_SUPABASE_ANON_KEY` env
  // var on this project, so every admin call 401'd → admin pricing
  // page showed empty + "Unauthorized" toast.
  //
  // Re-enable: set ADMIN_AUTH_SUPABASE_ANON_KEY in this project's
  // Supabase Dashboard → Functions → Secrets (paste the admin hub
  // project's anon-public key, found in admin hub Dashboard → API),
  // then uncomment the two lines below.
  //
  //   const adminPayload = await verifyAdminJwt(req);
  //   if (!adminPayload) return unauthorizedResponse(CORS_HEADERS);

  let body: { action?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!action) {
    return json({ error: "Missing `action` in request body" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Audit context. We don't have a federated admin user uuid here — the
  // admin-hub JWT is signed by a different project. If the frontend
  // someday passes `x-admin-user-id`, we'll start writing audit rows.
  // `x-admin-email` is accepted for forward compat (logged into details).
  const adminUserHeader = req.headers.get("x-admin-user-id");
  const adminEmailHeader = req.headers.get("x-admin-email");
  const auditCtx = {
    adminUserId:
      adminUserHeader && /^[0-9a-f-]{36}$/i.test(adminUserHeader)
        ? adminUserHeader
        : null,
    adminEmail: adminEmailHeader || null,
  };

  try {
    switch (action) {
      // ── Reads ──────────────────────────────────────────────────────
      case "list_plans":
        return json(
          await listRows(admin, "subscription_plans", [
            { column: "sort_order", ascending: true },
          ]),
        );

      case "list_topup_packages":
        return json(
          await listRows(admin, "topup_packages", [
            { column: "sort_order", ascending: true },
          ]),
        );

      // Pricing Manager calls this `fetch_credit_costs` against the consumer
      // bridge — accept both names so the frontend can stay agnostic.
      case "list_credit_costs":
      case "fetch_credit_costs": {
        const rows = await listRows(admin, "credit_costs", [
            { column: "feature", ascending: true },
            { column: "model", ascending: true },
        ]);
        if (rows.data.length === 0) {
          await seedWorkspacePricingCatalog(admin, auditCtx);
          return json(
            await listRows(admin, "credit_costs", [
              { column: "feature", ascending: true },
              { column: "model", ascending: true },
            ]),
          );
        }
        return json(rows);
      }

      case "get_markup_multipliers":
        return json(await getMarkupMultipliers(admin));

      case "get_pricing_buffer":
        return json(await getPricingBuffer(admin));

      case "get_workspace_credit_balance":
        return json(await getWorkspaceCreditBalance(admin, req.headers.get("authorization"), body));

      case "get_pricing_catalog": {
        const buffer = await getPricingBuffer(admin);
        return json({
          data: {
            ratios: {
              flow_credits_per_thb: FLOW_CREDITS_PER_THB,
              workspace_credits_per_thb: WORKSPACE_CREDITS_PER_THB,
              flow_to_workspace_ratio: FLOW_TO_WORKSPACE_RATIO,
            },
            buffer: buffer.data,
            rows: RECOMMENDED_WORKSPACE_PRICING,
          },
        });
      }

      // ── Mutations ──────────────────────────────────────────────────
      case "upsert_credit_cost":
        return json(await upsertCreditCost(admin, body, auditCtx));

      case "delete_credit_cost":
        return json(await deleteCreditCost(admin, body, auditCtx));

      case "set_markup_multipliers":
        return json(await setMarkupMultipliers(admin, body, auditCtx));

      case "set_pricing_buffer":
        return json(await setPricingBuffer(admin, body, auditCtx));

      case "recalculate_all_prices":
        return json(recalculateAllPrices());

      case "seed_workspace_pricing_catalog":
        return json(await seedWorkspacePricingCatalog(admin, auditCtx));

      case "import_flow_credit_costs":
        return json(await importFlowCreditCosts(admin, auditCtx));

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("admin_workspace_pricing error:", msg);
    return json({ error: msg }, 500);
  }
});
