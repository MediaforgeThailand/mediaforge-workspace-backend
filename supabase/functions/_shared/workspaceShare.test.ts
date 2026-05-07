/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CORS_HEADERS,
  buildShareUrl,
  json,
  publicShareOrigin,
  randomToken,
  readJson,
  requireUser,
} from "./workspaceShare.ts";

/* ── json() ──────────────────────────────────────────────────────── */

Deno.test("json — defaults to status 200 with CORS + JSON headers", async () => {
  const res = json({ ok: true });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(await res.json(), { ok: true });
});

Deno.test("json — accepts a custom status code", async () => {
  const res = json({ error: "boom" }, 500);
  assertEquals(res.status, 500);
});

Deno.test("CORS_HEADERS — Allow-Methods is POST, OPTIONS", () => {
  assertEquals(CORS_HEADERS["Access-Control-Allow-Methods"], "POST, OPTIONS");
});

Deno.test("CORS_HEADERS — Allow-Headers includes the workspace client metadata headers", () => {
  const allow = CORS_HEADERS["Access-Control-Allow-Headers"];
  for (const h of [
    "authorization",
    "apikey",
    "x-supabase-client-platform",
    "x-supabase-client-runtime-version",
  ]) {
    assertEquals(allow.includes(h), true, `Missing ${h}`);
  }
});

/* ── randomToken() ───────────────────────────────────────────────── */

Deno.test("randomToken — emits a 64-char hex string", () => {
  const token = randomToken();
  assertEquals(token.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(token), true);
});

Deno.test("randomToken — collisions are astronomically unlikely (sanity check)", () => {
  const set = new Set<string>();
  for (let i = 0; i < 1000; i++) set.add(randomToken());
  assertEquals(set.size, 1000);
});

/* ── buildShareUrl() ─────────────────────────────────────────────── */

Deno.test("buildShareUrl — composes the canonical workspace share URL", () => {
  const url = buildShareUrl(
    "https://workspace.mediaforge.co",
    "ws-1",
    "tok-abc",
  );
  assertEquals(
    url,
    "https://workspace.mediaforge.co/app/workspace/ws-1?share=tok-abc",
  );
});

Deno.test("buildShareUrl — strips trailing slashes from origin", () => {
  const url = buildShareUrl(
    "https://workspace.mediaforge.co///",
    "ws-1",
    "tok",
  );
  assertEquals(
    url,
    "https://workspace.mediaforge.co/app/workspace/ws-1?share=tok",
  );
});

Deno.test("buildShareUrl — URL-encodes workspaceId and token", () => {
  const url = buildShareUrl(
    "https://x.co",
    "ws/1 with spaces",
    "tok&dangerous=1",
  );
  assertEquals(
    url,
    "https://x.co/app/workspace/ws%2F1%20with%20spaces?share=tok%26dangerous%3D1",
  );
});

/* ── publicShareOrigin() ─────────────────────────────────────────── */

function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
): T {
  const backup = Object.keys(vars).map(
    (k) => [k, Deno.env.get(k)] as const,
  );
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of backup) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("publicShareOrigin — uses body.app_origin when valid", () => {
  withEnv(
    { PUBLIC_WORKSPACE_APP_URL: undefined, WORKSPACE_APP_URL: undefined, SITE_URL: undefined },
    () => {
      const req = new Request("http://x");
      assertEquals(
        publicShareOrigin(req, { app_origin: "https://branded.example.com/path" }),
        "https://branded.example.com",
      );
    },
  );
});

Deno.test("publicShareOrigin — uses Origin header when no body", () => {
  withEnv(
    { PUBLIC_WORKSPACE_APP_URL: undefined, WORKSPACE_APP_URL: undefined, SITE_URL: undefined },
    () => {
      const req = new Request("http://x", {
        headers: { Origin: "https://prod.example.com" },
      });
      assertEquals(publicShareOrigin(req), "https://prod.example.com");
    },
  );
});

Deno.test("publicShareOrigin — preferred env wins when candidate is local", () => {
  withEnv(
    {
      PUBLIC_WORKSPACE_APP_URL: "https://workspace.mediaforge.co",
      WORKSPACE_APP_URL: undefined,
      SITE_URL: undefined,
    },
    () => {
      const req = new Request("http://x", {
        headers: { Origin: "http://localhost:5173" },
      });
      assertEquals(
        publicShareOrigin(req),
        "https://workspace.mediaforge.co",
      );
    },
  );
});

