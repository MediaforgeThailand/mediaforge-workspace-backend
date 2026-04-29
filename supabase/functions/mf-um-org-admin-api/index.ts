/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any
//
// mf-um-org-admin-api  (edu-DB build)
// -----------------------------------
// CRUD endpoint used by the super-admin portal (Mediaforgetest-admin) and
// the teacher dashboard to manage organizations, their domains, SSO
// providers, members, classes, enrolment codes, and credit requests.
//
// Auth tiers:
//   * requireSuperAdmin   — caller must have user_roles.role='super_admin'
//   * requireOrgWriter    — super_admin OR org_admin of THAT org
//   * requireClassWriter  — super_admin OR org_admin OR class teacher (any role)
//   * requireOrgMember    — super_admin OR active org_membership in the org
//
// All checks resolve via the SECURITY DEFINER helpers from the edu DB
// (`is_org_admin`, `is_class_teacher`) — no schema-naming leaks here.
//
// Routes (POST body or query string for filters):
//   GET    /orgs                     list orgs
//   POST   /orgs                     create org { name, slug, type?, primary_contact_email? }
//   GET    /orgs/:id                 detail (org row + domains + sso + member count)
//   PATCH  /orgs/:id                 update mutable fields
//   DELETE /orgs/:id                 soft delete (clears org_id on all members)
//
//   POST   /orgs/:id/domains         add domain { domain, is_primary?, auto_verify? }
//   POST   /orgs/:id/domains/:dId/verify  mark verified (admin only)
//   DELETE /orgs/:id/domains/:dId
//
//   POST   /orgs/:id/sso             upsert SSO { provider, is_primary?, is_enabled?, config? }
//   DELETE /orgs/:id/sso/:pId
//
//   GET    /orgs/:id/members         list members (with profile + recent activity)
//   PATCH  /orgs/:id/members/:userId update role/status
//   DELETE /orgs/:id/members/:userId
//
//   POST   /orgs/:id/credit-pool     super-admin pool top-up / claw-back
//   GET    /orgs/:id/analytics       30-day usage rollup
//
//   GET    /orgs/:id/classes         list classes
//   POST   /orgs/:id/classes         create class
//   GET    /classes/:cid             class detail
//   PATCH  /classes/:cid             update
//   DELETE /classes/:cid             soft-end
//   POST   /classes/:cid/allocate    super-admin: org pool → class pool
//   GET    /classes/:cid/teachers
//   POST   /classes/:cid/teachers    add co-teacher (by user_id or email)
//   DELETE /classes/:cid/teachers/:userId
//   GET    /classes/:cid/members
//   PATCH  /classes/:cid/members/:userId
//   DELETE /classes/:cid/members/:userId
//   POST   /classes/:cid/members/:userId/credits   teacher grant (positive) or revoke (negative)
//   GET    /classes/:cid/codes
//   POST   /classes/:cid/codes
//   DELETE /classes/:cid/codes/:codeId
//   GET    /classes/:cid/credit-requests
//   POST   /classes/:cid/credit-requests           student creates request
//   POST   /credit-requests/:id/review             teacher approve/deny

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE);
}

/** Resolve caller from JWT (returns user id or a 401 Response). */
async function resolveCaller(req: Request): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "missing_authorization" }, 401);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: "invalid_session" }, 401);
  return { userId: userData.user.id };
}

async function requireSuperAdmin(
  req: Request,
): Promise<{ userId: string } | Response> {
  const c = await resolveCaller(req);
  if (c instanceof Response) return c;
  const { data: roleRow } = await admin()
    .from("user_roles")
    .select("role")
    .eq("user_id", c.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) return json({ error: "forbidden_not_super_admin" }, 403);
  return c;
}

async function requireOrgWriter(
  req: Request,
  orgId: string,
): Promise<{ userId: string } | Response> {
  const c = await resolveCaller(req);
  if (c instanceof Response) return c;
  const { data: ok } = await admin().rpc("is_org_admin", {
    p_user_id: c.userId,
    p_org_id: orgId,
  });
  if (!ok) return json({ error: "forbidden_not_org_admin" }, 403);
  return c;
}

async function requireClassWriter(
  req: Request,
  classId: string,
): Promise<{ userId: string } | Response> {
  const c = await resolveCaller(req);
  if (c instanceof Response) return c;
  const { data: ok } = await admin().rpc("is_class_teacher", {
    p_user_id: c.userId,
    p_class_id: classId,
  });
  if (!ok) return json({ error: "forbidden_not_class_teacher" }, 403);
  return c;
}

/** Class CREATION: any active org member can spawn a class (becomes
 *  primary_instructor). Super admins always pass. */
