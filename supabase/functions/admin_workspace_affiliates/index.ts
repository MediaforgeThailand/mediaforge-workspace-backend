/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";
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

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function stripeClient() {
  const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!key) throw new Error("Stripe is not configured");
  return new Stripe(key, { apiVersion: "2026-02-25.clover" as any });
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function clampPercent(value: unknown, fallback = 0): number {
  return Math.max(0, Math.min(100, Number(asNumber(value, fallback).toFixed(2))));
}

function normalizeCode(raw: unknown): string {
  const cleaned = asString(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(cleaned)) {
    throw new Error("Affiliate code must be 3-40 characters using letters, numbers, or hyphens");
  }
  return cleaned;
}

function defaultCodeSeed(app: any): string {
  const base = [
    "MF",
    asString(app.legal_first_name, "CREATOR"),
    asString(app.legal_last_name, "").slice(0, 12),
  ].filter(Boolean).join("-");
  return normalizeCode(base || `MF-${crypto.randomUUID().slice(0, 8)}`);
}

function splitName(fullName: string, fallbackEmail = "") {
  const fallback = fallbackEmail.split("@")[0] || "Creator";
  const parts = (fullName || fallback).trim().split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || fallback,
    last: parts.slice(1).join(" ") || "-",
  };
}

async function hydrateAuthUsers(client: SupabaseClient, rows: any[], field = "user_id") {
  const ids = [...new Set(rows.map((row) => row?.[field]).filter(Boolean))];
  const byId = new Map<string, { email: string | null; display_name: string | null }>();
  await Promise.all(ids.map(async (id) => {
    try {
      const { data } = await client.auth.admin.getUserById(id);
      const user = data?.user;
      byId.set(id, {
        email: user?.email ?? null,
        display_name: (user?.user_metadata?.display_name ?? user?.user_metadata?.full_name ?? null) as string | null,
      });
    } catch {
      byId.set(id, { email: null, display_name: null });
    }
  }));
  return rows.map((row) => ({
    ...row,
    user_email: byId.get(row?.[field])?.email ?? null,
    user_display_name: byId.get(row?.[field])?.display_name ?? null,
  }));
}

async function ensureStripeCoupon(
  client: SupabaseClient,
  stripe: Stripe,
  codeRow: any | null,
  code: string,
  discountPercent: number,
): Promise<string | null> {
  if (discountPercent <= 0) return null;
  if (codeRow?.stripe_coupon_id && Number(codeRow.discount_percent ?? 0) === discountPercent) {
    return String(codeRow.stripe_coupon_id);
  }

  const coupon = await stripe.coupons.create({
    name: `MediaForge creator ${code} - ${discountPercent}% off`,
    percent_off: discountPercent,
    duration: "once",
    metadata: {
      source: "workspace_affiliate",
      affiliate_code: code,
    },
  });

  if (codeRow?.id) {
    await client
      .from("referral_codes")
      .update({ stripe_coupon_id: coupon.id, updated_at: new Date().toISOString() })
      .eq("id", codeRow.id);
  }

  return coupon.id;
}

