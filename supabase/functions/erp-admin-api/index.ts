import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

// ── Bridge helper ──────────────────────────────────────────────
const BRIDGE_URL = Deno.env.get("MAIN_BRIDGE_URL") ?? "";
if (!BRIDGE_URL) throw new Error("MAIN_BRIDGE_URL is not configured");

// ── ERP-bridge helper (Main project's runtime-overrides endpoint) ──
// Different erp-bridge versions have used slightly different auth/body contracts,
// so this helper sends a compatibility payload that supports both styles.
const ERP_BRIDGE_URL = (() => {
  // Allow explicit override; otherwise derive from MAIN_BRIDGE_URL
  const explicit = Deno.env.get("ERP_BRIDGE_URL");
  if (explicit) return explicit;
  try {
    const u = new URL(BRIDGE_URL);
    // Replace the function path with /functions/v1/erp-bridge
    u.pathname = "/functions/v1/erp-bridge";
    return u.toString();
  } catch {
    return "";
  }
})();

async function callErpBridge(action: string, params?: Record<string, unknown>) {
  if (!ERP_BRIDGE_URL) throw new Error("ERP_BRIDGE_URL could not be derived");
  const secret = Deno.env.get("ERP_BRIDGE_SECRET");
  if (!secret) throw new Error("ERP_BRIDGE_SECRET not configured");
  const payload = params ?? {};

  console.log(`[callErpBridge:${action}] POST ${ERP_BRIDGE_URL}`);

  const res = await fetch(ERP_BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "x-erp-secret": secret,
    },
    body: JSON.stringify({ action, secret, payload, ...payload }),
  });

  const rawText = await res.text();
  let data: any = null;
  try { data = rawText ? JSON.parse(rawText) : null; } catch (_) { /* non-JSON */ }

  console.log(`[callErpBridge:${action}] status=${res.status} body=${rawText.slice(0, 500)}`);

  if (!res.ok) {
    const msg =
      (typeof data?.error === "string" && data.error) ||
      (typeof data?.message === "string" && data.message) ||
      `erp-bridge HTTP ${res.status}: ${rawText.slice(0, 200)}`.trim();
    throw new Error(msg);
  }
  if (data?.ok === false || data?.success === false) {
    const msg = (typeof data?.error === "string" && data.error) || `erp-bridge failure: ${rawText.slice(0, 200)}`;
    throw new Error(msg);
  }
  return data;
}

// ── flows-bridge helper (Main project's Active Flows endpoint) ──
// Auth pattern: shared-secret (matches erp-bridge / erp-affiliate-bridge).
// ERP verifies role locally, then forwards to MAIN with:
//   Authorization: Bearer <ERP_BRIDGE_SECRET>
//   X-Actor-Id:    <erp user uuid>
//   X-Actor-Role:  admin | sales
const FLOWS_BRIDGE_URL = (() => {
  const explicit = Deno.env.get("FLOWS_BRIDGE_URL");
  if (explicit) return explicit;
  try {
    const u = new URL(BRIDGE_URL);
    u.pathname = "/functions/v1/flows-bridge";
    return u.toString();
  } catch {
    return "";
  }
})();

async function callFlowsBridge(
  action: string,
  params: Record<string, unknown> | undefined,
  actor: { sub: string; role: string },
) {
  if (!FLOWS_BRIDGE_URL) throw new Error("FLOWS_BRIDGE_URL could not be derived");
  const secret = Deno.env.get("ERP_BRIDGE_SECRET");
  if (!secret) throw new Error("ERP_BRIDGE_SECRET not configured");

  const res = await fetch(FLOWS_BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "X-Actor-Id": actor.sub,
      "X-Actor-Role": actor.role,
    },
    body: JSON.stringify({ action, params: params ?? {} }),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const msg =
      (typeof data?.error === "string" && data.error) ||
      (typeof data?.message === "string" && data.message) ||
      `flows-bridge HTTP ${res.status}: ${text.slice(0, 200)}`;
    throw new Error(msg);
  }
  return data;
}

