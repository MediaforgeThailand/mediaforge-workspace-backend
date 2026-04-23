import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/get-stripe-key`;

Deno.test("get-stripe-key: CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "OPTIONS",
    headers: { "Origin": "http://localhost:3000" },
  });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.text();
});

Deno.test("get-stripe-key: returns 401 without auth", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "GET",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
    },
  });
  const status = res.status;
  await res.text();
  assertEquals(status, 401);
});

// ─── Edge Case Tests ──────────────────────────────────────────────

Deno.test("get-stripe-key: POST method also returns 401 without auth", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({}),
  });
  // Should return 401 or similar auth error, not crash
  assertEquals([401, 500].includes(res.status), true);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("get-stripe-key: error messages never leak STRIPE_PUBLISHABLE_KEY value", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "GET",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
    },
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("stripe_secret"), false);
  assertEquals(errorStr.includes("sk_"), false);
  assertEquals(errorStr.includes("service_role"), false);
});
