// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendTransactionalEmail } from "./sendEmail.ts";

const ZERO_DECIMAL_CURRENCIES = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(Number.isFinite(n) ? n : 0);
}

function majorFromStripeAmount(amount: number | null | undefined, currency: string | null | undefined): number {
  const safeAmount = Number(amount ?? 0);
  return ZERO_DECIMAL_CURRENCIES.has(String(currency ?? "").toLowerCase())
    ? safeAmount
    : safeAmount / 100;
}

function documentNumber(prefix: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${prefix}-${y}${m}${d}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function firstHttpsUrl(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.startsWith("https://")) return trimmed;
  }
  return null;
}

function titleFromPayment(payment: any): string {
  const meta = payment?.checkout_metadata && typeof payment.checkout_metadata === "object"
    ? payment.checkout_metadata
    : {};
  return asString(meta.package_name)
    || asString(meta.plan_name)
    || asString(meta.type)
    || (payment?.payment_scope === "organization" ? "Organization credits" : "MediaForge credits");
}

async function hydratePaymentUser(client: SupabaseClient, userId: string | null | undefined) {
  if (!userId) return { email: null, firstName: "there" };
  try {
    const { data } = await client.auth.admin.getUserById(userId);
    const user = data?.user;
    const email = user?.email ?? null;
    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
    const firstName = asString(meta.first_name)
      || asString(meta.full_name).split(" ")[0]
      || asString(meta.display_name).split(" ")[0]
      || (email ? email.split("@")[0] : "there");
    return { email, firstName };
  } catch {
    return { email: null, firstName: "there" };
  }
}

async function logBillingDocumentEvent(
  client: SupabaseClient,
  billingDocumentId: string,
  eventType: string,
  details: Record<string, unknown> = {},
  actor?: { id?: string | null; email?: string | null },
) {
  try {
    await client.from("billing_document_events").insert({
      billing_document_id: billingDocumentId,
      event_type: eventType,
      actor_id: actor?.id ?? null,
      actor_email: actor?.email ?? null,
      details,
    });
  } catch (error) {
    console.warn("[billingDocuments] event log failed:", error);
  }
}

