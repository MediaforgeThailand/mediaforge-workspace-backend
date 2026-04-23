import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { refundCreditsAtomic } from "../_shared/pricing.ts";
import { logApiUsage } from "../_shared/posthogCapture.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ─── Types ─── */

interface FlowNode {
  id: string;
  node_type: string;
  label: string;
  sort_order: number;
  config: Record<string, unknown>;
}

interface NodeResult {
  output: string;
  type: string;
}

interface NodeOutput {
  [nodeId: string]: NodeResult;
}

/* ─── Kling Node → API model mapping ─── */
const KLING_NODE_API: Record<string, { model: string; mode: string; fixedDuration?: string }> = {
  "ai/kling_2_6_i2v":    { model: "kling-2-6-pro", mode: "pro" },
  "ai/kling_2_6_camera": { model: "kling-v1-std", mode: "pro", fixedDuration: "5" },
  "ai/kling_3_0_i2v":    { model: "kling-v3-pro", mode: "pro" },
};

/* ─── Voice model mapping ─── */
const VOICE_MODEL_MAP: Record<string, string> = {
  "Kore": "Kore", "Puck": "Puck", "Charon": "Charon", "Fenrir": "Fenrir",
  "Aoede": "Aoede", "Leda": "Leda", "Orus": "Orus", "Zephyr": "Zephyr",
};

/* ─── Text gen model mapping ─── */
const TEXT_MODEL_MAP: Record<string, string> = {
  "GPT-5": "openai/gpt-5",
  "Gemini 2.5 Flash": "google/gemini-2.5-flash",
};

/* ─── Image gen model mapping ─── */
const IMAGE_MODEL_MAP: Record<string, string> = {
  "Banana Pro": "nano-banana-pro",
  "Banana 2": "nano-banana-2",
};

/* ─── Gemini Image Model Config ─── */
const GEMINI_IMAGE_MODELS: Record<string, { gemini_model: string }> = {
  "nano-banana-pro": { gemini_model: "gemini-3-pro-image-preview" },
  "nano-banana-2":   { gemini_model: "gemini-3.1-flash-image-preview" },
};

/* ─── Base64 helpers ─── */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageBuffer(url: string): Promise<Uint8Array> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:[^;]+;base64,(.+)$/);
    if (match) {
      const bin = atob(match[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    throw new Error("Invalid data URI");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function resolveModelId(map: Record<string, string>, raw: string): string {
  return map[raw] ?? raw;
}

/* ─── Topological Sort (Kahn's algorithm) ─── */

function topologicalSort(nodes: FlowNode[]): FlowNode[] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    graph.set(n.id, []);
    inDegree.set(n.id, 0);
  }

  for (const n of nodes) {
    const conns = (n.config?.connections as Array<{ source: string }>) ?? [];
    for (const c of conns) {
      if (graph.has(c.source)) {
        graph.get(c.source)!.push(n.id);
        inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of graph.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error("Flow contains a cycle — cannot execute");
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return sorted.map((id) => nodeMap.get(id)!).filter(Boolean);
}

/* ─── Resolve {{node_id.output}} variables ─── */

function resolveRefs(template: string, outputs: NodeOutput): string {
  if (!template) return template;
  return template.replace(/\{\{([a-f0-9-]+)\.(\w+)\}\}/g, (_match, nodeId, port) => {
    const nodeOutput = outputs[nodeId];
    if (nodeOutput && port === "output") return nodeOutput.output;
    return "";
  });
}

/* ─── Kling JWT ─── */

async function generateKlingJWT(accessKeyId: string, secretKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKeyId, exp: now + 1800, nbf: now - 5, iat: now };

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${signingInput}.${sigB64}`;
}

/* ─── Poll Kling video task until complete ─── */

async function pollKlingTask(taskId: string, jwtToken: string, maxWaitMs = 300_000): Promise<string> {
  const start = Date.now();
  const statusEndpoint = `https://api.klingai.com/v1/videos/image2video/${taskId}`;

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 5000));

    const res = await fetch(statusEndpoint, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });

    if (!res.ok) {
      const txt = await res.text();
      if (res.status >= 500 || txt.trim().startsWith("<")) {
        console.warn(`[run-flow] Kling poll 5xx/HTML, retrying...`);
        continue;
      }
      throw new Error(`Kling poll error ${res.status}: ${txt}`);
    }

    const result = await res.json();
    const status = result.data?.task_status;

    if (status === "succeed") {
      const videos = result.data?.task_result?.videos;
      if (videos && videos.length > 0) return videos[0].url;
      throw new Error("Video completed but no URL returned");
    }
    if (status === "failed") {
      throw new Error(result.data?.task_status_msg || "Video generation failed");
    }
  }

  throw new Error("Video generation timed out (5 min)");
}

