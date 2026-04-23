// ─────────────────────────────────────────────────────────────────────────────
//  flows-bridge — ERP → MAIN bridge for managing flows / homepage curation
//
//  Auth: shared-secret (Authorization: Bearer <ERP_BRIDGE_SECRET>)
//        Optional X-Bridge-Token header is also accepted for backward compat.
//        Caller (ERP) must verify role locally and pass:
//          X-Actor-Id   : <erp_user_uuid>     (required, used for audit trail)
//          X-Actor-Role : "admin" | "sales"   (required, used for authorization)
//
//  Supported actions (POST { action, params }):
//    - list_active_flows
//    - update_flow_status
//    - toggle_flow_official
//    - manage_flow_badges
//    - update_flow_metadata
//    - list_homepage_featured
//    - upsert_homepage_featured
//    - delete_homepage_featured
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-bridge-token, x-actor-id, x-actor-role",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ActorRole = "admin" | "sales";

const READ_ONLY_ACTIONS = new Set([
  "list_active_flows",
  "list_homepage_featured",
]);

const ALLOWED_BADGES = new Set(["featured", "trending", "new", "staff_pick"]);
const ALLOWED_STATUSES = new Set([
  "draft",
  "submitted",
  "in_review",
  "approved",
  "published",
  "paused",
  "archived",
  "rejected",
  "changes_requested",
]);

