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
const TRIPO3D_STS_TOKEN_ENDPOINT = "https://api.tripo3d.ai/v2/openapi/upload/sts/token";
const TRIPO3D_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const TRIPO3D_IMPORT_FORMATS = new Set(["glb", "obj", "fbx", "stl"]);

const TRIPO3D_RIG_TYPES = new Set([
  "biped",
  "quadruped",
  "hexapod",
  "octopod",
  "avian",
  "serpentine",
  "aquatic",
]);

const TRIPO3D_ANIMATION_PRESETS = new Set([
  "preset:idle",
  "preset:walk",
  "preset:run",
  "preset:dive",
  "preset:climb",
  "preset:jump",
  "preset:slash",
  "preset:shoot",
  "preset:hurt",
  "preset:fall",
  "preset:turn",
  "preset:quadruped:walk",
  "preset:hexapod:walk",
  "preset:octopod:walk",
  "preset:serpentine:march",
  "preset:aquatic:march",
]);

const TRIPO3D_CONVERT_FORMATS = new Set(["GLTF", "USDZ", "FBX", "OBJ", "STL", "3MF"]);
const TRIPO3D_FBX_PRESETS = new Set(["blender", "3dsmax", "mixamo"]);

function tripoApiKey(): string {
  const key =
    Deno.env.get("TRIO_API_KEY") ??
    Deno.env.get("TRIPO_API_KEY") ??
    Deno.env.get("TRIPO3D_API_KEY");
  if (!key) {
    throw new Error(
      "TRIO_API_KEY (or TRIPO_API_KEY) is not configured - set it in Supabase project secrets.",
    );
  }
  return key;
}

async function submitTripoTask(
  submitBody: Record<string, unknown>,
  label: string,
): Promise<string> {
  const submitRes = await fetch(TRIPO3D_POLL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tripoApiKey()}`,
    },
    body: JSON.stringify(submitBody),
  });

  if (!submitRes.ok) {
    const errText = (await submitRes.text()).substring(0, 500);
    console.error(`[tripo3d] submit ${label} ${submitRes.status}:`, errText);
    if (submitRes.status === 401 || submitRes.status === 403) {
      throw new Error(
        `Tripo3D authentication failed (HTTP ${submitRes.status}) - check TRIO_API_KEY.`,
      );
    }
    if (isProviderBillingLike(submitRes.status, errText)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    if (/version value is invalid|code"?\s*:\s*2017/i.test(errText)) {
      throw new Error(
        `Tripo3D rejected this model version - pick a newer Image to 3D model before ${label}.`,
      );
    }
    throw new Error(`Tripo3D ${label} submit failed (HTTP ${submitRes.status}): ${errText}`);
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
    throw new Error(`Tripo3D ${label} did not return a task_id`);
  }
  return taskId;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function boolParam(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return fallback;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  if (!(key in params)) return undefined;
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : undefined;
}

function extractTextField(value: unknown, keys: string[]): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractTextField(item, keys);
      if (found) return found;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  const providerMeta = record.provider_meta;
  if (providerMeta && typeof providerMeta === "object") {
    const found = extractTextField(providerMeta, keys);
    if (found) return found;
  }
  return "";
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hmacSha256(key: Uint8Array, value: string): Promise<Uint8Array> {
  const keyData = new Uint8Array(key.byteLength);
  keyData.set(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

function amzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function contentTypeForModelFormat(format: string): string {
  switch (format) {
    case "glb":
      return "model/gltf-binary";
    case "obj":
      return "model/obj";
    case "fbx":
      return "model/fbx";
    case "stl":
      return "model/stl";
    default:
      return "application/octet-stream";
  }
}

function normalizeImportFormat(params: Record<string, unknown>, modelUrl: string): string {
  const raw = firstText(
    params.format,
    params.file_format,
    params.model_format,
    params.extension,
    extractTextField(params.model3d, ["format", "file_format", "model_format", "extension"]),
    modelUrl.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1],
  ).toLowerCase();
  if (TRIPO3D_IMPORT_FORMATS.has(raw)) return raw;
  throw new Error("Tripo import supports GLB, OBJ, FBX, or STL model files.");
}

function resolveExternalModelImport(params: Record<string, unknown>): {
  sourceModelUrl: string;
  format: string;
  sourceName: string;
} {
  const source = [
    params.model3d,
    params.model_3d,
    params.ref_model,
    params.output_model,
    params.input_model,
    params.model,
  ];
  const sourceModelUrl = firstText(
    params.source_model_url,
    params.model_url,
    params.url,
    params.file_url,
    extractTextField(source, [
      "source_model_url",
      "model_url",
      "url",
      "file_url",
      "preview_url",
    ]),
  );
  if (!/^https?:\/\//i.test(sourceModelUrl)) {
    throw new Error("Upload a GLB, OBJ, FBX, or STL model before importing it to Tripo.");
  }
  const format = normalizeImportFormat(params, sourceModelUrl);
  const sourceName = firstText(
    params.file_name,
    params.filename,
    params.name,
    extractTextField(source, ["file_name", "filename", "name"]),
    `import.${format}`,
  );
  return { sourceModelUrl, format, sourceName };
}

async function requestTripoStsToken(format: string): Promise<{
  s3Host: string;
  bucket: string;
  key: string;
  sessionToken: string;
  accessKeyId: string;
  secretAccessKey: string;
}> {
  const res = await fetch(TRIPO3D_STS_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tripoApiKey()}`,
    },
    body: JSON.stringify({ format }),
  });
  if (!res.ok) {
    const errText = (await res.text()).substring(0, 500);
    throw new Error(`Tripo3D import upload token failed (HTTP ${res.status}): ${errText}`);
  }
  const json = await res.json() as {
    code?: number;
    data?: {
      s3_host?: string;
      resource_bucket?: string;
      resource_uri?: string;
      session_token?: string;
      sts_ak?: string;
      sts_sk?: string;
    };
    message?: string;
  };
  if (json.code !== undefined && json.code !== 0) {
    throw new Error(`Tripo3D import upload token failed: ${json.message ?? json.code}`);
  }
  const data = json.data ?? {};
  const s3Host = firstText(data.s3_host, "s3.us-west-2.amazonaws.com");
  const bucket = firstText(data.resource_bucket, "tripo-data");
  const key = firstText(data.resource_uri);
  const sessionToken = firstText(data.session_token);
  const accessKeyId = firstText(data.sts_ak);
  const secretAccessKey = firstText(data.sts_sk);
  if (!s3Host || !bucket || !key || !sessionToken || !accessKeyId || !secretAccessKey) {
    throw new Error("Tripo3D import upload token was missing S3 credentials.");
  }
  return { s3Host, bucket, key, sessionToken, accessKeyId, secretAccessKey };
}

