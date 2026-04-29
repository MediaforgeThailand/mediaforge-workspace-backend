// admin_workspace_logs — workspace-side admin reads for the Generation Log
// + Retry Queue admin pages.
//
// Purpose
// -------
// The admin-hub has two log pages — Generation Log and Retry Queue — that
// historically only spoke to the consumer project's bridge. When the
// operator flips the top-bar target pill to "Workspace" we want those
// pages to actually read the workspace project's run/retry tables instead
// of showing consumer data labelled as workspace data (the bug we're
// fixing here).
//
// This function is the workspace-side equivalent of the consumer admin-api
// for the run/retry surface. It exposes the same POST { action, ...payload }
// contract as `admin_workspace_pricing` so the frontend can route via a
// single dispatcher (see useTargetAwareApi in the admin-hub repo).
//
// Auth
// ----
// `verify_jwt: false` — same reason as `admin_workspace_pricing` and
// `admin_dashboard_stats`: the admin user's JWT is signed by the admin
// project, not this workspace project. Federating admin auth across
// projects is out of scope for this wave. The function returns aggregate
// run/retry rows only — no message bodies, no user PII beyond user_id —
// so the blast radius is the run history surface, which an admin can
// already see in the consumer project.
//
// Mutations
// ---------
// The workspace product runs nodes individually (no flow-level retries
// today), so the retry queue is empty by design. All mutation actions
// (cancel_retry_job, recover_stuck_retry_jobs) are stubbed to 501. When
// node-level retries / cancellations land, the stubs become real reads
// from `provider_retry_queue` + `retry_queue_dead_letter`.

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

function clampLimit(raw: unknown, fallback = 50, max = 500): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function clampOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

// ───────────────────────────────────────────────────────────────────────
// Reads
// ───────────────────────────────────────────────────────────────────────

/**
 * Generation Log: pipeline executions + flow runs.
 *
 * The frontend's GenerationLogPage was originally built for the consumer
 * `flow_runs` table. Workspace has both `pipeline_executions` (the actual
 * source of truth for workspace generations — built around flow_run_id +
 * step_index) and a vestigial `flow_runs` table (present for schema
 * symmetry, currently unused). We expose BOTH actions:
 *
 *   - `list_flow_runs`           → pipeline_executions, mapped to the
 *                                  shape GenerationLogPage already expects
 *                                  (so the page works unchanged).
 *   - `list_pipeline_executions` → pipeline_executions, raw shape, for
 *                                  any future workspace-only UI.
 *
 * The mapping uses `created_at` as a stand-in for `started_at` (workspace
 * pipeline_executions doesn't have a separate started_at column) and
 * leaves error_classification / display_name / flow_name / duration_ms
 * blank since the workspace schema doesn't capture those today.
 */
