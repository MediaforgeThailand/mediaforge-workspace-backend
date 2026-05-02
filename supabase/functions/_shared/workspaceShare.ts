// deno-lint-ignore-file no-explicit-any
import { createClient, type SupabaseClient, type User } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    [
      "authorization",
      "x-client-info",
      "apikey",
      "content-type",
      "x-supabase-client-platform",
      "x-supabase-client-platform-version",
      "x-supabase-client-runtime",
      "x-supabase-client-runtime-version",
    ].join(", "),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function serviceClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

export function userClient(authHeader: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
}

export async function requireUser(req: Request): Promise<{
  user: User;
  authHeader: string;
  client: SupabaseClient;
} | Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const client = userClient(authHeader);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return json({ error: "unauthorized" }, 401);

  return { user, authHeader, client };
}

export async function readJson(req: Request): Promise<Record<string, any> | Response> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return json({ error: "invalid_json" }, 400);
    return body as Record<string, any>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    return host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("127.");
  } catch {
    return true;
  }
}

export function publicShareOrigin(req: Request, body?: Record<string, any>): string {
  const preferred =
    Deno.env.get("PUBLIC_WORKSPACE_APP_URL") ||
    Deno.env.get("WORKSPACE_APP_URL") ||
    Deno.env.get("SITE_URL") ||
    "https://workspace.mediaforge.co";

  const fromBody = typeof body?.app_origin === "string" ? body.app_origin : "";
  const fromHeader = req.headers.get("origin") ?? "";
  const candidate = fromBody || fromHeader;

  if (!candidate || isLocalOrigin(candidate)) return preferred.replace(/\/+$/, "");

  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}`.replace(/\/+$/, "");
  } catch {
    return preferred.replace(/\/+$/, "");
  }
}

export function buildShareUrl(origin: string, workspaceId: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/app/workspace/${encodeURIComponent(workspaceId)}?share=${encodeURIComponent(token)}`;
}

export async function getWorkspace(service: SupabaseClient, workspaceId: string) {
  const { data, error } = await service
    .from("workspaces")
    .select("id,user_id,project_id,name,created_at,updated_at")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`workspace_lookup_failed: ${error.message}`);
  return data as {
    id: string;
    user_id: string;
    project_id: string | null;
    name: string;
    created_at: string;
    updated_at: string;
  } | null;
}

export async function assertWorkspaceOwner(
  service: SupabaseClient,
  workspaceId: string,
  userId: string,
) {
  const workspace = await getWorkspace(service, workspaceId);
  if (!workspace) throw new Error("workspace_not_found");
  if (workspace.user_id !== userId) throw new Error("workspace_owner_required");
  return workspace;
}
