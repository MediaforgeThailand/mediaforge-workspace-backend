/// <reference lib="deno.ns" />

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseJpegInfo, prepareReferenceImage } from "./imageValidation.ts";
import {
  coerceOpenAIEditSize,
  detectOpenAIImageFile,
  isValidGptImage2FlexibleSize,
  normalizeOpenAIImageGenerationSize,
  toSupabaseRenderUrlForOpenAI,
} from "./imageUtils.ts";

// Minimal valid baseline JPEG with no EXIF, 1x1 pixel, used as a
// fast-path control. Bytes generated via jpeg-js from a single black
// pixel.
const TINY_BASELINE_JPEG_1x1 = new Uint8Array([
  0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,
  0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,
  0x07,0x07,0x07,0x09,0x09,0x08,0x0A,0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,
  0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,0x24,0x2E,0x27,0x20,
  0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,0x1F,0x27,
  0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,
  0x00,0x01,0x01,0x01,0x11,0x00,0xFF,0xC4,0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,
  0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,
  0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0xFF,0xC4,0x00,0xB5,0x10,0x00,0x02,0x01,0x03,
  0x03,0x02,0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7D,0x01,0x02,0x03,0x00,
  0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,
  0x81,0x91,0xA1,0x08,0x23,0x42,0xB1,0xC1,0x15,0x52,0xD1,0xF0,0x24,0x33,0x62,0x72,
  0x82,0x09,0x0A,0x16,0x17,0x18,0x19,0x1A,0x25,0x26,0x27,0x28,0x29,0x2A,0x34,0x35,
  0x36,0x37,0x38,0x39,0x3A,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4A,0x53,0x54,0x55,
  0x56,0x57,0x58,0x59,0x5A,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6A,0x73,0x74,0x75,
  0x76,0x77,0x78,0x79,0x7A,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8A,0x92,0x93,0x94,
  0x95,0x96,0x97,0x98,0x99,0x9A,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,0xA8,0xA9,0xAA,0xB2,
  0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,0xC8,0xC9,
  0xCA,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xE1,0xE2,0xE3,0xE4,0xE5,0xE6,
  0xE7,0xE8,0xE9,0xEA,0xF1,0xF2,0xF3,0xF4,0xF5,0xF6,0xF7,0xF8,0xF9,0xFA,0xFF,0xDA,
  0x00,0x08,0x01,0x01,0x00,0x00,0x3F,0x00,0xFB,0xD2,0xFF,0xD9,
]);

Deno.test("coerceOpenAIEditSize: passes through supported sizes", () => {
  assertEquals(coerceOpenAIEditSize("1024x1024"), "1024x1024");
  assertEquals(coerceOpenAIEditSize("1024x1536"), "1024x1536");
  assertEquals(coerceOpenAIEditSize("1536x1024"), "1536x1024");
  assertEquals(coerceOpenAIEditSize("auto"), "auto");
});

Deno.test("coerceOpenAIEditSize: portrait ratio → 1024x1536", () => {
  // The exact value the user's failing requests sent.
  assertEquals(coerceOpenAIEditSize("1024x1280"), "1024x1536");
  assertEquals(coerceOpenAIEditSize("768x1024"), "1024x1536");
});

Deno.test("coerceOpenAIEditSize: landscape ratio → 1536x1024", () => {
  assertEquals(coerceOpenAIEditSize("1920x1080"), "1536x1024");
  assertEquals(coerceOpenAIEditSize("1280x1024"), "1536x1024");
});

Deno.test("coerceOpenAIEditSize: near-square → 1024x1024", () => {
  assertEquals(coerceOpenAIEditSize("1024x1024"), "1024x1024");
  assertEquals(coerceOpenAIEditSize("1000x1010"), "1024x1024");
});

Deno.test("coerceOpenAIEditSize: garbage → 1024x1024 fallback", () => {
  assertEquals(coerceOpenAIEditSize(""), "1024x1024");
  assertEquals(coerceOpenAIEditSize("garbage"), "1024x1024");
  assertEquals(coerceOpenAIEditSize("0x0"), "1024x1024");
});

Deno.test("normalizeOpenAIImageGenerationSize: preserves valid gpt-image-2 flexible sizes", () => {
  assertEquals(isValidGptImage2FlexibleSize("1280x720"), true);
  assertEquals(isValidGptImage2FlexibleSize("2048x1152"), true);
  assertEquals(isValidGptImage2FlexibleSize("3840x2160"), true);
  assertEquals(normalizeOpenAIImageGenerationSize("1280x720"), "1280x720");
  assertEquals(normalizeOpenAIImageGenerationSize("2048x1152"), "2048x1152");
  assertEquals(normalizeOpenAIImageGenerationSize("3840x2160"), "3840x2160");
});

