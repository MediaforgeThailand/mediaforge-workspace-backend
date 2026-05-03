/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { acceptPendingOrgInviteForUser } from "../_shared/orgInvite.ts";

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

const ORG_TOPUP_RATIO_THB_TO_CREDITS = 50;
const MIN_ORG_TOPUP_THB = 500;
const MAX_ORG_TOPUP_THB = 100_000;
const TEAM_SEAT_PRICE_USD = 10;
const TEAM_SEAT_PRICE_THB = 290;
const PAYMENT_SELECT = [
  "id",
  "user_id",
  "organization_id",
  "payment_scope",
  "stripe_session_id",
  "stripe_payment_intent_id",
  "stripe_charge_id",
  "stripe_invoice_id",
  "amount_thb",
  "credits_added",
  "status",
  "payment_method",
  "receipt_url",
  "invoice_url",
  "receipt_number",
  "receipt_generated_at",
  "created_at",
  "updated_at",
].join(",");
const GENERATION_SELECT = [
  "id",
  "user_id",
  "organization_id",
  "class_id",
  "project_id",
  "workspace_id",
  "canvas_id",
  "node_id",
  "feature",
  "model",
  "provider",
  "output_tier",
  "output_count",
  "width",
  "height",
  "duration_seconds",
  "aspect_ratio",
  "credits_spent",
  "status",
  "task_id",
  "created_at",
].join(",");
const POOL_TRANSACTION_SELECT = [
  "id",
  "user_id",
  "class_id",
  "organization_id",
  "triggered_by",
  "amount",
  "reason",
  "description",
  "metadata",
  "created_at",
].join(",");

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
  return new Stripe(key, { apiVersion: "2026-02-25.clover" as any });
}

function slugCode(input: string): string {
  const base = input
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 14);
  return base || `TEAM-${Math.floor(Math.random() * 9999)}`;
}

function allowedConsoleRedirect(input: unknown): string {
  const fallback = Deno.env.get("ADMIN_CONSOLE_URL") || "https://mediaforge-admin-hub.vercel.app/org/console";
  const allowed = [
    fallback,
    "https://mediaforge-admin-hub.vercel.app/org/console",
    "http://127.0.0.1:8090/org/console",
    "http://localhost:8090/org/console",
  ];
  const raw = asString(input) || fallback;
  try {
    const url = new URL(raw);
    const isAllowed = allowed.some((candidate) => {
      try {
        const allowedUrl = new URL(candidate);
        return url.origin === allowedUrl.origin && url.pathname === allowedUrl.pathname;
      } catch {
        return false;
      }
    });
    return isAllowed ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function firstUrl(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.startsWith("https://")) return trimmed;
  }
  return null;
}

function normalizeBrandShortName(value: unknown): string | null {
  const shortName = asString(value).toUpperCase();
  if (!shortName) return null;
  if (shortName.length < 2 || shortName.length > 8) {
    throw new Error("short name must be 2-8 characters");
  }
  return shortName;
}

function normalizeBrandColor(value: unknown): string | null {
  const color = asString(value);
  if (!color) return null;
  if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?$/i.test(color)) {
    throw new Error("brand color must be a valid hex color");
  }
  return color.toUpperCase();
}

function logoExtension(contentType: string, filename: string): string {
  const lowerName = filename.toLowerCase();
  if (contentType === "image/svg+xml" || lowerName.endsWith(".svg")) return "svg";
  if (contentType === "image/webp" || lowerName.endsWith(".webp")) return "webp";
  if (contentType === "image/jpeg" || lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "jpg";
  return "png";
}

function decodeDataUrlImage(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("logo file must be PNG, JPG, SVG, or WEBP");
  const contentType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("logo file must be 2 MB or smaller");
  return { bytes, contentType };
}

function normalizeHostname(value: unknown): string {
  const host = asString(value).toLowerCase();
  if (!host) throw new Error("hostname is required");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw new Error("hostname must be a valid DNS name");
  }
  return host;
}

