/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import {
  CORS_HEADERS,
  getWorkspace,
  json,
  readJson,
  requireUser,
  serviceClient,
} from "../_shared/workspaceShare.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await readJson(req);
  if (body instanceof Response) return body;

  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!workspaceId || !token) {
    return json({ valid: false, reason: "invalid" });
  }

  const service = serviceClient();
  try {
    const { data: share, error: shareErr } = await service
      .from("workspace_shares")
      .select("id,workspace_id,created_by,role,token,expires_at,revoked_at,created_at")
      .eq("workspace_id", workspaceId)
      .eq("token", token)
      .maybeSingle();

    if (shareErr) throw new Error(`share_lookup_failed: ${shareErr.message}`);
    if (!share) return json({ valid: false, reason: "invalid" });
    if (share.revoked_at) return json({ valid: false, reason: "revoked" });
    if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
      return json({ valid: false, reason: "expired" });
    }

    const workspace = await getWorkspace(service, workspaceId);
    if (!workspace) return json({ valid: false, reason: "invalid" });

    const { data: profile } = await service
      .from("profiles")
      .select("display_name")
      .eq("user_id", workspace.user_id)
      .maybeSingle();

    const ownerLabel =
      (profile as any)?.display_name ||
      "Workspace owner";

    if (auth.user.id !== workspace.user_id) {
      const { error: grantErr } = await service
        .from("workspace_share_grants")
        .upsert(
          {
            share_id: share.id,
            workspace_id: workspaceId,
            user_id: auth.user.id,
            role: share.role,
            last_resolved_at: new Date().toISOString(),
          },
          { onConflict: "share_id,user_id" },
        );
      if (grantErr) throw new Error(`share_grant_failed: ${grantErr.message}`);
    }

    return json({
      valid: true,
      role: share.role,
      ownerLabel,
      shareId: share.id,
      workspace: {
        id: workspace.id,
        user_id: workspace.user_id,
        project_id: workspace.project_id,
        name: workspace.name,
        created_at: workspace.created_at,
        updated_at: workspace.updated_at,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[workspace_share_resolve]", message);
    return json({ valid: false, reason: "network", error: message }, 500);
  }
});
