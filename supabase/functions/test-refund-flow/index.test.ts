import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/test-refund-flow`;

Deno.test("test-refund-flow - CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, { method: "OPTIONS" });
  assertEquals(res.status, 200);
  await res.text();
});

Deno.test("test-refund-flow - missing auth returns 401", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(data.error, "Authorization required");
});

Deno.test("test-refund-flow - invalid token returns 401", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token_xyz",
    },
    body: JSON.stringify({}),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(data.error, "Invalid token");
});

Deno.test("test-refund-flow - error messages never leak credentials", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("service_role"), false);
  assertEquals(errorStr.includes("supabase_url"), false);
});
