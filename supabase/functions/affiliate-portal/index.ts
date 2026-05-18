/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const UPGRADE_SALES_THRESHOLD_THB = 100_000;
const UPGRADE_DISCOUNT_PERCENT = 20;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function splitName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return {
    first: parts[0] || "Creator",
    last: parts.slice(1).join(" ") || "-",
  };
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

async function getAuthedUser(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function activeSalesTotal(rows: any[]): number {
  return rows
    .filter((row) => !["void", "clawback"].includes(String(row.status ?? "")))
    .reduce((sum, row) => sum + Number(row.net_amount_thb ?? row.gross_amount_thb ?? row.commission_base_amount_thb ?? 0), 0);
}

async function mintUpgradeCode(client: any, user: any, existingCode?: string | null) {
  // Derive a NEW code from the partner's referral code, never reuse it.
  // MF-AAH -> MF-AAH-20; falls back to seed if the partner has no code yet.
  const base = existingCode
    ? normalizeCode(`${existingCode}-20`)
    : normalizeCode(`MF-${asString(user.email).split("@")[0] || user.id.slice(0, 8)}-20`);
  for (let i = 0; i < 10; i += 1) {
    const code = i === 0 ? base : `${base}-${i + 1}`;
    const { data, error } = await client.from("referral_codes").select("id").eq("code", code).maybeSingle();
    if (error) throw new Error(`code lookup failed: ${error.message}`);
    if (!data) return code;
  }
  return normalizeCode(`MF-${crypto.randomUUID().slice(0, 8)}-20`);
}

async function maybeGrantSalesUpgradeCode(
  client: any,
  user: any,
  partner: any | null,
  codes: any[],
  salesTotalThb: number,
) {
  const unlocked = codes.some((code) => code.is_active !== false && Number(code.discount_percent ?? 0) >= UPGRADE_DISCOUNT_PERCENT);
  if (!partner || partner.suspended_at || salesTotalThb < UPGRADE_SALES_THRESHOLD_THB || unlocked) return codes;

  try {
    // Insert a NEW code alongside the existing referral code so the
    // partner's old `?ref=` links keep working as referral-only and
    // the discount code is a separate share-friendly handle.
    const existing = codes.find((code) => code.is_active !== false) ?? codes[0] ?? null;
    const code = await mintUpgradeCode(client, user, existing?.code ?? null);
    const payload = {
      user_id: user.id,
      code,
      code_type: "partner_affiliate",
      is_active: true,
      campaign_label: "100K sales upgrade",
      discount_percent: UPGRADE_DISCOUNT_PERCENT,
      stripe_coupon_id: null,
      discount_duration: "once",
      updated_at: new Date().toISOString(),
    };

    const { data: inserted, error: insertError } = await client
      .from("referral_codes")
      .insert(payload)
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);

    await client.from("affiliate_audit_log").insert({
      actor_id: user.id,
      action: "workspace_affiliate_upgrade_code_granted",
      entity_type: "referral_code",
      entity_id: inserted?.id ?? code,
      diff: {
        source: "self_serve_sales_threshold",
        partner_user_id: user.id,
        sales_total_thb: salesTotalThb,
        threshold_thb: UPGRADE_SALES_THRESHOLD_THB,
        discount_percent: UPGRADE_DISCOUNT_PERCENT,
        existing_code: existing?.code ?? null,
        new_code: code,
      },
    });

    const { data: refreshed, error: refreshError } = await client
      .from("referral_codes")
      .select("*")
      .eq("user_id", user.id)
      .eq("code_type", "partner_affiliate")
      .order("created_at");
    if (refreshError) throw new Error(refreshError.message);
    return refreshed ?? codes;
  } catch (error) {
    console.warn("[affiliate-portal] sales upgrade code grant skipped:", error);
    return codes;
  }
}

