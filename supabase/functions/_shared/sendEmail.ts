/**
 * Shared SendGrid email helper for edge functions.
 * Service-role token is used so any edge function can send to any recipient.
 *
 * Usage:
 *   await sendTransactionalEmail("payment_receipt", "user@example.com", {
 *     first_name: "John",
 *     invoice_number: "INV-001",
 *     ...
 *   });
 *
 * Failures are logged but never thrown — emails are best-effort.
 */
export interface TransactionalEmailAttachment {
  content: string;
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
  content_id?: string;
}

export async function sendTransactionalEmail(
  template: string,
  to: string,
  data: Record<string, unknown>,
  opts?: { subject?: string; reply_to?: string; attachments?: TransactionalEmailAttachment[] },
): Promise<{ success: boolean; message_id?: string; error?: string; attachment_count?: number }> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.warn("[sendTransactionalEmail] Missing Supabase env — skipping send");
    return { success: false, error: "missing_env" };
  }

  if (!to || !template) {
    console.warn("[sendTransactionalEmail] Missing template or recipient — skipping");
    return { success: false, error: "invalid_args" };
  }

  // Always include current_year so templates render correctly
  const enrichedData = {
    current_year: new Date().getFullYear(),
    ...data,
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template,
        to,
        data: enrichedData,
        ...(opts?.subject ? { subject: opts.subject } : {}),
        ...(opts?.reply_to ? { reply_to: opts.reply_to } : {}),
        ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[sendTransactionalEmail] template=${template} to=${to} HTTP ${res.status}: ${errText.substring(0, 200)}`);
      let providerError = `http_${res.status}`;
      try {
        const parsed = JSON.parse(errText);
        const errorText = typeof parsed?.error === "string" ? parsed.error : "";
        if (errorText.includes("SENDGRID_API_KEY") || errorText === "email_provider_not_configured") {
          providerError = "email_provider_not_configured";
        } else if (errorText) {
          providerError = errorText;
        }
      } catch {
        // Keep the generic HTTP code if the email function returns plain text.
      }
      return { success: false, error: providerError };
    }

    const json = await res.json();
    const attachmentCount = Number(json.attachment_count ?? opts?.attachments?.length ?? 0);
    console.log(`[sendTransactionalEmail] template=${template} to=${to} message_id=${json.message_id ?? "n/a"} attachments=${attachmentCount}`);
    return { success: true, message_id: json.message_id, attachment_count: attachmentCount };
  } catch (e) {
    console.warn(`[sendTransactionalEmail] template=${template} to=${to} error:`, e);
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
