/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import {
  assertWorkspaceOwner,
  CORS_HEADERS,
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

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return json({ error: "share_id_required" }, 400);

  const service = serviceClient();
  try {
    const { data: share, error: shareErr } = await service
      .from("workspace_shares")
      .select("id,workspace_id,created_by,revoked_at")
      .eq("id", id)
      .maybeSingle();
    if (shareErr) throw new Error(`share_lookup_failed: ${shareErr.message}`);
    if (!share) return json({ error: "share_not_found" }, 404);

    await assertWorkspaceOwner(service, share.workspace_id, auth.user.id);

    const { error } = await service
      .from("workspace_shares")
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`share_revoke_failed: ${error.message}`);

    await service.from("workspace_share_grants").delete().eq("share_id", id);
    return json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "workspace_not_found"
      ? 404
      : message === "workspace_owner_required"
        ? 403
        : 500;
    console.error("[workspace_share_revoke]", message);
    return json({ error: message }, status);
  }
});
