/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any
//
// admin_workspace_orgs
// --------------------
// Action-style admin API for Workspace SSO organizations, domains,
// providers, org credit pools, and team/class credit pools. This is used by
// the ERP admin hub when the operator selects the Workspace target.
//
// ERP scope: support/debug. Customer org admins manage members, teams,
// requests, top-ups, and team credit pools through workspace_org_console.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAdminJwt, unauthorizedResponse } from "../_shared/adminAuth.ts";
import { assertPrivateEmailDomain } from "../_shared/publicEmailDomains.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
      "x-admin-email",
      "x-admin-auth-key",
      "x-supabase-client-platform",
      "x-supabase-client-platform-version",
      "x-supabase-client-runtime",
      "x-supabase-client-runtime-version",
    ].join(", "),
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const PROVIDERS = new Set(["google_workspace", "microsoft_entra", "email_otp", "saml"]);
const ORG_TYPES = new Set(["school", "university", "enterprise"]);
const ORG_STATUSES = new Set(["pending", "active", "suspended", "expired"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.toLowerCase());
  return fallback;
}

function asInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `org-${Date.now()}`;
}

function randomClassCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += letters[Math.floor(Math.random() * letters.length)];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

async function listUsersByDomain(client: SupabaseClient, domain: string) {
  const normalizedDomain = assertWorkspaceOrgDomain(domain);
  const matches: Array<{ id: string; email: string | null }> = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth users read failed: ${error.message}`);
    const users = data?.users ?? [];
    for (const user of users) {
      const email = String(user.email ?? "").toLowerCase();
      if (email.endsWith(`@${normalizedDomain}`)) matches.push({ id: user.id, email });
    }
    if (users.length < 1000) break;
  }
  return matches;
}

async function findAuthUserByEmail(client: SupabaseClient, email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return null;
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth users read failed: ${error.message}`);
    const found = (data?.users ?? []).find((user) =>
      String(user.email ?? "").toLowerCase() === normalizedEmail
    );
    if (found) return { id: found.id, email: found.email ?? normalizedEmail };
    if ((data?.users ?? []).length < 1000) break;
  }
  return null;
}

function assertWorkspaceOrgDomain(value: string): string {
  const domain = assertPrivateEmailDomain(value);
  if (!DOMAIN_RE.test(domain)) throw new Error("invalid domain");
  return domain;
}

