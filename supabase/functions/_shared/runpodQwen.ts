/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderResult } from "./providerResult.ts";
import {
  WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS,
  workspaceAiMediaPipelinePath,
} from "./storageUrl.ts";

const RUNPOD_API_BASE = "https://api.runpod.ai/v2";
const DEFAULT_QWEN_IMAGE_MODEL = "qwen-image-runpod";
const DEFAULT_QWEN_EDIT_MODEL = "qwen-image-edit-2511-runpod";

const QWEN_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1328, height: 1328 },
  "16:9": { width: 1664, height: 928 },
  "9:16": { width: 928, height: 1664 },
  "4:3": { width: 1472, height: 1140 },
  "3:4": { width: 1140, height: 1472 },
  "3:2": { width: 1584, height: 1056 },
  "2:3": { width: 1056, height: 1584 },
};

type SupabaseClient = ReturnType<typeof createClient>;

export function qwenRunpodModelKey(params: Record<string, unknown>): string {
  const model = String(params.model_name ?? params.model ?? DEFAULT_QWEN_IMAGE_MODEL).toLowerCase();
  if (model.includes("edit")) return DEFAULT_QWEN_EDIT_MODEL;
  return DEFAULT_QWEN_IMAGE_MODEL;
}

export function qwenRunpodPriceKeys(params: Record<string, unknown>): string[] {
  const model = qwenRunpodModelKey(params);
  return Array.from(new Set([model, String(params.model_name ?? params.model ?? model).toLowerCase()]));
}

function cleanEndpointBase(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:run|runsync)\/?$/i, "")
    .replace(/\/status\/[^/]+$/i, "")
    .replace(/\/status\/?$/i, "");
}

function runpodEndpointBase(): string {
  const explicit = Deno.env.get("RUNPOD_QWEN_ENDPOINT_URL")?.trim();
  if (explicit) return cleanEndpointBase(explicit);

  const endpointId = Deno.env.get("RUNPOD_QWEN_ENDPOINT_ID")?.trim();
  if (!endpointId) {
    throw new Error("RUNPOD_QWEN_ENDPOINT_URL or RUNPOD_QWEN_ENDPOINT_ID is required");
  }
  return `${RUNPOD_API_BASE}/${endpointId}`;
}

function runpodApiKey(): string {
  const key = Deno.env.get("RUNPOD_QWEN_API_KEY")?.trim() ?? Deno.env.get("RUNPOD_API_KEY")?.trim();
  if (!key) throw new Error("RUNPOD_QWEN_API_KEY or RUNPOD_API_KEY is required");
  return key;
}

function workerToken(): string {
  return (
    Deno.env.get("RUNPOD_QWEN_WORKER_TOKEN")?.trim() ??
    Deno.env.get("RUNPOD_WAN_WORKER_TOKEN")?.trim() ??
    Deno.env.get("RUNPOD_WORKER_TOKEN")?.trim() ??
    ""
  );
}

function isRunpodApiUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname === "api.runpod.ai";
  } catch {
    return false;
  }
}

function endpointAuthHeaders(rawUrl: string): HeadersInit {
  if (isRunpodApiUrl(rawUrl)) {
    return { Authorization: `Bearer ${runpodApiKey()}` };
  }

  const token = workerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function collectImageUrls(params: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...asStringArray(params.image_url),
    ...asStringArray(params.ref_image),
    ...asStringArray(params.image_urls),
    ...asStringArray(params.mention_image_urls),
    ...asStringArray(params.reference_image_urls),
  ])).slice(0, 3);
}

function pickDimensions(params: Record<string, unknown>): { width: number; height: number; aspect_ratio: string } {
  const aspect = String(params.aspect_ratio ?? "1:1");
  const preset = QWEN_DIMENSIONS[aspect] ?? QWEN_DIMENSIONS["1:1"];
  const width = Number(params.width ?? params.custom_width ?? preset.width);
  const height = Number(params.height ?? params.custom_height ?? preset.height);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : preset.width,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : preset.height,
    aspect_ratio: aspect,
  };
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function workflowFor(params: Record<string, unknown>, imageUrls: string[]): "qwen_image" | "qwen_image_edit_2511" {
  const model = String(params.model_name ?? params.model ?? "").toLowerCase();
  const requested = String(params.workflow ?? params.mode ?? "").toLowerCase();
  if (requested.includes("edit") || model.includes("edit") || imageUrls.length > 0) {
    return "qwen_image_edit_2511";
  }
  return "qwen_image";
}

