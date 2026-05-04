/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any
//
// mf-um-class-enroll
// ------------------
// Endpoint students hit after scanning a teacher's QR code.
//
//   POST { code: "DM-2026-X8K9", student_code: "6612345" }
//
// Returns:
//   { ok: true, class_id, class_name, starting_balance, ... }
//   { ok: false, error: "code_expired" | "class_full" | "already_redeemed" | ... }
//
// Auth: requires a Supabase session. Resolves user_id from JWT and passes
// it to redeem_enrollment_code() which handles all DB writes atomically
// (upsert membership, log enrolment, grant initial credits per class policy).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Resolve caller from JWT
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ ok: false, error: "not_signed_in" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) return json({ ok: false, error: "invalid_session" }, 401);

  let body: { code?: unknown; student_code?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code || code.length < 6 || code.length > 32) {
    return json({ ok: false, error: "invalid_code" }, 400);
  }
  const studentCode = typeof body.student_code === "string"
    ? body.student_code.trim()
    : null;
  if (!studentCode) {
    return json({ ok: false, error: "student_code_required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await admin.rpc("redeem_enrollment_code", {
    p_code: code,
    p_user_id: userData.user.id,
    p_student_code: studentCode,
  });
  if (error) {
    console.error("[mf-um-class-enroll] rpc error:", error.message);
    return json({ ok: false, error: "internal_error", detail: error.message }, 500);
  }

  // The redeem_enrollment_code RPC handles profile.organization_id + the
  // organization_memberships upsert internally (Schema C, see migration 170)
  // so the edge fn no longer needs to mirror the side-effects here. Just
  // return the RPC result as-is.
  const result = data as any;
  return json(result ?? { ok: false, error: "no_response" });
});