async function putObjectToTripoS3(args: {
  credentials: Awaited<ReturnType<typeof requestTripoStsToken>>;
  bytes: ArrayBuffer;
  contentType: string;
}): Promise<void> {
  const { credentials, bytes, contentType } = args;
  const region = "us-west-2";
  const service = "s3";
  const { amzDate, dateStamp } = amzDates();
  const payloadHash = await sha256Hex(bytes);
  const canonicalUri = `/${encodeURIComponent(credentials.bucket)}/${encodeS3Path(credentials.key)}`;
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${credentials.s3Host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${credentials.sessionToken}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const encoder = new TextEncoder();
  const dateKey = await hmacSha256(encoder.encode(`AWS4${credentials.secretAccessKey}`), dateStamp);
  const regionKey = await hmacSha256(dateKey, region);
  const serviceKey = await hmacSha256(regionKey, service);
  const signingKey = await hmacSha256(serviceKey, "aws4_request");
  const signature = hex(await hmacSha256(signingKey, stringToSign));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const uploadUrl = `https://${credentials.s3Host}${canonicalUri}`;
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "x-amz-security-token": credentials.sessionToken,
    },
    body: bytes,
  });
  if (!res.ok) {
    const errText = (await res.text()).substring(0, 500);
    throw new Error(`Tripo3D import S3 upload failed (HTTP ${res.status}): ${errText}`);
  }
}

function resolveSourceModel(params: Record<string, unknown>): {
  originalModelTaskId: string;
  sourceModelUrl: string;
} {
  const source = [
    params.model3d,
    params.model_3d,
    params.ref_model,
    params.output_model,
    params.input_model,
    params.model,
  ];
  const originalModelTaskId = firstText(
    params.tripo_model_task_id,
    params.original_model_task_id,
    params.model_task_id,
    params.tripo_task_id,
    extractTextField(source, [
      "tripo_model_task_id",
      "original_model_task_id",
      "model_task_id",
      "tripo_task_id",
      "task_id",
    ]),
  );
  if (!originalModelTaskId || /^https?:\/\//i.test(originalModelTaskId)) {
    throw new Error(
      "Tripo rigging needs a Tripo-generated 3D model. Wire the output from Image to 3D, Rig, or Animate so the original_model_task_id is available.",
    );
  }

  const sourceModelUrl = firstText(
    params.source_model_url,
    params.model_url,
    extractTextField(source, [
      "source_model_url",
      "model_url",
      "url",
      "preview_url",
    ]),
  );

  return { originalModelTaskId, sourceModelUrl };
}