function buildInput(params: Record<string, unknown>): Record<string, unknown> {
  const imageUrls = collectImageUrls(params);
  const workflow = workflowFor(params, imageUrls);
  if (workflow === "qwen_image_edit_2511" && imageUrls.length === 0) {
    throw new Error("Qwen Image Edit needs at least one ref_image input");
  }
  const dims = pickDimensions(params);
  const defaultSteps = workflow === "qwen_image_edit_2511" ? 40 : 20;
  const steps = clampNumber(params.steps, defaultSteps, 1, 80);
  const cfg = clampNumber(params.cfg ?? params.guidance_scale, workflow === "qwen_image_edit_2511" ? 4 : 4, 0, 12);
  const seedRaw = Number(params.seed);
  const seed = Number.isFinite(seedRaw) && seedRaw >= 0
    ? Math.floor(seedRaw)
    : Math.floor(Math.random() * 2_147_483_647);

  return {
    workflow,
    model: qwenRunpodModelKey(params),
    prompt: String(params.prompt ?? "").trim(),
    negative_prompt: String(params.negative_prompt ?? "").trim(),
    image_urls: imageUrls,
    mask_image_url: String(params.mask_image_url ?? params.mask_url ?? "").trim() || null,
    width: dims.width,
    height: dims.height,
    aspect_ratio: dims.aspect_ratio,
    steps,
    cfg,
    seed,
    sampler_name: String(params.sampler_name ?? "euler"),
    scheduler: String(params.scheduler ?? "simple"),
    denoise: clampNumber(params.denoise, 1, 0, 1),
    lightning_lora: String(params.lightning_lora ?? "off") === "on",
    protect_original: String(params.protect_original ?? "on") !== "off",
    mask_expand: Math.round(clampNumber(params.mask_expand, 4, 0, 128)),
    mask_feather: Math.round(clampNumber(params.mask_feather, 12, 0, 128)),
    batch_size: clampNumber(params.batch_size, 1, 1, 4),
  };
}

function looksLikeBase64(value: string): boolean {
  const v = value.replace(/\s+/g, "");
  return v.length > 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}

