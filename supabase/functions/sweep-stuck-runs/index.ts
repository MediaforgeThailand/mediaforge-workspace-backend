/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthUser, isServiceRole, unauthorized } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const STUCK_THRESHOLD_MINUTES = 20;
const MAX_RUNS_PER_SWEEP = 100;
const STUCK_RUN_STATUSES = ["pending", "running", "processing"];

interface StuckRun {
  id: string;
  user_id: string;
  flow_id: string;
  credits_used: number;
  started_at: string;
  status: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Only allow service_role key or authenticated users
  if (!isServiceRole(req)) {
    const user = await getAuthUser(req);
    if (!user) return unauthorized();
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Missing Supabase env" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const cutoffIso = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString();

  // Find stuck runs across all active execution statuses used by the platform.
  const { data: stuckRuns, error: queryErr } = await supabase
    .from("flow_runs")
    .select("id, user_id, flow_id, credits_used, started_at, status")
    .in("status", STUCK_RUN_STATUSES)
    .lt("started_at", cutoffIso)
    .order("started_at", { ascending: true })
    .limit(MAX_RUNS_PER_SWEEP);

  if (queryErr) {
    console.error("[sweep-stuck-runs] Query error:", queryErr);
    return new Response(JSON.stringify({ error: queryErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const runs = (stuckRuns ?? []) as StuckRun[];
  console.log(`[sweep-stuck-runs] Found ${runs.length} stuck run(s) older than ${STUCK_THRESHOLD_MINUTES}m across statuses: ${STUCK_RUN_STATUSES.join(", ")}`);

  let processed = 0;
  let refunded = 0;
  let failedRefunds = 0;

  for (const run of runs) {
    try {
      let refundSucceeded = false;
      const shouldRefund = !!run.credits_used && run.credits_used > 0;

      if (shouldRefund) {
        const { error: refundErr } = await supabase.rpc("refund_credits", {
          p_user_id: run.user_id,
          p_amount: run.credits_used,
          p_reason: `Auto-refund: generation timed out (>${STUCK_THRESHOLD_MINUTES} min)`,
          p_reference_id: run.id,
        });
        if (refundErr) {
          console.error(`[sweep-stuck-runs] Refund failed for run ${run.id}:`, refundErr);
          failedRefunds++;
        } else {
          refundSucceeded = true;
          refunded++;
        }
      }

      const finalStatus = shouldRefund && refundSucceeded ? "failed_refunded" : "failed";
      const finalMessage = shouldRefund && refundSucceeded
        ? "Generation timed out (auto-refunded)"
        : "Generation timed out";

      const { error: updErr } = await supabase
        .from("flow_runs")
        .update({
          status: finalStatus,
          error_message: finalMessage,
          completed_at: new Date().toISOString(),
        })
        .eq("id", run.id)
        .in("status", STUCK_RUN_STATUSES);
      if (updErr) console.error(`[sweep-stuck-runs] Update failed for ${run.id}:`, updErr);

      try {
        await supabase.from("notifications").insert({
          user_id: run.user_id,
          type: "generation_failed",
          title: "Generation Timed Out",
          message: refundSucceeded
            ? "Your generation took too long and has been auto-refunded."
            : "Your generation took too long and was stopped.",
          icon: "alert-circle",
          link: `/play/${run.flow_id}`,
          metadata: { run_id: run.id, flow_id: run.flow_id, refunded: refundSucceeded, reason: "timeout", previous_status: run.status },
        });
      } catch (e) {
        console.warn(`[sweep-stuck-runs] Notification insert failed for ${run.id}:`, e);
      }

      processed++;
    } catch (e) {
      console.error(`[sweep-stuck-runs] Error processing run ${run.id}:`, e);
    }
  }

  const summary = {
    found: runs.length,
    processed,
    refunded,
    failed_refunds: failedRefunds,
    cutoff: cutoffIso,
    threshold_minutes: STUCK_THRESHOLD_MINUTES,
    statuses: STUCK_RUN_STATUSES,
  };
  console.log(`[sweep-stuck-runs] Summary:`, summary);

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
