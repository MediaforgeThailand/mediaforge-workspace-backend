/// <reference lib="deno.ns" />
/**
 * Workspace generation analytics helpers.
 *
 * Extracted from workspace-run-node/index.ts so the dispatcher source
 * stays small enough to round-trip through the MCP deploy tool. Same
 * behaviour as the original inline helpers — see
 * supabase/migrations/20260429160000_workspace_generation_events.sql for
 * the table this writes to and the analytics surface that reads it.
 *
 * Recording is best-effort: every helper here is wrapped at the call
 * site in a try/catch so a transient Postgres / table-missing error can
 * never fail a working generation.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Keep this in sync with the inline `ProviderResult` interface in
 *  workspace-run-node/index.ts. We re-declare instead of importing to
 *  avoid a cyclic dependency between the dispatcher and _shared. */
export interface ProviderResultLike {
  task_id?: string;
  result_url?: string;
  outputs: Record<string, unknown>;
  output_type: "video_url" | "image_url" | "text" | "audio_url" | "model_3d";
  provider_meta?: Record<string, unknown>;
  /** Number of distinct media units the provider produced for this run.
   *  Defaults to 1 when omitted. Multi-image providers (Banana / GPT
   *  Image with n>1) should set this so usage logging doesn't undercount
   *  cost — every billable output unit gets its own per-row weight. */
  output_count?: number;
}

/** Bucket image dimensions / video resolution into the four output tiers
 *  the analytics surface displays. Matches the spec:
 *    < 768  → low
 *    < 1280 → medium
 *    < 1920 → high
 *    ≥ 1920 → 2k
 *  When width/height are unknown we return null so the analytics page
 *  can show "—" rather than mis-classify. */
export function classifyOutputTier(
  width: number | null,
  height: number | null,
): string | null {
  const max = Math.max(width ?? 0, height ?? 0);
  if (!max) return null;
  if (max >= 1920) return "2k";
  if (max >= 1280) return "high";
  if (max >= 768) return "medium";
  return "low";
}

/** Map a provider key + raw params/result into a (feature, model, tier,
 *  width, height, duration) tuple suitable for insertion. */
export function deriveAnalyticsFromRun(
  provider: string,
  nodeType: string,
  params: Record<string, unknown>,
  result: ProviderResultLike,
): {
  feature: string;
  model: string;
  output_tier: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
} {
  // Feature: derive from output type, falling back to nodeType keyword.
  // Text outputs map to "chat_ai" so the analytics row joins cleanly to
  // credit_costs (whose chat-AI rates use feature="chat_ai") — keeping
  // the two surfaces aligned means a future $/run rollup just works.
  let feature: string;
  if (result.output_type === "video_url") feature = "video";
  else if (result.output_type === "image_url") feature = "image";
  else if (result.output_type === "audio_url") feature = "audio";
  else if (result.output_type === "text") feature = "chat_ai";
  else if (result.output_type === "model_3d") feature = "model_3d";
  else if (/audio/i.test(nodeType)) feature = "audio";
  else if (/3d|tripo/i.test(nodeType)) feature = "model_3d";
  else feature = "image";

  const model = String(
    params.model_name ?? params.model ?? provider ?? "unknown",
  );

  // Width / height extraction — order matters.
  let width: number | null = null;
  let height: number | null = null;

  const paramWidth = Number(params.width);
  const paramHeight = Number(params.height);
  if (Number.isFinite(paramWidth) && paramWidth > 0) width = paramWidth;
  if (Number.isFinite(paramHeight) && paramHeight > 0) height = paramHeight;

  // OpenAI gpt-image / DALL·E style "1024x1024".
  if ((!width || !height) && typeof params.size === "string") {
    const m = params.size.match(/^(\d+)x(\d+)$/i);
    if (m) {
      width = width ?? Number(m[1]);
      height = height ?? Number(m[2]);
    }
  }

  // Banana/Gemini "image_size" enum.
  let tierFromEnum: string | null = null;
  const imageSize = String(params.image_size ?? params.imageSize ?? "")
    .toLowerCase()
    .trim();
  if (imageSize === "4k") tierFromEnum = "2k";
  else if (imageSize === "2k") tierFromEnum = "2k";
  else if (imageSize === "1k") tierFromEnum = "high";
  else if (imageSize === "512" || imageSize === "low") tierFromEnum = "low";

  // provider_meta echo (e.g. Kling sometimes returns the actual rendered size).
  const meta = (result.provider_meta ?? {}) as Record<string, unknown>;
  if (!width && typeof meta.width === "number") width = meta.width;
  if (!height && typeof meta.height === "number") height = meta.height;

  // Duration (videos): Kling has `duration_seconds` or `duration`.
  let duration: number | null = null;
  const durRaw = params.duration_seconds ?? params.duration;
  if (durRaw !== undefined && durRaw !== null) {
    const n = Number(durRaw);
    if (Number.isFinite(n) && n > 0) duration = n;
  }

  const aspect = typeof params.aspect_ratio === "string" && params.aspect_ratio
    ? String(params.aspect_ratio)
    : null;

  const tier = classifyOutputTier(width, height) ?? tierFromEnum;

  return {
    feature,
    model,
    output_tier: tier,
    width,
    height,
    duration_seconds: duration,
    aspect_ratio: aspect,
  };
}

