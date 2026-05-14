/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { verifyAdminJwt, unauthorizedResponse } from "../_shared/adminAuth.ts";
import {
  createManualBillingDocument,
  sendBillingDocumentEmail,
  syncBillingDocumentsForPayment,
} from "../_shared/billingDocuments.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-email, x-admin-auth-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const PAYMENT_SELECT = [
  "id",
  "user_id",
  "organization_id",
  "payment_scope",
  "stripe_session_id",
  "stripe_payment_intent_id",
  "stripe_charge_id",
  "stripe_invoice_id",
  "stripe_customer_id",
  "amount_thb",
  "currency",
  "amount_original",
  "credits_added",
  "status",
  "payment_method",
  "receipt_url",
  "invoice_url",
  "invoice_pdf_url",
  "receipt_number",
  "receipt_generated_at",
  "checkout_metadata",
  "created_at",
  "updated_at",
].join(",");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function stripeClient() {
  const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!key) throw new Error("Stripe is not configured");
  return new Stripe(key, { apiVersion: "2026-02-25.clover" as any });
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampLimit(raw: unknown, fallback = 50, max = 200) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function findUserByEmail(client: SupabaseClient, email: string) {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  for (let page = 1; page <= 40; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth user lookup failed: ${error.message}`);
    const users = data?.users ?? [];
    const found = users.find((user) => String(user.email ?? "").toLowerCase() === target);
    if (found) return found;
    if (users.length < 1000) break;
  }
  return null;
}

async function hydrateUsers(client: SupabaseClient, rows: any[]) {
  const ids = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
  const byId = new Map<string, { email: string | null; display_name: string | null }>();
  await Promise.all(ids.map(async (id) => {
    try {
      const { data } = await client.auth.admin.getUserById(id);
      const user = data?.user;
      byId.set(id, {
        email: user?.email ?? null,
        display_name: (user?.user_metadata?.display_name ?? user?.user_metadata?.full_name ?? null) as string | null,
      });
    } catch {
      byId.set(id, { email: null, display_name: null });
    }
  }));
  return rows.map((row) => ({
    ...row,
    user_email: row.email_to ?? byId.get(row.user_id)?.email ?? null,
    user_display_name: byId.get(row.user_id)?.display_name ?? null,
  }));
}

async function listBillingDocuments(client: SupabaseClient, body: Record<string, unknown>) {
  const limit = clampLimit(body.limit, 50);
  const status = asString(body.status);
  const search = asString(body.search).toLowerCase();
  const organizationId = asString(body.organization_id);

  let docsQuery = client
    .from("billing_documents")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status && status !== "all") docsQuery = docsQuery.eq("status", status);
  if (organizationId) docsQuery = docsQuery.eq("organization_id", organizationId);

  const { data: docsRaw, error: docsError } = await docsQuery;
  if (docsError) throw new Error(`billing documents read failed: ${docsError.message}`);

  let paymentsQuery = client
    .from("payment_transactions")
    .select(PAYMENT_SELECT)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (organizationId) paymentsQuery = paymentsQuery.eq("organization_id", organizationId);

  const { data: paymentsRaw, error: paymentsError } = await paymentsQuery;
  if (paymentsError) throw new Error(`payments read failed: ${paymentsError.message}`);

  const docs = await hydrateUsers(client, docsRaw ?? []);
  const payments = await hydrateUsers(client, paymentsRaw ?? []);
  const paymentIds = (paymentsRaw ?? []).map((payment: any) => payment.id).filter(Boolean);
  let docPaymentIds = new Set<string>();
  if (paymentIds.length > 0) {
    const { data: linkedDocs, error: linkedDocsError } = await client
      .from("billing_documents")
      .select("payment_transaction_id")
      .in("payment_transaction_id", paymentIds);
    if (linkedDocsError) throw new Error(`billing document link read failed: ${linkedDocsError.message}`);
    docPaymentIds = new Set((linkedDocs ?? []).map((doc: any) => doc.payment_transaction_id).filter(Boolean));
  }
  const paymentsMissingDocuments = payments.filter((payment: any) => !docPaymentIds.has(payment.id));

  const filteredDocs = search
    ? docs.filter((doc: any) => {
      const haystack = [
        doc.document_number,
        doc.title,
        doc.user_email,
        doc.stripe_payment_intent_id,
        doc.stripe_invoice_id,
        doc.stripe_charge_id,
      ].map((value) => String(value ?? "").toLowerCase()).join(" ");
      return haystack.includes(search);
    })
    : docs;

  return {
    data: {
      documents: filteredDocs,
      recent_payments: payments,
      payments_missing_documents: paymentsMissingDocuments,
      summary: {
        documents: docs.length,
        needs_email: docs.filter((doc: any) => doc.email_status !== "sent").length,
        payments_missing_documents: paymentsMissingDocuments.length,
      },
    },
  };
}

async function syncBillingDocument(client: SupabaseClient, body: Record<string, unknown>, actor: { id: string; email: string }) {
  const paymentTransactionId = asString(body.payment_transaction_id);
  if (!paymentTransactionId) throw new Error("payment_transaction_id is required");

  const { data: payment, error } = await client
    .from("payment_transactions")
    .select(PAYMENT_SELECT)
    .eq("id", paymentTransactionId)
    .maybeSingle();
  if (error) throw new Error(`payment read failed: ${error.message}`);
  if (!payment) throw new Error("payment transaction not found");

  const result = await syncBillingDocumentsForPayment(client, stripeClient(), payment, {
    sendEmail: body.send_email === true,
    actorId: actor.id,
    actorEmail: actor.email,
  });
  return { data: result };
}

async function resendBillingDocument(client: SupabaseClient, body: Record<string, unknown>, actor: { id: string; email: string }) {
  const documentId = asString(body.document_id);
  if (!documentId) throw new Error("document_id is required");

  const { data: doc, error } = await client
    .from("billing_documents")
    .select("*")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw new Error(`document read failed: ${error.message}`);
  if (!doc) throw new Error("billing document not found");

  const result = await sendBillingDocumentEmail(client, doc, { actorId: actor.id, actorEmail: actor.email });
  return { data: { document_id: documentId, email: result } };
}

async function voidBillingDocument(client: SupabaseClient, body: Record<string, unknown>, actor: { id: string; email: string }) {
  const documentId = asString(body.document_id);
  if (!documentId) throw new Error("document_id is required");

  const { data, error } = await client
    .from("billing_documents")
    .update({
      status: "voided",
      voided_at: new Date().toISOString(),
      metadata: {
        void_reason: asString(body.reason, "Voided by admin"),
      },
    })
    .eq("id", documentId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`void document failed: ${error.message}`);
  if (!data) throw new Error("billing document not found");

  await client.from("billing_document_events").insert({
    billing_document_id: documentId,
    event_type: "voided",
    actor_id: actor.id,
    actor_email: actor.email,
    details: { reason: asString(body.reason) },
  });

  return { data };
}

async function createManualDocument(client: SupabaseClient, body: Record<string, unknown>, actor: { id: string; email: string }) {
  const email = asString(body.email_to).toLowerCase();
  let userId = asString(body.user_id) || null;
  if (!userId && email) {
    const user = await findUserByEmail(client, email);
    userId = user?.id ?? null;
  }

  const doc = await createManualBillingDocument(client, {
    ...body,
    user_id: userId,
    email_to: email || asString(body.email_to),
  }, { id: actor.id, email: actor.email });

  let emailResult = null;
  if (body.send_email === true) {
    emailResult = await sendBillingDocumentEmail(client, doc, { actorId: actor.id, actorEmail: actor.email });
  }

  return { data: { document: doc, email: emailResult } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const admin = await verifyAdminJwt(req);
  if (!admin) return unauthorizedResponse(CORS_HEADERS);

  try {
    const body = await req.json().catch(() => ({}));
    const action = asString(body.action);
    const client = adminClient();
    const actor = { id: admin.sub, email: admin.email };

    switch (action) {
      case "list_billing_documents":
        return json(await listBillingDocuments(client, body));
      case "sync_billing_document":
        return json(await syncBillingDocument(client, body, actor));
      case "resend_billing_document":
        return json(await resendBillingDocument(client, body, actor));
      case "void_billing_document":
        return json(await voidBillingDocument(client, body, actor));
      case "create_manual_billing_document":
        return json(await createManualDocument(client, body, actor));
      default:
        return json({ error: `Unsupported action: ${action}` }, 400);
    }
  } catch (error) {
    console.error("[admin_workspace_billing] Error:", error);
    return json({ error: error instanceof Error ? error.message : "Internal server error" }, 500);
  }
});
