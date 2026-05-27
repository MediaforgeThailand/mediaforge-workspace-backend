/**
 * production-contact - public contact form relay for studio.mediaforge.co.
 *
 * Uses the existing SendGrid secret stored in Supabase project secrets, so the
 * static production-house site does not need to carry the provider key.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";
const TO_EMAIL = "info@mediaforge.co";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clean(value: unknown, maxLength = 1200) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
}

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { message: "Method not allowed." });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { message: "Invalid request body." });
  }

  if (clean(body.website)) return json(200, { ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 180);
  const company = clean(body.company, 180);
  const project = clean(body.project, 180);
  const budget = clean(body.budget, 180);
  const message = clean(body.message, 2400);

  if (!name || !email || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { message: "Please complete the required fields." });
  }

  const sendgridApiKey = Deno.env.get("SENDGRID_API_KEY");
  if (!sendgridApiKey) return json(500, { message: "Email service is not configured." });

  const submittedAt = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  });
  const subject = `New production inquiry from ${name}`;
  const fromEmail = Deno.env.get("CONTACT_FROM_EMAIL") || Deno.env.get("SENDGRID_FROM_EMAIL") || "noreply@mediaforge.co";
  const fromName = Deno.env.get("CONTACT_FROM_NAME") || "MediaForge Studio";
  const toEmail = Deno.env.get("CONTACT_TO_EMAIL") || TO_EMAIL;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#161616;line-height:1.5">
      <h1 style="font-size:24px;margin:0 0 16px">New production inquiry</h1>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Company:</strong> ${company || "-"}</p>
      <p><strong>Project Type:</strong> ${project || "-"}</p>
      <p><strong>Budget / Timeline:</strong> ${budget || "-"}</p>
      <p><strong>Submitted:</strong> ${submittedAt} Bangkok time</p>
      <hr style="border:0;border-top:1px solid #ddd;margin:20px 0" />
      <p style="white-space:pre-line">${message}</p>
    </div>
  `;
  const text = [
    "New production inquiry",
    `Name: ${name}`,
    `Email: ${email}`,
    `Company: ${company || "-"}`,
    `Project Type: ${project || "-"}`,
    `Budget / Timeline: ${budget || "-"}`,
    `Submitted: ${submittedAt} Bangkok time`,
    "",
    message,
  ].join("\n");

  const sendGridResponse = await fetch(SENDGRID_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sendgridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }], subject }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email, name },
      subject,
      content: [
        { type: "text/plain", value: text },
        { type: "text/html", value: html },
      ],
      categories: ["production-house-contact"],
    }),
  });

  if (!sendGridResponse.ok) {
    const detail = await sendGridResponse.text().catch(() => "");
    console.error(`[production-contact] SendGrid ${sendGridResponse.status}: ${detail.slice(0, 400)}`);
    return json(502, { message: "Email could not be sent." });
  }

  return json(200, {
    ok: true,
    id: sendGridResponse.headers.get("x-message-id"),
  });
});
