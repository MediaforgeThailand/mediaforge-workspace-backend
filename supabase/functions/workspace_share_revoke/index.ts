/**
 * workspace_share_revoke
 *
 * Mark a share row as revoked. The row is preserved (revoked=true)
 * for audit, but every subsequent resolve fails with reason "revoked".
 *
 * Inputs: { id: string }   — share row id (uuid)
 * Output: { ok: true }
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

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const id = body.id?.trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "id required" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ── Verify caller owns the share, then flip revoked flag ──
   * We do this atomically via an UPDATE … WHERE created_by = caller
   * so a stale id from another user can't slip through. */
  const { data: row, error } = await admin
    .from("workspace_shares")
    .update({ revoked: true })
    .eq("id", id)
    .eq("created_by", user.id)
    .select("id, workspace_id")
    .maybeSingle();

  if (error) {
    console.error("[workspace_share_revoke] update failed", error);
    return new Response(JSON.stringify({ error: "Revoke failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
  if (!row) {
    return new Response(
      JSON.stringify({ error: "Share not found or not yours" }),
      { status: 404, headers: jsonHeaders },
    );
  }

  // Best-effort audit log
  try {
    await admin.from("admin_audit_logs").insert({
      action: "workspace_share_revoke",
      actor_user_id: user.id,
      target_id: row.workspace_id,
      metadata: { share_id: row.id },
    });
  } catch (auditErr) {
    console.warn("[workspace_share_revoke] audit log skipped", auditErr);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: jsonHeaders,
  });
});
