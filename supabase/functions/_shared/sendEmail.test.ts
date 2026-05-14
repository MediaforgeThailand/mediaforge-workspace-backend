import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendTransactionalEmail } from "./sendEmail.ts";

Deno.test("sendTransactionalEmail — maps missing provider config to readable error", async () => {
  const originalUrl = Deno.env.get("SUPABASE_URL");
  const originalServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const originalFetch = globalThis.fetch;

  try {
    Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    (globalThis as any).fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ error: "email_provider_not_configured" }), {
        status: 500,
      }));

    const result = await sendTransactionalEmail("payment_receipt", "user@example.com", {});
    assertEquals(result.success, false);
    assertEquals(result.error, "email_provider_not_configured");
  } finally {
    (globalThis as any).fetch = originalFetch;
    if (originalUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", originalUrl);
    if (originalServiceKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", originalServiceKey);
  }
});

Deno.test("sendTransactionalEmail — forwards PDF attachments to send-email", async () => {
  const originalUrl = Deno.env.get("SUPABASE_URL");
  const originalServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;

  try {
    Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return Promise.resolve(new Response(JSON.stringify({ message_id: "msg_test" }), { status: 200 }));
    };

    const result = await sendTransactionalEmail("payment_receipt", "user@example.com", {}, {
      attachments: [{
        content: "JVBERi0xLjQK",
        filename: "invoice.pdf",
        type: "application/pdf",
        disposition: "attachment",
      }],
    });

    assertEquals(result.success, true);
    assertEquals(sentBody.attachments?.[0]?.filename, "invoice.pdf");
    assertEquals(sentBody.attachments?.[0]?.type, "application/pdf");
  } finally {
    (globalThis as any).fetch = originalFetch;
    if (originalUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", originalUrl);
    if (originalServiceKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", originalServiceKey);
  }
});