function findImageCandidate(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed) || looksLikeBase64(trimmed)) {
      return trimmed;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageCandidate(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of ["image_url", "url", "result_url", "output_image", "b64_json", "base64", "image"]) {
    const found = findImageCandidate(row[key], depth + 1);
    if (found) return found;
  }
  for (const key of ["images", "outputs", "output", "data", "result"]) {
    const found = findImageCandidate(row[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function decodeImageData(value: string): { bytes: Uint8Array; contentType: string; ext: string } | null {
  const dataUrl = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  const contentType = dataUrl?.[1] ?? "image/png";
  const raw = (dataUrl?.[2] ?? value).replace(/\s+/g, "");
  if (!looksLikeBase64(raw)) return null;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
  return { bytes, contentType, ext };
}

async function saveImageCandidate(
  candidate: string,
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<string> {
  if (/^https?:\/\//i.test(candidate)) {
    const response = await fetch(candidate);
    if (!response.ok) throw new Error(`Qwen image download failed HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    const ext = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
    const path = workspaceAiMediaPipelinePath(userId, `qwen_${taskId}.${ext}`);
    const body = response.body;
    if (!body) throw new Error("Qwen image download response has no body");
    const upload = await supabase.storage
      .from("ai-media")
      .upload(path, body, { contentType, upsert: true });
    if (upload.error) throw upload.error;
    const signed = await supabase.storage
      .from("ai-media")
      .createSignedUrl(path, WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) throw signed.error ?? new Error("No signed URL for Qwen image");
    return signed.data.signedUrl;
  }

  const decoded = decodeImageData(candidate);
  if (!decoded) throw new Error("Qwen output did not contain a supported image URL or base64 image");
  const path = workspaceAiMediaPipelinePath(userId, `qwen_${taskId}.${decoded.ext}`);
  const upload = await supabase.storage
    .from("ai-media")
    .upload(path, decoded.bytes, { contentType: decoded.contentType, upsert: true });
  if (upload.error) throw upload.error;
  const signed = await supabase.storage
    .from("ai-media")
    .createSignedUrl(path, WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) throw signed.error ?? new Error("No signed URL for Qwen image");
  return signed.data.signedUrl;
}

function normalizeRunpodStatus(raw: unknown, hasOutput: boolean): "succeed" | "failed" | "processing" {
  const status = String(raw ?? "").toUpperCase();
  if (hasOutput || status === "COMPLETED" || status === "SUCCEEDED" || status === "SUCCESS") return "succeed";
  if (status === "FAILED" || status === "CANCELLED" || status === "CANCELED" || status === "ERROR") return "failed";
  return "processing";
}

export async function executeRunpodQwen(
  params: Record<string, unknown>,
  supabase: SupabaseClient,
  userId: string,
): Promise<ProviderResult> {
  const base = runpodEndpointBase();
  const input = buildInput(params);
  const response = await fetch(`${base}/run`, {
    method: "POST",
    headers: {
      ...endpointAuthHeaders(base),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) payload = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Runpod Qwen submit failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const taskId = String(payload.id ?? payload.job_id ?? payload.task_id ?? payload.request_id ?? "").trim();
  const candidate = findImageCandidate(payload.output ?? payload.result ?? payload);
  const status = normalizeRunpodStatus(payload.status, Boolean(candidate));
  if (candidate && status === "succeed") {
    const url = await saveImageCandidate(candidate, supabase, userId, taskId || `direct_${Date.now()}`);
    return {
      result_url: url,
      outputs: { image: url },
      output_type: "image_url",
      provider_meta: {
        provider: "runpod_qwen",
        status,
        workflow: input.workflow,
        model: input.model,
      },
      output_count: 1,
    };
  }
  if (!taskId) throw new Error("Runpod Qwen did not return a job id");

  return {
    task_id: taskId,
    outputs: {},
    output_type: "image_url",
    provider_meta: {
      provider: "runpod_qwen",
      poll_endpoint: `${base}/status/${taskId}`,
      workflow: input.workflow,
      model: input.model,
      output_type: "image_url",
    },
  };
}

export async function pollRunpodQwenOnce(args: {
  taskId: string;
  pollEndpoint: string;
  supabase: SupabaseClient;
  userId: string;
}): Promise<Record<string, unknown>> {
  const endpoint = args.pollEndpoint.replace(/\/+$/, "");
  const alreadyHasTask = endpoint.endsWith(`/${encodeURIComponent(args.taskId)}`) || endpoint.endsWith(`/${args.taskId}`);
  const url = alreadyHasTask ? endpoint : `${endpoint}/${encodeURIComponent(args.taskId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: endpointAuthHeaders(url),
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) payload = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok) {
    return {
      status: "polling_error",
      task_id: args.taskId,
      message: `Runpod Qwen poll failed HTTP ${response.status}: ${text.slice(0, 300)}`,
    };
  }

  const candidate = findImageCandidate(payload.output ?? payload.result ?? payload);
  const status = normalizeRunpodStatus(payload.status, Boolean(candidate));
  if (status === "failed") {
    return {
      status: "failed",
      task_id: args.taskId,
      url: "",
      message: String(payload.error ?? payload.message ?? "Runpod Qwen task failed"),
    };
  }
  if (status === "succeed" && candidate) {
    const publicUrl = await saveImageCandidate(candidate, args.supabase, args.userId, args.taskId);
    return {
      status: "succeed",
      task_id: args.taskId,
      url: publicUrl,
      outputs: { image: publicUrl },
      provider_meta: {
        provider: "runpod_qwen",
        original_status: payload.status ?? null,
      },
    };
  }
  return {
    status: "processing",
    task_id: args.taskId,
    url: "",
    message: String(payload.status ?? "processing"),
  };
}
