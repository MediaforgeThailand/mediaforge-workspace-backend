// deno-lint-ignore-file no-explicit-any
import { sendTransactionalEmail } from "./sendEmail.ts";

type SupabaseClient = any;
type EmailAttachment = {
  content: string;
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
};

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

function pdfSafeText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

function pdfEscape(value: unknown): string {
  return pdfSafeText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapPdfLine(value: unknown, max = 84): string[] {
  const text = pdfSafeText(value);
  if (!text) return [""];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= max) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function simplePdf(lines: Array<{ text: string; size?: number; gap?: number }>): Uint8Array {
  const encoder = new TextEncoder();
  const content: string[] = ["q", "1 1 1 rg", "0 0 612 792 re f", "Q"];
  let y = 742;
  for (const line of lines) {
    const size = line.size ?? 10;
    content.push("BT", `/F1 ${size} Tf`, `50 ${y} Td`, `(${pdfEscape(line.text)}) Tj`, "ET");
    y -= line.gap ?? Math.max(14, size + 5);
    if (y < 48) break;
  }
  const stream = `${content.join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}endstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function documentFilename(document: any): string {
  const number = pdfSafeText(document?.document_number || "mediaforge-document")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${number || "mediaforge-document"}.pdf`;
}

export function buildGeneratedBillingDocumentPdfAttachment(document: any): EmailAttachment {
  const typeLabel = String(document?.document_type ?? "").includes("receipt") ? "Receipt" : "Invoice";
  const issuedAt = document?.issued_at ? new Date(document.issued_at) : new Date();
  const issued = Number.isFinite(issuedAt.getTime()) ? issuedAt.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const currency = String(document?.currency ?? "thb").toUpperCase();
  const amount = fmtNum(Number(document?.amount_thb ?? 0));
  const lineItems = Array.isArray(document?.line_items) ? document.line_items : [];
  const metadata = document?.metadata && typeof document.metadata === "object" ? document.metadata : {};
  const rows: Array<{ text: string; size?: number; gap?: number }> = [
    { text: `MediaForge ${typeLabel}`, size: 20, gap: 30 },
    { text: `Document number: ${document?.document_number ?? "-"}`, size: 11 },
    { text: `Issued date: ${issued}`, size: 11 },
    { text: `Recipient: ${document?.email_to ?? "-"}`, size: 11 },
    { text: `Title: ${document?.title ?? "-"}`, size: 11 },
    { text: `Amount: ${amount} ${currency}`, size: 11 },
    { text: `Credits: ${fmtNum(Number(document?.credits_added ?? 0))}`, size: 11, gap: 24 },
    { text: "Line items", size: 13, gap: 18 },
  ];

  if (lineItems.length > 0) {
    for (const item of lineItems.slice(0, 12)) {
      const description = pdfSafeText(item?.description || "MediaForge credits");
      const itemCredits = Number(item?.credits ?? 0);
      const itemAmount = Number(item?.amount_thb ?? 0);
      for (const wrapped of wrapPdfLine(`- ${description} | credits: ${fmtNum(itemCredits)} | amount: ${fmtNum(itemAmount)} ${currency}`, 86)) {
        rows.push({ text: wrapped, size: 10 });
      }
    }
  } else {
    rows.push({ text: "- MediaForge billing document", size: 10 });
  }

  const note = pdfSafeText(metadata.note || metadata.reason || "");
  if (note) {
    rows.push({ text: "", gap: 10 });
    rows.push({ text: "Note", size: 13, gap: 18 });
    for (const wrapped of wrapPdfLine(note, 86)) rows.push({ text: wrapped, size: 10 });
  }

  rows.push({ text: "", gap: 12 });
  rows.push({ text: "MediaForge Co., Ltd. | https://mediaforge.co", size: 9 });
  rows.push({ text: "This PDF was generated automatically for billing records.", size: 9 });

  return {
    content: bytesToBase64(simplePdf(rows)),
    filename: documentFilename(document),
    type: "application/pdf",
    disposition: "attachment",
  };
}

async function buildBillingDocumentPdfAttachment(document: any): Promise<EmailAttachment> {
  const pdfUrl = firstHttpsUrl(document?.invoice_pdf_url);
  if (pdfUrl) {
    try {
      const response = await fetch(pdfUrl);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 0 && bytes.length <= 7_500_000) {
          return {
            content: bytesToBase64(bytes),
            filename: documentFilename(document),
            type: "application/pdf",
            disposition: "attachment",
          };
        }
      }
    } catch (error) {
      console.warn("[billingDocuments] invoice_pdf_url fetch failed, using generated PDF:", error);
    }
  }

  return buildGeneratedBillingDocumentPdfAttachment(document);
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
  const source = asString(values.source);
  const documentType = asString(values.document_type);
  const sourceReference = asString(values.source_reference);
  if (!source || !documentType || !sourceReference) {
    throw new Error("billing document source, type, and reference are required");
  }

  const { data: existing, error: existingError } = await client
    .from("billing_documents")
    .select("*")
    .eq("source", source)
    .eq("document_type", documentType)
    .eq("source_reference", sourceReference)
    .maybeSingle();
  if (existingError) throw existingError;

  if (existing?.id) {
    const updateValues = { ...values };
    delete updateValues.document_number;
    delete updateValues.issued_at;
    delete updateValues.created_by;

    const { data, error } = await client
      .from("billing_documents")
      .update(updateValues)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await client
    .from("billing_documents")
    .insert(values)
    .select("*")
    .single();
  if (error) {
    // Unique-race fallback: keep the original document number stable if a
    // duplicate insert landed between the select and insert.
    const { data: raced, error: racedError } = await client
      .from("billing_documents")
      .select("*")
      .eq("source", source)
      .eq("document_type", documentType)
      .eq("source_reference", sourceReference)
      .maybeSingle();
    if (raced?.id && !racedError) return raced;
    throw error;
  }
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
  const pdfAttachment = await buildBillingDocumentPdfAttachment(document);

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
    attachments: [pdfAttachment],
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
    {
      to: emailTo,
      error: result.error ?? null,
      attachment_filename: pdfAttachment.filename,
      attachment_count: 1,
    },
    { id: opts.actorId ?? null, email: opts.actorEmail ?? null },
  );

  return {
    ...result,
    attachment_count: result.attachment_count ?? 1,
    attachment_filename: pdfAttachment.filename,
  };
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
