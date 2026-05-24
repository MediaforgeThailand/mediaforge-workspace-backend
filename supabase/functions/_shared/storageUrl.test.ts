/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseSupabaseStorageUrl,
  publicizeSupabaseStorageUrl,
} from "./storageUrl.ts";

Deno.test("parseSupabaseStorageUrl parses signed storage object URLs", () => {
  const parsed = parseSupabaseStorageUrl(
    "http://kong:8000/storage/v1/object/sign/ai-media/user-id/file.png?token=abc",
    "http://kong:8000",
  );

  assertEquals(parsed, {
    bucket: "ai-media",
    path: "user-id/file.png",
  });
});

Deno.test("publicizeSupabaseStorageUrl rewrites local Kong storage URLs", () => {
  const out = publicizeSupabaseStorageUrl(
    "http://kong:8000/storage/v1/object/sign/ai-media/user-id/file.png?token=abc",
    {
      internalSupabaseUrl: "http://kong:8000",
      publicSupabaseUrl: "http://127.0.0.1:56321",
    },
  );

  assertEquals(
    out,
    "http://127.0.0.1:56321/storage/v1/object/sign/ai-media/user-id/file.png?token=abc",
  );
});

Deno.test("publicizeSupabaseStorageUrl leaves provider URLs untouched", () => {
  const input = "https://cdn.example.com/image.png";
  assertEquals(
    publicizeSupabaseStorageUrl(input, {
      internalSupabaseUrl: "http://kong:8000",
      publicSupabaseUrl: "http://127.0.0.1:56321",
    }),
    input,
  );
});

Deno.test("publicizeSupabaseStorageUrl leaves already-public storage URLs untouched", () => {
  const input =
    "http://127.0.0.1:56321/storage/v1/object/sign/ai-media/user-id/file.png?token=abc";
  assertEquals(
    publicizeSupabaseStorageUrl(input, {
      internalSupabaseUrl: "http://kong:8000",
      publicSupabaseUrl: "http://127.0.0.1:56321",
    }),
    input,
  );
});
