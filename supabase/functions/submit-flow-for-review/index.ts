import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { logApiUsage } from "../_shared/posthogCapture.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const orgBlock = await rejectIfOrgUser(req);
  if (orgBlock) return orgBlock;

  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return json({ error: "Unauthorized" }, 401);
    const userId = authUser.id;

    const { flow_id } = await req.json();
    if (!flow_id) return json({ error: "flow_id required" }, 400);

    // Use service role to update
    const adminClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Verify ownership and valid status
    const { data: flow, error: flowErr } = await adminClient
      .from("flows")
      .select("id, user_id, status")
      .eq("id", flow_id)
      .single();

    if (flowErr || !flow) {
      console.error("[submit-review] Flow not found:", flow_id, flowErr?.message);
      await logApiUsage(adminClient, { user_id: userId, endpoint: "submit-flow-for-review", feature: "flow_review", status: "error", error_message: `Flow not found: ${flowErr?.message ?? flow_id}` });
      return json({ error: "Flow not found" }, 404);
    }
    if (flow.user_id !== userId) {
      console.error("[submit-review] Ownership mismatch:", { flow_id, flow_owner: flow.user_id, caller: userId });
      await logApiUsage(adminClient, { user_id: userId, endpoint: "submit-flow-for-review", feature: "flow_review", status: "error", error_message: `Ownership mismatch on flow ${flow_id}` });
      return json({ error: "Not your flow" }, 403);
    }
    if (!["draft", "changes_requested", "rejected", "published", "approved"].includes(flow.status)) {
      console.error("[submit-review] Invalid status transition:", { flow_id, current_status: flow.status });
      await logApiUsage(adminClient, { user_id: userId, endpoint: "submit-flow-for-review", feature: "flow_review", status: "error", error_message: `Invalid status transition from ${flow.status}`, request_metadata: { flow_id, current_status: flow.status } });
      return json({ error: `Cannot submit flow with status: ${flow.status}` }, 400);
    }

    const { error: updateErr } = await adminClient
      .from("flows")
      .update({ status: "submitted" })
      .eq("id", flow_id);

    if (updateErr) {
      console.error("[submit-review] DB update failed:", updateErr.message);
      await logApiUsage(adminClient, { user_id: userId, endpoint: "submit-flow-for-review", feature: "flow_review", status: "error", error_message: `DB update failed: ${updateErr.message}`, request_metadata: { flow_id } });
      return json({ error: updateErr.message }, 500);
    }

    await logApiUsage(adminClient, { user_id: userId, endpoint: "submit-flow-for-review", feature: "flow_review", status: "success", request_metadata: { flow_id, from_status: flow.status } });
    return json({ success: true, status: "submitted" });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[submit-review] Unhandled error:", errMsg);
    // Best-effort log — adminClient may not exist if error was early
    try {
      const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await logApiUsage(svc, { user_id: "unknown", endpoint: "submit-flow-for-review", feature: "flow_review", status: "error", error_message: errMsg });
    } catch { /* swallow */ }
    return json({ error: "Server error" }, 500);
  }
});
