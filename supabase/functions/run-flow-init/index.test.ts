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

// ═══════════════════════════════════════════════════════════
// Banana (Gemini) Background Execution — Single Node Flow
// ═══════════════════════════════════════════════════════════
//
// LEGACY (skipped): the tests below depend on:
//   1. A test user `test-runner@test.local / testpass123456` in
//      Supabase Auth that doesn't exist on workspace prod.
//   2. A seeded flow named "Test Food Promo" in `public.flows`.
//   3. Live Banana / Gemini calls that consume real credits per run.
//
// run-flow-init is part of the legacy consumer-app flow execution
// path (see CLAUDE.md). Workspace product runs nodes through
// workspace-run-node instead. We keep these tests in source so they
// can be revived if the legacy surface ever needs to be re-validated,
// but mark them ignore so the suite stays green and CI doesn't burn
// API credit on every run. To revive: provision the test user + seed
// the flow, then change `Deno.test.ignore` back to `Deno.test`.

Deno.test.ignore("run-flow-init: banana single-node returns status=running with task_id (background execution)", async () => {
  const token = await getTestUserToken();
  const flowId = await getTestFlowId(token);

  const graphNodes = [
    { id: "input1", type: "inputNode", data: { label: "Image Upload", fieldType: "image", required: true } },
    { id: "banana1", type: "bananaProNode", data: { label: "Banana Pro", params: { prompt: "Generate a food promo image", model_name: "nano-banana-2", aspect_ratio: "1:1" } } },
    { id: "output1", type: "outputNode", data: { label: "Output", outputType: "image" } },
  ];
  const graphEdges = [
    { id: "e1", source: "input1", target: "banana1", sourceHandle: "default", targetHandle: "ref_image" },
    { id: "e2", source: "banana1", target: "output1", sourceHandle: "image", targetHandle: "default" },
  ];

  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow_id: flowId,
      node_type: "bananaProNode",
      provider: "banana",
      is_async: false,
      output_type: "image_url",
      params: { prompt: "Generate a food promo image", model_name: "nano-banana-2", aspect_ratio: "1:1" },
      graph_nodes: graphNodes,
      graph_edges: graphEdges,
    }),
  });

  const data = await res.json();

  // Should return immediately with status "processing" (background execution via EdgeRuntime.waitUntil)
  assertEquals(res.status, 200);
  assertEquals(data.status, "processing");
  assertExists(data.run_id, "Should have run_id");
  assertEquals(data.output_type, "image_url");
  assertEquals(typeof data.credit_cost, "number");
  assertEquals(data.credit_cost > 0, true, "Credit cost should be positive");
  assertEquals(data.background, true, "Should indicate background execution");
});

Deno.test.ignore("run-flow-init: banana flow creates flow_run record with processing status", async () => {
  const token = await getTestUserToken();
  const flowId = await getTestFlowId(token);

  const graphNodes = [
    { id: "input1", type: "inputNode", data: { label: "Image Upload", fieldType: "image", required: true } },
    { id: "banana1", type: "bananaProNode", data: { label: "Banana Pro", params: { prompt: "Test prompt", model_name: "nano-banana-2", aspect_ratio: "1:1" } } },
    { id: "output1", type: "outputNode", data: { label: "Output", outputType: "image" } },
  ];
  const graphEdges = [
    { id: "e1", source: "input1", target: "banana1", sourceHandle: "default", targetHandle: "ref_image" },
    { id: "e2", source: "banana1", target: "output1", sourceHandle: "image", targetHandle: "default" },
  ];

  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow_id: flowId,
      node_type: "bananaProNode",
      params: { prompt: "Test prompt", model_name: "nano-banana-2", aspect_ratio: "1:1" },
      graph_nodes: graphNodes,
      graph_edges: graphEdges,
    }),
  });

  const data = await res.json();
  assertEquals(res.status, 200);
  assertEquals(data.status, "processing");

  // Verify the flow_run record exists in DB with status "processing"
  const runRes = await fetch(
    `${SUPABASE_URL}/rest/v1/flow_runs?id=eq.${data.run_id}&select=id,status,outputs,credits_used`,
    { headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${token}` } },
  );
  const runs = await runRes.json();
  assertEquals(runs.length, 1, "Should have exactly one flow_run record");
  // Status is either "processing" (background task not done yet) or "completed"/"failed_refunded" (already done)
  assertEquals(
    ["processing", "completed", "failed_refunded"].includes(runs[0].status),
    true,
    `Status should be processing/completed/failed_refunded but got: ${runs[0].status}`,
  );
  assertEquals(runs[0].credits_used > 0, true, "Credits used should be positive");
});

Deno.test.ignore("run-flow-init: banana flow deducts credits (verified via transactions)", async () => {
  const token = await getTestUserToken();
  const flowId = await getTestFlowId(token);
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userId = "b64059e0-bfad-4001-8fda-bbe1ec377ccd";

  const graphNodes = [
    { id: "input1", type: "inputNode", data: { label: "Image Upload", fieldType: "image", required: true } },
    { id: "banana1", type: "bananaProNode", data: { label: "Banana Pro", params: { prompt: "Credit test", model_name: "nano-banana-2", aspect_ratio: "1:1" } } },
    { id: "output1", type: "outputNode", data: { label: "Output", outputType: "image" } },
  ];
  const graphEdges = [
    { id: "e1", source: "input1", target: "banana1", sourceHandle: "default", targetHandle: "ref_image" },
    { id: "e2", source: "banana1", target: "output1", sourceHandle: "image", targetHandle: "default" },
  ];

  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      flow_id: flowId,
      node_type: "bananaProNode",
      params: { prompt: "Credit test", model_name: "nano-banana-2", aspect_ratio: "1:1" },
      graph_nodes: graphNodes,
      graph_edges: graphEdges,
    }),
  });

  const data = await res.json();
  assertEquals(res.status, 200);
  assertEquals(data.status, "processing");

  // Verify credit deduction happened via transactions table
  // (balance may already be refunded by background task, but the usage transaction proves deduction occurred)
  const txRes = await fetch(
    `${SUPABASE_URL}/rest/v1/credit_transactions?user_id=eq.${userId}&type=eq.usage&order=created_at.desc&limit=1&select=amount,type`,
    { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
  );
  const txData = await txRes.json();
  assertEquals(txData.length, 1, "Should have at least one usage transaction");
  assertEquals(txData[0].type, "usage");
  assertEquals(txData[0].amount < 0, true, "Usage transaction amount should be negative (deduction)");
  assertEquals(Math.abs(txData[0].amount), data.credit_cost, "Deducted amount should match credit_cost");
});