Deno.test("normalizeOpenAIImageGenerationSize: invalid custom sizes fall back to legacy presets", () => {
  assertEquals(isValidGptImage2FlexibleSize("1537x864"), false);
  assertEquals(isValidGptImage2FlexibleSize("4096x2304"), false);
  assertEquals(isValidGptImage2FlexibleSize("4000x1000"), false);
  assertEquals(normalizeOpenAIImageGenerationSize("1537x864"), "1536x1024");
  assertEquals(normalizeOpenAIImageGenerationSize("4096x2304"), "1536x1024");
  assertEquals(normalizeOpenAIImageGenerationSize("4000x1000"), "1536x1024");
});

Deno.test("toSupabaseRenderUrlForOpenAI: Supabase JPEG sign URL is rewritten", () => {
  const input = "https://fymncypboeubdikpbmqc.supabase.co/storage/v1/object/sign/ai-media/foo/bar.jpeg?token=abc";
  const out = toSupabaseRenderUrlForOpenAI(input);
  const parsed = new URL(out);
  assertEquals(parsed.pathname, "/storage/v1/render/image/sign/ai-media/foo/bar.jpeg");
  assertEquals(parsed.searchParams.get("token"), "abc");
  assertEquals(parsed.searchParams.get("width"), "2048");
  assertEquals(parsed.searchParams.get("height"), "2048");
  assertEquals(parsed.searchParams.get("resize"), "contain");
});

Deno.test("toSupabaseRenderUrlForOpenAI: public URL also rewritten", () => {
  const input = "https://example.supabase.co/storage/v1/object/public/ai-media/x.jpg";
  const out = toSupabaseRenderUrlForOpenAI(input);
  assertEquals(new URL(out).pathname, "/storage/v1/render/image/public/ai-media/x.jpg");
});

Deno.test("toSupabaseRenderUrlForOpenAI: PNG URLs pass through unchanged", () => {
  const input = "https://example.supabase.co/storage/v1/object/sign/ai-media/x.png?token=abc";
  assertEquals(toSupabaseRenderUrlForOpenAI(input), input);
});

Deno.test("toSupabaseRenderUrlForOpenAI: non-Supabase URLs pass through unchanged", () => {
  const input = "https://cdn.example.com/photo.jpg";
  assertEquals(toSupabaseRenderUrlForOpenAI(input), input);
});

Deno.test("toSupabaseRenderUrlForOpenAI: already-rendered URLs pass through unchanged", () => {
  const input = "https://example.supabase.co/storage/v1/render/image/sign/ai-media/x.jpeg?token=abc&width=512";
  assertEquals(toSupabaseRenderUrlForOpenAI(input), input);
});

Deno.test("parseJpegInfo: tiny baseline JPEG with no EXIF", () => {
  const info = parseJpegInfo(TINY_BASELINE_JPEG_1x1);
  assertExists(info);
  assertEquals(info.width, 1);
  assertEquals(info.height, 1);
  assertEquals(info.components, 1);
  assertEquals(info.isBaseline, true);
  assertEquals(info.isProgressive, false);
  assertEquals(info.exifOrientation, null);
});

Deno.test("parseJpegInfo: rejects non-JPEG bytes", () => {
  assertEquals(parseJpegInfo(new Uint8Array([0x89, 0x50, 0x4E, 0x47])), null);
  assertEquals(parseJpegInfo(new Uint8Array([0, 0])), null);
});

Deno.test("prepareReferenceImage: PNG/WEBP pass through unchanged", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
  const detected = detectOpenAIImageFile(png);
  assertExists(detected);
  const out = await prepareReferenceImage(png, detected, 0);
  assertEquals(out.reencoded, false);
  assertEquals(out.bytes, png);
});

Deno.test("prepareReferenceImage: clean baseline JPEG passes through", async () => {
  const detected = detectOpenAIImageFile(TINY_BASELINE_JPEG_1x1);
  assertExists(detected);
  const out = await prepareReferenceImage(TINY_BASELINE_JPEG_1x1, detected, 0);
  assertEquals(out.reencoded, false);
  assertEquals(out.reason, undefined);
});
