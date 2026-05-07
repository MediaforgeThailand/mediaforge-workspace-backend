/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { rejectIfOrgUser } from "./orgUserGuard.ts";

/**
 * NOTE: rejectIfOrgUser hits Supabase for both auth.getUser() and a
 * profiles SELECT. We can't mock the SDK without DI, so the test focus
 * here is the early-exit branches that gate the network call. The
 * "actually returns 403 for org users" path is exercised by the live
 * integration tests (admin_workspace_*).
 */

function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const backup: Array<[string, string | undefined]> = Object.keys(vars).map(
    (k) => [k, Deno.env.get(k)],
  );
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  return fn().finally(() => {
    for (const [k, v] of backup) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

Deno.test("rejectIfOrgUser — null when no Authorization header", async () => {
  const req = new Request("http://x", { method: "POST" });
  assertEquals(await rejectIfOrgUser(req), null);
});

Deno.test("rejectIfOrgUser — null when token is empty (post-Bearer strip)", async () => {
  const req = new Request("http://x", {
    method: "POST",
    headers: { Authorization: "Bearer " },
  });
  assertEquals(await rejectIfOrgUser(req), null);
});

Deno.test("rejectIfOrgUser — null when only 'Bearer' is sent (no token)", async () => {
  const req = new Request("http://x", {
    method: "POST",
    headers: { Authorization: "Bearer" },
  });
  assertEquals(await rejectIfOrgUser(req), null);
});

Deno.test("rejectIfOrgUser — null when SUPABASE_URL is unset", async () => {
  await withEnv(
    {
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: "service",
      SUPABASE_ANON_KEY: "anon",
    },
    async () => {
      const req = new Request("http://x", {
        method: "POST",
        headers: { Authorization: "Bearer some-token" },
      });
      assertEquals(await rejectIfOrgUser(req), null);
    },
  );
});

Deno.test("rejectIfOrgUser — null when SUPABASE_SERVICE_ROLE_KEY is unset", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      SUPABASE_ANON_KEY: "anon",
    },
    async () => {
      const req = new Request("http://x", {
        method: "POST",
        headers: { Authorization: "Bearer some-token" },
      });
      assertEquals(await rejectIfOrgUser(req), null);
    },
  );
});

Deno.test("rejectIfOrgUser — null when SUPABASE_ANON_KEY is unset", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      SUPABASE_ANON_KEY: undefined,
    },
    async () => {
      const req = new Request("http://x", {
        method: "POST",
        headers: { Authorization: "Bearer some-token" },
      });
      assertEquals(await rejectIfOrgUser(req), null);
    },
  );
});

// NOTE: the "valid token resolves to org user → 403" path requires a real
// Supabase project with seeded profiles. That live coverage lives in the
// integration tests for admin_workspace_* (which exercise rejectIfOrgUser
// against a known org user). The early-exit branches above are what
// keeps the guard honest as a defensive layer.
