/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
      "x-supabase-client-platform",
      "x-supabase-client-platform-version",
      "x-supabase-client-runtime",
      "x-supabase-client-runtime-version",
    ].join(", "),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ORG_TOPUP_RATIO_THB_TO_CREDITS = 50;
const MIN_ORG_TOPUP_THB = 500;
const MAX_ORG_TOPUP_THB = 100_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

function userClient(authHeader: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function stripeClient() {
  const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!key) throw new Error("Stripe is not configured");
  return new Stripe(key, { apiVersion: "2025-08-27.basil" });
}

function slugCode(input: string): string {
  const base = input
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 14);
  return base || `TEAM-${Math.floor(Math.random() * 9999)}`;
}

function emailDomain(email: string): string {
  return email.toLowerCase().split("@")[1] ?? "";
}

async function currentUser(req: Request): Promise<User | null> {
  const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const { data, error } = await userClient(authHeader).auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

async function findUserByEmail(client: SupabaseClient, email: string): Promise<User | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`user lookup failed: ${error.message}`);
    const users = data?.users ?? [];
    const match = users.find((user) => String(user.email ?? "").toLowerCase() === target);
    if (match) return match;
    if (users.length < 1000) return null;
  }
  return null;
}

async function hydrateUsers(client: SupabaseClient, rows: any[]) {
  const ids = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
  const byId = new Map<string, { email: string | null; name: string | null }>();
  await Promise.all(ids.map(async (id) => {
    const { data } = await client.auth.admin.getUserById(id);
    const user = data?.user;
    byId.set(id, {
      email: user?.email ?? null,
      name: (user?.user_metadata?.display_name ?? user?.user_metadata?.full_name ?? null) as string | null,
    });
  }));
  return rows.map((row) => ({
    ...row,
    email: byId.get(row.user_id)?.email ?? null,
    display_name: byId.get(row.user_id)?.name ?? null,
  }));
}

async function orgAdminContext(client: SupabaseClient, user: User) {
  const { data: membership, error } = await client
    .from("organization_memberships")
    .select("id,organization_id,role,status")
    .eq("user_id", user.id)
    .eq("role", "org_admin")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  if (!membership) return null;
  return membership as any;
}

