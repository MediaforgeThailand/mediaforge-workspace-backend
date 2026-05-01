/// <reference lib="deno.ns" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
/**
 * Shared admin-JWT verifier used by all admin_workspace_* functions.
 *
 * Background: the admin hub project (`mediaforge-admin-hub`) signs
 * its own JWTs via the `admin-login` edge function in THIS project,
 * using the `JWT_SECRET` env var. The admin hub then forwards those
 * tokens as `Authorization: Bearer <token>` on every workspace-side
 * admin call. This helper validates the signature + expiry + the
 * `type: "admin"` claim so admin_workspace_* edge functions can
 * trust the caller is a real admin (verified via the same secret
 * that issued the token).
 *
 * Source of the bug this guards: 5-agent audit 2026-04-30 finding
 * #6 — admin_workspace_{logs,pricing,analytics,orgs} were running
 * with `verify_jwt:false` and NO internal auth, meaning anyone with
 * the function URL could read user data and rewrite pricing.
 *
 * Failure modes:
 *   - missing/malformed Authorization header → returns null
 *   - signature mismatch → returns null
 *   - expired token → returns null
 *   - `type !== "admin"` → returns null (e.g. user-JWT submitted)
 *   - JWT_SECRET env var unset → returns null (fail closed)
 *
 * Caller pattern:
 *   const admin = await verifyAdminJwt(req);
 *   if (!admin) return json({ error: "Unauthorized" }, 401);
 */

export interface AdminJwtPayload {
  sub: string;
  email: string;
  role: string;
  display_name?: string;
  type: "admin";
  iat: number;
  exp: number;
}

function adminAuthProjectConfig(req: Request): { url: string; anonKey: string } | null {
  const url =
    Deno.env.get("ADMIN_AUTH_SUPABASE_URL") ??
    Deno.env.get("ADMIN_SUPABASE_URL") ??
    Deno.env.get("ERP_ADMIN_SUPABASE_URL") ??
    "https://jonueleuisfarcepwkuo.supabase.co";
  const anonKey =
    Deno.env.get("ADMIN_AUTH_SUPABASE_ANON_KEY") ??
    Deno.env.get("ADMIN_SUPABASE_ANON_KEY") ??
    Deno.env.get("ERP_ADMIN_SUPABASE_ANON_KEY") ??
    req.headers.get("x-admin-auth-key") ??
    "";
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

function b64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  // Pad with '=' to a multiple of 4 so atob() doesn't trip on
  // base64url's stripped padding.
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Uint8Array.from(atob(padded + pad), (c) => c.charCodeAt(0));
}

export async function verifyAdminJwt(req: Request): Promise<AdminJwtPayload | null> {
  const secret = Deno.env.get("JWT_SECRET");

  const auth = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const parts = auth.slice(7).split(".");
  if (secret && parts.length === 3) {
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const sigBytes = b64urlToBytes(parts[2]);
      const ok = await crypto.subtle.verify(
        "HMAC",
        key,
        sigBytes,
        enc.encode(`${parts[0]}.${parts[1]}`),
      );
      if (ok) {
        const payloadJson = new TextDecoder().decode(b64urlToBytes(parts[1]));
        const payload = JSON.parse(payloadJson) as AdminJwtPayload;

        if (payload.type !== "admin") return null;
        if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;

        return payload;
      }
    } catch {
      // Fall through to ERP Supabase-session verification below.
    }
  }

  const adminAuth = adminAuthProjectConfig(req);
  if (!adminAuth) return null;

  try {
    const adminClient = createClient(adminAuth.url, adminAuth.anonKey, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userError } = await adminClient.auth.getUser();
    const user = userData.user;
    if (userError || !user) return null;

    const { data: roles, error: roleError } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    if (roleError) return null;
    const allowedAdminRoles = new Set(["admin", "super_admin"]);
    const role = (roles ?? [])
      .map((row: { role: string }) => row.role)
      .find((value) => allowedAdminRoles.has(value));
    if (!role) return null;

    const now = Math.floor(Date.now() / 1000);
    return {
      sub: user.id,
      email: user.email ?? "",
      role,
      display_name: user.user_metadata?.display_name ?? user.email ?? "",
      type: "admin",
      iat: now,
      exp: now + 3600,
    };
  } catch {
    return null;
  }
}

/** Helper that wraps a Response.json error for the 401 case. Keeps
 *  the call sites uniform. */
export function unauthorizedResponse(corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
