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
// This function aggregates over that table on demand. Four actions:
//
//   - generation_summary   { since?, until?, group_by? }
//       Totals, by-model, by-tier, timeseries (window-aware).
//   - recent_generations   { since?, until?, limit?, offset?,
//                            model?, feature? }
//       Paged window with exact count for "Showing X of Y" + Load more.
//   - top_generation_users { since?, until?, limit? }
//       Credit-weighted account leaderboard for the selected window.
//   - generation_user_detail { since?, until?, user_id, limit?, offset? }
//       Per-account summary + paged generation history.
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

interface AccountInfo {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface RecentGenerationApiRow {
  id: string;
  user_id: string | null;
  account: AccountInfo | null;
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
}

interface GenerationEventLiteRow {
  user_id: string | null;
  feature: string | null;
  model: string | null;
  output_count: number | null;
  credits_spent: number | null;
  created_at: string;
}

async function loadAccountInfo(
  client: SupabaseClient,
  rawUserIds: Array<string | null | undefined>,
): Promise<Map<string, AccountInfo>> {
  const userIds = Array.from(
    new Set(
      rawUserIds.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const accounts = new Map<string, AccountInfo>();
  for (const userId of userIds) {
    accounts.set(userId, {
      user_id: userId,
      email: null,
      display_name: null,
      avatar_url: null,
    });
  }
  if (userIds.length === 0) return accounts;

  const { data: profiles, error: profileError } = await client
    .from("profiles")
    .select("user_id, display_name, avatar_url")
    .in("user_id", userIds);

  if (profileError) {
    console.warn("admin_workspace_analytics profile lookup failed:", profileError.message);
  } else {
    for (const profile of profiles ?? []) {
      const userId = String((profile as { user_id?: unknown }).user_id ?? "");
      if (!userId) continue;
      const existing = accounts.get(userId) ?? {
        user_id: userId,
        email: null,
        display_name: null,
        avatar_url: null,
      };
      const displayName = (profile as { display_name?: unknown }).display_name;
      const avatarUrl = (profile as { avatar_url?: unknown }).avatar_url;
      existing.display_name =
        typeof displayName === "string" ? displayName : existing.display_name;
      existing.avatar_url = typeof avatarUrl === "string" ? avatarUrl : existing.avatar_url;
      accounts.set(userId, existing);
    }
  }

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const { data, error } = await client.auth.admin.getUserById(userId);
        if (error || !data.user) return;
        const existing = accounts.get(userId) ?? {
          user_id: userId,
          email: null,
          display_name: null,
          avatar_url: null,
        };
        existing.email = data.user.email ?? existing.email;
        const meta = data.user.user_metadata;
        if (!existing.display_name && meta && typeof meta === "object") {
          const fullName = (meta as Record<string, unknown>).full_name;
          const name = (meta as Record<string, unknown>).name;
          existing.display_name =
            typeof fullName === "string"
              ? fullName
              : typeof name === "string"
                ? name
                : null;
        }
        accounts.set(userId, existing);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("admin_workspace_analytics auth user lookup failed:", userId, msg);
      }
    }),
  );

  return accounts;
}

function normalizeGenerationRow(
  r: RecentGenerationRow,
  accounts: Map<string, AccountInfo>,
): RecentGenerationApiRow {
  const userId = r.user_id ?? null;
  return {
    id: String(r.id),
    user_id: userId,
    account: userId ? accounts.get(userId) ?? null : null,
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
  };
}

function boundedLimit(value: unknown, fallback: number, cap: number): number {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), cap) : fallback;
}

