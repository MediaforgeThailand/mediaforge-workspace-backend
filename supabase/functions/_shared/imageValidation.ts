/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { OPENAI_IMAGE_MAX_BYTES, openAIReferenceImageError } from "./imageUtils.ts";

// gpt-image-1 accepts ≤4096px per side (verified 2026-05-16). We
// downscale anything larger before re-encode rather than risking a
// silent provider-side resample.
const OPENAI_INPUT_MAX_DIM = 4096;

// jpeg-js raises if a decoded image exceeds maxResolutionInMP. iPhone
// 13 Pro shots are ~12 MP; 200 MP is a generous ceiling that still
// blocks runaway inputs.
const JPEG_MAX_DECODE_MP = 200;

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  isBaseline: boolean;
  isProgressive: boolean;
  exifOrientation: number | null;
}

// Walk JPEG markers to extract SOF (width/height/components/encoding)
// and EXIF orientation. Returns null if the file is malformed enough
// that no SOF segment was found before the entropy-coded stream
// (`SOS`) — caller treats that as corrupt.
export function parseJpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  const info: Partial<JpegInfo> = { exifOrientation: null };
  let i = 2;
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    while (i < bytes.length - 1 && bytes[i + 1] === 0xFF) i++;
    const marker = bytes[i + 1];
    i += 2;
    if (marker === 0xD9 || marker === 0xDA) break; // EOI or SOS
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue; // TEM / RST*
    if (i + 1 >= bytes.length) return null;
    const segLen = (bytes[i] << 8) | bytes[i + 1];
    if (segLen < 2 || i + segLen > bytes.length) return null;

    // SOF range is 0xC0–0xCF excluding 0xC4 (DHT) and 0xC8 (JPG-ext)
    // and 0xCC (DAC). Width/height/components live in every SOF.
    if (
      marker >= 0xC0 && marker <= 0xCF &&
      marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
    ) {
      if (segLen < 8) return null;
      info.height = (bytes[i + 3] << 8) | bytes[i + 4];
      info.width = (bytes[i + 5] << 8) | bytes[i + 6];
      info.components = bytes[i + 7];
      info.isBaseline = marker === 0xC0;
      info.isProgressive = marker === 0xC2;
    } else if (marker === 0xE1 && segLen >= 14) {
      // APP1 header is "Exif\0\0" then TIFF; if it's XMP we ignore
      if (
        bytes[i + 2] === 0x45 && bytes[i + 3] === 0x78 &&
        bytes[i + 4] === 0x69 && bytes[i + 5] === 0x66
      ) {
        info.exifOrientation = readExifOrientation(bytes, i + 8, i + segLen);
      }
    }
    i += segLen;
  }
  if (info.width === undefined) return null;
  return info as JpegInfo;
}

function readExifOrientation(bytes: Uint8Array, tiffStart: number, end: number): number | null {
  if (tiffStart + 8 > end) return null;
  let little: boolean;
  if (bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49) little = true;
  else if (bytes[tiffStart] === 0x4D && bytes[tiffStart + 1] === 0x4D) little = false;
  else return null;
  const u16 = (off: number) => little
    ? bytes[off] | (bytes[off + 1] << 8)
    : (bytes[off] << 8) | bytes[off + 1];
  const u32 = (off: number) => little
    ? (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
    : ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
  if (u16(tiffStart + 2) !== 0x002A) return null;
  const ifdOffset = u32(tiffStart + 4);
  const ifd0 = tiffStart + ifdOffset;
  if (ifd0 + 2 > end) return null;
  const numEntries = u16(ifd0);
  for (let e = 0; e < numEntries; e++) {
    const entry = ifd0 + 2 + e * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      // Orientation is SHORT (type 3); value sits in the first 2
      // bytes of the 4-byte value field.
      if (u16(entry + 2) !== 3) return null;
      return u16(entry + 8);
    }
  }
  return null;
}