Deno.test("publicShareOrigin — falls back to default when no candidate or env", () => {
  withEnv(
    {
      PUBLIC_WORKSPACE_APP_URL: undefined,
      WORKSPACE_APP_URL: undefined,
      SITE_URL: undefined,
    },
    () => {
      const req = new Request("http://x");
      assertEquals(
        publicShareOrigin(req),
        "https://workspace.mediaforge.co",
      );
    },
  );
});

Deno.test("publicShareOrigin — strips trailing slashes from preferred env", () => {
  withEnv(
    { PUBLIC_WORKSPACE_APP_URL: "https://my.example.co////", WORKSPACE_APP_URL: undefined, SITE_URL: undefined },
    () => {
      const req = new Request("http://x", {
        headers: { Origin: "http://localhost" },
      });
      assertEquals(publicShareOrigin(req), "https://my.example.co");
    },
  );
});

Deno.test("publicShareOrigin — env precedence: PUBLIC_WORKSPACE_APP_URL > WORKSPACE_APP_URL > SITE_URL", () => {
  withEnv(
    {
      PUBLIC_WORKSPACE_APP_URL: "https://primary",
      WORKSPACE_APP_URL: "https://secondary",
      SITE_URL: "https://tertiary",
    },
    () => {
      const req = new Request("http://x");
      assertEquals(publicShareOrigin(req), "https://primary");
    },
  );
  withEnv(
    {
      PUBLIC_WORKSPACE_APP_URL: undefined,
      WORKSPACE_APP_URL: "https://secondary",
      SITE_URL: "https://tertiary",
    },
    () => {
      const req = new Request("http://x");
      assertEquals(publicShareOrigin(req), "https://secondary");
    },
  );
  withEnv(
    {
      PUBLIC_WORKSPACE_APP_URL: undefined,
      WORKSPACE_APP_URL: undefined,
      SITE_URL: "https://tertiary",
    },
    () => {
      const req = new Request("http://x");
      assertEquals(publicShareOrigin(req), "https://tertiary");
    },
  );
});

/* ── readJson() ──────────────────────────────────────────────────── */

Deno.test("readJson — returns the parsed body for valid JSON", async () => {
  const req = new Request("http://x", {
    method: "POST",
    body: JSON.stringify({ a: 1, b: "x" }),
  });
  const result = await readJson(req);
  assertEquals(result, { a: 1, b: "x" });
});

Deno.test("readJson — returns 400 Response for invalid JSON", async () => {
  const req = new Request("http://x", { method: "POST", body: "not-json" });
  const result = await readJson(req);
  if (!(result instanceof Response)) throw new Error("expected Response on bad JSON");
  assertEquals(result.status, 400);
  assertEquals(await result.json(), { error: "invalid_json" });
});

Deno.test("readJson — returns 400 when body is JSON null", async () => {
  const req = new Request("http://x", { method: "POST", body: "null" });
  const result = await readJson(req);
  if (!(result instanceof Response)) throw new Error("expected Response when body is null");
  assertEquals(result.status, 400);
});

Deno.test("readJson — returns 400 when body is JSON primitive (string/number)", async () => {
  const req = new Request("http://x", { method: "POST", body: "\"just a string\"" });
  const result = await readJson(req);
  if (!(result instanceof Response)) throw new Error("expected Response when body is a primitive");
  assertEquals(result.status, 400);
});

/* ── requireUser() — early-exit branches only ───────────────────── */

Deno.test("requireUser — returns 401 Response when Authorization is missing", async () => {
  const req = new Request("http://x", { method: "POST" });
  const result = await requireUser(req);
  if (!(result instanceof Response)) throw new Error("expected Response");
  assertEquals(result.status, 401);
});

Deno.test("requireUser — returns 401 Response when Authorization is not Bearer", async () => {
  const req = new Request("http://x", {
    method: "POST",
    headers: { Authorization: "Basic abc" },
  });
  const result = await requireUser(req);
  if (!(result instanceof Response)) throw new Error("expected Response");
  assertEquals(result.status, 401);
});
