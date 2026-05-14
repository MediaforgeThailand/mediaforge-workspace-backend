/**
 * Unified Provider Retry Strategy (12 + 6 with health probe)
 *
 * Used by workspace-run-node — provides the error classifiers
 * (classifyError / classifyProviderError / shouldFastFallbackProviderError)
 * and the retry cap (TOTAL_MAX_RETRIES) that the workspace job worker uses
 * when retrying provider calls through workspace_generation_jobs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Strategy
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Phase 1 — Initial attempts (PRIMARY_RETRIES = 12)
 *     Patient exponential backoff: 3s × 2^attempt, capped at 60s + jitter.
 *     Total worst-case: ~10 minutes.
 *
 *   After phase 1 exhausts → run health probe against the AI provider.
 *
 *   Phase 2A — Provider HEALTHY but our calls failed
 *     → likely "high demand" / queue overflow / transient model overload.
 *     → run EXTENDED_RETRIES = 6 more attempts, with same backoff curve
 *       continuing where we left off (still capped at 60s).
 *     → Total additional worst-case: ~6 minutes.
 *
 *   Phase 2B — Provider UNHEALTHY
 *     → upstream is genuinely down. No point burning more time.
 *     → return immediately so the caller can refund.
 *
 *   Permanent errors (billing, safety, malformed prompt) short-circuit
 *   at any point and never trigger phase 2.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const PRIMARY_RETRIES = 12;
export const EXTENDED_RETRIES = 6;
export const TOTAL_MAX_RETRIES = PRIMARY_RETRIES + EXTENDED_RETRIES; // 18

const BASE_DELAY_MS = 3000;     // 3s starting delay
const MAX_DELAY_MS = 60_000;    // 60s cap per attempt

export interface HealthProbe {
  healthy: boolean;
  reason: string;
}

export interface RetryOutcome<T> {
  result: T | null;
  error: Error | null;
  attempts: number;
  enteredExtendedPhase: boolean;
  health_probe?: HealthProbe;
  classification: "success" | "permanent" | "high_demand" | "provider_down" | "exhausted";
}

/**
 * Hard cap on consecutive Google `DEADLINE_EXCEEDED` (HTTP 504) errors
 * before we short-circuit to permanent. Pro image / video models
 * (Gemini Pro Image, Veo) sometimes hit Google-side render timeouts
 * that can't recover within our 145s gateway budget no matter how
 * many times we retry — capping keeps the user from waiting 18×5min
 * for a refund. After this many consecutive 504s, the retry loop
 * gives up and refunds with the friendly message the executor
 * threw.
 */
export const DEADLINE_EXCEEDED_RETRY_CAP = 3;

export function isDeadlineExceededError(errMsg: string): boolean {
  return /DEADLINE_EXCEEDED|HTTP\s*504\b/i.test(errMsg);
}

export function isNonRetryableQuotaError(errMsg: string): boolean {
  const quotaExhausted =
    /RESOURCE_EXHAUSTED|exceeded your current quota|quota exceeded|check your plan and billing details/i.test(
      errMsg,
    );
  if (!quotaExhausted) return false;
  return !/please retry in\b|retryDelay|RetryInfo/i.test(errMsg);
}

export type ProviderErrorClass =
  | "quota"
  | "billing"
  | "rate_limit"
  | "busy"
  | "timeout"
  | "safety"
  | "validation"
  | "auth"
  | "programming"
  | "transient"
  | "unknown";

export interface ProviderErrorClassification {
  kind: ProviderErrorClass;
  retryable: boolean;
  fast_fallback: boolean;
  permanent: boolean;
}