/** Whitelist of params keys we surface in the admin Recent-Generations
 *  table. These are the knobs that drive credit cost (e.g. GPT-Image's
 *  `quality`, Banana's `image_size`, Kling's `duration_seconds` /
 *  `has_audio`). We deliberately exclude the prompt, uploaded image
 *  URLs, and any internal flags — the analytics surface is operator-
 *  facing and shouldn't leak user prompts.
 *
 *  Empty strings, null, undefined, and NaN are dropped so the rendered
 *  pill list stays compact ("quality:high · 2K") instead of showing
 *  "format:" with an empty value. */
export const COST_PARAM_KEYS = [
  "quality",
  "size",
  "image_size",
  "resolution",
  "aspect_ratio",
  "duration_seconds",
  "has_audio",
  "format",
  "output_format",
  // Chat-AI billing fields. Token counts come straight from provider
  // response; max_tokens / temperature are user-tunable knobs that
  // affect cost. Keeping them in the same whitelist means we don't
  // touch the schema and the params jsonb stays cost-relevant only.
  "model_name",
  "max_tokens",
  "temperature",
  "tokens_in",
  "tokens_out",
  "tokens_total",
] as const;

export function pickCostParams(
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const k of COST_PARAM_KEYS) {
    const v = params[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Insert one analytics row for a successful run. Best-effort: errors
 *  are logged + swallowed. Caller must already have a service-role
 *  supabase client (the dispatcher does — it bypasses RLS for asset
 *  inserts too). */
// deno-lint-ignore no-explicit-any
export async function recordGenerationEvent(args: {
  supabase: SupabaseClient<any, any, any>;
  userId: string;
  organizationId?: string | null;
  classId?: string | null;
  provider: string;
  nodeType: string;
  params: Record<string, unknown>;
  result: ProviderResultLike;
  projectId?: string | null;
  workspaceId?: string | null;
  canvasId?: string | null;
  nodeId?: string | null;
  creditsSpent?: number | null;
}): Promise<void> {
  try {
    const a = deriveAnalyticsFromRun(
      args.provider,
      args.nodeType,
      args.params,
      args.result,
    );

    // Output count: trust the executor when it reports >1 (Banana,
    // GPT-Image with n>1, etc). Default to 1 so single-output flows
    // still record correctly. Guard against bad values by clamping
    // negative / NaN to 1 — undercount is preferable to a poison row.
    const rawCount = args.result.output_count;
    const outputCount =
      typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0
        ? Math.floor(rawCount)
        : 1;

    // Merge token usage from provider_meta into params jsonb so the
    // chat-AI analytics surface can compute cost without a schema
    // change. Mutating a shallow copy keeps the caller's params
    // object untouched.
    const meta = (args.result.provider_meta ?? {}) as Record<string, unknown>;
    const enrichedParams: Record<string, unknown> = { ...args.params };
    for (const key of ["tokens_in", "tokens_out", "tokens_total"]) {
      const v = meta[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        enrichedParams[key] = v;
      }
    }

    const { error } = await args.supabase
      .from("workspace_generation_events")
      .insert({
        user_id: args.userId,
        organization_id: args.organizationId ?? null,
        class_id: args.classId ?? null,
        project_id: args.projectId ?? null,
        workspace_id: args.workspaceId ?? null,
        canvas_id: args.canvasId ?? null,
        node_id: args.nodeId ?? null,
        feature: a.feature,
        model: a.model,
        provider: args.provider,
        output_tier: a.output_tier,
        output_count: outputCount,
        width: a.width,
        height: a.height,
        duration_seconds: a.duration_seconds,
        aspect_ratio: a.aspect_ratio,
        credits_spent: args.creditsSpent ?? null,
        status: "completed",
        task_id: args.result.task_id ?? null,
        // Whitelisted cost-driving settings — see COST_PARAM_KEYS for
        // the full list and the migration 20260429180000 for the
        // reasoning. Null when no whitelisted keys are present.
        // For chat_ai feature this also carries tokens_in/out merged
        // from provider_meta above.
        params: pickCostParams(enrichedParams),
      });
    if (error) {
      console.warn(
        "[workspace-run-node] analytics insert skipped:",
        error.message,
      );
    }
  } catch (err) {
    console.warn(
      "[workspace-run-node] analytics insert threw:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
