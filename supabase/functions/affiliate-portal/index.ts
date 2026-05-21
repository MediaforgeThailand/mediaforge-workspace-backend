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

const SOCIAL_PLATFORM_VALUES = new Set([
  "YouTube",
  "TikTok",
  "Instagram",
  "Facebook",
  "X / Twitter",
  "Threads",
  "Twitch",
  "Website / Blog",
  "Podcast",
  "Other",
]);

const THAI_BANK_VALUES = new Set([
  "Bangkok Bank (BBL)",
  "Kasikornbank (KBank)",
  "Krungthai Bank (KTB)",
  "Siam Commercial Bank (SCB)",
  "Bank of Ayudhya / Krungsri (BAY)",
  "TMBThanachart Bank (ttb)",
  "Government Savings Bank (GSB)",
  "BAAC",
  "Government Housing Bank (GHB)",
  "Kiatnakin Phatra Bank (KKP)",
  "CIMB Thai Bank",
  "TISCO Bank",
  "United Overseas Bank (Thai) / UOB",
  "LH Bank",
  "Thai Credit Bank",
  "Islamic Bank of Thailand",
  "Standard Chartered Bank (Thai)",
  "ICBC (Thai)",
  "Bank of China (Thai)",
  "SME D Bank",
  "EXIM Bank Thailand",
  "Other Thai bank",
]);

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

function normalizePhone(raw: string): string {
  const trimmed = raw.replace(/[\s-]/g, "");
  if (/^0\d{8,9}$/.test(trimmed)) return `+66${trimmed.slice(1)}`;
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  throw new Error("phone must be Thai local format or E.164");
}

function normalizeBankAccountNo(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (!/^\d{6,15}$/.test(digits)) {
    throw new Error("bank account number must be 6-15 digits");
  }
  return digits;
}

function normalizeSocialProfileUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return url.toString();
  } catch {
    throw new Error("social profile URL must be a valid http(s) URL");
  }
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

async function maybeGrantSalesUpgradeCode(
  client: any,
  user: any,
  partner: any | null,
  codes: any[],
  salesTotalThb: number,
) {
  const unlocked = codes.some((code) => code.is_active !== false && Number(code.discount_percent ?? 0) >= UPGRADE_DISCOUNT_PERCENT);
  if (!partner || partner.suspended_at || salesTotalThb < UPGRADE_SALES_THRESHOLD_THB || unlocked) return codes;

  // Atomic grant via SECURITY DEFINER RPC. Replaces the prior 3-call
  // sequence (INSERT code → INSERT audit → SELECT refreshed) that could
  // orphan a code without an audit row (or vice versa) if a step failed.
  const { data: rpcResult, error: rpcError } = await client.rpc("grant_sales_upgrade_code", {
    p_user_id: user.id,
    p_email: user.email ?? "",
    p_sales_total_thb: salesTotalThb,
    p_threshold_thb: UPGRADE_SALES_THRESHOLD_THB,
    p_discount_percent: UPGRADE_DISCOUNT_PERCENT,
  });

  if (rpcError) {
    console.warn("[affiliate-portal] grant_sales_upgrade_code RPC failed:", rpcError);
    return codes;
  }
  // RPC returns NULL when no grant happened (gates failed or idempotent skip).
  if (!rpcResult) return codes;

  const { data: refreshed, error: refreshError } = await client
    .from("referral_codes")
    .select("*")
    .eq("user_id", user.id)
    .eq("code_type", "partner_affiliate")
    .order("created_at");
  if (refreshError) {
    console.warn("[affiliate-portal] post-grant refresh failed:", refreshError);
    return codes;
  }
  return refreshed ?? codes;
}

async function getStatus(user: any) {
  const userId = user.id;
  const client = adminClient();
  const [application, partner, codes, commissions, ledgerTotals] = await Promise.all([
    client.from("partner_applications").select("*").eq("user_id", userId).maybeSingle(),
    client.from("partners").select("*").eq("user_id", userId).maybeSingle(),
    client.from("referral_codes").select("*").eq("user_id", userId).eq("code_type", "partner_affiliate").order("created_at"),
    client.from("commission_events").select("*").eq("partner_user_id", userId).order("created_at", { ascending: false }).limit(50),
    client.rpc("affiliate_partner_status_totals", { p_partner_user_id: userId }).maybeSingle(),
  ]);
  if (application.error) throw new Error(`application read failed: ${application.error.message}`);
  if (partner.error) throw new Error(`partner read failed: ${partner.error.message}`);
  if (codes.error) throw new Error(`codes read failed: ${codes.error.message}`);
  if (commissions.error) throw new Error(`commissions read failed: ${commissions.error.message}`);
  if (ledgerTotals.error) throw new Error(`commission totals read failed: ${ledgerTotals.error.message}`);

  const commissionRows = commissions.data ?? [];
  const totalsRow = ledgerTotals.data ?? {};
  const totals = {
    total: Number(totalsRow.total ?? 0),
    holding: Number(totalsRow.holding ?? 0),
    available: Number(totalsRow.available ?? 0),
    paid: Number(totalsRow.paid ?? 0),
  };
  const salesTotalThb = Number(totalsRow.sales_total_thb ?? 0);
  const resolvedCodes = await maybeGrantSalesUpgradeCode(client, user, partner.data ?? null, codes.data ?? [], salesTotalThb);

  return {
    data: {
      application: application.data ?? null,
      partner: partner.data ?? null,
      codes: resolvedCodes,
      commissions: commissionRows,
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
  const rawPhone = asString(body.phone);
  if (!rawPhone) throw new Error("phone is required");
  const phone = normalizePhone(rawPhone);
  const socialUrl = normalizeSocialProfileUrl(asString(body.social_profile_url));
  const socialPlatform = asString(body.social_platform);
  const bankName = asString(body.bank_name);
  const bankAccountNo = normalizeBankAccountNo(asString(body.bank_account_no));
  const bankAccountName = asString(body.bank_account_name) || fullName;

  if (!socialUrl) throw new Error("social profile URL is required");
  if (!bankName || !bankAccountNo || !bankAccountName) throw new Error("bank details are required");
  if (socialPlatform && !SOCIAL_PLATFORM_VALUES.has(socialPlatform)) throw new Error("invalid social platform");
  if (!THAI_BANK_VALUES.has(bankName)) throw new Error("invalid Thai bank name");

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
    social_platform: socialPlatform,
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
