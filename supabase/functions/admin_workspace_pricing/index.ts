// admin_workspace_pricing — workspace-side credit-system admin reads.
//
// Purpose
// -------
// The admin-hub has two pricing pages (Subscription Builder, Pricing Manager)
// that historically only spoke to the consumer project's bridge. When the
// operator flips the top-bar target pill to "Workspace" we want those pages
// to actually read the workspace project's pricing tables instead of just
// showing a "you're on the wrong target" banner.
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
// Write actions are stubbed to return 501 Not Implemented for now. This is
// deliberate: it keeps the contract obvious to the frontend (so the page
// can disable buttons + show a clear toast) without leaving accidentally-
// usable write paths exposed during the read-only rollout. When the
// recalculation job + audit-log story is ready the stubs become real.

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

// Pull markup_* rows out of subscription_settings and shape them into the
// flat `{ image, video, chat, audio }` object the Pricing Manager UI
// expects. Storage shape is `key`/`value` text — we coerce to numbers
// here so the frontend doesn't have to know the table layout.
async function getMarkupMultipliers(
  client: SupabaseClient,
): Promise<{ data: Record<string, number> }> {
  const { data, error } = await client
    .from("subscription_settings")
    .select("key, value")
    .like("key", "markup_%");
  if (error) {
    throw new Error(`subscription_settings read failed: ${error.message}`);
  }

  // Defaults match what Pricing Manager falls back to when nothing is set.
  const out: Record<string, number> = {
    image: 4.0,
    video: 4.0,
    chat: 4.0,
    audio: 4.0,
  };
  for (const row of data ?? []) {
    const key = String((row as { key: string }).key ?? "");
    const value = (row as { value: string }).value;
    const stripped = key.replace(/^markup_/, "");
    const num = Number(value);
    if (stripped && Number.isFinite(num)) out[stripped] = num;
  }
  return { data: out };
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
      case "fetch_credit_costs":
        return json(
          await listRows(admin, "credit_costs", [
            { column: "feature", ascending: true },
            { column: "model", ascending: true },
          ]),
        );

      case "get_markup_multipliers":
        return json(await getMarkupMultipliers(admin));

      // ── Mutations (stubbed) ───────────────────────────────────────
      // These return 501 instead of running the actual write so the
      // workspace project can't be silently mutated from an admin UI
      // that hasn't yet been audited for cross-project safety. The
      // frontend short-circuits before calling these, but we reject
      // here as a defense-in-depth net.
      case "upsert_credit_cost":
      case "delete_credit_cost":
      case "set_markup_multipliers":
      case "recalculate_all_prices":
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
    console.error("admin_workspace_pricing error:", msg);
    return json({ error: msg }, 500);
  }
});
