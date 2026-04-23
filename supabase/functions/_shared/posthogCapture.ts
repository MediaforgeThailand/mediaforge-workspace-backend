/// <reference lib="deno.ns" />
/**
 * PostHog server-side event capture for Supabase Edge Functions.
 * Uses the PostHog Capture API directly (posthog-node doesn't support Deno).
 *
 * Requires POSTHOG_API_KEY in Supabase secrets.
 */

const POSTHOG_HOST = Deno.env.get("POSTHOG_HOST") || "https://us.i.posthog.com";
const POSTHOG_API_KEY = Deno.env.get("POSTHOG_API_KEY") || "";

export interface PostHogEvent {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

/**
 * Send an event to PostHog. Fire-and-forget: errors are logged but never thrown.
 */
export async function capturePostHogEvent(ev: PostHogEvent): Promise<void> {
  if (!POSTHOG_API_KEY) {
    console.warn("[PostHog] POSTHOG_API_KEY not set, skipping event:", ev.event);
    return;
  }
  try {
    const res = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_API_KEY,
        event: ev.event,
        distinct_id: ev.distinctId,
        properties: ev.properties ?? {},
        timestamp: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.error("[PostHog] Capture failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("[PostHog] Unexpected error:", err);
  }
}

/**
 * Drop-in replacement for the old logApiUsage function.
 * Accepts the same payload shape and sends it as a PostHog event.
 */
export interface ApiLogPayload {
  user_id: string;
  endpoint: string;
  feature: string;
  model?: string;
  status: "success" | "error";
  credits_used?: number;
  credits_refunded?: number;
  duration_ms?: number;
  error_message?: string;
  request_metadata?: Record<string, unknown>;
}

export async function logApiUsage(
  _supabase: unknown,
  payload: ApiLogPayload,
): Promise<void> {
  await capturePostHogEvent({
    distinctId: payload.user_id,
    event: `api_${payload.feature}`,
    properties: {
      endpoint: payload.endpoint,
      feature: payload.feature,
      model: payload.model ?? null,
      status: payload.status,
      credits_used: payload.credits_used ?? 0,
      credits_refunded: payload.credits_refunded ?? 0,
      duration_ms: payload.duration_ms ?? null,
      error_message: payload.error_message ?? null,
      ...payload.request_metadata,
    },
  });
}
