// admin_workspace_analytics — workspace-side admin reads for the
// Generation Analytics admin-hub page.
//
// Purpose
// -------
// Workspace V2 (workspace-run-node) is otherwise stateless — every
// generation is a single fire-and-forget node call that doesn't write
// to flow_runs / pipeline_executions / credit_transactions today. To
// give the operator visibility on per-model and per-tier volume we
// added `public.workspace_generation_events` (one row per successful
// run, written by the dispatcher's best-effort recorder).
//
// This function aggregates over that table on demand. Two actions:
//
//   - generation_summary   { since?, until?, group_by? }
//       Totals, by-model, by-tier, 30-day timeseries.
//   - recent_generations   { limit?, model?, feature? }
//       Last N rows for the recent-activity table on the admin page.
//
// Mirrors the style of admin_workspace_pricing / admin_workspace_logs:
// `verify_jwt: false`, POST + { action, ...payload } shape, service-role
// internally, same CORS helper. The admin user's JWT is signed by the
// admin DB project, not this one, so we deliberately don't verify it.
// Returns aggregate counts only (no message bodies, no emails) — the
// blast radius is the analytics surface, which the admin can already
// see via Supabase Studio.
//
// Privacy: recent_generations returns user_id only — no email lookup.
// The admin-hub joins emails client-side via its own user-lookup
// capability when needed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/** Coerce a since/until input to ISO. Accepts ISO strings or null/undefined.
 *  Defaults to 30 days ago for `since` and now for `until` so the page
 *  has sensible defaults without the caller having to compute them. */
function resolveWindow(
  since?: unknown,
  until?: unknown,
): { since: string; until: string } {
  const now = Date.now();
  const defaultSince = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const defaultUntil = new Date(now).toISOString();

  let s = defaultSince;
  if (typeof since === "string" && since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) s = d.toISOString();
  }
  let u = defaultUntil;
  if (typeof until === "string" && until) {
    const d = new Date(until);
    if (!Number.isNaN(d.getTime())) u = d.toISOString();
  }
  return { since: s, until: u };
}

interface EventRow {
  feature: string;
  model: string;
  output_tier: string | null;
  output_count: number | null;
  credits_spent: number | null;
  created_at: string;
}

/** generation_summary — pulls every row in [since, until] and aggregates
 *  in JS. Workspace events are sparse today (zero rows currently;
 *  expected to grow to a few hundred / day as the workspace product
 *  ships) so a full scan over a 30-day window stays sub-100ms even
 *  without a fancy materialised view. We keep the shape aligned with
 *  what the admin-hub page expects so the React code stays a 1-1 read.
 */
