/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import type { ProviderResult } from "./providerResult.ts";
import { MAGNIFIC_BASE, loadMagnificApiKey } from "./magnific.ts";

export const MAGNIFIC_UPSCALE_MODEL = "magnific-upscale-precision-v2";
export const MAGNIFIC_UPSCALE_PATH = "/ai/image-upscaler-precision-v2";

const FLAVORS = new Set(["sublime", "photo", "photo_denoiser"]);

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

function flavorParam(raw: unknown): "sublime" | "photo" | "photo_denoiser" {
  const value = String(raw ?? "photo").trim().toLowerCase();
  return FLAVORS.has(value) ? (value as "sublime" | "photo" | "photo_denoiser") : "photo";
}

function readTaskData(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload;
}

export async function executeMagnificUpscale(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const image = String(params.image ?? params.image_url ?? "").trim();
  if (!image) {
    throw new Error("Upscale requires an image input.");
  }

  const endpoint = `${MAGNIFIC_BASE}${MAGNIFIC_UPSCALE_PATH}`;
  const apiKey = loadMagnificApiKey();
  const body = {
    image,
    scale_factor: intParam(params.scale_factor ?? params.scale, 2, 16, 2),
    flavor: flavorParam(params.flavor),
    sharpen: intParam(params.sharpen, 0, 100, 7),
    smart_grain: intParam(params.smart_grain, 0, 100, 7),
    ultra_detail: intParam(params.ultra_detail, 0, 100, 30),
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
      scale_factor: body.scale_factor,
      flavor: body.flavor,
    },
  };
}