export interface ReferenceImagePrep {
  bytes: Uint8Array;
  mime: string;
  ext: "png" | "jpg" | "webp";
  reencoded: boolean;
  reason?: string;
}

// Decide whether a reference image needs decode + re-encode before
// shipping to OpenAI /v1/images/edits, and do it if so. Triggers:
//   * EXIF orientation tag != 1 — OpenAI's decoder hard-rejects with
//     "Invalid image file or mode for image N" (verified live).
//   * Progressive JPEG — same provider-side fragility on some uploads.
//   * CMYK JPEG (4 components) — gpt-image-1 expects RGB.
//   * Either side > OPENAI_INPUT_MAX_DIM — silent server-side
//     downscale risks moderation-trip variance; normalise here.
//   * Corrupt JPEG (no SOF found) — surface a clear user error
//     instead of letting OpenAI return its opaque 400.
// PNG/WEBP pass through unchanged: they don't carry EXIF orientation
// risk and OpenAI rarely 400s them.
export async function prepareReferenceImage(
  bytes: Uint8Array,
  detected: { mime: string; ext: "png" | "jpg" | "webp" },
  index: number,
): Promise<ReferenceImagePrep> {
  if (detected.ext !== "jpg") {
    return { bytes, mime: detected.mime, ext: detected.ext, reencoded: false };
  }

  const info = parseJpegInfo(bytes);
  if (!info) {
    throw openAIReferenceImageError(
      index,
      "JPEG file appears corrupt or truncated. Please re-export the image as a standard baseline JPEG, PNG, or WEBP.",
    );
  }

  const issues: string[] = [];
  if (info.exifOrientation !== null && info.exifOrientation !== 1) {
    issues.push(`exif-orientation=${info.exifOrientation}`);
  }
  if (info.isProgressive) issues.push("progressive");
  if (info.components === 4) issues.push("cmyk");
  if (info.width > OPENAI_INPUT_MAX_DIM || info.height > OPENAI_INPUT_MAX_DIM) {
    issues.push(`oversize=${info.width}x${info.height}`);
  }
  if (issues.length === 0) {
    return { bytes, mime: detected.mime, ext: detected.ext, reencoded: false };
  }

  const reason = issues.join(",");
  console.log(`[openai-image-2] ref ${index + 1}: re-encoding (${reason}), input=${bytes.byteLength}B`);

  const jpeg = await loadJpegJs();
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: JPEG_MAX_DECODE_MP,
    });
  } catch (err) {
    throw openAIReferenceImageError(
      index,
      `JPEG could not be decoded (${err instanceof Error ? err.message : String(err)}). Please re-export as a standard baseline JPEG, PNG, or WEBP.`,
    );
  }

  let { width, height, data } = decoded;
  const orientation = info.exifOrientation ?? 1;
  if (orientation >= 2 && orientation <= 8) {
    ({ data, width, height } = applyExifOrientation(data, width, height, orientation));
  }
  if (width > OPENAI_INPUT_MAX_DIM || height > OPENAI_INPUT_MAX_DIM) {
    ({ data, width, height } = downscaleRgba(data, width, height, OPENAI_INPUT_MAX_DIM));
  }

  const encoded = jpeg.encode({ data, width, height }, 92);
  const outBytes: Uint8Array = encoded.data instanceof Uint8Array
    ? encoded.data
    : new Uint8Array(encoded.data);
  if (outBytes.byteLength > OPENAI_IMAGE_MAX_BYTES) {
    throw openAIReferenceImageError(
      index,
      "re-encoded image still exceeds 50MB after compression. Please reduce dimensions before uploading.",
    );
  }
  console.log(`[openai-image-2] ref ${index + 1}: re-encoded ${bytes.byteLength}B → ${outBytes.byteLength}B (${width}x${height})`);
  return { bytes: outBytes, mime: "image/jpeg", ext: "jpg", reencoded: true, reason };
}

