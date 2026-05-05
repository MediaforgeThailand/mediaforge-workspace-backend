import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";
import {
  lookupBaseCost, calculatePricing, refundCreditsAtomic, fetchFeatureMultipliers,
  NODE_TYPE_REGISTRY, type ProviderDef, type ProviderKey, type OutputType, type PricingResult,
} from "../_shared/pricing.ts";
import { logApiUsage } from "../_shared/posthogCapture.ts";
import {
  executeWithUnifiedRetry, defaultProbeProviderHealth, TOTAL_MAX_RETRIES,
} from "../_shared/providerRetry.ts";

/** Fetch with timeout (default 120s) — prevents indefinite hangs */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* Provider registry, pricing, and refund logic imported from _shared/pricing.ts */

/* ─── Kling model mapping (all 11 official models) ─── */
const KLING_MODEL_MAP: Record<string, { model: string; mode: string }> = {
  "kling-v1-pro":       { model: "kling-v1",          mode: "pro" },
  "kling-v1-5-pro":     { model: "kling-v1-5",        mode: "pro" },
  "kling-v1-6-pro":     { model: "kling-v1-6",        mode: "pro" },
  "kling-v2-master":    { model: "kling-v2-master",    mode: "pro" },
  "kling-v2-1-pro":     { model: "kling-v2-1",        mode: "pro" },
  "kling-v2-1-master":  { model: "kling-v2-1-master",  mode: "pro" },
  "kling-v2-5-turbo":   { model: "kling-v2-5-turbo",  mode: "pro" },
  "kling-v2-6-pro":     { model: "kling-v2-6",        mode: "pro" },
  "kling-v3-pro":       { model: "kling-v3",          mode: "pro" },
  
  "kling-v3-omni":      { model: "kling-v3-omni",     mode: "pro" },
  "kling-v2-6-motion-pro": { model: "kling-v2-6",     mode: "pro" },
  "kling-v3-motion-pro":   { model: "kling-v3",       mode: "pro" },
};

const BANANA_MODEL_MAP: Record<string, string> = {
  "nano-banana-pro": "nano-banana-pro",
  "nano-banana-2":   "nano-banana-2",
};

/* ─── Handle normalization for single-node execution ─── */

const SINGLE_NODE_HANDLE_MAP: Record<string, Record<string, string>> = {
  kling:           { start_frame: "image_url", ref_image: "image_url", end_frame: "tail_image_url" },
  kling_extension: { start_frame: "image_url", ref_image: "image_url" },
  motion_control:  { start_frame: "image_url", ref_image: "image_url" },
  banana:          { ref_image: "image_url", start_frame: "image_url" },
  chat_ai:         { ref_image: "image_url", start_frame: "image_url" },
  remove_bg:       { image: "image_url", ref_image: "image_url", image_input: "image_url" },
  merge_audio:     { video: "video_url", audio: "audio_url" },
};

function normalizeHandleForSingleNode(provider: ProviderKey, handle: string): string | undefined {
  return SINGLE_NODE_HANDLE_MAP[provider]?.[handle];
}

/* ─── Helpers ─── */

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

async function imageUrlToBase64(url: string): Promise<string> {
  return bytesToBase64(await fetchImageBuffer(url));
}

/* ─── Image dimension extraction (lightweight header parsing) ─── */

interface ImageDimensions { width: number; height: number }

function extractImageDimensions(buf: Uint8Array): ImageDimensions | null {
  try {
    // PNG: bytes 0-7 = signature, IHDR chunk starts at byte 8
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
      const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
      return { width, height };
    }
    // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xFF) { offset++; continue; }
        const marker = buf[offset + 1];
        // SOF0, SOF1, SOF2, SOF3
        if (marker >= 0xC0 && marker <= 0xC3 && marker !== 0xC1) {
          const height = (buf[offset + 5] << 8) | buf[offset + 6];
          const width = (buf[offset + 7] << 8) | buf[offset + 8];
          return { width, height };
        }
        const segLen = (buf[offset + 2] << 8) | buf[offset + 3];
        offset += 2 + segLen;
      }
    }
    // WebP: RIFF....WEBP + VP8 chunk
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      // VP8 lossy
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
        const width = ((buf[26] | (buf[27] << 8)) & 0x3FFF);
        const height = ((buf[28] | (buf[29] << 8)) & 0x3FFF);
        return { width, height };
      }
      // VP8L lossless
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4C) {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        const width = 1 + (((b1 & 0x3F) << 8) | b0);
        const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 >> 6) & 0x03));
        return { width, height };
      }
    }
  } catch (e) {
    console.warn("[aspect-ratio] Header parse error:", e);
  }
  return null;
}

/* ─── Closest aspect ratio matching ─── */

const KLING_SUPPORTED_RATIOS: Array<{ label: string; value: number }> = [
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "1:1",  value: 1 },
];

function findClosestAspectRatio(width: number, height: number): string {
  const actual = width / height;
  let bestLabel = "16:9";
  let bestDiff = Infinity;
  for (const r of KLING_SUPPORTED_RATIOS) {
    const diff = Math.abs(actual - r.value);
    if (diff < bestDiff) { bestDiff = diff; bestLabel = r.label; }
  }
  console.log(`[aspect-ratio] Image ${width}×${height} (ratio=${actual.toFixed(4)}) → matched "${bestLabel}" (diff=${bestDiff.toFixed(4)})`);
  return bestLabel;
}

/**
 * Provider-aware @mention resolver.
 * Parses @[Label](nodeId), resolves nodeId → real URL, rewrites prompt with
 * natural-language context instructions, and collects all resolved image URLs.
 */
async function resolveMentionsInPrompt(
  prompt: string,
  graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }> | undefined,
  supabase: ReturnType<typeof createClient>,
  provider?: string,
): Promise<{ resolvedPrompt: string; mentionedImageUrls: string[] }> {
  if (!graphNodes || !prompt.includes("@[")) return { resolvedPrompt: prompt, mentionedImageUrls: [] };

  const mentions = [...prompt.matchAll(/@\[([^\]]+)\]\(([^)]+)\)/g)];
  if (mentions.length === 0) return { resolvedPrompt: prompt, mentionedImageUrls: [] };

  // Step 1: Resolve every nodeId → URL
  const resolvedUrls: Array<{ fullMatch: string; label: string; url: string | null }> = [];
  for (const match of mentions) {
    const fullMatch = match[0];
    const label = match[1];
    const nodeId = match[2];
    let resolvedUrl: string | null = null;

    const node = graphNodes.find((n) => n.id === nodeId);
    if (node) {
      const data = node.data || {};
      const uploadedUrl = data.uploadedUrl as string | undefined;
      if (uploadedUrl) {
        resolvedUrl = uploadedUrl;
      } else {
        const storagePath = data.storagePath as string | undefined;
        if (storagePath) {
          const { data: signedData } = await supabase.storage.from("ai-media").createSignedUrl(storagePath, 3600);
          if (signedData?.signedUrl) resolvedUrl = signedData.signedUrl;
        }
        if (!resolvedUrl) resolvedUrl = (data.previewUrl as string | undefined) || null;
      }
    }
    resolvedUrls.push({ fullMatch, label, url: resolvedUrl });
  }

  const mentionedImageUrls = resolvedUrls.map((r) => r.url).filter(Boolean) as string[];

  // Step 2: Provider-aware prompt formatting
  let result = prompt;
  const p = (provider || "").toLowerCase();
  const contextInstructions: string[] = [];

  if (p === "kling" || p === "kling_extension" || p === "motion_control") {
    for (let i = 0; i < resolvedUrls.length; i++) {
      const r = resolvedUrls[i];
      if (r.url) {
        const placeholder = `@image_${i + 1}`;
        result = result.replace(r.fullMatch, placeholder);
        contextInstructions.push(`${placeholder} refers to the attached image "${r.label}"`);
      } else {
        result = result.replace(r.fullMatch, `[${r.label}]`);
      }
    }
  } else if (p === "banana") {
    for (let i = 0; i < resolvedUrls.length; i++) {
      const r = resolvedUrls[i];
      if (r.url) {
        result = result.replace(r.fullMatch, "");
        contextInstructions.push(`Reference the attached image "${r.label}" (image ${i + 1}) for visual context`);
      } else {
        result = result.replace(r.fullMatch, `[${r.label}]`);
      }
    }
  } else if (p === "chat_ai") {
    for (const r of resolvedUrls) {
      if (r.url) {
        result = result.replace(r.fullMatch, `[Image: ${r.label}]`);
        contextInstructions.push(`"${r.label}" refers to the resource at: ${r.url}`);
      } else {
        result = result.replace(r.fullMatch, `[${r.label}]`);
      }
    }
  } else {
    for (const r of resolvedUrls) {
      result = result.replace(r.fullMatch, "");
    }
  }

  result = result.replace(/\s{2,}/g, " ").trim();
  if (contextInstructions.length > 0) {
    result = `${result}\n\n[Context: ${contextInstructions.join(". ")}.]\n`;
  }

  console.log(`[mention-resolver] Provider="${provider}", resolved ${mentionedImageUrls.length} image(s), prompt length=${result.length}`);
  return { resolvedPrompt: result, mentionedImageUrls };
}

