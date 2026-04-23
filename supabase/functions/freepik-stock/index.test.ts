import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/freepik-stock`;

Deno.test("freepik-stock: CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "OPTIONS",
    headers: { "Origin": "http://localhost:3000" },
  });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.text();
});

Deno.test("freepik-stock: returns 401 without auth", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: "search", query: "test" }),
  });
  const status = res.status;
  await res.text();
  assertEquals(status, 401);
});

// ─── Edge Case Tests ──────────────────────────────────────────────

Deno.test("freepik-stock: unknown action returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ action: "nonexistent_action" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("freepik-stock: missing resourceId for download returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ action: "download" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("freepik-stock: error messages never leak FREEPIK_API_KEY", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ action: "search", query: "test" }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("freepik_api_key"), false);
  assertEquals(errorStr.includes("service_role"), false);
});
