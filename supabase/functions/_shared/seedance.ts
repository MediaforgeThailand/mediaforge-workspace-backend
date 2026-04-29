/// <reference lib="deno.ns" />
/**
 * Seedance (BytePlus / Volcengine ModelArk) video-generation client.
 *
 * Seedance is Bytedance's video model family, served through the
 * Volcengine "Ark" inference API. Workspace V2 talks to it directly
 * (no aggregator) using an API key the user provisions in the
 * Volcengine console — same pattern Kling uses with native creds.
 *
 * Async submit/poll flow mirrors Kling:
 *   1. POST /api/v3/contents/generations/tasks → returns { id }
 *   2. GET  /api/v3/contents/generations/tasks/{id} (poll until done)
 *
 * The frontend polls via the workspace-run-node `poll_seedance` action
 * (whitelisted host, like poll_kling) until status === "succeeded".
 *
 * NOTE — provider docs reference: as of the time of writing the
 * canonical reference is the Volcengine Ark API console. Endpoints +
 * field names below match the Volcengine Ark video-generation spec
 * (text2video / image2video). If pricing or model IDs change, update
 * SEEDANCE_MODEL_MAP and the pricing migration in tandem.
 */

/** BytePlus ModelArk base URL (international) — text/image-to-video endpoint.
 *  Domestic-China deployments would use https://ark.cn-beijing.volces.com,
 *  but our workspace integration uses the BytePlus international gateway. */
export const SEEDANCE_BASE = "https://ark.ap-southeast.bytepluses.com";
export const SEEDANCE_TASKS_PATH = "/api/v3/contents/generations/tasks";

/** Map UI model slug → Ark model ID + capability flags. */
export interface SeedanceModelEntry {
  /** Ark model ID — the value sent in the API `model` field. */
  model: string;
  /** Generation pricing tier label. Used for logging only. */
  tier: "lite" | "pro" | "pro-fast" | "master";
  /** Audio generation supported (Seedance 1.5+ + 2.0). */
  supportsAudio: boolean;
  /** Multimodal video reference supported (Seedance 2.0 series). */
  supportsVideoReference?: boolean;
}

export const SEEDANCE_MODEL_MAP: Record<string, SeedanceModelEntry> = {
  // Legacy 1.x — kept for parity with the legacy nodeApiSchema.
  "seedance-1-0-pro-250528": { model: "seedance-1-0-pro-250528", tier: "pro", supportsAudio: false, supportsVideoReference: false },
  "seedance-1-0-pro-fast-251015": { model: "seedance-1-0-pro-fast-251015", tier: "pro-fast", supportsAudio: false, supportsVideoReference: false },
  "seedance-1-5-pro-251215": { model: "seedance-1-5-pro-251215", tier: "pro", supportsAudio: true, supportsVideoReference: false },
  // Seedance 2.0 family — BytePlus ModelArk model IDs (verified in
  // ap-southeast-1 console on 2026-04-30). The UI slug stays
  // "seedance-2-0-{lite|pro}" so the frontend dropdown doesn't have
  // to change; we forward the BytePlus identifier on the wire.
  //   - dreamina-seedance-2-0-260128       = Seedance 2.0 Pro (full)
  //   - dreamina-seedance-2-0-fast-260128  = Seedance 2.0 Fast (lite)
  "seedance-2-0-lite": { model: "dreamina-seedance-2-0-fast-260128", tier: "lite", supportsAudio: true, supportsVideoReference: true },
  "seedance-2-0-pro":  { model: "dreamina-seedance-2-0-260128",      tier: "pro",  supportsAudio: true, supportsVideoReference: true },
  // Direct-ID aliases — let the BytePlus IDs themselves resolve in
  // case any caller already sends the verbatim identifier.
  "dreamina-seedance-2-0-260128":      { model: "dreamina-seedance-2-0-260128",      tier: "pro",  supportsAudio: true, supportsVideoReference: true },
  "dreamina-seedance-2-0-fast-260128": { model: "dreamina-seedance-2-0-fast-260128", tier: "lite", supportsAudio: true, supportsVideoReference: true },
};

export interface SeedanceTaskCreate {
  model: string;
  /**
   * Volcengine "content" array — same shape as Doubao multimodal.
   * Each item is `{ type: "text", text }` for the prompt/params, or
   * `{ type: "image_url", image_url: { url } }` for image-to-video
   * reference frames (start_frame / end_frame).
   *
   * Trailing flags inside the prompt text drive ratio / resolution /
   * duration / audio: e.g.
   *   "subject + action --resolution 720p --ratio 16:9 --duration 5 --camerafixed false"
   */
  content: Array<Record<string, unknown>>;
}

export interface SeedanceTaskCreateResponse {
  id: string;
  /** present only on error */
  error?: { code?: string; message?: string };
}

export interface SeedanceTaskStatus {
  id: string;
  /** "queued" | "running" | "succeeded" | "failed" | "cancelled" */
  status: string;
  content?: {
    /** Video URL on success. */
    video_url?: string;
  };
  error?: { code?: string; message?: string };
  /** Seconds the job took on the server. Surfaced for analytics. */
  usage?: { total_seconds?: number };
}

export interface SeedanceParams {
  prompt: string;
  /** Resolution flag — Volcengine accepts "480p" | "720p" | "1080p". */
  resolution?: string;
  /** Aspect ratio — "16:9" | "9:16" | "1:1" | "4:3" | "21:9" | "adaptive". */
  ratio?: string;
  /** Duration in seconds — supported range 2–12 depending on model. */
  duration?: number;
  /** Generate audio track (Seedance 1.5+ / 2.0). */
  generateAudio?: boolean;
  /** Lock camera position (no auto pan/zoom). */
  cameraFixed?: boolean;
  /** Optional seed for reproducibility. */
  seed?: number;
  /** Add Bytedance watermark to output. Default false. */
  watermark?: boolean;
  /** Image-to-video first frame URL (HTTPS or base64 data URI). */
  startFrameUrl?: string;
  /** Image-to-video end frame URL (optional, models that support it). */
  endFrameUrl?: string;
  /** Seedance 2.0 multimodal reference video URL. */
  referenceVideoUrl?: string;
}

