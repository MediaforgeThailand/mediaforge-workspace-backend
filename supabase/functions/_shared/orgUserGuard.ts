// orgUserGuard — defence-in-depth for the workspace-only org-user model.
//
// Frontend already prevents org users from navigating to billing/creator/
// flow-run routes via OrgUserBlockGate. This guard mirrors that on the
// server: any function listed below the comment block in each edge
// function file should call `rejectIfOrgUser()` BEFORE doing real work,
// so a hand-crafted curl from an org user's JWT is also rejected.
//
// Returns:
//   - Response (403) → caller should immediately return it
//   - null            → caller is consumer or guest, proceed as normal
//
// The check is intentionally service-role + read-only on `profiles` so it
// works regardless of RLS policy changes.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function forbidden(extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      error: "forbidden_for_org_users",
      message:
        "Organisation accounts are restricted to /app/workspace and cannot use this endpoint. " +
        "If you need access to a billing or consumer feature, talk to your platform administrator.",
      ...extra,
    }),
    {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

/**
 * Reject an authenticated org user.
 *
 * Usage at the top of a route:
 *
 *   const block = await rejectIfOrgUser(req);
 *   if (block) return block;
 *
 * Behaviour:
 *  - No Authorization header           → returns null (let caller's own auth
 *                                          check fire — guards do not
 *                                          _enforce_ auth, only _reject_
 *                                          when a known org user is signed in)
 *  - Token cannot be resolved          → returns null
 *  - Profile.organization_id is null   → returns null (not org-scoped)
 *  - Profile.organization_id is set    → returns Response 403
 *  - Profile.account_type='org_user'   → returns Response 403 (covers edge
 *                                          case where organization_id was
 *                                          NULLed but account_type stayed)
 *
 * Schema C: profile.organization_id is the source of truth (column was
 * renamed from `org_id` in migration 20260430000020_extend_profiles.sql).
 */
export async function rejectIfOrgUser(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return null;

  // Resolve caller from JWT
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  // Read profile via service role (bypass RLS)
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: profile } = await admin
    .from("profiles")
    .select("organization_id, account_type")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  const p = profile as any;
  if (p?.organization_id || p?.account_type === "org_user") {
    return forbidden({ user_id: userData.user.id });
  }
  return null;
}
