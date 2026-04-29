/**
 * workspace_share_create
 *
 * Mint a share link for a workspace. Only the workspace owner can
 * mint. Returns the freshly-generated row + a fully-qualified share
 * URL the dialog can copy to clipboard.
 *
 * Inputs:
 *   { workspace_id: string, role: 'viewer' | 'editor' }
 *
 * Output:
 *   { id, token, role, expires_at, share_url }
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

/** Generate a ~64-char hex token from two crypto.randomUUID() calls.
 *  256 bits of entropy from the first UUID alone; doubling stays
 *  comfortably URL-safe and gives us margin if we ever want to embed
 *  versioning prefixes. */
function generateToken(): string {
  return (
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "")
  );
}

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

  let body: { workspace_id?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const workspaceId = body.workspace_id?.trim();
  const role = body.role;

  if (!workspaceId) {
    return new Response(JSON.stringify({ error: "workspace_id required" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  if (role !== "viewer" && role !== "editor") {
    return new Response(
      JSON.stringify({ error: "role must be 'viewer' or 'editor'" }),
      { status: 400, headers: jsonHeaders },
    );
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ── Ownership check ────────────────────────────────────────
   * Only the workspace owner (or a team member, once teams are
   * wired up) may mint share links. We check `workspaces.user_id`
   * which is the canonical owner column; team_members are not
   * permitted to mint until org-wide sharing is shipped — they
   * can be added later by extending this OR clause. */
  const { data: workspace, error: wsErr } = await admin
    .from("workspaces")
    .select("id, user_id, name")
    .eq("id", workspaceId)
    .maybeSingle();

  if (wsErr) {
    console.error("[workspace_share_create] workspace lookup failed", wsErr);
    return new Response(JSON.stringify({ error: "Workspace lookup failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
  if (!workspace) {
    return new Response(JSON.stringify({ error: "Workspace not found" }), {
      status: 404,
      headers: jsonHeaders,
    });
  }
  if (workspace.user_id !== user.id) {
    return new Response(
      JSON.stringify({ error: "Only the workspace owner can mint share links" }),
      { status: 403, headers: jsonHeaders },
    );
  }

  /* ── Insert ────────────────────────────────────────────────── */
  const token = generateToken();
  const { data: row, error: insErr } = await admin
    .from("workspace_shares")
    .insert({
      workspace_id: workspaceId,
      created_by: user.id,
      role,
      token,
    })
    .select("id, token, role, expires_at, created_at")
    .single();

  if (insErr || !row) {
    console.error("[workspace_share_create] insert failed", insErr);
    return new Response(JSON.stringify({ error: "Failed to create share" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  /* ── Build share URL ────────────────────────────────────────
   * The Origin header is set by the browser; fall back to a
   * configured workspace origin env var if the call came from a
   * non-browser context. */
  const origin =
    req.headers.get("origin") ||
    req.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
    Deno.env.get("WORKSPACE_PUBLIC_ORIGIN") ||
    "https://workspace.mediaforge.co";

  const shareUrl = `${origin.replace(/\/$/, "")}/app/workspace/${workspaceId}?share=${token}`;

  /* ── Optional audit log row ──────────────────────────────────
   * admin_audit_logs exists in this project — write a best-effort
   * row so the admin panel can surface share-mint events. We
   * don't fail the request if the insert errors. */
  try {
    await admin.from("admin_audit_logs").insert({
      action: "workspace_share_create",
      actor_user_id: user.id,
      target_id: workspaceId,
      metadata: {
        share_id: row.id,
        role: row.role,
        expires_at: row.expires_at,
      },
    });
  } catch (auditErr) {
    // best-effort — schema may not match; don't fail the mint
    console.warn("[workspace_share_create] audit log skipped", auditErr);
  }

  return new Response(
    JSON.stringify({
      id: row.id,
      token: row.token,
      role: row.role,
      expires_at: row.expires_at,
      created_at: row.created_at,
      share_url: shareUrl,
    }),
    { status: 200, headers: jsonHeaders },
  );
});