/* ─── Fetch credit cost from DB ─── */

async function getNodeBaseCost(
  supabase: ReturnType<typeof createClient>,
  nodeType: string,
  config: Record<string, unknown>,
): Promise<number> {
  if (nodeType === "ai/image_gen") {
    const { data } = await supabase
      .from("credit_costs")
      .select("cost")
      .eq("feature", "generate_freepik_image")
      .limit(1)
      .maybeSingle();
    return data?.cost ?? 104;
  }

  // All Kling video nodes
  if (nodeType.startsWith("ai/kling_")) {
    const duration = parseInt((config.duration as string) ?? "5", 10) || 5;
    const hasAudio = false;
    const klingDef = KLING_NODE_API[nodeType];
    const model = klingDef?.model ?? "kling-2-6-pro";

    const { data } = await supabase
      .from("credit_costs")
      .select("cost")
      .eq("feature", "generate_freepik_video")
      .eq("duration_seconds", duration)
      .eq("has_audio", hasAudio)
      .ilike("model", `%${model.split("-").slice(0, 3).join("-")}%`)
      .limit(1)
      .maybeSingle();

    if (data) return data.cost;
    if (duration === 5) return 700;
    if (duration === 10) return 1400;
    return 2800;
  }

  if (nodeType === "ai/voice_gen") {
    const { data } = await supabase
      .from("credit_costs")
      .select("cost")
      .eq("feature", "tts")
      .limit(1)
      .maybeSingle();
    return data?.cost ?? 5;
  }

  if (nodeType === "ai/text_gen") {
    return 2;
  }

  return 0;
}

/* ─── Dual-Sided Monetization Pricing (with Subscription Discounts) ─── */

interface PricingResult {
  deduction: number;
  transaction_type: string;
  rev_share_amount: number;
  base_cost: number;
  discount_applied: number;
}

function calculatePricing(
  baseCost: number,
  markupMultiplier: number,
  isOwner: boolean,
  discountPercent: number = 0,
): PricingResult {
  if (isOwner) {
    const deduction = Math.ceil(baseCost * 1.1);
    return { deduction, transaction_type: "test_run", rev_share_amount: 0, base_cost: baseCost, discount_applied: 0 };
  }
  const rawPrice = Math.ceil(baseCost * markupMultiplier);
  const discountAmount = discountPercent > 0 ? Math.floor(rawPrice * (discountPercent / 100)) : 0;
  const finalPrice = Math.max(rawPrice - discountAmount, 1); // minimum 1 credit
  const revShare = Math.floor((finalPrice - baseCost) * 0.20);
  return { deduction: finalPrice, transaction_type: "consumer_run", rev_share_amount: Math.max(revShare, 0), base_cost: baseCost, discount_applied: discountAmount };
}

