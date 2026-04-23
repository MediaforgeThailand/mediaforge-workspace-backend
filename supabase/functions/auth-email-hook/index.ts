/**
 * auth-email-hook — Supabase Auth Send Email Hook → SendGrid
 *
 * Receives auth email events from Supabase Auth (signup, password reset,
 * magic link, email change, etc.) and dispatches them to SendGrid Dynamic
 * Templates. Replaces Lovable Email entirely.
 *
 * Configure in Supabase Dashboard → Authentication → Hooks → Send Email Hook.
 * Webhook secret stored in env var SEND_EMAIL_HOOK_SECRET (Supabase generates it).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY");
const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET") ?? "";
const FROM_EMAIL = Deno.env.get("SENDGRID_FROM_EMAIL") ?? "noreply@mediaforge.co";
const FROM_NAME = "MediaForge";

// Map Supabase action_type → SendGrid template logical name → template id
const TEMPLATE_IDS: Record<string, string> = {
  signup: "d-2eaf8ea610974c1f9ff7b6c5c2a8436c",
  magiclink: "d-12b14f6ce530444d886945a4f5fee8c7",
  recovery: "d-9ea2b61d71334f5f856415291f795d50",
  email_change: "d-414fcd553f9b4e599e15e37986959e3c",
  email_change_current: "d-414fcd553f9b4e599e15e37986959e3c",
  email_change_new: "d-414fcd553f9b4e599e15e37986959e3c",
  invite: "d-2eaf8ea610974c1f9ff7b6c5c2a8436c",
  reauthentication: "d-fc0b25b9f2854577ab1041b5a5a36044",
};

const SUBJECTS: Record<string, string> = {
  signup: "ยืนยันอีเมลของคุณ • MediaForge",
  magiclink: "ลิงก์เข้าสู่ระบบ MediaForge",
  recovery: "รีเซ็ตรหัสผ่าน MediaForge",
  email_change: "ยืนยันการเปลี่ยนอีเมล • MediaForge",
  email_change_current: "ยืนยันการเปลี่ยนอีเมล • MediaForge",
  email_change_new: "ยืนยันอีเมลใหม่ • MediaForge",
  invite: "คุณได้รับเชิญใช้งาน MediaForge",
  reauthentication: "รหัสยืนยันตัวตน MediaForge",
};

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!SENDGRID_API_KEY) {
    console.error("[auth-email-hook] SENDGRID_API_KEY missing");
    return new Response(JSON.stringify({ error: "sendgrid_not_configured" }), { status: 500 });
  }

  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers);

  // Verify Standard Webhook signature when secret is configured
  let payload: any;
  if (HOOK_SECRET) {
    try {
      const cleanSecret = HOOK_SECRET.replace(/^v1,whsec_/, "").replace(/^whsec_/, "");
      const wh = new Webhook(cleanSecret);
      payload = wh.verify(rawBody, headers) as any;
    } catch (e) {
      console.error("[auth-email-hook] Signature verification failed:", e);
      return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
    }
  } else {
    console.warn("[auth-email-hook] SEND_EMAIL_HOOK_SECRET not set — skipping verification");
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
    }
  }

  const user = payload?.user ?? {};
  const emailData = payload?.email_data ?? {};
  const recipientEmail = emailData.new_email ?? user.email;
  const actionType: string = emailData.email_action_type ?? "signup";

  if (!recipientEmail) {
    console.error("[auth-email-hook] No recipient email in payload");
    return new Response(JSON.stringify({ error: "no_recipient" }), { status: 400 });
  }

  const templateId = TEMPLATE_IDS[actionType] ?? TEMPLATE_IDS.signup;
  const subject = SUBJECTS[actionType] ?? "MediaForge";

  // Build the action URL Supabase expects users to click
  const siteUrl = (emailData.site_url ?? "https://mediaforge.co").replace(/\/$/, "");
  const verifyUrl =
    `${siteUrl}/auth/v1/verify?token=${emailData.token_hash}` +
    `&type=${actionType}&redirect_to=${encodeURIComponent(emailData.redirect_to ?? siteUrl)}`;

  const dynamicData: Record<string, unknown> = {
    confirmation_url: verifyUrl,
    action_url: verifyUrl,
    token: emailData.token,
    token_hash: emailData.token_hash,
    site_url: siteUrl,
    redirect_to: emailData.redirect_to ?? siteUrl,
    email: recipientEmail,
    new_email: emailData.new_email ?? null,
    user_email: user.email ?? null,
    display_name:
      user?.user_metadata?.full_name ??
      user?.user_metadata?.name ??
      (user?.email ? user.email.split("@")[0] : ""),
    current_year: new Date().getFullYear(),
  };

  const sgPayload = {
    personalizations: [
      {
        to: [{ email: recipientEmail }],
        dynamic_template_data: dynamicData,
        subject,
      },
    ],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    template_id: templateId,
    mail_settings: { sandbox_mode: { enable: false } },
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: true },
    },
  };

  const sgRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sgPayload),
  });

  if (!sgRes.ok) {
    const errText = await sgRes.text();
    console.error(`[auth-email-hook] SendGrid ${sgRes.status} action=${actionType} to=${recipientEmail}: ${errText.slice(0, 400)}`);
    // Return 200 anyway so Supabase doesn't block signup; user can retry
    return new Response(
      JSON.stringify({ ok: false, sendgrid_status: sgRes.status, detail: errText.slice(0, 400) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const messageId = sgRes.headers.get("x-message-id");
  console.log(`[auth-email-hook] sent action=${actionType} to=${recipientEmail} msg=${messageId}`);

  return new Response(
    JSON.stringify({ ok: true, message_id: messageId }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
