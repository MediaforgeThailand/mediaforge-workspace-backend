/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

// affiliate-drift-notifier — Layer 4 of the affiliate runtime safety net.
//
// Runs every 15 minutes via pg_cron (see 20260519052333_affiliate_drift_email_notifier.sql).
// Reads reconciliation_drift rows from affiliate_audit_log where
// notified_at IS NULL, batches them into one digest email per run, sends
// via SendGrid to AFFILIATE_DRIFT_ALERT_EMAILS, then UPDATEs notified_at.
//
// Auth: cron passes x-cron-secret matching retry_worker_cron_secret.
// Service-role direct calls are also accepted (so the same endpoint can be
// invoked manually from an admin tool).
//
// Env:
//   AFFILIATE_DRIFT_ALERT_EMAILS  — comma-separated recipient list (required)
//   SENDGRID_API_KEY              — for outbound email (required)
//   SENDGRID_FROM_EMAIL           — sender (defaults to alerts@mediaforge.co)
//
// Failure modes:
//   - No recipients configured → log + 200 (cron should not retry)
//   - SendGrid error → log + return 500 (cron observes; pending rows stay
//                       unnotified for next run)
//   - DB error reading pending rows → 500
//
// Response: { ok: true, sent: N, batched_ids: [...] }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CRON_SECRET = Deno.env.get("RETRY_WORKER_CRON_SECRET") || Deno.env.get("CRON_SECRET");
const ALERT_EMAILS_RAW = Deno.env.get("AFFILIATE_DRIFT_ALERT_EMAILS") ?? "";
const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY") ?? "";
const SENDGRID_FROM_EMAIL = Deno.env.get("SENDGRID_FROM_EMAIL") ?? "alerts@mediaforge.co";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BATCH_LIMIT = 100;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time string compare. Length is not a secret so fail fast on
  // mismatch, but never short-circuit per-byte to avoid timing oracles.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(req: Request): boolean {
  const cronSecret = req.headers.get("x-cron-secret");
  if (CRON_SECRET && cronSecret && timingSafeEqual(cronSecret, CRON_SECRET)) return true;

  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (SERVICE_ROLE_KEY && timingSafeEqual(token, SERVICE_ROLE_KEY)) return true;
  }

  return false;
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes("@"));
}

function renderDrift(row: any): string {
  const diff = row.diff ?? {};
  const invariant = diff.invariant ?? "(unknown invariant)";
  const ts = row.created_at;
  const detail = JSON.stringify(diff, null, 0);
  return `<li><b>${escapeHtml(invariant)}</b> — entity_type=<code>${escapeHtml(row.entity_type)}</code>, entity_id=<code>${escapeHtml(row.entity_id)}</code><br/><small>${escapeHtml(ts)}</small><br/><code>${escapeHtml(detail)}</code></li>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildDigestHtml(rows: any[], pendingRemaining: number): string {
  const items = rows.map(renderDrift).join("\n");
  const backlogBanner = pendingRemaining > 0
    ? `<div style="background:#fff3cd;border:1px solid #ffe69c;padding:8px 12px;margin:8px 0;border-radius:4px"><b>Backlog:</b> ${pendingRemaining} more drift row${pendingRemaining === 1 ? "" : "s"} queued for the next 15-minute tick. This batch is capped at 100 rows.</div>`
    : "";
  return `<!DOCTYPE html><html><body style="font-family: -apple-system, sans-serif;">
<h2>Affiliate reconciliation drift — ${rows.length} new event${rows.length === 1 ? "" : "s"}</h2>
${backlogBanner}
<p>These rows in <code>affiliate_audit_log</code> indicate the partner-level counters
or per-row arithmetic diverged from the underlying transactions. Investigate before
the next payout run.</p>
<ul>${items}</ul>
<p style="color:#666;font-size:12px">Auto-sent by <code>affiliate-drift-notifier</code> every 15 minutes when new drifts are detected. Re-trigger by clearing <code>affiliate_audit_log.notified_at</code> on the rows you want re-sent.</p>
</body></html>`;
}

async function sendDigest(
  recipients: string[],
  rows: any[],
  pendingRemaining: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!SENDGRID_API_KEY) return { ok: false, error: "missing_sendgrid_api_key" };

  const subjectSuffix = pendingRemaining > 0 ? ` (+${pendingRemaining} queued)` : "";
  const payload = {
    personalizations: recipients.map((to) => ({ to: [{ email: to }] })),
    from: { email: SENDGRID_FROM_EMAIL, name: "MediaForge Alerts" },
    subject: `[Affiliate drift] ${rows.length} new event${rows.length === 1 ? "" : "s"}${subjectSuffix}`,
    content: [{ type: "text/html", value: buildDigestHtml(rows, pendingRemaining) }],
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    return { ok: false, error: `sendgrid_${res.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!isAuthorized(req)) return json({ ok: false, error: "unauthorized" }, 401);

  const recipients = parseRecipients(ALERT_EMAILS_RAW);
  if (recipients.length === 0) {
    console.warn("[affiliate-drift-notifier] No AFFILIATE_DRIFT_ALERT_EMAILS configured — skipping");
    return json({ ok: true, sent: 0, skipped: "no_recipients" });
  }

  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: pending, error: readErr } = await client
    .from("affiliate_audit_log")
    .select("id, action, entity_type, entity_id, diff, created_at")
    .eq("action", "reconciliation_drift")
    .is("notified_at", null)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (readErr) {
    console.error("[affiliate-drift-notifier] DB read failed:", readErr);
    return json({ ok: false, error: readErr.message }, 500);
  }

  if (!pending || pending.length === 0) {
    return json({ ok: true, sent: 0 });
  }

  // If we hit the batch limit, peek at the total backlog so the email +
  // response indicate how many more rows are queued for the next 15-min
  // tick. Admin can then see "10 sent now, 240 queued" rather than
  // silently sitting on 240 unseen drifts.
  let pendingRemaining = 0;
  if (pending.length >= BATCH_LIMIT) {
    const { count, error: countErr } = await client
      .from("affiliate_audit_log")
      .select("*", { count: "exact", head: true })
      .eq("action", "reconciliation_drift")
      .is("notified_at", null);
    if (countErr) {
      console.warn("[affiliate-drift-notifier] pending-count peek failed:", countErr);
    } else {
      pendingRemaining = Math.max(0, (count ?? 0) - pending.length);
    }
  }

  const send = await sendDigest(recipients, pending, pendingRemaining);
  if (!send.ok) {
    console.error("[affiliate-drift-notifier] SendGrid failed:", send.error);
    // Don't mark notified — next run will retry. Return 500 so cron logs the failure.
    return json({ ok: false, error: send.error, pending_count: pending.length }, 500);
  }

  const ids = pending.map((r: any) => r.id);
  const { error: updErr } = await client
    .from("affiliate_audit_log")
    .update({ notified_at: new Date().toISOString() })
    .in("id", ids);

  if (updErr) {
    // Email sent but DB mark failed. Next run will re-email — admin will see
    // a duplicate. Surface so ops knows to investigate, but the alert itself
    // already went out.
    console.error("[affiliate-drift-notifier] mark-notified DB write failed (email already sent):", updErr);
    return json({ ok: true, sent: pending.length, mark_warning: updErr.message, pending_remaining: pendingRemaining }, 200);
  }

  if (pendingRemaining > 0) {
    console.warn(`[affiliate-drift-notifier] batched ${pending.length} drift rows; ${pendingRemaining} remaining for next run`);
  }

  return json({ ok: true, sent: pending.length, batched_ids: ids, pending_remaining: pendingRemaining });
});
