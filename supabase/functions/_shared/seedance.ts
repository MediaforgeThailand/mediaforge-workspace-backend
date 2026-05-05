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
   * Ark "content" array — multimodal. Each item is one of:
   *   - { type: "text", text }                                     (prompt)
   *   - { type: "image_url",  image_url:  { url }, role? }         (ref image / keyframe)
   *   - { type: "video_url",  video_url:  { url }, role? }         (ref video, 2.0+)
   *   - { type: "audio_url",  audio_url:  { url }, role? }         (ref audio, 2.0+)
   *
   * BytePlus 2.0 spec defines TWO mutually-exclusive image modes
   * (per official docs verified 2026-04 — see comment block in
   * buildSeedanceContent for the verbatim role-string list):
   *   - keyframe mode → roles `first_frame` / `last_frame`
   *   - multimodal-ref mode → roles `reference_image` /
   *     `reference_video` / `reference_audio`
   * Mixing both modes in one request returns 400. Workspace UI
   * surfaces only start_frame/end_frame for Seedance, so we only
   * emit the keyframe roles from this builder; ref_video/ref_audio
   * still use the multimodal-ref roles for 2.0 callers that wire
   * those slots.
   *
   * Legacy 1.x omits the role entirely on image_url and still
   * accepts trailing `--flag` tokens inline in the prompt text.
   */
  content: Array<Record<string, unknown>>;
  /* ── Top-level generation params (Seedance 2.0 spec). ──
   *  1.x ignores these and reads the same values from inline
   *  prompt flags instead — callers that target 1.x should leave
   *  these undefined and rely on buildSeedanceContent's flag mode. */
  ratio?: string;
  duration?: number;
  resolution?: string;
  generate_audio?: boolean;
  watermark?: boolean;
  seed?: number;
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
  /** Resolution — "480p" | "720p" | "1080p". */
  resolution?: string;
  /** Aspect ratio — "16:9" | "9:16" | "1:1" | "4:3" | "21:9" | "adaptive". */
  ratio?: string;
  /** Duration in seconds — supported range 2–12 depending on model. */
  duration?: number;
  /** Generate audio track (Seedance 1.5+ / 2.0). */
  generateAudio?: boolean;
  /** Lock camera position (no auto pan/zoom). 1.x only — 2.0 ignores. */
  cameraFixed?: boolean;
  /** Optional seed for reproducibility. */
  seed?: number;
  /** Add Bytedance watermark to output. Default false. */
  watermark?: boolean;
  /** Image-to-video first frame URL (HTTPS or base64 data URI). */
  startFrameUrl?: string;
  /** Image-to-video end frame URL (optional, models that support it). */
  endFrameUrl?: string;
  /** Seedance 2.0 multimodal reference image URLs. */
  referenceImageUrls?: string[];
  /** Seedance 2.0 multimodal reference video URL. */
  referenceVideoUrl?: string;
  /** Seedance 2.0 multimodal reference audio URL. */
  referenceAudioUrl?: string;
}

/** Result of `buildSeedanceContent` — `content` plus optional
 *  top-level fields the v2 spec expects beside the array. Spread
 *  these straight into the body of `submitSeedanceTask` and let
 *  the legacy fields stay `undefined` for 1.x callers. */
export interface BuiltSeedanceBody {
  content: Array<Record<string, unknown>>;
  ratio?: string;
  duration?: number;
  resolution?: string;
  generate_audio?: boolean;
  watermark?: boolean;
  seed?: number;
}

