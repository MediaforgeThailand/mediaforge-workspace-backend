/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import {
  assertWorkspaceOwner,
  buildShareUrl,
  CORS_HEADERS,
  json,
  publicShareOrigin,
  randomToken,
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
  const role = body.role === "editor" ? "editor" : "viewer";
  if (!workspaceId) return json({ error: "workspace_id_required" }, 400);

  const service = serviceClient();
  try {
    await assertWorkspaceOwner(service, workspaceId, auth.user.id);

    const token = randomToken();
    const expiresAt =
      typeof body.expires_at === "string" && body.expires_at
        ? new Date(body.expires_at).toISOString()
        : null;

    const { data, error } = await service
      .from("workspace_shares")
      .insert({
        workspace_id: workspaceId,
        created_by: auth.user.id,
        role,
        token,
        expires_at: expiresAt,
      })
      .select("id,workspace_id,role,token,expires_at,created_at,revoked_at")
      .single();

    if (error) throw new Error(`share_create_failed: ${error.message}`);

    const origin = publicShareOrigin(req, body);
    return json({
      id: data.id,
      token,
      role: data.role,
      expires_at: data.expires_at,
      created_at: data.created_at,
      revoked: Boolean(data.revoked_at),
      share_url: buildShareUrl(origin, workspaceId, token),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "workspace_not_found"
      ? 404
      : message === "workspace_owner_required"
        ? 403
        : 500;
    console.error("[workspace_share_create]", message);
    return json({ error: message }, status);
  }
});