/**
 * Resolves #[Label](nodeId) text variable tokens in a prompt.
 * Performs DIRECT STRING REPLACEMENT: the token is replaced by the upstream node's text output.
 * Retrieves text from graphNodes data (textValue) or from outputs dictionary.
 */
function resolveTextVariablesInPrompt(
  prompt: string,
  graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }> | undefined,
  outputs?: Record<string, Record<string, string>>,
): string {
  if (!graphNodes || !prompt.includes("#[")) return prompt;

  const textVarRegex = /#\[([^\]]+)\]\(([^)]+)\)/g;
  return prompt.replace(textVarRegex, (_fullMatch, _label, nodeId) => {
    // First check pipeline outputs (for multi-step execution)
    if (outputs) {
      const nodeOutputs = outputs[nodeId];
      if (nodeOutputs) {
        const textValue = nodeOutputs.output_text || nodeOutputs.text || Object.values(nodeOutputs)[0];
        if (textValue) return `"${textValue}"`;
      }
    }
    // Then check node data directly (for single-node or static text)
    const node = graphNodes.find((n) => n.id === nodeId);
    if (node) {
      const data = node.data || {};
      const textValue = (data.textValue as string) || (data.text as string);
      if (textValue) return `"${textValue}"`;
    }
    return "";
  });
}

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

/* ─── Credit helpers ─── */

/* lookupBaseCost, calculatePricing imported from _shared/pricing.ts */

async function deductCredits(
  supabase: ReturnType<typeof createClient>,
  userId: string, amount: number, description: string, referenceId: string, transactionType: string,
): Promise<{ success: boolean; balance: number }> {
  const { data: success, error } = await supabase.rpc("consume_credits", {
    p_user_id: userId, p_amount: amount, p_feature: "flow_run",
    p_description: description, p_reference_id: referenceId,
  });
  if (error) { console.error("[dispatcher] consume_credits error:", error); return { success: false, balance: 0 }; }
  if (!success) {
    const { data: uc } = await supabase.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
    return { success: false, balance: uc?.balance ?? 0 };
  }
  if (transactionType !== "usage") {
    await supabase.from("credit_transactions")
      .update({ type: transactionType }).eq("reference_id", referenceId)
      .eq("user_id", userId).eq("type", "usage")
      .order("created_at", { ascending: false }).limit(1);
  }
  const { data: uc } = await supabase.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
  return { success: true, balance: uc?.balance ?? 0 };
}

async function creditRevShare(
  supabase: ReturnType<typeof createClient>,
  ownerId: string, amount: number, flowName: string, referenceId: string,
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
}

/* refundCredits replaced by refundCreditsAtomic from _shared/pricing.ts */

/* ═══════════════════════════════════════════════════════════
   Single-node Provider Executors (kept for legacy single-node path)
   ═══════════════════════════════════════════════════════════ */

interface ProviderResult {
  task_id?: string;
  result_url?: string;
  output_type: OutputType;
  provider_meta?: Record<string, unknown>;
}