async function listApplications(client: SupabaseClient, body: Record<string, unknown>) {
  const status = asString(body.status, "all");
  let q = client
    .from("partner_applications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (status !== "all") q = q.eq("status", status);

  const { data, error } = await q;
  if (error) throw new Error(`applications read failed: ${error.message}`);
  return { data: { applications: await hydrateAuthUsers(client, data ?? []) } };
}

async function listPartners(client: SupabaseClient) {
  const { data: partners, error: partnerError } = await client
    .from("partners")
    .select("*, partner_applications(*)")
    .order("approved_at", { ascending: false })
    .limit(200);
  if (partnerError) throw new Error(`partners read failed: ${partnerError.message}`);

  const hydrated = await hydrateAuthUsers(client, partners ?? []);
  const ids = hydrated.map((row) => row.user_id).filter(Boolean);

  const [{ data: codes, error: codesError }, { data: commissions, error: commissionsError }] = await Promise.all([
    ids.length
      ? client.from("referral_codes").select("*").in("user_id", ids).eq("code_type", "partner_affiliate")
      : Promise.resolve({ data: [], error: null } as any),
    ids.length
      ? client.from("commission_events").select("partner_user_id, commission_amount_thb, net_amount_thb, gross_amount_thb, status").in("partner_user_id", ids)
      : Promise.resolve({ data: [], error: null } as any),
  ]);
  if (codesError) throw new Error(`codes read failed: ${codesError.message}`);
  if (commissionsError) throw new Error(`commissions read failed: ${commissionsError.message}`);

  const codesByUser = new Map<string, any[]>();
  for (const code of codes ?? []) {
    const list = codesByUser.get(code.user_id) ?? [];
    list.push(code);
    codesByUser.set(code.user_id, list);
  }

  const totalsByUser = new Map<string, { holding: number; available: number; paid: number; total: number; sales: number }>();
  for (const event of commissions ?? []) {
    const current = totalsByUser.get(event.partner_user_id) ?? { holding: 0, available: 0, paid: 0, total: 0, sales: 0 };
    const amount = Number(event.commission_amount_thb ?? 0);
    current.total += amount;
    if (event.status === "holding") current.holding += amount;
    if (event.status === "available") current.available += amount;
    if (event.status === "paid") current.paid += amount;
    if (!["void", "clawback"].includes(String(event.status ?? ""))) {
      current.sales += Number(event.net_amount_thb ?? event.gross_amount_thb ?? 0);
    }
    totalsByUser.set(event.partner_user_id, current);
  }

  return {
    data: {
      partners: hydrated.map((row) => ({
        ...row,
        codes: codesByUser.get(row.user_id) ?? [],
        commission_totals: totalsByUser.get(row.user_id) ?? { holding: 0, available: 0, paid: 0, total: 0, sales: 0 },
      })),
    },
  };
}

async function getSummary(client: SupabaseClient) {
  const [apps, partners, codes, commissions] = await Promise.all([
    client.from("partner_applications").select("id,status", { count: "exact" }),
    client.from("partners").select("user_id", { count: "exact" }).is("suspended_at", null),
    client.from("referral_codes").select("id", { count: "exact" }).eq("code_type", "partner_affiliate").eq("is_active", true),
    client.from("commission_events").select("commission_amount_thb,status"),
  ]);
  if (apps.error) throw new Error(`applications summary failed: ${apps.error.message}`);
  if (partners.error) throw new Error(`partners summary failed: ${partners.error.message}`);
  if (codes.error) throw new Error(`codes summary failed: ${codes.error.message}`);
  if (commissions.error) throw new Error(`commissions summary failed: ${commissions.error.message}`);

  const pending = (apps.data ?? []).filter((row: any) => ["submitted", "in_review", "needs_info"].includes(row.status)).length;
  const commissionTotal = (commissions.data ?? []).reduce((sum: number, row: any) => sum + Number(row.commission_amount_thb ?? 0), 0);
  const commissionPayable = (commissions.data ?? [])
    .filter((row: any) => row.status === "available")
    .reduce((sum: number, row: any) => sum + Number(row.commission_amount_thb ?? 0), 0);

  return {
    data: {
      pending_applications: pending,
      active_partners: partners.count ?? 0,
      active_codes: codes.count ?? 0,
      total_commission_thb: commissionTotal,
      payable_commission_thb: commissionPayable,
    },
  };
}

async function approveApplication(client: SupabaseClient, body: Record<string, unknown>, actor: { id: string; email: string }) {
  const applicationId = asString(body.application_id);
  if (!applicationId) throw new Error("application_id is required");
  const commissionRate = Math.max(0, Math.min(1, asNumber(body.commission_rate, 0.3)));
  const discountPercent = clampPercent(body.discount_percent, 0);

  const { data: app, error: appError } = await client
    .from("partner_applications")
    .update({
      status: "approved",
      reviewed_by: actor.id,
      reviewed_at: new Date().toISOString(),
      rejection_reason: null,
      needs_info_message: null,
    })
    .eq("id", applicationId)
    .select("*")
    .maybeSingle();
  if (appError) throw new Error(`application approve failed: ${appError.message}`);
  if (!app) throw new Error("application not found");

  const { data: partner, error: partnerError } = await client
    .from("partners")
    .upsert({
      user_id: app.user_id,
      application_id: app.id,
      commission_rate: commissionRate,
      tier: "standard",
      approved_at: new Date().toISOString(),
      suspended_at: null,
      suspended_reason: null,
    }, { onConflict: "user_id" })
    .select("*")
    .maybeSingle();
  if (partnerError) throw new Error(`partner upsert failed: ${partnerError.message}`);

  const code = normalizeCode(body.code || defaultCodeSeed(app));
  const codeResult = await upsertCode(client, {
    partner_user_id: app.user_id,
    code,
    discount_percent: discountPercent,
    campaign_label: asString(body.campaign_label, "Creator affiliate"),
    is_active: true,
  });

  await client.from("affiliate_audit_log").insert({
    actor_id: actor.id,
    action: "workspace_affiliate_application_approved",
    entity_type: "partner_application",
    entity_id: app.id,
    diff: { actor_email: actor.email, partner_user_id: app.user_id, code },
  });

  return { data: { application: app, partner, code: codeResult.data.code } };
}

async function rejectApplication(client: SupabaseClient, body: Record<string, unknown>, actor: { id: string; email: string }) {
  const applicationId = asString(body.application_id);
  if (!applicationId) throw new Error("application_id is required");
  const { data, error } = await client
    .from("partner_applications")
    .update({
      status: "rejected",
      reviewed_by: actor.id,
      reviewed_at: new Date().toISOString(),
      rejection_reason: asString(body.reason, "Rejected by admin"),
    })
    .eq("id", applicationId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`application reject failed: ${error.message}`);
  return { data };
}

async function upsertCode(client: SupabaseClient, body: Record<string, unknown>) {
  const partnerUserId = asString(body.partner_user_id);
  if (!partnerUserId) throw new Error("partner_user_id is required");
  const code = normalizeCode(body.code);
  const discountPercent = clampPercent(body.discount_percent, 0);

  const { data: partner, error: partnerError } = await client
    .from("partners")
    .select("user_id, suspended_at")
    .eq("user_id", partnerUserId)
    .maybeSingle();
  if (partnerError) throw new Error(`partner read failed: ${partnerError.message}`);
  if (!partner || partner.suspended_at) throw new Error("partner is not active");

  const { data: existing, error: existingError } = await client
    .from("referral_codes")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (existingError) throw new Error(`code read failed: ${existingError.message}`);
  if (existing && existing.user_id !== partnerUserId) throw new Error("affiliate code is already owned by another partner");

  const couponId = discountPercent > 0
    ? await ensureStripeCoupon(client, stripeClient(), existing, code, discountPercent)
    : null;
  const payload = {
    user_id: partnerUserId,
    code,
    code_type: "partner_affiliate",
    is_active: body.is_active !== false,
    campaign_label: asString(body.campaign_label, "Creator affiliate"),
    discount_percent: discountPercent,
    stripe_coupon_id: couponId,
    discount_duration: "once",
    updated_at: new Date().toISOString(),
  };

  const query = existing
    ? client.from("referral_codes").update(payload).eq("id", existing.id)
    : client.from("referral_codes").insert(payload);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new Error(`code save failed: ${error.message}`);
  return { data: { code: data } };
}

async function findUserByEmail(client: SupabaseClient, email: string) {
  const needle = email.trim().toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth users lookup failed: ${error.message}`);
    const user = data.users.find((item) => (item.email ?? "").toLowerCase() === needle);
    if (user) return user;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function manualCreatePartner(client: SupabaseClient, body: Record<string, unknown>, actor: { id: string; email: string }) {
  const email = asString(body.email).toLowerCase();
  if (!email || !email.includes("@")) throw new Error("valid creator email is required");

  const user = await findUserByEmail(client, email);
  if (!user) throw new Error("Creator must create a MediaForge account before admin can invite them");

  const fullName = asString(body.full_name) || asString(user.user_metadata?.display_name) || asString(user.user_metadata?.full_name) || email.split("@")[0];
  const name = splitName(fullName, email);
  const commissionRate = Math.max(0, Math.min(1, asNumber(body.commission_rate, 0.3)));
  const discountPercent = clampPercent(body.discount_percent, 20);

  const bankName = asString(body.bank_name);
  const bankAccountNo = asString(body.bank_account_no);
  const bankAccountName = asString(body.bank_account_name) || fullName;
  if (!bankName || !bankAccountNo) {
    throw new Error("bank_name and bank_account_no are required — collect bank details before inviting the creator");
  }

  const applicationPayload = {
    user_id: user.id,
    legal_first_name: name.first,
    legal_last_name: name.last,
    phone_e164: asString(body.phone, "-"),
    bank_name: bankName,
    bank_account_no: bankAccountNo,
    bank_account_name: bankAccountName,
    social_profile_url: asString(body.social_profile_url),
    social_platform: asString(body.social_platform),
    follower_count: Math.max(0, Math.trunc(asNumber(body.follower_count, 0))),
    status: "approved",
    reviewed_by: actor.id,
    reviewed_at: new Date().toISOString(),
    rejection_reason: null,
    needs_info_message: null,
    submitted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: app, error: appError } = await client
    .from("partner_applications")
    .upsert(applicationPayload, { onConflict: "user_id" })
    .select("*")
    .maybeSingle();
  if (appError) throw new Error(`manual application save failed: ${appError.message}`);
  if (!app) throw new Error("manual application save returned empty");

  const { data: partner, error: partnerError } = await client
    .from("partners")
    .upsert({
      user_id: user.id,
      application_id: app.id,
      commission_rate: commissionRate,
      tier: discountPercent >= 20 ? "creator_20" : "standard",
      approved_at: new Date().toISOString(),
      suspended_at: null,
      suspended_reason: null,
    }, { onConflict: "user_id" })
    .select("*")
    .maybeSingle();
  if (partnerError) throw new Error(`manual partner save failed: ${partnerError.message}`);

  const defaultCode = normalizeCode(body.code || `MF-${email.split("@")[0]}`);
  const codeResult = await upsertCode(client, {
    partner_user_id: user.id,
    code: defaultCode,
    discount_percent: discountPercent,
    campaign_label: asString(body.campaign_label, "Invited creator"),
    is_active: true,
  });

  await client.from("affiliate_audit_log").insert({
    actor_id: actor.id,
    action: "workspace_affiliate_partner_manual_created",
    entity_type: "partner",
    entity_id: user.id,
    diff: { actor_email: actor.email, email, code: defaultCode, discount_percent: discountPercent },
  });

  return { data: { application: app, partner, code: codeResult.data.code } };
}

async function toggleCode(client: SupabaseClient, body: Record<string, unknown>) {
  const codeId = asString(body.code_id);
  if (!codeId) throw new Error("code_id is required");
  const { data, error } = await client
    .from("referral_codes")
    .update({ is_active: body.is_active !== false, updated_at: new Date().toISOString() })
    .eq("id", codeId)
    .eq("code_type", "partner_affiliate")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`code toggle failed: ${error.message}`);
  if (!data) throw new Error("code not found");
  return { data: { code: data } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const admin = await verifyAdminJwt(req);
  if (!admin) return unauthorizedResponse(CORS_HEADERS);

  try {
    const body = await req.json().catch(() => ({}));
    const action = asString(body.action);
    const client = adminClient();
    const actor = { id: admin.sub, email: admin.email };

    switch (action) {
      case "workspace_affiliate_summary":
        return json(await getSummary(client));
      case "list_workspace_affiliate_applications":
        return json(await listApplications(client, body));
      case "list_workspace_affiliate_partners":
        return json(await listPartners(client));
      case "approve_workspace_affiliate_application":
        return json(await approveApplication(client, body, actor));
      case "reject_workspace_affiliate_application":
        return json(await rejectApplication(client, body, actor));
      case "upsert_workspace_affiliate_code":
        return json(await upsertCode(client, body));
      case "manual_create_workspace_affiliate_partner":
        return json(await manualCreatePartner(client, body, actor));
      case "toggle_workspace_affiliate_code":
        return json(await toggleCode(client, body));
      default:
        return json({ error: `Unsupported action: ${action}` }, 400);
    }
  } catch (error) {
    console.error("[admin_workspace_affiliates] Error:", error);
    return json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
});
