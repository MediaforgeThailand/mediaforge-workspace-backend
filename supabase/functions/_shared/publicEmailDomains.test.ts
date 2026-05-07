/// <reference lib="deno.ns" />
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PUBLIC_EMAIL_DOMAINS,
  assertPrivateEmailDomain,
  isPublicEmailDomain,
  normalizeEmailDomain,
} from "./publicEmailDomains.ts";

Deno.test("normalizeEmailDomain trims, lowercases, and strips leading @", () => {
  assertEquals(normalizeEmailDomain("  GMAIL.com  "), "gmail.com");
  assertEquals(normalizeEmailDomain("@yahoo.com"), "yahoo.com");
  assertEquals(normalizeEmailDomain("@@@protonmail.com"), "protonmail.com");
  assertEquals(normalizeEmailDomain(""), "");
});

Deno.test("normalizeEmailDomain coerces non-string input safely", () => {
  // Cast to bypass TS — runtime guards handle nullish gracefully
  // deno-lint-ignore no-explicit-any
  assertEquals(normalizeEmailDomain(null as any), "");
  // deno-lint-ignore no-explicit-any
  assertEquals(normalizeEmailDomain(undefined as any), "");
});

Deno.test("isPublicEmailDomain matches every entry in the curated set", () => {
  for (const domain of PUBLIC_EMAIL_DOMAINS) {
    assertEquals(isPublicEmailDomain(domain), true, `expected ${domain} to be public`);
  }
});

Deno.test("isPublicEmailDomain treats casing/whitespace consistently", () => {
  assertEquals(isPublicEmailDomain("GMAIL.com"), true);
  assertEquals(isPublicEmailDomain(" outlook.com "), true);
  assertEquals(isPublicEmailDomain("@hotmail.com"), true);
});

Deno.test("isPublicEmailDomain rejects org-style domains", () => {
  assertEquals(isPublicEmailDomain("mediaforge.co"), false);
  assertEquals(isPublicEmailDomain("acme.org"), false);
  assertEquals(isPublicEmailDomain("school.ac.th"), false);
});

Deno.test("assertPrivateEmailDomain throws on public domains", () => {
  assertThrows(
    () => assertPrivateEmailDomain("gmail.com"),
    Error,
    "Public email domains cannot be used",
  );
});

Deno.test("assertPrivateEmailDomain returns normalized form for private domains", () => {
  assertEquals(assertPrivateEmailDomain("ACME.com"), "acme.com");
  assertEquals(assertPrivateEmailDomain("@school.ac.th"), "school.ac.th");
});
