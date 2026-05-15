/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import type { ProviderResult } from "./providerResult.ts";

type UrlAssetFormat = "mp4" | "mp3" | "png";

interface UrlAssetTarget {
  format: UrlAssetFormat;
  outputType: ProviderResult["output_type"];
  primaryHandle: string;
  aliasHandle: string;
  fileType: "video" | "audio" | "image";
  contentType: string;
  acceptedContentTypes: string[];
  acceptedExtensions: string[];
  folder: string;
  maxBytes: number;
}

interface UrlAssetContext {
  projectId?: string | null;
  workspaceId?: string | null;
  canvasId?: string | null;
}

interface UrlAssetSupabaseClient {
  storage: {
    from: (bucket: string) => {
      upload: (
        path: string,
        body: ReadableStream<Uint8Array>,
        options: { contentType: string; upsert: boolean },
      ) => Promise<{ error: unknown | null }>;
      createSignedUrl: (
        path: string,
        expiresIn: number,
      ) => Promise<{ data: { signedUrl?: string } | null; error: unknown | null }>;
      createSignedUploadUrl: (
        path: string,
        options?: { upsert: boolean },
      ) => Promise<{ data: { signedUrl?: string; path?: string; token?: string } | null; error: unknown | null }>;
    };
  };
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => Promise<{ error: unknown | null }>;
  };
}

const MB = 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TARGETS: Record<UrlAssetFormat, UrlAssetTarget> = {
  mp4: {
    format: "mp4",
    outputType: "video_url",
    primaryHandle: "output_video",
    aliasHandle: "video_url",
    fileType: "video",
    contentType: "video/mp4",
    acceptedContentTypes: ["video/mp4", "application/mp4", "video/x-m4v"],
    acceptedExtensions: [".mp4", ".m4v"],
    folder: "url-imports/video",
    maxBytes: positiveIntEnv("URL_ASSET_MAX_VIDEO_MB", 256) * MB,
  },
  mp3: {
    format: "mp3",
    outputType: "audio_url",
    primaryHandle: "audio",
    aliasHandle: "audio_url",
    fileType: "audio",
    contentType: "audio/mpeg",
    acceptedContentTypes: ["audio/mpeg", "audio/mp3", "audio/mpeg3", "audio/x-mpeg"],
    acceptedExtensions: [".mp3"],
    folder: "url-imports/audio",
    maxBytes: positiveIntEnv("URL_ASSET_MAX_AUDIO_MB", 128) * MB,
  },
  png: {
    format: "png",
    outputType: "image_url",
    primaryHandle: "image",
    aliasHandle: "image_url",
    fileType: "image",
    contentType: "image/png",
    acceptedContentTypes: ["image/png", "image/x-png"],
    acceptedExtensions: [".png"],
    folder: "url-imports/image",
    maxBytes: positiveIntEnv("URL_ASSET_MAX_IMAGE_MB", 32) * MB,
  },
};

function parseOutputFormat(params: Record<string, unknown>): UrlAssetFormat {
  const raw = String(
    params.output_format ??
      params.target_format ??
      params.format ??
      params.model_name ??
      "url-to-png",
  ).toLowerCase();
  if (raw.includes("mp4") || raw.includes("video")) return "mp4";
  if (raw.includes("mp3") || raw.includes("audio")) return "mp3";
  return "png";
}