async function retroactivelyAssignDomainUsers(
  client: SupabaseClient,
  organizationId: string,
  domain: string,
): Promise<number> {
  const users = await listUsersByDomain(client, domain);
  let assigned = 0;
  for (const user of users) {
    const { data: profile } = await client
      .from("profiles")
      .select("user_id, organization_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!profile) continue;
    if (!profile.organization_id) {
      await client
        .from("profiles")
        .update({
          organization_id: organizationId,
          account_type: "org_user",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
    }

    const { error } = await client.from("organization_memberships").upsert(
      {
        organization_id: organizationId,
        user_id: user.id,
        role: "member",
        status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,user_id" },
    );
    if (error) throw new Error(`membership upsert failed: ${error.message}`);
    assigned += 1;
  }
  return assigned;
}

async function listWorkspaceOrgs(client: SupabaseClient) {
  const [orgsRes, domainsRes, providersRes, membersRes, classesRes] = await Promise.all([
    client
      .from("organizations")
      .select(
        "id,name,slug,display_name,type,status,logo_url,brand_color,primary_contact_name,primary_contact_email,primary_contact_phone,contact_notes,credit_pool,credit_pool_allocated,settings,created_at,updated_at",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    client
      .from("organization_domains")
      .select("id,organization_id,domain,is_primary,verification_method,verified_at,created_at")
      .order("is_primary", { ascending: false }),
    client
      .from("organization_sso_providers")
      .select("id,organization_id,provider,is_enabled,is_primary,config,created_at,updated_at")
      .order("is_primary", { ascending: false }),
    client
      .from("organization_memberships")
      .select("organization_id,status"),
    client
      .from("classes")
      .select("id,organization_id,name,code,status,credit_pool,credit_pool_consumed,created_at,updated_at")
      .is("deleted_at", null),
  ]);

  if (orgsRes.error) throw new Error(`organizations read failed: ${orgsRes.error.message}`);
  if (domainsRes.error) throw new Error(`domains read failed: ${domainsRes.error.message}`);
  if (providersRes.error) throw new Error(`sso providers read failed: ${providersRes.error.message}`);
  if (membersRes.error) throw new Error(`memberships read failed: ${membersRes.error.message}`);
  if (classesRes.error) throw new Error(`classes read failed: ${classesRes.error.message}`);

  const domainsByOrg = new Map<string, unknown[]>();
  for (const row of domainsRes.data ?? []) {
    const key = String((row as any).organization_id);
    domainsByOrg.set(key, [...(domainsByOrg.get(key) ?? []), row]);
  }
  const providersByOrg = new Map<string, unknown[]>();
  for (const row of providersRes.data ?? []) {
    const key = String((row as any).organization_id);
    providersByOrg.set(key, [...(providersByOrg.get(key) ?? []), row]);
  }
  const memberCount = new Map<string, number>();
  for (const row of membersRes.data ?? []) {
    if ((row as any).status !== "active") continue;
    const key = String((row as any).organization_id);
    memberCount.set(key, (memberCount.get(key) ?? 0) + 1);
  }
  const classCount = new Map<string, number>();
  for (const row of classesRes.data ?? []) {
    const key = String((row as any).organization_id);
    classCount.set(key, (classCount.get(key) ?? 0) + 1);
  }

  const orgs = (orgsRes.data ?? []).map((org: any) => {
    const allocated = Number(org.credit_pool_allocated ?? 0);
    const pool = Number(org.credit_pool ?? 0);
    return {
      ...org,
      credit_available: Math.max(0, pool - allocated),
      domains: domainsByOrg.get(org.id) ?? [],
      sso_providers: providersByOrg.get(org.id) ?? [],
      member_count: memberCount.get(org.id) ?? 0,
      team_count: classCount.get(org.id) ?? 0,
    };
  });

  return { data: { orgs } };
}

async function saveWorkspaceOrg(client: SupabaseClient, body: Record<string, unknown>) {
  const id = asString(body.id);
  const name = asString(body.name);
  if (!name) throw new Error("name is required");
  const slug = slugify(asString(body.slug) || name);
  if (!SLUG_RE.test(slug)) throw new Error("invalid slug");
  const type = asString(body.type, "enterprise");
  const status = asString(body.status, "active");
  if (!ORG_TYPES.has(type)) throw new Error("invalid organization type");
  if (!ORG_STATUSES.has(status)) throw new Error("invalid organization status");

  const row = {
    name,
    slug,
    display_name: asString(body.display_name) || name,
    type,
    status,
    logo_url: asString(body.logo_url) || null,
    brand_color: asString(body.brand_color) || null,
    primary_contact_name: asString(body.primary_contact_name) || null,
    primary_contact_email: asString(body.primary_contact_email) || null,
    primary_contact_phone: asString(body.primary_contact_phone) || null,
    contact_notes: asString(body.contact_notes) || null,
  };

  let existingOrgId = id;
  if (!existingOrgId) {
    const { data: existingOrg, error: lookupError } = await client
      .from("organizations")
      .select("id")
      .eq("slug", slug)
      .is("deleted_at", null)
      .maybeSingle();
    if (lookupError) throw new Error(`organization lookup failed: ${lookupError.message}`);
    existingOrgId = String((existingOrg as any)?.id ?? "");
  }

  const result = existingOrgId
    ? await client.from("organizations").update(row).eq("id", existingOrgId).select("*").single()
    : await client.from("organizations").insert(row).select("*").single();
  if (result.error) throw new Error(`organization save failed: ${result.error.message}`);

  const org = result.data as any;
  const initialCredits = Math.max(0, asInt(body.initial_credits, 0));
  const initialTopUp = Math.max(0, initialCredits - Number(org.credit_pool ?? 0));
  if (!id && initialTopUp > 0) {
    const { data, error } = await client.rpc("admin_adjust_org_credit_pool", {
      p_org_id: org.id,
      p_delta: initialTopUp,
      p_actor_id: null,
      p_description: "Initial workspace org credits from ERP",
    });
    if (error) throw new Error(`initial credit top-up failed: ${error.message}`);
    org.credit_pool = data;
  }

  const domain = asString(body.primary_domain).toLowerCase();
  if (domain) {
    await addWorkspaceOrgDomain(client, {
      organization_id: org.id,
      domain,
      is_primary: true,
      auto_verify: true,
    });
  }

  const provider = asString(body.provider);
  if (provider) {
    await saveWorkspaceOrgSso(client, {
      organization_id: org.id,
      provider,
      is_enabled: true,
      is_primary: true,
      config: body.provider_config ?? {},
    });
  }

  return { data: { org } };
}

async function addWorkspaceOrgDomain(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const domain = assertWorkspaceOrgDomain(asString(body.domain));
  if (!organizationId) throw new Error("organization_id is required");
  const isPrimary = asBool(body.is_primary, false);
  const autoVerify = asBool(body.auto_verify, true);

  const { data: existing, error: existingError } = await client
    .from("organization_domains")
    .select("id, organization_id, domain")
    .eq("domain", domain)
    .maybeSingle();
  if (existingError) throw new Error(`domain precheck failed: ${existingError.message}`);
  if (existing && String((existing as any).organization_id) !== organizationId) {
    throw new Error(`Domain "${domain}" is already registered to another organization`);
  }

  if (isPrimary) {
    await client.from("organization_domains").update({ is_primary: false }).eq("organization_id", organizationId);
  }

  const { data, error } = await client
    .from("organization_domains")
    .upsert(
      {
        organization_id: organizationId,
        domain,
        is_primary: isPrimary,
        verification_method: autoVerify ? "manual" : "dns_txt",
        verified_at: autoVerify ? new Date().toISOString() : null,
      },
      { onConflict: "domain" },
    )
    .select()
    .single();
  if (error) throw new Error(`domain save failed: ${error.message}`);

  const assigned = autoVerify
    ? await retroactivelyAssignDomainUsers(client, organizationId, domain)
    : 0;

  return { data: { domain: data, retroactively_assigned: assigned } };
}

async function verifyWorkspaceOrgDomain(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const domainId = asString(body.domain_id);
  if (!organizationId || !domainId) throw new Error("organization_id and domain_id are required");

  const { data: existing, error: existingError } = await client
    .from("organization_domains")
    .select("id, domain")
    .eq("id", domainId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (existingError) throw new Error(`domain read failed: ${existingError.message}`);
  if (!existing) throw new Error("domain not found");
  const domain = assertWorkspaceOrgDomain(String((existing as any).domain ?? ""));

  const { data, error } = await client
    .from("organization_domains")
    .update({ verified_at: new Date().toISOString(), verification_method: "manual" })
    .eq("id", domainId)
    .eq("organization_id", organizationId)
    .select()
    .single();
  if (error) throw new Error(`domain verify failed: ${error.message}`);

  const assigned = await retroactivelyAssignDomainUsers(client, organizationId, domain);
  return { data: { domain: data, retroactively_assigned: assigned } };
}

async function deleteWorkspaceOrgDomain(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const domainId = asString(body.domain_id);
  if (!organizationId || !domainId) throw new Error("organization_id and domain_id are required");
  const { error } = await client
    .from("organization_domains")
    .delete()
    .eq("id", domainId)
    .eq("organization_id", organizationId);
  if (error) throw new Error(`domain delete failed: ${error.message}`);
  return { data: { ok: true } };
}

async function saveWorkspaceOrgSso(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const provider = asString(body.provider);
  if (!organizationId) throw new Error("organization_id is required");
  if (!PROVIDERS.has(provider)) throw new Error("invalid provider");
  const isPrimary = asBool(body.is_primary, false);
  if (isPrimary) {
    await client
      .from("organization_sso_providers")
      .update({ is_primary: false })
      .eq("organization_id", organizationId);
  }

  const config = body.config && typeof body.config === "object" ? body.config : {};
  const { data, error } = await client
    .from("organization_sso_providers")
    .upsert(
      {
        organization_id: organizationId,
        provider,
        is_enabled: asBool(body.is_enabled, true),
        is_primary: isPrimary,
        config,
      },
      { onConflict: "organization_id,provider" },
    )
    .select()
    .single();
  if (error) throw new Error(`sso save failed: ${error.message}`);
  return { data: { provider: data } };
}

async function deleteWorkspaceOrgSso(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const providerId = asString(body.provider_id);
  if (!organizationId || !providerId) throw new Error("organization_id and provider_id are required");
  const { error } = await client
    .from("organization_sso_providers")
    .delete()
    .eq("id", providerId)
    .eq("organization_id", organizationId);
  if (error) throw new Error(`sso delete failed: ${error.message}`);
  return { data: { ok: true } };
}

async function adjustWorkspaceOrgCredits(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const delta = asInt(body.delta ?? body.amount);
  if (!organizationId || delta === 0) throw new Error("organization_id and non-zero delta are required");
  const { data, error } = await client.rpc("admin_adjust_org_credit_pool", {
    p_org_id: organizationId,
    p_delta: delta,
    p_actor_id: null,
    p_description: asString(body.description) || "ERP workspace org credit adjustment",
  });
  if (error) throw new Error(`credit adjustment failed: ${error.message}`);
  if (data === -1) throw new Error("credit adjustment would make available credits negative");
  return { data: { credit_pool: data } };
}

async function bootstrapCmoWorkspaceOrg(client: SupabaseClient) {
  const saved = await saveWorkspaceOrg(client, {
    name: "CMO Group",
    slug: "cmo-group",
    display_name: "CMO Group",
    type: "enterprise",
    status: "active",
    primary_contact_email: "admin@cmo-group.com",
    primary_domain: "cmo-group.com",
    provider: "email_otp",
  });
  const org = (saved as any).data.org;

  const current = Number(org.credit_pool ?? 0);
  if (current < 1000000) {
    await adjustWorkspaceOrgCredits(client, {
      organization_id: org.id,
      delta: 1000000 - current,
      description: "CMO Group initial shared credits",
    });
  }
  const refreshed = await client.from("organizations").select("*").eq("id", org.id).single();
  if (refreshed.error) throw new Error(`CMO refresh failed: ${refreshed.error.message}`);
  return { data: { org: refreshed.data } };
}

async function listWorkspaceTeams(client: SupabaseClient) {
  const [classesRes, orgsRes, membersRes] = await Promise.all([
    client
      .from("classes")
      .select("id,organization_id,name,code,status,credit_pool,credit_pool_consumed,credit_policy,credit_amount,primary_instructor_id,created_at,updated_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    client.from("organizations").select("id,name,display_name,slug,type,status").is("deleted_at", null),
    client.from("class_members").select("class_id,status"),
  ]);
  if (classesRes.error) throw new Error(`teams read failed: ${classesRes.error.message}`);
  if (orgsRes.error) throw new Error(`organizations read failed: ${orgsRes.error.message}`);
  if (membersRes.error) throw new Error(`team members read failed: ${membersRes.error.message}`);

  const orgById = new Map((orgsRes.data ?? []).map((o: any) => [o.id, o]));
  const memberCount = new Map<string, number>();
  for (const row of membersRes.data ?? []) {
    if ((row as any).status !== "active") continue;
    const key = String((row as any).class_id);
    memberCount.set(key, (memberCount.get(key) ?? 0) + 1);
  }

  const teams = (classesRes.data ?? []).map((row: any) => ({
    ...row,
    organization: orgById.get(row.organization_id) ?? null,
    credit_available: Math.max(0, Number(row.credit_pool ?? 0) - Number(row.credit_pool_consumed ?? 0)),
    member_count: memberCount.get(row.id) ?? 0,
  }));
  return { data: { teams } };
}

async function saveWorkspaceTeam(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const name = asString(body.name);
  if (!organizationId || !name) throw new Error("organization_id and name are required");
  const id = asString(body.id);
  const settings = body.settings && typeof body.settings === "object"
    ? body.settings as Record<string, unknown>
    : {};
  const schedule = asString(body.schedule);
  if (schedule) settings.schedule = schedule;
  const row = {
    organization_id: organizationId,
    name,
    code: asString(body.code).toUpperCase() || randomClassCode(),
    status: asString(body.status, "active"),
    credit_policy: asString(body.credit_policy, "manual"),
    credit_amount: Math.max(0, asInt(body.credit_amount, 0)),
    description: asString(body.description) || null,
    term: asString(body.term) || null,
    year: asInt(body.year, 0) || null,
    max_students: asInt(body.max_students, 0) || null,
    start_date: asString(body.start_date) || null,
    end_date: asString(body.end_date) || null,
    reset_day_of_month: Math.min(28, Math.max(1, asInt(body.reset_day_of_month, 1))),
    reset_day_of_week: Math.min(6, Math.max(0, asInt(body.reset_day_of_week, 1))),
    settings,
  };

  const result = id
    ? await client.from("classes").update(row).eq("id", id).select("*").single()
    : await client.from("classes").insert(row).select("*").single();
  if (result.error) throw new Error(`team save failed: ${result.error.message}`);

  const initialCredits = Math.max(0, asInt(body.initial_credits, 0));
  if (!id && initialCredits > 0) {
    await allocateWorkspaceTeamCredits(client, {
      class_id: (result.data as any).id,
      delta: initialCredits,
      description: "Initial team credits from ERP",
    });
  }
  return { data: { team: result.data } };
}

async function allocateWorkspaceTeamCredits(client: SupabaseClient, body: Record<string, unknown>) {
  const classId = asString(body.class_id);
  const delta = asInt(body.delta ?? body.amount);
  if (!classId || delta === 0) throw new Error("class_id and non-zero delta are required");
  const { data, error } = await client.rpc("admin_allocate_class_pool", {
    p_class_id: classId,
    p_delta: delta,
    p_actor_id: null,
    p_description: asString(body.description) || "ERP team credit allocation",
  });
  if (error) throw new Error(`team credit allocation failed: ${error.message}`);
  if (data === -1) throw new Error("organization does not have enough unallocated credits");
  if (data === -2) throw new Error("team has already consumed too many credits to revoke that amount");
  return { data: { credit_pool: data } };
}

async function hydrateWorkspaceMembers(client: SupabaseClient, rows: any[]) {
  const ids = [...new Set(rows.map((row) => String(row.user_id ?? "")).filter(Boolean))];
  const authById = new Map<string, { email: string | null; display_name: string | null }>();

  await Promise.all(ids.map(async (id) => {
    try {
      const { data } = await client.auth.admin.getUserById(id);
      const user = data?.user;
      authById.set(id, {
        email: user?.email ?? null,
        display_name: (user?.user_metadata?.display_name ?? user?.user_metadata?.full_name ?? null) as string | null,
      });
    } catch {
      authById.set(id, { email: null, display_name: null });
    }
  }));

  const profilesById = new Map<string, any>();
  if (ids.length > 0) {
    const { data } = await client
      .from("profiles")
      .select("user_id,display_name,avatar_url,organization_id,account_type")
      .in("user_id", ids);
    for (const profile of data ?? []) {
      profilesById.set(String((profile as any).user_id), profile);
    }
  }

  return rows.map((row) => {
    const auth = authById.get(String(row.user_id)) ?? { email: null, display_name: null };
    const profile = profilesById.get(String(row.user_id));
    return {
      ...row,
      email: auth.email,
      display_name: profile?.display_name ?? auth.display_name,
      avatar_url: profile?.avatar_url ?? null,
      account_type: profile?.account_type ?? null,
    };
  });
}

async function listWorkspaceOrgMembers(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  if (!organizationId) throw new Error("organization_id is required");

  const [membersRes, teamsRes, invitesRes] = await Promise.all([
    client
      .from("organization_memberships")
      .select("id,organization_id,user_id,role,status,source,team_id,requested_at,approved_at,approved_by,invited_by,joined_at,suspended_at,created_at,updated_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false }),
    client
      .from("classes")
      .select("id,organization_id,name,code,status,credit_pool,credit_pool_consumed,credit_policy,credit_amount,created_at,updated_at")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    client
      .from("organization_member_invites")
      .select("id,organization_id,email,role,team_id,status,expires_at,created_at,updated_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false }),
  ]);

  if (membersRes.error) throw new Error(`members read failed: ${membersRes.error.message}`);
  if (teamsRes.error) throw new Error(`teams read failed: ${teamsRes.error.message}`);
  if (invitesRes.error) throw new Error(`invites read failed: ${invitesRes.error.message}`);

  const teams = (teamsRes.data ?? []).map((team: any) => ({
    ...team,
    credit_available: Math.max(0, Number(team.credit_pool ?? 0) - Number(team.credit_pool_consumed ?? 0)),
  }));
  const teamById = new Map(teams.map((team: any) => [team.id, team]));
  const members = (await hydrateWorkspaceMembers(client, membersRes.data ?? [])).map((member: any) => ({
    ...member,
    team: member.team_id ? teamById.get(member.team_id) ?? null : null,
  }));

  return {
    data: {
      members,
      teams,
      invites: invitesRes.data ?? [],
    },
  };
}

async function normalizeWorkspaceOrgTeamId(
  client: SupabaseClient,
  organizationId: string,
  rawTeamId: unknown,
): Promise<string | null> {
  const teamId = rawTeamId === null ? "" : asString(rawTeamId);
  if (!teamId || teamId === "__none" || teamId === "none") return null;

  const { data: team, error } = await client
    .from("classes")
    .select("id")
    .eq("id", teamId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`team lookup failed: ${error.message}`);
  if (!team) throw new Error("team does not belong to this organization");
  return teamId;
}

async function addWorkspaceOrgMember(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const email = asString(body.email).toLowerCase();
  if (!organizationId || !email) throw new Error("organization_id and email are required");
  if (!email.includes("@")) throw new Error("valid email is required");

  const role = asString(body.role, "member") === "org_admin" ? "org_admin" : "member";
  const teamId = await normalizeWorkspaceOrgTeamId(client, organizationId, body.team_id);

  const { data: org, error: orgError } = await client
    .from("organizations")
    .select("id,type,status")
    .eq("id", organizationId)
    .eq("type", "enterprise")
    .is("deleted_at", null)
    .maybeSingle();
  if (orgError) throw new Error(`enterprise lookup failed: ${orgError.message}`);
  if (!org) throw new Error("enterprise account not found");

  const user = await findAuthUserByEmail(client, email);
  const now = new Date().toISOString();

  if (user) {
    const { error: profileError } = await client.from("profiles").upsert(
      {
        user_id: user.id,
        organization_id: organizationId,
        account_type: "org_user",
        updated_at: now,
      },
      { onConflict: "user_id" },
    );
    if (profileError) throw new Error(`profile update failed: ${profileError.message}`);

    const { data: membership, error: membershipError } = await client
      .from("organization_memberships")
      .upsert(
        {
          organization_id: organizationId,
          user_id: user.id,
          role,
          status: "active",
          source: "manual",
          team_id: teamId,
          joined_at: now,
          approved_at: now,
          suspended_at: null,
          updated_at: now,
        },
        { onConflict: "organization_id,user_id" },
      )
      .select("id,organization_id,user_id,role,status,source,team_id,requested_at,approved_at,approved_by,invited_by,joined_at,suspended_at,created_at,updated_at")
      .single();
    if (membershipError) throw new Error(`member save failed: ${membershipError.message}`);

    const members = await hydrateWorkspaceMembers(client, [membership]);
    return { data: { mode: "activated", member: members[0] } };
  }

  const { data: invite, error: inviteError } = await client
    .from("organization_member_invites")
    .upsert(
      {
        organization_id: organizationId,
        email,
        role,
        team_id: teamId,
        status: "pending",
        expires_at: null,
        updated_at: now,
      },
      { onConflict: "organization_id,email" },
    )
    .select("id,organization_id,email,role,team_id,status,expires_at,created_at,updated_at")
    .single();
  if (inviteError) throw new Error(`member invite failed: ${inviteError.message}`);

  return { data: { mode: "invited", invite } };
}

async function updateWorkspaceOrgMember(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const membershipId = asString(body.membership_id);
  if (!organizationId || !membershipId) throw new Error("organization_id and membership_id are required");

  const role = asString(body.role);
  const status = asString(body.status);
  const hasTeam = Object.prototype.hasOwnProperty.call(body, "team_id");

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (role) {
    if (role !== "org_admin" && role !== "member") throw new Error("invalid member role");
    updates.role = role;
  }
  if (status) {
    if (!["active", "pending", "invited", "rejected", "suspended"].includes(status)) {
      throw new Error("invalid member status");
    }
    updates.status = status;
    if (status === "active") {
      updates.approved_at = new Date().toISOString();
      updates.suspended_at = null;
    }
    if (status === "suspended") updates.suspended_at = new Date().toISOString();
  }
  if (hasTeam) {
    const teamId = await normalizeWorkspaceOrgTeamId(client, organizationId, body.team_id);
    if (!teamId) {
      updates.team_id = null;
    } else {
      updates.team_id = teamId;
    }
  }
  if (Object.keys(updates).length === 1) throw new Error("no member changes supplied");

  const { data, error } = await client
    .from("organization_memberships")
    .update(updates)
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .select("id,organization_id,user_id,role,status,source,team_id,requested_at,approved_at,approved_by,invited_by,joined_at,suspended_at,created_at,updated_at")
    .single();
  if (error) throw new Error(`member update failed: ${error.message}`);

  if ((data as any).status === "active") {
    await client.from("profiles").update({
      organization_id: organizationId,
      account_type: "org_user",
      updated_at: new Date().toISOString(),
    }).eq("user_id", (data as any).user_id);
  } else if (["suspended", "rejected"].includes(String((data as any).status))) {
    const { count, error: activeMembershipError } = await client
      .from("organization_memberships")
      .select("id", { count: "exact", head: true })
      .eq("user_id", (data as any).user_id)
      .eq("status", "active");
    if (activeMembershipError) {
      console.warn(
        "[admin_workspace_orgs] active membership check skipped:",
        activeMembershipError.message,
      );
    } else if (!count) {
      await client.from("profiles").update({
        organization_id: null,
        account_type: "consumer",
        updated_at: new Date().toISOString(),
      }).eq("user_id", (data as any).user_id);
    }
  }

  const members = await hydrateWorkspaceMembers(client, [data]);
  return { data: { member: members[0] } };
}

function rowDate(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

async function listWorkspaceEducation(client: SupabaseClient) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [orgsRes, domainsRes, providersRes, classesRes, membersRes, orgMembersRes, profilesRes] = await Promise.all([
    client
      .from("organizations")
      .select("id,name,slug,display_name,type,status,logo_url,brand_color,primary_contact_email,credit_pool,credit_pool_allocated,settings,created_at,updated_at")
      .in("type", ["school", "university"])
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    client
      .from("organization_domains")
      .select("id,organization_id,domain,is_primary,verification_method,verified_at,created_at")
      .order("is_primary", { ascending: false }),
    client
      .from("organization_sso_providers")
      .select("id,organization_id,provider,is_enabled,is_primary,config,created_at,updated_at")
      .order("is_primary", { ascending: false }),
    client
      .from("classes")
      .select("id,organization_id,name,code,description,term,year,status,start_date,end_date,max_students,primary_instructor_id,credit_policy,credit_amount,credit_pool,credit_pool_consumed,settings,created_at,updated_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    client
      .from("class_members")
      .select("id,class_id,user_id,role,status,student_code,credit_cap,credits_balance,credits_lifetime_received,credits_lifetime_used,joined_at,created_at,updated_at"),
    client
      .from("organization_memberships")
      .select("id,organization_id,user_id,role,status,joined_at,created_at,updated_at")
      .eq("role", "org_admin"),
    client
      .from("profiles")
      .select("user_id,display_name,avatar_url,organization_id,account_type"),
  ]);

  if (orgsRes.error) throw new Error(`education orgs read failed: ${orgsRes.error.message}`);
  if (domainsRes.error) throw new Error(`education domains read failed: ${domainsRes.error.message}`);
  if (providersRes.error) throw new Error(`education providers read failed: ${providersRes.error.message}`);
  if (classesRes.error) throw new Error(`education classes read failed: ${classesRes.error.message}`);
  if (membersRes.error) throw new Error(`education members read failed: ${membersRes.error.message}`);
  if (orgMembersRes.error) throw new Error(`education org admins read failed: ${orgMembersRes.error.message}`);
  if (profilesRes.error) throw new Error(`education profiles read failed: ${profilesRes.error.message}`);

  const orgIds = new Set((orgsRes.data ?? []).map((org: any) => String(org.id)));
  const classRows = (classesRes.data ?? []).filter((row: any) => orgIds.has(String(row.organization_id)));
  const classIds = new Set(classRows.map((row: any) => String(row.id)));
  const members = (membersRes.data ?? []).filter((row: any) => classIds.has(String((row as any).class_id)));
  const orgAdminMembers = (orgMembersRes.data ?? []).filter((row: any) => orgIds.has(String(row.organization_id)));
  const userIds = Array.from(new Set([
    ...members.map((row: any) => String(row.user_id)),
    ...orgAdminMembers.map((row: any) => String(row.user_id)),
  ]));

  const usersById = new Map<string, { email: string | null }>();
  try {
    for (let page = 1; page <= 20; page += 1) {
      const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      for (const user of data?.users ?? []) {
        if (userIds.includes(user.id)) usersById.set(user.id, { email: user.email ?? null });
      }
      if ((data?.users ?? []).length < 1000) break;
    }
  } catch (err) {
    console.warn("[admin_workspace_orgs] education auth user lookup skipped:", err instanceof Error ? err.message : String(err));
  }

  const profilesById = new Map((profilesRes.data ?? []).map((p: any) => [String(p.user_id), p]));

  const domainsByOrg = new Map<string, unknown[]>();
  for (const row of domainsRes.data ?? []) {
    const orgId = String((row as any).organization_id);
    if (!orgIds.has(orgId)) continue;
    domainsByOrg.set(orgId, [...(domainsByOrg.get(orgId) ?? []), row]);
  }
  const providersByOrg = new Map<string, unknown[]>();
  for (const row of providersRes.data ?? []) {
    const orgId = String((row as any).organization_id);
    if (!orgIds.has(orgId)) continue;
    providersByOrg.set(orgId, [...(providersByOrg.get(orgId) ?? []), row]);
  }

  const adminsByOrg = new Map<string, any[]>();
  for (const row of orgAdminMembers as any[]) {
    const orgId = String(row.organization_id);
    const userId = String(row.user_id);
    const profile = profilesById.get(userId);
    adminsByOrg.set(orgId, [
      ...(adminsByOrg.get(orgId) ?? []),
      {
        ...row,
        email: usersById.get(userId)?.email ?? null,
        display_name: profile?.display_name ?? null,
        avatar_url: profile?.avatar_url ?? null,
      },
    ]);
  }

  const membersByClass = new Map<string, any[]>();
  for (const row of members as any[]) {
    const classId = String(row.class_id);
    membersByClass.set(classId, [...(membersByClass.get(classId) ?? []), row]);
  }

  let generations: any[] = [];
  try {
    const { data, error } = await client
      .from("workspace_generation_events")
      .select("id,user_id,organization_id,class_id,feature,model,provider,credits_spent,created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) throw error;
    generations = (data ?? []).filter((row: any) =>
      (row.organization_id && orgIds.has(String(row.organization_id))) ||
      (row.class_id && classIds.has(String(row.class_id))) ||
      (row.user_id && userIds.includes(String(row.user_id)))
    );
  } catch (err) {
    console.warn("[admin_workspace_orgs] education generation events skipped:", err instanceof Error ? err.message : String(err));
  }

  let sessions: any[] = [];
  try {
    const { data, error } = await client
      .from("education_class_sessions")
      .select("id,organization_id,class_id,title,status,starts_at,ends_at,settings,created_at,updated_at")
      .is("deleted_at", null)
      .order("starts_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    sessions = (data ?? []).filter((row: any) => classIds.has(String(row.class_id)));
  } catch (err) {
    console.warn("[admin_workspace_orgs] education sessions skipped:", err instanceof Error ? err.message : String(err));
  }

  let presence: any[] = [];
  try {
    const { data, error } = await client
      .from("education_student_screen_presence")
      .select("id,organization_id,class_id,session_id,user_id,status,screen_state,current_workspace_id,current_canvas_id,current_project_id,current_activity,screen_thumbnail_url,screen_stream_url,last_seen_at,metadata,updated_at")
      .order("last_seen_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    presence = (data ?? []).filter((row: any) => classIds.has(String(row.class_id)));
  } catch (err) {
    console.warn("[admin_workspace_orgs] education screen presence skipped:", err instanceof Error ? err.message : String(err));
  }

  const generationsByClass = new Map<string, any[]>();
  const generationsByUser = new Map<string, any[]>();
  const modelUsage = new Map<string, { model: string; feature: string; count: number; credits: number }>();
  for (const row of generations) {
    const classId = row.class_id ? String(row.class_id) : null;
    const userId = row.user_id ? String(row.user_id) : null;
    if (classId) generationsByClass.set(classId, [...(generationsByClass.get(classId) ?? []), row]);
    if (userId) generationsByUser.set(userId, [...(generationsByUser.get(userId) ?? []), row]);
    const key = `${row.feature ?? "other"}:${row.model ?? "unknown"}`;
    const current = modelUsage.get(key) ?? {
      model: String(row.model ?? "unknown"),
      feature: String(row.feature ?? "other"),
      count: 0,
      credits: 0,
    };
    current.count += 1;
    current.credits += Number(row.credits_spent ?? 0);
    modelUsage.set(key, current);
  }

  const presenceByClass = new Map<string, any[]>();
  const presenceByUser = new Map<string, any>();
  const onlineCutoff = Date.now() - 2 * 60 * 1000;
  for (const row of presence) {
    const classId = String(row.class_id);
    presenceByClass.set(classId, [...(presenceByClass.get(classId) ?? []), row]);
    presenceByUser.set(String(row.user_id), row);
  }

  const classes = classRows.map((klass: any) => {
    const classMembers = membersByClass.get(String(klass.id)) ?? [];
    const students = classMembers.filter((m) => m.role === "student");
    const teachers = classMembers.filter((m) => m.role === "teacher");
    const gen = generationsByClass.get(String(klass.id)) ?? [];
    const liveRows = presenceByClass.get(String(klass.id)) ?? [];
    const online = liveRows.filter((row) => {
      const seen = new Date(row.last_seen_at ?? 0).getTime();
      return seen >= onlineCutoff && row.status !== "offline";
    });
    const lowCredit = students.filter((m) => Number(m.credits_balance ?? 0) <= 30).length;
    return {
      ...klass,
      member_count: students.length,
      teacher_count: teachers.length,
      low_credit_count: lowCredit,
      online_count: online.length,
      help_requested_count: liveRows.filter((row) => row.status === "help_requested").length,
      generation_count_30d: gen.length,
      credits_spent_30d: gen.reduce((sum, row) => sum + Number(row.credits_spent ?? 0), 0),
      credit_available: Math.max(0, Number(klass.credit_pool ?? 0) - Number(klass.credit_pool_consumed ?? 0)),
      schedule: (klass.settings && typeof klass.settings === "object" ? (klass.settings as any).schedule : null) ?? null,
    };
  });

  const classesByOrg = new Map<string, any[]>();
  for (const klass of classes) {
    const orgId = String(klass.organization_id);
    classesByOrg.set(orgId, [...(classesByOrg.get(orgId) ?? []), klass]);
  }

  const students = members
    .filter((row: any) => row.role === "student")
    .map((row: any) => {
      const profile = profilesById.get(String(row.user_id));
      const gen = generationsByUser.get(String(row.user_id)) ?? [];
      const live = presenceByUser.get(String(row.user_id)) ?? null;
      const lastGen = gen[0] ?? null;
      const credits = Number(row.credits_balance ?? 0);
      const lastSeen = live?.last_seen_at ?? lastGen?.created_at ?? row.updated_at ?? row.created_at;
      const staleDays = lastSeen ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 86_400_000) : 999;
      const risk =
        row.status !== "active" ? "blocked" :
        credits <= 15 ? "needs_credit" :
        staleDays >= 7 ? "inactive" :
        gen.length === 0 ? "not_started" :
        "healthy";
      return {
        ...row,
        email: usersById.get(String(row.user_id))?.email ?? null,
        display_name: profile?.display_name ?? null,
        avatar_url: profile?.avatar_url ?? null,
        last_activity_at: rowDate(lastSeen),
        last_model: lastGen?.model ?? null,
        generation_count_30d: gen.length,
        credits_spent_30d: gen.reduce((sum, item) => sum + Number(item.credits_spent ?? 0), 0),
        live_status: live?.status ?? "offline",
        screen_state: live?.screen_state ?? "not_shared",
        current_activity: live?.current_activity ?? null,
        screen_thumbnail_url: live?.screen_thumbnail_url ?? null,
        screen_stream_url: live?.screen_stream_url ?? null,
        risk,
      };
    });

  const institutions = (orgsRes.data ?? []).map((org: any) => {
    const orgClasses = classesByOrg.get(String(org.id)) ?? [];
    const orgClassIds = new Set(orgClasses.map((klass) => String(klass.id)));
    const orgStudents = students.filter((student) => orgClassIds.has(String(student.class_id)));
    const orgPresence = presence.filter((row) => orgClassIds.has(String(row.class_id)));
    const online = orgPresence.filter((row) => {
      const seen = new Date(row.last_seen_at ?? 0).getTime();
      return seen >= onlineCutoff && row.status !== "offline";
    }).length;
    const allocated = Number(org.credit_pool_allocated ?? 0);
    const pool = Number(org.credit_pool ?? 0);
    return {
      ...org,
      domains: domainsByOrg.get(String(org.id)) ?? [],
      sso_providers: providersByOrg.get(String(org.id)) ?? [],
      admins: adminsByOrg.get(String(org.id)) ?? [],
      admin_count: (adminsByOrg.get(String(org.id)) ?? []).filter((admin) => admin.status === "active").length,
      class_count: orgClasses.length,
      student_count: orgStudents.length,
      online_count: online,
      at_risk_count: orgStudents.filter((student) => student.risk !== "healthy").length,
      credit_available: Math.max(0, pool - allocated),
    };
  });

  const totals = {
    institutions: institutions.length,
    classes: classes.length,
    students: students.length,
    online: institutions.reduce((sum, org: any) => sum + Number(org.online_count ?? 0), 0),
    at_risk: students.filter((student) => student.risk !== "healthy").length,
    credits_available: institutions.reduce((sum, org: any) => sum + Number(org.credit_available ?? 0), 0),
    credits_spent_30d: generations.reduce((sum, row) => sum + Number(row.credits_spent ?? 0), 0),
    generations_30d: generations.length,
  };

  return {
    data: {
      totals,
      institutions,
      classes,
      students,
      sessions,
      presence,
      model_usage: Array.from(modelUsage.values()).sort((a, b) => b.credits - a.credits),
      generated_at: new Date().toISOString(),
    },
  };
}

async function saveWorkspaceEducationInstitution(client: SupabaseClient, body: Record<string, unknown>) {
  const type = asString(body.type, "university");
  if (type !== "university" && type !== "school") {
    throw new Error("education institution type must be school or university");
  }
  const saved = await saveWorkspaceOrg(client, {
    ...body,
    type,
    provider: asString(body.provider, "email_otp"),
  });
  const adminEmail = asString(body.admin_email).toLowerCase();
  if (!adminEmail) return saved;

  const orgId = String((saved as any)?.data?.org?.id ?? "");
  const adminResult = orgId
    ? await addWorkspaceEducationAdmin(client, { organization_id: orgId, email: adminEmail })
    : null;
  return { data: { ...(saved as any).data, admin_result: (adminResult as any)?.data ?? null } };
}

async function addWorkspaceEducationAdmin(client: SupabaseClient, body: Record<string, unknown>) {
  const organizationId = asString(body.organization_id);
  const email = asString(body.email).toLowerCase();
  if (!organizationId || !email) throw new Error("organization_id and email are required");

  const { data: org, error: orgError } = await client
    .from("organizations")
    .select("id,type")
    .eq("id", organizationId)
    .in("type", ["school", "university"])
    .is("deleted_at", null)
    .maybeSingle();
  if (orgError) throw new Error(`education institution lookup failed: ${orgError.message}`);
  if (!org) throw new Error("education institution not found");

  const user = await findAuthUserByEmail(client, email);
  if (!user) {
    return {
      data: {
        ok: false,
        error: "user_not_found",
        message: `No workspace user found for ${email}. Ask the admin to sign in once before granting university admin access.`,
      },
    };
  }

  const now = new Date().toISOString();
  const { error: profileError } = await client.from("profiles").upsert(
    {
      user_id: user.id,
      organization_id: organizationId,
      account_type: "org_user",
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (profileError) throw new Error(`profile update failed: ${profileError.message}`);

  const { data: membership, error: membershipError } = await client
    .from("organization_memberships")
    .upsert(
      {
        organization_id: organizationId,
        user_id: user.id,
        role: "org_admin",
        status: "active",
        suspended_at: null,
        updated_at: now,
      },
      { onConflict: "organization_id,user_id" },
    )
    .select()
    .single();
  if (membershipError) throw new Error(`university admin save failed: ${membershipError.message}`);

  return { data: { ok: true, admin: { ...membership, email: user.email } } };
}

async function saveWorkspaceEducationClass(client: SupabaseClient, body: Record<string, unknown>) {
  return saveWorkspaceTeam(client, {
    ...body,
    credit_policy: asString(body.credit_policy, "monthly_reset"),
    credit_amount: asInt(body.credit_amount, 200),
  });
}

async function addWorkspaceEducationStudent(client: SupabaseClient, body: Record<string, unknown>) {
  const classId = asString(body.class_id);
  const email = asString(body.email).toLowerCase();
  const studentCode = asString(body.student_code);
  const initialCredits = Math.max(0, asInt(body.initial_credits, 0));
  if (!classId || !email) throw new Error("class_id and email are required");

  const { data: klass, error: classError } = await client
    .from("classes")
    .select("id, organization_id")
    .eq("id", classId)
    .is("deleted_at", null)
    .maybeSingle();
  if (classError) throw new Error(`class lookup failed: ${classError.message}`);
  if (!klass) throw new Error("class not found");

  let userId = "";
  for (let page = 1; page <= 20 && !userId; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth users read failed: ${error.message}`);
    const found = (data?.users ?? []).find((user) => String(user.email ?? "").toLowerCase() === email);
    if (found) userId = found.id;
    if ((data?.users ?? []).length < 1000) break;
  }
  if (!userId) {
    return {
      data: {
        ok: false,
        error: "user_not_found",
        message: `No workspace user found for ${email}. Ask the student to sign in once, or use an enrollment QR code.`,
      },
    };
  }

  await client.from("profiles").update({
    organization_id: (klass as any).organization_id,
    account_type: "org_user",
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);

  await client.from("organization_memberships").upsert({
    organization_id: (klass as any).organization_id,
    user_id: userId,
    role: "member",
    status: "active",
    updated_at: new Date().toISOString(),
  }, { onConflict: "organization_id,user_id" });

  const { data: member, error } = await client
    .from("class_members")
    .upsert({
      class_id: classId,
      user_id: userId,
      role: "student",
      status: "active",
      student_code: studentCode || null,
      joined_at: new Date().toISOString(),
    }, { onConflict: "class_id,user_id" })
    .select()
    .single();
  if (error) throw new Error(`student add failed: ${error.message}`);

  if (initialCredits > 0) {
    const { data, error: creditError } = await client.rpc("admin_adjust_class_member_credits", {
      p_class_id: classId,
      p_user_id: userId,
      p_delta: initialCredits,
      p_actor_id: null,
      p_reason: "Initial class credits from ERP education admin",
    });
    if (creditError) throw new Error(`student credit grant failed: ${creditError.message}`);
    if (data === -1) throw new Error("class does not have enough unconsumed credits");
  }

  return { data: { ok: true, member } };
}

async function adjustWorkspaceEducationStudentCredits(client: SupabaseClient, body: Record<string, unknown>) {
  const classId = asString(body.class_id);
  const userId = asString(body.user_id);
  const delta = asInt(body.delta ?? body.amount);
  if (!classId || !userId || delta === 0) throw new Error("class_id, user_id and non-zero delta are required");
  const { data, error } = await client.rpc("admin_adjust_class_member_credits", {
    p_class_id: classId,
    p_user_id: userId,
    p_delta: delta,
    p_actor_id: null,
    p_reason: asString(body.reason) || "ERP education credit adjustment",
  });
  if (error) throw new Error(`student credit adjustment failed: ${error.message}`);
  if (data === -1) throw new Error("class does not have enough unconsumed credits");
  return { data: { balance: data } };
}

async function saveWorkspaceEducationSession(client: SupabaseClient, body: Record<string, unknown>) {
  const id = asString(body.id);
  const classId = asString(body.class_id);
  const title = asString(body.title);
  if (!classId || !title) throw new Error("class_id and title are required");
  const { data: klass, error: classError } = await client
    .from("classes")
    .select("organization_id")
    .eq("id", classId)
    .maybeSingle();
  if (classError) throw new Error(`class lookup failed: ${classError.message}`);
  if (!klass) throw new Error("class not found");
  const row = {
    organization_id: (klass as any).organization_id,
    class_id: classId,
    title,
    status: asString(body.status, "scheduled"),
    starts_at: asString(body.starts_at) || null,
    ends_at: asString(body.ends_at) || null,
    settings: body.settings && typeof body.settings === "object" ? body.settings : {},
  };
  const result = id
    ? await client.from("education_class_sessions").update(row).eq("id", id).select("*").single()
    : await client.from("education_class_sessions").insert(row).select("*").single();
  if (result.error) throw new Error(`education session save failed: ${result.error.message}`);
  return { data: { session: result.data } };
}

async function createWorkspaceEducationCode(client: SupabaseClient, body: Record<string, unknown>) {
  const classId = asString(body.class_id);
  if (!classId) throw new Error("class_id is required");
  const { data: klass, error: classError } = await client
    .from("classes")
    .select("code")
    .eq("id", classId)
    .maybeSingle();
  if (classError) throw new Error(`class lookup failed: ${classError.message}`);
  if (!klass) throw new Error("class not found");

  const code = `${String((klass as any).code ?? "CLASS").toUpperCase()}-${randomClassCode().replace("-", "")}`;
  const { data, error } = await client
    .from("class_enrollment_codes")
    .insert({
      class_id: classId,
      code,
      flow: asString(body.flow, "auto_approve"),
      max_uses: asInt(body.max_uses, 0) || null,
      expires_at: asString(body.expires_at) || null,
    })
    .select()
    .single();
  if (error) throw new Error(`education code create failed: ${error.message}`);
  return { data: { code: data } };
}

const ACTIONS: Record<string, (client: SupabaseClient, body: Record<string, unknown>) => Promise<unknown>> = {
  list_workspace_orgs: (client) => listWorkspaceOrgs(client),
  save_workspace_org: saveWorkspaceOrg,
  bootstrap_cmo_workspace_org: (client) => bootstrapCmoWorkspaceOrg(client),
  add_workspace_org_domain: addWorkspaceOrgDomain,
  verify_workspace_org_domain: verifyWorkspaceOrgDomain,
  delete_workspace_org_domain: deleteWorkspaceOrgDomain,
  save_workspace_org_sso: saveWorkspaceOrgSso,
  delete_workspace_org_sso: deleteWorkspaceOrgSso,
  adjust_workspace_org_credits: adjustWorkspaceOrgCredits,
  list_workspace_teams: (client) => listWorkspaceTeams(client),
  save_workspace_team: saveWorkspaceTeam,
  allocate_workspace_team_credits: allocateWorkspaceTeamCredits,
  list_workspace_org_members: listWorkspaceOrgMembers,
  add_workspace_org_member: addWorkspaceOrgMember,
  update_workspace_org_member: updateWorkspaceOrgMember,
  list_workspace_education_dashboard: (client) => listWorkspaceEducation(client),
  save_workspace_education_institution: saveWorkspaceEducationInstitution,
  add_workspace_education_admin: addWorkspaceEducationAdmin,
  save_workspace_education_class: saveWorkspaceEducationClass,
  add_workspace_education_student: addWorkspaceEducationStudent,
  adjust_workspace_education_student_credits: adjustWorkspaceEducationStudentCredits,
  save_workspace_education_session: saveWorkspaceEducationSession,
  create_workspace_education_code: createWorkspaceEducationCode,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // ── ADMIN-JWT GATE TEMPORARILY DISABLED ───────────────────────
  // See companion note in admin_workspace_pricing/index.ts. Re-enable
  // once `ADMIN_AUTH_SUPABASE_ANON_KEY` is set.
  //   const adminPayload = await verifyAdminJwt(req);
  //   if (!adminPayload) return unauthorizedResponse(CORS_HEADERS);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const action = asString(body.action);
  const handler = ACTIONS[action];
  if (!handler) return json({ error: `Unsupported action: ${action}` }, 400);

  try {
    const result = await handler(admin(), body);
    return json(result);
  } catch (err) {
    console.error(`[admin_workspace_orgs] ${action} failed:`, err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
