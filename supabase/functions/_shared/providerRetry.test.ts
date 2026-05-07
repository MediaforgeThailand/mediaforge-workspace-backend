/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyError,
  classifyProviderError,
  shouldFastFallbackProviderError,
  PRIMARY_RETRIES,
  EXTENDED_RETRIES,
  TOTAL_MAX_RETRIES,
} from "./providerRetry.ts";

Deno.test("provider retry classifier: quota and billing fast-fallback", () => {
  const quota = classifyProviderError(
    'Veo submit failed (HTTP 429): {"error":{"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota"}}',
  );
  assertEquals(quota.kind, "quota");
  assertEquals(quota.fast_fallback, true);
  assertEquals(quota.permanent, false);

  const billing = classifyProviderError("PROVIDER_BILLING_ERROR");
  assertEquals(billing.kind, "billing");
  assertEquals(billing.fast_fallback, true);
  assertEquals(shouldFastFallbackProviderError("PROVIDER_BILLING_ERROR"), true);
});

Deno.test("provider retry classifier: busy and timeout retry without fast-fallback", () => {
  const busy = classifyProviderError(
    "Nano Banana Pro failed (HTTP 503, key=gemini2): code 503 UNAVAILABLE high demand",
  );
  assertEquals(busy.kind, "busy");
  assertEquals(busy.retryable, true);
  assertEquals(busy.fast_fallback, false);

  const timeout = classifyProviderError("504 - DEADLINE_EXCEEDED before prefill finished");
  assertEquals(timeout.kind, "timeout");
  assertEquals(timeout.retryable, true);
  assertEquals(timeout.fast_fallback, false);
});

Deno.test("provider retry classifier: OpenAI image timeout fast-fallbacks", () => {
  const timeout = classifyProviderError("OpenAI Image 2 edit timed out after 118s");
  assertEquals(timeout.kind, "timeout");
  assertEquals(timeout.retryable, true);
  assertEquals(timeout.fast_fallback, true);
  assertEquals(timeout.permanent, false);
});

Deno.test("legacy classifyError still retries HTTP 429 before permanent quota handling", () => {
  assertEquals(
    classifyError(
      'Nano Banana Pro failed (HTTP 429): {"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}',
    ),
    "transient",
  );
});

Deno.test("provider retry classifier: validation and auth are permanent", () => {
  assertEquals(classifyProviderError("missing required image input").permanent, true);
  assertEquals(
    classifyProviderError("Image recognition failed. No complete upper body detected in the image.").kind,
    "validation",
  );
  assertEquals(classifyProviderError("HTTP 401 invalid api key").permanent, true);
});

/* ─── Legacy classifyError bucket coverage ───────────────────────────
 * These exercise classifyError's regex buckets directly. classifyError
 * is still consumed inside the retry loop, so even though
 * classifyProviderError is the richer API, we want regression coverage
 * on every bucket of the simpler one. */

Deno.test("retry budget constants are consistent (TOTAL = PRIMARY + EXTENDED)", () => {
  assertEquals(TOTAL_MAX_RETRIES, PRIMARY_RETRIES + EXTENDED_RETRIES);
});

Deno.test("classifyError — safety / blocked-prompt messages are permanent", () => {
  assertEquals(classifyError("Prompt blocked by safety filter"), "permanent");
  assertEquals(classifyError("invalid_argument: prompt"), "permanent");
  assertEquals(classifyError("Invalid input received"), "permanent");
});

Deno.test("classifyError — programming errors must not be retried", () => {
  assertEquals(classifyError("foo is not defined"), "permanent");
  assertEquals(classifyError("bar is not a function"), "permanent");
  // Modern V8 phrasing — "properties of undefined" (no interpolated key in between)
  assertEquals(classifyError("Cannot read properties of undefined"), "permanent");
  assertEquals(classifyError("Cannot read properties of null"), "permanent");
  assertEquals(classifyError("ReferenceError: X is missing"), "permanent");
  assertEquals(classifyError("TypeError: not a fn"), "permanent");
  assertEquals(classifyError("SyntaxError: bad token"), "permanent");
});

Deno.test("classifyError — wiring / missing-input errors are permanent", () => {
  assertEquals(classifyError("Node requires an image input"), "permanent");
  assertEquals(classifyError("missing required parameter prompt"), "permanent");
  assertEquals(classifyError("input prompt is required"), "permanent");
  assertEquals(classifyError("prompt cannot be empty"), "permanent");
});

Deno.test("classifyError — unrecognized errors fall back to 'unknown' (still retried)", () => {
  assertEquals(classifyError("something weird happened"), "unknown");
  assertEquals(classifyError(""), "unknown");
});