async function resolvePaymentReceipt(client: SupabaseClient, stripe: Stripe, payment: any) {
  if (!payment?.id) return payment;

  const updates: Record<string, unknown> = {};
  try {
    let invoiceId = asString(payment.stripe_invoice_id);
    let chargeId = asString(payment.stripe_charge_id);

    if (!payment.receipt_url && payment.stripe_payment_intent_id) {
      const intent = await stripe.paymentIntents.retrieve(
        payment.stripe_payment_intent_id,
        { expand: ["latest_charge"] } as any,
      ) as any;
      const latestCharge = intent.latest_charge;
      const charge = typeof latestCharge === "string"
        ? await stripe.charges.retrieve(latestCharge)
        : latestCharge;

      if (charge?.id) {
        chargeId = charge.id;
        updates.stripe_charge_id = charge.id;
        if (charge.receipt_url) updates.receipt_url = charge.receipt_url;
        if (charge.receipt_number) updates.receipt_number = charge.receipt_number;
        if (charge.invoice && !invoiceId) {
          invoiceId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice.id;
          updates.stripe_invoice_id = invoiceId;
        }
      }
    }

    if (!payment.invoice_url && invoiceId) {
      const invoice = await stripe.invoices.retrieve(invoiceId) as any;
      updates.stripe_invoice_id = invoice.id ?? invoiceId;
      const invoiceUrl = firstUrl(invoice.hosted_invoice_url, invoice.invoice_pdf);
      if (invoiceUrl) updates.invoice_url = invoiceUrl;
    }

    if (chargeId && !updates.stripe_charge_id) updates.stripe_charge_id = chargeId;
    const resolvedUrl = firstUrl(updates.receipt_url, updates.invoice_url, payment.receipt_url, payment.invoice_url);
    if (resolvedUrl) updates.receipt_generated_at = new Date().toISOString();

    if (Object.keys(updates).length > 0) {
      const { error } = await client
        .from("payment_transactions")
        .update(updates)
        .eq("id", payment.id);
      if (error) console.warn("[workspace_org_console] receipt cache update failed:", error);
    }
  } catch (err) {
    console.warn("[workspace_org_console] Stripe receipt lookup failed:", err);
  }

  return { ...payment, ...updates };
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
  const byId = new Map<string, {
    email: string | null;
    name: string | null;
    last_sign_in_at: string | null;
    created_at: string | null;
  }>();
  await Promise.all(ids.map(async (id) => {
    const { data } = await client.auth.admin.getUserById(id);
    const user = data?.user;
    byId.set(id, {
      email: user?.email ?? null,
      name: (user?.user_metadata?.display_name ?? user?.user_metadata?.full_name ?? null) as string | null,
      last_sign_in_at: user?.last_sign_in_at ?? null,
      created_at: user?.created_at ?? null,
    });
  }));
  return rows.map((row) => ({
    ...row,
    email: byId.get(row.user_id)?.email ?? null,
    display_name: byId.get(row.user_id)?.name ?? null,
    last_sign_in_at: byId.get(row.user_id)?.last_sign_in_at ?? null,
    auth_created_at: byId.get(row.user_id)?.created_at ?? null,
  }));
}

async function hydrateActors(client: SupabaseClient, rows: any[]) {
  const ids = [...new Set(rows.map((row) => row.triggered_by).filter(Boolean))];
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
    actor_email: byId.get(row.triggered_by)?.email ?? null,
    actor_display_name: byId.get(row.triggered_by)?.name ?? null,
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
  const acceptedInvite = await acceptPendingOrgInviteForUser(client, user, "team_status");
  if (acceptedInvite.accepted) return;

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
  const orgById = new Map((orgs ?? []).map((org: any) => [
    org.id,
    {
      ...org,
      credit_available: Math.max(0, Number(org.credit_pool ?? 0) - Number(org.credit_pool_allocated ?? 0)),
    },
  ]));

  const teamIds = [...new Set((memberships ?? []).map((row: any) => row.team_id).filter(Boolean))];
  const { data: teams } = teamIds.length
    ? await client
      .from("classes")
      .select("id,organization_id,name,code,status,credit_pool,credit_pool_consumed,credit_policy,credit_amount")
      .in("id", teamIds)
      .is("deleted_at", null)
    : { data: [] as any[] };
  const teamById = new Map((teams ?? []).map((team: any) => [
    team.id,
    {
      ...team,
      credit_available: Math.max(0, Number(team.credit_pool ?? 0) - Number(team.credit_pool_consumed ?? 0)),
    },
  ]));

  return {
    data: {
      memberships: (memberships ?? []).map((row: any) => ({
        ...row,
        organization: orgById.get(row.organization_id) ?? null,
        team: row.team_id ? teamById.get(row.team_id) ?? null : null,
      })),
      can_open_admin_console: (memberships ?? []).some((row: any) => row.role === "org_admin" && row.status === "active"),
    },
  };
}

