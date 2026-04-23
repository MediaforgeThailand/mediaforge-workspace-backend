// ============================================================================
//  erp-affiliate-bridge — Supabase Edge Function (deploy to MAIN Supabase)
//  Path: supabase/functions/erp-affiliate-bridge/index.ts
//
//  Single consolidated bridge for ALL ERP admin actions on the affiliate /
//  KYC / payout subsystem. Dispatches by `action` field in request body.
//
//  Auth: shared secret via `X-Bridge-Token` header (BRIDGE_API_KEY).
//  Uses SERVICE_ROLE_KEY on Main side. ERP never talks to Main DB directly.
//
//  Response contract: { ok: true, data: ... } | { ok: false, error: "..." }
//  Never leaks stack traces. All mutations write to affiliate_audit_log.
//  Rate limit: 100 req/min per bridge token (in-memory, per-instance).
// ============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: true, data }), { status, headers: jsonHeaders });
const fail = (error: string, status = 400) =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers: jsonHeaders });

// ── Rate limit (per-instance, per-token) ────────────────────────────────────
const RATE_LIMIT = 100;
const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(token: string): boolean {
  const now = Date.now();
  const b = buckets.get(token);
  if (!b || b.resetAt < now) {
    buckets.set(token, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (b.count >= RATE_LIMIT) return false;
  b.count++;
  return true;
}

// ── KYC document signing ────────────────────────────────────────────────────
// 1-hour TTL so the ERP admin drawer has time to open documents after the list
// is loaded. Previously 300s caused "InvalidJWT exp claim" errors when admins
// took >5min between list-load and clicking a document thumbnail.
const KYC_URL_TTL_SECONDS = 3600;

const KYC_DOC_FIELDS = {
  id_card_front: "id_card_front_url",
  id_card_back: "id_card_back_url",
  bank_book: "bank_book_url",
  selfie_with_id: "selfie_with_id_url",
} as const;

async function signKycDocs(
  db: SupabaseClient,
  app: Record<string, any>,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  await Promise.all(
    Object.entries(KYC_DOC_FIELDS).map(async ([key, column]) => {
      const path = app[column];
      if (!path) {
        out[key] = null;
        return;
      }
      const { data: s } = await db.storage
        .from("kyc-docs")
        .createSignedUrl(path, KYC_URL_TTL_SECONDS);
      out[key] = s?.signedUrl ?? null;
    }),
  );
  return out;
}

// ── Mask sensitive fields in list/detail views ──────────────────────────────
// Returns BOTH masked and full values so ERP can display masked by default
// and reveal full on demand. PDPA: caller is already authenticated via bridge
// token + ERP admin/sales session, and the ERP side logs every Reveal click.
function maskApplication(row: Record<string, any>) {
  const nid = row.national_id ? String(row.national_id) : null;
  const acct = row.bank_account_no ? String(row.bank_account_no) : null;
  return {
    ...row,
    // Masked (default display)
    national_id_masked: nid ? `•••••••••${nid.slice(-4)}` : null,
    bank_account_masked: acct ? `••••${acct.slice(-4)}` : null,
    // Full (for Reveal button)
    national_id_full: nid,
    bank_account_no_full: acct,
    // Legacy keys kept masked to avoid accidental exposure in older UIs
    national_id: nid ? "••••••••" : null,
    bank_account_no: acct ? `••••${acct.slice(-4)}` : null,
  };
}

// ── Audit log helper ────────────────────────────────────────────────────────
async function audit(
  db: SupabaseClient,
  actor_id: string | null,
  action: string,
  entity_type: string,
  entity_id: string,
  diff: Record<string, unknown>,
) {
  const { error } = await db.from("affiliate_audit_log").insert({
    actor_id,
    action,
    entity_type,
    entity_id,
    diff,
  });
  if (error) console.error("[audit] failed:", error.message, { action, entity_id });
}

// ── Partner code generator ──────────────────────────────────────────────────
function genPartnerCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(r).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "MF-P-" + hex.slice(0, 6).toUpperCase();
}

// ── Main handler ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("Method not allowed", 405);

  try {
    // 1. Auth — accept X-Bridge-Token (service-to-service) OR Supabase session (admin frontend)
    const bridgeToken = req.headers.get("X-Bridge-Token");
    const expected = Deno.env.get("BRIDGE_API_KEY");
    let actorId: string | null = null;
    let actorEmail: string | null = null;
    let actorRole: string | null = null;

    if (bridgeToken && expected && bridgeToken === expected) {
      // Service-to-service auth via shared secret — actor info comes from body
    } else {
      // Direct frontend call — verify Supabase session + admin/sales/creator role
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) return fail("Unauthorized", 401);

      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error: authErr } = await anonClient.auth.getUser();
      if (authErr || !user) return fail("Unauthorized", 401);

      const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: roleRow } = await svc
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!roleRow || !["admin", "sales", "creator"].includes(roleRow.role)) {
        return fail("Insufficient permissions", 403);
      }

      actorId = user.id;
      actorEmail = user.email ?? null;
      actorRole = roleRow.role;
    }

    // 2. Rate limit
    const rlKey = bridgeToken ?? actorId ?? "anon";
    if (!rateLimit(rlKey)) return fail("Rate limit exceeded", 429);

    // 3. Parse body
    // Accept params under any of: `params`, `payload`, or top-level keys
    // (ERP callers have historically used all three shapes).
    let body: Record<string, any>;
    try {
      body = await req.json();
    } catch {
      return fail("Invalid JSON body", 400);
    }
    const { action } = body ?? {};
    if (!action) return fail("Missing action", 400);
    const params: Record<string, any> = {
      ...(body ?? {}),
      ...(body?.payload ?? {}),
      ...(body?.params ?? {}),
    };
    delete params.action;
    delete params.payload;
    delete params.params;

    // Inject actor info from Supabase auth (frontend calls don't have these in body)
    if (actorId) {
      params.actor_id = params.actor_id ?? actorId;
      params.actor_email = params.actor_email ?? actorEmail;
      params.actor_role = params.actor_role ?? actorRole;
    }

    // 4. Service-role client (Main DB)
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // ── Dispatch ──────────────────────────────────────────────────────────
    switch (action) {
      // ════════════════════════════════════════════════════════════════
      //  KYC MANAGEMENT
      // ════════════════════════════════════════════════════════════════

      case "list_partner_applications": {
        const {
          status,
          date_from,
          date_to,
          search,
          page = 1,
          page_size = 25,
        } = params;
        let q = db.from("partner_applications").select("*", { count: "exact" });
        if (status) q = q.eq("status", status);
        if (date_from) q = q.gte("created_at", date_from);
        if (date_to) q = q.lte("created_at", date_to);
        if (search) {
          q = q.or(
            `legal_first_name.ilike.%${search}%,legal_last_name.ilike.%${search}%,phone_e164.ilike.%${search}%`,
          );
        }
        const from = (page - 1) * page_size;
        q = q.order("created_at", { ascending: false }).range(from, from + page_size - 1);
        const { data, count, error } = await q;
        if (error) return fail(error.message, 500);

        // Sign KYC document URLs for each row (1-hour TTL) so the drawer can
        // open documents without re-fetching. Done in parallel per row.
        const rows = await Promise.all(
          (data ?? []).map(async (app: any) => {
            const signed = await signKycDocs(db, app);
            return { ...maskApplication(app), signed_urls: signed };
          }),
        );
        return ok({ rows, total: count ?? 0, page, page_size });
      }

      case "get_partner_application": {
        const { id } = params;
        if (!id) return fail("Missing id", 400);
        const { data: app, error } = await db
          .from("partner_applications")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (error) return fail(error.message, 500);
        if (!app) return fail("Application not found", 404);

        const signed = await signKycDocs(db, app);
        return ok({ ...maskApplication(app), signed_urls: signed });
      }

      // Refresh a single document signed URL (used by ERP when an opened
      // signed URL has expired in the browser tab — issues a fresh 1h URL).
      case "refresh_kyc_document_url": {
        const { application_id, document_type } = params;
        if (!application_id || !document_type)
          return fail("Missing application_id or document_type", 400);
        const allowed: Record<string, string> = {
          id_card_front: "id_card_front_url",
          id_card_back: "id_card_back_url",
          bank_book: "bank_book_url",
          selfie_with_id: "selfie_with_id_url",
        };
        const column = allowed[document_type];
        if (!column) return fail("Invalid document_type", 400);

        const { data: app, error } = await db
          .from("partner_applications")
          .select(`id, ${column}`)
          .eq("id", application_id)
          .maybeSingle();
        if (error) return fail(error.message, 500);
        if (!app) return fail("Application not found", 404);

        const path = (app as any)[column];
        if (!path) return ok({ signed_url: null });

        const { data: s, error: signErr } = await db.storage
          .from("kyc-docs")
          .createSignedUrl(path, KYC_URL_TTL_SECONDS);
        if (signErr) return fail(signErr.message, 500);
        return ok({ signed_url: s?.signedUrl ?? null });
      }

      case "reveal_partner_pii": {
        const { application_id, field, admin_id } = params;
        if (!application_id || !field) return fail("Missing application_id or field", 400);
        const allowed = ["national_id", "bank_account_no"];
        if (!allowed.includes(field)) return fail("Invalid field", 400);

        const { data: app, error } = await db
          .from("partner_applications")
          .select(`id, user_id, ${field}`)
          .eq("id", application_id)
          .maybeSingle();
        if (error) return fail(error.message, 500);
        if (!app) return fail("Application not found", 404);

        await audit(db, admin_id ?? null, "reveal_partner_pii", "partner_application", application_id, {
          field,
          revealed_by: admin_id ?? "unknown",
        });

        return ok({ application_id, field, value: (app as any)[field] ?? null });
      }

      case "approve_application": {
        const { id, reviewer_id } = params;
        if (!id || !reviewer_id) return fail("Missing id or reviewer_id", 400);

        const { data: app, error: appErr } = await db
          .from("partner_applications")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (appErr) return fail(appErr.message, 500);
        if (!app) return fail("Application not found", 404);
        if (app.status === "approved") return fail("Already approved", 409);

        // 1. Update application
        const now = new Date().toISOString();
        const { error: updErr } = await db
          .from("partner_applications")
          .update({ status: "approved", reviewed_by: reviewer_id, reviewed_at: now, updated_at: now })
          .eq("id", id);
        if (updErr) return fail(updErr.message, 500);

        // 2. Insert partner row (commission_rate 0.30)
        const { data: partner, error: pErr } = await db
          .from("partners")
          .insert({
            user_id: app.user_id,
            application_id: id,
            commission_rate: 0.3,
            tier: "standard",
            approved_at: now,
          })
          .select()
          .single();
        if (pErr) return fail(`Partner insert failed: ${pErr.message}`, 500);

        // 3. Generate unique partner referral code
        let code = genPartnerCode();
        for (let i = 0; i < 5; i++) {
          const { data: dup } = await db
            .from("referral_codes")
            .select("id")
            .eq("code", code)
            .maybeSingle();
          if (!dup) break;
          code = genPartnerCode();
        }
        const { data: codeRow, error: cErr } = await db
          .from("referral_codes")
          .insert({ user_id: app.user_id, code, code_type: "partner_affiliate", is_active: true })
          .select()
          .single();
        if (cErr) return fail(`Code insert failed: ${cErr.message}`, 500);

        // 4. Audit
        await audit(db, reviewer_id, "approve_application", "partner_application", id, {
          partner_user_id: app.user_id,
          referral_code: code,
          commission_rate: 0.3,
        });

        return ok({ partner, referral_code: codeRow });
      }

      case "reject_application": {
        const { id, reviewer_id, reason } = params;
        if (!id || !reviewer_id || !reason) return fail("Missing id, reviewer_id, or reason", 400);
        const now = new Date().toISOString();
        const { error } = await db
          .from("partner_applications")
          .update({
            status: "rejected",
            reviewed_by: reviewer_id,
            reviewed_at: now,
            rejection_reason: reason,
            updated_at: now,
          })
          .eq("id", id);
        if (error) return fail(error.message, 500);
        await audit(db, reviewer_id, "reject_application", "partner_application", id, { reason });
        return ok({ id, status: "rejected" });
      }

      case "request_more_info": {
        const { id, reviewer_id, message } = params;
        if (!id || !reviewer_id || !message) return fail("Missing id, reviewer_id, or message", 400);
        const now = new Date().toISOString();
        const { error } = await db
          .from("partner_applications")
          .update({
            status: "needs_info",
            reviewed_by: reviewer_id,
            reviewed_at: now,
            needs_info_message: message,
            updated_at: now,
          })
          .eq("id", id);
        if (error) return fail(error.message, 500);
        await audit(db, reviewer_id, "request_more_info", "partner_application", id, { message });
        return ok({ id, status: "needs_info" });
      }

      // ════════════════════════════════════════════════════════════════
      //  PAYOUT MANAGEMENT
      // ════════════════════════════════════════════════════════════════

      case "list_payout_requests": {
        const { status, date_from, date_to, partner_user_id, page = 1, page_size = 25 } = params;
        let q = db.from("payout_requests").select("*", { count: "exact" });
        if (status) q = q.eq("status", status);
        if (partner_user_id) q = q.eq("partner_user_id", partner_user_id);
        if (date_from) q = q.gte("requested_at", date_from);
        if (date_to) q = q.lte("requested_at", date_to);
        const from = (page - 1) * page_size;
        q = q.order("requested_at", { ascending: false }).range(from, from + page_size - 1);
        const { data, count, error } = await q;
        if (error) return fail(error.message, 500);
        return ok({ rows: data ?? [], total: count ?? 0, page, page_size });
      }

      case "mark_payout_processing": {
        const { id, processor_id } = params;
        if (!id || !processor_id) return fail("Missing id or processor_id", 400);
        const { error } = await db
          .from("payout_requests")
          .update({ status: "processing", processed_by: processor_id })
          .eq("id", id)
          .eq("status", "pending");
        if (error) return fail(error.message, 500);
        await audit(db, processor_id, "mark_payout_processing", "payout_request", id, {});
        return ok({ id, status: "processing" });
      }

      case "mark_payout_paid": {
        const { id, processor_id, proof_url } = params;
        if (!id || !processor_id || !proof_url)
          return fail("Missing id, processor_id, or proof_url", 400);
        const { data: payout, error: pErr } = await db
          .from("payout_requests")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (pErr) return fail(pErr.message, 500);
        if (!payout) return fail("Payout not found", 404);
        if (payout.status === "paid") return fail("Already paid", 409);

        const now = new Date().toISOString();

        // 1. Update payout
        const { error: e1 } = await db
          .from("payout_requests")
          .update({ status: "paid", processed_by: processor_id, processed_at: now, proof_url })
          .eq("id", id);
        if (e1) return fail(e1.message, 500);

        // 2. Update commission_events → paid
        if (Array.isArray(payout.commission_ids) && payout.commission_ids.length > 0) {
          const { error: e2 } = await db
            .from("commission_events")
            .update({ status: "paid", paid_at: now, payout_id: id })
            .in("id", payout.commission_ids);
          if (e2) return fail(`Commission update failed: ${e2.message}`, 500);
        }

        // 3. Update partner lifetime_paid_thb (read-modify-write; no atomic SQL via PostgREST)
        const { data: partner } = await db
          .from("partners")
          .select("lifetime_paid_thb")
          .eq("user_id", payout.partner_user_id)
          .maybeSingle();
        const current = Number(partner?.lifetime_paid_thb ?? 0);
        const next = current + Number(payout.amount_thb);
        await db
          .from("partners")
          .update({ lifetime_paid_thb: next })
          .eq("user_id", payout.partner_user_id);

        // 4. Audit
        await audit(db, processor_id, "mark_payout_paid", "payout_request", id, {
          amount_thb: payout.amount_thb,
          proof_url,
          commission_ids: payout.commission_ids,
        });

        return ok({ id, status: "paid", amount_thb: payout.amount_thb });
      }

      case "mark_payout_failed": {
        const { id, processor_id, reason } = params;
        if (!id || !processor_id || !reason) return fail("Missing id, processor_id, or reason", 400);
        const { error } = await db
          .from("payout_requests")
          .update({
            status: "failed",
            processed_by: processor_id,
            processed_at: new Date().toISOString(),
            failure_reason: reason,
          })
          .eq("id", id);
        if (error) return fail(error.message, 500);
        await audit(db, processor_id, "mark_payout_failed", "payout_request", id, { reason });
        return ok({ id, status: "failed" });
      }

      // ════════════════════════════════════════════════════════════════
      //  ANALYTICS
      // ════════════════════════════════════════════════════════════════

      case "get_affiliate_analytics": {
        const { date_from, date_to } = params;
        const dFrom = date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString();
        const dTo = date_to ?? new Date().toISOString();

        const [apps, partners, refs, comms, payouts] = await Promise.all([
          db.from("partner_applications").select("status", { count: "exact", head: false })
            .gte("created_at", dFrom).lte("created_at", dTo),
          db.from("partners").select("user_id", { count: "exact", head: true }),
          db.from("referrals").select("attribution_status", { count: "exact", head: false })
            .gte("created_at", dFrom).lte("created_at", dTo),
          db.from("commission_events").select("status,commission_amount_thb")
            .gte("created_at", dFrom).lte("created_at", dTo),
          db.from("payout_requests").select("status,amount_thb")
            .gte("requested_at", dFrom).lte("requested_at", dTo),
        ]);

        const byStatus = (rows: any[] | null, key = "status") =>
          (rows ?? []).reduce<Record<string, number>>((acc, r) => {
            const k = r[key] ?? "unknown";
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {});
        const sumBy = (rows: any[] | null, status: string, field: string) =>
          (rows ?? []).filter((r) => r.status === status)
            .reduce((s, r) => s + Number(r[field] ?? 0), 0);

        return ok({
          range: { from: dFrom, to: dTo },
          applications: { total: apps.count ?? 0, by_status: byStatus(apps.data) },
          partners_total: partners.count ?? 0,
          referrals: { total: refs.count ?? 0, by_status: byStatus(refs.data, "attribution_status") },
          commissions: {
            holding_thb: sumBy(comms.data, "holding", "commission_amount_thb"),
            available_thb: sumBy(comms.data, "available", "commission_amount_thb"),
            paid_thb: sumBy(comms.data, "paid", "commission_amount_thb"),
            clawback_thb: sumBy(comms.data, "clawback", "commission_amount_thb"),
          },
          payouts: {
            pending_thb: sumBy(payouts.data, "pending", "amount_thb"),
            paid_thb: sumBy(payouts.data, "paid", "amount_thb"),
            failed_thb: sumBy(payouts.data, "failed", "amount_thb"),
          },
        });
      }

      case "get_partner_detail": {
        const { user_id } = params;
        if (!user_id) return fail("Missing user_id", 400);
        const [partner, app, code, comms, payouts] = await Promise.all([
          db.from("partners").select("*").eq("user_id", user_id).maybeSingle(),
          db.from("partner_applications").select("*").eq("user_id", user_id).maybeSingle(),
          db.from("referral_codes").select("*").eq("user_id", user_id)
            .eq("code_type", "partner_affiliate").maybeSingle(),
          db.from("commission_events").select("*").eq("partner_user_id", user_id)
            .order("created_at", { ascending: false }).limit(50),
          db.from("payout_requests").select("*").eq("partner_user_id", user_id)
            .order("requested_at", { ascending: false }).limit(20),
        ]);
        if (!partner.data) return fail("Partner not found", 404);
        return ok({
          partner: partner.data,
          application: app.data ? maskApplication(app.data) : null,
          referral_code: code.data,
          recent_commissions: comms.data ?? [],
          recent_payouts: payouts.data ?? [],
        });
      }

      case "list_all_referrals": {
        const { attribution_status, min_risk, page = 1, page_size = 50 } = params;
        let q = db.from("referrals").select("*", { count: "exact" });
        if (attribution_status) q = q.eq("attribution_status", attribution_status);
        if (typeof min_risk === "number") q = q.gte("risk_score", min_risk);
        const from = (page - 1) * page_size;
        q = q.order("created_at", { ascending: false }).range(from, from + page_size - 1);
        const { data, count, error } = await q;
        if (error) return fail(error.message, 500);
        return ok({ rows: data ?? [], total: count ?? 0, page, page_size });
      }

      case "list_fraud_alerts": {
        const { page = 1, page_size = 50 } = params;
        const from = (page - 1) * page_size;
        const { data, count, error } = await db
          .from("referrals")
          .select("*", { count: "exact" })
          .or("attribution_status.eq.fraud,risk_score.gte.70")
          .order("risk_score", { ascending: false })
          .range(from, from + page_size - 1);
        if (error) return fail(error.message, 500);
        return ok({ rows: data ?? [], total: count ?? 0, page, page_size });
      }

      // ════════════════════════════════════════════════════════════════
      //  ADMIN ACTIONS
      // ════════════════════════════════════════════════════════════════

      case "suspend_partner": {
        const { user_id, admin_id, reason } = params;
        if (!user_id || !admin_id || !reason) return fail("Missing user_id, admin_id, or reason", 400);
        const { error } = await db
          .from("partners")
          .update({
            suspended_at: new Date().toISOString(),
            suspended_reason: reason,
          })
          .eq("user_id", user_id);
        if (error) return fail(error.message, 500);
        // Also deactivate their partner code
        await db.from("referral_codes")
          .update({ is_active: false })
          .eq("user_id", user_id)
          .eq("code_type", "partner_affiliate");
        await audit(db, admin_id, "suspend_partner", "partner", user_id, { reason });
        return ok({ user_id, suspended: true });
      }

      case "unsuspend_partner": {
        const { user_id, admin_id } = params;
        if (!user_id || !admin_id) return fail("Missing user_id or admin_id", 400);
        const { error } = await db
          .from("partners")
          .update({ suspended_at: null, suspended_reason: null })
          .eq("user_id", user_id);
        if (error) return fail(error.message, 500);
        await db.from("referral_codes")
          .update({ is_active: true })
          .eq("user_id", user_id)
          .eq("code_type", "partner_affiliate");
        await audit(db, admin_id, "unsuspend_partner", "partner", user_id, {});
        return ok({ user_id, suspended: false });
      }

      case "adjust_commission_rate": {
        const { partner_user_id, new_rate, admin_id } = params;
        if (!partner_user_id || typeof new_rate !== "number" || !admin_id)
          return fail("Missing partner_user_id, new_rate, or admin_id", 400);
        if (new_rate < 0 || new_rate > 1) return fail("new_rate must be between 0 and 1", 400);
        const { data: prev } = await db
          .from("partners").select("commission_rate")
          .eq("user_id", partner_user_id).maybeSingle();
        const { error } = await db
          .from("partners")
          .update({ commission_rate: new_rate })
          .eq("user_id", partner_user_id);
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "adjust_commission_rate", "partner", partner_user_id, {
          previous_rate: prev?.commission_rate ?? null,
          new_rate,
        });
        return ok({ partner_user_id, commission_rate: new_rate });
      }

      case "manual_commission_adjustment": {
        const { partner_user_id, amount, reason, admin_id } = params;
        if (!partner_user_id || typeof amount !== "number" || !reason || !admin_id)
          return fail("Missing partner_user_id, amount, reason, or admin_id", 400);

        // Insert a synthetic commission_event marked 'available' immediately
        const now = new Date().toISOString();
        const { data: ev, error } = await db
          .from("commission_events")
          .insert({
            partner_user_id,
            referred_user_id: partner_user_id, // self-reference for manual adjustments
            referral_id: null as any, // will fail FK if NOT NULL — see note below
            gross_amount_thb: amount,
            net_amount_thb: amount,
            commission_rate: 0,
            commission_amount_thb: amount,
            billing_cycle: "manual",
            cycle_index: 0,
            status: amount >= 0 ? "available" : "clawback",
            hold_until: now,
            available_at: now,
          })
          .select()
          .single();
        if (error) {
          return fail(
            `Manual adjustment failed: ${error.message}. ` +
              `If you see a NOT NULL violation on referral_id, run: ` +
              `ALTER TABLE commission_events ALTER COLUMN referral_id DROP NOT NULL;`,
            500,
          );
        }
        await audit(db, admin_id, "manual_commission_adjustment", "partner", partner_user_id, {
          amount, reason, commission_event_id: ev.id,
        });
        return ok({ commission_event: ev });
      }

      // ════════════════════════════════════════════════════════════════
      // Page 3 — Cash Wallet Withdrawals queue
      // ════════════════════════════════════════════════════════════════
      case "list_withdrawals": {
        const { status, limit = 50, offset = 0 } = params;
        let q = db
          .from("cash_wallet_withdrawals")
          .select("*", { count: "exact" })
          .order("requested_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (status && status !== "all") q = q.eq("status", status);
        const { data, count, error } = await q;
        if (error) return fail(error.message, 500);

        // Enrich with partner display name + current wallet balance
        const userIds = [...new Set((data ?? []).map((w: any) => w.user_id))];
        const [{ data: profiles }, { data: wallets }] = await Promise.all([
          db.from("profiles").select("user_id, display_name").in("user_id", userIds),
          db.from("cash_wallets").select("user_id, balance_thb").in("user_id", userIds),
        ]);
        const pMap = new Map((profiles ?? []).map((p: any) => [p.user_id, p.display_name]));
        const wMap = new Map((wallets ?? []).map((w: any) => [w.user_id, w.balance_thb]));
        const enriched = (data ?? []).map((w: any) => ({
          ...w,
          partner_display_name: pMap.get(w.user_id) ?? null,
          current_wallet_balance_thb: Number(wMap.get(w.user_id) ?? 0),
        }));
        return ok({ withdrawals: enriched, total: count ?? 0 });
      }

      case "get_withdrawal": {
        const { withdrawal_id } = params;
        if (!withdrawal_id) return fail("Missing withdrawal_id", 400);
        const { data, error } = await db
          .from("cash_wallet_withdrawals")
          .select("*")
          .eq("id", withdrawal_id)
          .maybeSingle();
        if (error) return fail(error.message, 500);
        if (!data) return fail("Withdrawal not found", 404);
        const [{ data: profile }, { data: wallet }] = await Promise.all([
          db.from("profiles").select("display_name").eq("user_id", data.user_id).maybeSingle(),
          db.from("cash_wallets").select("balance_thb, lifetime_earned").eq("user_id", data.user_id).maybeSingle(),
        ]);
        return ok({
          withdrawal: {
            ...data,
            partner_display_name: profile?.display_name ?? null,
            current_wallet_balance_thb: Number(wallet?.balance_thb ?? 0),
            lifetime_earned_thb: Number(wallet?.lifetime_earned ?? 0),
          },
        });
      }

      case "approve_withdrawal": {
        const { withdrawal_id, admin_id, admin_note } = params;
        if (!withdrawal_id || !admin_id) return fail("Missing withdrawal_id or admin_id", 400);
        const { data: prev } = await db
          .from("cash_wallet_withdrawals").select("status, user_id, amount_thb")
          .eq("id", withdrawal_id).maybeSingle();
        if (!prev) return fail("Withdrawal not found", 404);
        if (prev.status !== "pending") return fail(`Cannot approve withdrawal in status: ${prev.status}`, 409);

        const { data, error } = await db
          .from("cash_wallet_withdrawals")
          .update({
            status: "approved",
            approved_at: new Date().toISOString(),
            approved_by: admin_id,
            admin_note: admin_note ?? null,
          })
          .eq("id", withdrawal_id)
          .eq("status", "pending") // optimistic concurrency
          .select()
          .single();
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "approve_withdrawal", "withdrawal", withdrawal_id, {
          user_id: prev.user_id, amount_thb: prev.amount_thb, admin_note,
        });
        return ok({ withdrawal: data });
      }

      case "reject_withdrawal": {
        const { withdrawal_id, admin_id, rejection_reason } = params;
        if (!withdrawal_id || !admin_id || !rejection_reason)
          return fail("Missing withdrawal_id, admin_id, or rejection_reason", 400);
        const { data: prev } = await db
          .from("cash_wallet_withdrawals").select("status, user_id, amount_thb")
          .eq("id", withdrawal_id).maybeSingle();
        if (!prev) return fail("Withdrawal not found", 404);
        if (!["pending", "approved"].includes(prev.status))
          return fail(`Cannot reject withdrawal in status: ${prev.status}`, 409);

        const { data, error } = await db
          .from("cash_wallet_withdrawals")
          .update({
            status: "rejected",
            rejected_at: new Date().toISOString(),
            rejected_by: admin_id,
            rejection_reason,
          })
          .eq("id", withdrawal_id)
          .select()
          .single();
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "reject_withdrawal", "withdrawal", withdrawal_id, {
          user_id: prev.user_id, amount_thb: prev.amount_thb, rejection_reason,
        });
        return ok({ withdrawal: data });
      }

      case "mark_withdrawal_paid": {
        const { withdrawal_id, admin_id, bank_reference } = params;
        if (!withdrawal_id || !admin_id || !bank_reference)
          return fail("Missing withdrawal_id, admin_id, or bank_reference", 400);
        const { data: prev } = await db
          .from("cash_wallet_withdrawals").select("status, user_id, amount_thb")
          .eq("id", withdrawal_id).maybeSingle();
        if (!prev) return fail("Withdrawal not found", 404);
        if (prev.status !== "approved")
          return fail(`Cannot mark paid: withdrawal must be 'approved', got '${prev.status}'`, 409);

        // Wallet debit + ledger entry happen here (single source of truth)
        // 1. Decrement wallet
        const { data: wallet, error: wErr } = await db
          .from("cash_wallets")
          .select("balance_thb")
          .eq("user_id", prev.user_id)
          .maybeSingle();
        if (wErr) return fail(wErr.message, 500);
        if (!wallet || Number(wallet.balance_thb) < Number(prev.amount_thb))
          return fail(`Insufficient wallet balance: have ฿${wallet?.balance_thb ?? 0}, need ฿${prev.amount_thb}`, 409);

        const newBalance = Number(wallet.balance_thb) - Number(prev.amount_thb);
        const { error: updWalletErr } = await db
          .from("cash_wallets")
          .update({ balance_thb: newBalance, updated_at: new Date().toISOString() })
          .eq("user_id", prev.user_id);
        if (updWalletErr) return fail(`Wallet debit failed: ${updWalletErr.message}`, 500);

        // 2. Ledger entry
        await db.from("cash_wallet_transactions").insert({
          user_id: prev.user_id,
          amount_thb: -Number(prev.amount_thb),
          tx_type: "withdrawal_paid",
          reference_id: withdrawal_id,
          note: `Withdrawal paid (bank ref: ${bank_reference})`,
        });

        // 3. Mark paid
        const { data, error } = await db
          .from("cash_wallet_withdrawals")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
            paid_by: admin_id,
            bank_reference,
          })
          .eq("id", withdrawal_id)
          .select()
          .single();
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "mark_withdrawal_paid", "withdrawal", withdrawal_id, {
          user_id: prev.user_id, amount_thb: prev.amount_thb, bank_reference, new_wallet_balance: newBalance,
        });
        return ok({ withdrawal: data });
      }

      // ════════════════════════════════════════════════════════════════
      // Admin Notes tab
      // ════════════════════════════════════════════════════════════════
      case "list_partner_notes": {
        const { partner_user_id } = params;
        if (!partner_user_id) return fail("Missing partner_user_id", 400);
        const { data, error } = await db
          .from("partner_admin_notes")
          .select("*")
          .eq("partner_user_id", partner_user_id)
          .order("created_at", { ascending: false });
        if (error) return fail(error.message, 500);

        // Enrich with author display names
        const authorIds = [...new Set((data ?? []).map((n: any) => n.author_id))];
        const { data: authors } = await db
          .from("profiles").select("user_id, display_name").in("user_id", authorIds);
        const aMap = new Map((authors ?? []).map((a: any) => [a.user_id, a.display_name]));
        return ok({
          notes: (data ?? []).map((n: any) => ({ ...n, author_display_name: aMap.get(n.author_id) ?? null })),
        });
      }

      case "add_partner_note": {
        const { partner_user_id, admin_id, note, visibility = "internal" } = params;
        if (!partner_user_id || !admin_id || !note) return fail("Missing partner_user_id, admin_id, or note", 400);
        if (!["internal", "partner_visible"].includes(visibility))
          return fail("visibility must be 'internal' or 'partner_visible'", 400);
        const { data, error } = await db
          .from("partner_admin_notes")
          .insert({ partner_user_id, author_id: admin_id, note, visibility })
          .select()
          .single();
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "add_partner_note", "partner", partner_user_id, {
          note_id: data.id, visibility, note_preview: note.slice(0, 80),
        });
        return ok({ note: data });
      }

      case "update_partner_note": {
        const { note_id, admin_id, note, visibility } = params;
        if (!note_id || !admin_id) return fail("Missing note_id or admin_id", 400);
        const patch: Record<string, unknown> = {};
        if (typeof note === "string") patch.note = note;
        if (visibility) {
          if (!["internal", "partner_visible"].includes(visibility))
            return fail("visibility must be 'internal' or 'partner_visible'", 400);
          patch.visibility = visibility;
        }
        if (Object.keys(patch).length === 0) return fail("No fields to update", 400);
        const { data, error } = await db
          .from("partner_admin_notes").update(patch).eq("id", note_id).select().single();
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "update_partner_note", "partner", data.partner_user_id, {
          note_id, patch: Object.keys(patch),
        });
        return ok({ note: data });
      }

      case "delete_partner_note": {
        const { note_id, admin_id } = params;
        if (!note_id || !admin_id) return fail("Missing note_id or admin_id", 400);
        const { data: prev } = await db
          .from("partner_admin_notes").select("partner_user_id").eq("id", note_id).maybeSingle();
        const { error } = await db.from("partner_admin_notes").delete().eq("id", note_id);
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "delete_partner_note", "partner", prev?.partner_user_id ?? note_id, { note_id });
        return ok({ note_id });
      }

      // ════════════════════════════════════════════════════════════════
      // Tier override (temporary commission rate override with expiry)
      // ════════════════════════════════════════════════════════════════
      case "set_tier_override": {
        const { partner_user_id, admin_id, new_rate, expires_at, reason } = params;
        if (!partner_user_id || !admin_id || typeof new_rate !== "number" || !expires_at || !reason)
          return fail("Missing partner_user_id, admin_id, new_rate, expires_at, or reason", 400);
        if (new_rate < 0 || new_rate > 1) return fail("new_rate must be between 0 and 1", 400);
        const expDate = new Date(expires_at);
        if (Number.isNaN(expDate.getTime()) || expDate <= new Date())
          return fail("expires_at must be a future ISO timestamp", 400);

        const { data: prev } = await db
          .from("partners").select("commission_rate, tier_override_expires_at, tier_override_reason")
          .eq("user_id", partner_user_id).maybeSingle();
        if (!prev) return fail("Partner not found", 404);

        const { data, error } = await db
          .from("partners")
          .update({
            commission_rate: new_rate,
            tier_override_expires_at: expDate.toISOString(),
            tier_override_reason: reason,
            tier_override_set_by: admin_id,
            tier_override_set_at: new Date().toISOString(),
          })
          .eq("user_id", partner_user_id)
          .select()
          .single();
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "set_tier_override", "partner", partner_user_id, {
          previous_rate: prev.commission_rate,
          new_rate,
          expires_at: expDate.toISOString(),
          reason,
        });
        return ok({ partner: data });
      }

      case "clear_tier_override": {
        const { partner_user_id, admin_id, restore_rate } = params;
        if (!partner_user_id || !admin_id || typeof restore_rate !== "number")
          return fail("Missing partner_user_id, admin_id, or restore_rate", 400);
        if (restore_rate < 0 || restore_rate > 1) return fail("restore_rate must be between 0 and 1", 400);

        const { data: prev } = await db
          .from("partners").select("commission_rate, tier_override_expires_at, tier_override_reason")
          .eq("user_id", partner_user_id).maybeSingle();
        if (!prev) return fail("Partner not found", 404);

        const { data, error } = await db
          .from("partners")
          .update({
            commission_rate: restore_rate,
            tier_override_expires_at: null,
            tier_override_reason: null,
            tier_override_set_by: null,
            tier_override_set_at: null,
          })
          .eq("user_id", partner_user_id)
          .select()
          .single();
        if (error) return fail(error.message, 500);
        await audit(db, admin_id, "clear_tier_override", "partner", partner_user_id, {
          previous_rate: prev.commission_rate,
          previous_override_reason: prev.tier_override_reason,
          restored_rate: restore_rate,
        });
        return ok({ partner: data });
      }

      // ── Aliases for admin-hub frontend ──────────────────────────────
      case "list_partners": {
        const { data, error } = await db.from("partners").select("*").order("created_at", { ascending: false });
        if (error) return fail(error.message);
        return ok(data);
      }
      case "list_payouts": {
        // Alias → list_payout_requests
        const { data, error } = await db.from("payout_requests").select("*").order("requested_at", { ascending: false }).limit(params?.limit ?? 50);
        if (error) return fail(error.message);
        return ok(data);
      }
      case "list_commission_events": {
        const { data, error } = await db.from("commission_events").select("*").order("created_at", { ascending: false }).limit(params?.limit ?? 50);
        if (error) return fail(error.message);
        return ok(data);
      }
      case "list_fraud_flags": {
        const limit = params?.limit ?? 50;
        const offset = params?.offset ?? 0;
        let query = db.from("fraud_flags").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
        if (params?.status && params.status !== "all") query = query.eq("status", params.status);
        if (params?.severity && params.severity !== "all") query = query.eq("severity", params.severity);
        if (params?.kind && params.kind !== "all") query = query.eq("kind", params.kind);
        const { data, error, count } = await query;
        if (error) return fail(error.message);
        // Count by severity for summary badges
        const { data: allFlags } = await db.from("fraud_flags").select("severity, status");
        const counts = { open: 0, critical: 0, high: 0, medium: 0, low: 0 };
        for (const f of allFlags ?? []) {
          if (f.status === "open") counts.open++;
          if (f.severity === "critical") counts.critical++;
          else if (f.severity === "high") counts.high++;
          else if (f.severity === "medium") counts.medium++;
          else if (f.severity === "low") counts.low++;
        }
        return ok({ items: data ?? [], total: count ?? 0, limit, offset, counts });
      }

      // ════════════════════════════════════════════════════════════════
      default:
        return fail(`Unknown action: ${action}`, 400);
    }
  } catch (err: any) {
    // Never leak stack traces — log server-side, return generic message
    console.error("[erp-affiliate-bridge] unhandled:", err?.message ?? err);
    return fail("Internal server error", 500);
  }
});
