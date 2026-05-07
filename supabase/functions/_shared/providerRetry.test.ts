/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyError,
  classifyProviderError,
  shouldFastFallbackProviderError,
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