async function executeKling(
  params: Record<string, unknown>,
  graph_nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }>,
): Promise<ProviderResult> {
  const KLING_ACCESS_KEY_ID = Deno.env.get("KLING_ACCESS_KEY_ID")!;
  const KLING_SECRET_KEY = Deno.env.get("KLING_SECRET_KEY")!;

  const modelSlug = String(params.model_name ?? params.model ?? "kling-v2-6-pro");
  const mapping = KLING_MODEL_MAP[modelSlug];
  if (!mapping) throw new Error(`Unknown Kling model: ${modelSlug}`);

  const isMotion = modelSlug.includes("motion");
  const isOmni = modelSlug === "kling-v3-omni";
  const finalPrompt = String(params.prompt ?? "");

  const rawImageUrl = params.image_url as string | undefined;
  const videoUrl = params.video_url as string | undefined;

  // Endpoint routing
  let endpoint: string;
  if (isOmni) {
    endpoint = "https://api.klingai.com/v1/videos/omni-video";
  } else if (isMotion) {
    endpoint = "https://api.klingai.com/v1/videos/motion-control";
  } else if (rawImageUrl) {
    endpoint = "https://api.klingai.com/v1/videos/image2video";
  } else {
    endpoint = "https://api.klingai.com/v1/videos/text2video";
  }

  // Fetch image buffer once — reused for base64 AND dimension extraction
  let imageBytes: Uint8Array | undefined;
  let imageBase64: string | undefined;
  if (rawImageUrl) {
    try {
      imageBytes = await fetchImageBuffer(rawImageUrl);
      imageBase64 = bytesToBase64(imageBytes);
    } catch (err) {
      console.error(`[executeKling] image fetch failed, using URL:`, err);
    }
  }

  let tailImageBase64: string | undefined;
  if (params.image_tail_url) {
    try { tailImageBase64 = await imageUrlToBase64(String(params.image_tail_url)); } catch (err) {
      console.error(`[executeKling] tail base64 conversion failed:`, err);
    }
  }

  // ── Runtime aspect ratio resolution ──
  const rawAspect = params.aspect_ratio as string | undefined;
  let resolvedAspect: string;
  if (!rawAspect || rawAspect === "Auto") {
    if (imageBytes) {
      const dims = extractImageDimensions(imageBytes);
      if (dims) {
        resolvedAspect = findClosestAspectRatio(dims.width, dims.height);
      } else {
        console.warn("[aspect-ratio] Could not parse image dimensions, falling back to 16:9");
        resolvedAspect = "16:9";
      }
    } else {
      resolvedAspect = "16:9";
    }
  } else {
    resolvedAspect = rawAspect;
  }

  const initialMode = String((params.mode as string) ?? mapping.mode).toLowerCase() === "std" ? "std" : "pro";
  const body: Record<string, unknown> = {
    model_name: mapping.model, mode: initialMode,
  };

  if (isOmni) {
    // ── Omni: image_list + video_list + duration slider ──
    body.duration = String(params.duration ?? 5);
    body.aspect_ratio = resolvedAspect;

    // image_list — Kling spec: each item key is `image_url` (NOT `url`)
    const imageList: Array<Record<string, string>> = [];
    if (imageBase64) {
      imageList.push({ image_url: imageBase64, type: "first_frame" });
      console.log(`[executeKling-omni] Converted start_frame to base64 (${Math.round(imageBase64.length / 1024)}KB)`);
    } else if (rawImageUrl) {
      imageList.push({ image_url: rawImageUrl, type: "first_frame" });
    }
    if (params.image_tail_url) {
      imageList.push({ image_url: tailImageBase64 || String(params.image_tail_url), type: "end_frame" });
    }
    // ref_image
    const refImageUrl = params.ref_image_url as string | undefined;
    if (refImageUrl) {
      let refPayload = refImageUrl;
      try {
        const refBytes = await fetchImageBuffer(refImageUrl);
        refPayload = bytesToBase64(refBytes);
      } catch { /* use URL */ }
      imageList.push({ image_url: refPayload });
    }
    if (imageList.length > 0) body.image_list = imageList;

    // video_list — Kling spec: each item key is `video_url`,
    // refer_type/keep_original_sound live INSIDE the item (not top-level).
    if (videoUrl) {
      const referType = String(params.refer_type ?? "base");
      const keepSound = String(params.keep_original_sound ?? "no");
      body.video_list = [{ video_url: videoUrl, refer_type: referType, keep_original_sound: keepSound }];
    }

    // Audio — Kling spec: sound = "on" | "off" (string, NOT boolean).
    // Must be "off" when a reference video is present.
    const wantsSound = params.has_audio === "true" || params.has_audio === true;
    body.sound = (wantsSound && !videoUrl) ? "on" : "off";

    // Multi-shot director mode — resolve @mentions and #textvars per scene
    const isMultiShot = params.multi_shot === "true" || params.multi_shot === true;
    if (isMultiShot && params.multi_prompt) {
      body.multi_shot = true;
      body.shot_type = "customize";
      let shots: Array<{ prompt: string; duration: number }>;
      if (typeof params.multi_prompt === "string") {
        try { shots = JSON.parse(params.multi_prompt); } catch { throw new Error("multi_prompt must be valid JSON"); }
      } else {
        shots = params.multi_prompt as Array<{ prompt: string; duration: number }>;
      }

      // Resolve @mentions and #textvars in each scene prompt
      const resolvedShots: Array<{ index: number; prompt: string; duration: string }> = [];
      for (let i = 0; i < shots.length; i++) {
        let scenePrompt = shots[i].prompt;

        // Resolve #[Label](nodeId) text variables
        if (scenePrompt.includes("#[")) {
          scenePrompt = resolveTextVariablesInPrompt(scenePrompt, graphNodes);
        }

        // Resolve @[Label](nodeId) mentions — collect images for the image_list
        if (scenePrompt.includes("@[")) {
          const { resolvedPrompt, mentionedImageUrls } = await resolveMentionsInPrompt(
            scenePrompt, graphNodes, supabaseClient, "kling",
          );
          scenePrompt = resolvedPrompt;
          // Add mention images to image_list (Kling key = `image_url`, deduplicate)
          for (const url of mentionedImageUrls) {
            const existing = (body.image_list as Array<Record<string, string>> | undefined) ?? [];
            const alreadyAdded = existing.some((img) => img.image_url === url);
            if (!alreadyAdded) {
              try {
                const imgBytes = await fetchImageBuffer(url);
                const b64 = bytesToBase64(imgBytes);
                imageList.push({ image_url: b64 });
              } catch {
                imageList.push({ image_url: url });
              }
              console.log(`[executeKling-omni] Added multi_shot mention image to image_list`);
            }
          }
        }

        resolvedShots.push({
          index: i + 1,
          prompt: scenePrompt,
          duration: String(shots[i].duration),
        });
      }
      body.multi_prompt = resolvedShots;
    } else {
      if (finalPrompt) body.prompt = finalPrompt;
    }

    if (params.negative_prompt) body.negative_prompt = params.negative_prompt;

    console.log(`[executeKling] OMNI model=${modelSlug} duration=${params.duration}s images=${(body.image_list as unknown[])?.length ?? 0} videos=${videoUrl ? 1 : 0} multi_shot=${isMultiShot}`);

  } else if (isMotion) {
    body.prompt = finalPrompt;
    if (imageBase64) body.image_url = imageBase64;
    else if (rawImageUrl) body.image_url = rawImageUrl;
    if (videoUrl) body.video_url = videoUrl;
    if (params.character_orientation) body.character_orientation = params.character_orientation;
    if (params.keep_original_sound) body.keep_original_sound = params.keep_original_sound;
  } else {
    body.prompt = finalPrompt;
    body.duration = String(params.duration ?? 5);
    body.aspect_ratio = resolvedAspect;
    if (imageBase64) body.image = imageBase64;
    else if (rawImageUrl) body.image = rawImageUrl;
    if (params.image_tail_url) body.image_tail = tailImageBase64 || params.image_tail_url;
    if (params.negative_prompt) body.negative_prompt = params.negative_prompt;
    if (params.cfg_scale !== undefined) body.cfg_scale = params.cfg_scale;
  }

  const jwtToken = await generateKlingJWT(KLING_ACCESS_KEY_ID, KLING_SECRET_KEY);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  const message = String(result?.message ?? "Kling API error");
  if (!res.ok || result?.code !== 0) {
    if (/account balance not enough|insufficient balance|quota exceeded|billing/i.test(message)) throw new Error("PROVIDER_BILLING_ERROR");
    throw new Error(message || "Kling API error");
  }
  return { task_id: result?.data?.task_id, output_type: "video_url", provider_meta: { model: modelSlug, mode: initialMode, aspect_ratio: resolvedAspect } };
}

/* ─── Gemini Image Model Config ─── */
const GEMINI_IMAGE_MODELS: Record<string, { gemini_model: string }> = {
  "nano-banana-pro": { gemini_model: "gemini-3-pro-image-preview" },
  "nano-banana-2":   { gemini_model: "gemini-3.1-flash-image-preview" },
};

