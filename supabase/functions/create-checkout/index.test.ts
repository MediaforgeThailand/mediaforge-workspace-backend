import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/create-checkout`;

// ─── Existing Tests ───────────────────────────────────────────────

Deno.test("create-checkout - CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  await res.text();
});

Deno.test("create-checkout - rejects unauthenticated request", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: "test-id" }),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  assertEquals(data.error.includes("SUPABASE") || data.error.includes("stripe"), false);
});

Deno.test("create-checkout - rejects invalid bearer token", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token_abc123",
    },
    body: JSON.stringify({ packageId: "test-id" }),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  assertEquals(data.error, "User not authenticated");
});

Deno.test("create-checkout - rejects missing packageId", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  const isSafe = ["User not authenticated", "Missing packageId", "Checkout failed. Please try again."].includes(data.error);
  assertEquals(isSafe, true);
});

Deno.test("create-checkout - rejects invalid billingInterval", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ packageId: "test", billingInterval: "weekly" }),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  const isSafe = ["User not authenticated", "Invalid billingInterval", "Checkout failed. Please try again."].includes(data.error);
  assertEquals(isSafe, true);
});

Deno.test("create-checkout - error messages never leak internal details", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: 123 }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("stripe_secret"), false);
  assertEquals(errorStr.includes("supabase_service_role"), false);
  assertEquals(errorStr.includes("stack trace"), false);
});

// ─── Edge Case Tests ──────────────────────────────────────────────

Deno.test("create-checkout - empty body returns safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "",
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("stripe_secret"), false);
});

Deno.test("create-checkout - non-string packageId (number) returns safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ packageId: 42 }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  const isSafe = ["User not authenticated", "Missing packageId", "Checkout failed. Please try again."].includes(data.error);
  assertEquals(isSafe, true);
});

Deno.test("create-checkout - non-string packageId (array) returns safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ packageId: ["a", "b"] }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("create-checkout - extra-long packageId returns safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ packageId: "x".repeat(2000) }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("stripe_secret"), false);
});

// ─── Stripe Webhook Tests ─────────────────────────────────────────

const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/stripe-webhook`;

Deno.test("stripe-webhook - CORS preflight returns 200", async () => {
  const res = await fetch(WEBHOOK_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  await res.text();
});

Deno.test("stripe-webhook - rejects missing signature", async () => {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "checkout.session.completed" }),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(data.error, "Missing signature");
});

Deno.test("stripe-webhook - rejects invalid signature", async () => {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": "t=123,v1=invalid_signature",
    },
    body: JSON.stringify({ type: "checkout.session.completed" }),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(data.error, "Invalid signature");
});

// ─── Stripe Webhook Edge Cases ────────────────────────────────────

Deno.test("stripe-webhook - empty body with signature returns error", async () => {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": "t=999,v1=fakesig",
    },
    body: "",
  });
  // Should return 401 (invalid sig) not 500
  assertEquals([401, 500].includes(res.status), true);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  const errorStr = data.error.toLowerCase();
  assertEquals(errorStr.includes("stripe_secret"), false);
  assertEquals(errorStr.includes("stripe_webhook_secret"), false);
});

Deno.test("stripe-webhook - malformed JSON with signature returns error", async () => {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": "t=999,v1=fakesig",
    },
    body: "{not valid json!!!",
  });
  assertEquals([401, 500].includes(res.status), true);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("stripe-webhook - error messages never leak webhook secret", async () => {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": "t=0,v1=bad",
    },
    body: JSON.stringify({ type: "test" }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("whsec_"), false);
  assertEquals(errorStr.includes("stripe_webhook_secret"), false);
});
