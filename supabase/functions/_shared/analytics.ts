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
  output_type: "video_url" | "image_url" | "text";
  provider_meta?: Record<string, unknown>;
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
  let feature: string;
  if (result.output_type === "video_url") feature = "video";
  else if (result.output_type === "image_url") feature = "image";
  else if (result.output_type === "text") feature = "text";
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

/** Insert one analytics row for a successful run. Best-effort: errors
 *  are logged + swallowed. Caller must already have a service-role
 *  supabase client (the dispatcher does — it bypasses RLS for asset
 *  inserts too). */
// deno-lint-ignore no-explicit-any
export async function recordGenerationEvent(args: {
  supabase: SupabaseClient<any, any, any>;
  userId: string;
  provider: string;
  nodeType: string;
  params: Record<string, unknown>;
  result: ProviderResultLike;
  workspaceId?: string | null;
  canvasId?: string | null;
  nodeId?: string | null;
}): Promise<void> {
  try {
    const a = deriveAnalyticsFromRun(
      args.provider,
      args.nodeType,
      args.params,
      args.result,
    );
    const { error } = await args.supabase
      .from("workspace_generation_events")
      .insert({
        user_id: args.userId,
        workspace_id: args.workspaceId ?? null,
        canvas_id: args.canvasId ?? null,
        node_id: args.nodeId ?? null,
        feature: a.feature,
        model: a.model,
        provider: args.provider,
        output_tier: a.output_tier,
        output_count: 1,
        width: a.width,
        height: a.height,
        duration_seconds: a.duration_seconds,
        aspect_ratio: a.aspect_ratio,
        status: "completed",
        task_id: args.result.task_id ?? null,
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