async function executeBanana(params: Record<string, unknown>, supabase: ReturnType<typeof createClient>): Promise<ProviderResult> {
  const GOOGLE_AI_STUDIO_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  if (!GOOGLE_AI_STUDIO_KEY) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");

  const rawModel = String(params.model_name ?? params.model ?? "nano-banana-pro");
  const modelId = BANANA_MODEL_MAP[rawModel] ?? rawModel;
  const modelConfig = GEMINI_IMAGE_MODELS[modelId];
  if (!modelConfig) throw new Error(`Unknown Banana model: ${modelId}. Available: ${Object.keys(GEMINI_IMAGE_MODELS).join(", ")}`);

  const prompt = String(params.prompt ?? "");
  const aspectRatio = String(params.aspect_ratio ?? "Auto");
  const imageUrl = params.image_url as string | undefined;
  const mentionImageUrls = params.mention_image_urls as string[] | undefined;
  if (!prompt) throw new Error("A prompt is required.");

  // Build Gemini API request parts
  const parts: Array<Record<string, unknown>> = [];
  parts.push({ text: prompt });

  // Resolve reference images to base64 inline data
  const imageUrls: string[] = mentionImageUrls ?? (imageUrl ? [imageUrl] : []);
  if (imageUrls.length > 0) {
    for (const url of imageUrls) {
      try {
        const bytes = await fetchImageBuffer(url);
        const base64 = bytesToBase64(bytes);
        let mime = "image/png";
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) mime = "image/jpeg";
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) mime = "image/webp";
        parts.push({ inlineData: { mimeType: mime, data: base64 } });
      } catch (imgErr) {
        console.warn(`[banana-direct] Failed to resolve image: ${imgErr}`);
      }
    }
    console.log(`[banana-direct] Added ${imageUrls.length} reference images`);
  }

  console.log(`[banana-direct] Requesting ${modelId} (${modelConfig.gemini_model}), ref_images: ${imageUrls.length}`);

  // Build generationConfig
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (aspectRatio && aspectRatio !== "Auto") {
    generationConfig.imageConfig = { aspectRatio };
  }
  const geminiRequestBody = JSON.stringify({ contents: [{ parts }], generationConfig });

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.gemini_model}:generateContent?key=${GOOGLE_AI_STUDIO_KEY}`;
  console.log(`[banana-direct] Calling model: ${modelConfig.gemini_model}`);

  const aiResponse = await fetchWithTimeout(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Server-Timeout": "280" },
    body: geminiRequestBody,
  }, 300_000);

  if (!aiResponse.ok) {
    const statusCode = aiResponse.status;
    const errorText = await aiResponse.text();
    console.error(`[banana-direct] Gemini API error: ${statusCode}`, errorText.substring(0, 500));
    if (statusCode === 429 || (statusCode < 500 && /billing|quota|exceeded|resource exhausted/i.test(errorText))) throw new Error("PROVIDER_BILLING_ERROR");
    if (statusCode >= 500) throw new Error(`Gemini ขัดข้องชั่วคราว (HTTP ${statusCode}) กรุณาลองใหม่ในอีกสักครู่`);
    const modelLabel = modelId === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2";
    throw new Error(`${modelLabel} failed (HTTP ${statusCode}). Please try again.`);
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
  const ext = imageMime.split("/")[1] || "png";
  const fileName = `pipeline/mediaforge_${Date.now()}.${ext}`;
  const binaryData = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
  let publicUrl = `data:${imageMime};base64,${imageBase64}`;

  const { error: uploadError } = await supabase.storage
    .from("ai-media").upload(fileName, binaryData, { contentType: imageMime, upsert: true });

  if (uploadError) {
    console.error("[banana-direct] Upload error:", uploadError);
  } else {
    const { data: urlData, error: signError } = await supabase.storage
      .from("ai-media").createSignedUrl(fileName, 60 * 60 * 24 * 7);
    if (!signError && urlData?.signedUrl) publicUrl = urlData.signedUrl;
    else {
      const { data: pubData } = supabase.storage.from("ai-media").getPublicUrl(fileName);
      publicUrl = pubData.publicUrl;
    }
  }

  return { result_url: publicUrl, output_type: "image_url", provider_meta: { model: modelId } };
}

async function executeChatAi(params: Record<string, unknown>): Promise<ProviderResult> {
  const model = String(params.model_name ?? "google/gemini-3.1-pro-preview");
  const systemPrompt = String(params.system_prompt ?? "You are a helpful AI assistant.");
  const userPrompt = String(params.prompt ?? "");
  const temperature = Number(params.temperature ?? 0.7);
  const maxTokens = parseInt(String(params.max_tokens ?? "1024"), 10);
  const context = params.context_text as string | undefined;
  if (!userPrompt && !context) throw new Error("Prompt is required");

  const messages: Array<{ role: string; content: string }> = [{ role: "system", content: systemPrompt }];
  if (context) messages.push({ role: "user", content: `Context:\n${context}\n\n${userPrompt}` });
  else messages.push({ role: "user", content: userPrompt });

  let content: string;
  if (model.startsWith("google/")) {
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
    if (!GOOGLE_KEY) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");
    const geminiModel = model.replace("google/", "");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GOOGLE_KEY}`;
    const geminiContents = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }],
    }));
    const res = await fetch(geminiUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] }, contents: geminiContents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 || (res.status < 500 && /billing|quota|exceeded|resource exhausted/i.test(errText))) throw new Error("PROVIDER_BILLING_ERROR");
      throw new Error(`Google AI API error (${res.status})`);
    }
    const data = await res.json();
    content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } else if (model.startsWith("openai/")) {
    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not configured");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: model.replace("openai/", ""), messages, temperature, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429 || res.status === 402 || /billing|quota|insufficient_quota|rate limit/i.test(errText)) throw new Error("PROVIDER_BILLING_ERROR");
      throw new Error(`OpenAI API error (${res.status})`);
    }
    const data = await res.json();
    content = data.choices?.[0]?.message?.content ?? "";
  } else throw new Error(`Unsupported model: ${model}`);

  return { result_url: content, output_type: "text", provider_meta: { model } };
}

/**
 * executeRemoveBg — proxies to remove-background edge function (Replicate BiRefNet).
 */
/**
 * executeMergeAudio — proxies to merge-audio-video edge fn (Shotstack).
 * Synchronous from the dispatcher's POV: the sub-function blocks until render is done.
 */
async function executeMergeAudio(params: Record<string, unknown>): Promise<ProviderResult> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const videoUrl = String(params.video_url ?? "");
  const audioUrl = String(params.audio_url ?? "");
  if (!videoUrl) throw new Error("Merge Audio requires a video input.");
  if (!audioUrl) throw new Error("Merge Audio requires an audio input.");

  const res = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/merge-audio-video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({
      video_url: videoUrl,
      audio_url: audioUrl,
      audio_mode: params.audio_mode ?? "replace",
      audio_volume: params.audio_volume ?? 1,
    }),
  }, 360_000); // 6 min — Shotstack render can take up to 5 min

  const json = await res.json();
  if (!res.ok) {
    const errMsg = String(json?.error || `merge-audio-video failed (${res.status})`);
    if (errMsg === "PROVIDER_BILLING_ERROR") throw new Error("PROVIDER_BILLING_ERROR");
    throw new Error(errMsg);
  }

  const url = String(json.result_url ?? json.outputs?.output_video ?? "");
  if (!url) throw new Error("merge-audio-video returned no URL");

  return {
    result_url: url,
    output_type: "video_url" as const,
    provider_meta: json.provider_meta ?? { provider: "shotstack" },
  };
}

async function executeRemoveBg(params: Record<string, unknown>): Promise<ProviderResult> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const imageUrl = String(params.image_url ?? "");
  if (!imageUrl) throw new Error("Remove Background requires an image input.");

  const res = await fetchWithTimeout(`${supabaseUrl}/functions/v1/remove-background`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({ image_url: imageUrl }),
  }, 120_000);

  const json = await res.json();
  if (!res.ok) {
    const errMsg = String(json?.error || `remove-background failed (${res.status})`);
    if (errMsg === "PROVIDER_BILLING_ERROR") throw new Error("PROVIDER_BILLING_ERROR");
    throw new Error(errMsg);
  }

  const url = String(json.result_url ?? json.outputs?.output_image ?? "");
  if (!url) throw new Error("remove-background returned no URL");

  return {
    result_url: url,
    output_type: "image_url" as const,
    provider_meta: json.provider_meta ?? { model: "replicate-birefnet" },
  };
}

/* ═══════════════════════════════════════════════════════════
   Pipeline Helpers
   ═══════════════════════════════════════════════════════════ */

/**
 * Returns sorted action nodes + a per-node-id "level" map.
 * Level grouping = nodes sharing the same level have NO dependency between them
 * and CAN run in parallel.  Level N depends only on nodes from levels < N.
 */