async function requireOrgMember(
  req: Request,
  orgId: string,
): Promise<{ userId: string } | Response> {
  const c = await resolveCaller(req);
  if (c instanceof Response) return c;
  const a = admin();
  const { data: roleRow } = await a.from("user_roles")
    .select("role").eq("user_id", c.userId).eq("role", "admin").maybeSingle();
  if (roleRow) return c;
  const { data: mem } = await a.from("organization_memberships")
    .select("status").eq("user_id", c.userId).eq("organization_id", orgId).maybeSingle();
  if (!mem || (mem as any).status !== "active") {
    return json({ error: "forbidden_not_org_member" }, 403);
  }
  return c;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const fullPath = url.pathname;
  const pathStart = fullPath.indexOf("/mf-um-org-admin-api");
  const path = pathStart >= 0 ? fullPath.slice(pathStart + "/mf-um-org-admin-api".length) : fullPath;
  const segments = path.split("/").filter(Boolean);
  const method = req.method.toUpperCase();

  let body: any = null;
  if (method === "POST" || method === "PATCH") {
    try { body = await req.json(); } catch { body = {}; }
  }

  try {
    // ─── /orgs (list / create) ──────────────────────────────────────────
    if (segments[0] === "orgs" && segments.length === 1) {
      if (method === "GET") {
        const auth = await requireSuperAdmin(req);
        if (auth instanceof Response) return auth;

        const { data, error } = await admin()
          .from("organizations")
          .select("id, name, slug, type, status, logo_url, primary_contact_email, contract_start_date, contract_end_date, created_at, deleted_at")
          .is("deleted_at", null)
          .order("created_at", { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json({ orgs: data });
      }

      if (method === "POST") {
        const auth = await requireSuperAdmin(req);
        if (auth instanceof Response) return auth;

        const { name, slug, type, primary_contact_email, primary_contact_name, primary_contact_phone, contract_start_date, contract_end_date, logo_url } = body ?? {};
        if (!name || !slug) return json({ error: "name_and_slug_required" }, 400);
        if (!SLUG_RE.test(String(slug))) return json({ error: "invalid_slug" }, 400);

        const { data, error } = await admin()
          .from("organizations")
          .insert({
            name, slug,
            type: type ?? "school",
            primary_contact_email, primary_contact_name, primary_contact_phone,
            contract_start_date, contract_end_date, logo_url,
          })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ org: data }, 201);
      }
    }

    // ─── /orgs/:id (detail / update / delete) ──────────────────────────
    if (segments[0] === "orgs" && segments.length === 2) {
      const orgId = segments[1];

      if (method === "GET") {
        const auth = await requireSuperAdmin(req);
        if (auth instanceof Response) return auth;

        const a = admin();
        const [orgRes, domainsRes, ssoRes, memCountRes] = await Promise.all([
          a.from("organizations").select("*").eq("id", orgId).maybeSingle(),
          a.from("organization_domains").select("*").eq("organization_id", orgId).order("is_primary", { ascending: false }),
          a.from("organization_sso_providers").select("*").eq("organization_id", orgId).order("is_primary", { ascending: false }),
          a.from("organization_memberships").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status", "active"),
        ]);
        if (orgRes.error) return json({ error: orgRes.error.message }, 500);
        if (!orgRes.data) return json({ error: "not_found" }, 404);

        return json({
          org: orgRes.data,
          domains: domainsRes.data ?? [],
          sso_providers: ssoRes.data ?? [],
          member_count: memCountRes.count ?? 0,
        });
      }

      if (method === "PATCH") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const allowed = ["name", "logo_url", "type", "status", "settings", "primary_contact_name", "primary_contact_email", "primary_contact_phone", "contract_start_date", "contract_end_date"];
        const updates: Record<string, any> = {};
        for (const k of allowed) if (k in (body ?? {})) updates[k] = body[k];
        updates.updated_at = new Date().toISOString();

        const { data, error } = await admin()
          .from("organizations")
          .update(updates)
          .eq("id", orgId)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ org: data });
      }

      if (method === "DELETE") {
        const auth = await requireSuperAdmin(req);
        if (auth instanceof Response) return auth;

        const a = admin();

        // Strip org_id from member profiles + drop org_memberships rows so
        // RLS doesn't keep treating them as part of this org. We DO NOT
        // re-flag the user as 'consumer' — there is no consumer/org_user
        // duality in this DB.
        const { data: members } = await a
          .from("organization_memberships")
          .select("user_id")
          .eq("organization_id", orgId);
        const memberIds = (members ?? []).map((m: any) => m.user_id);
        if (memberIds.length > 0) {
          await a.from("profiles")
            .update({ organization_id: null, updated_at: new Date().toISOString() })
            .in("user_id", memberIds);
          await a.from("organization_memberships").delete().eq("organization_id", orgId);
        }

        const { error } = await a
          .from("organizations")
          .update({ deleted_at: new Date().toISOString(), status: "expired" })
          .eq("id", orgId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, members_demoted: memberIds.length });
      }
    }

    // ─── /orgs/:id/domains ─────────────────────────────────────────────
    if (segments[0] === "orgs" && segments[2] === "domains" && segments.length === 3) {
      const orgId = segments[1];

      if (method === "POST") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const domain = String(body?.domain ?? "").trim().toLowerCase();
        if (!DOMAIN_RE.test(domain)) return json({ error: "invalid_domain" }, 400);

        const auto_verify = body?.auto_verify !== false;

        const a = admin();

        // Pre-check: domain has UNIQUE constraint across all orgs. Surface a
        // user-friendly error naming the conflicting org.
        const { data: existing } = await a
          .from("organization_domains")
          .select("id, org_id, organizations(name, slug)")
          .eq("domain", domain)
          .maybeSingle();
        if (existing) {
          const conflictName = (existing as any).organizations?.name ?? "another organization";
          const sameOrg = existing.organization_id === orgId;
          return json({
            error: sameOrg
              ? `Domain "${domain}" is already registered to this organization.`
              : `Domain "${domain}" is already registered to "${conflictName}". Remove it there first.`,
            code: "domain_already_registered",
            conflict_org_id: existing.organization_id,
          }, 409);
        }

        const { data, error } = await a
          .from("organization_domains")
          .insert({
            organization_id: orgId,
            domain,
            is_primary: !!body?.is_primary,
            // Schema C: verified_at IS NOT NULL is the truth — no separate is_verified flag
            verified_at: auto_verify ? new Date().toISOString() : null,
            verification_method: auto_verify ? "admin_assert" : null,
          })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);

        // Retro-active assignment: existing auth.users whose email matches
        // this newly-verified domain AND who have NULL profile.organization_id should
        // be backfilled. The post-auth trigger only fires on auth.users
        // INSERT/UPDATE OF email — adding a domain after-the-fact does not
        // re-fire it, hence this loop.
        let assigned = 0;
        if (auto_verify) {
          const { data: matchingUsers } = await a.auth.admin.listUsers();
          const candidates = (matchingUsers?.users ?? []).filter(
            (u: any) => u.email && u.email.toLowerCase().endsWith(`@${domain}`),
          );
          for (const u of candidates) {
            const { data: prof } = await a
              .from("profiles").select("user_id, org_id").eq("user_id", u.id).maybeSingle();
            if (!prof || prof.organization_id) continue;
            await a.from("profiles").update({
              organization_id: orgId,
              updated_at: new Date().toISOString(),
            }).eq("user_id", u.id);
            await a.from("organization_memberships").upsert({
              organization_id: orgId, user_id: u.id, role: "member", status: "active",
            }, { onConflict: "org_id,user_id", ignoreDuplicates: true });
            assigned += 1;
          }
        }

        return json({ domain: data, retroactively_assigned: assigned }, 201);
      }
    }

    if (segments[0] === "orgs" && segments[2] === "domains" && segments[4] === "verify" && segments.length === 5) {
      const orgId = segments[1];
      const domainId = segments[3];
      if (method === "POST") {
        const auth = await requireSuperAdmin(req);
        if (auth instanceof Response) return auth;

        const { data, error } = await admin()
          .from("organization_domains")
          .update({ verified_at: new Date().toISOString(), verification_method: "admin_assert" })
          .eq("id", domainId)
          .eq("organization_id", orgId)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ domain: data });
      }
    }

    if (segments[0] === "orgs" && segments[2] === "domains" && segments.length === 4) {
      const orgId = segments[1];
      const domainId = segments[3];
      if (method === "DELETE") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const { error } = await admin()
          .from("organization_domains")
          .delete()
          .eq("id", domainId)
          .eq("organization_id", orgId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
    }

    // ─── /orgs/:id/sso ─────────────────────────────────────────────────
    if (segments[0] === "orgs" && segments[2] === "sso" && segments.length === 3) {
      const orgId = segments[1];
      if (method === "POST") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const provider = String(body?.provider ?? "");
        if (!["google_workspace", "microsoft_entra", "email_otp"].includes(provider)) {
          return json({ error: "invalid_provider" }, 400);
        }

        const row = {
          organization_id: orgId,
          provider,
          is_primary: !!body?.is_primary,
          is_enabled: body?.is_enabled !== false,
          config: body?.config ?? {},
          updated_at: new Date().toISOString(),
        };

        const { data, error } = await admin()
          .from("organization_sso_providers")
          .upsert(row, { onConflict: "org_id,provider" })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ sso: data }, 201);
      }
    }

    if (segments[0] === "orgs" && segments[2] === "sso" && segments.length === 4) {
      const orgId = segments[1];
      const ssoId = segments[3];
      if (method === "DELETE") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const { error } = await admin()
          .from("organization_sso_providers")
          .delete()
          .eq("id", ssoId)
          .eq("organization_id", orgId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
    }

    // ─── /orgs/:id/members ─────────────────────────────────────────────
    if (segments[0] === "orgs" && segments[2] === "members" && segments.length === 3) {
      const orgId = segments[1];
      if (method === "GET") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const a = admin();
        const { data: m, error: mErr } = await a
          .from("organization_memberships")
          .select("id, role, status, joined_at, suspended_at, suspended_reason, user_id")
          .eq("organization_id", orgId)
          .order("joined_at", { ascending: false });
        if (mErr) return json({ error: mErr.message }, 500);

        const ids = (m ?? []).map((r) => r.user_id);
        const profilesRes = await a.from("profiles")
          .select("user_id, display_name, avatar_url").in("user_id", ids);
        const profilesMap = new Map((profilesRes.data ?? []).map((p) => [p.user_id, p]));

        const usersRes = await a.auth.admin.listUsers();
        const usersById = new Map(
          (usersRes.data?.users ?? []).map((u: any) => [u.id, u]),
        );

        const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const { data: actRows } = await a.from("workspace_activity")
          .select("user_id, created_at, activity_type")
          .eq("organization_id", orgId)
          .in("user_id", ids)
          .gte("created_at", since)
          .order("created_at", { ascending: false });
        const lastActivity = new Map<string, string>();
        const activityCount = new Map<string, number>();
        for (const r of (actRows ?? []) as any[]) {
          if (!lastActivity.has(r.user_id)) lastActivity.set(r.user_id, r.created_at);
          if (r.activity_type === "model_use") {
            activityCount.set(r.user_id, (activityCount.get(r.user_id) ?? 0) + 1);
          }
        }

        const enriched = (m ?? []).map((row: any) => ({
          ...row,
          display_name: profilesMap.get(row.user_id)?.display_name ?? null,
          avatar_url: profilesMap.get(row.user_id)?.avatar_url ?? null,
          email: usersById.get(row.user_id)?.email ?? null,
          last_activity_at: lastActivity.get(row.user_id) ?? null,
          model_uses_30d: activityCount.get(row.user_id) ?? 0,
        }));
        return json({ members: enriched });
      }
    }

    // (Deprecated: /orgs/:id/credit-codes — replaced by class enrolment codes)
    if (segments[0] === "orgs" && segments[2] === "credit-codes") {
      return json({
        error: "deprecated",
        message: "Use /classes/:id/codes — class-scoped enrolment codes replace org-level credit codes.",
      }, 410);
    }

    // ─── /orgs/:id/credit-pool (super-admin only) ─────────────────────
    if (segments[0] === "orgs" && segments[2] === "credit-pool" && segments.length === 3) {
      const orgId = segments[1];
      if (method === "POST") {
        const auth = await requireSuperAdmin(req);
        if (auth instanceof Response) return auth;

        const delta = Number(body?.delta ?? 0);
        if (!Number.isInteger(delta) || delta === 0) {
          return json({ error: "delta_must_be_nonzero_integer" }, 400);
        }
        const reason = String(body?.reason ?? "manual_pool_adjustment");

        const a = admin();
        const { data: org, error: orgErr } = await a
          .from("organizations")
          .select("credit_pool, credit_pool_allocated_to_classes, name")
          .eq("id", orgId)
          .maybeSingle();
        if (orgErr || !org) return json({ error: "org_not_found" }, 404);

        const newPool = (org.credit_pool ?? 0) + delta;
        if (newPool < (org.credit_pool_allocated_to_classes ?? 0)) {
          return json({
            error: "Cannot reduce credit pool below already-allocated credits.",
            credit_pool_allocated_to_classes: org.credit_pool_allocated_to_classes,
            attempted_new_pool: newPool,
          }, 409);
        }
        if (newPool < 0) return json({ error: "credit_pool_cannot_go_negative" }, 400);

        const { data: updated, error: upErr } = await a
          .from("organizations")
          .update({ credit_pool: newPool, updated_at: new Date().toISOString() })
          .eq("id", orgId)
          .select("credit_pool, credit_pool_allocated_to_classes")
          .single();
        if (upErr) return json({ error: upErr.message }, 400);

        await a.from("workspace_activity").insert({
          user_id: auth.userId,
          organization_id: orgId,
          activity_type: delta > 0 ? "credits_granted" : "credits_revoked",
          credits_used: Math.abs(delta),
          metadata: {
            scope: "credit_pool",
            actor_id: auth.userId,
            reason,
            new_pool: newPool,
          },
        });

        return json({
          ok: true,
          credit_pool: updated.credit_pool,
          credit_pool_allocated_to_classes: updated.credit_pool_allocated_to_classes,
          credit_pool_remaining: updated.credit_pool - updated.credit_pool_allocated_to_classes,
          delta,
        });
      }
    }

    // ─── /orgs/:id/analytics ──────────────────────────────────────────
    if (segments[0] === "orgs" && segments[2] === "analytics" && segments.length === 3) {
      const orgId = segments[1];
      if (method === "GET") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const a = admin();
        const url2 = new URL(req.url);
        const since = url2.searchParams.get("since")
          ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

        const [orgRes, memCountRes, modelUsageRes, totalCreditsRes, recentRes] = await Promise.all([
          a.from("organizations")
            .select("credit_pool, credit_pool_allocated_to_classes, name").eq("id", orgId).maybeSingle(),
          a.from("organization_memberships")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId).eq("status", "active"),
          a.from("workspace_activity")
            .select("model_id, credits_used")
            .eq("organization_id", orgId).eq("activity_type", "model_use")
            .gte("created_at", since),
          a.from("workspace_activity")
            .select("credits_used")
            .eq("organization_id", orgId).eq("activity_type", "model_use"),
          a.from("workspace_activity")
            .select("user_id, activity_type, model_id, credits_used, created_at, metadata, class_id")
            .eq("organization_id", orgId)
            .order("created_at", { ascending: false })
            .limit(50),
        ]);

        const usageByModel: Record<string, { count: number; credits: number }> = {};
        for (const row of (modelUsageRes.data ?? [])) {
          const m = (row as any).model_id ?? "unknown";
          if (!usageByModel[m]) usageByModel[m] = { count: 0, credits: 0 };
          usageByModel[m].count += 1;
          usageByModel[m].credits += Number((row as any).credits_used ?? 0);
        }

        const totalCreditsAllTime = ((totalCreditsRes.data as any[]) ?? [])
          .reduce((s, r) => s + Number(r.credits_used ?? 0), 0);

        return json({
          org_name: orgRes.data?.name,
          credit_pool: orgRes.data?.credit_pool ?? 0,
          credit_pool_allocated_to_classes: orgRes.data?.credit_pool_allocated_to_classes ?? 0,
          credit_pool_remaining: Math.max(
            0,
            (orgRes.data?.credit_pool ?? 0) - (orgRes.data?.credit_pool_allocated_to_classes ?? 0),
          ),
          active_members: memCountRes.count ?? 0,
          total_credits_used_all_time: totalCreditsAllTime,
          model_usage_since: since,
          model_usage: usageByModel,
          recent_activity: recentRes.data ?? [],
        });
      }
    }

    // (Deprecated: /orgs/:id/members/:userId/credits — credits are class-scoped)
    if (segments[0] === "orgs" && segments[2] === "members" && segments[4] === "credits") {
      return json({
        error: "deprecated",
        message: "Credits are class-scoped now. Use /classes/:id/members/:userId/credits.",
      }, 410);
    }

    if (segments[0] === "orgs" && segments[2] === "members" && segments.length === 4) {
      const orgId = segments[1];
      const userId = segments[3];

      if (method === "PATCH") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const updates: Record<string, any> = { updated_at: new Date().toISOString() };
        if (body?.role && ["org_admin", "member"].includes(body.role)) updates.role = body.role;
        if (body?.status && ["active", "suspended"].includes(body.status)) {
          updates.status = body.status;
          if (body.status === "suspended") {
            updates.suspended_at = new Date().toISOString();
            updates.suspended_reason = body.suspended_reason ?? null;
          } else {
            updates.suspended_at = null;
            updates.suspended_reason = null;
          }
        }

        const { data, error } = await admin()
          .from("organization_memberships")
          .update(updates)
          .eq("organization_id", orgId)
          .eq("user_id", userId)
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);
        return json({ member: data });
      }

      if (method === "DELETE") {
        const auth = await requireOrgWriter(req, orgId);
        if (auth instanceof Response) return auth;

        const a = admin();
        const { error: mErr } = await a
          .from("organization_memberships")
          .delete()
          .eq("organization_id", orgId)
          .eq("user_id", userId);
        if (mErr) return json({ error: mErr.message }, 400);

        await a.from("profiles")
          .update({ organization_id: null, updated_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("organization_id", orgId);

        return json({ ok: true });
      }
    }

    /* ════════════════════════════════════════════════════════════════════
       CLASS-SCOPED ROUTES
       ════════════════════════════════════════════════════════════════════ */

    // ─── /orgs/:id/classes ────────────────────────────────────────────
    if (segments[0] === "orgs" && segments[2] === "classes" && segments.length === 3) {
      const orgId = segments[1];
      if (method === "GET") {
        const auth = await requireOrgMember(req, orgId);
        if (auth instanceof Response) return auth;
        const { data, error } = await admin()
          .from("classes")
          .select("id, name, code, term, year, status, max_students, primary_instructor_id, " +
                  "credit_policy, credit_amount, credit_pool, credit_pool_consumed, " +
                  "start_date, end_date, created_at")
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false });
        if (error) return json({ error: error.message }, 500);
        return json({ classes: data ?? [] });
      }
      if (method === "POST") {
        const auth = await requireOrgMember(req, orgId);
        if (auth instanceof Response) return auth;

        const name = String(body?.name ?? "").trim();
        if (!name) return json({ error: "name_required" }, 400);

        let code = String(body?.code ?? "").trim().toUpperCase();
        if (!code) {
          const initials = name
            .split(/\s+/).map((w) => w[0] ?? "").join("")
            .replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 4) || "CLASS";
          const year = body?.year ?? new Date().getFullYear();
          const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
          const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)),
                                  (b) => ALPHA[b % ALPHA.length]).join("");
          code = `${initials}-${year}-${rand}`;
        }

        const { data: orgRow } = await admin()
          .from("organizations")
          .select("default_credit_policy, default_credit_amount").eq("id", orgId).maybeSingle();

        const credit_policy = String(body?.credit_policy ?? orgRow?.default_credit_policy ?? "monthly_reset");
        const credit_amount = Number(body?.credit_amount ?? orgRow?.default_credit_amount ?? 200);

        const primaryInstructorId = body?.primary_instructor_id ?? auth.userId;

        const a = admin();
        const { data, error } = await a
          .from("classes")
          .insert({
            organization_id: orgId,
            name,
            code,
            term: body?.term ?? null,
            year: body?.year ?? null,
            max_students: body?.max_students ?? null,
            primary_instructor_id: primaryInstructorId,
            start_date: body?.start_date ?? null,
            end_date: body?.end_date ?? null,
            credit_policy,
            credit_amount,
            reset_day_of_month: body?.reset_day_of_month ?? 1,
            reset_day_of_week: body?.reset_day_of_week ?? 1,
          })
          .select()
          .single();
        if (error) return json({ error: error.message }, 400);

        // Mirror the primary instructor into class_teachers for consistency
        // with the M:N teacher list. Idempotent — UNIQUE(class_id,user_id).
        await a.from("class_teachers").upsert({
          class_id: data.id,
          user_id: primaryInstructorId,
          role: "primary",
          invited_by: auth.userId,
        }, { onConflict: "class_id,user_id", ignoreDuplicates: true });

        return json({ class: data }, 201);
      }
    }

    // ─── /classes/:cid (detail / patch / delete) ─────────────────────
    if (segments[0] === "classes" && segments.length === 2) {
      const classId = segments[1];

      const { data: classRow } = await admin()
        .from("classes").select("*").eq("id", classId).maybeSingle();
      if (!classRow) return json({ error: "class_not_found" }, 404);

      if (method === "GET") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;

        const a = admin();
        const [memCount, codes, pendingReqCount, teachers] = await Promise.all([
          a.from("class_memberships").select("id", { count: "exact", head: true })
            .eq("class_id", classId).eq("status", "active"),
          a.from("class_enrollment_codes")
            .select("id, code, max_uses, uses_count, expires_at, created_at")
            .eq("class_id", classId).is("revoked_at", null)
            .order("created_at", { ascending: false }).limit(10),
          a.from("credit_requests").select("id", { count: "exact", head: true })
            .eq("class_id", classId).eq("status", "pending"),
          a.from("class_teachers").select("user_id, role").eq("class_id", classId),
        ]);

        return json({
          class: classRow,
          active_member_count: memCount.count ?? 0,
          enrollment_codes: codes.data ?? [],
          pending_credit_requests: pendingReqCount.count ?? 0,
          teachers: teachers.data ?? [],
          credit_pool_remaining: (classRow.credit_pool ?? 0) - (classRow.credit_pool_consumed ?? 0),
        });
      }

      if (method === "PATCH") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;

        const allowed = ["name", "code", "term", "year", "max_students", "primary_instructor_id",
          "start_date", "end_date", "credit_policy", "credit_amount", "status",
          "reset_day_of_month", "reset_day_of_week", "settings"];
        const updates: Record<string, any> = {};
        for (const k of allowed) if (k in (body ?? {})) updates[k] = body[k];
        updates.updated_at = new Date().toISOString();

        const { data, error } = await admin()
          .from("classes").update(updates).eq("id", classId).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ class: data });
      }

      if (method === "DELETE") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;

        await admin()
          .from("classes")
          .update({ status: "ended", end_date: new Date().toISOString().slice(0, 10),
                    updated_at: new Date().toISOString() })
          .eq("id", classId);
        try { await admin().rpc("run_class_auto_end"); } catch { /* best effort */ }
        return json({ ok: true });
      }
    }

    // ─── /classes/:cid/allocate (super-admin only) ───────────────────
    if (segments[0] === "classes" && segments[2] === "allocate" && segments.length === 3) {
      const classId = segments[1];
      if (method === "POST") {
        const auth = await requireSuperAdmin(req);
        if (auth instanceof Response) return auth;
        const delta = Number(body?.delta ?? 0);
        if (!Number.isInteger(delta) || delta === 0) {
          return json({ error: "delta_must_be_nonzero_integer" }, 400);
        }
        const { data, error } = await admin().rpc("allocate_class_pool", {
          p_class_id: classId, p_delta: delta,
          p_actor_id: auth.userId, p_reason: String(body?.reason ?? ""),
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
    }

    // ─── /classes/:cid/teachers ──────────────────────────────────────
    if (segments[0] === "classes" && segments[2] === "teachers" && segments.length === 3) {
      const classId = segments[1];
      const { data: cls } = await admin()
        .from("classes").select("organization_id").eq("id", classId).maybeSingle();
      if (!cls) return json({ error: "class_not_found" }, 404);
      if (method === "GET") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;
        const { data } = await admin()
          .from("class_teachers").select("*").eq("class_id", classId);
        return json({ teachers: data ?? [] });
      }
      if (method === "POST") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;

        let userId = String(body?.user_id ?? "");
        const email = String(body?.user_email ?? body?.email ?? "").trim().toLowerCase();
        if (!userId && email) {
          const a = admin();
          const { data: users } = await a.auth.admin.listUsers();
          const found = (users?.users ?? []).find(
            (u: any) => (u.email ?? "").toLowerCase() === email,
          );
          if (!found) {
            return json({
              error: "user_not_found",
              message: `No user found with email ${email}. They must sign up first.`,
            }, 404);
          }
          userId = found.id;
        }
        if (!userId) return json({ error: "user_id_or_email_required" }, 400);

        // Schema C: class_members table with role='teacher' (no separate
        // class_teachers table — class_teachers is a compat view).
        // The "primary"/"co" distinction is derived from
        // classes.primary_instructor_id, so we just upsert the role here.
        const a = admin();
        const { data, error } = await a
          .from("class_members")
          .upsert(
            { class_id: classId, user_id: userId, role: "teacher", status: "active",
              invited_by: auth.userId, joined_at: new Date().toISOString() },
            { onConflict: "class_id,user_id" }
          )
          .select().single();
        if (error) return json({ error: error.message }, 400);

        // Side effect: ensure the teacher has profile.organization_id pinned + an
        // organization_memberships row. Idempotent.
        await a.from("profiles").update({
          organization_id: cls.organization_id,
          account_type: "org_user",
          updated_at: new Date().toISOString(),
        }).eq("user_id", userId);
        await a.from("organization_memberships").upsert({
          organization_id: cls.organization_id, user_id: userId, role: "member", status: "active",
        }, { onConflict: "organization_id,user_id", ignoreDuplicates: true });

        return json({ teacher: data }, 201);
      }
    }
    if (segments[0] === "classes" && segments[2] === "teachers" && segments.length === 4) {
      const classId = segments[1];
      const userId = segments[3];
      if (method === "DELETE") {
        const { data: cls } = await admin()
          .from("classes").select("organization_id").eq("id", classId).maybeSingle();
        if (!cls) return json({ error: "class_not_found" }, 404);
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;
        // Schema C: target class_members directly with role filter
        const { error } = await admin()
          .from("class_members").delete()
          .eq("class_id", classId).eq("user_id", userId).eq("role", "teacher");
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
    }

    // ─── /classes/:cid/members ───────────────────────────────────────
    if (segments[0] === "classes" && segments[2] === "members" && segments.length === 3) {
      const classId = segments[1];
      const { data: cls } = await admin()
        .from("classes").select("organization_id").eq("id", classId).maybeSingle();
      if (!cls) return json({ error: "class_not_found" }, 404);
      if (method === "GET") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;

        const a = admin();
        const { data: m, error: mErr } = await a
          .from("class_memberships")
          .select("id, user_id, status, enrolled_at, enrolled_via, student_code, " +
                  "credits_balance, credits_lifetime_received, credits_lifetime_used")
          .eq("class_id", classId)
          .order("enrolled_at", { ascending: false });
        if (mErr) return json({ error: mErr.message }, 500);

        const ids = ((m ?? []) as any[]).map((r) => r.user_id);
        if (ids.length === 0) return json({ members: [] });

        const profilesRes = await a.from("profiles")
          .select("user_id, display_name, avatar_url").in("user_id", ids);
        const profilesMap = new Map(((profilesRes.data ?? []) as any[]).map((p) => [p.user_id, p]));
        const usersRes = await a.auth.admin.listUsers();
        const usersById = new Map((usersRes.data?.users ?? []).map((u: any) => [u.id, u]));

        // class_id is now a first-class column, so we can filter directly
        // (no metadata->>'class_id' digging).
        const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const { data: actRows } = await a.from("workspace_activity")
          .select("user_id, created_at, activity_type")
          .eq("class_id", classId).in("user_id", ids).gte("created_at", since)
          .order("created_at", { ascending: false });
        const lastActivity = new Map<string, string>();
        const useCount = new Map<string, number>();
        for (const r of (actRows ?? []) as any[]) {
          if (!lastActivity.has(r.user_id)) lastActivity.set(r.user_id, r.created_at);
          if (r.activity_type === "model_use") {
            useCount.set(r.user_id, (useCount.get(r.user_id) ?? 0) + 1);
          }
        }

        const enriched = (m ?? []).map((row: any) => ({
          ...row,
          display_name: profilesMap.get(row.user_id)?.display_name ?? null,
          avatar_url: profilesMap.get(row.user_id)?.avatar_url ?? null,
          email: usersById.get(row.user_id)?.email ?? null,
          last_activity_at: lastActivity.get(row.user_id) ?? null,
          model_uses_30d: useCount.get(row.user_id) ?? 0,
        }));
        return json({ members: enriched });
      }
    }

    // ─── /classes/:cid/members/:userId/credits (grant/revoke) ────────
    if (segments[0] === "classes" && segments[2] === "members"
        && segments[4] === "credits" && segments.length === 5) {
      const classId = segments[1];
      const userId = segments[3];
      if (method === "POST") {
        const { data: cls } = await admin()
          .from("classes").select("organization_id").eq("id", classId).maybeSingle();
        if (!cls) return json({ error: "class_not_found" }, 404);
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;

        const amount = Number(body?.amount ?? 0);
        if (!Number.isFinite(amount) || amount === 0) {
          return json({ error: "amount_must_be_nonzero_integer" }, 400);
        }
        const reason = String(body?.reason ?? "manual");

        if (amount > 0) {
          const { data, error } = await admin().rpc("grant_credits", {
            p_class_id: classId,
            p_user_id: userId,
            p_amount: amount,
            p_actor_id: auth.userId,
            p_metadata: { reason },
          });
          if (error) return json({ error: error.message }, 400);
          if (data === null) return json({ error: "class_budget_exhausted" }, 409);
          return json({ new_balance: data, granted: amount });
        }

        // Negative → revoke via the dedicated SECURITY DEFINER helper.
        // It clamps to current balance, decrements credits_lifetime_received,
        // and writes a typed activity_logs row in one atomic txn.
        const revoke = Math.abs(amount);
        const { data, error } = await admin().rpc("revoke_credits", {
          p_class_id: classId,
          p_user_id: userId,
          p_amount: revoke,
          p_actor_id: auth.userId,
          p_reason: reason,
        });
        if (error) return json({ error: error.message }, 400);
        // Helper returns the new balance. We don't know the exact `taken`
        // amount from the return shape — but the activity_logs row records
        // it, and the UI reads new_balance to refresh.
        return json({ new_balance: data, revoked: revoke });
      }
    }

    // ─── /classes/:cid/members/:userId (PATCH / DELETE) ──────────────
    if (segments[0] === "classes" && segments[2] === "members" && segments.length === 4) {
      const classId = segments[1];
      const userId = segments[3];
      const { data: cls } = await admin()
        .from("classes").select("organization_id").eq("id", classId).maybeSingle();
      if (!cls) return json({ error: "class_not_found" }, 404);

      if (method === "PATCH") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;
        const updates: Record<string, any> = { updated_at: new Date().toISOString() };
        if (body?.status && ["active","suspended","removed"].includes(body.status)) {
          updates.status = body.status;
        }
        if (typeof body?.student_code === "string") updates.student_code = body.student_code;
        const { data, error } = await admin()
          .from("class_memberships").update(updates)
          .eq("class_id", classId).eq("user_id", userId).select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ member: data });
      }
      if (method === "DELETE") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;
        const { error } = await admin()
          .from("class_memberships").delete()
          .eq("class_id", classId).eq("user_id", userId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
    }

    // ─── /classes/:cid/codes (enrolment QR codes) ────────────────────
    if (segments[0] === "classes" && segments[2] === "codes" && segments.length === 3) {
      const classId = segments[1];
      const { data: cls } = await admin()
        .from("classes").select("org_id, code").eq("id", classId).maybeSingle();
      if (!cls) return json({ error: "class_not_found" }, 404);

      if (method === "GET") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;
        const { data } = await admin()
          .from("class_enrollment_codes")
          .select("id, code, max_uses, uses_count, expires_at, description, created_at")
          .eq("class_id", classId).is("revoked_at", null)
          .order("created_at", { ascending: false });
        return json({ codes: data ?? [] });
      }
      if (method === "POST") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;

        const max_uses = body?.max_uses === null || body?.max_uses === undefined
          ? null : Number(body.max_uses);
        if (max_uses !== null && (!Number.isInteger(max_uses) || max_uses <= 0)) {
          return json({ error: "max_uses_must_be_positive_integer_or_null" }, 400);
        }
        const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)),
                                (b) => ALPHA[b % ALPHA.length]).join("");
        const code = `${(cls.code as string).toUpperCase()}-${rand}`;

        const { data, error } = await admin()
          .from("class_enrollment_codes")
          .insert({
            class_id: classId,
            code,
            max_uses,
            expires_at: body?.expires_at ?? null,
            description: body?.description ?? null,
            created_by: auth.userId,
          })
          .select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ code: data }, 201);
      }
    }
    if (segments[0] === "classes" && segments[2] === "codes" && segments.length === 4) {
      const classId = segments[1];
      const codeId = segments[3];
      if (method === "DELETE") {
        const { data: cls } = await admin()
          .from("classes").select("organization_id").eq("id", classId).maybeSingle();
        if (!cls) return json({ error: "class_not_found" }, 404);
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;
        const { error } = await admin()
          .from("class_enrollment_codes")
          .update({ revoked_at: new Date().toISOString(), revoked_by: auth.userId })
          .eq("id", codeId).eq("class_id", classId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
    }

    // ─── /classes/:cid/credit-requests ───────────────────────────────
    if (segments[0] === "classes" && segments[2] === "credit-requests" && segments.length === 3) {
      const classId = segments[1];
      const { data: cls } = await admin()
        .from("classes").select("organization_id").eq("id", classId).maybeSingle();
      if (!cls) return json({ error: "class_not_found" }, 404);

      if (method === "GET") {
        const auth = await requireClassWriter(req, classId);
        if (auth instanceof Response) return auth;
        const { data } = await admin()
          .from("credit_requests")
          .select("*").eq("class_id", classId)
          .order("created_at", { ascending: false });
        return json({ requests: data ?? [] });
      }
      // Student creates a request
      if (method === "POST") {
        const c = await resolveCaller(req);
        if (c instanceof Response) return c;

        const amount = Number(body?.amount_requested ?? 0);
        if (!Number.isInteger(amount) || amount <= 0) {
          return json({ error: "amount_required_positive_integer" }, 400);
        }
        const { data: mem } = await admin()
          .from("class_memberships").select("id, status")
          .eq("class_id", classId).eq("user_id", c.userId).maybeSingle();
        if (!mem || (mem as any).status !== "active") {
          return json({ error: "not_an_active_member" }, 403);
        }
        const { data, error } = await admin()
          .from("credit_requests")
          .insert({ class_id: classId, user_id: c.userId,
                    amount_requested: amount, reason: body?.reason ?? null })
          .select().single();
        if (error) return json({ error: error.message }, 400);
        return json({ request: data }, 201);
      }
    }

    // ─── /credit-requests/:id/review (teacher approve/deny) ──────────
    if (segments[0] === "credit-requests" && segments[2] === "review" && segments.length === 3) {
      const reqId = segments[1];
      if (method === "POST") {
        const { data: r } = await admin()
          .from("credit_requests").select("class_id").eq("id", reqId).maybeSingle();
        if (!r) return json({ error: "request_not_found" }, 404);
        const reqClassId = (r as any).class_id;
        const auth = await requireClassWriter(req, reqClassId);
        if (auth instanceof Response) return auth;

        const approve = body?.approve === true;
        const amountGranted = body?.amount_granted ?? null;
        const note = String(body?.review_note ?? "");
        const { data, error } = await admin().rpc("review_credit_request", {
          p_request_id: reqId,
          p_reviewer_id: auth.userId,
          p_approve: approve,
          p_amount_granted: amountGranted,
          p_review_note: note,
        });
        if (error) return json({ error: error.message }, 500);
        return json(data);
      }
    }

    return json({ error: "not_found", path }, 404);
  } catch (err: any) {
    console.error("[mf-um-org-admin-api] unhandled:", err?.message ?? err);
    return json({ error: "internal_error", detail: String(err?.message ?? err) }, 500);
  }
});
