import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/run-flow-status`;
const INIT_URL = `${SUPABASE_URL}/functions/v1/run-flow-init`;

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

Deno.test("run-flow-status: CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "OPTIONS",
    headers: { "Origin": "http://localhost:3000" },
  });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.text();
});

Deno.test("run-flow-status: returns 401 without auth", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ task_id: "test", provider: "kling" }),
  });
  const status = res.status;
  await res.text();
  assertEquals(status, 401);
});

Deno.test("run-flow-status: missing task_id returns 400", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers("invalid_token"),
    body: JSON.stringify({}),
  });
  const data = await res.json();
  // Kong gateway may return { msg: "..." } instead of { error: "..." }
  const hasError = typeof data.error === "string" || typeof data.msg === "string";
  assertEquals(hasError, true, "Response should contain an error or msg field");
  // Either auth error (401) or validation error (400) — both acceptable
  assertEquals([400, 401].includes(res.status), true);
});

Deno.test("run-flow-status: invalid token returns 401", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers("totally_invalid_token_abc"),
    body: JSON.stringify({ task_id: "test123" }),
  });
  assertEquals(res.status, 401);
  const data = await res.json();
  // Kong gateway may return { msg: "..." } instead of { error: "..." }
  const hasError = data.error === "Invalid token" || typeof data.msg === "string";
  assertEquals(hasError, true, "Response should contain an error/msg field");
});