export function classifyProviderError(errMsg: string): ProviderErrorClassification {
  const msg = String(errMsg ?? "");
  if (msg === "PROVIDER_BILLING_ERROR") {
    return { kind: "billing", retryable: false, fast_fallback: true, permanent: false };
  }
  if (/is not defined|is not a function|cannot read prop(?:erty|erties) of (?:undefined|null)|ReferenceError|TypeError|SyntaxError/i.test(msg)) {
    return { kind: "programming", retryable: false, fast_fallback: false, permanent: true };
  }
  if (/safety|prompt blocked|blocked this prompt|content policy|prohibited|recitation|SPII/i.test(msg)) {
    return { kind: "safety", retryable: false, fast_fallback: false, permanent: true };
  }
  if (/invalid input|invalid_argument|validation|requires (?:a |an )?[\w ]+ input|missing required|no .* (?:provided|specified|supplied)|input .* is required|cannot be empty/i.test(msg)) {
    return { kind: "validation", retryable: false, fast_fallback: false, permanent: true };
  }
  if (/image recognition failed|image meets the requirements|no complete (?:upper )?body detected|ensure .* clearly visible/i.test(msg)) {
    return { kind: "validation", retryable: false, fast_fallback: false, permanent: true };
  }
  if (/reference videos?.*(?:must|duration|invalid)|video duration.*(?:must|invalid|exceed)|total reference video duration|total duration of all videos/i.test(msg)) {
    return { kind: "validation", retryable: false, fast_fallback: false, permanent: true };
  }
  if (/Veo: failed to fetch start\/end frame \((?:400|401|403|404|410)\)/i.test(msg)) {
    return { kind: "validation", retryable: false, fast_fallback: false, permanent: true };
  }
  if (/HTTP\s*402\b|payment required|insufficient balance|account balance not enough|AccountOverdueError|overdue balance|prepaid|top[ -]?up/i.test(msg)) {
    return { kind: "billing", retryable: false, fast_fallback: true, permanent: false };
  }
  if (/HTTP\s*(?:401|403)\b|unauthorized|forbidden|invalid api key|api key.*(?:invalid|not configured|missing)|credentials missing/i.test(msg)) {
    return { kind: "auth", retryable: false, fast_fallback: false, permanent: true };
  }
  if (isNonRetryableQuotaError(msg)) {
    return { kind: "quota", retryable: false, fast_fallback: true, permanent: false };
  }
  if (/HTTP\s*429\b|rate[ -]?limit|too many requests|rate-limits|ai\.dev\/rate-limit/i.test(msg)) {
    return { kind: "rate_limit", retryable: true, fast_fallback: true, permanent: false };
  }
  if (/OpenAI Image 2 (?:edit|generation) timed out after \d+s/i.test(msg)) {
    return { kind: "timeout", retryable: true, fast_fallback: false, permanent: false };
  }
  if (/DEADLINE_EXCEEDED|HTTP\s*504\b|timeout|timed out|aborted|ETIMEDOUT/i.test(msg)) {
    return { kind: "timeout", retryable: true, fast_fallback: false, permanent: false };
  }
  if (/not having enough compute resources|insufficient compute resources|compute resources/i.test(msg)) {
    return { kind: "busy", retryable: true, fast_fallback: true, permanent: false };
  }
  if (/HTTP\s*503\b|UNAVAILABLE|high demand|overload|busy|queue|capacity|currently experiencing/i.test(msg)) {
    return { kind: "busy", retryable: true, fast_fallback: false, permanent: false };
  }
  if (/HTTP\s*(?:500|502)\b|ECONNRESET|fetch failed|ENOTFOUND|socket hang up/i.test(msg)) {
    return { kind: "transient", retryable: true, fast_fallback: false, permanent: false };
  }
  return { kind: "unknown", retryable: true, fast_fallback: false, permanent: false };
}

export function shouldFastFallbackProviderError(errMsg: string): boolean {
  return classifyProviderError(errMsg).fast_fallback;
}

/**
 * Classify an error message to decide whether retrying makes sense.
 *
 *   - "permanent": billing / safety / malformed prompt — never retry
 *   - "transient": 5xx / 429 / timeout / connection — retry
 *   - "unknown":   default safe — also retry, then probe at the end
 */
export function classifyError(errMsg: string): "permanent" | "transient" | "unknown" {
  if (errMsg === "PROVIDER_BILLING_ERROR") return "permanent";
  // Keep the legacy retry loop behavior: HTTP 429 / 5xx should retry first.
  // Workspace durable jobs use shouldFastFallbackProviderError() directly when
  // they need to skip straight to the next provider on quota/rate-limit errors.
  if (/HTTP\s*(?:429|500|502|503|504)\b/i.test(errMsg)) return "transient";
  const rich = classifyProviderError(errMsg);
  if (rich.permanent) return "permanent";
  if (rich.kind === "billing" || rich.kind === "quota") return "permanent";
  if (rich.kind === "rate_limit" || rich.kind === "busy" || rich.kind === "timeout" || rich.kind === "transient") {
    return "transient";
  }
  // HTTP 429 / 5xx wins before the quota-text classifier. Google's
  // "ghost 429" responses on Tier-1 paid keys include
  // "exceeded your current quota" / "check your plan and billing details"
  // in the body even though the failure is server-side and recovers on
  // retry — `isNonRetryableQuotaError` would otherwise refund those
  // permanently. Throwers that include `(HTTP 429)` / `(HTTP 503)` etc.
  // in the message land in the transient lane instead.
  if (isNonRetryableQuotaError(errMsg)) return "permanent";
  if (/safety|invalid input|invalid_argument|prompt blocked/i.test(errMsg)) {
    return "permanent";
  }
  // Provider-side validation: reference media constraints cannot be fixed by retrying.
  if (/reference videos?.*(?:must|duration|invalid)|video duration.*(?:must|invalid|exceed)|total reference video duration|total duration of all videos/i.test(errMsg)) {
    return "permanent";
  }
  // Referenced Veo frame URLs that return 4xx are missing/expired or not readable.
  if (/Veo: failed to fetch start\/end frame \((?:400|401|403|404|410)\)/i.test(errMsg)) {
    return "permanent";
  }
  // Programming errors — retrying never helps. Refund immediately.
  if (/is not defined|is not a function|cannot read prop(?:erty|erties) of (?:undefined|null)|ReferenceError|TypeError|SyntaxError/i.test(errMsg)) {
    return "permanent";
  }
  // Validation errors — missing required inputs / wiring issues. Retry never helps.
  // Two word orders cover the executor message conventions in this repo:
  //   - "A prompt is required."          (banana, openAIImage)
  //   - "Seedream requires a prompt."    (seedream, seedance, replicate variants)
  // Both must classify as permanent or the durable worker retry-loops the
  // user's no-prompt run 18× until the deadline expires (job stays
  // "running" the whole time — the credit is never refunded automatically).
  if (/requires (?:a |an )?[\w ]+ input|requires? (?:a |an )?prompt|missing required|no .* (?:provided|specified|supplied)|input .* is required|prompt (?:is |are )?required|cannot be empty/i.test(errMsg)) {
    return "permanent";
  }
  if (/504|502|503|500|429|timeout|ECONNRESET|fetch failed|aborted|ENOTFOUND|ETIMEDOUT|socket hang up|overload|busy|queue|rate limit|compute resources/i.test(errMsg)) {
    return "transient";
  }
  return "unknown";
}

function computeDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 750);
  return base + jitter;
}

/**
 * Execute `runOnce` with the unified 12+6 retry strategy.
 *
 * @param runOnce         async fn that performs ONE provider call and returns the result
 * @param probeHealth     async fn returning provider health, called after PRIMARY_RETRIES exhaust
 * @param logTag          prefix for console logs (e.g. "[dispatcher]" or "[step-executor 3]")
 */
export async function executeWithUnifiedRetry<T>(
  runOnce: () => Promise<T>,
  probeHealth: () => Promise<HealthProbe>,
  logTag = "[retry]",
): Promise<RetryOutcome<T>> {
  let result: T | null = null;
  let lastError: Error | null = null;
  let attempts = 0;
  let enteredExtendedPhase = false;
  let healthProbe: HealthProbe | undefined;
  let deadlineExceededHits = 0;

  // ─── Phase 1: PRIMARY_RETRIES (12) ────────────────────────────────
  for (let attempt = 0; attempt < PRIMARY_RETRIES; attempt++) {
    attempts++;
    try {
      result = await runOnce();
      return {
        result, error: null, attempts,
        enteredExtendedPhase: false,
        classification: "success",
      };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const errMsg = lastError.message;
      const kind = classifyError(errMsg);

      if (kind === "permanent") {
        console.error(`${logTag} attempt ${attempts} PERMANENT (no retry): ${errMsg}`);
        return {
          result: null, error: lastError, attempts,
          enteredExtendedPhase: false,
          classification: "permanent",
        };
      }

      // Streak-based short-circuit: Google DEADLINE_EXCEEDED on Pro
      // image / video models almost always comes in long streaks; one
      // success out of 18 attempts is rare enough that waiting it out
      // costs the user more than refunding promptly.
      if (isDeadlineExceededError(errMsg)) {
        deadlineExceededHits++;
        if (deadlineExceededHits >= DEADLINE_EXCEEDED_RETRY_CAP) {
          console.error(
            `${logTag} ${deadlineExceededHits} consecutive DEADLINE_EXCEEDED — short-circuit to permanent: ${errMsg}`,
          );
          return {
            result: null, error: lastError, attempts,
            enteredExtendedPhase: false,
            classification: "permanent",
          };
        }
      } else {
        deadlineExceededHits = 0;
      }

      if (attempt === PRIMARY_RETRIES - 1) {
        console.warn(`${logTag} attempt ${attempts}/${PRIMARY_RETRIES} exhausted phase 1: ${errMsg}`);
        break;
      }

      const delay = computeDelay(attempt);
      console.warn(`${logTag} attempt ${attempts}/${PRIMARY_RETRIES} retryable, waiting ${delay}ms: ${errMsg}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ─── After phase 1: run health probe ───────────────────────────────
  console.log(`${logTag} phase 1 exhausted, probing provider health...`);
  healthProbe = await probeHealth();
  console.log(`${logTag} health probe →`, healthProbe);

  // Provider is DOWN → refund immediately, no more retries
  if (!healthProbe.healthy) {
    return {
      result: null, error: lastError, attempts,
      enteredExtendedPhase: false,
      health_probe: healthProbe,
      classification: "provider_down",
    };
  }

  // ─── Phase 2: EXTENDED_RETRIES (6) — assume "high demand" ─────────
  enteredExtendedPhase = true;
  console.log(`${logTag} provider healthy, entering EXTENDED phase (+${EXTENDED_RETRIES} retries, high demand assumed)`);

  for (let i = 0; i < EXTENDED_RETRIES; i++) {
    attempts++;
    // Continue the backoff curve from where phase 1 left off
    const attemptForBackoff = PRIMARY_RETRIES + i;
    try {
      result = await runOnce();
      return {
        result, error: null, attempts,
        enteredExtendedPhase: true,
        health_probe: healthProbe,
        classification: "success",
      };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const errMsg = lastError.message;
      const kind = classifyError(errMsg);

      if (kind === "permanent") {
        console.error(`${logTag} EXT attempt ${attempts} PERMANENT: ${errMsg}`);
        return {
          result: null, error: lastError, attempts,
          enteredExtendedPhase: true,
          health_probe: healthProbe,
          classification: "permanent",
        };
      }

      // Same streak short-circuit as phase 1 — counter persists across
      // phases so a deadline-exceeded streak that starts in phase 1 and
      // continues in phase 2 still trips the cap.
      if (isDeadlineExceededError(errMsg)) {
        deadlineExceededHits++;
        if (deadlineExceededHits >= DEADLINE_EXCEEDED_RETRY_CAP) {
          console.error(
            `${logTag} EXT ${deadlineExceededHits} consecutive DEADLINE_EXCEEDED — short-circuit to permanent: ${errMsg}`,
          );
          return {
            result: null, error: lastError, attempts,
            enteredExtendedPhase: true,
            health_probe: healthProbe,
            classification: "permanent",
          };
        }
      } else {
        deadlineExceededHits = 0;
      }

      if (i === EXTENDED_RETRIES - 1) {
        console.error(`${logTag} EXT attempt ${attempts} TOTAL EXHAUSTED: ${errMsg}`);
        break;
      }

      const delay = computeDelay(attemptForBackoff);
      console.warn(`${logTag} EXT attempt ${attempts}/${TOTAL_MAX_RETRIES} retryable, waiting ${delay}ms: ${errMsg}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return {
    result: null, error: lastError, attempts,
    enteredExtendedPhase: true,
    health_probe: healthProbe,
    classification: "high_demand", // healthy provider but couldn't recover
  };
}

/**
 * Default health probe — usable from both functions.
 * Mirrors the implementation in execute-pipeline-step.
 */
export async function defaultProbeProviderHealth(provider: string): Promise<HealthProbe> {
  try {
    if (provider === "kling" || provider === "kling_extension" || provider === "motion_control") {
      const KLING_ACCESS_KEY_ID = Deno.env.get("KLING_ACCESS_KEY_ID");
      const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY");
      if (!KLING_ACCESS_KEY_ID || !KLING_SECRET_KEY) return { healthy: false, reason: "credentials missing" };
      // Lightweight HEAD-style ping: list one task
      const jwt = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);
      const res = await fetch("https://api.klingai.com/v1/videos/text2video?pageNum=1&pageSize=1", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      await res.body?.cancel();
      return { healthy: res.ok || res.status === 404, reason: `HTTP ${res.status}` };
    }
    if (provider === "banana" || provider === "chat_ai") {
      const KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
      if (!KEY) return { healthy: false, reason: "credentials missing" };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${KEY}`);
      await res.body?.cancel();
      return { healthy: res.ok, reason: `HTTP ${res.status}` };
    }
    if (provider === "remove_bg" || provider === "upscale_image") {
      const key =
        Deno.env.get("MAGNIFIC_API_KEY") ??
        Deno.env.get("FREEPIK_API_KEY") ??
        Deno.env.get("MAGNIFIC_KEY");
      if (!key?.trim()) return { healthy: false, reason: "credentials missing" };
      return { healthy: true, reason: "freepik credentials configured" };
    }
    if (provider === "merge_audio") {
      const KEY = Deno.env.get("SHOTSTACK_API_KEY");
      if (!KEY) return { healthy: false, reason: "credentials missing" };
      const res = await fetch("https://api.shotstack.io/edit/v1/probe/probe", {
        headers: { "x-api-key": KEY },
      });
      await res.body?.cancel();
      return { healthy: res.status !== 401 && res.status !== 403, reason: `HTTP ${res.status}` };
    }
    if (provider === "mp3_input") {
      return { healthy: true, reason: "passthrough" };
    }
    return { healthy: true, reason: "unknown provider, assumed healthy" };
  } catch (err) {
    return { healthy: false, reason: err instanceof Error ? err.message : String(err) };
  }
}


// Minimal JWT helper for Kling probe — duplicated here to keep _shared self-contained.
async function generateKlingJWT(accessKey: string, secretKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const data = `${enc(header)}.${enc(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${data}.${sigB64}`;
}