async function creditRevShare(
  supabase: ReturnType<typeof createClient>,
  ownerId: string,
  amount: number,
  flowName: string,
  referenceId: string,
) {
  if (amount <= 0) return;

  await supabase.from("credit_batches").insert({
    user_id: ownerId, amount, remaining: amount, source_type: "topup",
    reference_id: referenceId,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const { data: uc } = await supabase.from("user_credits").select("balance").eq("user_id", ownerId).maybeSingle();
  const newBalance = (uc?.balance ?? 0) + amount;
  await supabase.from("user_credits").update({ balance: newBalance, updated_at: new Date().toISOString() }).eq("user_id", ownerId);

  await supabase.from("credit_transactions").insert({
    user_id: ownerId, amount, type: "rev_share", feature: "flow_run",
    description: `RevShare: ${flowName}`, reference_id: referenceId, balance_after: newBalance,
  });

  console.log(`[run-flow] RevShare: ${amount} credits to owner ${ownerId}`);
}

/* ─── Execute a single node ─── */

async function executeNode(
  node: FlowNode,
  outputs: NodeOutput,
  inputs: Record<string, unknown>,
  supabaseUrl: string,
  serviceRoleKey: string,
  authToken: string,
): Promise<NodeResult> {
  const cfg = node.config;
  const category = node.node_type.split("/")[0];
  const subType = node.node_type.split("/")[1];

  // ── Input nodes: pass through user inputs
  if (category === "input") {
    const value = (inputs[node.id] as string) ?? "";
    const type = subType.includes("image") ? "image_url"
      : subType.includes("video") ? "video_url"
      : "text";
    return { output: value, type };
  }

  // ── Transform / prompt_builder
  if (node.node_type === "transform/prompt_builder") {
    const template = (cfg.template as string) ?? "";
    return { output: resolveRefs(template, outputs), type: "text" };
  }

  // ── AI: Image Generation (Direct Gemini API call — no nested edge function)
  if (node.node_type === "ai/image_gen") {
    const GOOGLE_AI_STUDIO_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
    if (!GOOGLE_AI_STUDIO_KEY) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");

    const prompt = resolveRefs((cfg.prompt as string) ?? "", outputs);
    const rawModel = (cfg.model_name as string) ?? (cfg.model as string) ?? "Banana Pro";
    const modelId = resolveModelId(IMAGE_MODEL_MAP, rawModel);
    const aspectRatio = (cfg.aspect_ratio as string) ?? "1:1";

    const modelConfig = GEMINI_IMAGE_MODELS[modelId];
    if (!modelConfig) throw new Error(`Unknown image model: ${modelId}`);

    console.log(`[run-flow] image_gen: display="${rawModel}" → api="${modelId}" (${modelConfig.gemini_model})`);

    // Build Gemini request
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];

    // Resolve connected reference images
    const conns = (cfg.connections as Array<{ source: string }>) ?? [];
    for (const c of conns) {
      const srcOutput = outputs[c.source];
      if (srcOutput?.type === "image_url" && srcOutput.output) {
        try {
          const bytes = await fetchImageBuffer(srcOutput.output);
          const base64 = bytesToBase64(bytes);
          let mime = "image/png";
          if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = "image/jpeg";
          else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = "image/webp";
          parts.push({ inlineData: { mimeType: mime, data: base64 } });
        } catch (imgErr) {
          console.warn(`[run-flow] Failed to resolve ref image: ${imgErr}`);
        }
      }
    }

    const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
    if (aspectRatio && aspectRatio !== "Auto") {
      generationConfig.imageConfig = { aspectRatio };
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.gemini_model}:generateContent?key=${GOOGLE_AI_STUDIO_KEY}`;
    console.log(`[run-flow] Calling model: ${modelConfig.gemini_model}`);

    const aiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error(`[run-flow] Gemini error: ${aiResponse.status}`, errorText.substring(0, 300));
      if (aiResponse.status === 429 || (aiResponse.status < 500 && /billing|quota|exceeded|resource exhausted/i.test(errorText))) throw new Error("PROVIDER_BILLING_ERROR");
      if (aiResponse.status >= 500) throw new Error(`Gemini ขัดข้องชั่วคราว (HTTP ${aiResponse.status}) กรุณาลองใหม่ในอีกสักครู่`);
      const modelLabel = modelId === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2";
      throw new Error(`${modelLabel} failed (HTTP ${aiResponse.status}). Please try again.`);
    }

    const aiResult = await aiResponse.json();
    const responseParts = aiResult.candidates?.[0]?.content?.parts || [];
    let imageBase64: string | null = null;
    let imageMime = "image/png";
    for (const part of responseParts) {
      if (part.inlineData) { imageBase64 = part.inlineData.data; imageMime = part.inlineData.mimeType || "image/png"; }
    }
    if (!imageBase64) throw new Error("No image was generated. Try a different prompt.");

    // Upload to storage
    const SUPABASE_URL_ENV = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const storageClient = createClient(SUPABASE_URL_ENV, SUPABASE_SERVICE_ROLE_KEY);
    const ext = imageMime.split("/")[1] || "png";
    const fileName = `pipeline/${Date.now()}.${ext}`;
    const binaryData = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
    let publicUrl = `data:${imageMime};base64,${imageBase64}`;

    const { error: uploadError } = await storageClient.storage
      .from("ai-media").upload(fileName, binaryData, { contentType: imageMime, upsert: true });
    if (!uploadError) {
      const { data: urlData, error: signError } = await storageClient.storage
        .from("ai-media").createSignedUrl(fileName, 60 * 60 * 24 * 7);
      if (!signError && urlData?.signedUrl) publicUrl = urlData.signedUrl;
      else {
        const { data: pubData } = storageClient.storage.from("ai-media").getPublicUrl(fileName);
        publicUrl = pubData.publicUrl;
      }
    }

    return { output: publicUrl, type: "image_url" };
  }

  // ── AI: Kling Video Nodes (2.6 I2V, 2.6 Camera Control, 3.0 I2V)
  if (KLING_NODE_API[node.node_type]) {
    const klingDef = KLING_NODE_API[node.node_type];
    const prompt = resolveRefs((cfg.prompt as string) ?? "", outputs);
    const negative_prompt = (cfg.negative_prompt as string) ?? "";
    const cfg_scale = (cfg.cfg_scale as number) ?? 0.5;
    const aspect_ratio = (cfg.aspect_ratio as string) ?? "16:9";
    const duration = klingDef.fixedDuration ?? ((cfg.duration as string) ?? "5");
    const mode = (cfg.mode as string) ?? klingDef.mode;

    // Resolve connected images from handles
    const conns = (cfg.connections as Array<{ source: string; targetHandle?: string | null }>) ?? [];
    let image_url = "";
    let image_tail_url = "";

    for (const c of conns) {
      const srcOutput = outputs[c.source];
      if (!srcOutput) continue;

      if (c.targetHandle === "end_frame") {
        if (srcOutput.type === "image_url") image_tail_url = srcOutput.output;
      } else if (c.targetHandle === "start_frame" || !c.targetHandle) {
        if (srcOutput.type === "image_url") image_url = srcOutput.output;
      }
    }

    console.log(`[run-flow] ${node.node_type}: model="${klingDef.model}", mode="${mode}", duration=${duration}s, start=${!!image_url}, end=${!!image_tail_url}`);

    // Build video request body
    const videoBody: Record<string, unknown> = {
      prompt,
      model: klingDef.model,
      duration: parseInt(duration, 10),
      aspect_ratio,
      image_url,
      cfg_scale,
    };

    if (negative_prompt) videoBody.negative_prompt = negative_prompt;
    if (image_tail_url) videoBody.image_tail_url = image_tail_url;

    // Camera control for kling_2_6_camera
    if (node.node_type === "ai/kling_2_6_camera") {
      const cameraType = (cfg.camera_type as string) ?? "simple";
      const cameraControl: Record<string, unknown> = { type: cameraType };

      if (cameraType === "simple") {
        cameraControl.config = {
          pan: (cfg.camera_pan as number) ?? 0,
          tilt: (cfg.camera_tilt as number) ?? 0,
          zoom: (cfg.camera_zoom as number) ?? 0,
          roll: (cfg.camera_roll as number) ?? 0,
        };
      }

      videoBody.camera_control = cameraControl;
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/generate-video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(videoBody),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Video generation failed");

    // If we got a task_id, poll for completion
    const taskId = data.task_id;
    if (taskId) {
      console.log(`[run-flow] Video task ${taskId} — polling for completion...`);
      const KLING_ACCESS_KEY_ID = Deno.env.get("KLING_ACCESS_KEY_ID") ?? "";
      const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY") ?? "";
      const jwtToken = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);
      const videoUrl = await pollKlingTask(taskId, jwtToken);
      return { output: videoUrl, type: "video_url" };
    }

    return { output: data.video_url ?? data.url ?? "", type: "video_url" };
  }

  // ── AI: Voice Generation (TTS)
  if (node.node_type === "ai/voice_gen") {
    const text = resolveRefs((cfg.text as string) ?? (cfg.prompt as string) ?? "", outputs);
    const rawVoice = (cfg.model as string) ?? (cfg.voice as string) ?? "Kore";
    const voice = resolveModelId(VOICE_MODEL_MAP, rawVoice);

    console.log(`[run-flow] voice_gen: voice="${rawVoice}" → api="${voice}"`);

    const res = await fetch(`${supabaseUrl}/functions/v1/text-to-speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ text, voice_name: voice }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "TTS failed");
    return { output: data.audio_url ?? "", type: "audio_url" };
  }

  // ── AI: Text Generation (via Lovable AI Gateway)
  if (node.node_type === "ai/text_gen") {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const systemPrompt = (cfg.system_prompt as string) ?? "";
    const userPrompt = resolveRefs((cfg.prompt as string) ?? "", outputs);
    const rawModel = (cfg.model as string) ?? "GPT-5";
    const model = resolveModelId(TEXT_MODEL_MAP, rawModel);

    console.log(`[run-flow] text_gen: display="${rawModel}" → api="${model}"`);

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const status = res.status;
      if (status === 429) throw new Error("AI rate limit exceeded. Please try again later.");
      if (status === 402) throw new Error("Insufficient AI credits. Please top up your workspace.");
      const errText = await res.text();
      console.error("[run-flow] AI Gateway error:", status, errText);
      throw new Error("Text generation failed");
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    return { output: text, type: "text" };
  }

  // ── Output nodes: pass through from connected source
  if (category === "output") {
    const conns = (cfg.connections as Array<{ source: string }>) ?? [];
    for (const c of conns) {
      if (outputs[c.source]) return outputs[c.source];
    }
    return { output: "", type: "unknown" };
  }

  // ── Default passthrough for transform/unrecognized
  const conns = (cfg.connections as Array<{ source: string }>) ?? [];
  for (const c of conns) {
    if (outputs[c.source]) return outputs[c.source];
  }
  return { output: "", type: "unknown" };
}