function getActionPipeline(
  graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }>,
  graphEdges: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>,
): {
  sorted: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  levelByNodeId: Record<string, number>;
} {
  const actionNodes = graphNodes.filter((n) => NODE_TYPE_REGISTRY[n.type]);
  if (actionNodes.length === 0) return { sorted: [], levelByNodeId: {} };
  if (actionNodes.length === 1) {
    return { sorted: actionNodes, levelByNodeId: { [actionNodes[0].id]: 0 } };
  }

  const actionNodeIds = new Set(actionNodes.map((n) => n.id));
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  for (const n of actionNodes) { inDegree[n.id] = 0; adj[n.id] = []; }

  for (const edge of graphEdges) {
    const srcAction = findUpstreamActionNode(edge.source, graphNodes, graphEdges, actionNodeIds);
    const tgtAction = findDownstreamActionNode(edge.target, graphNodes, graphEdges, actionNodeIds);
    if (srcAction && tgtAction && srcAction !== tgtAction) {
      if (!adj[srcAction].includes(tgtAction)) { adj[srcAction].push(tgtAction); inDegree[tgtAction]++; }
    }
  }
  for (const edge of graphEdges) {
    if (actionNodeIds.has(edge.source) && actionNodeIds.has(edge.target)) {
      if (!adj[edge.source].includes(edge.target)) { adj[edge.source].push(edge.target); inDegree[edge.target]++; }
    }
  }

  // Kahn's algorithm with level tracking (BFS layers)
  const levelByNodeId: Record<string, number> = {};
  let currentLevel: string[] = Object.keys(inDegree).filter((id) => inDegree[id] === 0);
  for (const id of currentLevel) levelByNodeId[id] = 0;

  const sorted: string[] = [];
  let level = 0;
  while (currentLevel.length > 0) {
    sorted.push(...currentLevel);
    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      for (const next of adj[nodeId] || []) {
        inDegree[next]--;
        if (inDegree[next] === 0) {
          levelByNodeId[next] = level + 1;
          nextLevel.push(next);
        }
      }
    }
    currentLevel = nextLevel;
    level++;
  }

  console.log(`[level-grouping] ${actionNodes.length} nodes across ${level} level(s):`,
    Object.entries(levelByNodeId).map(([id, lvl]) => `${id}=L${lvl}`).join(", "));

  return {
    sorted: sorted.map((id) => actionNodes.find((n) => n.id === id)!).filter(Boolean),
    levelByNodeId,
  };
}

function findUpstreamActionNode(
  nodeId: string, nodes: Array<{ id: string; type: string }>,
  edges: Array<{ source: string; target: string }>, actionNodeIds: Set<string>, visited = new Set<string>(),
): string | null {
  if (visited.has(nodeId)) return null; visited.add(nodeId);
  if (actionNodeIds.has(nodeId)) return nodeId;
  for (const edge of edges) {
    if (edge.target === nodeId) { const found = findUpstreamActionNode(edge.source, nodes, edges, actionNodeIds, visited); if (found) return found; }
  }
  return null;
}

function findDownstreamActionNode(
  nodeId: string, nodes: Array<{ id: string; type: string }>,
  edges: Array<{ source: string; target: string }>, actionNodeIds: Set<string>, visited = new Set<string>(),
): string | null {
  if (visited.has(nodeId)) return null; visited.add(nodeId);
  if (actionNodeIds.has(nodeId)) return nodeId;
  for (const edge of edges) {
    if (edge.source === nodeId) { const found = findDownstreamActionNode(edge.target, nodes, edges, actionNodeIds, visited); if (found) return found; }
  }
  return null;
}

/**
 * Build step definitions for the pipeline, including input_edges for dynamic mapping.
 * Each step's input_edges describe where its inputs come from (other action nodes or input nodes).
 */
function buildPipelineSteps(
  pipeline: Array<{ id: string; type: string; data: Record<string, unknown> }>,
  graphNodes: Array<{ id: string; type: string; data: Record<string, unknown> }>,
  graphEdges: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>,
  allNodeParams: Record<string, Record<string, unknown>> | undefined,
  defaultParams: Record<string, unknown>,
  levelByNodeId: Record<string, number>,
) {
  const actionNodeIds = new Set(pipeline.map(n => n.id));

  return pipeline.map((pipeNode, index) => {
    const providerDef = NODE_TYPE_REGISTRY[pipeNode.type]!;

    // Build params for this step
    let stepParams: Record<string, unknown>;
    if (providerDef.provider === "mp3_input") {
      const nodeData = (pipeNode.data as Record<string, unknown> | undefined) ?? {};
      const previewUrl = String(nodeData.previewUrl ?? nodeData.uploadedUrl ?? "");
      stepParams = {
        ...(nodeData.params as Record<string, unknown> ?? {}),
        ...(allNodeParams?.[pipeNode.id] ?? {}),
        previewUrl,
        audio_url: previewUrl,
        storagePath: nodeData.storagePath,
        fileName: nodeData.fileName,
      };
    } else if (allNodeParams && allNodeParams[pipeNode.id]) {
      stepParams = { ...allNodeParams[pipeNode.id] };
    } else if (index === 0) {
      stepParams = { ...defaultParams };
    } else {
      stepParams = { ...(pipeNode.data?.params as Record<string, unknown> ?? {}) };
    }

    // Find ALL edges targeting this node — these define its inputs
    const inputEdges: Array<{ source_node_id: string; target_handle: string; source_handle: string }> = [];
    for (const edge of graphEdges) {
      if (edge.target === pipeNode.id) {
        inputEdges.push({
          source_node_id: edge.source,
          target_handle: edge.targetHandle || "",
          source_handle: edge.sourceHandle || "",
        });
      }
      // Also check edges that pass through intermediate nodes (input/output nodes)
      // to reach this action node
      if (!actionNodeIds.has(edge.target) && edge.target !== pipeNode.id) {
        // Check if this non-action node connects to our pipe node
        const forwardEdges = graphEdges.filter(e2 => e2.source === edge.target && e2.target === pipeNode.id);
        for (const fwd of forwardEdges) {
          inputEdges.push({
            source_node_id: edge.source,
            target_handle: fwd.targetHandle || edge.targetHandle || "",
            source_handle: edge.sourceHandle || "",
          });
        }
      }
    }

    return {
      node_id: pipeNode.id,
      node_type: pipeNode.type,
      provider: providerDef.provider,
      is_async: providerDef.is_async,
      output_type: providerDef.output_type,
      params: stepParams,
      input_edges: inputEdges,
      level: levelByNodeId[pipeNode.id] ?? 0,
    };
  });
}

