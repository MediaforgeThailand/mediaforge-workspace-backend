/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import {
  assertWorkspaceOwner,
  buildShareUrl,
  CORS_HEADERS,
  json,
  publicShareOrigin,
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
  if (!workspaceId) return json({ error: "workspace_id_required" }, 400);

  const service = serviceClient();
  try {
    await assertWorkspaceOwner(service, workspaceId, auth.user.id);

    const { data, error } = await service
      .from("workspace_shares")
      .select("id,workspace_id,role,token,expires_at,created_at,revoked_at")
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });

    if (error) throw new Error(`share_list_failed: ${error.message}`);

    const origin = publicShareOrigin(req, body);
    return json({
      shares: (data ?? []).map((row: any) => ({
        id: row.id,
        role: row.role,
        token: row.token,
        expires_at: row.expires_at,
        created_at: row.created_at,
        revoked: Boolean(row.revoked_at),
        share_url: buildShareUrl(origin, workspaceId, row.token),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "workspace_not_found"
      ? 404
      : message === "workspace_owner_required"
        ? 403
        : 500;
    console.error("[workspace_share_list]", message);
    return json({ error: message }, status);
  }
});