/**
 * Build the Ark task body. The shape diverges between Seedance 1.x
 * and 2.0:
 *
 *   - 1.x → inline `--flag value` tokens trailing the prompt text
 *           (BytePlus parses them server-side); image_url has no role.
 *   - 2.0 → top-level fields (`ratio`, `duration`, `generate_audio`,
 *           `watermark`, `seed`) sit beside `content`; image roles
 *           split into TWO mutually-exclusive modes:
 *             • Keyframe mode → `first_frame` / `last_frame`
 *               (used for start-frame and end-frame inputs)
 *             • Multimodal-ref mode → `reference_image` /
 *               `reference_video` / `reference_audio`
 *               (used for character / style / clip references;
 *                Seedance 2.0 accepts 1-9 reference images)
 *           Mixing the two modes in a single request → 400. Verified
 *           against the official BytePlus ModelArk API reference
 *           docs (Apr 2026, page 1520757):
 *             - "For first-and-last-frame generation, pass two image
 *                items and set role to first_frame and last_frame."
 *             - "Mode 1 is frame-guided generation … Mode 2 is
 *                multimodal reference generation … the parameter
 *                'content' specified is not valid with first/last
 *                frame content mixed with reference media content."
 *
 * Pass `{ v2: true }` for the dreamina-seedance-* family; default
 * stays on 1.x flag-encoding for backwards compatibility.
 */
export function buildSeedanceContent(
  p: SeedanceParams,
  opts?: { v2?: boolean },
): BuiltSeedanceBody {
  if (opts?.v2) {
    // ── Seedance 2.0 — top-level fields + named-role multimodal refs.
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: p.prompt.trim() },
    ];
    // start_frame / end_frame → keyframe-mode roles (first_frame /
    // last_frame). NOT reference_image: the BytePlus API treats
    // those as different modes and rejects the call when keyframe
    // intent is sent under reference_image semantics — the model
    // ends up animating around the image instead of using it as
    // the literal first/last frame.
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
    for (const url of p.referenceImageUrls ?? []) {
      content.push({
        type: "image_url",
        image_url: { url },
        role: "reference_image",
      });
    }
    if (p.referenceVideoUrl) {
      content.push({
        type: "video_url",
        video_url: { url: p.referenceVideoUrl },
        role: "reference_video",
      });
    }
    if (p.referenceAudioUrl) {
      content.push({
        type: "audio_url",
        audio_url: { url: p.referenceAudioUrl },
        role: "reference_audio",
      });
    }
    return {
      content,
      ratio: p.ratio,
      duration: p.duration,
      resolution: p.resolution,
      generate_audio: p.generateAudio,
      watermark: p.watermark ?? false,
      seed: p.seed,
    };
  }

  // ── Legacy 1.x — flag tokens inlined in the prompt text.
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
    });
  }
  if (p.endFrameUrl) {
    content.push({
      type: "image_url",
      image_url: { url: p.endFrameUrl },
    });
  }

  return { content };
}

export interface SeedanceCredentials {
  apiKey: string;
}

/**
 * Load BytePlus Ark credentials.
 *
 * Pass `{ v2: true }` when the caller is hitting a Seedance 2.0
 * model that lives behind a *custom* inference endpoint provisioned
 * in the BytePlus console — those endpoints are billed against a
 * dedicated API key (`SEEDANCE_V2_API_KEY`) that may be scoped to
 * only that endpoint. Falling back to the default account key when
 * the v2 key isn't set keeps the function usable for ad-hoc tests
 * before the secret is provisioned.
 *
 * Default (no opts) returns the account-wide key Seedream + Hyper3D
 * "auto" endpoints share with the legacy 1.x Seedance models.
 */
export function loadSeedanceCredentials(opts?: { v2?: boolean }): SeedanceCredentials {
  if (opts?.v2) {
    const v2Key =
      Deno.env.get("SEEDANCE_V2_API_KEY") ??
      Deno.env.get("BYTEPLUS_SEEDANCE_V2_API_KEY");
    if (v2Key) return { apiKey: v2Key };
    // fall through to the default key — better to attempt the call
    // (and surface the BytePlus error) than fail outright while the
    // operator is mid-rollout.
  }

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
      (res.status !== 429 &&
        /account balance not enough|insufficient balance|insufficient_quota|billing|payment required|prepaid|top[ -]?up|quota exceeded/i.test(text))
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