function normalizeRigType(params: Record<string, unknown>): string {
  const rigType = String(params.rig_type ?? "").trim().toLowerCase();
  if (!rigType || rigType === "auto") {
    throw new Error(
      "Tripo rigging needs an explicit rig_type after Rig Check. Choose biped, quadruped, hexapod, octopod, avian, serpentine, or aquatic.",
    );
  }
  if (!TRIPO3D_RIG_TYPES.has(rigType)) {
    throw new Error(`Unsupported Tripo rig_type: ${rigType}`);
  }
  return rigType;
}

function normalizeOutFormat(params: Record<string, unknown>): "glb" | "fbx" {
  const format = String(params.out_format ?? params.format ?? "glb").trim().toLowerCase();
  return format === "fbx" ? "fbx" : "glb";
}

function normalizeAnimationPreset(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const preset = raw.startsWith("preset:") ? raw : `preset:${raw}`;
  return TRIPO3D_ANIMATION_PRESETS.has(preset) ? preset : "";
}

function collectAnimationPresets(params: Record<string, unknown>): string[] {
  const rawBatch = params.animations;
  const hasBatch = Array.isArray(rawBatch)
    ? rawBatch.length > 0
    : typeof rawBatch === "string" && rawBatch.trim().length > 0;
  const raw = hasBatch ? rawBatch : params.animation ?? "preset:walk";
  const pieces = Array.isArray(raw)
    ? raw
    : String(raw).split(/[\n,]+/);
  const presets = pieces
    .map((item) => normalizeAnimationPreset(String(item)))
    .filter(Boolean);
  return Array.from(new Set(presets)).slice(0, 5);
}

function baseProviderMeta(
  taskId: string,
  taskType: string,
  source?: { originalModelTaskId: string; sourceModelUrl: string },
): Record<string, unknown> {
  return {
    provider: "tripo3d",
    task_type: taskType,
    poll_endpoint: TRIPO3D_POLL_ENDPOINT,
    task_id: taskId,
    provider_task_id: taskId,
    ...(source
      ? {
          original_model_task_id: source.originalModelTaskId,
          tripo_model_task_id: source.originalModelTaskId,
          source_model_url: source.sourceModelUrl,
        }
      : {}),
  };
}

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
    output_type: "model_3d" as const,
    provider_meta: {
      provider: "tripo3d",
      model_version: modelVersion,
      task_type: taskType,
      input_image_count: imageUrls.length,
      poll_endpoint: TRIPO3D_POLL_ENDPOINT,
      task_id: taskId,
      provider_task_id: taskId,
      original_model_task_id: taskId,
      tripo_model_task_id: taskId,
    },
  };
}

export async function executeTripoImportModel(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const source = resolveExternalModelImport(params);
  const sourceRes = await fetch(source.sourceModelUrl);
  if (!sourceRes.ok) {
    throw new Error(`Could not fetch uploaded 3D model for Tripo import (HTTP ${sourceRes.status}).`);
  }
  const contentLength = Number(sourceRes.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > TRIPO3D_IMPORT_MAX_BYTES) {
    throw new Error("Tripo OpenAPI model upload currently supports files up to 20MB. Try a smaller GLB/OBJ/FBX/STL.");
  }
  const bytes = await sourceRes.arrayBuffer();
  if (bytes.byteLength > TRIPO3D_IMPORT_MAX_BYTES) {
    throw new Error("Tripo OpenAPI model upload currently supports files up to 20MB. Try a smaller GLB/OBJ/FBX/STL.");
  }
  const credentials = await requestTripoStsToken(source.format);
  await putObjectToTripoS3({
    credentials,
    bytes,
    contentType: sourceRes.headers.get("content-type") ?? contentTypeForModelFormat(source.format),
  });
  const taskId = await submitTripoTask({
    type: "import_model",
    file: {
      object: {
        bucket: credentials.bucket,
        key: credentials.key,
      },
    },
  }, "import model");
  console.log(`[tripo3d] import model task submitted task_id=${taskId.slice(0, 8)}...`);
  return {
    task_id: taskId,
    outputs: {},
    output_type: "model_3d",
    provider_meta: {
      ...baseProviderMeta(taskId, "import_model"),
      original_model_task_id: taskId,
      tripo_model_task_id: taskId,
      imported_source_model_url: source.sourceModelUrl,
      source_model_url: source.sourceModelUrl,
      source_file_name: source.sourceName,
      import_format: source.format,
    },
  };
}

export async function executeTripoPreRigCheck(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const source = resolveSourceModel(params);
  const taskId = await submitTripoTask({
    type: "animate_prerigcheck",
    original_model_task_id: source.originalModelTaskId,
  }, "pre-rig check");
  console.log(`[tripo3d] pre-rig task submitted task_id=${taskId.slice(0, 8)}...`);
  return {
    task_id: taskId,
    outputs: {},
    output_type: "model_3d",
    provider_meta: baseProviderMeta(taskId, "animate_prerigcheck", source),
  };
}

