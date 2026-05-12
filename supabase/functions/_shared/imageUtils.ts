/// <reference lib="deno.ns" />
/// <reference lib="dom" />

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function fetchImageBuffer(url: string): Promise<Uint8Array> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:[^;]+;base64,(.+)$/);
    if (match) {
      const bin = atob(match[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    throw new Error("Invalid data URI");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function imageUrlToBase64(url: string): Promise<string> {
  return bytesToBase64(await fetchImageBuffer(url));
}

export const OPENAI_IMAGE_MAX_BYTES = 50 * 1024 * 1024;

export function detectOpenAIImageFile(bytes: Uint8Array): { mime: string; ext: "png" | "jpg" | "webp" } | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4E &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0D &&
    bytes[5] === 0x0A &&
    bytes[6] === 0x1A &&
    bytes[7] === 0x0A
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export function openAIReferenceImageError(index: number, message: string): Error {
  return new Error(`Reference image ${index + 1} is invalid for GPT Image 2: ${message}`);
}

export interface ImageDimensions { width: number; height: number }

export function extractImageDimensions(buf: Uint8Array): ImageDimensions | null {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
      const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
      return { width, height };
    }
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xFF) { offset++; continue; }
        const marker = buf[offset + 1];
        if (marker >= 0xC0 && marker <= 0xC3 && marker !== 0xC1) {
          const height = (buf[offset + 5] << 8) | buf[offset + 6];
          const width = (buf[offset + 7] << 8) | buf[offset + 8];
          return { width, height };
        }
        const segLen = (buf[offset + 2] << 8) | buf[offset + 3];
        offset += 2 + segLen;
      }
    }
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
        const width = ((buf[26] | (buf[27] << 8)) & 0x3FFF);
        const height = ((buf[28] | (buf[29] << 8)) & 0x3FFF);
        return { width, height };
      }
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4C) {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        const width = 1 + (((b1 & 0x3F) << 8) | b0);
        const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 >> 6) & 0x03));
        return { width, height };
      }
    }
  } catch (e) {
    console.warn("[aspect-ratio] Header parse error:", e);
  }
  return null;
}

const KLING_SUPPORTED_RATIOS: Array<{ label: string; value: number }> = [
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "1:1",  value: 1 },
];

export function extractProviderMediaUrl(value: unknown): string {
  if (typeof value === "string") {
    return /^https:\/\//i.test(value) ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractProviderMediaUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    for (const key of ["url", "image", "image_url", "output", "download_url"]) {
      const found = extractProviderMediaUrl(row[key]);
      if (found) return found;
    }
    for (const nested of Object.values(row)) {
      const found = extractProviderMediaUrl(nested);
      if (found) return found;
    }
  }
  return "";
}

export function findClosestAspectRatio(width: number, height: number): string {
  const actual = width / height;
  let bestLabel = "16:9";
  let bestDiff = Infinity;
  for (const r of KLING_SUPPORTED_RATIOS) {
    const diff = Math.abs(actual - r.value);
    if (diff < bestDiff) { bestDiff = diff; bestLabel = r.label; }
  }
  console.log(`[aspect-ratio] Image ${width}×${height} (ratio=${actual.toFixed(4)}) → matched "${bestLabel}" (diff=${bestDiff.toFixed(4)})`);
  return bestLabel;
}