async function generationSummary(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{
  range: { since: string; until: string };
  totals: {
    images: number;
    videos: number;
    audio: number;
    other: number;
    grand_total: number;
    credits_spent: number;
  };
  by_model: Array<{
    model: string;
    feature: string;
    count: number;
    credits: number;
  }>;
  by_tier: Array<{ tier: string; feature: string; count: number }>;
  by_feature: Array<{ feature: string; count: number }>;
  timeseries: Array<{
    date: string;
    images: number;
    videos: number;
    audio: number;
    other: number;
  }>;
}> {
  const { since, until } = resolveWindow(body.since, body.until);

  // Pull the columns we need for every aggregation in a single read.
  // workspace_generation_events is narrow (10-ish columns) so this is
  // cheap. We intentionally do NOT pull user_id / canvas_id / task_id
  // here — the summary is anonymous by design.
  const { data, error } = await client
    .from("workspace_generation_events")
    .select("feature, model, output_tier, output_count, credits_spent, created_at")
    .gte("created_at", since)
    .lte("created_at", until)
    .order("created_at", { ascending: false })
    .limit(50_000); // safety cap; at 1k rows/day this is ~50 days of data
  if (error) {
    throw new Error(`workspace_generation_events read failed: ${error.message}`);
  }

  const rows = (data ?? []) as EventRow[];

  const totals = {
    images: 0,
    videos: 0,
    audio: 0,
    other: 0,
    grand_total: 0,
    credits_spent: 0,
  };

  // Composite keys keep the aggregation in a single pass.
  // We split by_model AND by_tier on `feature` too so the page can show
  // "videos by model" vs "images by model" in separate columns if it
  // wants to (the spec asks for a feature badge in each row).
  const modelMap = new Map<
    string,
    { model: string; feature: string; count: number; credits: number }
  >();
  const tierMap = new Map<
    string,
    { tier: string; feature: string; count: number }
  >();
  const featureMap = new Map<string, number>();

  // 30-day buckets keyed by YYYY-MM-DD (UTC). The admin-hub renders this
  // as an area chart; missing days are filled with zeros below.
  const dayMap = new Map<
    string,
    { images: number; videos: number; audio: number; other: number }
  >();

  for (const r of rows) {
    const count = Math.max(1, Number(r.output_count ?? 1));
    const credits = Number(r.credits_spent ?? 0);
    const feature = String(r.feature ?? "other");
    const model = String(r.model ?? "unknown");
    const tier = r.output_tier ?? "unknown";

    if (feature === "image") totals.images += count;
    else if (feature === "video") totals.videos += count;
    else if (feature === "audio") totals.audio += count;
    else totals.other += count;
    totals.grand_total += count;
    totals.credits_spent += Number.isFinite(credits) ? credits : 0;

    const mk = `${model}__${feature}`;
    const existing = modelMap.get(mk);
    if (existing) {
      existing.count += count;
      existing.credits += Number.isFinite(credits) ? credits : 0;
    } else {
      modelMap.set(mk, {
        model,
        feature,
        count,
        credits: Number.isFinite(credits) ? credits : 0,
      });
    }

    const tk = `${tier}__${feature}`;
    const tExisting = tierMap.get(tk);
    if (tExisting) tExisting.count += count;
    else tierMap.set(tk, { tier, feature, count });

    featureMap.set(feature, (featureMap.get(feature) ?? 0) + count);

    // Bucket the day (UTC).
    const d = new Date(r.created_at);
    if (!Number.isNaN(d.getTime())) {
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
      const day = dayMap.get(key) ?? {
        images: 0,
        videos: 0,
        audio: 0,
        other: 0,
      };
      if (feature === "image") day.images += count;
      else if (feature === "video") day.videos += count;
      else if (feature === "audio") day.audio += count;
      else day.other += count;
      dayMap.set(key, day);
    }
  }

  // Sort by count desc — that's how the page wants both tables.
  const by_model = [...modelMap.values()].sort((a, b) => b.count - a.count);
  const by_tier = [...tierMap.values()].sort((a, b) => b.count - a.count);
  const by_feature = [...featureMap.entries()]
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count);

  // Fill missing days so the chart has a contiguous x-axis.
  const timeseries: Array<{
    date: string;
    images: number;
    videos: number;
    audio: number;
    other: number;
  }> = [];
  const sinceMs = new Date(since).getTime();
  const untilMs = new Date(until).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  // Walk backwards from until → since, day-by-day. Cap at 60 entries to
  // protect the JSON response size if the operator passes a wide window.
  const days: string[] = [];
  for (
    let t = Math.floor(untilMs / dayMs) * dayMs;
    t >= sinceMs && days.length < 60;
    t -= dayMs
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  days.reverse(); // oldest → newest, chart-friendly
  for (const date of days) {
    const day = dayMap.get(date) ?? {
      images: 0,
      videos: 0,
      audio: 0,
      other: 0,
    };
    timeseries.push({ date, ...day });
  }

  return {
    range: { since, until },
    totals,
    by_model,
    by_tier,
    by_feature,
    timeseries,
  };
}

/** recent_generations — last N rows. Optionally filter by feature/model.
 *  Hard cap at 100 rows so a misbehaving client can't pull megabytes.
 *  Returns user_id only (no email) — the admin-hub joins display names
 *  client-side via its own user-lookup capability when needed. */
async function recentGenerations(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{
  rows: Array<{
    id: string;
    user_id: string | null;
    feature: string;
    model: string;
    provider: string | null;
    output_tier: string | null;
    output_count: number;
    credits_spent: number | null;
    duration_seconds: number | null;
    aspect_ratio: string | null;
    canvas_id: string | null;
    node_id: string | null;
    task_id: string | null;
    created_at: string;
  }>;
}> {
  const limitRaw = Number(body.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 100)
      : 25;
  const featureFilter =
    typeof body.feature === "string" && body.feature ? body.feature : null;
  const modelFilter =
    typeof body.model === "string" && body.model ? body.model : null;

  let q = client
    .from("workspace_generation_events")
    .select(
      "id, user_id, feature, model, provider, output_tier, output_count, credits_spent, duration_seconds, aspect_ratio, canvas_id, node_id, task_id, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (featureFilter) q = q.eq("feature", featureFilter);
  if (modelFilter) q = q.eq("model", modelFilter);

  const { data, error } = await q;
  if (error) {
    throw new Error(`workspace_generation_events read failed: ${error.message}`);
  }

  return {
    rows: (data ?? []).map((r: any) => ({
      id: String(r.id),
      user_id: r.user_id ?? null,
      feature: String(r.feature ?? ""),
      model: String(r.model ?? ""),
      provider: r.provider ?? null,
      output_tier: r.output_tier ?? null,
      output_count: Number(r.output_count ?? 1),
      credits_spent: r.credits_spent ?? null,
      duration_seconds: r.duration_seconds ?? null,
      aspect_ratio: r.aspect_ratio ?? null,
      canvas_id: r.canvas_id ?? null,
      node_id: r.node_id ?? null,
      task_id: r.task_id ?? null,
      created_at: String(r.created_at),
    })),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed — use POST" }, 405);
  }

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

  try {
    switch (action) {
      case "generation_summary":
        return json(await generationSummary(admin, body));

      case "recent_generations":
        return json(await recentGenerations(admin, body));

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("admin_workspace_analytics error:", msg);
    return json({ error: msg }, 500);
  }
});
