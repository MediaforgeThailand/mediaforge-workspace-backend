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

async function getStatus(userId: string) {
  const client = adminClient();
  const [application, partner, codes, commissions] = await Promise.all([
    client.from("partner_applications").select("*").eq("user_id", userId).maybeSingle(),
    client.from("partners").select("*").eq("user_id", userId).maybeSingle(),
    client.from("referral_codes").select("*").eq("user_id", userId).eq("code_type", "partner_affiliate").order("created_at"),
    client.from("commission_events").select("*").eq("partner_user_id", userId).order("created_at", { ascending: false }).limit(50),
  ]);
  if (application.error) throw new Error(`application read failed: ${application.error.message}`);
  if (partner.error) throw new Error(`partner read failed: ${partner.error.message}`);
  if (codes.error) throw new Error(`codes read failed: ${codes.error.message}`);
  if (commissions.error) throw new Error(`commissions read failed: ${commissions.error.message}`);

  const totals = (commissions.data ?? []).reduce((acc: any, row: any) => {
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
      codes: codes.data ?? [],
      commissions: commissions.data ?? [],
      totals,
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
    .select("id,status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingError) throw new Error(`application read failed: ${existingError.message}`);

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
        return json(await getStatus(user.id));
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
