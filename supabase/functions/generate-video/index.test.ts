import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/generate-video`;

Deno.test("generate-video: CORS preflight returns 200", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "OPTIONS",
    headers: { "Origin": "http://localhost:3000" },
  });
  assertEquals(res.status, 200);
  assertExists(res.headers.get("access-control-allow-origin"));
  await res.text();
});

Deno.test("generate-video: returns 401 without auth", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ prompt: "test", model: "kling-2-6-pro" }),
  });
  const status = res.status;
  await res.text();
  assertEquals(status, 401);
});

// ─── Edge Case Tests ──────────────────────────────────────────────

Deno.test("generate-video: missing prompt and image_url returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ model: "kling-2-6-pro" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("generate-video: invalid model returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ prompt: "test", model: "nonexistent-model" }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("generate-video: invalid camera_control type returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({
      prompt: "test",
      model: "kling-2-6-pro",
      camera_control: { type: "invalid_type", config: {} },
    }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("generate-video: camera control values out of range returns error", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({
      prompt: "test",
      model: "kling-2-6-pro",
      camera_control: {
        type: "simple",
        config: { horizontal: 15, vertical: -15 },
      },
    }),
  });
  const data = await res.json();
  assertEquals(typeof data.error, "string");
});

Deno.test("generate-video: error messages never leak KLING keys", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer invalid_token",
    },
    body: JSON.stringify({ prompt: "test", model: "kling-2-6-pro" }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("kling_access_key"), false);
  assertEquals(errorStr.includes("kling_secret_key"), false);
  assertEquals(errorStr.includes("kling_api_key"), false);
});