async function getStatus(user: any) {
  const userId = user.id;
  const client = adminClient();
  const [application, partner, codes, commissions] = await Promise.all([
    client.from("partner_applications").select("*").eq("user_id", userId).maybeSingle(),
    client.from("partners").select("*").eq("user_id", userId).maybeSingle(),
    client.from("referral_codes").select("*").eq("user_id", userId).eq("code_type", "partner_affiliate").order("created_at"),
    client.from("commission_events").select("*").eq("partner_user_id", userId).order("created_at", { ascending: false }).limit(1000),
  ]);
  if (application.error) throw new Error(`application read failed: ${application.error.message}`);
  if (partner.error) throw new Error(`partner read failed: ${partner.error.message}`);
  if (codes.error) throw new Error(`codes read failed: ${codes.error.message}`);
  if (commissions.error) throw new Error(`commissions read failed: ${commissions.error.message}`);

  const commissionRows = commissions.data ?? [];
  const salesTotalThb = activeSalesTotal(commissionRows);
  const resolvedCodes = await maybeGrantSalesUpgradeCode(client, user, partner.data ?? null, codes.data ?? [], salesTotalThb);

  const totals = commissionRows.reduce((acc: any, row: any) => {
    const amount = Number(row.commission_amount_thb ?? 0);
    acc.total += amount;
    if (row.status === "holding") acc.holding += amount;
    if (row.status === "available") acc.available += amount;
    if (row.status === "paid") acc.paid += amount;
    return acc;
  }, { total: 0, holding: 0, available: 0, paid: 0 });

  return {
    data: {
      application: application.data ?? null,
      partner: partner.data ?? null,
      codes: resolvedCodes,
      commissions: commissionRows.slice(0, 50),
      totals,
      sales_total_thb: salesTotalThb,
      upgrade: {
        threshold_thb: UPGRADE_SALES_THRESHOLD_THB,
        discount_percent: UPGRADE_DISCOUNT_PERCENT,
        sales_total_thb: salesTotalThb,
        remaining_thb: Math.max(0, UPGRADE_SALES_THRESHOLD_THB - salesTotalThb),
        eligible: salesTotalThb >= UPGRADE_SALES_THRESHOLD_THB,
        unlocked: resolvedCodes.some((code) => code.is_active !== false && Number(code.discount_percent ?? 0) >= UPGRADE_DISCOUNT_PERCENT),
      },
    },
  };
}

async function submitApplication(user: any, body: Record<string, unknown>) {
  const fullName = asString(body.full_name) || asString(user.user_metadata?.full_name) || asString(user.email).split("@")[0];
  const name = splitName(fullName);
  const phone = asString(body.phone);
  const socialUrl = asString(body.social_profile_url);
  const bankName = asString(body.bank_name);
  const bankAccountNo = asString(body.bank_account_no);
  const bankAccountName = asString(body.bank_account_name) || fullName;

  if (!phone) throw new Error("phone is required");
  if (!socialUrl) throw new Error("social profile URL is required");
  if (!bankName || !bankAccountNo || !bankAccountName) throw new Error("bank details are required");

  const client = adminClient();
  const { data: existing, error: existingError } = await client
    .from("partner_applications")
    .select("id,status,submitted_at,reviewed_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingError) throw new Error(`application read failed: ${existingError.message}`);

  // Cooldowns: there is at most one application per user (UNIQUE), so
  // "rate limit" here means "stop the same row from being thrashed".
  if (existing) {
    const submittedAt = existing.submitted_at ? new Date(existing.submitted_at).getTime() : 0;
    const reviewedAt = existing.reviewed_at ? new Date(existing.reviewed_at).getTime() : 0;
    const now = Date.now();
    if (existing.status === "submitted" && submittedAt && now - submittedAt < 30 * 60_000) {
      throw new Error("Your application is already in review. Please wait at least 30 minutes before resubmitting.");
    }
    if (existing.status === "rejected" && reviewedAt && now - reviewedAt < 24 * 60 * 60_000) {
      throw new Error("Your application was reviewed recently. Please wait 24 hours before resubmitting.");
    }
  }

  const payload = {
    user_id: user.id,
    legal_first_name: name.first,
    legal_last_name: name.last,
    phone_e164: phone,
    bank_name: bankName,
    bank_account_no: bankAccountNo,
    bank_account_name: bankAccountName,
    social_profile_url: socialUrl,
    social_platform: asString(body.social_platform),
    follower_count: Math.max(0, Math.trunc(asNumber(body.follower_count, 0))),
    status: existing?.status === "approved" ? "approved" : "submitted",
    submitted_at: new Date().toISOString(),
  };

  const query = existing
    ? client.from("partner_applications").update(payload).eq("id", existing.id)
    : client.from("partner_applications").insert(payload);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new Error(`application save failed: ${error.message}`);

  return { data: { application: data } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const user = await getAuthedUser(req);
    if (!user) return json({ error: "Unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const action = asString(body.action, "get_affiliate_status");

    switch (action) {
      case "get_affiliate_status":
        return json(await getStatus(user));
      case "submit_affiliate_application":
        return json(await submitApplication(user, body));
      default:
        return json({ error: `Unsupported action: ${action}` }, 400);
    }
  } catch (error) {
    console.error("[affiliate-portal] Error:", error);
    return json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
});