function readSourceUrl(params: Record<string, unknown>): string {
  for (const key of ["source_url", "url", "input_url", "prompt"]) {
    const value = String(params[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeExternalSource(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const facebookQuery = trimmed.replace(/^[?&]/, "");
  if (/^(?:fbid=|.*&fbid=)/i.test(facebookQuery)) {
    return `https://www.facebook.com/photo/?${facebookQuery}`;
  }

  const youtubeQuery = trimmed.replace(/^[?&]/, "");
  if (/^(?:v=|.*&v=)/i.test(youtubeQuery)) {
    const params = new URLSearchParams(youtubeQuery);
    const videoId = params.get("v")?.trim();
    if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  if (/^(?:www\.|m\.)?(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|fb\.watch)(?:\/|$)/i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (/youtube\.com$/i.test(parsed.hostname) && parsed.pathname === "/watch") {
      const videoId = parsed.searchParams.get("v")?.trim();
      if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    }
  } catch {
    // parseExternalUrl will return the validation error.
  }

  return trimmed;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isPrivateIpv4(host)) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

function parseExternalUrl(raw: string): URL {
  const normalized = normalizeExternalSource(raw);
  if (!normalized) {
    throw new Error("Validation: enter a direct media URL before running URL to Asset.");
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Validation: URL to Asset requires a valid http/https media URL, YouTube link, Instagram link, Facebook link, or YouTube v= video ID.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Validation: URL to Asset only accepts http or https URLs.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Validation: URL to Asset does not accept URLs with embedded credentials.");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error("Validation: URL to Asset cannot fetch private, local, or internal network URLs.");
  }
  return parsed;
}

function pathHasAcceptedExtension(url: URL, target: UrlAssetTarget): boolean {
  const path = decodeURIComponent(url.pathname).toLowerCase();
  return target.acceptedExtensions.some((ext) => path.endsWith(ext));
}

function isKnownWebPageHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    /(^|\.)youtube\.com$/i.test(host) ||
    /(^|\.)youtu\.be$/i.test(host) ||
    /(^|\.)instagram\.com$/i.test(host) ||
    /(^|\.)facebook\.com$/i.test(host) ||
    /(^|\.)fb\.watch$/i.test(host)
  );
}

function isLikelyWebPageUrl(url: URL, contentType: string): boolean {
  const cleanType = contentType.split(";")[0]?.trim().toLowerCase() || "";
  if (cleanType === "text/html" || cleanType === "application/xhtml+xml") return true;
  return isKnownWebPageHost(url);
}

function validateMediaType(url: URL, contentType: string, target: UrlAssetTarget): void {
  const cleanType = contentType.split(";")[0]?.trim().toLowerCase() || "";
  const contentTypeMatches = target.acceptedContentTypes.includes(cleanType);
  const extensionMatches = pathHasAcceptedExtension(url, target);
  if (contentTypeMatches || extensionMatches) return;

  if (isLikelyWebPageUrl(url, cleanType)) {
    throw new Error(
      `Validation: this page did not resolve to a downloadable ${target.format.toUpperCase()} asset. Use a public YouTube, Instagram, or Facebook link, or paste a direct .${target.format} file URL.`,
    );
  }

  const received = cleanType || "unknown content-type";
  throw new Error(
    `Validation: URL must point directly to a ${target.format.toUpperCase()} file. Received ${received}; use a direct .${target.format} URL.`,
  );
}

export function validateUrlAssetParams(params: Record<string, unknown>): void {
  const target = TARGETS[parseOutputFormat(params)];
  const source = parseExternalUrl(readSourceUrl(params));

  const path = decodeURIComponent(source.pathname).toLowerCase();
  const knownMediaExtensions = Object.values(TARGETS).flatMap((item) => item.acceptedExtensions);
  const hasKnownMediaExtension = knownMediaExtensions.some((ext) => path.endsWith(ext));
  const hasExpectedExtension = target.acceptedExtensions.some((ext) => path.endsWith(ext));
  if (!isKnownWebPageHost(source) && hasKnownMediaExtension && !hasExpectedExtension) {
    throw new Error(
      `Validation: selected URL to Asset model expects a direct ${target.format.toUpperCase()} URL. Change the model or paste a matching file URL.`,
    );
  }
}

async function fetchExternalMedia(url: URL, target: UrlAssetTarget): Promise<{ response: Response; finalUrl: URL }> {
  let current = url;
  for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
    const response = await fetch(current.toString(), {
      redirect: "manual",
      headers: {
        "Accept": target.contentType,
        "User-Agent": "MediaForge-URL-Asset-Import/1.0",
      },
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    if (isRedirect) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Validation: URL redirected without a Location header.");
      current = parseExternalUrl(new URL(location, current).toString());
      continue;
    }

    return { response, finalUrl: current };
  }
  throw new Error("Validation: URL redirected too many times.");
}

function limitResponseBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): ReadableStream<Uint8Array> {
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            throw new Error(
              `Validation: ${label} is larger than ${Math.round(maxBytes / MB)} MB. Upload the file directly instead.`,
            );
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
        try {
          await reader.cancel(error);
        } catch {
          // best effort
        }
      }
    },
  });
}

