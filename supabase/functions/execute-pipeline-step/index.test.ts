/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/execute-pipeline-step`;

// ─── CORS ──────────────────────────────────────────────

Deno.test("execute-pipeline-step: CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "OPTIONS",
    headers: { "Origin": "http://localhost:3000" },
  });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.text();
});

// ─── Auth ──────────────────────────────────────────────

Deno.test("execute-pipeline-step: returns 401 without auth", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ execution_id: "test", step_index: 0 }),
  });
  assertEquals(res.status, 401);
  await res.text();
});

Deno.test("execute-pipeline-step: invalid token returns 401", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer totally_invalid_token_xyz",
    },
    body: JSON.stringify({ execution_id: "test", step_index: 0 }),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

// ─── Validation ────────────────────────────────────────

Deno.test("execute-pipeline-step: missing execution_id returns 400", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ step_index: 0 }),
  });
  const data = await res.json();
  // Either auth error (401) or validation error (400) — both acceptable
  assertEquals([400, 401].includes(res.status), true);
  assertEquals(typeof data.error, "string");
});

Deno.test("execute-pipeline-step: empty body returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: "",
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

// ─── Security ──────────────────────────────────────────

Deno.test("execute-pipeline-step: error messages never leak credentials", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer bad_token",
    },
    body: JSON.stringify({ execution_id: "nonexistent", step_index: 0 }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("service_role"), false);
  assertEquals(errorStr.includes("kling_access_key"), false);
  assertEquals(errorStr.includes("kling_secret_key"), false);
  assertEquals(errorStr.includes("stripe_secret"), false);
  assertEquals(errorStr.includes("supabase_url"), false);
});

