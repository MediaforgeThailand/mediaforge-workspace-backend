/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { unauthorizedResponse, verifyAdminJwt } from "./adminAuth.ts";

const SECRET = "test-jwt-secret-do-not-use-in-prod-1234567890";

// ─── Helpers ───────────────────────────────────────────────────────

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64Url(s: string): string {
  return bytesToB64Url(new TextEncoder().encode(s));
}

async function signJwt(payload: Record<string, unknown>, secret = SECRET): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encHeader = strToB64Url(JSON.stringify(header));
  const encPayload = strToB64Url(JSON.stringify(payload));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(`${encHeader}.${encPayload}`)),
  );
  return `${encHeader}.${encPayload}.${bytesToB64Url(sig)}`;
}

function reqWithAuth(token: string): Request {
  return new Request("http://x", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function withSecret<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> | T {
  const original = Deno.env.get("JWT_SECRET");
  if (value === undefined) Deno.env.delete("JWT_SECRET");
  else Deno.env.set("JWT_SECRET", value);
  const restore = () => {
    if (original === undefined) Deno.env.delete("JWT_SECRET");
    else Deno.env.set("JWT_SECRET", original);
  };
  // Block any ERP-fallback path from reaching network by clearing the
  // ADMIN_* env vars and removing x-admin-auth-key — the test wants
  // strict HMAC behaviour.
  const adminEnvKeys = [
    "ADMIN_AUTH_SUPABASE_URL", "ADMIN_AUTH_SUPABASE_ANON_KEY",
    "ADMIN_SUPABASE_URL", "ADMIN_SUPABASE_ANON_KEY",
    "ERP_ADMIN_SUPABASE_URL", "ERP_ADMIN_SUPABASE_ANON_KEY",
  ];
  const adminBackup = adminEnvKeys.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of adminEnvKeys) Deno.env.delete(k);
  const restoreAdmin = () => {
    for (const [k, v] of adminBackup) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        restore();
        restoreAdmin();
      }) as Promise<T>;
    }
    restore();
    restoreAdmin();
    return result;
  } catch (e) {
    restore();
    restoreAdmin();
    throw e;
  }
}

// ─── unauthorizedResponse ──────────────────────────────────────────

Deno.test("unauthorizedResponse — 401 with custom CORS headers merged", async () => {
  const res = unauthorizedResponse({ "Access-Control-Allow-Origin": "*" });
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assertEquals(body.error, "Unauthorized");
});

// ─── verifyAdminJwt — early-exit branches ──────────────────────────

Deno.test("verifyAdminJwt — null when Authorization is missing", async () => {
  await withSecret(SECRET, async () => {
    const req = new Request("http://x", { method: "POST" });
    assertEquals(await verifyAdminJwt(req), null);
  });
});

Deno.test("verifyAdminJwt — null when Authorization is not Bearer", async () => {
  await withSecret(SECRET, async () => {
    const req = new Request("http://x", {
      method: "POST",
      headers: { Authorization: "Basic abc" },
    });
    assertEquals(await verifyAdminJwt(req), null);
  });
});

Deno.test("verifyAdminJwt — null when JWT has wrong number of parts", async () => {
  await withSecret(SECRET, async () => {
    assertEquals(await verifyAdminJwt(reqWithAuth("only-two.parts")), null);
  });
});

Deno.test("verifyAdminJwt — null when JWT_SECRET env is unset (fail closed)", async () => {
  await withSecret(undefined, async () => {
    // Can't even build a valid JWT against the unset secret — but even a
    // structurally valid token signed elsewhere should be rejected
    // because the ERP fallback has no admin URL/key configured either.
    const token = await signJwt({
      sub: "u1",
      email: "a@b.co",
      role: "admin",
      type: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    assertEquals(await verifyAdminJwt(reqWithAuth(token)), null);
  });
});

// ─── verifyAdminJwt — HMAC happy path ──────────────────────────────

Deno.test("verifyAdminJwt — accepts a valid HS256 admin token within expiry", async () => {
  await withSecret(SECRET, async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      sub: "user-123",
      email: "admin@mediaforge.co",
      role: "super_admin",
      display_name: "Admin Bob",
      type: "admin",
      iat: now,
      exp: now + 3600,
    });
    const result = await verifyAdminJwt(reqWithAuth(token));
    assertEquals(result?.sub, "user-123");
    assertEquals(result?.email, "admin@mediaforge.co");
    assertEquals(result?.role, "super_admin");
    assertEquals(result?.type, "admin");
  });
});

Deno.test("verifyAdminJwt — accepts lowercase 'authorization' header", async () => {
  await withSecret(SECRET, async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      sub: "u1",
      email: "a@b.co",
      role: "admin",
      type: "admin",
      iat: now,
      exp: now + 3600,
    });
    const req = new Request("http://x", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const result = await verifyAdminJwt(req);
    assertEquals(result?.sub, "u1");
  });
});

// ─── verifyAdminJwt — HMAC rejection paths ─────────────────────────

Deno.test("verifyAdminJwt — null when type claim is not 'admin'", async () => {
  await withSecret(SECRET, async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      sub: "u1",
      email: "a@b.co",
      role: "admin",
      type: "user", // NOT admin
      iat: now,
      exp: now + 3600,
    });
    assertEquals(await verifyAdminJwt(reqWithAuth(token)), null);
  });
});

Deno.test("verifyAdminJwt — null when token has expired", async () => {
  await withSecret(SECRET, async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({
      sub: "u1",
      email: "a@b.co",
      role: "admin",
      type: "admin",
      iat: now - 7200,
      exp: now - 3600, // expired one hour ago
    });
    assertEquals(await verifyAdminJwt(reqWithAuth(token)), null);
  });
});

Deno.test("verifyAdminJwt — null when exp claim is not a number", async () => {
  await withSecret(SECRET, async () => {
    const token = await signJwt({
      sub: "u1",
      email: "a@b.co",
      role: "admin",
      type: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: "not-a-number" as unknown as number,
    });
    assertEquals(await verifyAdminJwt(reqWithAuth(token)), null);
  });
});

Deno.test("verifyAdminJwt — null when signature was made with a different secret", async () => {
  await withSecret(SECRET, async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      {
        sub: "u1",
        email: "a@b.co",
        role: "admin",
        type: "admin",
        iat: now,
        exp: now + 3600,
      },
      "different-secret-pretender",
    );
    assertEquals(await verifyAdminJwt(reqWithAuth(token)), null);
  });
});

Deno.test("verifyAdminJwt — null when payload has been tampered after signing", async () => {
  await withSecret(SECRET, async () => {
    const now = Math.floor(Date.now() / 1000);
    const valid = await signJwt({
      sub: "u1",
      email: "a@b.co",
      role: "admin",
      type: "admin",
      iat: now,
      exp: now + 3600,
    });
    const [h, , s] = valid.split(".");
    // Replace payload with a privilege-escalation attempt using same header + signature
    const fakePayload = strToB64Url(
      JSON.stringify({
        sub: "attacker",
        email: "x@y.co",
        role: "super_admin",
        type: "admin",
        iat: now,
        exp: now + 3600,
      }),
    );
    const tampered = `${h}.${fakePayload}.${s}`;
    assertEquals(await verifyAdminJwt(reqWithAuth(tampered)), null);
  });
});
