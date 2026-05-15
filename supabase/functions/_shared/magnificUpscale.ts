/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import type { ProviderResult } from "./providerResult.ts";
import { MAGNIFIC_BASE, loadMagnificApiKey } from "./magnific.ts";

export const MAGNIFIC_UPSCALE_MODEL = "magnific-upscale-precision-v2";
export const MAGNIFIC_UPSCALE_PATH = "/ai/image-upscaler-precision-v2";
export const MAGNIFIC_VIDEO_UPSCALE_PATH = "/ai/video-upscaler-precision";

const FLAVORS = new Set(["sublime", "photo", "photo_denoiser"]);
const UPSCALE_PRESETS = new Set(["balanced", "clean", "detail", "creative"]);
const VIDEO_RESOLUTIONS = new Set(["720p", "1k", "2k", "4k"]);

type UpscalePreset = "balanced" | "clean" | "detail" | "creative";
type ImageFlavor = "sublime" | "photo" | "photo_denoiser";

const IMAGE_PRESET_DEFAULTS: Record<
  UpscalePreset,
  { flavor: ImageFlavor; sharpen: number; smart_grain: number; ultra_detail: number }
> = {
  balanced: { flavor: "photo", sharpen: 7, smart_grain: 7, ultra_detail: 30 },
  clean: { flavor: "photo_denoiser", sharpen: 4, smart_grain: 0, ultra_detail: 18 },
  detail: { flavor: "photo", sharpen: 15, smart_grain: 8, ultra_detail: 55 },
  creative: { flavor: "sublime", sharpen: 8, smart_grain: 8, ultra_detail: 35 },
};

const VIDEO_PRESET_DEFAULTS: Record<
  UpscalePreset,
  { strength: number; sharpen: number; smart_grain: number }
> = {
  balanced: { strength: 60, sharpen: 0, smart_grain: 0 },
  clean: { strength: 45, sharpen: 0, smart_grain: 0 },
  detail: { strength: 75, sharpen: 12, smart_grain: 6 },
  creative: { strength: 60, sharpen: 0, smart_grain: 0 },
};

function authHeaderNameForEndpoint(endpoint: string): string {
  return new URL(endpoint).hostname.includes("magnific.com")
    ? "x-magnific-api-key"
    : "x-freepik-api-key";
}