/* ─── Main Handler ─── */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Auth check
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { flow_id, inputs } = body as { flow_id: string; inputs: Record<string, unknown> };
    if (!flow_id) throw new Error("flow_id is required");

    // Fetch flow with monetization columns
    const { data: flow, error: flowErr } = await supabase
      .from("flows")
      .select("*")
      .eq("id", flow_id)
      .single();
    if (flowErr || !flow) throw new Error("Flow not found");

    const isOwner = user.id === flow.user_id;
    const markupMultiplier = Number(flow.markup_multiplier) || 4.0;
    const isOfficial = !!flow.is_official;

    // ─── Lookup subscription discount ───
    let discountPercent = 0;
    if (!isOwner) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("subscription_plan_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (profile?.subscription_plan_id) {
        const { data: plan } = await supabase
          .from("subscription_plans")
          .select("discount_official, discount_community")
          .eq("id", profile.subscription_plan_id)
          .maybeSingle();

        if (plan) {
          discountPercent = isOfficial
            ? Number(plan.discount_official) || 0
            : Number(plan.discount_community) || 0;
        }
      }
    }

    // Fetch nodes
    const { data: nodes, error: nodesErr } = await supabase
      .from("flow_nodes")
      .select("*")
      .eq("flow_id", flow_id)
      .order("sort_order", { ascending: true });
    if (nodesErr) throw new Error("Failed to fetch nodes");
    if (!nodes || nodes.length === 0) throw new Error("Flow has no nodes");

    // Topological sort
    const sorted = topologicalSort(nodes as FlowNode[]);

    // Pre-calculate total base cost from all AI nodes
    let totalBaseCost = 0;
    for (const node of sorted) {
      if (node.node_type.startsWith("ai/")) {
        totalBaseCost += await getNodeBaseCost(supabase, node.node_type, node.config);
      }
    }

    // Calculate pricing based on caller role + subscription discount
    const pricing = calculatePricing(totalBaseCost, markupMultiplier, isOwner, discountPercent);

    console.log(`[run-flow] flow=${flow_id} | isOwner=${isOwner} | base_cost=${totalBaseCost} | deduction=${pricing.deduction} | discount=${pricing.discount_applied} | type=${pricing.transaction_type} | rev_share=${pricing.rev_share_amount}`);

    // ─── Pre-auth: Use consume_credits for atomic deduction ───
    const { data: deductSuccess, error: deductErr } = await supabase.rpc("consume_credits", {
      p_user_id: user.id,
      p_amount: pricing.deduction,
      p_feature: "flow_run",
      p_description: `Flow: ${flow.name} (${pricing.transaction_type})`,
      p_reference_id: flow_id,
    });

    if (deductErr || !deductSuccess) {
      const { data: uc } = await supabase.from("user_credits").select("balance").eq("user_id", user.id).maybeSingle();
      return new Response(
        JSON.stringify({
          error: "Insufficient credits",
          required: pricing.deduction,
          balance: uc?.balance ?? 0,
        }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update transaction type from default 'usage' to specific type
    if (pricing.transaction_type !== "usage") {
      await supabase
        .from("credit_transactions")
        .update({ type: pricing.transaction_type })
        .eq("reference_id", flow_id)
        .eq("user_id", user.id)
        .eq("type", "usage")
        .order("created_at", { ascending: false })
        .limit(1);
    }

    // Create flow_run record
    const { data: run, error: runErr } = await supabase
      .from("flow_runs")
      .insert({
        flow_id,
        user_id: user.id,
        inputs: inputs ?? {},
        status: "running",
        version: flow.current_version,
        credits_used: pricing.deduction,
      })
      .select()
      .single();
    if (runErr) throw new Error("Failed to create run record");

    // Execute nodes sequentially
    const outputs: NodeOutput = {};
    const startTime = Date.now();

    for (let i = 0; i < sorted.length; i++) {
      const node = sorted[i];

      try {
        // Stream progress via Realtime
        await supabase
          .from("flow_runs")
          .update({
            outputs: {
              progress: {
                current_step: i + 1,
                total_steps: sorted.length,
                current_node_label: node.label,
                current_node_type: node.node_type,
                completed_nodes: Object.keys(outputs),
              },
              partial_results: outputs,
            },
          })
          .eq("id", run.id);

        const result = await executeNode(node, outputs, inputs ?? {}, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, token);
        outputs[node.id] = result;
      } catch (nodeError) {
        // Atomic refund via RPC (consistent with run-flow-init)
        const refundAmount = pricing.deduction;
        await refundCreditsAtomic(
          supabase, user.id, refundAmount,
          `Refund: node "${node.label}" failed`, run.id,
        );

        // Log failed API usage
        await logApiUsage(supabase, {
          user_id: user.id,
          endpoint: "run-flow",
          feature: "flow_run",
          model: node.node_type,
          status: "error",
          credits_used: refundAmount,
          credits_refunded: refundAmount,
          duration_ms: Date.now() - startTime,
          error_message: (nodeError as Error).message,
          request_metadata: { flow_id, node_id: node.id, node_label: node.label },
        });

        // Mark run as failed
        await supabase
          .from("flow_runs")
          .update({
            status: "failed_refunded",
            error_message: `Node "${node.label}" failed: ${(nodeError as Error).message}`,
            completed_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            outputs: { partial_results: outputs },
          })
          .eq("id", run.id);

        return new Response(
          JSON.stringify({
            error: `Node "${node.label}" failed: ${(nodeError as Error).message}`,
            run_id: run.id,
            refunded: true,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ─── RevShare: credit the flow owner if consumer run ───
    if (pricing.rev_share_amount > 0 && !isOwner) {
      await creditRevShare(
        supabase, flow.user_id, pricing.rev_share_amount,
        flow.name ?? "Untitled Flow", run.id,
      );
    }

    // Collect final outputs from output nodes
    const finalOutputs: Record<string, NodeResult> = {};
    for (const node of sorted) {
      if (node.node_type.startsWith("output/")) {
        finalOutputs[node.id] = outputs[node.id];
      }
    }

    // Mark complete
    const durationMs = Date.now() - startTime;
    await supabase
      .from("flow_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        outputs: {
          final: finalOutputs,
          all: outputs,
          pricing: {
            base_cost: totalBaseCost,
            deduction: pricing.deduction,
            transaction_type: pricing.transaction_type,
            rev_share: pricing.rev_share_amount,
          },
        },
      })
      .eq("id", run.id);

    // Log successful API usage
    await logApiUsage(supabase, {
      user_id: user.id,
      endpoint: "run-flow",
      feature: "flow_run",
      status: "success",
      credits_used: pricing.deduction,
      duration_ms: durationMs,
      request_metadata: {
        flow_id, run_id: run.id,
        node_count: sorted.length,
        transaction_type: pricing.transaction_type,
        base_cost: totalBaseCost,
      },
    });

    return new Response(
      JSON.stringify({
        run_id: run.id,
        status: "completed",
        credits_used: pricing.deduction,
        base_cost: totalBaseCost,
        transaction_type: pricing.transaction_type,
        rev_share: pricing.rev_share_amount,
        duration_ms: durationMs,
        outputs: finalOutputs,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[run-flow] error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