async function createConsoleLoginLink(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  if (!user.email) throw new Error("user email is required");
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");

  const redirectTo = allowedConsoleRedirect(body.redirect_to);
  const { data, error } = await client.auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
    options: { redirectTo },
  });
  if (error) throw new Error(`console handoff failed: ${error.message}`);

  const url = (data as any)?.properties?.action_link;
  if (!url) throw new Error("console handoff failed: missing action link");

  await client.from("workspace_activity").insert({
    user_id: user.id,
    organization_id: ctx.organization_id,
    activity_type: "login",
    metadata: { redirect_to: redirectTo },
  });

  return {
    data: {
      url,
      redirect_to: redirectTo,
    },
  };
}

async function getOverview(client: SupabaseClient, user: User) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const orgId = ctx.organization_id;

  const [orgRes, domainRes, memberRes, inviteRes, teamRes, paymentRes, generationRes] = await Promise.all([
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
      .select(PAYMENT_SELECT)
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100),
    client
      .from("workspace_generation_events")
      .select(GENERATION_SELECT)
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(250),
  ]);

  if (orgRes.error) throw new Error(`organization read failed: ${orgRes.error.message}`);
  if (domainRes.error) throw new Error(`domain read failed: ${domainRes.error.message}`);
  if (memberRes.error) throw new Error(`member read failed: ${memberRes.error.message}`);
  if (inviteRes.error) throw new Error(`invite read failed: ${inviteRes.error.message}`);
  if (teamRes.error) throw new Error(`team read failed: ${teamRes.error.message}`);
  if (paymentRes.error) throw new Error(`payment read failed: ${paymentRes.error.message}`);
  if (generationRes.error) throw new Error(`generation history read failed: ${generationRes.error.message}`);
  const teamIds = (teamRes.data ?? []).map((team: any) => team.id).filter(Boolean);
  const poolTxFilter = teamIds.length
    ? `organization_id.eq.${orgId},class_id.in.(${teamIds.join(",")})`
    : `organization_id.eq.${orgId}`;
  const poolTxRes = await client
    .from("pool_transactions")
    .select(POOL_TRANSACTION_SELECT)
    .or(poolTxFilter)
    .order("created_at", { ascending: false })
    .limit(100);
  if (poolTxRes.error) throw new Error(`pool transaction read failed: ${poolTxRes.error.message}`);

  const hydratedMembers = await hydrateUsers(client, memberRes.data ?? []);
  const payments = await hydrateUsers(client, paymentRes.data ?? []);
  const generations = await hydrateUsers(client, generationRes.data ?? []);
  const pool_transactions = await hydrateActors(client, poolTxRes.data ?? []);
  const memberUserIds = hydratedMembers.map((member: any) => member.user_id).filter(Boolean);
  const activityRes = memberUserIds.length
    ? await client
      .from("workspace_activity")
      .select("user_id,activity_type,created_at")
      .eq("organization_id", orgId)
      .in("user_id", memberUserIds)
      .order("created_at", { ascending: false })
      .limit(1000)
    : { data: [] as any[], error: null };
  if (activityRes.error) throw new Error(`activity read failed: ${activityRes.error.message}`);
  const latestActivityByUser = new Map<string, any>();
  for (const activity of activityRes.data ?? []) {
    if (activity.user_id && !latestActivityByUser.has(activity.user_id)) {
      latestActivityByUser.set(activity.user_id, activity);
    }
  }
  const members = hydratedMembers.map((member: any) => {
    const latest = latestActivityByUser.get(member.user_id);
    return {
      ...member,
      last_active_at: latest?.created_at ?? member.last_sign_in_at ?? member.updated_at ?? member.created_at ?? null,
      last_activity_type: latest?.activity_type ?? null,
    };
  });
  const teams = (teamRes.data ?? []).map((team: any) => ({
    ...team,
    credit_available: Math.max(0, Number(team.credit_pool ?? 0) - Number(team.credit_pool_consumed ?? 0)),
    member_count: members.filter((member: any) => member.team_id === team.id && member.status === "active").length,
  }));
  const completedPayments = payments.filter((payment: any) => payment.status === "completed");
  const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentGenerations = generations.filter((generation: any) => {
    const t = Date.parse(generation.created_at ?? "");
    return Number.isFinite(t) && t >= cutoff30d;
  });

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
      payments,
      generations,
      pool_transactions,
      usage_summary: {
        payment_count: payments.length,
        topup_amount_thb_total: completedPayments.reduce((sum: number, payment: any) => sum + Number(payment.amount_thb ?? 0), 0),
        topup_credits_total: completedPayments.reduce((sum: number, payment: any) => sum + Number(payment.credits_added ?? 0), 0),
        generation_count: generations.length,
        generation_count_30d: recentGenerations.length,
        generation_credits_total: generations.reduce((sum: number, generation: any) => sum + Number(generation.credits_spent ?? 0), 0),
        generation_credits_30d: recentGenerations.reduce((sum: number, generation: any) => sum + Number(generation.credits_spent ?? 0), 0),
      },
      seat_price_usd: TEAM_SEAT_PRICE_USD,
      seat_price_thb: TEAM_SEAT_PRICE_THB,
      org_topup_ratio_thb_to_credits: ORG_TOPUP_RATIO_THB_TO_CREDITS,
    },
  };
}