function safeName(raw: unknown, fallback: string): string {
  const base = String(raw ?? "")
    .trim()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return base || fallback;
}

function storagePathForUrlAsset(userId: string, target: UrlAssetTarget): string {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `${userId}/${target.folder}/mediaforge_${Date.now()}_${id}.${target.format}`;
}

async function createUrlAssetRecord(args: {
  supabase: UrlAssetSupabaseClient;
  userId: string;
  target: UrlAssetTarget;
  fileName: string;
  assetUrl: string;
  storagePath: string;
  context: UrlAssetContext;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const assetRow: Record<string, unknown> = {
    user_id: args.userId,
    name: `${args.fileName}.${args.target.format}`,
    file_url: args.assetUrl,
    file_type: args.target.fileType,
    source: "upload",
    category: "url_import",
    project_id: args.context.projectId ?? null,
    workspace_id: args.context.workspaceId ?? null,
    canvas_id: args.context.canvasId ?? null,
    metadata: args.metadata,
  };

  const insert = await args.supabase.from("user_assets").insert(assetRow);
  if (insert.error) {
    console.warn("[url-asset] user_assets insert warning:", insert.error);
  }
}

async function executeSocialUrlAsset(args: {
  params: Record<string, unknown>;
  supabase: UrlAssetSupabaseClient;
  userId: string;
  context: UrlAssetContext;
  source: URL;
  target: UrlAssetTarget;
}): Promise<ProviderResult> {
  const downloaderUrl = Deno.env.get("URL_ASSET_SOCIAL_DOWNLOADER_URL")?.trim();
  const downloaderSecret = Deno.env.get("URL_ASSET_SOCIAL_DOWNLOADER_SECRET")?.trim();
  if (!downloaderUrl || !downloaderSecret) {
    throw new Error(
      "Validation: social downloader is not configured. Direct MP4, MP3, and PNG file URLs still work.",
    );
  }

  const fileName = safeName(args.params.file_name, `URL ${args.target.format.toUpperCase()}`);
  const storagePath = storagePathForUrlAsset(args.userId, args.target);
  const signedUpload = await args.supabase.storage
    .from("user_assets")
    .createSignedUploadUrl(storagePath, { upsert: false });
  if (signedUpload.error || !signedUpload.data?.signedUrl) {
    console.error("[url-asset] signed upload URL error:", signedUpload.error);
    throw new Error("Failed to prepare URL asset upload. Please try again.");
  }

  const response = await fetch(downloaderUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${downloaderSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_url: args.source.toString(),
      output_format: args.target.format,
      file_name: fileName,
      max_bytes: args.target.maxBytes,
      upload: {
        signed_url: signedUpload.data.signedUrl,
        path: storagePath,
      },
    }),
  });

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    const message = String(payload.error || `social downloader failed (${response.status})`);
    throw new Error(`Validation: ${message}`);
  }

  const contentType = String(payload.content_type || args.target.contentType).split(";")[0]?.trim().toLowerCase();
  validateMediaType(new URL(`https://mediaforge.local/social.${args.target.format}`), contentType, args.target);

  const signed = await args.supabase.storage
    .from("user_assets")
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    console.error("[url-asset] signed URL error:", signed.error);
    throw new Error("Failed to save URL asset. Please try again.");
  }

  const assetUrl = signed.data.signedUrl;
  const bytes = Number(payload.bytes);
  await createUrlAssetRecord({
    supabase: args.supabase,
    userId: args.userId,
    target: args.target,
    fileName,
    assetUrl,
    storagePath,
    context: args.context,
    metadata: {
      provider: "url_asset",
      extractor: String(payload.extractor || "social_downloader"),
      source_url: args.source.toString(),
      final_url: args.source.toString(),
      storage_path: storagePath,
      requested_format: args.target.format,
      content_type: contentType,
      source_content_type: "social_page",
      content_length: Number.isFinite(bytes) ? bytes : null,
    },
  });

  return {
    result_url: assetUrl,
    output_type: args.target.outputType,
    outputs: {
      [args.target.primaryHandle]: assetUrl,
      [args.target.aliasHandle]: assetUrl,
    },
    provider_meta: {
      provider: "url_asset",
      model: `url-to-${args.target.format}`,
      extractor: String(payload.extractor || "social_downloader"),
      source_url: args.source.toString(),
      final_url: args.source.toString(),
      storage_path: storagePath,
      content_type: contentType,
      source_content_type: "social_page",
    },
  };
}

