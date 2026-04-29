/// <reference lib="deno.ns" />
/**
 * Hyper3D (BytePlus ModelArk) image-to-3D generation client.
 *
 * Hyper3D Gen2 is BytePlus' image-to-3D model that produces a textured
 * GLB / OBJ from a single reference image. It rides the same async
 * submit/poll pipeline as Seedance video, just with a different model
 * ID and 3D-flavoured response payload.
 *
 *   1. POST /api/v3/contents/generations/tasks → returns { id }
 *   2. GET  /api/v3/contents/generations/tasks/{id}            (poll)
 *
 * The same BytePlus Ark API key powers Seedance + Seedream + Hyper3D
 * — the credential loader is shared via _shared/seedance.ts so the
 * env-var fallback chain (SEEDANCE_API_KEY → ARK_API_KEY → …) is
 * consistent across all three executors.
 *
 * The frontend can drive polling by hitting workspace-run-node with
 * action=`poll_hyper3d` (mirror of poll_seedance). For server-side
 * inline use, see pollHyper3dToCompletion below.
 */

import { loadSeedanceCredentials } from "./seedance.ts";

/** BytePlus ModelArk base — same gateway Seedance + Seedream use. */
export const HYPER3D_BASE = "https://ark.ap-southeast.bytepluses.com";
export const HYPER3D_TASKS_PATH = "/api/v3/contents/generations/tasks";

export interface Hyper3dModelEntry {
  /** Ark model ID — value sent in the API `model` field. */
  model: string;
  /** Generation tier label. */
  tier: "gen2";
  /** Whether the model accepts a reference image (image-to-3D). All
   *  Hyper3D variants currently require one. */
  requiresImage: boolean;
}

export const HYPER3D_MODEL_MAP: Record<string, Hyper3dModelEntry> = {
  // BytePlus ModelArk Hyper3D Gen2 — verified in ap-southeast-1 console
  // on 2026-04-30. UI slug aliases let the frontend keep using the
  // unversioned name; the dated ID is what BytePlus expects on the wire.
  "hyper3d-gen2":          { model: "hyper3d-gen2-260112", tier: "gen2", requiresImage: true },
  "hyper3d-gen2-260112":   { model: "hyper3d-gen2-260112", tier: "gen2", requiresImage: true },
  "hyper3d":               { model: "hyper3d-gen2-260112", tier: "gen2", requiresImage: true },
};

export interface Hyper3dParams {
  /** HTTPS or data-URI of the reference image to lift to 3D. */
  imageUrl: string;
  /** Optional text prompt — improves geometry hints when supplied. */
  prompt?: string;
  /** Output format hint: "glb" | "obj" | "fbx". Default "glb". */
  format?: "glb" | "obj" | "fbx";
  /** Whether to bake textures (PBR). Default true. */
  texture?: boolean;
  /** Optional seed for reproducibility. */
  seed?: number;
}

export interface Hyper3dTaskCreate {
  model: string;
  /** Ark "content" array — same shape Seedance uses. Hyper3D reads:
   *    [{ type: "image_url", image_url: { url } }, { type: "text", text }]
   *  with optional --format / --texture flags inlined into the text. */
  content: Array<Record<string, unknown>>;
}

export interface Hyper3dTaskCreateResponse {
  id?: string;
  error?: { code?: string; message?: string };
}

export interface Hyper3dTaskStatus {
  id: string;
  /** "queued" | "running" | "succeeded" | "failed" | "cancelled". */
  status: string;
  content?: {
    /** Primary model URL (GLB by default). */
    model_url?: string;
    /** Some variants return additional rendered preview / mesh URLs. */
    rendered_image_url?: string;
    obj_url?: string;
    fbx_url?: string;
    glb_url?: string;
  };
  error?: { code?: string; message?: string };
  usage?: { total_seconds?: number };
}

/** Build the Ark "content" array from Hyper3D params. */
export function buildHyper3dContent(p: Hyper3dParams): Array<Record<string, unknown>> {
  const flags: string[] = [];
  if (p.format) flags.push(`--format ${p.format}`);
  if (p.texture !== undefined) flags.push(`--texture ${p.texture ? "true" : "false"}`);
  if (typeof p.seed === "number") flags.push(`--seed ${p.seed}`);

  const promptWithFlags = [p.prompt?.trim() ?? "", ...flags].filter(Boolean).join(" ").trim();

  const content: Array<Record<string, unknown>> = [
    { type: "image_url", image_url: { url: p.imageUrl } },
  ];
  // Only include the text item when there's something to say — sending
  // an empty text node confuses some BytePlus model loaders.
  if (promptWithFlags) {
    content.push({ type: "text", text: promptWithFlags });
  }

  return content;
}

