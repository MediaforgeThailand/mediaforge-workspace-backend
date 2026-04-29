/**
 * workspace_share_resolve
 *
 * Given a workspace_id + token, return the role the visiting user
 * should be granted ("viewer" | "editor"), or a structured reason
 * when the share is no longer valid (revoked / expired / invalid).
 *
 * Auth: signed-in users only — viewer access still requires a
 * Supabase session. Anonymous requests are rejected with 401 so the
 * frontend can redirect to /auth?redirect=<current-url>.
 *
 * Side effect: a `workspace_share_visits` row is written on every
 * successful resolve so the owner can audit who has opened the link.
 */

/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthUser, unauthorized } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  let body: { workspace_id?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const workspaceId = body.workspace_id?.trim();
  const token = body.token?.trim();

  if (!workspaceId || !token) {
    return new Response(
      JSON.stringify({ error: "workspace_id and token required" }),
      { status: 400, headers: jsonHeaders },
    );
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ── Look up the share row ──────────────────────────────────
   * Service-role bypasses RLS so we can resolve tokens for non-
   * owners. We never expose the row directly — only the role +
   * a friendly owner label go back over the wire. */
  const { data: share, error: shareErr } = await admin
    .from("workspace_shares")
    .select("id, workspace_id, created_by, role, expires_at, revoked")
    .eq("token", token)
    .maybeSingle();

  if (shareErr) {
    console.error("[workspace_share_resolve] lookup failed", shareErr);
    return new Response(JSON.stringify({ error: "Lookup failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  if (!share) {
    return new Response(
      JSON.stringify({ valid: false, reason: "invalid" }),
      { status: 200, headers: jsonHeaders },
    );
  }

  if (share.workspace_id !== workspaceId) {
    return new Response(
      JSON.stringify({ valid: false, reason: "invalid" }),
      { status: 200, headers: jsonHeaders },
    );
  }

  if (share.revoked) {
    return new Response(
      JSON.stringify({ valid: false, reason: "revoked" }),
      { status: 200, headers: jsonHeaders },
    );
  }

  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return new Response(
      JSON.stringify({ valid: false, reason: "expired" }),
      { status: 200, headers: jsonHeaders },
    );
  }

  /* ── Owner label — display_name from profiles, fall back to email ── */
  let ownerLabel = "Workspace owner";
  try {
    const { data: ownerProfile } = await admin
      .from("profiles")
      .select("display_name")
      .eq("user_id", share.created_by)
      .maybeSingle();
    if (ownerProfile?.display_name) {
      ownerLabel = ownerProfile.display_name;
    } else {
      const { data: ownerAuth } = await admin.auth.admin.getUserById(
        share.created_by,
      );
      if (ownerAuth?.user?.email) ownerLabel = ownerAuth.user.email;
    }
  } catch (labelErr) {
    console.warn("[workspace_share_resolve] owner label lookup failed", labelErr);
  }

  /* ── Audit visit ─────────────────────────────────────────────
   * Write the visit row in a non-blocking way — even if it fails
   * we still want to return success so the user can enter the
   * workspace. Composite PK includes visited_at so re-entries
   * land as new rows. */
  try {
    await admin.from("workspace_share_visits").insert({
      share_id: share.id,
      user_id: user.id,
      role: share.role,
    });
  } catch (visitErr) {
    console.warn("[workspace_share_resolve] visit log skipped", visitErr);
  }

  return new Response(
    JSON.stringify({
      valid: true,
      role: share.role,
      ownerLabel,
      ownerId: share.created_by,
      shareId: share.id,
      expiresAt: share.expires_at,
    }),
    { status: 200, headers: jsonHeaders },
  );
});
