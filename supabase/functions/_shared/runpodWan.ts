/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderResult } from "./providerResult.ts";
import {
  WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS,
  workspaceAiMediaPipelinePath,
} from "./storageUrl.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const DEFAULT_WAN_MODEL = "wan2.1-vace-1.3b-runpod";

export function wanRunpodModelKey(params: Record<string, unknown>): string {
  return String(params.model_name ?? params.model ?? DEFAULT_WAN_MODEL).toLowerCase();
}

export function wanRunpodPriceKeys(params: Record<string, unknown>): string[] {
  const model = wanRunpodModelKey(params);
  const resolution = String(params.resolution ?? "480p").toLowerCase();
  return Array.from(new Set([`${model}:${resolution}`, model]));
}

function cleanWorkerBase(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:run|status(?:\/[^/]+)?)\/?$/i, "");
}

function workerBase(): string {
  const explicit = Deno.env.get("RUNPOD_WAN_WORKER_URL")?.trim();
  if (!explicit) throw new Error("RUNPOD_WAN_WORKER_URL is required");
  return cleanWorkerBase(explicit);
}

function workerToken(): string {
  return Deno.env.get("RUNPOD_WAN_WORKER_TOKEN")?.trim() ?? "";
}

function authHeaders(): HeadersInit {
  const token = workerToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function authHeadersForUrl(rawUrl: string, pollEndpoint?: string): HeadersInit {
  const token = workerToken();
  if (!token) return {};

  try {
    const target = new URL(rawUrl);
    const worker = new URL(workerBase());
    const poll = pollEndpoint ? new URL(pollEndpoint) : null;
    const isWorkerHost = target.hostname === worker.hostname;
    const isPollHost = poll ? target.hostname === poll.hostname : false;
    return isWorkerHost || isPollHost ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function firstString(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
  }
  return "";
}

function pickUrl(params: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = firstString(params[key]);
    if (value) return value;
  }
  return "";
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function buildInput(params: Record<string, unknown>): Record<string, unknown> {
  const sourceVideoUrl = pickUrl(params, [
    "source_video_url",
    "input_video",
    "video_url",
    "video",
    "ref_video",
    "reference_video_url",
  ]);
  const maskVideoUrl = pickUrl(params, [
    "mask_video_url",
    "mask_video",
    "src_mask",
    "mask",
  ]);
  const refImageUrl = pickUrl(params, [
    "ref_image_url",
    "reference_image_url",
    "ref_image",
    "start_image",
    "image_url",
  ]);

  if (!sourceVideoUrl) throw new Error("Wan VACE needs a source video input.");
  if (!maskVideoUrl) throw new Error("Wan VACE needs a mask video input.");
  if (!refImageUrl) throw new Error("Wan VACE needs a reference/start image input.");

  const resolution = String(params.resolution ?? "480p").toLowerCase();
  const width = Math.round(clampNumber(params.width ?? params.custom_width, resolution === "720p" ? 1280 : 832, 256, 1920));
  const height = Math.round(clampNumber(params.height ?? params.custom_height, resolution === "720p" ? 720 : 480, 256, 1080));
  const frameCap = Math.round(clampNumber(params.frame_load_cap ?? params.total_frames ?? params.num_frames, 240, 1, 300));
  const chunkFrames = Math.round(clampNumber(params.chunk_frames, Math.min(frameCap, 49), 1, frameCap));
  const fps = Math.round(clampNumber(params.fps ?? params.force_rate, 16, 1, 30));
  const seedRaw = Number(params.seed);
  const seed = Number.isFinite(seedRaw) && seedRaw >= 0
    ? Math.floor(seedRaw)
    : Math.floor(Math.random() * 2_147_483_647);

  return {
    workflow: "wan_vace_video_mask_reference",
    model: wanRunpodModelKey(params),
    source_video_url: sourceVideoUrl,
    mask_video_url: maskVideoUrl,
    ref_image_url: refImageUrl,
    prompt: String(params.prompt ?? "").trim(),
    negative_prompt: String(params.negative_prompt ?? "bad quality, blurry, distorted, flicker, inconsistent lighting, broken body, duplicated person").trim(),
    resolution,
    width,
    height,
    total_frames: frameCap,
    num_frames: frameCap,
    chunk_frames: chunkFrames,
    fps,
    force_rate: fps,
    skip_first_frames: Math.round(clampNumber(params.skip_first_frames, 0, 0, 600)),
    select_every_nth: Math.round(clampNumber(params.select_every_nth, 1, 1, 24)),
    steps: Math.round(clampNumber(params.steps, 20, 1, 60)),
    cfg: clampNumber(params.cfg ?? params.guidance_scale, 4, 0, 12),
    shift: clampNumber(params.shift, 8, 0, 16),
    seed,
    scheduler: String(params.scheduler ?? "unipc"),
    sampler: String(params.sampler_name ?? params.sampler ?? "unipc"),
    mask_channel: String(params.mask_channel ?? "red"),
    invert_mask:
      params.invert_mask === true ||
      String(params.invert_mask ?? "off").toLowerCase() === "on" ||
      String(params.mask_polarity ?? "").toLowerCase() === "black_edits",
    vace_strength: clampNumber(params.vace_strength, 0.35, 0, 2),
    vace_start_percent: clampNumber(params.vace_start_percent, 0, 0, 1),
    vace_end_percent: clampNumber(params.vace_end_percent, 1, 0, 1),
    crf: Math.round(clampNumber(params.crf, 19, 10, 35)),
    output_prefix: String(params.output_prefix ?? "mediaforge_wan_vace"),
  };
}

function findVideoCandidate(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed) || /^data:video\//i.test(trimmed) || /^\/outputs\//i.test(trimmed)) {
      return trimmed;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoCandidate(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of ["video_url", "url", "result_url", "output_video", "mp4", "video"]) {
    const found = findVideoCandidate(row[key], depth + 1);
    if (found) return found;
  }
  for (const key of ["videos", "outputs", "output", "data", "result"]) {
    const found = findVideoCandidate(row[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function absoluteCandidateUrl(candidate: string, pollEndpoint: string): string {
  if (/^https?:\/\//i.test(candidate) || /^data:video\//i.test(candidate)) return candidate;
  const base = new URL(pollEndpoint);
  return `${base.protocol}//${base.host}${candidate.startsWith("/") ? candidate : `/${candidate}`}`;
}

function normalizeStatus(raw: unknown, hasOutput: boolean): "succeed" | "failed" | "processing" {
  const status = String(raw ?? "").toUpperCase();
  if (hasOutput || ["COMPLETED", "SUCCEEDED", "SUCCESS", "DONE"].includes(status)) return "succeed";
  if (["FAILED", "CANCELLED", "CANCELED", "ERROR"].includes(status)) return "failed";
  return "processing";
}

function decodeVideoData(value: string): { bytes: Uint8Array; contentType: string; ext: string } | null {
  const dataUrl = value.match(/^data:(video\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!dataUrl) return null;
  const contentType = dataUrl[1] ?? "video/mp4";
  const binary = atob((dataUrl[2] ?? "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const ext = contentType.includes("webm") ? "webm" : "mp4";
  return { bytes, contentType, ext };
}

async function saveVideoCandidate(
  candidate: string,
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  pollEndpoint?: string,
): Promise<string> {
  const source = pollEndpoint ? absoluteCandidateUrl(candidate, pollEndpoint) : candidate;
  const decoded = decodeVideoData(source);
  const pathBase = workspaceAiMediaPipelinePath(userId, `wan_vace_${taskId}`);
  if (decoded) {
    const path = `${pathBase}.${decoded.ext}`;
    const upload = await supabase.storage
      .from("ai-media")
      .upload(path, decoded.bytes, { contentType: decoded.contentType, upsert: true });
    if (upload.error) throw upload.error;
    const signed = await supabase.storage
      .from("ai-media")
      .createSignedUrl(path, WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) throw signed.error ?? new Error("No signed URL for Wan output");
    return signed.data.signedUrl;
  }

  const response = await fetch(source, { headers: authHeadersForUrl(source, pollEndpoint) });
  if (!response.ok) throw new Error(`Wan video download failed HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
  const ext = contentType.includes("webm") ? "webm" : "mp4";
  const path = `${pathBase}.${ext}`;
  const body = response.body;
  if (!body) throw new Error("Wan video download response has no body");
  const upload = await supabase.storage
    .from("ai-media")
    .upload(path, body, { contentType, upsert: true });
  if (upload.error) throw upload.error;
  const signed = await supabase.storage
    .from("ai-media")
    .createSignedUrl(path, WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) throw signed.error ?? new Error("No signed URL for Wan output");
  return signed.data.signedUrl;
}

export async function executeRunpodWanVace(
  params: Record<string, unknown>,
  supabase: SupabaseClient,
  userId: string,
): Promise<ProviderResult> {
  const base = workerBase();
  const input = buildInput(params);
  const response = await fetch(`${base}/run`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) payload = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`RunPod Wan submit failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const taskId = String(payload.id ?? payload.job_id ?? payload.task_id ?? payload.request_id ?? "").trim();
  const candidate = findVideoCandidate(payload.output ?? payload.result ?? payload);
  const status = normalizeStatus(payload.status, Boolean(candidate));
  if (candidate && status === "succeed") {
    const url = await saveVideoCandidate(candidate, supabase, userId, taskId || `direct_${Date.now()}`, `${base}/status/${taskId}`);
    return {
      result_url: url,
      outputs: { video: url },
      output_type: "video_url",
      provider_meta: {
        provider: "runpod_wan_vace",
        status,
        workflow: input.workflow,
        model: input.model,
        output_type: "video_url",
      },
      output_count: 1,
    };
  }
  if (!taskId) throw new Error("RunPod Wan worker did not return a job id");

  return {
    task_id: taskId,
    outputs: {},
    output_type: "video_url",
    provider_meta: {
      provider: "runpod_wan_vace",
      poll_endpoint: `${base}/status/${taskId}`,
      workflow: input.workflow,
      model: input.model,
      output_type: "video_url",
    },
  };
}

export async function pollRunpodWanVaceOnce(args: {
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
    headers: authHeaders(),
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) payload = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok) {
    return {
      status: "polling_error",
      task_id: args.taskId,
      message: `RunPod Wan poll failed HTTP ${response.status}: ${text.slice(0, 300)}`,
    };
  }

  const candidate = findVideoCandidate(payload.output ?? payload.result ?? payload);
  const status = normalizeStatus(payload.status, Boolean(candidate));
  if (status === "failed") {
    return {
      status: "failed",
      task_id: args.taskId,
      url: "",
      message: String(payload.error ?? payload.message ?? "RunPod Wan task failed"),
    };
  }
  if (status === "succeed" && candidate) {
    const publicUrl = await saveVideoCandidate(candidate, args.supabase, args.userId, args.taskId, url);
    return {
      status: "succeed",
      task_id: args.taskId,
      url: publicUrl,
      outputs: { video: publicUrl },
      provider_meta: {
        provider: "runpod_wan_vace",
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