async function upsertDocument(client: SupabaseClient, values: Record<string, unknown>) {
  const { data, error } = await client
    .from("billing_documents")
    .upsert(values, {
      onConflict: "source,document_type,source_reference",
      ignoreDuplicates: false,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function sendBillingDocumentEmail(
  client: SupabaseClient,
  document: any,
  opts: { actorId?: string | null; actorEmail?: string | null } = {},
) {
  const emailTo = asString(document?.email_to);
  if (!emailTo) {
    await client.from("billing_documents").update({
      email_status: "skipped",
      email_error: "missing_recipient",
    }).eq("id", document.id);
    return { success: false, error: "missing_recipient" };
  }

  const { firstName } = await hydratePaymentUser(client, document.user_id);
  const paymentDate = document.issued_at
    ? new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(new Date(document.issued_at))
    : new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(new Date());
  const amountThb = Number(document.amount_thb ?? 0);
  const title = asString(document.title) || (document.document_type.includes("invoice") ? "MediaForge invoice" : "MediaForge receipt");
  const transactionsUrl = document.organization_id
    ? "https://mediaforge-admin-hub.vercel.app/org/console"
    : "https://mediaforge.co/app/transactions";

  const result = await sendTransactionalEmail("payment_receipt", emailTo, {
    first_name: firstName,
    invoice_number: document.document_number,
    payment_date: paymentDate,
    package_name: title,
    credits_added: fmtNum(Number(document.credits_added ?? 0)),
    amount_thb: fmtNum(amountThb),
    transactions_url: transactionsUrl,
    receipt_url: document.receipt_url ?? document.hosted_url ?? null,
    invoice_url: document.invoice_url ?? null,
    invoice_pdf_url: document.invoice_pdf_url ?? null,
  }, {
    subject: document.document_type.includes("invoice")
      ? `MediaForge invoice ${document.document_number}`
      : `MediaForge receipt ${document.document_number}`,
  });

  await client.from("billing_documents").update({
    status: result.success ? "emailed" : "email_failed",
    email_status: result.success ? "sent" : "failed",
    email_error: result.success ? null : (result.error ?? "send_failed"),
    email_sent_at: result.success ? new Date().toISOString() : document.email_sent_at ?? null,
  }).eq("id", document.id);

  await logBillingDocumentEvent(
    client,
    document.id,
    result.success ? "email_sent" : "email_failed",
    { to: emailTo, error: result.error ?? null },
    { id: opts.actorId ?? null, email: opts.actorEmail ?? null },
  );

  return result;
}

export async function syncBillingDocumentsForPayment(
  client: SupabaseClient,
  stripe: any,
  paymentInput: any,
  opts: { sendEmail?: boolean; actorId?: string | null; actorEmail?: string | null } = {},
) {
  let payment = paymentInput;
  if (!payment?.id) return { documents: [], payment: paymentInput };

  const updates: Record<string, unknown> = {};
  let charge: any = null;
  let invoice: any = null;
  let invoiceId = asString(payment.stripe_invoice_id);
  let chargeId = asString(payment.stripe_charge_id);

  try {
    if (payment.stripe_payment_intent_id) {
      const intent = await stripe.paymentIntents.retrieve(
        payment.stripe_payment_intent_id,
        { expand: ["latest_charge"] } as any,
      ) as any;
      const latestCharge = intent?.latest_charge;
      if (typeof latestCharge === "string") {
        charge = await stripe.charges.retrieve(latestCharge);
      } else if (latestCharge && typeof latestCharge === "object") {
        charge = latestCharge;
      }
      if (intent?.customer && !payment.stripe_customer_id) updates.stripe_customer_id = typeof intent.customer === "string" ? intent.customer : intent.customer.id;
    }

    if (charge?.id) {
      chargeId = charge.id;
      updates.stripe_charge_id = charge.id;
      if (charge.receipt_url) updates.receipt_url = charge.receipt_url;
      if (charge.receipt_number) updates.receipt_number = charge.receipt_number;
      if (charge.invoice && !invoiceId) {
        invoiceId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice.id;
        updates.stripe_invoice_id = invoiceId;
      }
    }

    if (invoiceId) {
      invoice = await stripe.invoices.retrieve(invoiceId) as any;
      updates.stripe_invoice_id = invoice.id ?? invoiceId;
      if (invoice.customer && !payment.stripe_customer_id) {
        updates.stripe_customer_id = typeof invoice.customer === "string" ? invoice.customer : invoice.customer.id;
      }
      if (invoice.hosted_invoice_url) updates.invoice_url = invoice.hosted_invoice_url;
      if (invoice.invoice_pdf) updates.invoice_pdf_url = invoice.invoice_pdf;
    }
  } catch (error) {
    console.warn("[billingDocuments] Stripe document lookup failed:", error);
  }

  if (firstHttpsUrl(updates.receipt_url, payment.receipt_url, updates.invoice_url, payment.invoice_url)) {
    updates.receipt_generated_at = new Date().toISOString();
  }

  if (Object.keys(updates).length > 0) {
    const { data, error } = await client
      .from("payment_transactions")
      .update(updates)
      .eq("id", payment.id)
      .select("*")
      .maybeSingle();
    if (error) console.warn("[billingDocuments] payment cache update failed:", error);
    if (data) payment = data;
    else payment = { ...payment, ...updates };
  }

  const { email } = await hydratePaymentUser(client, payment.user_id);
  const currency = String(payment.currency ?? invoice?.currency ?? charge?.currency ?? "thb").toLowerCase();
  const amountMinor = Number.isFinite(Number(charge?.amount))
    ? Number(charge.amount)
    : Number.isFinite(Number(invoice?.amount_paid))
      ? Number(invoice.amount_paid)
      : null;
  const amountThb = Number(payment.amount_thb ?? (currency === "thb" ? majorFromStripeAmount(amountMinor, currency) : 0));
  const baseDoc = {
    payment_transaction_id: payment.id,
    user_id: payment.user_id ?? null,
    organization_id: payment.organization_id ?? null,
    source: "stripe",
    status: "issued",
    title: titleFromPayment(payment),
    currency,
    amount_minor: amountMinor,
    amount_thb: Number.isFinite(amountThb) ? amountThb : null,
    credits_added: Number(payment.credits_added ?? 0),
    stripe_session_id: payment.stripe_session_id ?? null,
    stripe_payment_intent_id: payment.stripe_payment_intent_id ?? null,
    stripe_charge_id: chargeId || null,
    stripe_invoice_id: invoice?.id ?? invoiceId ?? null,
    stripe_customer_id: payment.stripe_customer_id ?? updates.stripe_customer_id ?? null,
    email_to: email,
    line_items: [{
      description: titleFromPayment(payment),
      credits: Number(payment.credits_added ?? 0),
      amount_thb: Number.isFinite(amountThb) ? amountThb : null,
    }],
    metadata: {
      checkout_metadata: payment.checkout_metadata ?? {},
      payment_scope: payment.payment_scope ?? null,
    },
  };

  const documents: any[] = [];
  const receiptUrl = firstHttpsUrl(payment.receipt_url, updates.receipt_url, charge?.receipt_url);
  if (chargeId || receiptUrl) {
    const receiptDoc = await upsertDocument(client, {
      ...baseDoc,
      document_type: "receipt",
      source_reference: chargeId || payment.stripe_payment_intent_id || payment.id,
      document_number: payment.receipt_number || documentNumber("RCPT"),
      receipt_url: receiptUrl,
      invoice_url: firstHttpsUrl(payment.invoice_url, updates.invoice_url, invoice?.hosted_invoice_url),
      invoice_pdf_url: firstHttpsUrl((payment as any).invoice_pdf_url, updates.invoice_pdf_url, invoice?.invoice_pdf),
    });
    documents.push(receiptDoc);
    await logBillingDocumentEvent(client, receiptDoc.id, "synced_from_stripe", {
      payment_transaction_id: payment.id,
      stripe_charge_id: chargeId || null,
    }, { id: opts.actorId ?? null, email: opts.actorEmail ?? null });
  }

  const invoiceUrl = firstHttpsUrl(payment.invoice_url, updates.invoice_url, invoice?.hosted_invoice_url, invoice?.invoice_pdf);
  if (invoice?.id || invoiceUrl) {
    const invoiceDoc = await upsertDocument(client, {
      ...baseDoc,
      document_type: "invoice",
      source_reference: invoice?.id ?? invoiceId ?? payment.id,
      document_number: invoice?.number || documentNumber("INV"),
      receipt_url: receiptUrl,
      invoice_url: firstHttpsUrl(invoice?.hosted_invoice_url, payment.invoice_url, updates.invoice_url),
      invoice_pdf_url: firstHttpsUrl(invoice?.invoice_pdf, updates.invoice_pdf_url),
    });
    documents.push(invoiceDoc);
    await logBillingDocumentEvent(client, invoiceDoc.id, "synced_from_stripe", {
      payment_transaction_id: payment.id,
      stripe_invoice_id: invoice?.id ?? invoiceId ?? null,
    }, { id: opts.actorId ?? null, email: opts.actorEmail ?? null });
  }

  if (opts.sendEmail !== false && documents.length > 0) {
    const docToEmail = documents.find((doc) => doc.document_type === "invoice") ?? documents[0];
    if (docToEmail?.email_status !== "sent") {
      await sendBillingDocumentEmail(client, docToEmail, opts);
    }
  }

  return { documents, payment };
}

export async function createManualBillingDocument(
  client: SupabaseClient,
  input: Record<string, unknown>,
  actor?: { id?: string | null; email?: string | null },
) {
  const requestedType = asString(input.document_type, "manual_invoice");
  const documentType = requestedType === "manual_receipt" ? "manual_receipt" : "manual_invoice";
  const amountThb = Number(input.amount_thb ?? 0);
  if (!Number.isFinite(amountThb) || amountThb < 0) {
    throw new Error("amount_thb must be zero or greater");
  }
  const emailTo = asString(input.email_to);
  const title = asString(input.title) || (documentType === "manual_invoice" ? "Manual invoice" : "Manual receipt");
  const doc = await upsertDocument(client, {
    user_id: asString(input.user_id) || null,
    organization_id: asString(input.organization_id) || null,
    document_type: documentType,
    source: "manual",
    source_reference: `manual:${crypto.randomUUID()}`,
    status: "issued",
    document_number: documentNumber(documentType === "manual_invoice" ? "INV-M" : "RCPT-M"),
    title,
    currency: asString(input.currency, "thb").toLowerCase(),
    amount_thb: amountThb,
    credits_added: Number(input.credits_added ?? 0),
    email_to: emailTo || null,
    created_by: actor?.id ?? null,
    line_items: Array.isArray(input.line_items)
      ? input.line_items
      : [{
        description: title,
        amount_thb: amountThb,
        credits: Number(input.credits_added ?? 0),
      }],
    metadata: {
      reason: asString(input.reason),
      note: asString(input.note),
      created_from: "admin_workspace_billing",
    },
  });

  await logBillingDocumentEvent(client, doc.id, "manual_created", {
    amount_thb: amountThb,
    document_type: documentType,
  }, actor);

  return doc;
}