// Bake an EXIF orientation tag into RGBA pixels. Values 1–8 per the
// EXIF spec; 5–8 swap dst width/height.
function applyExifOrientation(
  src: Uint8Array,
  width: number,
  height: number,
  orientation: number,
): { data: Uint8Array; width: number; height: number } {
  const swapDims = orientation >= 5;
  const dstWidth = swapDims ? height : width;
  const dstHeight = swapDims ? width : height;
  const dst = new Uint8Array(dstWidth * dstHeight * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number, dy: number;
      switch (orientation) {
        case 2: dx = width - 1 - x; dy = y; break;
        case 3: dx = width - 1 - x; dy = height - 1 - y; break;
        case 4: dx = x; dy = height - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = height - 1 - y; dy = x; break;
        case 7: dx = height - 1 - y; dy = width - 1 - x; break;
        case 8: dx = y; dy = width - 1 - x; break;
        default: dx = x; dy = y;
      }
      const sIdx = (y * width + x) * 4;
      const dIdx = (dy * dstWidth + dx) * 4;
      dst[dIdx] = src[sIdx];
      dst[dIdx + 1] = src[sIdx + 1];
      dst[dIdx + 2] = src[sIdx + 2];
      dst[dIdx + 3] = src[sIdx + 3];
    }
  }
  return { data: dst, width: dstWidth, height: dstHeight };
}

function downscaleRgba(
  src: Uint8Array,
  width: number,
  height: number,
  maxDim: number,
): { data: Uint8Array; width: number; height: number } {
  const scale = maxDim / Math.max(width, height);
  if (scale >= 1) return { data: src, width, height };
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));
  const dst = new Uint8Array(dw * dh * 4);
  const xRatio = width / dw;
  const yRatio = height / dh;
  for (let y = 0; y < dh; y++) {
    const sy = y * yRatio;
    const sy0 = Math.floor(sy);
    const sy1 = Math.min(height - 1, sy0 + 1);
    const fy = sy - sy0;
    for (let x = 0; x < dw; x++) {
      const sx = x * xRatio;
      const sx0 = Math.floor(sx);
      const sx1 = Math.min(width - 1, sx0 + 1);
      const fx = sx - sx0;
      const i00 = (sy0 * width + sx0) * 4;
      const i01 = (sy0 * width + sx1) * 4;
      const i10 = (sy1 * width + sx0) * 4;
      const i11 = (sy1 * width + sx1) * 4;
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = (1 - fx) * (1 - fy) * src[i00 + c]
                + fx       * (1 - fy) * src[i01 + c]
                + (1 - fx) * fy       * src[i10 + c]
                + fx       * fy       * src[i11 + c];
        dst[di + c] = Math.round(v);
      }
    }
  }
  return { data: dst, width: dw, height: dh };
}

interface JpegJsModule {
  decode: (
    bytes: Uint8Array,
    opts: { useTArray: boolean; formatAsRGBA: boolean; maxResolutionInMP: number },
  ) => { width: number; height: number; data: Uint8Array };
  encode: (
    image: { data: Uint8Array; width: number; height: number },
    quality: number,
  ) => { data: Uint8Array | ArrayBuffer; width: number; height: number };
}

let jpegJsCache: JpegJsModule | null = null;

async function loadJpegJs(): Promise<JpegJsModule> {
  if (jpegJsCache) return jpegJsCache;
  const mod = await import("https://esm.sh/jpeg-js@0.4.4");
  // jpeg-js ships as CJS-default + named; esm.sh normalises both. Try
  // the default export first, then the namespace.
  const candidate = (mod.default ?? mod) as JpegJsModule;
  if (typeof candidate.decode !== "function" || typeof candidate.encode !== "function") {
    throw new Error("jpeg-js module did not expose decode/encode");
  }
  jpegJsCache = candidate;
  return jpegJsCache;
}