async function callBridge(action: string, payload?: Record<string, unknown>) {
  const secret = Deno.env.get("ERP_BRIDGE_SECRET");
  if (!secret) throw new Error("ERP_BRIDGE_SECRET not configured");

  // Bridge contract: secret goes in the BODY (not headers).
  const res = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, secret, payload: payload ?? {} }),
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch (_) {
    // bridge returned non-JSON
  }

  const stringifyErr = (e: unknown): string => {
    if (e == null) return "";
    if (typeof e === "string") return e;
    if (typeof e === "object") {
      const o = e as Record<string, unknown>;
      if (typeof o.message === "string") return o.message;
      if (typeof o.error === "string") return o.error;
      if (typeof o.detail === "string") return o.detail;
      if (typeof o.hint === "string") return o.hint;
      try { return JSON.stringify(e); } catch { return String(e); }
    }
    return String(e);
  };

  if (!res.ok) {
    const msg =
      stringifyErr(data?.error) ||
      stringifyErr(data?.message) ||
      `Bridge HTTP ${res.status} ${res.statusText || ""}`.trim();
    console.error(`[callBridge:${action}] HTTP ${res.status}`, JSON.stringify(data));
    throw new Error(msg);
  }
  if (data?.ok === false || data?.success === false) {
    const msg = stringifyErr(data?.error) || stringifyErr(data?.message) || "Bridge returned failure flag";
    console.error(`[callBridge:${action}] body failure`, JSON.stringify(data));
    throw new Error(msg);
  }
  return data;
}

async function callBridgeWithFallback(
  actions: string[],
  payload?: Record<string, unknown>,
) {
  let lastError: Error | null = null;

  for (const action of actions) {
    try {
      return await callBridge(action, payload);
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const message = lastError.message || "";
      const isUnknownAction = message.includes("Unknown action:");
      if (!isUnknownAction || action === actions[actions.length - 1]) {
        throw lastError;
      }
      console.warn(
        `[admin-api] Bridge action '${action}' unavailable, retrying fallback`,
      );
    }
  }

  throw lastError ?? new Error("Bridge call failed");
}

function buildCompactReviewPayload(
  params: Record<string, unknown> | undefined,
  adminUser: { sub: string; email: string },
) {
  const totalScore = calculateReviewTotal(params);

  // Only forward api_cost when caller provided a real positive number.
  // Sending 0 (or null) would force MAIN to recompute selling_price as 0.
  // When omitted, MAIN keeps the existing flow.api_cost / per-node pricing.
  const rawApiCost = Number(params?.api_cost);
  // selling_price (optional): if ERP supplies it, MAIN will use it as the
  // final price and back-calculate margin/payout. Only forward positive numbers.
  const rawSellingPrice = Number(params?.selling_price);
  const payload: Record<string, unknown> = {
    flow_id: params?.flow_id,
    decision: params?.decision,
    reviewer_notes: params?.reviewer_notes ?? null,
    total_score: totalScore,
    reviewer_id: adminUser.sub,
    admin_user_email: adminUser.email,
  };
  if (Number.isFinite(rawApiCost) && rawApiCost > 0) {
    payload.api_cost = rawApiCost;
  }
  if (Number.isFinite(rawSellingPrice) && rawSellingPrice > 0) {
    payload.selling_price = rawSellingPrice;
  }
  return payload;
}

function calculateReviewTotal(params: Record<string, unknown> | undefined) {
  return Number(params?.output_quality ?? 0) +
    Number(params?.consistency ?? 0) +
    Number(params?.commercial_usability ?? 0) +
    Number(params?.originality ?? 0) +
    Number(params?.efficiency ?? 0) +
    Number(params?.workflow_clarity ?? 0) +
    Number(params?.safety ?? 0);
}