/**
 * Submit a Hyper3D generation task. Returns the task_id immediately;
 * caller polls via pollHyper3dOnce or relies on the frontend poll.
 */
export async function submitHyper3dTask(
  body: Hyper3dTaskCreate,
  apiKey: string,
): Promise<string> {
  const url = `${HYPER3D_BASE}${HYPER3D_TASKS_PATH}`;
  console.log(`[hyper3d] POST ${url} model=${body.model}`);
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
    console.error(`[hyper3d] submit HTTP ${res.status}: ${text.substring(0, 500)}`);
    if (
      res.status === 402 ||
      res.status === 429 ||
      /balance|insufficient|quota|billing/i.test(text)
    ) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Hyper3D authentication failed (HTTP ${res.status}) — same BytePlus ` +
          `ModelArk key as Seedance/Seedream; check SEEDANCE_API_KEY.`,
      );
    }
    throw new Error(
      `Hyper3D API error (HTTP ${res.status}): ${text.substring(0, 200)}`,
    );
  }

  let parsed: Hyper3dTaskCreateResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Hyper3D returned non-JSON response: ${text.substring(0, 200)}`);
  }
  if (!parsed.id) {
    const errMsg = parsed.error?.message ?? "no id in response";
    throw new Error(`Hyper3D submit failed: ${errMsg}`);
  }
  return parsed.id;
}

/** Single status poll. Mirrors pollSeedanceOnce. */
export async function pollHyper3dOnce(
  taskId: string,
  apiKey: string,
): Promise<Hyper3dTaskStatus> {
  const url = `${HYPER3D_BASE}${HYPER3D_TASKS_PATH}/${encodeURIComponent(taskId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Hyper3D status check failed (HTTP ${res.status}): ${errText.substring(0, 200)}`,
    );
  }
  return (await res.json()) as Hyper3dTaskStatus;
}

/** Best-effort URL extraction across the response variants BytePlus
 *  uses for different output formats. */
export function pickHyper3dModelUrl(status: Hyper3dTaskStatus): string {
  const c = status.content ?? {};
  return c.model_url ?? c.glb_url ?? c.obj_url ?? c.fbx_url ?? "";
}

/**
 * Server-side polling helper. Burns wall-clock until the task finishes
 * or a timeout fires. The workspace-run-node executor doesn't use this
 * (it returns task_id and lets the frontend drive polling, same as
 * Seedance), but it's exported for any future inline use.
 */
export async function pollHyper3dToCompletion(
  taskId: string,
  apiKey: string,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<{ url: string; raw: Hyper3dTaskStatus }> {
  const timeoutMs = opts.timeoutMs ?? 600_000; // 3D jobs can run longer than video
  const intervalMs = opts.intervalMs ?? 6_000;
  const label = opts.label ?? "hyper3d";
  const started = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) {
      throw new Error(
        `[${label}] Polling timed out after ${Math.round(elapsed / 1000)}s ` +
          `(task_id=${taskId}). Job may still complete on the Ark side.`,
      );
    }

    let status: Hyper3dTaskStatus;
    try {
      status = await pollHyper3dOnce(taskId, apiKey);
    } catch (err) {
      console.warn(`[${label}] poll attempt ${attempt} error, retrying:`, err);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    const s = (status.status ?? "").toLowerCase();
    if (s === "succeeded" || s === "success") {
      const modelUrl = pickHyper3dModelUrl(status);
      if (!modelUrl) {
        throw new Error(
          `[${label}] Task succeeded but response had no model URL (task_id=${taskId})`,
        );
      }
      console.log(
        `[${label}] Task ${taskId} succeeded after ${Math.round(elapsed / 1000)}s ` +
          `(${attempt} polls)`,
      );
      return { url: modelUrl, raw: status };
    }
    if (s === "failed" || s === "fail" || s === "cancelled") {
      const msg = status.error?.message ?? "no detail";
      throw new Error(`[${label}] Task ${s}: ${msg} (task_id=${taskId})`);
    }

    if (attempt === 1 || attempt % 6 === 0) {
      console.log(
        `[${label}] Task ${taskId} status=${s || "(empty)"} elapsed=${Math.round(elapsed / 1000)}s`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