function intParam(raw: unknown, min: number, max: number, fallback: number): number {
  const source = typeof raw === "string" ? raw.replace(/x$/i, "") : raw;
  const parsed = Number(source);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function boolParam(raw: unknown, fallback = false): boolean {
  if (raw === true || raw === false) return raw;
  if (raw === 1 || raw === "1") return true;
  if (raw === 0 || raw === "0") return false;
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) return true;
  if (["false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function presetParam(raw: unknown): UpscalePreset {
  const value = String(raw ?? "balanced").trim().toLowerCase();
  return UPSCALE_PRESETS.has(value) ? (value as UpscalePreset) : "balanced";
}

function flavorParam(raw: unknown): ImageFlavor {
  const value = String(raw ?? "photo").trim().toLowerCase();
  return FLAVORS.has(value) ? (value as ImageFlavor) : "photo";
}

function videoResolutionParam(raw: unknown): "720p" | "1k" | "2k" | "4k" {
  const value = String(raw ?? "2k").trim().toLowerCase();
  return VIDEO_RESOLUTIONS.has(value) ? (value as "720p" | "1k" | "2k" | "4k") : "2k";
}

function readTaskData(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload;
}

export async function executeMagnificUpscale(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const media = String(params.media ?? params.media_url ?? "").trim();
  const sourceContentType = String(
    params.source_content_type ?? params.content_type ?? params.mime ?? "",
  ).toLowerCase();
  const sourceMediaType = String(
    params.media_type ?? params.source_media_type ?? "",
  ).toLowerCase();
  const mediaLooksVideo =
    sourceMediaType === "video" ||
    sourceContentType.startsWith("video/") ||
    /\.(mp4|mov|webm|m4v)(?:[?#].*)?$/i.test(media);
  const video = String(
    params.video ?? params.video_url ?? (mediaLooksVideo ? media : ""),
  ).trim();
  const image = String(
    params.image ?? params.image_url ?? (!video && media ? media : ""),
  ).trim();

  if (!image && !video) {
    throw new Error("Upscale requires an image or video input.");
  }

  const preset = presetParam(params.upscale_preset ?? params.preset);
  const isVideo = !!video;
  const endpoint = `${MAGNIFIC_BASE}${isVideo ? MAGNIFIC_VIDEO_UPSCALE_PATH : MAGNIFIC_UPSCALE_PATH}`;
  const apiKey = loadMagnificApiKey();

  if (isVideo) {
    const defaults = VIDEO_PRESET_DEFAULTS[preset];
    const body = {
      video,
      resolution: videoResolutionParam(params.resolution ?? params.video_resolution),
      fps_boost: boolParam(params.fps_boost, false),
      sharpen: intParam(params.sharpen, 0, 100, defaults.sharpen),
      smart_grain: intParam(params.smart_grain, 0, 100, defaults.smart_grain),
      strength: intParam(params.strength, 0, 100, defaults.strength),
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [authHeaderNameForEndpoint(endpoint)]: apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 402 || /billing|payment|insufficient|quota/i.test(text)) {
        throw new Error("PROVIDER_BILLING_ERROR");
      }
      throw new Error(
        `Magnific video upscale failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Magnific video upscale returned non-JSON: ${text.slice(0, 200)}`);
    }

    const data = readTaskData(parsed);
    const taskId = String(data.task_id ?? data.id ?? parsed.task_id ?? parsed.id ?? "").trim();
    if (!taskId) {
      throw new Error("Magnific video upscale did not return a task_id.");
    }

    return {
      task_id: taskId,
      result_url: "",
      outputs: {},
      output_type: "video_url",
      provider_meta: {
        provider: "magnific_upscale",
        model: MAGNIFIC_UPSCALE_MODEL,
        endpoint,
        poll_endpoint: endpoint,
        status: String(data.status ?? parsed.status ?? "CREATED"),
        media_type: "video",
        output_type: "video_url",
        preset,
        resolution: body.resolution,
        fps_boost: body.fps_boost,
      },
    };
  }

  const defaults = IMAGE_PRESET_DEFAULTS[preset];
  const body = {
    image,
    // Live task audit on 2026-05-15 showed Precision V2 returning a
    // single 2x output even for submitted scale_factor=8. Clamp the
    // request to the verified behavior so logs/pricing don't imply a
    // higher multiplier until Magnific confirms the API behavior.
    scale_factor: 2,
    flavor: flavorParam(params.flavor ?? defaults.flavor),
    sharpen: intParam(params.sharpen, 0, 100, defaults.sharpen),
    smart_grain: intParam(params.smart_grain, 0, 100, defaults.smart_grain),
    ultra_detail: intParam(params.ultra_detail, 0, 100, defaults.ultra_detail),
    filter_nsfw: boolParam(params.filter_nsfw, false),
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [authHeaderNameForEndpoint(endpoint)]: apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 402 || /billing|payment|insufficient|quota/i.test(text)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(
      `Magnific upscale failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Magnific upscale returned non-JSON: ${text.slice(0, 200)}`);
  }

  const data = readTaskData(parsed);
  const taskId = String(data.task_id ?? data.id ?? parsed.task_id ?? parsed.id ?? "").trim();
  if (!taskId) {
    throw new Error("Magnific upscale did not return a task_id.");
  }

  return {
    task_id: taskId,
    result_url: "",
    outputs: {},
    output_type: "image_url",
    provider_meta: {
      provider: "magnific_upscale",
      model: MAGNIFIC_UPSCALE_MODEL,
      endpoint,
      poll_endpoint: endpoint,
      status: String(data.status ?? parsed.status ?? "CREATED"),
      media_type: "image",
      output_type: "image_url",
      preset,
      scale_factor: body.scale_factor,
      flavor: body.flavor,
    },
  };
}
