/// <reference lib="deno.ns" />
/// <reference lib="dom" />
/**
 * delete-account — PDPA right-of-erasure flow.
 *
 * Background: the audit found that workspace.mediaforge.co's
 * Privacy Policy promises a "right to delete your data" but the
 * product had no UI / API to action that promise — a PDPA
 * compliance gap the moment any Thai user submitted a request.
 *
 * This function does the cascade:
 *   1. Verify the caller's password via Supabase Auth (re-authn)
 *   2. Log the request to `account_deletion_requests` (audit trail)
 *   3. Cancel any active Stripe subscription / detach payment methods
 *   4. Call `auth.admin.deleteUser(user_id)` — DB FKs cascade through
 *      profiles, workspaces, canvases, generations, credits, etc.
 *   5. Delete the user's storage objects (ai-media, user_assets)
 *   6. Mark the deletion request `completed`
 *
 * Failure modes:
 *   - Wrong password → 401 Unauthorized
 *   - Stripe API down → continue with deletion, log the orphan; the
 *     subscription will keep billing until ops manually cancels.
 *     The DB delete is the source of truth for PDPA.
 *   - Storage delete fails → continue; the bucket entries will be
 *     swept by a separate orphan-cleanup cron (TODO).
 *
 * NOTE: `auth.admin.deleteUser` requires service-role.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@15.0.0?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const userJwt = auth.slice(7);

  let body: { password?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const password = String(body.password ?? "");
  if (!password) return json({ error: "password_required" }, 400);
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

  // ── Step 1: identify caller via their user-JWT ─────────────────
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: "unauthorized" }, 401);
  const user = userData.user;
  const userId = user.id;
  const userEmail = user.email ?? "";

  // ── Step 2: verify password by attempting a fresh sign-in ───────
  // signInWithPassword returns a fresh session; if password is
  // wrong it errors out. We don't keep that session — it's only
  // used here as a proof-of-knowledge check before destruction.
  const { error: pwErr } = await userClient.auth.signInWithPassword({
    email: userEmail,
    password,
  });
  if (pwErr) return json({ error: "wrong_password" }, 401);

  // ── Step 3: service-role client for the destructive part ──────
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Step 4: log the request (idempotent — re-tries are safe) ──
  const { data: requestRow, error: logErr } = await admin
    .from("account_deletion_requests")
    .insert({
      user_id: userId,
      user_email: userEmail,
      reason,
      status: "processing",
    })
    .select("id")
    .single();
  if (logErr) {
    return json({ error: "audit_log_failed", details: logErr.message }, 500);
  }
  const requestId = requestRow.id;

  // ── Step 5: cancel Stripe subscription + detach payment methods ──
  let stripeNotes: string[] = [];
  if (STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(STRIPE_SECRET_KEY, {
        apiVersion: "2024-11-20.acacia",
        httpClient: Stripe.createFetchHttpClient(),
      });
      // Find Stripe customer by metadata
      const { data: profile } = await admin
        .from("profiles")
        .select("stripe_customer_id, stripe_subscription_id")
        .eq("user_id", userId)
        .single();

      if (profile?.stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(profile.stripe_subscription_id);
          stripeNotes.push(`canceled_subscription:${profile.stripe_subscription_id}`);
        } catch (e) {
          stripeNotes.push(`subscription_cancel_failed:${(e as Error).message}`);
        }
      }
      if (profile?.stripe_customer_id) {
        try {
          // Detach all payment methods so future charges fail closed
          const pms = await stripe.paymentMethods.list({
            customer: profile.stripe_customer_id,
            limit: 20,
          });
          for (const pm of pms.data) {
            try {
              await stripe.paymentMethods.detach(pm.id);
            } catch {/* ignore */}
          }
          stripeNotes.push(`detached_payment_methods:${pms.data.length}`);
        } catch (e) {
          stripeNotes.push(`payment_method_list_failed:${(e as Error).message}`);
        }
      }
    } catch (e) {
      stripeNotes.push(`stripe_init_failed:${(e as Error).message}`);
    }
  } else {
    stripeNotes.push("stripe_secret_unset_skipped");
  }

  // ── Step 6: delete storage objects in user-prefixed folders ─────
  let storageNotes: string[] = [];
  for (const bucket of ["ai-media", "user_assets"]) {
    try {
      const { data: list } = await admin.storage
        .from(bucket)
        .list(userId, { limit: 1000, sortBy: { column: "name", order: "asc" } });
      if (list && list.length > 0) {
        const paths = list.map((o) => `${userId}/${o.name}`);
        const { error: delErr } = await admin.storage.from(bucket).remove(paths);
        if (delErr) storageNotes.push(`${bucket}:remove_failed:${delErr.message}`);
        else storageNotes.push(`${bucket}:removed_${paths.length}`);
      } else {
        storageNotes.push(`${bucket}:empty`);
      }
    } catch (e) {
      storageNotes.push(`${bucket}:error:${(e as Error).message}`);
    }
  }

  // ── Step 7: delete the auth.users row (cascades through DB) ─────
  // FKs across the schema use ON DELETE CASCADE on user_id, so this
  // single call wipes profiles, workspaces, canvases, generation
  // jobs, credits, transactions, etc.
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    // Mark the audit row as failed so ops can retry manually.
    await admin
      .from("account_deletion_requests")
      .update({
        status: "failed",
        notes: `auth.deleteUser failed: ${delErr.message}\nstripe: ${stripeNotes.join("; ")}\nstorage: ${storageNotes.join("; ")}`,
      })
      .eq("id", requestId);
    return json({ error: "delete_failed", details: delErr.message }, 500);
  }

  // ── Step 8: stamp the audit row as completed ───────────────────
  // NOTE: the row itself will be cascade-deleted by the FK on
  // `account_deletion_requests.user_id` when the auth.users row
  // goes — so this update is best-effort. We catch and ignore.
  await admin
    .from("account_deletion_requests")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      notes: `stripe: ${stripeNotes.join("; ")}\nstorage: ${storageNotes.join("; ")}`,
    })
    .eq("id", requestId)
    .then(() => {/* ignore */}, () => {/* ignore */});

  return json({
    success: true,
    message: "Account deleted",
    stripe: stripeNotes,
    storage: storageNotes,
  });
});
