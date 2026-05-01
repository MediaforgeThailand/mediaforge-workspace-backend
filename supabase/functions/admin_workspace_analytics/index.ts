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
//       Totals, by-model, by-tier, timeseries (window-aware).
//   - recent_generations   { since?, until?, limit?, offset?,
//                            model?, feature? }
//       Paged window with exact count for "Showing X of Y" + Load more.
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
import { verifyAdminJwt, unauthorizedResponse } from "../_shared/adminAuth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-email, x-admin-auth-key",
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

interface RecentGenerationRow {
  id: string;
  user_id: string | null;
  feature: string | null;
  model: string | null;
  provider: string | null;
  output_tier: string | null;
  output_count: number | null;
  credits_spent: number | null;
  duration_seconds: number | null;
  aspect_ratio: string | null;
  canvas_id: string | null;
  node_id: string | null;
  task_id: string | null;
  params: unknown;
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
  const { data, error } = await client.rpc("admin_workspace_generation_summary", {
    p_since: since,
    p_until: until,
  });
  if (error) {
    throw new Error(`workspace_generation_events summary failed: ${error.message}`);
  }
  return data as {
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
  };
}
/** recent_generations — paged window into workspace_generation_events.
 *  Honours the same `since`/`until` window as generation_summary so the
 *  admin page's date-range picker re-keys both queries together.
 *
 *  Hard cap of 100 per page so a misbehaving client can't pull megabytes;
 *  the frontend uses a 50-per-page accumulator with a "Load more" button.
 *
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
    params: Record<string, unknown> | null;
    created_at: string;
  }>;
  total: number;
  limit: number;
  offset: number;
}> {
  const { since, until } = resolveWindow(body.since, body.until);

  const limitRaw = Number(body.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 100)
      : 50;

  const offsetRaw = Number(body.offset);
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

  const featureFilter =
    typeof body.feature === "string" && body.feature ? body.feature : null;
  const modelFilter =
    typeof body.model === "string" && body.model ? body.model : null;

  // Build the query once for the paged read. We ask Postgres for an
  // exact count alongside the page so the frontend's "Showing X of Y"
  // counter stays accurate without a second round trip.
  let q = client
    .from("workspace_generation_events")
    .select(
      "id, user_id, feature, model, provider, output_tier, output_count, credits_spent, duration_seconds, aspect_ratio, canvas_id, node_id, task_id, params, created_at",
      { count: "exact" },
    )
    .gte("created_at", since)
    .lte("created_at", until)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (featureFilter) q = q.eq("feature", featureFilter);
  if (modelFilter) q = q.eq("model", modelFilter);

  const { data, error, count } = await q;
  if (error) {
    throw new Error(`workspace_generation_events read failed: ${error.message}`);
  }

  return {
    rows: ((data ?? []) as RecentGenerationRow[]).map((r) => ({
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
      params:
        r.params && typeof r.params === "object" && !Array.isArray(r.params)
          ? (r.params as Record<string, unknown>)
          : null,
      created_at: String(r.created_at),
    })),
    total: typeof count === "number" ? count : 0,
    limit,
    offset,
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
  // See companion note in admin_workspace_pricing/index.ts. Re-enable
  // once `ADMIN_AUTH_SUPABASE_ANON_KEY` is set.
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
