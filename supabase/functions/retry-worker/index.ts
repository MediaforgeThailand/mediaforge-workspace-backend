import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";

/**
 * retry-worker — Phase 2 (real invoker) + resume / dead-letter handling
 *
 * Triggered by pg_cron every 30s. Each invocation:
 *   1. Recovers stuck "processing" jobs older than STUCK_AFTER_MIN minutes
 *      (kept beyond the natural lock_expires_at as a defense-in-depth pass)
 *   2. Pre-escalates jobs whose attempt counter is already >= max_attempts to
 *      the dead-letter table BEFORE claiming
 *   3. Claims a batch of due jobs via claim_retry_jobs (FOR UPDATE SKIP LOCKED
 *      — gives us the per-row advisory-style guarantee against concurrent
 *      workers grabbing the same job)
 *   4. Invokes execute-pipeline-step?mode=resume per job (parallel, timeboxed)
 *   5. On SIGTERM, releases its own locks back to "pending" instead of leaving
 *      them stuck in "processing"
 *
 * The resume endpoint:
 *   - reads the job's resume_payload to locate execution_id + step_index
 *   - runs ONE provider attempt (no inline retry loop here — worker handles scheduling)
 *   - calls complete_retry_job / fail_retry_job to advance state
 *   - on terminal fail, persists failure + refund to flow_run
 *
 * Auth: verify_jwt = false + x-cron-secret header verified against Vault.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const BATCH_SIZE = 5;
const LOCK_DURATION_SEC = 300; // 5 min — comfortably > resume timeout (120s)
const RESUME_TIMEOUT_MS = 120_000;
const STUCK_AFTER_MIN = 10; // recover processing jobs idle > 10 min

// Track in-flight job ids per worker invocation so SIGTERM can release them
const inFlightJobs = new Set<string>();
let shuttingDown = false;

// Register graceful shutdown once per cold start
let shutdownRegistered = false;
function registerShutdownOnce(supabase: ReturnType<typeof createClient>, workerId: string) {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const release = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(
      `[retry-worker] ${workerId} received ${signal}, releasing ${inFlightJobs.size} lock(s)`,
    );
    try {
      const { data, error } = await supabase.rpc("release_worker_locks", {
        p_worker_id: workerId,
      });
      if (error) {
        console.error(`[retry-worker] release_worker_locks error:`, error);
      } else {
        console.warn(
          `[retry-worker] ${workerId} released ${data ?? 0} job(s) on ${signal}`,
        );
      }
    } catch (e) {
      console.error(`[retry-worker] release on shutdown failed:`, e);
    }
  };

  try {
    Deno.addSignalListener("SIGTERM", () => void release("SIGTERM"));
    Deno.addSignalListener("SIGINT", () => void release("SIGINT"));
  } catch (e) {
    // Some runtimes (Deno Deploy/edge) restrict signal listeners — log + continue
    console.warn(`[retry-worker] signal listener unavailable:`, (e as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ─── Auth: x-cron-secret ──────────────────────────────────────────
  const providedSecret = req.headers.get("x-cron-secret");
  if (!providedSecret) {
    console.warn(`[retry-worker] missing x-cron-secret header`);
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: vaultSecret, error: secretErr } = await supabase.rpc(
    "get_retry_worker_cron_secret",
  );

  if (secretErr || !vaultSecret) {
    console.error(`[retry-worker] vault secret fetch failed:`, secretErr);
    return new Response(JSON.stringify({ error: "secret_not_found" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (providedSecret !== vaultSecret) {
    console.warn(`[retry-worker] invalid cron secret`);
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  registerShutdownOnce(supabase, workerId);
  console.log(`[retry-worker] ${workerId} started`);

  let recoveredCount = 0;
  let escalatedCount = 0;

  try {
    // ─── 1. Recover stuck processing jobs (defense in depth) ─────────
    try {
      const { data: recovered, error: recoverErr } = await supabase.rpc(
        "recover_stuck_retry_jobs",
        { p_stuck_after_minutes: STUCK_AFTER_MIN },
      );
      if (recoverErr) {
        console.error(`[retry-worker] recover_stuck error:`, recoverErr);
      } else {
        const list = (recovered ?? []) as Array<{
          recovered_id: string;
          prior_locked_by: string | null;
          prior_attempt: number;
        }>;
        recoveredCount = list.length;
        if (recoveredCount > 0) {
          console.warn(
            `[retry-worker] stuck_job_recovered: ${recoveredCount} job(s) reset to pending`,
            list.map((r) => ({
              id: r.recovered_id,
              prior_worker: r.prior_locked_by,
              attempt: r.prior_attempt,
            })),
          );
        }
      }
    } catch (e) {
      console.error(`[retry-worker] stuck recovery threw:`, e);
    }

    // ─── 2. Escalate jobs that already exceeded max_attempts to DLQ ──
    try {
      const { data: exhausted, error: exErr } = await supabase
        .from("provider_retry_queue")
        .select("id, attempt, max_attempts, last_error")
        .in("status", ["pending", "processing"])
        .filter("attempt", "gte", "max_attempts");

      if (exErr) {
        console.error(`[retry-worker] exhausted query error:`, exErr);
      } else {
        for (const job of exhausted ?? []) {
          try {
            const { data: dlqId, error: escErr } = await supabase.rpc(
              "escalate_to_dead_letter",
              {
                p_job_id: job.id,
                p_final_error:
                  job.last_error ?? `max_attempts (${job.max_attempts}) exceeded`,
                p_moved_by: workerId,
              },
            );
            if (escErr) {
              console.error(`[retry-worker] dlq escalate ${job.id} error:`, escErr);
            } else {
              escalatedCount += 1;
              console.error(
                `[retry-worker] dead_letter_escalated job=${job.id} ` +
                  `attempts=${job.attempt}/${job.max_attempts} dlq_id=${dlqId} ` +
                  `error=${(job.last_error ?? "").substring(0, 200)}`,
              );
            }
          } catch (e) {
            console.error(`[retry-worker] dlq escalate ${job.id} threw:`, e);
          }
        }
      }
    } catch (e) {
      console.error(`[retry-worker] dlq pre-claim sweep threw:`, e);
    }

    // ─── 3. Claim due jobs ──────────────────────────────────────────
    const { data: jobs, error: claimErr } = await supabase.rpc("claim_retry_jobs", {
      p_worker_id: workerId,
      p_batch_size: BATCH_SIZE,
      p_lock_duration_sec: LOCK_DURATION_SEC,
    });

    if (claimErr) {
      console.error(`[retry-worker] claim error:`, claimErr);
      return new Response(JSON.stringify({ error: claimErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const claimed = (jobs ?? []) as Array<{
      id: string;
      attempt: number;
      max_attempts: number;
      flow_run_id: string;
      step_index: number;
      provider: string;
      last_error: string | null;
    }>;
    console.log(
      `[retry-worker] ${workerId} recovered=${recoveredCount} escalated=${escalatedCount} claimed=${claimed.length}`,
    );

    if (claimed.length === 0) {
      return new Response(
        JSON.stringify({
          worker: workerId,
          recovered: recoveredCount,
          escalated_to_dlq: escalatedCount,
          claimed: 0,
          duration_ms: Date.now() - startedAt,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── 4. Invoke resume endpoint per job ─────────────────────────
    const resumeUrl = `${SUPABASE_URL}/functions/v1/execute-pipeline-step`;
    const invocations = claimed.map(async (job) => {
      // claim_retry_jobs increments attempt; if this attempt is the last one
      // and resume fails, fail_retry_job will mark it failed — escalation will
      // happen on the next worker tick via the pre-claim sweep above.
      inFlightJobs.add(job.id);
      const jobStart = Date.now();
      try {
        if (shuttingDown) {
          throw new Error("worker_shutting_down");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), RESUME_TIMEOUT_MS);

        const res = await fetch(resumeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-cron-secret": providedSecret,
          },
          body: JSON.stringify({ mode: "resume", job_id: job.id }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const bodyText = await res.text();
        console.log(
          `[retry-worker] job ${job.id} run=${job.flow_run_id} step=${job.step_index} ` +
            `attempt=${job.attempt}/${job.max_attempts} → HTTP ${res.status} in ${Date.now() - jobStart}ms`,
        );
        return {
          job_id: job.id,
          status: res.status,
          duration_ms: Date.now() - jobStart,
          body: bodyText.substring(0, 200),
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[retry-worker] job ${job.id} invoke error:`, errMsg);
        // Don't mark fail here — the resume endpoint manages fail_retry_job.
        // If the call never reached the endpoint, the lock will expire
        // (lock_expires_at) or recover_stuck_retry_jobs will reclaim it.
        return {
          job_id: job.id,
          status: 0,
          duration_ms: Date.now() - jobStart,
          error: errMsg,
        };
      } finally {
        inFlightJobs.delete(job.id);
      }
    });

    const settled = await Promise.allSettled(invocations);
    const results = settled.map((r) =>
      r.status === "fulfilled" ? r.value : { error: "promise_rejected" },
    );

    const summary = {
      worker: workerId,
      recovered: recoveredCount,
      escalated_to_dlq: escalatedCount,
      claimed: claimed.length,
      processed: results.length,
      results,
      duration_ms: Date.now() - startedAt,
    };

    console.log(`[retry-worker] ${workerId} done:`, summary);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[retry-worker] fatal:`, e);
    // Best-effort: release any locks we still hold so they don't sit stuck
    if (inFlightJobs.size > 0) {
      try {
        await supabase.rpc("release_worker_locks", { p_worker_id: workerId });
      } catch (relErr) {
        console.error(`[retry-worker] release on fatal failed:`, relErr);
      }
    }
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