function buildReviewPayloadVariants(
  params: Record<string, unknown> | undefined,
  adminUser: { sub: string; email: string },
) {
  const basePayload = params ?? {};
  const compactPayload = buildCompactReviewPayload(params, adminUser);

  return [
    {
      label: "full_with_reviewer_id",
      payload: {
        ...basePayload,
        reviewer_id: adminUser.sub,
        admin_id: adminUser.sub,
        admin_user_email: adminUser.email,
      },
    },
    {
      label: "full_email_only",
      payload: {
        ...basePayload,
        admin_user_email: adminUser.email,
      },
    },
    {
      label: "compact_with_reviewer_id",
      payload: {
        ...compactPayload,
        admin_id: adminUser.sub,
      },
    },
    {
      label: "compact_email_only",
      payload: (() => {
        const p: Record<string, unknown> = {
          flow_id: compactPayload.flow_id,
          decision: compactPayload.decision,
          reviewer_notes: compactPayload.reviewer_notes,
          total_score: compactPayload.total_score,
          admin_user_email: compactPayload.admin_user_email,
        };
        if (compactPayload.api_cost !== undefined) p.api_cost = compactPayload.api_cost;
        if (compactPayload.selling_price !== undefined) p.selling_price = compactPayload.selling_price;
        return p;
      })(),
    },
  ];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Auth: verify ERP Supabase session + check user_roles (local DB) ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResp(401, { error: "Unauthorized" });
    }

    const erpAnon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const {
      data: { user: erpUser },
      error: authError,
    } = await erpAnon.auth.getUser();
    if (authError || !erpUser) {
      return jsonResp(401, { error: "Invalid session" });
    }

    // user_roles lives in local ERP DB — this is the ONLY local query
    const erpAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: roleRow } = await erpAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", erpUser.id)
      .maybeSingle();

    const { action, params } = await req.json();
    const role = roleRow?.role ?? null;
    const CREATOR_ALLOWED_ACTIONS = new Set([
      "list_review_queue",
      "get_review_queue",
      "get_flow_for_review",
      "get_flow_detail",
      "submit_review",
      "bulk_review",
      "list_active_flows",
      "get_flow_markup_override",
      "list_flow_badges",
    ]);

    if (!role) {
      return jsonResp(403, { error: "Insufficient permissions" });
    }

    if (role === "creator") {
      if (!CREATOR_ALLOWED_ACTIONS.has(action)) {
        return jsonResp(403, { error: "Insufficient permissions for this action" });
      }
    } else if (!["admin", "sales"].includes(role)) {
      return jsonResp(403, { error: "Insufficient permissions" });
    }

    const adminUser = {
      sub: erpUser.id,
      email: erpUser.email ?? "",
      role,
    };

    // ── ALL actions routed through bridge to Main DB ──
    switch (action) {
      // ── Dashboard ──
      case "dashboard_stats": {
        try {
          const result = await callBridge("dashboard_stats");
          const d = result.data ?? result;
          // Map bridge field names to what the frontend expects
          return jsonResp(200, {
            ...d,
            users: d.total_users ?? d.users ?? 0,
            plans: d.total_active_plans ?? d.plans ?? 0,
            demoLinks: d.total_demo_links ?? d.demoLinks ?? 0,
            logs: d.total_audit_logs ?? d.logs ?? 0,
            codes: d.total_redemption_codes ?? d.codes ?? 0,
          });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge dashboard_stats error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Users ──
      case "list_users": {
        try {
          const result = await callBridge("list_users");
          return jsonResp(200, { data: result.data ?? [] });
        } catch (err: any) {
          console.error("[admin-api] Bridge list_users error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Credits ──
      case "grant_credits": {
        try {
          const result = await callBridge("grant_credits", params);
          return jsonResp(200, { success: true, ...result.data });
        } catch (err: any) {
          console.error("[admin-api] Bridge grant_credits error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Subscription Plans ──
      case "list_plans": {
        try {
          const result = await callBridge("list_plans");
          return jsonResp(200, { data: result.data ?? [] });
        } catch (err: any) {
          console.error("[admin-api] Bridge list_plans error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Redemption Codes ──
      case "list_codes": {
        try {
          const result = await callBridge("list_redemption_codes");
          return jsonResp(200, { data: result.data ?? [] });
        } catch (err: any) {
          console.error("[admin-api] Bridge list_codes error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      case "insert_code": {
        try {
          const result = await callBridge("insert_redemption_code", params);
          return jsonResp(200, { data: result.data });
        } catch (err: any) {
          console.error("[admin-api] Bridge insert_code error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Demo Links ──
      case "list_demo_links": {
        try {
          const result = await callBridge("list_demo_links");
          return jsonResp(200, { data: result.data ?? [] });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge list_demo_links error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      case "create_demo_link": {
        try {
          const result = await callBridge("insert_demo_link", params);
          return jsonResp(200, { data: result.data });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge create_demo_link error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      case "update_demo_link": {
        try {
          const result = await callBridge("update_demo_link", params);
          return jsonResp(200, { data: result.data });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge update_demo_link error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Demo Budget ──
      case "list_demo_budget": {
        try {
          const result = await callBridge("get_demo_budget", params);
          return jsonResp(200, { data: result.data });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge get_demo_budget error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      case "count_demo_links_today": {
        try {
          const result = await callBridge("count_demo_links_today", params);
          return jsonResp(200, { count: result.data ?? 0 });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge count_demo_links_today error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      case "upsert_demo_budget": {
        try {
          await callBridge("upsert_demo_budget", params);
          return jsonResp(200, { success: true });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge upsert_demo_budget error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Credit Costs (PURE PROXY — passthrough Main Bridge response) ──
      case "list_credit_costs":
      case "fetch_credit_costs": {
        try {
          const result = await callBridgeWithFallback([
            "list_credit_costs",
            "fetch_credit_costs",
          ]);
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] Bridge fetch_credit_costs error:", err.message);
          return jsonResp(502, { ok: false, error: err.message });
        }
      }

      case "upsert_credit_cost": {
        try {
          const result = await callBridge("upsert_credit_cost", {
            ...(params ?? {}),
            admin_email: adminUser.email,
            admin_id: adminUser.sub,
          });
          // Fire-and-forget ERP audit log — must NOT mask bridge response
          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: params?.id ? "update_credit_cost" : "create_credit_cost",
            target_email: null,
            details: {
              feature: params?.feature,
              model: params?.model,
              label: params?.label,
              cost: params?.cost,
              pricing_type: params?.pricing_type,
              duration_seconds: params?.duration_seconds,
              has_audio: params?.has_audio,
              id: params?.id,
            },
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit log (upsert_credit_cost) failed:", error.message);
          });
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] Bridge upsert_credit_cost error:", err.message);
          return jsonResp(502, { ok: false, error: err.message });
        }
      }

      case "delete_credit_cost": {
        try {
          const result = await callBridge("delete_credit_cost", {
            ...(params ?? {}),
            admin_email: adminUser.email,
            admin_id: adminUser.sub,
          });
          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: "delete_credit_cost",
            target_email: null,
            details: { id: params?.id },
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit log (delete_credit_cost) failed:", error.message);
          });
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] Bridge delete_credit_cost error:", err.message);
          return jsonResp(502, { ok: false, error: err.message });
        }
      }

      // ── Markup Multipliers (PURE PROXY) ──
      case "get_multipliers":
      case "get_markup_multipliers": {
        try {
          const result = await callBridgeWithFallback([
            "get_multipliers",
            "get_markup_multipliers",
          ]);
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] Bridge get_markup_multipliers error:", err.message);
          return jsonResp(502, { ok: false, error: err.message });
        }
      }

      // ── Recalculate all flow prices (PURE PROXY) ──
      case "recalculate_all_prices": {
        try {
          const result = await callBridge("recalculate_all_prices", {
            ...(params ?? {}),
            admin_user_email: adminUser.email,
            admin_id: adminUser.sub,
          });
          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: "recalculate_all_prices",
            target_email: null,
            details: result?.data ?? {},
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit log (recalculate_all_prices) failed:", error.message);
          });
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] Bridge recalculate_all_prices error:", err.message);
          return jsonResp(502, { ok: false, error: err.message });
        }
      }

      case "update_multipliers":
      case "set_markup_multipliers": {
        try {
          const result = await callBridgeWithFallback([
            "update_multipliers",
            "set_markup_multipliers",
          ], {
            ...(params ?? {}),
            admin_email: adminUser.email,
            admin_id: adminUser.sub,
          });
          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: "update_markup_multipliers",
            target_email: null,
            details: params ?? {},
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit log (update_multipliers) failed:", error.message);
          });
          // Pure passthrough — no hardcoded success wrapper
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] Bridge set_markup_multipliers error:", err.message);
          return jsonResp(502, { ok: false, error: err.message });
        }
      }

      // ── User Deep Dive (history) ──
      case "user_deep_dive":
      case "get_user_history": {
        try {
          const result = await callBridge("get_user_history", params);
          return jsonResp(200, result.data ?? result);
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge get_user_history error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Admin manage user (official / banned flags) ──
      case "admin_manage_user": {
        try {
          const result = await callBridge("admin_manage_user", {
            ...(params ?? {}),
            admin_user_email: adminUser.email,
          });
          await erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: "admin_manage_user",
            target_email: params?.target_email ?? null,
            details: {
              user_id: params?.user_id,
              is_official: params?.is_official,
              banned: params?.banned,
            },
          });
          return jsonResp(200, result.data ?? result);
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge admin_manage_user error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Audit Logs ──
      // If a specific `action` filter is supplied, read from the LOCAL ERP
      // admin_audit_logs table (where ERP-side mirrors land — including the new
      // set_nano_banana_tier_override / set_flow_markup_override entries).
      // Otherwise fall back to Main bridge for the consolidated history.
      case "list_audit_logs": {
        try {
          const filterAction = (params as any)?.action as string | undefined;
          const limit = Math.min(Number((params as any)?.limit ?? 50), 200);

          if (filterAction) {
            const { data, error } = await erpAdmin
              .from("admin_audit_logs")
              .select("*")
              .eq("action", filterAction)
              .order("created_at", { ascending: false })
              .limit(limit);
            if (error) throw error;
            // Normalize shape: page expects { id, action, details, created_at }
            const normalized = (data ?? []).map((r: any) => ({
              id: r.id,
              action: r.action ?? r.action_type,
              target_table: r.target_table ?? null,
              details: r.details ?? {},
              created_at: r.created_at,
            }));
            return jsonResp(200, { data: normalized });
          }

          const result = await callBridge("list_audit_logs");
          return jsonResp(200, { data: result.data ?? [] });
        } catch (err: any) {
          console.error(
            "[admin-api] list_audit_logs error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Flow Approval: Review Queue ──
      case "list_review_queue":
      case "get_review_queue": {
        try {
          // Normalize filter params for the Main bridge.
          // status: "pending_all" → ["submitted","in_review"]; "all" → null (no filter)
          const p = (params ?? {}) as Record<string, unknown>;
          const statusRaw = typeof p.status === "string" ? p.status : "pending_all";
          let statusFilter: string[] | null;
          if (statusRaw === "pending_all") {
            statusFilter = ["submitted", "in_review"];
          } else if (statusRaw === "all") {
            statusFilter = null;
          } else {
            statusFilter = [statusRaw];
          }
          const tierFilter = typeof p.tier === "string" && p.tier ? p.tier : null;
          const includePublished = Boolean(p.include_published);

          const bridgePayload: Record<string, unknown> = {
            ...p,
            status: statusFilter,
            tier: tierFilter,
            include_published: includePublished,
          };

          const result = await callBridgeWithFallback(
            ["get_review_queue", "list_review_queue", "list_pending_flows"],
            bridgePayload,
          );
          // Client-side safety net: support every common bridge envelope, then filter again
          // in case the Main bridge ignores params.
          const payload = result?.data ?? result;
          let rows: any[] = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.flows)
              ? payload.flows
              : Array.isArray(payload?.rows)
                ? payload.rows
                : Array.isArray(payload?.items)
                  ? payload.items
                  : [];
          if (statusFilter) {
            const allowed = new Set(statusFilter);
            rows = rows.filter((r) => !r?.status || allowed.has(r.status));
          }
          if (tierFilter) {
            rows = rows.filter((r) => (r?.tier ?? null) === tierFilter);
          }
          return jsonResp(200, { data: rows });
        } catch (err: any) {
          console.error("[admin-api] Bridge list_review_queue error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Flow Approval: Bulk Review ──
      case "bulk_review": {
        try {
          const p = (params ?? {}) as Record<string, unknown>;
          const flowIds = Array.isArray(p.flow_ids) ? (p.flow_ids as string[]).filter((x) => typeof x === "string") : [];
          const decision = typeof p.decision === "string" ? p.decision : "";
          const reviewerNotes = typeof p.reviewer_notes === "string" ? p.reviewer_notes : null;
          const ALLOWED_DECISIONS = ["approved", "rejected", "changes_requested"];
          if (!ALLOWED_DECISIONS.includes(decision)) {
            return jsonResp(400, { error: `decision must be one of: ${ALLOWED_DECISIONS.join(", ")}` });
          }
          if (flowIds.length === 0) {
            return jsonResp(400, { error: "flow_ids must be a non-empty array" });
          }

          // Resolve Main reviewer_id once (same logic as submit_review)
          let mainReviewerId: string | null = null;
          for (const lookupAction of ["lookup_admin_by_email", "get_admin_by_email", "resolve_admin_id"]) {
            try {
              const lookup = await callBridge(lookupAction, { email: adminUser.email });
              const candidate = lookup?.data?.id ?? lookup?.data?.admin_id ?? lookup?.id ?? lookup?.admin_id;
              if (candidate && typeof candidate === "string") {
                mainReviewerId = candidate;
                break;
              }
            } catch (err: any) {
              const msg = String(err?.message ?? "");
              if (!msg.includes("Unknown action")) {
                console.warn(`[admin-api] bulk_review lookup ${lookupAction} error:`, msg);
              }
            }
          }
          const reviewerId = mainReviewerId ?? adminUser.sub;

          const results: Array<{ flow_id: string; ok: boolean; error?: string }> = [];
          for (const flowId of flowIds) {
            const variants = buildReviewPayloadVariants(
              { flow_id: flowId, decision, reviewer_notes: reviewerNotes },
              { sub: reviewerId, email: adminUser.email },
            );
            let ok = false;
            let lastErr: string | null = null;
            for (const variant of variants) {
              try {
                await callBridge("submit_review", variant.payload);
                ok = true;
                break;
              } catch (err: any) {
                lastErr = err?.message ?? String(err);
              }
            }
            results.push(ok ? { flow_id: flowId, ok: true } : { flow_id: flowId, ok: false, error: lastErr ?? "unknown" });
          }

          const successCount = results.filter((r) => r.ok).length;

          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: `bulk_review_${decision}`,
            target_email: null,
            details: { decision, count: successCount, total: flowIds.length, flow_ids: flowIds, results },
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit (bulk_review) failed:", error.message);
          });

          return jsonResp(200, { count: successCount, total: flowIds.length, results });
        } catch (err: any) {
          console.error("[admin-api] bulk_review error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Flow Approval: Single Flow Detail ──
      case "get_flow_for_review":
      case "get_flow_detail": {
        try {
          const result = await callBridgeWithFallback(
            ["get_flow_for_review", "get_flow_detail"],
            params,
          );
          return jsonResp(200, result.data ?? result);
        } catch (err: any) {
          console.error("[admin-api] Bridge get_flow_detail error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Flow Approval: Submit Review ──
      case "submit_review": {
        try {
          // Step 1: Try to resolve the Main admin_accounts.id by email.
          // The Main bridge requires a valid reviewer_id (FK -> admin_accounts.id).
          // The ERP user UUID is NOT valid on Main, so we MUST look it up.
          let mainReviewerId: string | null = null;
          const lookupActions = ["lookup_admin_by_email", "get_admin_by_email", "resolve_admin_id"];
          for (const lookupAction of lookupActions) {
            try {
              const lookup = await callBridge(lookupAction, { email: adminUser.email });
              const candidate = lookup?.data?.id ?? lookup?.data?.admin_id ?? lookup?.id ?? lookup?.admin_id;
              if (candidate && typeof candidate === "string") {
                mainReviewerId = candidate;
                console.log(`[admin-api] resolved main reviewer_id via ${lookupAction}: ${mainReviewerId}`);
                break;
              }
            } catch (err: any) {
              const msg = String(err?.message ?? "");
              if (!msg.includes("Unknown action")) {
                console.warn(`[admin-api] ${lookupAction} returned error:`, msg);
              }
            }
          }

          // Step 2: Build payload using the resolved Main admin id (fallback to ERP id only if lookup failed).
          const effectiveAdmin = {
            sub: mainReviewerId ?? adminUser.sub,
            email: adminUser.email,
          };
          const variants = buildReviewPayloadVariants(params, effectiveAdmin);
          let result;
          let lastError: Error | null = null;

          for (const variant of variants) {
            try {
              result = await callBridge("submit_review", variant.payload);
              console.log(`[admin-api] submit_review succeeded with ${variant.label}`);
              break;
            } catch (err: any) {
              lastError = err instanceof Error ? err : new Error(String(err));
              console.warn(`[admin-api] submit_review failed with ${variant.label}: ${lastError.message}`);
            }
          }

          if (!result) {
            const baseMsg = lastError?.message ?? "submit_review failed";
            const enriched = mainReviewerId
              ? baseMsg
              : `${baseMsg} — could not resolve Main admin_accounts.id for email ${adminUser.email}. The Main bridge needs a 'lookup_admin_by_email' action, or the admin email must exist in admin_accounts.`;
            throw new Error(enriched);
          }

          await erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: `flow_review_${params?.decision ?? "unknown"}`,
            target_email: null,
            details: {
              flow_id: params?.flow_id,
              decision: params?.decision,
              total_score: calculateReviewTotal(params),
            },
          });
          return jsonResp(200, result.data ?? result);
        } catch (err: any) {
          const raw = String(err?.message ?? "");
          const opaque = raw.includes("[object Object]");
          const message = opaque
            ? "Main bridge rejected every review payload variant but did not return a readable error. This is now most likely a Main bridge/database issue such as reviewer_id mapping or missing flow_reviews columns, not a single ERP payload shape problem."
            : raw;
          console.error("[admin-api] Bridge submit_review error:", message);
          return jsonResp(502, {
            error: message,
            diagnostics: {
              opaque_bridge_error: opaque,
              attempted_payload_keys: buildReviewPayloadVariants(params, adminUser).map((variant) => ({
                label: variant.label,
                keys: Object.keys(variant.payload),
              })),
              hint: opaque
                ? "bridge returned ok:false with stringified object for all fallback payloads — fix Main bridge error serialization or reviewer mapping"
                : undefined,
            },
          });
        }
      }

      case "insert_audit_log": {
        try {
          await callBridge("insert_audit_log", {
            admin_email: adminUser.email,
            action_type: params?.action || "unknown",
            target_email: params?.target_email || null,
            details: params?.details || {},
          });
          return jsonResp(200, { success: true });
        } catch (err: any) {
          console.error(
            "[admin-api] Bridge insert_audit_log error:",
            err.message,
          );
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Runtime overrides (Main project's erp-bridge) ──
      case "get_flow_markup_override": {
        try {
          const result = await callErpBridge("get_flow_markup_override", params);
          const flowId = (params as any)?.flow_id;
          let computed: any = null;
          if (flowId) {
            try {
              const queueResult = await callBridgeWithFallback(
                ["get_review_queue", "list_review_queue", "list_pending_flows"],
                { flow_id: flowId, status: null, include_published: true },
              );
              const payload = queueResult?.data ?? queueResult;
              const rows = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.flows)
                  ? payload.flows
                  : Array.isArray(payload?.rows)
                    ? payload.rows
                    : Array.isArray(payload?.items)
                      ? payload.items
                      : [];
              computed = rows.find((row: any) => row?.id === flowId || row?.flow_id === flowId) ?? rows[0] ?? null;
            } catch (pricingErr: any) {
              console.warn("[admin-api] get_flow_markup_override pricing enrichment skipped:", pricingErr?.message ?? pricingErr);
            }
          }
          const base = result?.data ?? result ?? {};
          const live = computed ?? {};

          return jsonResp(200, {
            ...result,
            data: {
              ...base,
              ...live,
              default_markup_multiplier: base?.markup_multiplier ?? null,
              computed_markup_multiplier: live?.markup_multiplier ?? null,
              computed_selling_price: live?.selling_price ?? null,
              computed_api_cost: live?.api_cost ?? null,
            },
          });
        } catch (err: any) {
          console.error("[admin-api] erp-bridge get_flow_markup_override error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      case "set_flow_markup_override": {
        try {
          const rawOverride = (params as any)?.override;
          const overrideNumber = Number(rawOverride);
          const rawSellingPrice = Number((params as any)?.selling_price);
          const bridgePayload: Record<string, unknown> = {
            flow_id: (params as any)?.flow_id,
            actor_email: (params as any)?.actor_email ?? adminUser.email,
            reason: (params as any)?.reason ?? null,
          };

          // Prefer explicit selling_price for MAIN. Do not also send numeric override,
          // otherwise older MAIN logic may recompute from api_cost and zero the price.
          if (Number.isFinite(rawSellingPrice) && rawSellingPrice > 0) {
            bridgePayload.selling_price = rawSellingPrice;
          } else if (rawOverride === null) {
            bridgePayload.override = null;
          } else if (Number.isFinite(overrideNumber) && overrideNumber > 0) {
            bridgePayload.override = overrideNumber;
          }

          console.log("[admin-api] set_flow_markup_override payload", JSON.stringify(bridgePayload));

          const result = await callErpBridge("set_flow_markup_override", bridgePayload);
          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: "set_flow_markup_override",
            target_email: null,
            details: bridgePayload,
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit (set_flow_markup_override) failed:", error.message);
          });
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] erp-bridge set_flow_markup_override error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      case "get_nano_banana_tier_override": {
        try {
          const result = await callErpBridge("get_nano_banana_tier_override", params);
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] erp-bridge get_nano_banana_tier_override error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      case "set_nano_banana_tier_override": {
        try {
          const p = (params ?? {}) as Record<string, unknown>;
          const tierRaw = (p.tier_override ?? p.value) as string | undefined;
          const tier = typeof tierRaw === "string" ? tierRaw.trim().toLowerCase() : "";
          const ALLOWED = ["auto", "force_standard", "force_flex"];
          if (!ALLOWED.includes(tier)) {
            return jsonResp(400, { error: "tier_override must be one of: auto, force_standard, force_flex (received: " + JSON.stringify(tierRaw) + ")" });
          }
          const actorEmail = (p.actor_email as string | undefined) ?? adminUser.email;
          const reason = (p.reason as string | null | undefined) ?? null;
          const bridgePayload = { tier_override: tier, actor_email: actorEmail, reason };
          const result = await callErpBridge("set_nano_banana_tier_override", bridgePayload);
          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: "set_nano_banana_tier_override",
            target_email: null,
            details: { value: tier, actor_email: actorEmail, reason },
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit (set_nano_banana_tier_override) failed:", error.message);
          });
          return jsonResp(200, result);
        } catch (err: any) {
          console.error("[admin-api] erp-bridge set_nano_banana_tier_override error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Flow Badges ──
      case "list_flow_badges": {
        try {
          const flowId = (params as any)?.flow_id;
          if (!flowId) return jsonResp(400, { error: "flow_id required" });
          const result = await callBridgeWithFallback(
            ["list_flow_badges", "get_flow_badges"],
            { flow_id: flowId },
          );
          return jsonResp(200, { data: Array.isArray(result.data) ? result.data : [] });
        } catch (err: any) {
          console.error("[admin-api] list_flow_badges error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      case "manage_badge": {
        try {
          const p = (params ?? {}) as Record<string, unknown>;
          const flowId = p.flow_id as string | undefined;
          const badge = p.badge as string | undefined;
          const remove = Boolean(p.remove);
          const ALLOWED = ["official_flow", "top_performing", "enterprise_ready"];
          if (!flowId || !badge) return jsonResp(400, { error: "flow_id and badge required" });
          if (!ALLOWED.includes(badge)) return jsonResp(400, { error: `badge must be one of: ${ALLOWED.join(", ")}` });

          const action = remove ? "remove_flow_badge" : "add_flow_badge";
          const result = await callBridge(action, {
            flow_id: flowId,
            badge,
            assigned_by: adminUser.sub,
            assigned_by_email: adminUser.email,
          });

          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: remove ? "remove_flow_badge" : "add_flow_badge",
            target_email: null,
            details: { flow_id: flowId, badge },
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit (manage_badge) failed:", error.message);
          });

          return jsonResp(200, { success: true, data: result?.data ?? result });
        } catch (err: any) {
          console.error("[admin-api] manage_badge error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Unpublish a published flow back to submitted ──
      case "unpublish_flow": {
        try {
          const p = (params ?? {}) as Record<string, unknown>;
          const flowId = p.flow_id as string | undefined;
          const reason = (p.reason as string | undefined) ?? "Admin unpublish";
          if (!flowId) return jsonResp(400, { error: "flow_id required" });

          const result = await callBridgeWithFallback(
            ["unpublish_flow", "set_flow_status"],
            {
              flow_id: flowId,
              status: "submitted",
              reason,
              actor_email: adminUser.email,
              actor_id: adminUser.sub,
            },
          );

          erpAdmin.from("admin_audit_logs").insert({
            admin_email: adminUser.email,
            action_type: "unpublish_flow",
            target_email: null,
            details: { flow_id: flowId, reason },
          }).then(({ error }) => {
            if (error) console.error("[admin-api] audit (unpublish_flow) failed:", error.message);
          });

          return jsonResp(200, { success: true, data: result?.data ?? result });
        } catch (err: any) {
          console.error("[admin-api] unpublish_flow error:", err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      // ── Active Flows Management (Marketplace) ──
      // Admin / sales use flows-bridge directly.
      // Creator can read active flows via the review-queue bridge fallback,
      // but cannot mutate marketplace state here.
      case "list_active_flows":
      case "update_flow_status":
      case "toggle_flow_official":
      case "manage_flow_badges":
      case "update_flow_metadata":
      case "list_homepage_featured":
      case "upsert_homepage_featured":
      case "delete_homepage_featured": {
        try {
          if (adminUser.role === "creator") {
            if (action !== "list_active_flows") {
              return jsonResp(403, { error: "Insufficient permissions for this action" });
            }

            const p = (params ?? {}) as Record<string, unknown>;
            const publishedStatuses = ["approved", "published", "paused", "archived"];
            const requestedStatus = Array.isArray(p.status)
              ? (p.status as string[]).filter((s) => publishedStatuses.includes(s))
              : publishedStatuses;

            const queueResult = await callBridgeWithFallback(
              ["get_review_queue", "list_review_queue", "list_pending_flows"],
              {
                status: null,
                tier: null,
                include_published: true,
              },
            );

            const payload = queueResult?.data ?? queueResult;
            let rows: any[] = Array.isArray(payload)
              ? payload
              : Array.isArray(payload?.flows)
                ? payload.flows
                : Array.isArray(payload?.rows)
                  ? payload.rows
                  : Array.isArray(payload?.items)
                    ? payload.items
                    : [];

            const category = typeof p.category === "string" ? p.category : undefined;
            const flowSearch = typeof p.flow_search === "string" ? p.flow_search.trim().toLowerCase() : "";
            const creatorSearch = typeof p.creator_search === "string" ? p.creator_search.trim().toLowerCase() : "";
            const sort = ["created_at", "updated_at"].includes(String(p.sort)) ? String(p.sort) : "updated_at";
            const order = String(p.order) === "asc" ? "asc" : "desc";
            const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
            const offset = Math.max(Number(p.offset) || 0, 0);

            rows = rows.filter((row) => requestedStatus.includes(String(row?.status ?? "")));
            if (category && category !== "all") {
              rows = rows.filter((row) => String(row?.category ?? "") === category);
            }
            if (flowSearch) {
              rows = rows.filter((row) => String(row?.name ?? "").toLowerCase().includes(flowSearch));
            }
            if (creatorSearch) {
              rows = rows.filter((row) => String(row?.creator?.display_name ?? "").toLowerCase().includes(creatorSearch));
            }

            rows.sort((a, b) => {
              const av = new Date(String(a?.[sort] ?? 0)).getTime();
              const bv = new Date(String(b?.[sort] ?? 0)).getTime();
              return order === "asc" ? av - bv : bv - av;
            });

            return jsonResp(200, {
              data: {
                total: rows.length,
                rows: rows.slice(offset, offset + limit),
              },
            });
          }

          const result = await callFlowsBridge(action, params, {
            sub: adminUser.sub,
            role: adminUser.role,
          });
          // flows-bridge returns { data: ... }
          return jsonResp(200, result);
        } catch (err: any) {
          console.error(`[admin-api] flows-bridge ${action} error:`, err.message);
          return jsonResp(502, { error: err.message });
        }
      }

      default:
        return jsonResp(400, { error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error("[admin-api] Error:", err);
    return jsonResp(500, { error: err.message || "Internal server error" });
  }
});