export async function executeUrlAsset(
  params: Record<string, unknown>,
  supabaseClient: unknown,
  userId: string,
  context: UrlAssetContext = {},
): Promise<ProviderResult> {
  const supabase = supabaseClient as UrlAssetSupabaseClient;
  const format = parseOutputFormat(params);
  const target = TARGETS[format];
  const source = parseExternalUrl(readSourceUrl(params));
  if (isKnownWebPageHost(source)) {
    return executeSocialUrlAsset({ params, supabase, userId, context, source, target });
  }

  const { response, finalUrl } = await fetchExternalMedia(source, target);

  if (!response.ok) {
    throw new Error(`Validation: source URL returned HTTP ${response.status}.`);
  }
  if (!response.body) {
    throw new Error("Validation: source URL returned an empty response body.");
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "";
  validateMediaType(finalUrl, contentType, target);
  const uploadContentType = target.acceptedContentTypes.includes(contentType)
    ? contentType
    : target.contentType;

  const contentLength = response.headers.get("content-length");
  const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : null;
  if (parsedLength != null && Number.isFinite(parsedLength) && parsedLength > target.maxBytes) {
    throw new Error(
      `Validation: ${format.toUpperCase()} file is larger than ${Math.round(target.maxBytes / MB)} MB. Upload the file directly instead.`,
    );
  }

  const fileName = safeName(params.file_name, `URL ${format.toUpperCase()}`);
  const storagePath = storagePathForUrlAsset(userId, target);
  const limitedBody = limitResponseBody(response.body, target.maxBytes, `${format.toUpperCase()} file`);

  const upload = await supabase.storage
    .from("user_assets")
    .upload(storagePath, limitedBody, { contentType: uploadContentType, upsert: false });
  if (upload.error) {
    console.error("[url-asset] upload error:", upload.error);
    throw new Error("Failed to save URL asset. Please try again.");
  }

  const signed = await supabase.storage
    .from("user_assets")
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    console.error("[url-asset] signed URL error:", signed.error);
    throw new Error("Failed to save URL asset. Please try again.");
  }

  const assetUrl = signed.data.signedUrl;
  await createUrlAssetRecord({
    supabase,
    userId,
    target,
    fileName,
    assetUrl,
    storagePath,
    context,
    metadata: {
      provider: "url_asset",
      source_url: source.toString(),
      final_url: finalUrl.toString(),
      storage_path: storagePath,
      requested_format: format,
      content_type: uploadContentType,
      source_content_type: contentType || null,
      content_length: Number.isFinite(parsedLength ?? NaN) ? parsedLength : null,
    },
  });

  return {
    result_url: assetUrl,
    output_type: target.outputType,
    outputs: {
      [target.primaryHandle]: assetUrl,
      [target.aliasHandle]: assetUrl,
    },
    provider_meta: {
      provider: "url_asset",
      model: `url-to-${format}`,
      source_url: source.toString(),
      final_url: finalUrl.toString(),
      storage_path: storagePath,
      content_type: uploadContentType,
      source_content_type: contentType || null,
    },
  };
}
