import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { refundCreditsAtomic } from "../_shared/pricing.ts";
import { logApiUsage } from "../_shared/posthogCapture.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function generateKlingJWT(accessKeyId: string, secretKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKeyId, exp: now + 1800, nbf: now - 5, iat: now };
  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signingInput}.${sigB64}`;
}

/* refundCredits replaced by refundCreditsAtomic from _shared/pricing.ts */

/**
 * Extract end frame from a video URL.
 * TODO: Implement actual frame extraction (FFmpeg or external service).
 * For now returns cover_image if available, otherwise null.
 */
function extractEndFrame(_videoUrl: string, coverImage?: string): string | null {
  if (coverImage) return coverImage;
  return null;
}

/* ─── Ownership verification helper ─── */
interface RunOwnerInfo {
  user_id: string;
  flow_id: string;
  status: string;
  outputs: Record<string, unknown> | null;
}

async function verifyRunOwnership(
  supabase: ReturnType<typeof createClient>,
  runId: string,
  callerId: string,
): Promise<RunOwnerInfo> {
  const { data: run, error } = await supabase
    .from("flow_runs")
    .select("user_id, flow_id, status, outputs")
    .eq("id", runId)
    .maybeSingle();

  if (error || !run) {
    throw { status: 404, message: "Run not found" };
  }

  if (run.user_id !== callerId) {
    console.warn(`[run-flow-status] IDOR blocked: caller=${callerId} tried to access run owned by ${run.user_id}`);
    throw { status: 403, message: "You do not have permission to access this run" };
  }

  return run as RunOwnerInfo;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  try {
    const KLING_ACCESS_KEY_ID = Deno.env.get("KLING_ACCESS_KEY_ID");
    const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { task_id, run_id, credit_cost, force_timeout } = body;

    if (!task_id) {
      return new Response(JSON.stringify({ error: "task_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══════════════════════════════════════════════════════════
    // OWNERSHIP VERIFICATION — must happen before ANY action
    // ═══════════════════════════════════════════════════════════
    let runOwner: RunOwnerInfo | null = null;
    if (run_id) {
      try {
        runOwner = await verifyRunOwnership(supabase, run_id, user.id);
      } catch (ownerErr: unknown) {
        const err = ownerErr as { status: number; message: string };
        return new Response(JSON.stringify({ error: err.message }), {
          status: err.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Handle frontend timeout — force-fail the run and refund
    // SECURITY: Refund goes to run OWNER, not caller (already verified above)
    if (force_timeout && run_id && runOwner) {
      const errorMsg = "Polling timed out — generation took too long";
      if (credit_cost && credit_cost > 0) {
        await refundCreditsAtomic(supabase, runOwner.user_id, credit_cost, `Refund: ${errorMsg}`, run_id);
        await supabase.from("flow_runs").update({
          status: "failed_refunded", error_message: errorMsg, completed_at: new Date().toISOString(),
        }).eq("id", run_id);
      } else {
        await supabase.from("flow_runs").update({
          status: "failed", error_message: errorMsg, completed_at: new Date().toISOString(),
        }).eq("id", run_id);
      }
      // Also fail any pipeline_executions linked to this run
      await supabase.from("pipeline_executions").update({
        status: credit_cost > 0 ? "failed_refunded" : "failed",
        error_message: errorMsg, updated_at: new Date().toISOString(),
      }).eq("flow_run_id", run_id);

      await logApiUsage(supabase, {
        user_id: runOwner.user_id,
        endpoint: "run-flow-status",
        feature: "flow_run:timeout",
        status: "error",
        credits_refunded: credit_cost > 0 ? credit_cost : 0,
        duration_ms: Date.now() - startTime,
        error_message: errorMsg,
        request_metadata: { run_id, task_id, flow_id: runOwner.flow_id },
      });

      return new Response(
        JSON.stringify({ status: "failed_refunded", error: errorMsg, refunded: credit_cost > 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Check if the run is already completed in DB (provider-agnostic shortcut)
    // This handles both Kling async results AND background tasks (banana, chat_ai via EdgeRuntime.waitUntil)
    // SECURITY: runOwner already verified — use its data directly
    if (runOwner?.status === "completed") {
      const outputs = runOwner.outputs as Record<string, unknown> | null;
      return new Response(
        JSON.stringify({
          status: "succeed",
          result_url: outputs?.result_url ?? outputs?.video_url ?? "",
          output_type: outputs?.output_type ?? "video_url",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Check if the run failed in DB (background tasks write failure status directly)
    if (runOwner?.status === "failed_refunded" || runOwner?.status === "failed") {
      const outputs = runOwner.outputs as Record<string, unknown> | null;
      // Read error_message from flow_runs directly
      const { data: failedRun } = await supabase
        .from("flow_runs")
        .select("error_message")
        .eq("id", run_id)
        .maybeSingle();

      return new Response(
        JSON.stringify({
          status: "failed_refunded",
          error: failedRun?.error_message || (outputs as Record<string, unknown>)?.error_message || "Generation failed",
          refunded: runOwner.status === "failed_refunded",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // If run is still "processing" and provider is NOT Kling (i.e. background task still running),
    // return processing status without hitting Kling API
    const runOutputs = runOwner?.outputs as Record<string, unknown> | null;
    const runProvider = runOutputs?.provider as string | undefined;
    if (runOwner?.status === "processing" && runProvider && runProvider !== "kling" && runProvider !== "kling_extension" && runProvider !== "motion_control") {
      return new Response(
        JSON.stringify({ status: "processing" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Kling async polling — requires Kling API credentials
    if (!KLING_ACCESS_KEY_ID || !KLING_SECRET_KEY) {
      throw new Error("Kling API credentials not configured");
    }

    const jwtToken = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);

    // Try image2video first, then motion-control, then text2video
    let klingResult: Record<string, unknown> | null = null;
    for (const path of ["image2video", "motion-control", "text2video"]) {
      try {
        const res = await fetch(`https://api.klingai.com/v1/videos/${path}/${task_id}`, {
          headers: { Authorization: `Bearer ${jwtToken}` },
        });
        if (!res.ok) {
          const errText = await res.text();
          console.warn(`[run-flow-status] Kling ${path} HTTP ${res.status}: ${errText.substring(0, 200)}`);
          continue;
        }
        const text = await res.text();
        try {
          klingResult = JSON.parse(text);
        } catch {
          console.error(`[run-flow-status] Kling ${path} returned non-JSON: ${text.substring(0, 200)}`);
          continue;
        }
        break;
      } catch (fetchErr) {
        console.error(`[run-flow-status] Kling ${path} fetch error:`, fetchErr);
        continue;
      }
    }

    if (!klingResult) {
      return new Response(
        JSON.stringify({ status: "polling_error", error: "Failed to check status from Kling API" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = klingResult.data as Record<string, unknown> | undefined;
    const taskStatus = data?.task_status as string | undefined;

    if (taskStatus === "succeed") {
      const taskResult = data?.task_result as Record<string, unknown> | undefined;
      const videos = taskResult?.videos as Array<{ url: string; cover_image_url?: string }> | undefined;
      const videoUrl = videos?.[0]?.url ?? "";
      const coverImage = videos?.[0]?.cover_image_url ?? "";

      // Build structured outputs dict
      const outputs: Record<string, string> = {
        output_video: videoUrl,
        output_start_frame: coverImage || "",
        output_end_frame: extractEndFrame(videoUrl, coverImage) || "",
      };

      if (run_id && runOwner) {
        // AGGREGATION FIX: Merge into existing outputs instead of overwriting
        const { data: existingRun } = await supabase
          .from("flow_runs")
          .select("outputs")
          .eq("id", run_id)
          .maybeSingle();

        const existingOutputs = (existingRun?.outputs as Record<string, unknown>) ?? {};
        const existingByNode = (existingOutputs.by_node as Record<string, unknown>) ?? {};

        // ─── Locate the matching pipeline step (by task_id) so we can
        //     1) update step_results so downstream steps see this completion
        //     2) decide whether the parent flow_run is fully done or still has work
        const { data: pipelineExec } = await supabase
          .from("pipeline_executions")
          .select("id, steps, step_results, current_step, total_steps")
          .eq("flow_run_id", run_id)
          .maybeSingle();

        let actionNodeId = "async_result";
        let asyncStepIdx = -1;
        let totalPipelineSteps = 1;
        const existingStepResults = (pipelineExec?.step_results as Array<Record<string, unknown>> | null | undefined) ?? [];

        if (pipelineExec?.steps) {
          const stepsArr = pipelineExec.steps as Array<{ node_id?: string }>;
          totalPipelineSteps = (pipelineExec.total_steps as number | null | undefined) ?? stepsArr.length;
          // Match the running async step that holds this task_id
          asyncStepIdx = existingStepResults.findIndex(
            (r) => r && (r.task_id as string | undefined) === task_id,
          );
          if (asyncStepIdx < 0) {
            // Fallback: prefer the running step at current_step
            const currentIdx = (pipelineExec.current_step ?? stepsArr.length - 1) as number;
            asyncStepIdx = currentIdx;
          }
          actionNodeId = stepsArr[asyncStepIdx]?.node_id || actionNodeId;
        }

        // ─── Patch the matching step_result so subsequent levels can resolve
        //     `priorResults.find(r => r.status === "completed")` for this node.
        let isPipelineFullyDone = totalPipelineSteps <= 1;
        if (pipelineExec?.id && asyncStepIdx >= 0) {
          const updatedResults = [...existingStepResults];
          const prev = (updatedResults[asyncStepIdx] as Record<string, unknown> | undefined) ?? {};
          updatedResults[asyncStepIdx] = {
            ...prev,
            step_index: asyncStepIdx,
            node_id: actionNodeId,
            status: "completed",
            result_url: videoUrl,
            outputs,
            output_type: "video_url",
            task_id,
          };

          const completedCount = updatedResults.filter(
            (r) => (r?.status as string | undefined) === "completed",
          ).length;
          isPipelineFullyDone = completedCount >= totalPipelineSteps;

          await supabase
            .from("pipeline_executions")
            .update({
              step_results: updatedResults,
              ...(isPipelineFullyDone ? { status: "completed" } : {}),
              updated_at: new Date().toISOString(),
            })
            .eq("id", pipelineExec.id as string);
          console.log(
            `[run-flow-status] Patched pipeline_executions step ${asyncStepIdx} (${actionNodeId}) → completed; ` +
            `pipelineDone=${isPipelineFullyDone} (${completedCount}/${totalPipelineSteps})`,
          );
        }

        const mergedByNode = {
          ...existingByNode,
          [actionNodeId]: { result_url: videoUrl, outputs, output_type: "video_url" },
        };

        // RACE GUARD: Atomic conditional update — only the first poller that
        // sees the run still in a non-terminal state will succeed in marking it
        // "completed". Subsequent concurrent polls will update 0 rows and skip
        // the asset/notification side-effects, preventing duplicate assets.
        //
        // CRITICAL: Only flip the parent flow_run to "completed" when this was
        // the LAST async step in the pipeline. Otherwise we just patch outputs
        // (so the by_node map stays fresh) but leave status as-is so the next
        // pipeline level can still execute.
        const updatePayload: Record<string, unknown> = {
          outputs: { result_url: videoUrl, outputs, output_type: "video_url", by_node: mergedByNode },
        };
        if (isPipelineFullyDone) {
          updatePayload.status = "completed";
          updatePayload.completed_at = new Date().toISOString();
        }
        const { data: claimed, error: claimErr } = await supabase
          .from("flow_runs")
          .update(updatePayload)
          .eq("id", run_id)
          .in("status", ["pending", "running", "processing"])
          .select("id");

        const wonRace = !claimErr && Array.isArray(claimed) && claimed.length > 0 && isPipelineFullyDone;
        if (!wonRace && isPipelineFullyDone) {
          console.log(`[run-flow-status] Race lost for run ${run_id} — another poller already finalized; skipping asset/notification insert`);
        } else if (!isPipelineFullyDone) {
          console.log(`[run-flow-status] Async step ${asyncStepIdx} done; pipeline still has ${totalPipelineSteps - 1} more step(s) — leaving flow_run status as-is`);
        }

        // Auto-save generated video to user_assets — only the race winner inserts.
        // SECURITY: Save to run OWNER's assets, not caller
        if (wonRace && videoUrl) {
          try {
            await supabase.from("user_assets").insert({
              user_id: runOwner.user_id,
              name: `workflow-video-${Date.now()}`,
              file_url: videoUrl,
              file_type: "video",
              source: "workflow",
              category: "generated",
              metadata: { flow_id: runOwner.flow_id, flow_run_id: run_id },
            });
            console.log(`[run-flow-status] Auto-saved video asset for user ${runOwner.user_id}`);
          } catch (assetErr) {
            console.warn("[run-flow-status] Failed to auto-save asset:", assetErr);
          }
        }

        // Insert success notification — also gated by race winner
        if (wonRace) {
          try {
            const { data: flowInfo } = await supabase.from("flows").select("name").eq("id", runOwner.flow_id).maybeSingle();
            await supabase.from("notifications").insert({
              user_id: runOwner.user_id,
              type: "generation_complete",
              title: "Generation Complete ✨",
              message: `Flow "${flowInfo?.name || "Untitled"}" finished successfully!`,
              icon: "sparkles",
              link: `/play/${runOwner.flow_id}`,
              metadata: { flow_id: runOwner.flow_id, run_id, result_url: videoUrl },
            });
          } catch (notifErr) {
            console.warn("[run-flow-status] Failed to insert notification:", notifErr);
          }
        }
      }

      if (runOwner) {
        await logApiUsage(supabase, {
          user_id: runOwner.user_id,
          endpoint: "run-flow-status",
          feature: "flow_run:kling_poll",
          status: "success",
          credits_used: credit_cost ?? 0,
          duration_ms: Date.now() - startTime,
          request_metadata: { run_id, task_id, flow_id: runOwner.flow_id, terminal: "succeed" },
        });
      }

      return new Response(
        JSON.stringify({ status: "succeed", result_url: videoUrl, outputs, output_type: "video_url" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (taskStatus === "failed") {
      const errorMsg = (data?.task_status_msg as string) || "Generation failed";

      // SECURITY: Refund to run OWNER, not caller
      if (run_id && runOwner && credit_cost && credit_cost > 0) {
        await refundCreditsAtomic(supabase, runOwner.user_id, credit_cost, `Refund: ${errorMsg}`, run_id);
        await supabase.from("flow_runs").update({
          status: "failed_refunded", error_message: errorMsg, completed_at: new Date().toISOString(),
        }).eq("id", run_id);
      } else if (run_id) {
        await supabase.from("flow_runs").update({
          status: "failed", error_message: errorMsg, completed_at: new Date().toISOString(),
        }).eq("id", run_id);
      }

      // Insert failure notification
      if (runOwner) {
        try {
          const { data: flowInfo } = await supabase.from("flows").select("name").eq("id", runOwner.flow_id).maybeSingle();
          await supabase.from("notifications").insert({
            user_id: runOwner.user_id,
            type: "generation_failed",
            title: "Generation Failed",
            message: `Flow "${flowInfo?.name || "Untitled"}" failed: ${errorMsg.substring(0, 100)}`,
            icon: "alert-circle",
            link: `/play/${runOwner.flow_id}`,
            metadata: { flow_id: runOwner.flow_id, run_id, refunded: credit_cost > 0 },
          });
        } catch (notifErr) {
          console.warn("[run-flow-status] Failed to insert failure notification:", notifErr);
        }
      }

      if (runOwner) {
        await logApiUsage(supabase, {
          user_id: runOwner.user_id,
          endpoint: "run-flow-status",
          feature: "flow_run:kling_poll",
          status: "error",
          credits_refunded: credit_cost && credit_cost > 0 ? credit_cost : 0,
          duration_ms: Date.now() - startTime,
          error_message: errorMsg.substring(0, 500),
          request_metadata: { run_id, task_id, flow_id: runOwner.flow_id, terminal: "failed" },
        });
      }

      return new Response(
        JSON.stringify({ status: "failed_refunded", error: errorMsg, refunded: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Still processing
    return new Response(
      JSON.stringify({ status: taskStatus || "processing" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[run-flow-status] Error:", e);
    try {
      const logClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      );
      await logApiUsage(logClient, {
        user_id: "system",
        endpoint: "run-flow-status",
        feature: "flow_run:unhandled_crash",
        status: "error",
        duration_ms: Date.now() - startTime,
        error_message: (e instanceof Error ? e.message : String(e)).substring(0, 500),
        request_metadata: { error_type: "top_level_catch" },
      });
    } catch (_) { /* best-effort */ }
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
