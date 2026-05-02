/// <reference lib="deno.ns" />
/**
 * Seedream (BytePlus ModelArk) image-generation client.
 *
 * Seedream is Bytedance's image model family served through the same
 * BytePlus "Ark" inference API as Seedance. Unlike Seedance video,
 * image generation is synchronous — one POST returns the rendered
 * image URL directly, no submit/poll loop needed.
 *
 * Endpoint: `${ARK_BASE}/api/v3/images/generations`
 * Auth:     `Authorization: Bearer $ARK_API_KEY`
 *
 * Body shape mirrors the OpenAI Images API spec that BytePlus
 * intentionally implements for drop-in compatibility:
 *   {
 *     "model": "seedream-5-0-260128",
 *     "prompt": "...",
 *     "size":  "1024x1024",
 *     "response_format": "url"
 *   }
 *
 * Response:
 *   { "data": [ { "url": "https://..." } ], "usage": {...} }
 *
 * Reuses the same SEEDANCE_API_KEY env var (BytePlus issues one Ark
 * key per account that grants access to all Seedance + Seedream
 * models). The credential loader is shared via _shared/seedance.ts.
 */

import { loadSeedanceCredentials } from "./seedance.ts";

/** BytePlus ModelArk base URL (international). Same gateway as Seedance. */
export const SEEDREAM_BASE = "https://ark.ap-southeast.bytepluses.com";
export const SEEDREAM_IMAGES_PATH = "/api/v3/images/generations";

/** Map UI model slug → Ark model ID + capability flags. */
export interface SeedreamModelEntry {
  /** Ark model ID — the value sent in the API `model` field. */
  model: string;
  /** Pricing/quality tier label. Used for logging only. */
  tier: "v4" | "v5" | "v5-lite";
  /** Maximum supported size string the model accepts. */
  maxSize: string;
}

export const SEEDREAM_MODEL_MAP: Record<string, SeedreamModelEntry> = {
  // BytePlus ModelArk Seedream 5.0 — verified in ap-southeast-1
  // console on 2026-04-30. Pricing row in credit_costs uses the
  // verbatim BytePlus ID as the `model` column.
  "seedream-5-0":          { model: "seedream-5-0-260128", tier: "v5", maxSize: "2048x2048" },
  "seedream-5-0-260128":   { model: "seedream-5-0-260128", tier: "v5", maxSize: "2048x2048" },
  "seedream-5":            { model: "seedream-5-0-260128", tier: "v5", maxSize: "2048x2048" },
  "seedream-5-0-lite-260128": { model: "seedream-5-0-lite-260128", tier: "v5-lite", maxSize: "2048x2048" },
  "seedream-4-5-251128":   { model: "seedream-4-5-251128", tier: "v4", maxSize: "2048x2048" },
};

export interface SeedreamGenerateRequest {
  /** Ark model ID. */
  model: string;
  /** Text prompt. */
  prompt: string;
  /** Image size — "WIDTHxHEIGHT" (e.g. "1024x1024", "1024x1792"). */
  size?: string;
  /** "url" returns hosted URL, "b64_json" returns inline base64. */
  response_format?: "url" | "b64_json";
  /** Optional seed for reproducibility. */
  seed?: number;
  /** Optional reference image URLs for image-to-image / image editing.
   *  BytePlus ModelArk Seedream 4.5 + 5.0 both expect an ARRAY here
   *  under the `image_urls` key (max 14 references, ≤10 MB each, jpg/
   *  png/webp/bmp/tiff/gif). The legacy singular `image` key from
   *  Seedream 4.0 is silently ignored on the 4.5 + 5.0 endpoints, so
   *  the workspace builds the array form unconditionally — that's the
   *  shape the user is expected to wire in via the canvas ref_image
   *  port (or the standalone tool's reference image input). */
  image_urls?: string[];
  /** Optional negative prompt — Seedream supports it on most variants. */
  negative_prompt?: string;
  /** Number of images to return. BytePlus tops out at ~4. */
  n?: number;
}

export interface SeedreamImageItem {
  /** When response_format=url. */
  url?: string;
  /** When response_format=b64_json. */
  b64_json?: string;
  /** Per-image revised prompt the model actually rendered (occasionally returned). */
  revised_prompt?: string;
}

export interface SeedreamGenerateResponse {
  /** Unix seconds, when the API returns it. */
  created?: number;
  data?: SeedreamImageItem[];
  /** Token / image counters when returned. */
  usage?: { generated_images?: number; total_tokens?: number };
  /** Present only on error. */
  error?: { code?: string; message?: string };
}

/**
 * One-shot Seedream image generation. Throws on non-2xx, on missing
 * `data[0].url`, or on the BytePlus-specific billing/quota signals so
 * the executor can surface a clean error to the user.
 */
export async function generateSeedreamImage(
  body: SeedreamGenerateRequest,
  apiKey: string,
): Promise<SeedreamImageItem[]> {
  const url = `${SEEDREAM_BASE}${SEEDREAM_IMAGES_PATH}`;
  console.log(`[seedream] POST ${url} model=${body.model} size=${body.size ?? "default"}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[seedream] HTTP ${res.status}: ${text.substring(0, 500)}`);
    if (
      res.status === 402 ||
      (res.status !== 429 &&
        /account balance not enough|insufficient balance|insufficient_quota|billing|payment required|prepaid|top[ -]?up|quota exceeded/i.test(text))
    ) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Seedream authentication failed (HTTP ${res.status}) — check SEEDANCE_API_KEY ` +
          `(same BytePlus ModelArk key powers Seedance + Seedream).`,
      );
    }
    throw new Error(
      `Seedream API error (HTTP ${res.status}): ${text.substring(0, 200)}`,
    );
  }

  let parsed: SeedreamGenerateResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Seedream returned non-JSON response: ${text.substring(0, 200)}`);
  }

  if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
    const errMsg = parsed.error?.message ?? "no data in response";
    throw new Error(`Seedream generation failed: ${errMsg}`);
  }

  return parsed.data;
}

/** Convenience wrapper that loads creds + extracts the first image URL. */
export async function generateSeedreamSingleUrl(
  body: SeedreamGenerateRequest,
): Promise<{ url: string; raw: SeedreamImageItem[] }> {
  const { apiKey } = loadSeedanceCredentials();
  const items = await generateSeedreamImage(
    { ...body, response_format: body.response_format ?? "url", n: body.n ?? 1 },
    apiKey,
  );
  const first = items[0];
  const url = first?.url;
  if (!url) {
    throw new Error("Seedream returned no URL in the first image item.");
  }
  return { url, raw: items };
}
