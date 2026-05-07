/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getAuthUser, isServiceRole, unauthorized } from "./auth.ts";

/* ── unauthorized() — pure response builder ── */

Deno.test("unauthorized returns 401 with default message", async () => {
  const res = unauthorized();
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Unauthorized");
});

Deno.test("unauthorized accepts a custom message", async () => {
  const res = unauthorized("Bad token");
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Bad token");
});

Deno.test("unauthorized sets CORS + JSON headers", () => {
  const res = unauthorized();
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  // Allow-Headers includes the four entries the workspace clients send
  const allow = res.headers.get("Access-Control-Allow-Headers") ?? "";
  for (const h of ["authorization", "x-client-info", "apikey", "content-type"]) {
    assertEquals(allow.includes(h), true, `Missing ${h} in Allow-Headers`);
  }
});

/* ── isServiceRole() — synchronous header → env match ── */

Deno.test("isServiceRole — false when no Authorization header", () => {
  const req = new Request("http://x", { method: "GET" });
  assertEquals(isServiceRole(req), false);
});

Deno.test("isServiceRole — false when header is not Bearer-style", () => {
  const req = new Request("http://x", {
    method: "GET",
    headers: { Authorization: "Basic abc" },
  });
  assertEquals(isServiceRole(req), false);
});

Deno.test("isServiceRole — true when token matches SUPABASE_SERVICE_ROLE_KEY", () => {
  const sentinel = "sb_secret_TEST_VALUE_xyz";
  const original = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", sentinel);
  try {
    const req = new Request("http://x", {
      method: "GET",
      headers: { Authorization: `Bearer ${sentinel}` },
    });
    assertEquals(isServiceRole(req), true);
  } finally {
    if (original === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", original);
  }
});

Deno.test("isServiceRole — false when token does not match", () => {
  const original = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "real-secret");
  try {
    const req = new Request("http://x", {
      method: "GET",
      headers: { Authorization: "Bearer different-secret" },
    });
    assertEquals(isServiceRole(req), false);
  } finally {
    if (original === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", original);
  }
});

/* ── getAuthUser() — early-exit branches we can verify without
   setting up a Supabase mock ── */

Deno.test("getAuthUser — null when Authorization header is absent", async () => {
  const req = new Request("http://x", { method: "GET" });
  assertEquals(await getAuthUser(req), null);
});

Deno.test("getAuthUser — null when Authorization is not Bearer", async () => {
  const req = new Request("http://x", {
    method: "GET",
    headers: { Authorization: "Basic abc" },
  });
  assertEquals(await getAuthUser(req), null);
});

Deno.test("getAuthUser — null when Authorization header is empty string", async () => {
  const req = new Request("http://x", {
    method: "GET",
    headers: { Authorization: "" },
  });
  assertEquals(await getAuthUser(req), null);
});