async function normalizeTeamId(client: SupabaseClient, orgId: string, value: unknown): Promise<string | null> {
  const teamId = asString(value) || null;
  if (!teamId) return null;

  const { data, error } = await client
    .from("classes")
    .select("id")
    .eq("id", teamId)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`team lookup failed: ${error.message}`);
  if (!data) throw new Error("team does not belong to this organization");
  return teamId;
}

async function activeOrgAdminCount(client: SupabaseClient, orgId: string): Promise<number> {
  const { count, error } = await client
    .from("organization_memberships")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("role", "org_admin")
    .eq("status", "active");
  if (error) throw new Error(`admin count failed: ${error.message}`);
  return count ?? 0;
}

async function inviteMember(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const email = asString(body.email).toLowerCase();
  if (!email || !email.includes("@")) throw new Error("valid email is required");
  const role = asString(body.role, "member") === "org_admin" ? "org_admin" : "member";
  const teamId = await normalizeTeamId(client, ctx.organization_id, body.team_id);

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

async function updateMember(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const membershipId = asString(body.membership_id);
  if (!membershipId) throw new Error("membership_id is required");

  const { data: member, error: memberError } = await client
    .from("organization_memberships")
    .select("id,user_id,organization_id,role,status,team_id")
    .eq("id", membershipId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (memberError) throw new Error(`member lookup failed: ${memberError.message}`);
  if (!member) throw new Error("member not found");

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const nextRole = asString(body.role);
  if (nextRole) {
    if (nextRole !== "org_admin" && nextRole !== "member") throw new Error("invalid role");
    if ((member as any).role === "org_admin" && nextRole !== "org_admin") {
      const adminCount = await activeOrgAdminCount(client, ctx.organization_id);
      if (adminCount <= 1) throw new Error("organization must keep at least one active admin");
    }
    updates.role = nextRole;
  }

  if (Object.prototype.hasOwnProperty.call(body, "team_id")) {
    updates.team_id = await normalizeTeamId(client, ctx.organization_id, body.team_id);
  }

  if (Object.keys(updates).length === 1) throw new Error("no member updates provided");

  const { data, error } = await client
    .from("organization_memberships")
    .update(updates)
    .eq("id", membershipId)
    .eq("organization_id", ctx.organization_id)
    .select("id,user_id,organization_id,role,status,source,team_id,requested_at,approved_at,joined_at,created_at,updated_at")
    .single();
  if (error) throw new Error(`member update failed: ${error.message}`);
  return { data: { member: data } };
}

async function updateMemberStatus(client: SupabaseClient, user: User, body: Record<string, unknown>, status: "active" | "rejected" | "suspended") {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const membershipId = asString(body.membership_id);
  if (!membershipId) throw new Error("membership_id is required");
  const role = asString(body.role);
  const teamId = await normalizeTeamId(client, ctx.organization_id, body.team_id);

  const { data: existing, error: existingError } = await client
    .from("organization_memberships")
    .select("id,user_id,role,status")
    .eq("id", membershipId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (existingError) throw new Error(`member lookup failed: ${existingError.message}`);
  if (!existing) throw new Error("member not found");
  if (status === "suspended" && (existing as any).user_id === user.id) {
    throw new Error("you cannot suspend your own admin account");
  }
  if (status === "suspended" && (existing as any).role === "org_admin") {
    const adminCount = await activeOrgAdminCount(client, ctx.organization_id);
    if (adminCount <= 1) throw new Error("organization must keep at least one active admin");
  }

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

async function deleteTeam(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const teamId = await normalizeTeamId(client, ctx.organization_id, body.team_id);
  if (!teamId) throw new Error("team_id is required");

  const { data: team, error: teamError } = await client
    .from("classes")
    .select("id,organization_id,name,code,credit_pool,credit_pool_consumed")
    .eq("id", teamId)
    .eq("organization_id", ctx.organization_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (teamError) throw new Error(`team lookup failed: ${teamError.message}`);
  if (!team) throw new Error("team not found");

  const available = Math.max(0, Number((team as any).credit_pool ?? 0) - Number((team as any).credit_pool_consumed ?? 0));
  if (available > 0) {
    const { data, error } = await client.rpc("admin_allocate_class_pool", {
      p_class_id: teamId,
      p_delta: -available,
      p_actor_id: user.id,
      p_description: `Delete team ${String((team as any).name ?? teamId)}: return unused credits`,
    });
    if (error) throw new Error(`team credit return failed: ${error.message}`);
    if (data === -2) throw new Error("team has consumed more credits than expected");
  }

  await client
    .from("organization_memberships")
    .update({ team_id: null, updated_at: new Date().toISOString() })
    .eq("organization_id", ctx.organization_id)
    .eq("team_id", teamId);
  await client
    .from("organization_member_invites")
    .update({ team_id: null, updated_at: new Date().toISOString() })
    .eq("organization_id", ctx.organization_id)
    .eq("team_id", teamId)
    .eq("status", "pending");

  const deletedCode = `${String((team as any).code ?? "team")}-deleted-${Date.now()}`;
  const { data: deleted, error: deleteError } = await client
    .from("classes")
    .update({
      status: "archived",
      code: deletedCode,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", teamId)
    .eq("organization_id", ctx.organization_id)
    .select("id,name,code,status,deleted_at")
    .single();
  if (deleteError) throw new Error(`team delete failed: ${deleteError.message}`);
  return { data: { team: deleted, credits_returned: available } };
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

  const origin = req.headers.get("origin") || "";
  const returnUrl = allowedConsoleRedirect(origin ? `${origin}/org/console?topup=success` : null);
  const confirmed = await stripe.paymentIntents.confirm(paymentIntent.id, {
    payment_method_data: {
      type: "promptpay",
      billing_details: { email: user.email, name: customerName },
    },
    return_url: returnUrl,
  });

  const { error: txError } = await client.from("payment_transactions").insert({
    user_id: user.id,
    organization_id: ctx.organization_id,
    payment_scope: "organization",
    package_id: null,
    stripe_session_id: null,
    stripe_payment_intent_id: confirmed.id,
    amount_thb: amountThb,
    credits_added: credits,
    status: "pending",
    payment_method: "promptpay",
  });
  if (txError) throw new Error(`payment audit row failed: ${txError.message}`);

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
    .select(PAYMENT_SELECT)
    .eq("organization_id", ctx.organization_id)
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) throw new Error(`payment status lookup failed: ${error.message}`);
  return { data: { payment: data ?? null } };
}

async function getOrgReceipt(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const paymentId = asString(body.payment_id);
  if (!paymentId) throw new Error("payment_id is required");

  const { data, error } = await client
    .from("payment_transactions")
    .select(PAYMENT_SELECT)
    .eq("id", paymentId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (error) throw new Error(`payment lookup failed: ${error.message}`);
  if (!data) throw new Error("payment_not_found");

  const payment = await resolvePaymentReceipt(client, stripeClient(), data);
  const downloadUrl = firstUrl(payment.receipt_url, payment.invoice_url);
  if (!downloadUrl) throw new Error("receipt_not_available_yet");

  return {
    data: {
      payment,
      receipt_url: payment.receipt_url ?? null,
      invoice_url: payment.invoice_url ?? null,
      download_url: downloadUrl,
    },
  };
}

async function readBrandingDomains(client: SupabaseClient, orgId: string) {
  const { data, error } = await client
    .from("org_domains")
    .select("id,org_id,hostname,is_primary,created_at,updated_at")
    .eq("org_id", orgId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) {
    console.warn("[workspace_org_console] branding domain read failed:", error.message);
    return [];
  }
  return data ?? [];
}

async function getOrgBranding(client: SupabaseClient, user: User) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");

  const { data: org, error } = await client
    .from("organizations")
    .select("id,name,display_name,slug,type,status,logo_url,brand_color,settings,updated_at")
    .eq("id", ctx.organization_id)
    .single();
  if (error || !org) throw new Error(`organization lookup failed: ${error?.message ?? "not found"}`);

  const settings = ((org as any).settings && typeof (org as any).settings === "object")
    ? (org as any).settings
    : {};
  const shortName = asString((settings as any).display_name_short ?? (settings as any).brand_short_name);

  return {
    data: {
      org: { ...(org as any), display_name_short: shortName || null },
      domains: await readBrandingDomains(client, ctx.organization_id),
    },
  };
}

async function saveOrgBranding(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");

  const { data: org, error: orgError } = await client
    .from("organizations")
    .select("id,settings")
    .eq("id", ctx.organization_id)
    .single();
  if (orgError || !org) throw new Error(`organization lookup failed: ${orgError?.message ?? "not found"}`);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const settings = ((org as any).settings && typeof (org as any).settings === "object")
    ? { ...((org as any).settings as Record<string, unknown>) }
    : {};

  if (Object.prototype.hasOwnProperty.call(body, "display_name_short")) {
    const shortName = normalizeBrandShortName(body.display_name_short);
    if (shortName) {
      settings.display_name_short = shortName;
      settings.brand_short_name = shortName;
    } else {
      delete settings.display_name_short;
      delete settings.brand_short_name;
    }
    updates.settings = settings;
  }

  if (Object.prototype.hasOwnProperty.call(body, "brand_color")) {
    updates.brand_color = normalizeBrandColor(body.brand_color);
  }

  const logoDataUrl = asString(body.logo_data_url);
  if (logoDataUrl) {
    const { bytes, contentType } = decodeDataUrlImage(logoDataUrl);
    const ext = logoExtension(contentType, asString(body.logo_filename, `logo.${contentType.split("/")[1]}`));
    const path = `${ctx.organization_id}/logo.${ext}`;
    const { error: uploadError } = await client.storage
      .from("org-branding")
      .upload(path, bytes, { contentType, upsert: true });
    if (uploadError) throw new Error(`logo upload failed: ${uploadError.message}`);

    const { data: publicUrl } = client.storage.from("org-branding").getPublicUrl(path);
    updates.logo_url = `${publicUrl.publicUrl}?v=${Date.now()}`;
  }

  if (Object.keys(updates).length === 1) throw new Error("no branding updates provided");

  const { data: updated, error } = await client
    .from("organizations")
    .update(updates)
    .eq("id", ctx.organization_id)
    .select("id,name,display_name,slug,type,status,logo_url,brand_color,settings,updated_at")
    .single();
  if (error) throw new Error(`branding save failed: ${error.message}`);

  return {
    data: {
      org: {
        ...(updated as any),
        display_name_short: asString((updated as any)?.settings?.display_name_short ?? (updated as any)?.settings?.brand_short_name) || null,
      },
      domains: await readBrandingDomains(client, ctx.organization_id),
    },
  };
}

async function addBrandingDomain(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const hostname = normalizeHostname(body.hostname);
  const domains = await readBrandingDomains(client, ctx.organization_id);
  const isPrimary = asBool(body.is_primary, domains.length === 0);

  if (isPrimary) {
    await client.from("org_domains").update({ is_primary: false }).eq("org_id", ctx.organization_id);
  }

  const { data, error } = await client
    .from("org_domains")
    .upsert(
      { org_id: ctx.organization_id, hostname, is_primary: isPrimary },
      { onConflict: "hostname" },
    )
    .select("id,org_id,hostname,is_primary,created_at,updated_at")
    .single();
  if (error) throw new Error(`domain save failed: ${error.message}`);
  return { data: { domain: data, domains: await readBrandingDomains(client, ctx.organization_id) } };
}

async function setPrimaryBrandingDomain(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const domainId = asString(body.domain_id);
  if (!domainId) throw new Error("domain_id is required");

  await client.from("org_domains").update({ is_primary: false }).eq("org_id", ctx.organization_id);
  const { data, error } = await client
    .from("org_domains")
    .update({ is_primary: true })
    .eq("id", domainId)
    .eq("org_id", ctx.organization_id)
    .select("id,org_id,hostname,is_primary,created_at,updated_at")
    .single();
  if (error) throw new Error(`primary domain update failed: ${error.message}`);
  return { data: { domain: data, domains: await readBrandingDomains(client, ctx.organization_id) } };
}

async function removeBrandingDomain(client: SupabaseClient, user: User, body: Record<string, unknown>) {
  const ctx = await orgAdminContext(client, user);
  if (!ctx) throw new Error("org_admin_required");
  const domainId = asString(body.domain_id);
  if (!domainId) throw new Error("domain_id is required");

  const { error } = await client
    .from("org_domains")
    .delete()
    .eq("id", domainId)
    .eq("org_id", ctx.organization_id);
  if (error) throw new Error(`domain remove failed: ${error.message}`);
  return { data: { ok: true, domains: await readBrandingDomains(client, ctx.organization_id) } };
}

const ACTIONS: Record<string, (client: SupabaseClient, user: User, body: Record<string, unknown>) => Promise<unknown>> = {
  get_team_status: getTeamStatus,
  create_console_login_link: createConsoleLoginLink,
  get_console_overview: getOverview,
  invite_member: inviteMember,
  update_member: updateMember,
  approve_member: (client, user, body) => updateMemberStatus(client, user, body, "active"),
  reject_member: (client, user, body) => updateMemberStatus(client, user, body, "rejected"),
  suspend_member: (client, user, body) => updateMemberStatus(client, user, body, "suspended"),
  create_team: createTeam,
  allocate_team_credits: allocateTeamCredits,
  delete_team: deleteTeam,
  get_org_payment_status: getOrgPaymentStatus,
  get_org_receipt: getOrgReceipt,
  get_org_branding: getOrgBranding,
  save_org_branding: saveOrgBranding,
  add_branding_domain: addBrandingDomain,
  set_primary_branding_domain: setPrimaryBrandingDomain,
  remove_branding_domain: removeBrandingDomain,
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