export async function executeTripoRig(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const source = resolveSourceModel(params);
  const outFormat = normalizeOutFormat(params);
  const spec = String(params.spec ?? "tripo").trim().toLowerCase() === "mixamo" ? "mixamo" : "tripo";
  const rigType = normalizeRigType(params);
  const taskId = await submitTripoTask({
    type: "animate_rig",
    original_model_task_id: source.originalModelTaskId,
    out_format: outFormat,
    model_version: "v2.5-20260210",
    rig_type: rigType,
    spec,
  }, "auto rig");
  console.log(`[tripo3d] rig task submitted task_id=${taskId.slice(0, 8)}...`);
  return {
    task_id: taskId,
    outputs: {},
    output_type: "model_3d",
    provider_meta: {
      ...baseProviderMeta(taskId, "animate_rig", source),
      out_format: outFormat,
      rig_type: rigType,
      spec,
    },
  };
}

export async function executeTripoRetarget(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const source = resolveSourceModel(params);
  const outFormat = normalizeOutFormat(params);
  const animations = collectAnimationPresets(params);
  if (animations.length === 0) {
    throw new Error("Pick at least one supported Tripo animation preset.");
  }
  const submitBody: Record<string, unknown> = {
    type: "animate_retarget",
    original_model_task_id: source.originalModelTaskId,
    out_format: outFormat,
    bake_animation: boolParam(params, "bake_animation", true),
    export_with_geometry: boolParam(params, "export_with_geometry", true),
    animate_in_place: boolParam(params, "animate_in_place", false),
  };
  if (animations.length === 1) {
    submitBody.animation = animations[0];
  } else {
    submitBody.animations = animations;
  }
  const taskId = await submitTripoTask(submitBody, "retarget animation");
  console.log(`[tripo3d] retarget task submitted task_id=${taskId.slice(0, 8)}...`);
  return {
    task_id: taskId,
    outputs: {},
    output_type: "model_3d",
    provider_meta: {
      ...baseProviderMeta(taskId, "animate_retarget", source),
      out_format: outFormat,
      animations,
    },
  };
}

export async function executeTripoConvert(
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const source = resolveSourceModel(params);
  const format = String(params.format ?? "GLTF").trim().toUpperCase();
  if (!TRIPO3D_CONVERT_FORMATS.has(format)) {
    throw new Error(`Unsupported Tripo export format: ${format}`);
  }
  const submitBody: Record<string, unknown> = {
    type: "convert_model",
    original_model_task_id: source.originalModelTaskId,
    format,
    with_animation: boolParam(params, "with_animation", true),
    animate_in_place: boolParam(params, "animate_in_place", false),
    quad: boolParam(params, "quad", false),
    force_symmetry: boolParam(params, "force_symmetry", false),
    flatten_bottom: boolParam(params, "flatten_bottom", false),
    pivot_to_center_bottom: boolParam(params, "pivot_to_center_bottom", false),
    pack_uv: boolParam(params, "pack_uv", true),
    bake: boolParam(params, "bake", true),
  };
  const textureSize = optionalNumber(params, "texture_size");
  const faceLimit = optionalNumber(params, "face_limit");
  const flattenBottomThreshold = optionalNumber(params, "flatten_bottom_threshold");
  const scaleFactor = optionalNumber(params, "scale_factor");
  if (textureSize !== undefined) submitBody.texture_size = textureSize;
  if (faceLimit !== undefined) submitBody.face_limit = faceLimit;
  if (flattenBottomThreshold !== undefined) submitBody.flatten_bottom_threshold = flattenBottomThreshold;
  if (scaleFactor !== undefined) submitBody.scale_factor = scaleFactor;
  const textureFormat = String(params.texture_format ?? "").trim().toUpperCase();
  if (textureFormat) submitBody.texture_format = textureFormat;
  const fbxPreset = String(params.fbx_preset ?? "").trim().toLowerCase();
  if (format === "FBX" && TRIPO3D_FBX_PRESETS.has(fbxPreset)) {
    submitBody.fbx_preset = fbxPreset;
  }
  const orientation = String(params.export_orientation ?? "").trim();
  if (orientation) submitBody.export_orientation = orientation;

  const taskId = await submitTripoTask(submitBody, "model conversion");
  console.log(`[tripo3d] conversion task submitted task_id=${taskId.slice(0, 8)}...`);
  return {
    task_id: taskId,
    outputs: {},
    output_type: "model_3d",
    provider_meta: {
      ...baseProviderMeta(taskId, "convert_model", source),
      format,
      fbx_preset: submitBody.fbx_preset,
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