async function listFlowRunsForGenLog(
  client: SupabaseClient,
  status: string | null,
  limit: number,
  offset: number,
): Promise<{ rows: unknown[]; total: number; limit: number; offset: number }> {
  let q = client
    .from("pipeline_executions")
    .select(
      "id, user_id, flow_id, flow_run_id, status, credits_deducted, created_at, updated_at, error_message",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq("status", status);

  const { data, error, count } = await q;
  if (error) {
    throw new Error(`pipeline_executions read failed: ${error.message}`);
  }

  const rows = (data ?? []).map((r: any) => ({
    id: r.id,
    user_id: r.user_id,
    flow_id: r.flow_id,
    status: r.status,
    credits_used: r.credits_deducted ?? null,
    started_at: r.created_at, // workspace doesn't track started_at separately
    completed_at: r.status === "completed" ? r.updated_at : null,
    duration_ms: null,
    error_message: r.error_message ?? null,
    error_classification: null,
    display_name: null,
    flow_name: null,
  }));

  return { rows, total: count ?? rows.length, limit, offset };
}

/**
 * 7-day status-bucket counts for the Generation Log KPI cards.
 *
 * Mirrors the consumer `get_flow_runs_stats` shape: { since, counts: {...} }.
 * Bucketed via plain JS over a single SELECT — pipeline_executions on
 * workspace is small enough that a full status-only scan stays sub-200ms.
 */
async function getFlowRunsStats(
  client: SupabaseClient,
): Promise<{ since: string; counts: Record<string, number> }> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("pipeline_executions")
    .select("status")
    .gte("created_at", since);
  if (error) {
    throw new Error(`pipeline_executions stats read failed: ${error.message}`);
  }
  const counts: Record<string, number> = { total: 0 };
  for (const row of data ?? []) {
    const s = String((row as { status: string }).status ?? "unknown");
    counts.total += 1;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return { since, counts };
}

/**
 * Raw pipeline_executions list — for UIs that want the native shape.
 * Returns `{ data: [...], total }` to match the spec contract.
 */
async function listPipelineExecutions(
  client: SupabaseClient,
  status: string | null,
  limit: number,
  offset: number,
): Promise<{ data: unknown[]; total: number }> {
  let q = client
    .from("pipeline_executions")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq("status", status);
  const { data, error, count } = await q;
  if (error) {
    throw new Error(`pipeline_executions read failed: ${error.message}`);
  }
  return { data: data ?? [], total: count ?? 0 };
}

/**
 * Active retry queue — mirrors the consumer `list_retry_jobs` shape:
 * `{ jobs: [...] }`. Filters by status + provider when provided.
 */
async function listRetryJobs(
  client: SupabaseClient,
  status: string | null,
  provider: string | null,
  limit: number,
): Promise<{ jobs: unknown[] }> {
  let q = client
    .from("provider_retry_queue")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  if (provider) q = q.eq("provider", provider);
  const { data, error } = await q;
  if (error) {
    throw new Error(`provider_retry_queue read failed: ${error.message}`);
  }
  return { jobs: data ?? [] };
}

/**
 * Dead-letter queue — mirrors the consumer `list_retry_dead_letters`
 * shape: `{ dead_letters: [...] }`.
 */
async function listRetryDeadLetters(
  client: SupabaseClient,
  provider: string | null,
  limit: number,
): Promise<{ dead_letters: unknown[] }> {
  let q = client
    .from("retry_queue_dead_letter")
    .select("*")
    .order("moved_at", { ascending: false })
    .limit(limit);
  if (provider) q = q.eq("provider", provider);
  const { data, error } = await q;
  if (error) {
    throw new Error(`retry_queue_dead_letter read failed: ${error.message}`);
  }
  return { dead_letters: data ?? [] };
}

/**
 * Retry queue observability — counts grouped by status + provider, plus
 * the dead-letter total and a "stuck" count (lock_expires_at in the past
 * while still pending/processing). Mirrors consumer `get_retry_observability`.
 */
async function getRetryObservability(client: SupabaseClient): Promise<{
  queue: {
    by_status: Record<string, number>;
    by_provider: Record<string, number>;
    total: number;
  };
  dead_letter_total: number;
  stuck_count: number;
}> {
  const nowIso = new Date().toISOString();

  const [queueRes, dlqRes, stuckRes] = await Promise.all([
    client.from("provider_retry_queue").select("status, provider"),
    client
      .from("retry_queue_dead_letter")
      .select("id", { count: "exact", head: true }),
    client
      .from("provider_retry_queue")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "processing"])
      .lt("lock_expires_at", nowIso),
  ]);

  if (queueRes.error) {
    throw new Error(`retry queue scan failed: ${queueRes.error.message}`);
  }
  if (dlqRes.error) {
    throw new Error(`dead-letter scan failed: ${dlqRes.error.message}`);
  }
  if (stuckRes.error) {
    throw new Error(`stuck scan failed: ${stuckRes.error.message}`);
  }

  const by_status: Record<string, number> = {};
  const by_provider: Record<string, number> = {};
  let total = 0;
  for (const row of queueRes.data ?? []) {
    const s = String((row as { status: string }).status ?? "unknown");
    const p = String((row as { provider: string }).provider ?? "unknown");
    by_status[s] = (by_status[s] ?? 0) + 1;
    by_provider[p] = (by_provider[p] ?? 0) + 1;
    total += 1;
  }
  return {
    queue: { by_status, by_provider, total },
    dead_letter_total: dlqRes.count ?? 0,
    stuck_count: stuckRes.count ?? 0,
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
      // ── Generation Log reads ──────────────────────────────────────
      case "list_flow_runs": {
        // GenerationLogPage already passes { status, limit, offset } —
        // we accept the same shape for drop-in compatibility.
        const status =
          typeof body.status === "string" && body.status ? body.status : null;
        const limit = clampLimit(body.limit, 50);
        const offset = clampOffset(body.offset);
        return json(await listFlowRunsForGenLog(admin, status, limit, offset));
      }

      case "get_flow_runs_stats":
        return json(await getFlowRunsStats(admin));

      case "list_pipeline_executions": {
        const status =
          typeof body.status_filter === "string" && body.status_filter
            ? body.status_filter
            : typeof body.status === "string" && body.status
              ? body.status
              : null;
        const limit = clampLimit(body.limit, 50);
        const offset = clampOffset(body.offset);
        return json(await listPipelineExecutions(admin, status, limit, offset));
      }

      // ── Retry Queue reads ─────────────────────────────────────────
      case "list_retry_jobs":
      case "list_retry_queue": {
        const status =
          typeof body.status === "string" && body.status ? body.status : null;
        const provider =
          typeof body.provider === "string" && body.provider
            ? body.provider
            : null;
        const limit = clampLimit(body.limit, 200);
        return json(await listRetryJobs(admin, status, provider, limit));
      }

      case "list_retry_dead_letters":
      case "list_dead_letter": {
        const provider =
          typeof body.provider === "string" && body.provider
            ? body.provider
            : null;
        const limit = clampLimit(body.limit, 200);
        return json(await listRetryDeadLetters(admin, provider, limit));
      }

      case "get_retry_observability":
        return json(await getRetryObservability(admin));

      // ── Mutations (stubbed) ───────────────────────────────────────
      // Same defense-in-depth pattern as admin_workspace_pricing: the
      // frontend short-circuits before calling these (and disables the
      // buttons), but we reject here so a stale client can't accidentally
      // mutate the workspace project.
      case "cancel_retry_job":
      case "recover_stuck_retry_jobs":
      case "retry_failed_run":
      case "mark_run_resolved":
      case "requeue_dead_letter":
        return json(
          {
            error:
              `Action "${action}" is not yet implemented for the workspace target. ` +
              `Edit via Supabase Studio or switch to the consumer (PROD) target.`,
          },
          501,
        );

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("admin_workspace_logs error:", msg);
    return json({ error: msg }, 500);
  }
});
