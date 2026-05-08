import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/run-flow-init`;

/* ─── Helper: standard headers with apikey ─── */
function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// ═══════════════════════════════════════════════════════════
// Basic Auth & Validation Tests
// ═══════════════════════════════════════════════════════════

Deno.test("run-flow-init: CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "OPTIONS",
    headers: { "Origin": "http://localhost:3000" },
  });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.text();
});

Deno.test("run-flow-init: returns 401 without auth", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ flow_id: "test" }),
  });
  const status = res.status;
  await res.text();
  assertEquals(status, 401);
});

Deno.test("run-flow-init: returns error for missing flow_id", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(SUPABASE_ANON_KEY),
    body: JSON.stringify({}),
  });
  const body = await res.json();
  assertEquals(typeof body.error, "string");
});

Deno.test("run-flow-init: invalid token returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers("totally_invalid_token_xyz"),
    body: JSON.stringify({ flow_id: "test" }),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  // Kong gateway may return { msg: "..." } instead of { error: "..." }
  const hasError = typeof data.error === "string" || typeof data.msg === "string";
  assertEquals(hasError, true, "Response should contain an error or msg field");
});

Deno.test("run-flow-init: empty body returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers("invalid_token"),
    body: "",
  });
  const data = await res.json();
  // Kong gateway may return { msg: "..." } instead of { error: "..." }
  const hasError = typeof data.error === "string" || typeof data.msg === "string";
  assertEquals(hasError, true, "Response should contain an error or msg field");
});

Deno.test("run-flow-init: error messages never leak credentials", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers("bad_token"),
    body: JSON.stringify({ flow_id: "test" }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("service_role"), false);
  assertEquals(errorStr.includes("supabase_url"), false);
  assertEquals(errorStr.includes("kling"), false);
});

Deno.test("run-flow-init: non-existent flow_id returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(SUPABASE_ANON_KEY),
    body: JSON.stringify({ flow_id: "00000000-0000-0000-0000-000000000000" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("run-flow-init: response never contains raw secrets", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(SUPABASE_ANON_KEY),
    body: JSON.stringify({ flow_id: "test-pipeline" }),
  });
  const data = await res.json();
  const bodyStr = JSON.stringify(data).toLowerCase();
  assertEquals(bodyStr.includes("kling_access_key"), false);
  assertEquals(bodyStr.includes("stripe_secret"), false);
  assertEquals(bodyStr.includes("service_role"), false);
});