async function ensureDomainJoinRequest(client: SupabaseClient, user: User) {
  if (!user.email) return;
  const { data: existing, error: existingError } = await client
    .from("organization_memberships")
    .select("id,status")
    .eq("user_id", user.id)
    .in("status", ["active", "pending", "invited"])
    .limit(1);
  if (existingError) throw new Error(`membership lookup failed: ${existingError.message}`);
  if ((existing ?? []).length > 0) return;

  const { data: orgId, error: orgError } = await client.rpc("org_from_email", { p_email: user.email });
  if (orgError) throw new Error(`domain lookup failed: ${orgError.message}`);
  if (!orgId) return;

  const { error } = await client.from("organization_memberships").upsert(
    {
      organization_id: orgId,
      user_id: user.id,
      role: "member",
      status: "pending",
      requested_at: new Date().toISOString(),
      source: "domain_login",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,user_id" },
  );
  if (error) throw new Error(`domain join request failed: ${error.message}`);

  await client.from("workspace_activity").insert({
    user_id: user.id,
    organization_id: orgId,
    activity_type: "enrollment",
    metadata: { source: "domain_login_pending", via: "team_status" },
  });
}

async function getTeamStatus(client: SupabaseClient, user: User) {
  await ensureDomainJoinRequest(client, user);

  const { data: memberships, error } = await client
    .from("organization_memberships")
    .select("id,organization_id,role,status,source,requested_at,approved_at,team_id,created_at,updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`team status lookup failed: ${error.message}`);

  const orgIds = [...new Set((memberships ?? []).map((row: any) => row.organization_id).filter(Boolean))];
  const { data: orgs } = orgIds.length
    ? await client
      .from("organizations")
      .select("id,name,display_name,slug,type,status,credit_pool,credit_pool_allocated")
      .in("id", orgIds)
    : { data: [] as any[] };
  const orgById = new Map((orgs ?? []).map((org: any) => [org.id, org]));

  return {
    data: {
      memberships: (memberships ?? []).map((row: any) => ({
        ...row,
        organization: orgById.get(row.organization_id) ?? null,
      })),
      can_open_admin_console: (memberships ?? []).some((row: any) => row.role === "org_admin" && row.status === "active"),
    },
  };
}

async function getOverview(client: SupabaseClient, user: User) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const orgId = ctx.organization_id;

  const [orgRes, domainRes, memberRes, inviteRes, teamRes, paymentRes] = await Promise.all([
    client
      .from("organizations")
      .select("id,name,display_name,slug,type,status,logo_url,brand_color,primary_contact_email,credit_pool,credit_pool_allocated,settings,created_at,updated_at")
      .eq("id", orgId)
      .single(),
    client
      .from("organization_domains")
      .select("id,domain,is_primary,verified_at,verification_method,created_at")
      .eq("organization_id", orgId)
      .order("is_primary", { ascending: false }),
    client
      .from("organization_memberships")
      .select("id,organization_id,user_id,role,status,source,team_id,requested_at,approved_at,joined_at,created_at,updated_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false }),
    client
      .from("organization_member_invites")
      .select("id,organization_id,email,role,team_id,status,expires_at,created_at,updated_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false }),
    client
      .from("classes")
      .select("id,organization_id,name,code,status,credit_pool,credit_pool_consumed,credit_policy,credit_amount,settings,created_at,updated_at")
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    client
      .from("payment_transactions")
      .select("id,user_id,organization_id,stripe_payment_intent_id,amount_thb,credits_added,status,payment_method,created_at,updated_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (orgRes.error) throw new Error(`organization read failed: ${orgRes.error.message}`);
  if (domainRes.error) throw new Error(`domain read failed: ${domainRes.error.message}`);
  if (memberRes.error) throw new Error(`member read failed: ${memberRes.error.message}`);
  if (inviteRes.error) throw new Error(`invite read failed: ${inviteRes.error.message}`);
  if (teamRes.error) throw new Error(`team read failed: ${teamRes.error.message}`);
  if (paymentRes.error) throw new Error(`payment read failed: ${paymentRes.error.message}`);

  const members = await hydrateUsers(client, memberRes.data ?? []);
  const teams = (teamRes.data ?? []).map((team: any) => ({
    ...team,
    credit_available: Math.max(0, Number(team.credit_pool ?? 0) - Number(team.credit_pool_consumed ?? 0)),
    member_count: members.filter((member: any) => member.team_id === team.id && member.status === "active").length,
  }));

  return {
    data: {
      organization: {
        ...orgRes.data,
        credit_available: Math.max(0, Number((orgRes.data as any).credit_pool ?? 0) - Number((orgRes.data as any).credit_pool_allocated ?? 0)),
      },
      domains: domainRes.data ?? [],
      members,
      invites: inviteRes.data ?? [],
      teams,
      payments: paymentRes.data ?? [],
      seat_price_usd: 5,
      org_topup_ratio_thb_to_credits: ORG_TOPUP_RATIO_THB_TO_CREDITS,
    },
  };
}

async function verifiedDomains(client: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await client
    .from("organization_domains")
    .select("domain")
    .eq("organization_id", orgId)
    .not("verified_at", "is", null);
  if (error) throw new Error(`domain lookup failed: ${error.message}`);
  return (data ?? []).map((row: any) => String(row.domain).toLowerCase()).filter((value) => DOMAIN_RE.test(value));
}

async function inviteMember(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const email = asString(body.email).toLowerCase();
  if (!email || !email.includes("@")) throw new Error("valid email is required");
  const role = asString(body.role, "member") === "org_admin" ? "org_admin" : "member";
  const teamId = asString(body.team_id) || null;

  const domains = await verifiedDomains(client, ctx.organization_id);
  if (domains.length > 0 && !domains.includes(emailDomain(email))) {
    throw new Error("email domain is not verified for this organization");
  }

  const existingUser = await findUserByEmail(client, email);
  if (existingUser) {
    const { error } = await client.from("organization_memberships").upsert(
      {
        organization_id: ctx.organization_id,
        user_id: existingUser.id,
        role,
        status: "active",
        invited_by: user.id,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        source: "admin_console",
        team_id: teamId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,user_id" },
    );
    if (error) throw new Error(`member invite failed: ${error.message}`);

    await client.from("profiles").update({
      organization_id: ctx.organization_id,
      account_type: "org_user",
      updated_at: new Date().toISOString(),
    }).eq("user_id", existingUser.id);

    return { data: { mode: "activated", user_id: existingUser.id } };
  }

  const { data, error } = await client.from("organization_member_invites").upsert(
    {
      organization_id: ctx.organization_id,
      email,
      role,
      team_id: teamId,
      status: "pending",
      invited_by: user.id,
      expires_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,email" },
  ).select().single();
  if (error) throw new Error(`member invite failed: ${error.message}`);
  return { data: { mode: "invited", invite: data } };
}

async function updateMemberStatus(client: SupabaseClient, user: User, body: Record<string, unknown>, status: "active" | "rejected" | "suspended") {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const membershipId = asString(body.membership_id);
  if (!membershipId) throw new Error("membership_id is required");
  const role = asString(body.role);
  const teamId = asString(body.team_id);

  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === "active") {
    updates.approved_by = user.id;
    updates.approved_at = new Date().toISOString();
    if (role === "org_admin" || role === "member") updates.role = role;
    if (teamId) updates.team_id = teamId;
  }
  if (status === "suspended") updates.suspended_at = new Date().toISOString();

  const { data, error } = await client
    .from("organization_memberships")
    .update(updates)
    .eq("id", membershipId)
    .eq("organization_id", ctx.organization_id)
    .select("id,user_id,organization_id,status")
    .single();
  if (error) throw new Error(`member update failed: ${error.message}`);

  if (status === "active") {
    await client.from("profiles").update({
      organization_id: ctx.organization_id,
      account_type: "org_user",
      updated_at: new Date().toISOString(),
    }).eq("user_id", (data as any).user_id);
  }

  return { data: { member: data } };
}

async function createTeam(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const name = asString(body.name);
  if (!name) throw new Error("team name is required");
  const code = slugCode(asString(body.code) || name);
  const creditAmount = Math.max(0, asInt(body.credit_amount, 0));

  const { data, error } = await client.from("classes").insert({
    organization_id: ctx.organization_id,
    name,
    code,
    description: asString(body.description) || null,
    status: "active",
    primary_instructor_id: user.id,
    credit_policy: asString(body.credit_policy, "manual"),
    credit_amount: creditAmount,
    settings: { kind: "enterprise_team" },
  }).select().single();
  if (error) throw new Error(`team create failed: ${error.message}`);
  return { data: { team: data } };
}

async function allocateTeamCredits(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const classId = asString(body.team_id);
  const delta = asInt(body.delta);
  if (!classId || delta === 0) throw new Error("team_id and non-zero delta are required");

  const { data: team, error: teamError } = await client
    .from("classes")
    .select("id,organization_id")
    .eq("id", classId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (teamError) throw new Error(`team lookup failed: ${teamError.message}`);
  if (!team) throw new Error("team not found");

  const { data, error } = await client.rpc("admin_allocate_class_pool", {
    p_class_id: classId,
    p_delta: delta,
    p_actor_id: user.id,
    p_description: asString(body.description) || "Team credit allocation from org admin console",
  });
  if (error) throw new Error(`team credit allocation failed: ${error.message}`);
  if (data === -1) throw new Error("organization pool does not have enough available credits");
  if (data === -2) throw new Error("team has already consumed too many credits to revoke that amount");
  return { data: { credit_pool: data } };
}

async function createOrgPromptPayIntent(client: SupabaseClient, user: User, body: Record<string, unknown>, req: Request) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  if (!user.email) throw new Error("user email is required");

  const amountThb = Math.floor(Number(body.amount_thb ?? body.amountThb));
  if (
    !Number.isFinite(amountThb) ||
    amountThb < MIN_ORG_TOPUP_THB ||
    amountThb > MAX_ORG_TOPUP_THB
  ) {
    throw new Error(`amount_thb must be between ${MIN_ORG_TOPUP_THB} and ${MAX_ORG_TOPUP_THB}`);
  }

  const credits = amountThb * ORG_TOPUP_RATIO_THB_TO_CREDITS;
  const stripe = stripeClient();
  const { data: org, error: orgError } = await client
    .from("organizations")
    .select("id,name,display_name,slug")
    .eq("id", ctx.organization_id)
    .single();
  if (orgError || !org) throw new Error(`organization lookup failed: ${orgError?.message ?? "not found"}`);

  const customerName = (org as any).display_name || (org as any).name || "Workspace organization";
  const customers = await stripe.customers.list({ email: user.email, limit: 1 });
  const customer = customers.data[0] ?? await stripe.customers.create({
    email: user.email,
    name: customerName,
    metadata: {
      supabase_user_id: user.id,
      workspace_organization_id: ctx.organization_id,
    },
  });

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountThb * 100,
    currency: "thb",
    customer: customer.id,
    payment_method_types: ["promptpay"],
    metadata: {
      type: "org_promptpay_topup",
      user_id: user.id,
      organization_id: ctx.organization_id,
      credits: String(credits),
      amount_thb: String(amountThb),
      package_name: `${customerName} credit top-up`,
    },
  });

  const origin = req.headers.get("origin") || "https://mediaforge-admin-hub.vercel.app";
  const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, {
    payment_method_data: {
      type: "promptpay",
      billing_details: { email: user.email, name: customerName },
    },
    return_url: `${origin}/org/console?topup=success`,
  });

  const expiresAt = confirmed.next_action?.promptpay_display_qr_code?.expires_at ?? null;
  return {
    data: {
      payment_intent_id: confirmed.id,
      client_secret: confirmed.client_secret,
      qr_code_svg_url: confirmed.next_action?.promptpay_display_qr_code?.image_url_svg ?? null,
      qr_code_png_url: confirmed.next_action?.promptpay_display_qr_code?.image_url_png ?? null,
      expires_at: expiresAt,
      amount_thb: amountThb,
      credits,
    },
  };
}

async function getOrgPaymentStatus(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const paymentIntentId = asString(body.payment_intent_id);
  if (!paymentIntentId) throw new Error("payment_intent_id is required");

  const { data, error } = await client
    .from("payment_transactions")
    .select("id,stripe_payment_intent_id,amount_thb,credits_added,status,payment_method,created_at,updated_at")
    .eq("organization_id", ctx.organization_id)
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) throw new Error(`payment status lookup failed: ${error.message}`);
  return { data: { payment: data ?? null } };
}

const ACTIONS: Record<string, (client: SupabaseClient, user: User, body: Record<string, unknown>) => Promise<unknown>> = {
  get_team_status: getTeamStatus,
  get_console_overview: getOverview,
  invite_member: inviteMember,
  approve_member: (client, user, body) => updateMemberStatus(client, user, body, "active"),
  reject_member: (client, user, body) => updateMemberStatus(client, user, body, "rejected"),
  suspend_member: (client, user, body) => updateMemberStatus(client, user, body, "suspended"),
  create_team: createTeam,
  allocate_team_credits: allocateTeamCredits,
  get_org_payment_status: getOrgPaymentStatus,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const action = asString(body.action);
  const handler = ACTIONS[action];
  if (!handler && action !== "create_org_promptpay_intent") {
    return json({ error: `Unsupported action: ${action}` }, 400);
  }

  try {
    const admin = serviceClient();
    const result = action === "create_org_promptpay_intent"
      ? await createOrgPromptPayIntent(admin, user, body, req)
      : await handler!(admin, user, body);
    return json(result);
  } catch (err) {
    console.error(`[workspace_org_console] ${action} failed:`, err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
