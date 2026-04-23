import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/create-topup`;

Deno.test("create-topup - CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  await res.text();
});

Deno.test("create-topup - missing auth returns 500 safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: "test" }),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
  const errorStr = data.error.toLowerCase();
  assertEquals(errorStr.includes("stripe_secret"), false);
});

Deno.test("create-topup - invalid token returns safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token_xyz",
    },
    body: JSON.stringify({ packageId: "test" }),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  const isSafe = ["User not authenticated", "Top-up checkout failed. Please try again."].includes(data.error);
  assertEquals(isSafe, true);
});

Deno.test("create-topup - missing packageId returns safe error", async () => {
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
  const isSafe = ["User not authenticated", "Missing packageId", "Top-up checkout failed. Please try again."].includes(data.error);
  assertEquals(isSafe, true);
});

Deno.test("create-topup - non-string packageId returns safe error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ packageId: 123 }),
  });
  assertEquals(res.status, 500);
  const data = await res.json();
  const isSafe = ["User not authenticated", "Missing packageId", "Top-up checkout failed. Please try again."].includes(data.error);
  assertEquals(isSafe, true);
});

Deno.test("create-topup - error messages never leak Stripe keys", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageId: "nonexistent" }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("sk_"), false);
  assertEquals(errorStr.includes("stripe_secret"), false);
  assertEquals(errorStr.includes("service_role"), false);
});