function respond(ok: boolean, payload: unknown, status = 200) {
  const body = ok ? { ok: true, data: payload } : { ok: false, error: payload };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  return req.headers.get("x-bridge-token");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond(false, "Method not allowed", 405);

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const expected =
    Deno.env.get("ERP_BRIDGE_SECRET") ?? Deno.env.get("BRIDGE_API_KEY");
  if (!expected) {
    console.error("[flows-bridge] missing ERP_BRIDGE_SECRET / BRIDGE_API_KEY");
    return respond(false, { stage: "auth", message: "Server misconfiguration" }, 500);
  }
  const token = extractToken(req);
  if (!token || !constantTimeEqual(token, expected)) {
    return respond(false, { stage: "auth", message: "Unauthorized" }, 401);
  }

  // ── 2. Actor headers (role check done at ERP, we trust + audit) ───────────
  const actorId = req.headers.get("x-actor-id") ?? "";
  const actorRoleRaw = (req.headers.get("x-actor-role") ?? "").toLowerCase();
  if (!actorId || !/^[0-9a-f-]{36}$/i.test(actorId)) {
    return respond(false, { stage: "auth", message: "Missing/invalid X-Actor-Id" }, 400);
  }
  if (actorRoleRaw !== "admin" && actorRoleRaw !== "sales") {
    return respond(false, { stage: "auth", message: "Invalid X-Actor-Role" }, 400);
  }
  const actorRole = actorRoleRaw as ActorRole;

  // ── 3. Parse body ─────────────────────────────────────────────────────────
  let body: { action?: string; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return respond(false, { stage: "parse", message: "Invalid JSON body" }, 400);
  }
  const action = body?.action;
  const params = (body?.params ?? {}) as Record<string, any>;
  if (!action || typeof action !== "string") {
    return respond(false, { stage: "parse", message: "Missing action" }, 400);
  }

  // ── 4. Authorization (sales = read-only) ──────────────────────────────────
  if (actorRole === "sales" && !READ_ONLY_ACTIONS.has(action)) {
    return respond(
      false,
      { stage: "authz", message: `Sales role cannot perform '${action}'` },
      403,
    );
  }

  // ── 5. MAIN service-role client ───────────────────────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return respond(false, { stage: "config", message: "MAIN env vars missing" }, 500);
  }
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Audit helper (best-effort)
  const audit = async (entityId: string, diff: Record<string, unknown>) => {
    try {
      await db.from("affiliate_audit_log").insert({
        actor_id: actorId,
        action: `flows_bridge.${action}`,
        entity_type: "flow",
        entity_id: entityId,
        diff,
      });
    } catch (e) {
      console.warn("[flows-bridge] audit insert failed:", (e as Error).message);
    }
  };

  try {
    switch (action) {
      // ── list_active_flows ────────────────────────────────────────────────
      case "list_active_flows": {
        const {
          status,
          category,
          search,
          is_official,
          limit = 50,
          offset = 0,
        } = params;
        const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);

        let q = db
          .from("flows")
          .select(
            `
            id, name, description, category, categories, status, thumbnail_url,
            is_official, base_cost, api_cost, selling_price, markup_multiplier,
            markup_multiplier_override, contribution_margin, creator_payout,
            performance_bonus_percent, tags, format_tags, industry_tags,
            use_case_tags, keywords, created_at, updated_at, user_id,
            profiles:profiles!flows_user_id_fkey(display_name, avatar_url, is_official),
            flow_metrics(total_runs, total_revenue, avg_rating, last_run_at),
            flow_badges(id, badge, assigned_by, created_at)
            `,
            { count: "exact" },
          )
          .order("updated_at", { ascending: false })
          .range(off, off + cap - 1);

        if (status) q = q.eq("status", String(status));
        if (typeof is_official === "boolean") q = q.eq("is_official", is_official);
        if (category) q = q.eq("category", String(category));
        if (search) {
          const s = String(search).replace(/[%_]/g, "");
          q = q.or(`name.ilike.%${s}%,description.ilike.%${s}%`);
        }

        const { data, error, count } = await q;
        if (error) {
          // Profile join may fail if FK name differs — retry without join
          let q2 = db
            .from("flows")
            .select(
              `id, name, description, category, categories, status, thumbnail_url,
               is_official, base_cost, api_cost, selling_price, markup_multiplier,
               markup_multiplier_override, contribution_margin, creator_payout,
               performance_bonus_percent, tags, format_tags, industry_tags,
               use_case_tags, keywords, created_at, updated_at, user_id,
               flow_metrics(total_runs, total_revenue, avg_rating, last_run_at),
               flow_badges(id, badge, assigned_by, created_at)`,
              { count: "exact" },
            )
            .order("updated_at", { ascending: false })
            .range(off, off + cap - 1);
          if (status) q2 = q2.eq("status", String(status));
          if (typeof is_official === "boolean") q2 = q2.eq("is_official", is_official);
          if (category) q2 = q2.eq("category", String(category));
          if (search) {
            const s = String(search).replace(/[%_]/g, "");
            q2 = q2.or(`name.ilike.%${s}%,description.ilike.%${s}%`);
          }
          const r2 = await q2;
          if (r2.error) throw r2.error;

          // Hydrate profiles separately
          const userIds = Array.from(new Set((r2.data ?? []).map((r: any) => r.user_id).filter(Boolean)));
          let profilesMap: Record<string, any> = {};
          if (userIds.length) {
            const { data: profs } = await db
              .from("profiles")
              .select("user_id, display_name, avatar_url, is_official")
              .in("user_id", userIds);
            (profs ?? []).forEach((p: any) => { profilesMap[p.user_id] = p; });
          }
          const hydrated = (r2.data ?? []).map((r: any) => ({ ...r, profile: profilesMap[r.user_id] ?? null }));
          return respond(true, { rows: hydrated, count: r2.count ?? hydrated.length, limit: cap, offset: off });
        }
        return respond(true, { rows: data ?? [], count: count ?? 0, limit: cap, offset: off });
      }

      // ── update_flow_status ───────────────────────────────────────────────
      case "update_flow_status": {
        const { flow_id, status: newStatus } = params;
        if (!flow_id || !newStatus) {
          return respond(false, "flow_id and status are required", 400);
        }
        if (!ALLOWED_STATUSES.has(String(newStatus))) {
          return respond(false, `Invalid status '${newStatus}'`, 400);
        }
        const { data: before } = await db.from("flows").select("status").eq("id", flow_id).maybeSingle();
        const { data, error } = await db
          .from("flows")
          .update({ status: String(newStatus), updated_at: new Date().toISOString() })
          .eq("id", flow_id)
          .select("id, status, updated_at")
          .maybeSingle();
        if (error) throw error;
        if (!data) return respond(false, "Flow not found", 404);
        await audit(String(flow_id), { from: before?.status ?? null, to: data.status });
        return respond(true, data);
      }

      // ── toggle_flow_official ─────────────────────────────────────────────
      case "toggle_flow_official": {
        const { flow_id, is_official } = params;
        if (!flow_id || typeof is_official !== "boolean") {
          return respond(false, "flow_id (uuid) and is_official (boolean) required", 400);
        }
        const { data: before } = await db.from("flows").select("is_official").eq("id", flow_id).maybeSingle();
        const { data, error } = await db
          .from("flows")
          .update({ is_official, updated_at: new Date().toISOString() })
          .eq("id", flow_id)
          .select("id, is_official")
          .maybeSingle();
        if (error) throw error;
        if (!data) return respond(false, "Flow not found", 404);
        await audit(String(flow_id), { from: before?.is_official ?? null, to: data.is_official });
        return respond(true, data);
      }

      // ── manage_flow_badges ───────────────────────────────────────────────
      case "manage_flow_badges": {
        const { flow_id, op, badge } = params;
        if (!flow_id || !op || !badge) {
          return respond(false, "flow_id, op ('add'|'remove'), badge required", 400);
        }
        if (!ALLOWED_BADGES.has(String(badge))) {
          return respond(false, `Invalid badge '${badge}'. Allowed: ${[...ALLOWED_BADGES].join(", ")}`, 400);
        }
        if (op === "add") {
          const { data, error } = await db
            .from("flow_badges")
            .upsert(
              { flow_id, badge: String(badge), assigned_by: actorId },
              { onConflict: "flow_id,badge", ignoreDuplicates: false },
            )
            .select()
            .maybeSingle();
          if (error) {
            // Fallback if no unique constraint exists
            const ins = await db
              .from("flow_badges")
              .insert({ flow_id, badge: String(badge), assigned_by: actorId })
              .select()
              .maybeSingle();
            if (ins.error) throw ins.error;
            await audit(String(flow_id), { op: "add", badge });
            return respond(true, ins.data);
          }
          await audit(String(flow_id), { op: "add", badge });
          return respond(true, data);
        }
        if (op === "remove") {
          const { error } = await db
            .from("flow_badges")
            .delete()
            .eq("flow_id", flow_id)
            .eq("badge", String(badge));
          if (error) throw error;
          await audit(String(flow_id), { op: "remove", badge });
          return respond(true, { removed: true });
        }
        return respond(false, "op must be 'add' or 'remove'", 400);
      }

      // ── update_flow_metadata ─────────────────────────────────────────────
      case "update_flow_metadata": {
        const { flow_id, ...rest } = params;
        if (!flow_id) return respond(false, "flow_id is required", 400);

        // Whitelist mutable fields. NOTE: selling_price is intentionally excluded
        // (computed by trigger from api_cost × markup_multiplier_override).
        const allowed = [
          "name",
          "description",
          "category",
          "categories",
          "tags",
          "format_tags",
          "industry_tags",
          "use_case_tags",
          "keywords",
          "thumbnail_url",
          "markup_multiplier",
          "markup_multiplier_override",
          "performance_bonus_percent",
        ];
        const patch: Record<string, unknown> = {};
        for (const k of allowed) if (k in rest) patch[k] = rest[k];
        if (Object.keys(patch).length === 0) {
          return respond(false, "No valid fields to update", 400);
        }
        patch.updated_at = new Date().toISOString();

        const { data, error } = await db
          .from("flows")
          .update(patch)
          .eq("id", flow_id)
          .select(
            "id, name, category, categories, tags, format_tags, industry_tags, use_case_tags, keywords, thumbnail_url, markup_multiplier, markup_multiplier_override, performance_bonus_percent, selling_price, contribution_margin, creator_payout, updated_at",
          )
          .maybeSingle();
        if (error) throw error;
        if (!data) return respond(false, "Flow not found", 404);
        await audit(String(flow_id), { patch });
        return respond(true, data);
      }

      // ── list_homepage_featured ───────────────────────────────────────────
      case "list_homepage_featured": {
        const { data: sections, error: sErr } = await db
          .from("homepage_sections")
          .select("*")
          .order("sort_order", { ascending: true });
        if (sErr) throw sErr;

        const { data: featured, error: fErr } = await db
          .from("homepage_featured")
          .select(
            `id, section_id, slot, flow_id, sort_order, is_active, created_at, updated_at,
             flow:flows!homepage_featured_flow_id_fkey(
               id, name, thumbnail_url, status, is_official, category, selling_price
             )`,
          )
          .order("sort_order", { ascending: true });
        if (fErr) throw fErr;

        return respond(true, { sections: sections ?? [], featured: featured ?? [] });
      }

      // ── upsert_homepage_featured ─────────────────────────────────────────
      case "upsert_homepage_featured": {
        const {
          id,
          section_id,
          slot,
          flow_id,
          sort_order = 0,
          is_active = true,
        } = params;
        if (!flow_id) return respond(false, "flow_id is required", 400);
        if (!section_id && !slot) {
          return respond(false, "section_id or slot is required", 400);
        }

        const row: Record<string, unknown> = {
          flow_id,
          sort_order: Number(sort_order) || 0,
          is_active: Boolean(is_active),
          updated_at: new Date().toISOString(),
        };
        if (section_id) row.section_id = section_id;
        if (slot) row.slot = String(slot);

        let result;
        if (id) {
          result = await db
            .from("homepage_featured")
            .update(row)
            .eq("id", id)
            .select()
            .maybeSingle();
        } else {
          result = await db
            .from("homepage_featured")
            .insert(row)
            .select()
            .maybeSingle();
        }
        if (result.error) throw result.error;
        await audit(String(flow_id), { op: id ? "update_featured" : "insert_featured", row });
        return respond(true, result.data);
      }

      // ── delete_homepage_featured ─────────────────────────────────────────
      case "delete_homepage_featured": {
        const { id } = params;
        if (!id) return respond(false, "id is required", 400);
        const { data: before } = await db
          .from("homepage_featured")
          .select("flow_id, section_id, slot")
          .eq("id", id)
          .maybeSingle();
        const { error } = await db.from("homepage_featured").delete().eq("id", id);
        if (error) throw error;
        await audit(String(before?.flow_id ?? id), { op: "delete_featured", before });
        return respond(true, { deleted: true });
      }

      default:
        return respond(false, `Unknown action: ${action}`, 400);
    }
  } catch (e) {
    const err = e as Error;
    console.error(`[flows-bridge] action=${action} error:`, err.message, err.stack);
    return respond(false, { stage: "exec", action, message: err.message }, 500);
  }
});