function offsetValue(value: unknown): number {
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

function topEntry(counts: Map<string, number>): string | null {
  let bestKey: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestKey;
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
  rows: RecentGenerationApiRow[];
  total: number;
  limit: number;
  offset: number;
}> {
  const { since, until } = resolveWindow(body.since, body.until);

  const limit = boundedLimit(body.limit, 50, 100);
  const offset = offsetValue(body.offset);

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
  const rows = (data ?? []) as RecentGenerationRow[];
  const accounts = await loadAccountInfo(client, rows.map((r) => r.user_id));

  return {
    rows: rows.map((r) => normalizeGenerationRow(r, accounts)),
    total: typeof count === "number" ? count : 0,
    limit,
    offset,
  };
}

async function topGenerationUsers(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{
  range: { since: string; until: string };
  rows: Array<{
    user_id: string;
    account: AccountInfo | null;
    total_runs: number;
    credits_spent: number;
    images: number;
    videos: number;
    audio: number;
    other: number;
    top_model: string | null;
    top_feature: string | null;
    last_generated_at: string | null;
  }>;
}> {
  const { since, until } = resolveWindow(body.since, body.until);
  const limit = boundedLimit(body.limit, 10, 50);

  const { data, error } = await client
    .from("workspace_generation_events")
    .select("user_id, feature, model, output_count, credits_spent, created_at")
    .gte("created_at", since)
    .lte("created_at", until)
    .order("created_at", { ascending: false })
    .range(0, 9999);

  if (error) {
    throw new Error(`workspace_generation_events top users failed: ${error.message}`);
  }

  type Aggregate = {
    user_id: string;
    total_runs: number;
    credits_spent: number;
    images: number;
    videos: number;
    audio: number;
    other: number;
    model_counts: Map<string, number>;
    feature_counts: Map<string, number>;
    last_generated_at: string | null;
  };

  const aggregates = new Map<string, Aggregate>();
  for (const row of (data ?? []) as GenerationEventLiteRow[]) {
    if (!row.user_id) continue;
    const feature = String(row.feature ?? "other");
    const count = Number(row.output_count ?? 1) || 1;
    const credits = Number(row.credits_spent ?? 0) || 0;
    const existing = aggregates.get(row.user_id) ?? {
      user_id: row.user_id,
      total_runs: 0,
      credits_spent: 0,
      images: 0,
      videos: 0,
      audio: 0,
      other: 0,
      model_counts: new Map<string, number>(),
      feature_counts: new Map<string, number>(),
      last_generated_at: null,
    };

    existing.total_runs += 1;
    existing.credits_spent += credits;
    if (feature === "image") existing.images += count;
    else if (feature === "video") existing.videos += count;
    else if (feature === "audio") existing.audio += count;
    else existing.other += count;

    const model = String(row.model ?? "");
    if (model) existing.model_counts.set(model, (existing.model_counts.get(model) ?? 0) + 1);
    if (feature) {
      existing.feature_counts.set(feature, (existing.feature_counts.get(feature) ?? 0) + 1);
    }
    if (
      row.created_at &&
      (!existing.last_generated_at || new Date(row.created_at) > new Date(existing.last_generated_at))
    ) {
      existing.last_generated_at = String(row.created_at);
    }
    aggregates.set(row.user_id, existing);
  }

  const topAggregates = Array.from(aggregates.values())
    .sort((a, b) => b.credits_spent - a.credits_spent || b.total_runs - a.total_runs)
    .slice(0, limit);
  const accounts = await loadAccountInfo(client, topAggregates.map((row) => row.user_id));
  const rows = topAggregates.map((row) => ({
    user_id: row.user_id,
    account: accounts.get(row.user_id) ?? null,
    total_runs: row.total_runs,
    credits_spent: row.credits_spent,
    images: row.images,
    videos: row.videos,
    audio: row.audio,
    other: row.other,
    top_model: topEntry(row.model_counts),
    top_feature: topEntry(row.feature_counts),
    last_generated_at: row.last_generated_at,
  }));

  return { range: { since, until }, rows };
}

async function generationUserDetail(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<{
  range: { since: string; until: string };
  account: AccountInfo | null;
  summary: {
    total_runs: number;
    credits_spent: number;
    images: number;
    videos: number;
    audio: number;
    other: number;
    by_model: Array<{ model: string; count: number; credits: number }>;
    by_feature: Array<{ feature: string; count: number; credits: number }>;
  };
  rows: RecentGenerationApiRow[];
  total: number;
  limit: number;
  offset: number;
}> {
  const { since, until } = resolveWindow(body.since, body.until);
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  if (!userId) throw new Error("Missing user_id");

  const limit = boundedLimit(body.limit, 25, 100);
  const offset = offsetValue(body.offset);

  const baseSelect =
    "id, user_id, feature, model, provider, output_tier, output_count, credits_spent, duration_seconds, aspect_ratio, canvas_id, node_id, task_id, params, created_at";

  const { data, error, count } = await client
    .from("workspace_generation_events")
    .select(baseSelect, { count: "exact" })
    .eq("user_id", userId)
    .gte("created_at", since)
    .lte("created_at", until)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`workspace_generation_events user detail failed: ${error.message}`);
  }

  const { data: summaryRows, error: summaryError } = await client
    .from("workspace_generation_events")
    .select("user_id, feature, model, output_count, credits_spent, created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .lte("created_at", until)
    .range(0, 9999);

  if (summaryError) {
    throw new Error(`workspace_generation_events user summary failed: ${summaryError.message}`);
  }

  const byModel = new Map<string, { model: string; count: number; credits: number }>();
  const byFeature = new Map<string, { feature: string; count: number; credits: number }>();
  const summary = {
    total_runs: 0,
    credits_spent: 0,
    images: 0,
    videos: 0,
    audio: 0,
    other: 0,
    by_model: [] as Array<{ model: string; count: number; credits: number }>,
    by_feature: [] as Array<{ feature: string; count: number; credits: number }>,
  };

  for (const row of (summaryRows ?? []) as GenerationEventLiteRow[]) {
    const feature = String(row.feature ?? "other");
    const model = String(row.model ?? "unknown");
    const outputCount = Number(row.output_count ?? 1) || 1;
    const credits = Number(row.credits_spent ?? 0) || 0;

    summary.total_runs += 1;
    summary.credits_spent += credits;
    if (feature === "image") summary.images += outputCount;
    else if (feature === "video") summary.videos += outputCount;
    else if (feature === "audio") summary.audio += outputCount;
    else summary.other += outputCount;

    const modelRow = byModel.get(model) ?? { model, count: 0, credits: 0 };
    modelRow.count += 1;
    modelRow.credits += credits;
    byModel.set(model, modelRow);

    const featureRow = byFeature.get(feature) ?? { feature, count: 0, credits: 0 };
    featureRow.count += 1;
    featureRow.credits += credits;
    byFeature.set(feature, featureRow);
  }

  summary.by_model = Array.from(byModel.values()).sort(
    (a, b) => b.credits - a.credits || b.count - a.count,
  );
  summary.by_feature = Array.from(byFeature.values()).sort(
    (a, b) => b.credits - a.credits || b.count - a.count,
  );

  const accounts = await loadAccountInfo(client, [userId]);
  const account = accounts.get(userId) ?? null;
  const rows = ((data ?? []) as RecentGenerationRow[]).map((r) =>
    normalizeGenerationRow(r, accounts),
  );

  return {
    range: { since, until },
    account,
    summary,
    rows,
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

      case "top_generation_users":
        return json(await topGenerationUsers(admin, body));

      case "generation_user_detail":
        return json(await generationUserDetail(admin, body));

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("admin_workspace_analytics error:", msg);
    return json({ error: msg }, 500);
  }
});
