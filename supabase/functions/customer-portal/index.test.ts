import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/customer-portal`;

Deno.test("customer-portal - CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  await res.text();
});

Deno.test("customer-portal - missing auth returns 500", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("customer-portal - invalid token returns safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token_xyz",
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  // Should be generic safe message
  const isSafe = ["Unable to open billing portal. Please try again.", "No authorization header provided"].includes(data.error);
  assertEquals(isSafe, true);
});

Deno.test("customer-portal - error messages never leak Stripe keys", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("sk_"), false);
  assertEquals(errorStr.includes("stripe_secret"), false);
  assertEquals(errorStr.includes("service_role"), false);
  assertEquals(errorStr.includes("supabase_service_role_key"), false);
});
