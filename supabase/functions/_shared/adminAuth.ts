/// <reference lib="deno.ns" />
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

function b64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  // Pad with '=' to a multiple of 4 so atob() doesn't trip on
  // base64url's stripped padding.
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Uint8Array.from(atob(padded + pad), (c) => c.charCodeAt(0));
}

export async function verifyAdminJwt(req: Request): Promise<AdminJwtPayload | null> {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) return null; // fail closed when the secret is missing

  const auth = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const parts = auth.slice(7).split(".");
  if (parts.length !== 3) return null;

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
    if (!ok) return null;

    const payloadJson = new TextDecoder().decode(b64urlToBytes(parts[1]));
    const payload = JSON.parse(payloadJson) as AdminJwtPayload;

    if (payload.type !== "admin") return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;

    return payload;
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