/** Build the Volcengine Ark "content" array from prompt + params. */
export function buildSeedanceContent(p: SeedanceParams): Array<Record<string, unknown>> {
  const flags: string[] = [];
  if (p.resolution) flags.push(`--resolution ${p.resolution}`);
  if (p.ratio) flags.push(`--ratio ${p.ratio}`);
  if (typeof p.duration === "number") flags.push(`--duration ${p.duration}`);
  if (p.generateAudio !== undefined) flags.push(`--audio ${p.generateAudio ? "true" : "false"}`);
  if (p.cameraFixed !== undefined) flags.push(`--camerafixed ${p.cameraFixed ? "true" : "false"}`);
  if (typeof p.seed === "number") flags.push(`--seed ${p.seed}`);
  flags.push(`--watermark ${p.watermark ? "true" : "false"}`);

  const promptWithFlags = [p.prompt.trim(), ...flags].filter(Boolean).join(" ");
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: promptWithFlags },
  ];

  if (p.startFrameUrl) {
    content.push({
      type: "image_url",
      image_url: { url: p.startFrameUrl },
      role: "first_frame",
    });
  }
  if (p.endFrameUrl) {
    content.push({
      type: "image_url",
      image_url: { url: p.endFrameUrl },
      role: "last_frame",
    });
  }
  if (p.referenceVideoUrl) {
    content.push({
      type: "video_url",
      video_url: { url: p.referenceVideoUrl },
      role: "reference_video",
    });
  }

  return content;
}

export interface SeedanceCredentials {
  apiKey: string;
}

export function loadSeedanceCredentials(): SeedanceCredentials {
  const apiKey =
    Deno.env.get("SEEDANCE_API_KEY") ??
    Deno.env.get("ARK_API_KEY") ??
    Deno.env.get("BYTEDANCE_API_KEY") ??
    Deno.env.get("VOLCENGINE_ARK_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Seedance credentials missing — set SEEDANCE_API_KEY (or ARK_API_KEY) " +
        "in Supabase project secrets (workspace dev). Provision the key in the " +
        "BytePlus ModelArk console: https://console.byteplus.com/ark.",
    );
  }
  return { apiKey };
}

/**
 * Submit a Seedance generation task. Returns the task_id immediately —
 * the caller polls separately (see pollSeedanceOnce).
 */
export async function submitSeedanceTask(
  body: SeedanceTaskCreate,
  apiKey: string,
): Promise<string> {
  const url = `${SEEDANCE_BASE}${SEEDANCE_TASKS_PATH}`;
  console.log(`[seedance] POST ${url} model=${body.model}`);
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
    console.error(`[seedance] submit HTTP ${res.status}: ${text.substring(0, 500)}`);
    if (
      res.status === 402 ||
      res.status === 429 ||
      /balance|insufficient|quota|billing/i.test(text)
    ) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(
      `Seedance API error (HTTP ${res.status}): ${text.substring(0, 200)}`,
    );
  }

  let parsed: SeedanceTaskCreateResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Seedance returned non-JSON response: ${text.substring(0, 200)}`);
  }
  if (!parsed.id) {
    const errMsg = parsed.error?.message ?? "no id in response";
    throw new Error(`Seedance submit failed: ${errMsg}`);
  }
  return parsed.id;
}

/**
 * Single poll for a Seedance task. Returns the parsed status object —
 * the caller decides whether to keep polling. Used by:
 *   - workspace-run-node `poll_seedance` action (frontend repeatedly hits)
 *   - inline pollSeedanceVideo (server-side burn while caller waits)
 */
export async function pollSeedanceOnce(
  taskId: string,
  apiKey: string,
): Promise<SeedanceTaskStatus> {
  const url = `${SEEDANCE_BASE}${SEEDANCE_TASKS_PATH}/${encodeURIComponent(taskId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Seedance status check failed (HTTP ${res.status}): ${errText.substring(0, 200)}`,
    );
  }
  return (await res.json()) as SeedanceTaskStatus;
}

/**
 * Server-side polling helper — burns wall-clock until a task completes
 * or times out. Mirrors pollKlingVideo. The workspace-run-node executor
 * doesn't actually use this (we return task_id and let the frontend
 * drive `poll_seedance` like Kling does), but it's exported for any
 * future inline use case (e.g. multi-step pipelines).
 */
export async function pollSeedanceVideo(
  taskId: string,
  apiKey: string,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<{ url: string; raw: SeedanceTaskStatus }> {
  const timeoutMs = opts.timeoutMs ?? 320_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const label = opts.label ?? "seedance";
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

    let status: SeedanceTaskStatus;
    try {
      status = await pollSeedanceOnce(taskId, apiKey);
    } catch (err) {
      console.warn(`[${label}] poll attempt ${attempt} error, retrying:`, err);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    const s = (status.status ?? "").toLowerCase();
    if (s === "succeeded" || s === "success") {
      const videoUrl = status.content?.video_url ?? "";
      if (!videoUrl) {
        throw new Error(
          `[${label}] Task succeeded but response had no video_url (task_id=${taskId})`,
        );
      }
      console.log(
        `[${label}] Task ${taskId} succeeded after ${Math.round(elapsed / 1000)}s ` +
          `(${attempt} polls)`,
      );
      return { url: videoUrl, raw: status };
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
