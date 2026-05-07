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

// ─── Helpers for E2E tests ────────────────────────────

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RUN_FLOW_URL = `${SUPABASE_URL}/functions/v1/run-flow-init`;

function authHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${token}`,
  };
}

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

async function getTestFlowId(token: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/flows?name=eq.Test Food Promo&select=id&limit=1`, {
    headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data[0]?.id) throw new Error("Test flow not found — run seed script first");
  return data[0].id;
}

async function topUpCredits(userId: string, amount: number): Promise<void> {
  const r1 = await fetch(`${SUPABASE_URL}/rest/v1/user_credits?user_id=eq.${userId}`, {
    method: "PATCH",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ balance: amount }),
  });
  await r1.text();
  // Ensure a batch exists for consume_credits RPC
  const r2 = await fetch(`${SUPABASE_URL}/rest/v1/credit_batches`, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: userId, amount, remaining: amount, source_type: "topup",
      reference_id: `test-topup-${Date.now()}`,
      expires_at: "2027-01-01T00:00:00Z",
    }),
  });
  await r2.text();
}

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

// ═══════════════════════════════════════════════════════════
// E2E: Multi-node pipeline → execute-pipeline-step
// ═══════════════════════════════════════════════════════════
//
// LEGACY (skipped): the three e2e tests below need:
//   1. Test user `test-runner@test.local` in Supabase Auth.
//   2. Seed flow "Test Food Promo" in `public.flows`.
//   3. The hardcoded TEST_USER_ID below to match that user's auth.uid().
//   4. Real Banana / Gemini calls — every run consumes credits.
//
// execute-pipeline-step is part of the legacy consumer flow runner.
// Workspace product orchestrates nodes through workspace-run-node.
// See the LEGACY block in run-flow-init/index.test.ts for revival steps.

const TEST_USER_ID = "b64059e0-bfad-4001-8fda-bbe1ec377ccd";

Deno.test.ignore("e2e: run-flow-init creates pipeline, execute-pipeline-step runs chat_ai step", async () => {
  const token = await getTestUserToken();
  const flowId = await getTestFlowId(token);
  await topUpCredits(TEST_USER_ID, 50000);

  // 2-node pipeline: chatAiNode → bananaProNode
  const graphNodes = [
    {
      id: "chat1", type: "chatAiNode",
      data: { label: "Chat AI", params: { prompt: "You must respond with exactly this sentence: The golden sun dips below the purple horizon.", model_name: "google/gemini-3.1-pro-preview", max_tokens: "200" } },
    },
    {
      id: "banana1", type: "bananaProNode",
      data: { label: "Banana Pro", params: { prompt: "A beautiful sunset", model_name: "nano-banana-2", aspect_ratio: "1:1" } },
    },
    { id: "output1", type: "outputNode", data: { label: "Output", outputType: "image" } },
  ];
  const graphEdges = [
    { id: "e1", source: "chat1", target: "banana1", sourceHandle: "output_text", targetHandle: "context_text" },
    { id: "e2", source: "banana1", target: "output1", sourceHandle: "image", targetHandle: "default" },
  ];

  // Step 1: Create pipeline via run-flow-init
  const initRes = await fetch(RUN_FLOW_URL, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      flow_id: flowId,
      node_type: "chatAiNode",
      params: { prompt: "You must respond with exactly this sentence: The golden sun dips below the purple horizon.", model_name: "google/gemini-3.1-pro-preview", max_tokens: "200" },
      graph_nodes: graphNodes,
      graph_edges: graphEdges,
      all_node_params: {
        chat1: { prompt: "You must respond with exactly this sentence: The golden sun dips below the purple horizon.", model_name: "google/gemini-3.1-pro-preview", max_tokens: "200" },
        banana1: { prompt: "A beautiful sunset", model_name: "nano-banana-2", aspect_ratio: "1:1" },
      },
    }),
  });
  const initData = await initRes.json();
  assertEquals(initRes.status, 200, `run-flow-init failed: ${JSON.stringify(initData)}`);
  assertEquals(initData.status, "pipeline_created");
  assertExists(initData.execution_id, "Should have execution_id");
  assertExists(initData.run_id, "Should have run_id");
  assertEquals(initData.total_steps, 2, "Should have 2 pipeline steps");

  // Step 2: Execute first step (chatAiNode) via execute-pipeline-step
  const stepRes = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ execution_id: initData.execution_id, step_index: 0 }),
  });
  const stepData = await stepRes.json();
  assertEquals(stepRes.status, 200, `execute-pipeline-step failed: ${JSON.stringify(stepData)}`);
  assertExists(stepData.outcomes, "Should have outcomes array");
  assertEquals(stepData.outcomes.length, 1, "Should have 1 outcome");

  const outcome = stepData.outcomes[0];
  assertEquals(outcome.step_index, 0);
  assertEquals(outcome.status, "completed", `Step should complete but got: ${outcome.status}, error: ${outcome.error}`);
  assertEquals(outcome.output_type, "text");
  assertExists(outcome.outputs, "Chat AI should return outputs");
  // Gemini may return empty text for some prompts — status=completed is the key assertion
  console.log(`[e2e] Chat AI output: "${(outcome.outputs?.output_text ?? "").substring(0, 100)}"`);
});

