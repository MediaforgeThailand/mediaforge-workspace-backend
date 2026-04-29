/**
 * workspace_share_list
 *
 * Returns active (non-revoked) share links for a workspace. Only
 * the workspace owner may call. Used by the Share dialog to render
 * the list of currently-active links with role + creation date.
 *
 * Inputs:  { workspace_id: string }
 * Output:  { shares: Array<{ id, role, token, share_url, created_at,
 *           expires_at, revoked }> }
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

  let body: { workspace_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const workspaceId = body.workspace_id?.trim();
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: "workspace_id required" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  /* ── Ownership check ─── */
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, user_id")
    .eq("id", workspaceId)
    .maybeSingle();

  if (!workspace || workspace.user_id !== user.id) {
    return new Response(
      JSON.stringify({ error: "Forbidden" }),
      { status: 403, headers: jsonHeaders },
    );
  }

  const { data: rows, error } = await admin
    .from("workspace_shares")
    .select("id, role, token, expires_at, created_at, revoked")
    .eq("workspace_id", workspaceId)
    .eq("revoked", false)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[workspace_share_list] failed", error);
    return new Response(JSON.stringify({ error: "List failed" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const origin =
    req.headers.get("origin") ||
    req.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
    Deno.env.get("WORKSPACE_PUBLIC_ORIGIN") ||
    "https://workspace.mediaforge.co";

  const shares = (rows || []).map((r) => ({
    ...r,
    share_url: `${origin.replace(/\/$/, "")}/app/workspace/${workspaceId}?share=${r.token}`,
  }));

  return new Response(JSON.stringify({ shares }), {
    status: 200,
    headers: jsonHeaders,
  });
});
