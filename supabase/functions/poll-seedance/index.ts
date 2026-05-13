/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SEEDANCE_BASE,
  SEEDANCE_TASKS_PATH,
  humanizeSeedanceErrorMessage,
  loadSeedanceCredentials,
  pollSeedanceOnce,
} from "../_shared/seedance.ts";

/**
 * poll-seedance — standalone status poller for Seedance / BytePlus Ark
 * video tasks. Extracted from workspace-run-node action="poll_seedance"
 * to dodge that function's heavy import overhead (~316KB bundle, 5,978
 * lines) which causes Edge Worker cold starts to occasionally exceed
 * the 1-2s CPU budget and return HTTP 546.
 *
 * This function imports only what it needs (Seedance helpers + Supabase
 * storage client), so its bundle stays small and cold start stays well
 * under the platform limit.
 *
 * Auth: dual-mode (matches the original handler).
 *   - Worker mode: x-workspace-worker-secret + x-workspace-worker-user-id
 *     (Bearer must carry SUPABASE_SERVICE_ROLE_KEY)
 *   - User mode: standard Bearer JWT verified via getUser()
 *
 * Body params:
 *   - task_id (string, required)
 *   - poll_endpoint (string, required — BytePlus tasks endpoint)
 *   - model (string, optional — picks v1 vs v2 API key)
 *   - provider_model_id (string, optional)
 *
 * Response: { status, task_id, url, message } — same shape as the
 * legacy workspace-run-node action="poll_seedance".
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, x-workspace-worker-secret, x-workspace-worker-user-id, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

interface AuthedUser {
  id: string;
  isWorker: boolean;
}

/**
 * Load the worker-handshake secret the same way workspace-run-node does:
 * env first (WORKSPACE_WORKER_SECRET, then CRON_SECRET), and on miss
 * fall back to vault.decrypted_secrets via the get_retry_worker_cron_secret
 * RPC. Without this fallback, deployments that keep the secret only in
 * vault produce a handshake mismatch — workspace-run-node sends the vault
 * value, poll-seedance sees an empty env string, and every durable-worker
 * seedance poll returns 401 unauthorized.
 */
async function loadExpectedWorkerSecret(): Promise<string> {
  const envSecret =
    Deno.env.get("WORKSPACE_WORKER_SECRET") ??
    Deno.env.get("CRON_SECRET") ??
    "";
  if (envSecret) return envSecret;
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data, error } = await admin.rpc("get_retry_worker_cron_secret");
    if (!error && data) return String(data);
  } catch (err) {
    console.warn(
      "[poll-seedance] worker secret vault lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return "";
}

async function resolveCaller(req: Request): Promise<AuthedUser | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const workerSecret =
    req.headers.get("x-workspace-worker-secret") ??
    req.headers.get("x-cron-secret") ??
    "";

  // Worker mode — service-role bearer + matching worker secret + explicit user_id header
  if (serviceRoleKey && token === serviceRoleKey && workerSecret) {
    const expectedWorkerSecret = await loadExpectedWorkerSecret();
    if (expectedWorkerSecret && workerSecret === expectedWorkerSecret) {
      const userId = req.headers.get("x-workspace-worker-user-id") ?? "";
      if (!userId) return null;
      return { id: userId, isWorker: true };
    }
  }

  // User mode — verify JWT via Supabase
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;
  return { id: data.user.id, isWorker: false };
}

function isAllowedSeedancePollEndpoint(pollEndpoint: string): boolean {
  try {
    const u = new URL(pollEndpoint);
    const seedanceBaseHost = new URL(SEEDANCE_BASE).hostname;
    return (
      u.protocol === "https:" &&
      (u.hostname === seedanceBaseHost ||
        u.hostname === "ark.cn-beijing.volces.com" ||
        u.hostname.endsWith(".bytepluses.com") ||
        u.hostname.endsWith(".byteplusapi.com")) &&
      u.pathname.replace(/\/+$/, "") === SEEDANCE_TASKS_PATH
    );
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  const caller = await resolveCaller(req);
  if (!caller) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const taskId = String(body.task_id ?? "").trim();
  const pollEndpoint = String(body.poll_endpoint ?? "").trim();
  if (!taskId || !pollEndpoint) {
    return new Response(
      JSON.stringify({ error: "task_id and poll_endpoint required" }),
      { status: 400, headers: jsonHeaders },
    );
  }
  if (!isAllowedSeedancePollEndpoint(pollEndpoint)) {
    return new Response(
      JSON.stringify({ error: "poll_endpoint must be a Seedance tasks endpoint" }),
      { status: 400, headers: jsonHeaders },
    );
  }

  let creds: { apiKey: string };
  try {
    const pollModel = String(body.model ?? body.provider_model_id ?? "").toLowerCase();
    const isV2Poll = pollModel.includes("seedance-2-0");
    creds = loadSeedanceCredentials({ v2: isV2Poll });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  let statusObj;
  try {
    statusObj = await pollSeedanceOnce(taskId, creds.apiKey);
  } catch (e) {
    // Transport error reaching BytePlus — mirror the legacy 200/polling_error
    // shape so the durable worker continues retrying.
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ status: "polling_error", message: msg.substring(0, 300) }),
      { status: 200, headers: jsonHeaders },
    );
  }

  const rawStatus = String(statusObj.status ?? "").toLowerCase();
  const normalised =
    rawStatus === "succeeded" || rawStatus === "success"
      ? "succeed"
      : rawStatus === "failed" || rawStatus === "fail" || rawStatus === "cancelled"
        ? "failed"
        : rawStatus === "running"
          ? "processing"
          : rawStatus || "submitted";
  let videoUrl =
    normalised === "succeed" ? String(statusObj.content?.video_url ?? "") : "";
  const rawMessage =
    statusObj.error?.message ?? (normalised === "failed" ? "Task failed" : "");
  const message = humanizeSeedanceErrorMessage(rawMessage);

  // Mirror BytePlus CDN video into user_assets so the asset library can
  // reference a long-lived URL. Service-role client is fine here — RLS
  // for user_assets writes is enforced via path prefix matching user.id.
  if (videoUrl) {
    try {
      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) throw new Error(`download HTTP ${videoRes.status}`);
      const bytes = new Uint8Array(await videoRes.arrayBuffer());
      const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const path = `${caller.id}/seedance-renders/mediaforge_${safeTaskId}.mp4`;
      const storage = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const upload = await storage.storage
        .from("user_assets")
        .upload(path, bytes, { contentType: "video/mp4", upsert: true });
      if (upload.error) throw upload.error;
      const signed = await storage.storage
        .from("user_assets")
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      if (signed.error || !signed.data?.signedUrl) {
        throw signed.error ?? new Error("no signed URL");
      }
      videoUrl = signed.data.signedUrl;
      console.log(`[poll-seedance] mirrored video path=${path}`);
    } catch (err) {
      console.warn(
        `[poll-seedance] storage mirror failed, falling back to BytePlus URL: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return new Response(
    JSON.stringify({
      status: normalised,
      task_id: taskId,
      url: videoUrl,
      message,
    }),
    { status: 200, headers: jsonHeaders },
  );
});