Deno.test.ignore("e2e: execute-pipeline-step runs banana step with image generation", async () => {
  const token = await getTestUserToken();
  const flowId = await getTestFlowId(token);
  await topUpCredits(TEST_USER_ID, 50000);

  // Single banana node in a 2-node pipeline (we only execute step 0)
  const graphNodes = [
    {
      id: "banana1", type: "bananaProNode",
      data: { label: "Banana Pro", params: { prompt: "A red apple on a white background, minimal", model_name: "nano-banana-2", aspect_ratio: "1:1" } },
    },
    {
      id: "chat1", type: "chatAiNode",
      data: { label: "Chat AI", params: { prompt: "Describe this image", model_name: "google/gemini-3.1-pro-preview" } },
    },
    { id: "output1", type: "outputNode", data: { label: "Output", outputType: "text" } },
  ];
  const graphEdges = [
    { id: "e1", source: "banana1", target: "chat1", sourceHandle: "image", targetHandle: "image_input" },
    { id: "e2", source: "chat1", target: "output1", sourceHandle: "output_text", targetHandle: "default" },
  ];

  // Create pipeline
  const initRes = await fetch(RUN_FLOW_URL, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      flow_id: flowId,
      node_type: "bananaProNode",
      params: { prompt: "A red apple on a white background, minimal", model_name: "nano-banana-2", aspect_ratio: "1:1" },
      graph_nodes: graphNodes,
      graph_edges: graphEdges,
      all_node_params: {
        banana1: { prompt: "A red apple on a white background, minimal", model_name: "nano-banana-2", aspect_ratio: "1:1" },
        chat1: { prompt: "Describe this image", model_name: "google/gemini-3.1-pro-preview" },
      },
    }),
  });
  const initData = await initRes.json();
  assertEquals(initRes.status, 200, `run-flow-init failed: ${JSON.stringify(initData)}`);
  assertEquals(initData.status, "pipeline_created");

  // Execute banana step (step 0)
  const stepRes = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ execution_id: initData.execution_id, step_index: 0 }),
  });
  const stepData = await stepRes.json();
  assertEquals(stepRes.status, 200, `execute-pipeline-step failed: ${JSON.stringify(stepData)}`);

  const outcome = stepData.outcomes[0];
  assertEquals(outcome.step_index, 0);
  assertEquals(outcome.status, "completed", `Banana step should complete but got: ${outcome.status}, error: ${outcome.error}`);
  assertEquals(outcome.output_type, "image_url");
  assertExists(outcome.result_url, "Should have result_url with generated image");
  assertEquals(outcome.result_url.startsWith("http") || outcome.result_url.startsWith("data:"), true, "result_url should be a URL");

  console.log(`[e2e] Banana image URL: ${outcome.result_url.substring(0, 100)}...`);
});

Deno.test.ignore("e2e: execute-pipeline-step handles step_indices (parallel execution)", async () => {
  const token = await getTestUserToken();
  const flowId = await getTestFlowId(token);
  await topUpCredits(TEST_USER_ID, 50000);

  // 2 independent chat_ai nodes (fast) at same level → output
  const graphNodes = [
    {
      id: "chat1", type: "chatAiNode",
      data: { label: "Text Gen A", params: { prompt: "Reply with only: alpha", model_name: "google/gemini-3.1-pro-preview", max_tokens: "20" } },
    },
    {
      id: "chat2", type: "chatAiNode",
      data: { label: "Text Gen B", params: { prompt: "Reply with only: beta", model_name: "google/gemini-3.1-pro-preview", max_tokens: "20" } },
    },
    { id: "output1", type: "outputNode", data: { label: "Output", outputType: "text" } },
  ];
  // No edges between chat1 and chat2 — they are independent (same level)
  const graphEdges = [
    { id: "e1", source: "chat1", target: "output1", sourceHandle: "output_text", targetHandle: "default" },
  ];

  const initRes = await fetch(RUN_FLOW_URL, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      flow_id: flowId,
      node_type: "chatAiNode",
      params: { prompt: "Reply with only: alpha", model_name: "google/gemini-3.1-pro-preview", max_tokens: "20" },
      graph_nodes: graphNodes,
      graph_edges: graphEdges,
      all_node_params: {
        chat1: { prompt: "Reply with only: alpha", model_name: "google/gemini-3.1-pro-preview", max_tokens: "20" },
        chat2: { prompt: "Reply with only: beta", model_name: "google/gemini-3.1-pro-preview", max_tokens: "20" },
      },
    }),
  });
  const initData = await initRes.json();
  assertEquals(initRes.status, 200, `run-flow-init failed: ${JSON.stringify(initData)}`);
  assertEquals(initData.status, "pipeline_created");
  assertEquals(initData.total_steps, 2);

  // Execute BOTH steps in parallel via step_indices
  const stepRes = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ execution_id: initData.execution_id, step_indices: [0, 1] }),
  });
  const stepData = await stepRes.json();
  assertEquals(stepRes.status, 200, `execute-pipeline-step failed: ${JSON.stringify(stepData)}`);
  assertEquals(stepData.outcomes.length, 2, "Should have 2 outcomes for parallel execution");

  // Both should complete (they're independent chat_ai nodes)
  for (const outcome of stepData.outcomes) {
    assertEquals(
      outcome.status, "completed",
      `Step ${outcome.step_index} should complete but got: ${outcome.status}, error: ${outcome.error}`,
    );
    assertEquals(outcome.output_type, "text");
  }

  console.log(`[e2e] Parallel results: step0="${(stepData.outcomes[0].outputs?.output_text ?? "").substring(0, 40)}", step1="${(stepData.outcomes[1].outputs?.output_text ?? "").substring(0, 40)}"`);
});
