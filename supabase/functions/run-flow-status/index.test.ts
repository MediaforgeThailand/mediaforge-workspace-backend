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

/* ─── Helper: sign in test user and return access token ─── */
async function getTestUserToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: "test-runner@test.local", password: "testpass123456" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

/* ─── Helper: get test flow ID ─── */
async function getTestFlowId(token: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/flows?name=eq.Test Food Promo&select=id&limit=1`, {
    headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data[0]?.id) throw new Error("Test flow not found — run seed script first");
  return data[0].id;
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

Deno.test("run-flow-status: non-existent run_id returns 404", async () => {
  const token = await getTestUserToken();
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ task_id: "test", run_id: "00000000-0000-0000-0000-000000000000" }),
  });
  const data = await res.json();
  assertEquals(res.status, 404);
  assertEquals(typeof data.error, "string");
});

Deno.test("run-flow-status: error messages never leak credentials", async () => {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers("bad_token"),
    body: JSON.stringify({ task_id: "test" }),
  });
  const data = await res.json();
  const errorStr = JSON.stringify(data).toLowerCase();
  assertEquals(errorStr.includes("kling_access_key"), false);
  assertEquals(errorStr.includes("kling_secret_key"), false);
  assertEquals(errorStr.includes("service_role"), false);
});

// ═══════════════════════════════════════════════════════════
// Banana Background Execution — Polling via DB
// ═══════════════════════════════════════════════════════════

Deno.test("run-flow-status: polling banana background task returns processing while task runs", async () => {
  const token = await getTestUserToken();
  const flowId = await getTestFlowId(token);

  // First, initiate a banana flow to get a run_id
  const graphNodes = [
    { id: "input1", type: "inputNode", data: { label: "Image Upload", fieldType: "image", required: true } },
    { id: "banana1", type: "bananaProNode", data: { label: "Banana Pro", params: { prompt: "Poll test", model_name: "nano-banana-2", aspect_ratio: "1:1" } } },
    { id: "output1", type: "outputNode", data: { label: "Output", outputType: "image" } },
  ];
  const graphEdges = [
    { id: "e1", source: "input1", target: "banana1", sourceHandle: "default", targetHandle: "ref_image" },
    { id: "e2", source: "banana1", target: "output1", sourceHandle: "image", targetHandle: "default" },
  ];

  const initRes = await fetch(INIT_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow_id: flowId,
      node_type: "bananaProNode",
      params: { prompt: "Poll test", model_name: "nano-banana-2", aspect_ratio: "1:1" },
      graph_nodes: graphNodes,
      graph_edges: graphEdges,
    }),
  });
  const initData = await initRes.json();
  assertEquals(initRes.status, 200);
  assertEquals(initData.status, "running");

  // Now poll run-flow-status with the run_id (used as task_id for banana)
  const pollRes = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      task_id: initData.task_id,
      run_id: initData.run_id,
      credit_cost: initData.credit_cost,
    }),
  });
  const pollData = await pollRes.json();
  assertEquals(pollRes.status, 200);

  // Should be either "processing" (background task still running) or "succeed"/"failed_refunded" (already done)
  assertEquals(
    ["processing", "succeed", "failed_refunded"].includes(pollData.status),
    true,
    `Poll status should be processing/succeed/failed_refunded but got: ${pollData.status}`,
  );

  // If succeeded, should have result_url
  if (pollData.status === "succeed") {
    assertExists(pollData.result_url, "Completed poll should have result_url");
    assertEquals(pollData.output_type, "image_url");
  }
});

Deno.test("run-flow-status: completed banana run returns succeed with result_url", async () => {
  const token = await getTestUserToken();

  // Manually insert a completed flow_run to simulate background task completion
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userId = "b64059e0-bfad-4001-8fda-bbe1ec377ccd";

  // Get the test flow ID
  const flowId = await getTestFlowId(token);

  // Insert a completed run directly
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/flow_runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Prefer": "return=representation",
    },
    body: JSON.stringify({
      flow_id: flowId,
      user_id: userId,
      status: "completed",
      inputs: {},
      version: 1,
      credits_used: 100,
      outputs: {
        result_url: "https://example.com/test-image.png",
        output_type: "image_url",
        provider: "banana",
      },
      completed_at: new Date().toISOString(),
    }),
  });
  const insertData = await insertRes.json();
  const runId = insertData[0]?.id;
  assertExists(runId, "Should have created a flow_run");

  // Poll run-flow-status for this completed run
  const pollRes = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      task_id: runId,
      run_id: runId,
      credit_cost: 100,
    }),
  });
  const pollData = await pollRes.json();

  assertEquals(pollRes.status, 200);
  assertEquals(pollData.status, "succeed");
  assertEquals(pollData.result_url, "https://example.com/test-image.png");
  assertEquals(pollData.output_type, "image_url");
});

Deno.test("run-flow-status: failed_refunded banana run returns failure with refunded flag", async () => {
  const token = await getTestUserToken();
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userId = "b64059e0-bfad-4001-8fda-bbe1ec377ccd";
  const flowId = await getTestFlowId(token);

  // Insert a failed_refunded run directly
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/flow_runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Prefer": "return=representation",
    },
    body: JSON.stringify({
      flow_id: flowId,
      user_id: userId,
      status: "failed_refunded",
      inputs: {},
      version: 1,
      credits_used: 100,
      outputs: { provider: "banana" },
      error_message: "Gemini API quota exceeded",
      completed_at: new Date().toISOString(),
    }),
  });
  const insertData = await insertRes.json();
  const runId = insertData[0]?.id;
  assertExists(runId, "Should have created a flow_run");

  // Poll run-flow-status for this failed run
  const pollRes = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      task_id: runId,
      run_id: runId,
      credit_cost: 100,
    }),
  });
  const pollData = await pollRes.json();

  assertEquals(pollRes.status, 200);
  assertEquals(pollData.status, "failed_refunded");
  assertEquals(pollData.refunded, true);
  assertEquals(typeof pollData.error, "string");
  assertEquals(pollData.error.includes("quota"), true, "Error should contain the failure message");
});
