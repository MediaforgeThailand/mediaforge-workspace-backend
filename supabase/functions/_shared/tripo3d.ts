/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import type { ProviderResult } from "./providerResult.ts";
import { isProviderBillingLike } from "./providerErrors.ts";

/* Tripo3D `model_version` strings — pulled directly from the
 * official docs at platform.tripo3d.ai/docs/generation. The
 * date suffix is part of the contract; without it the API
 * returns code 2017 "version invalid".
 *
 * Default is `v3.1-20260211` (gold standard, what Freepik /
 * Pikaso label as "Tripo v3.1"). `P1-20260311` is even newer
 * but still flagged as preview; expose it as an option only.
 *
 * Last verified against the docs: 2026-04-28. */
export const TRIPO3D_MODEL_VERSIONS: Record<string, string> = {
  "tripo3d-p1":     "P1-20260311",
  "tripo3d-v3.1":   "v3.1-20260211",
  "tripo3d-v3.0":   "v3.0-20250812",
  "tripo3d-turbo":  "Turbo-v1.0-20250506",
  "tripo3d-v2.5":   "v2.5-20250123",
  "tripo3d-v2.0":   "v2.0-20240919",
  "tripo3d-v1.4":   "v1.4-20240625",
};

export const TRIPO3D_MULTIVIEW_MODEL_KEYS = new Set([
  "tripo3d-v3.1",
  "tripo3d-v3.0",
  "tripo3d-v2.5",
  "tripo3d-v2.0",
]);

export const TRIPO3D_POLL_ENDPOINT = "https://api.tripo3d.ai/v2/openapi/task";

export async function executeTripo3D(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const KEY =
    Deno.env.get("TRIO_API_KEY") ??
    Deno.env.get("TRIPO_API_KEY") ??
    Deno.env.get("TRIPO3D_API_KEY");
  if (!KEY) {
    throw new Error(
      "TRIO_API_KEY (or TRIPO_API_KEY) is not configured — set it in Supabase project secrets.",
    );
  }

  const modelKey = String(params.model_name ?? "tripo3d-v3.1");
  const modelVersion = TRIPO3D_MODEL_VERSIONS[modelKey] ?? TRIPO3D_MODEL_VERSIONS["tripo3d-v3.1"];
  const supportsMultiview = TRIPO3D_MULTIVIEW_MODEL_KEYS.has(modelKey);
  const imageUrls = collectTripoImageUrls(params).slice(0, supportsMultiview ? 4 : 1);
  const imageUrl = imageUrls[0];
  if (!imageUrl) {
    throw new Error("Image to 3D needs an image input — wire an asset / generation into the `image` port.");
  }

  const texture = String(params.texture ?? "true") === "true";
  const pbr = String(params.pbr ?? "true") === "true";
  const autoSize = String(params.auto_size ?? "true") === "true";

  const taskType = supportsMultiview && imageUrls.length >= 2
    ? "multiview_to_model"
    : "image_to_model";
  const submitBody: Record<string, unknown> =
    taskType === "multiview_to_model"
      ? {
          type: taskType,
          files: imageUrls.map((url) => ({ type: "url", url })),
          model_version: modelVersion,
          texture,
          pbr,
          auto_size: autoSize,
        }
      : {
          type: taskType,
          file: { type: "url", url: imageUrl },
          model_version: modelVersion,
          texture,
          pbr,
          auto_size: autoSize,
        };

  console.log(
    `[tripo3d] Submitting ${taskType} task (model=${modelVersion}, ` +
      `images=${imageUrls.length}, texture=${texture}, pbr=${pbr})`,
  );

  const submitRes = await fetch(TRIPO3D_POLL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitRes.ok) {
    const errText = (await submitRes.text()).substring(0, 500);
    console.error(`[tripo3d] submit ${submitRes.status}:`, errText);
    if (submitRes.status === 401 || submitRes.status === 403) {
      throw new Error(
        `Tripo3D authentication failed (HTTP ${submitRes.status}) — check TRIO_API_KEY.`,
      );
    }
    if (isProviderBillingLike(submitRes.status, errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    // Surface invalid-version specifically so the user knows to pick a
    // different model in the dropdown — Tripo3D rejects unrecognised
    // version strings with code 2017.
    if (/version value is invalid|code"?\s*:\s*2017/i.test(errText)) {
      throw new Error(
        `Tripo3D ปฏิเสธ version "${modelVersion}" — เลือก model อื่นใน dropdown ` +
          `(v2.5 / Turbo / v2.0 / v1.4 ตามที่ระบบรองรับ)`,
      );
    }
    throw new Error(`Tripo3D submit failed (HTTP ${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json() as {
    code?: number;
    data?: { task_id?: string };
    message?: string;
  };
  if (submitData.code !== undefined && submitData.code !== 0) {
    throw new Error(`Tripo3D returned error code ${submitData.code}: ${submitData.message ?? "no detail"}`);
  }
  const taskId = String(submitData?.data?.task_id ?? "").trim();
  if (!taskId) {
    throw new Error("Tripo3D didn't return a task_id");
  }

  console.log(`[tripo3d] task submitted task_id=${taskId.slice(0, 8)}…`);

  /* Async hand-off — frontend polls via action="poll_tripo3d" until
   * the job lands. Each poll is one quick edge-fn call (no risk of
   * worker timeout) so even multi-minute jobs finish reliably. */
  return {
    task_id: taskId,
    outputs: {},
    output_type: "image_url" as const,
    provider_meta: {
      provider: "tripo3d",
      model_version: modelVersion,
      task_type: taskType,
      input_image_count: imageUrls.length,
      poll_endpoint: TRIPO3D_POLL_ENDPOINT,
      task_id: taskId,
    },
  };
}

export function collectTripoImageUrls(params: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      urls.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(push);
    }
  };

  push(params.image_urls);
  push(params.ref_image);
  push(params.image_url);
  push(params.image);
  push(params.mention_image_urls);

  return Array.from(new Set(urls));
}