/* ═══════════════════════════════════════════════════════════
   Main Dispatcher
   ═══════════════════════════════════════════════════════════ */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const orgBlock = await rejectIfOrgUser(req);
  if (orgBlock) return orgBlock;

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      flow_id, node_type, params: rawParams = {}, graph_nodes,
      graph_edges, input_urls, all_node_params, run_id: client_run_id,
    } = body as {
      flow_id: string;
      run_id?: string;
      node_type: string;
      params: Record<string, unknown>;
      graph_nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }>;
      graph_edges?: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
      input_urls?: Record<string, string>;
      all_node_params?: Record<string, Record<string, unknown>>;
    };

    // Declare providerDef + providerKey early so mention resolver & edge mapping can use them
    const providerDef: ProviderDef | undefined = NODE_TYPE_REGISTRY[node_type];
    const providerKey: ProviderKey = providerDef?.provider ?? "banana";

    // Resolve @mentions and #variables in params (provider-aware)
    const params: Record<string, unknown> = {};
    const allMentionedImageUrls: string[] = [];
    for (const [key, val] of Object.entries(rawParams)) {
      let resolved: unknown = val;

      // 1) Resolve @[Label](nodeId) media mentions
      if (typeof resolved === "string" && resolved.includes("@[")) {
        const { resolvedPrompt, mentionedImageUrls } = await resolveMentionsInPrompt(resolved, graph_nodes, supabase, providerKey);
        resolved = resolvedPrompt;
        allMentionedImageUrls.push(...mentionedImageUrls);
      }

      // 2) Resolve #[Label](nodeId) text variables via direct string replacement
      if (typeof resolved === "string" && resolved.includes("#[")) {
        resolved = resolveTextVariablesInPrompt(resolved, graph_nodes);
      }

      params[key] = resolved;
    }

    // ─── Resolve input_urls for single-node path WITH multi-image aggregation ───
    // Collect ALL edge-mapped image URLs before assigning to params
    const edgeImageUrls: string[] = [];
    if (input_urls && graph_edges && Object.keys(input_urls).length > 0) {
      for (const [inputNodeId, uploadedUrl] of Object.entries(input_urls)) {
        if (!uploadedUrl) continue;
        const outEdges = graph_edges.filter((e) => e.source === inputNodeId);
        for (const edge of outEdges) {
          const handle = edge.targetHandle || edge.sourceHandle || "";
          if (handle) {
            const internalKey = normalizeHandleForSingleNode(providerKey, handle) || handle;
            // For image_url: collect ALL into array, don't skip duplicates
            if (internalKey === "image_url") {
              edgeImageUrls.push(uploadedUrl);
              // Only set params.image_url to the FIRST one (primary ref)
              if (!params[internalKey]) {
                params[internalKey] = uploadedUrl;
              }
              console.log(`[dispatcher] input_urls: collected ${inputNodeId} → ${handle} → ${internalKey} (provider=${providerKey})`);
            } else if (!params[internalKey]) {
              params[internalKey] = uploadedUrl;
              console.log(`[dispatcher] input_urls: mapped ${inputNodeId} → ${handle} → ${internalKey} (provider=${providerKey})`);
            }
          } else if (!params.image_url) {
            const inputNode = graph_nodes?.find((n) => n.id === inputNodeId);
            const fieldType = inputNode?.data?.fieldType as string | undefined;
            if (fieldType === "video") { if (!params.video_url) params.video_url = uploadedUrl; }
            else { params.image_url = uploadedUrl; edgeImageUrls.push(uploadedUrl); }
          }
        }
      }
    }

    // Merge mention images + edge images into a single deduplicated array
    const allImageUrls = [...new Set([...allMentionedImageUrls, ...edgeImageUrls])];
    if (allImageUrls.length > 0) {
      if (!params.image_url) params.image_url = allImageUrls[0];
      params.mention_image_urls = allImageUrls;
      console.log(`[dispatcher] Total aggregated images: ${allImageUrls.length} (mentions=${allMentionedImageUrls.length}, edges=${edgeImageUrls.length})`);
    }

    // simulate_failure only for admins

    let simulate_failure = false;
    if (body.simulate_failure === true) {
      const { data: adminRole } = await supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
      simulate_failure = !!adminRole;
    }

    if (!flow_id) {
      return new Response(JSON.stringify({ error: "flow_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Determine execution pipeline (with level grouping) ───
    const { sorted: pipeline, levelByNodeId } = (graph_nodes && graph_edges)
      ? getActionPipeline(graph_nodes, graph_edges)
      : { sorted: [] as Array<{ id: string; type: string; data: Record<string, unknown> }>, levelByNodeId: {} as Record<string, number> };
    const isMultiNode = pipeline.length > 1;

    console.log(`[dispatcher] Pipeline: ${pipeline.map((n) => `${n.type}(${n.id})[L${levelByNodeId[n.id]}]`).join(" → ")} | multi=${isMultiNode}`);
    if (!providerDef && !isMultiNode) {
      return new Response(JSON.stringify({ error: `Unsupported node type: ${node_type}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Fetch flow ───
    const { data: flow, error: flowErr } = await supabase
      .from("flows")
      .select("name, current_version, user_id, base_cost, markup_multiplier, is_official")
      .eq("id", flow_id).maybeSingle();
    if (flowErr || !flow) {
      return new Response(JSON.stringify({ error: "Flow not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const isOwner = user.id === flow.user_id;
    const markupMultiplier = Number(flow.markup_multiplier) || 4.0;
    const isOfficial = !!flow.is_official;

    // ─── Subscription discount ───
    let discountPercent = 0;
    if (!isOwner) {
      const { data: profile } = await supabase.from("profiles").select("subscription_plan_id").eq("user_id", user.id).maybeSingle();
      if (profile?.subscription_plan_id) {
        const { data: plan } = await supabase.from("subscription_plans").select("discount_official, discount_community").eq("id", profile.subscription_plan_id).maybeSingle();
        if (plan) discountPercent = isOfficial ? Number(plan.discount_official) || 0 : Number(plan.discount_community) || 0;
      }
    }

    // ═══════════════════════════════════════════════════════════
    // POINT 1 FIX: Calculate TOTAL cost across ALL action nodes
    // with per-feature multipliers from platform settings
    // ═══════════════════════════════════════════════════════════
    const featureMultipliers = await fetchFeatureMultipliers(supabase);

    let totalBaseCost: number;
    let totalWeightedPrice = 0;
    const perNodeCosts: Array<{ node_id: string; node_type: string; cost: number }> = [];

    const getNodeMultiplier = (nodeType: string): number => {
      const def = NODE_TYPE_REGISTRY[nodeType];
      if (!def) return markupMultiplier;
      switch (def.provider) {
        case "banana": return featureMultipliers.image;
        case "kling": return featureMultipliers.video;
        case "chat_ai": return featureMultipliers.chat;
        case "remove_bg": return featureMultipliers.image;
        case "merge_audio": return featureMultipliers.video;
        case "mp3_input": return 1.0;
        default: return markupMultiplier;
      }
    };

    if (isMultiNode) {
      totalBaseCost = 0;
      for (const pipeNode of pipeline) {
        const nodeProviderDef = NODE_TYPE_REGISTRY[pipeNode.type];
        if (!nodeProviderDef) continue;
        const nodeParams = all_node_params?.[pipeNode.id] ?? (pipeNode.data?.params as Record<string, unknown> ?? {});
        const nodeCost = await lookupBaseCost(supabase, nodeProviderDef, nodeParams);
        totalBaseCost += nodeCost;
        totalWeightedPrice += Math.ceil(nodeCost * getNodeMultiplier(pipeNode.type));
        perNodeCosts.push({ node_id: pipeNode.id, node_type: pipeNode.type, cost: nodeCost });
        console.log(`[dispatcher] Node cost: ${pipeNode.type}(${pipeNode.id}) = ${nodeCost}`);
      }
      console.log(`[dispatcher] Total pipeline base cost: ${totalBaseCost} (${perNodeCosts.length} nodes)`);
    } else {
      totalBaseCost = await lookupBaseCost(supabase, providerDef!, params);
      totalWeightedPrice = Math.ceil(totalBaseCost * getNodeMultiplier(node_type));
      perNodeCosts.push({ node_id: node_type, node_type, cost: totalBaseCost });
    }

    // ─── Pricing uses effective multiplier from per-feature weights ───
    const effectiveMultiplier = totalBaseCost > 0 ? totalWeightedPrice / totalBaseCost : markupMultiplier;
    const pricing = calculatePricing(totalBaseCost, effectiveMultiplier, isOwner, discountPercent);
    console.log(`[dispatcher] total_base=${totalBaseCost} | deduction=${pricing.deduction} | type=${pricing.transaction_type} | rev_share=${pricing.rev_share_amount}`);

    // ─── Deduct credits ───
    const deductResult = await deductCredits(
      supabase, user.id, pricing.deduction,
      `Flow: pipeline generation (${pricing.transaction_type})`, flow_id,
      pricing.transaction_type,
    );
    if (!deductResult.success) {
      return new Response(
        JSON.stringify({ error: "Insufficient credits", required: pricing.deduction, balance: deductResult.balance }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ─── Simulate failure ───
    if (simulate_failure) {
      await refundCreditsAtomic(supabase, user.id, pricing.deduction, `Refund: simulated API failure (debug mode)`, flow_id);
      const { data: simRun } = await supabase.from("flow_runs").insert({
        ...(client_run_id ? { id: client_run_id } : {}),
        flow_id, user_id: user.id, inputs: body, status: "failed_refunded",
        version: flow.current_version ?? 1, credits_used: pricing.deduction,
        outputs: { simulated: true, credit_cost: pricing.deduction, pricing },
        error_message: "Simulated API failure (debug mode)", completed_at: new Date().toISOString(),
      }).select("id").single();
      return new Response(
        JSON.stringify({
          run_id: simRun?.id, status: "failed_refunded", credit_cost: pricing.deduction,
          error: "Simulated API failure (debug mode)", refunded: true, simulated: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ═══════════════════════════════════════════════════════════
    // POINT 2 FIX: Multi-node → return immediately, frontend drives steps
    // ═══════════════════════════════════════════════════════════

    if (isMultiNode) {
      // Build step definitions with dynamic edge data + level grouping
      const pipelineSteps = buildPipelineSteps(pipeline, graph_nodes!, graph_edges!, all_node_params, params, levelByNodeId);

      // Compute level → step_indices map for parallel execution
      const totalLevels = pipelineSteps.reduce((max, s) => Math.max(max, s.level), 0) + 1;
      const stepsByLevel: Array<number[]> = Array.from({ length: totalLevels }, () => []);
      pipelineSteps.forEach((s, idx) => stepsByLevel[s.level].push(idx));

      console.log(`[dispatcher] Pipeline grouped into ${totalLevels} level(s):`,
        stepsByLevel.map((arr, lvl) => `L${lvl}=[${arr.join(",")}]`).join(" → "));

      // Create flow_run record first
      const { data: run } = await supabase.from("flow_runs").insert({
        ...(client_run_id ? { id: client_run_id } : {}),
        flow_id, user_id: user.id, inputs: body, status: "running",
        version: flow.current_version ?? 1, credits_used: pricing.deduction,
        outputs: { pipeline_steps: pipeline.map(n => n.type), credit_cost: pricing.deduction, per_node_costs: perNodeCosts },
      }).select("id").single();

      // Build per-node-cost lookup keyed by node_id (for partial refunds)
      const perNodeCostMap: Record<string, number> = {};
      for (const c of perNodeCosts) {
        // perNodeCosts entries from multi-node use node.id; single-node uses node_type fallback
        perNodeCostMap[c.node_id] = Math.ceil(c.cost * getNodeMultiplier(c.node_type));
      }

      // Create pipeline_execution record
      const { data: execution } = await supabase.from("pipeline_executions").insert({
        flow_id,
        flow_run_id: run?.id,
        user_id: user.id,
        status: "pending",
        total_steps: pipelineSteps.length,
        current_step: 0,
        steps: pipelineSteps,
        step_results: [],
        credits_deducted: pricing.deduction,
        pricing_info: {
          pricing,
          per_node_costs: perNodeCosts,
          per_node_cost_map: perNodeCostMap, // weighted price per node for partial refunds
          input_urls: input_urls || {},
          graph_nodes: graph_nodes,
          steps_by_level: stepsByLevel,
          total_levels: totalLevels,
        },
      }).select("id").single();

      // RevShare
      if (pricing.rev_share_amount > 0 && !isOwner) {
        await creditRevShare(supabase, flow.user_id, pricing.rev_share_amount, flow.name ?? "Untitled Flow", flow_id);
      }

      console.log(`[dispatcher] Multi-node pipeline created: execution_id=${execution?.id}, steps=${pipelineSteps.length}`);

      // Return immediately — frontend will call execute-pipeline-step per level
      return new Response(
        JSON.stringify({
          run_id: run?.id,
          execution_id: execution?.id,
          status: "pipeline_created",
          credit_cost: pricing.deduction,
          base_cost: totalBaseCost,
          per_node_costs: perNodeCosts,
          per_node_cost_map: perNodeCostMap,
          transaction_type: pricing.transaction_type,
          rev_share: pricing.rev_share_amount,
          total_steps: pipelineSteps.length,
          total_levels: totalLevels,
          steps_by_level: stepsByLevel,
          pipeline: pipelineSteps.map((s, i) => ({
            step: i,
            node_id: s.node_id,
            node_type: s.node_type,
            provider: s.provider,
            is_async: s.is_async,
            output_type: s.output_type,
            level: s.level,
          })),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ═══════════════════════════════════════════════════════════
    // SINGLE NODE — Pre-insert flow_run + Retry Loop
    // ═══════════════════════════════════════════════════════════

    // PRE-INSERT: Create flow_run with "processing" status BEFORE API call
    // This eliminates "ghost flows" where credits are deducted but no DB record exists
    const preInsertOutputs: Record<string, unknown> = {
      provider: providerDef!.provider, output_type: providerDef!.output_type,
      credit_cost: pricing.deduction, base_cost: totalBaseCost,
      transaction_type: pricing.transaction_type, rev_share: pricing.rev_share_amount,
    };
    const { data: run, error: preInsertErr } = await supabase.from("flow_runs").insert({
      ...(client_run_id ? { id: client_run_id } : {}),
      flow_id, user_id: user.id, inputs: body, status: "processing",
      version: flow.current_version ?? 1, credits_used: pricing.deduction,
      outputs: preInsertOutputs,
    }).select("id").single();

    if (preInsertErr) {
      console.error(`[dispatcher] PRE-INSERT FAILED for client_run_id=${client_run_id ?? "(none)"}:`, JSON.stringify(preInsertErr));
      // Refund credits since we deducted them but cannot create a tracking row.
      try {
        await refundCreditsAtomic(supabase, user.id, pricing.deduction, `Refund: pre-insert failed - ${preInsertErr.message}`, flow_id);
      } catch (refundErr) {
        console.error(`[dispatcher] Refund after pre-insert failure also failed:`, refundErr);
      }
      return new Response(
        JSON.stringify({
          error: `Failed to create flow_run record: ${preInsertErr.message}`,
          refunded: true,
          handled: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const runId = run?.id;
    console.log(`[dispatcher] Pre-inserted flow_run ${runId} with status=processing (client_run_id=${client_run_id ?? "(none)"})`);

    const dispatchStartMs = Date.now();

    // ─── Unified Retry Strategy (12 + health probe + 6 extended) ───
    // See supabase/functions/_shared/providerRetry.ts for the full strategy.
    const executeWithRetry = async (): Promise<{ providerResult: ProviderResult | null; error: Error | null }> => {
      const runOnce = async (): Promise<ProviderResult> => {
        switch (providerDef!.provider) {
          case "kling":
          case "kling_extension":
          case "motion_control":
            return await executeKling(params, graph_nodes);
          case "banana":
            return await executeBanana(params, supabase);
          case "chat_ai":
            return await executeChatAi(params);
          case "remove_bg":
            return await executeRemoveBg(params);
          case "merge_audio":
            return await executeMergeAudio(params);
          case "mp3_input":
            // mp3_input is a pure source node — no work to do. Return the URL passthrough.
            return {
              result_url: String(params.audio_url ?? params.previewUrl ?? ""),
              output_type: "video_url" as const, // marked as media (consumed by downstream)
              provider_meta: { provider: "mp3_input", passthrough: true },
            };
          default:
            throw new Error(`No executor for provider: ${providerDef!.provider}`);
        }
      };
      const outcome = await executeWithUnifiedRetry<ProviderResult>(
        runOnce,
        () => defaultProbeProviderHealth(providerDef!.provider),
        `[dispatcher ${providerDef!.provider}]`,
      );
      console.log(
        `[dispatcher] retry outcome: classification=${outcome.classification}, attempts=${outcome.attempts}/${TOTAL_MAX_RETRIES}, ` +
        `enteredExtended=${outcome.enteredExtendedPhase}, probe=${outcome.health_probe ? JSON.stringify(outcome.health_probe) : "n/a"}`,
      );
      return { providerResult: outcome.result, error: outcome.error };
    };

    const finalizeRun = async (
      providerResult: ProviderResult | null,
      error: Error | null,
    ): Promise<{ status: string; result_url?: string | null; task_id?: string | null }> => {
      if (error || !providerResult) {
        const errMsg = error?.message || "Unknown error";
        const isProviderBilling = errMsg === "PROVIDER_BILLING_ERROR";
        // Use runId as reference so refund is linkable to flow_run for auditing.
        await refundCreditsAtomic(supabase, user.id, pricing.deduction, `Refund: ${providerDef!.provider} error - ${errMsg}`, runId || flow_id);
        if (runId) {
          await supabase.from("flow_runs").update({
            status: "failed_refunded",
            error_message: errMsg,
            completed_at: new Date().toISOString(),
          }).eq("id", runId);
        }
        await supabase.from("notifications").insert({
          user_id: user.id,
          type: "generation_failed",
          title: "Generation Failed",
          message: isProviderBilling
            ? "ขออภัย ระบบไม่สามารถดำเนินการได้ในขณะนี้ กรุณาลองใหม่อีกครั้งในภายหลัง"
            : `Flow "${flow.name}" generation failed: ${errMsg.substring(0, 100)}`,
          icon: "alert-circle",
          link: `/play/${flow_id}`,
          metadata: { flow_id, run_id: runId, refunded: true },
        });
        await logApiUsage(supabase, {
          user_id: user.id,
          endpoint: "run-flow-init",
          feature: `flow_run:${providerDef!.provider}`,
          model: String((params as Record<string,unknown>).model_name ?? (params as Record<string,unknown>).model ?? node_type),
          status: "error",
          credits_used: 0,
          credits_refunded: pricing.deduction,
          duration_ms: Date.now() - dispatchStartMs,
          error_message: errMsg.substring(0, 500),
          request_metadata: { flow_id, run_id: runId, node_type },
        });
        return { status: "failed_refunded" };
      }

      if (pricing.rev_share_amount > 0 && !isOwner) {
        await creditRevShare(supabase, flow.user_id, pricing.rev_share_amount, flow.name ?? "Untitled Flow", flow_id);
      }

      const isAsync = providerDef!.is_async && !!providerResult.task_id;
      const finalStatus = isAsync ? "running" : "completed";
      const finalOutputs: Record<string, unknown> = { ...preInsertOutputs, ...providerResult.provider_meta };
      if (isAsync) finalOutputs.task_id = providerResult.task_id;
      else finalOutputs.result_url = providerResult.result_url;

      if (runId) {
        await supabase.from("flow_runs").update({
          status: finalStatus,
          outputs: finalOutputs,
          ...(finalStatus === "completed" ? { completed_at: new Date().toISOString() } : {}),
        }).eq("id", runId);
      }

      await logApiUsage(supabase, {
        user_id: user.id,
        endpoint: "run-flow-init",
        feature: `flow_run:${providerDef!.provider}`,
        model: String((params as Record<string,unknown>).model_name ?? (params as Record<string,unknown>).model ?? node_type),
        status: "success",
        credits_used: pricing.deduction,
        duration_ms: Date.now() - dispatchStartMs,
        request_metadata: { flow_id, run_id: runId, node_type, output_type: providerResult.output_type, is_async: isAsync },
      });

      if (finalStatus === "completed" && providerResult.result_url) {
        try {
          const fileType = providerDef!.output_type === "video_url" ? "video"
            : providerDef!.output_type === "image_url" ? "image" : "audio";
          await supabase.from("user_assets").insert({
            user_id: user.id,
            name: `${fileType}-${Date.now()}`,
            file_url: providerResult.result_url,
            file_type: fileType,
            source: "workflow",
            category: "generated",
            metadata: { flow_id, flow_run_id: runId, provider: providerDef!.provider },
          });
        } catch (assetErr) {
          console.error("[dispatcher] user_assets insert failed (non-fatal):", assetErr);
        }
        await supabase.from("notifications").insert({
          user_id: user.id,
          type: "generation_complete",
          title: "Generation Complete ✨",
          message: `Flow "${flow.name}" finished successfully!`,
          icon: "sparkles",
          link: `/play/${flow_id}`,
          metadata: { flow_id, run_id: runId, result_url: providerResult.result_url },
        });
      }

      return { status: finalStatus, result_url: providerResult.result_url ?? null, task_id: providerResult.task_id ?? null };
    };

    // ROUTING: Kling = inline (fast async submit). Banana / chat_ai = background
    // via EdgeRuntime.waitUntil to dodge the 150s edge gateway timeout.
    const isBackgroundProvider =
      providerDef!.provider === "banana" || providerDef!.provider === "chat_ai";

    if (isBackgroundProvider) {
      const bgTask = (async () => {
        try {
          const { providerResult, error } = await executeWithRetry();
          await finalizeRun(providerResult, error);
        } catch (err) {
          console.error("[dispatcher][bg] Unhandled error:", err);
          try {
            await refundCreditsAtomic(supabase, user.id, pricing.deduction, "Refund: background task crash", runId || flow_id);
            if (runId) {
              await supabase.from("flow_runs").update({
                status: "failed_refunded",
                error_message: err instanceof Error ? err.message : String(err),
                completed_at: new Date().toISOString(),
              }).eq("id", runId);
            }
          } catch (_) { /* best-effort */ }
        }
      })();

      const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(bgTask);
      else bgTask.catch((e) => console.error("[dispatcher][bg-fallback]", e));

      console.log(`[dispatcher] Backgrounded ${providerDef!.provider} run ${runId} — frontend will poll flow_runs`);

      return new Response(
        JSON.stringify({
          run_id: runId,
          status: "processing",
          credit_cost: pricing.deduction,
          base_cost: totalBaseCost,
          transaction_type: pricing.transaction_type,
          rev_share: pricing.rev_share_amount,
          output_type: providerDef!.output_type,
          background: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Inline path (Kling: fast submit, returns task_id quickly)
    const { providerResult: inlineResult, error: inlineError } = await executeWithRetry();
    const finalized = await finalizeRun(inlineResult, inlineError);

    if (finalized.status === "failed_refunded") {
      return new Response(
        JSON.stringify({
          error: inlineError?.message || "Generation failed",
          refunded: true,
          run_id: runId,
          provider_billing: inlineError?.message === "PROVIDER_BILLING_ERROR",
          handled: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        run_id: runId,
        status: finalized.status,
        credit_cost: pricing.deduction,
        base_cost: totalBaseCost,
        transaction_type: pricing.transaction_type,
        rev_share: pricing.rev_share_amount,
        output_type: inlineResult!.output_type,
        task_id: finalized.task_id,
        result_url: finalized.result_url,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
    // (legacy duplicated path removed — handled by executeWithRetry/finalizeRun above)

  } catch (e) {
    console.error("[dispatcher] Top-level error:", e);
    // If we have a pre-inserted flow_run that's still "processing", clean it up
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabaseCleanup = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const errMsg = e instanceof Error ? e.message : "Internal server error";

      // Log the unhandled failure
      await logApiUsage(supabaseCleanup, {
        user_id: "system",
        endpoint: "run-flow-init",
        feature: "flow_run:unhandled_crash",
        status: "error",
        error_message: errMsg.substring(0, 500),
        request_metadata: { error_type: "top_level_catch" },
      });
    } catch (_) { /* best-effort */ }
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
