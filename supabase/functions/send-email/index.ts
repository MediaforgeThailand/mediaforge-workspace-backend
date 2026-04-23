/**
 * send-email — Generic SendGrid Dynamic Template sender.
 *
 * Body: {
 *   template: string,            // logical name e.g. "payment_receipt"
 *   to: string | string[],       // recipient email(s)
 *   data: Record<string, unknown>, // dynamic_template_data
 *   subject?: string,            // optional override
 *   from?: { email: string; name?: string },
 *   reply_to?: string,
 * }
 *
 * SECURITY: Auth required. Service-role callers (edge → edge) pass through.
 * Public users can only send to their own email.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// SendGrid Dynamic Template IDs (logical_name → d-xxxxx)
const TEMPLATE_IDS: Record<string, string> = {
  // Auth (handled via Supabase SMTP normally — kept here for manual sends)
  signup_confirmation: "d-2eaf8ea610974c1f9ff7b6c5c2a8436c",
  magic_link: "d-12b14f6ce530444d886945a4f5fee8c7",
  password_reset: "d-9ea2b61d71334f5f856415291f795d50",
  otp_verification: "d-fc0b25b9f2854577ab1041b5a5a36044",
  email_change: "d-414fcd553f9b4e599e15e37986959e3c",

  // Transactional
  payment_receipt: "d-62b4b57d0dd54e2a9a09488e689aad79",
  affiliate_commission: "d-524684a60a0b4a0ba90b3fd5f1ac24c9",
  payout_approved: "d-cdaad5c66ba74a208a91c26e68d8c398",

  // TODO: add when user provides IDs
  // welcome: "d-...",
  // team_invite: "d-...",
  // flow_complete: "d-...",
  // flow_failed: "d-...",
  // low_credit: "d-...",
  // renewal_reminder: "d-...",
  // creator_flow_approved: "d-...",
  // creator_flow_changes: "d-...",
};

const DEFAULT_FROM = {
  email: "noreply@mediaforge.co",
  name: "MediaForge",
};

interface SendEmailBody {
  template: string;
  to: string | string[];
  data?: Record<string, unknown>;
  subject?: string;
  from?: { email: string; name?: string };
  reply_to?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!SENDGRID_API_KEY) {
      return new Response(JSON.stringify({ error: "SENDGRID_API_KEY not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");

    // Detect service-role vs user JWT.
    const isServiceRole = token === SUPABASE_SERVICE_ROLE_KEY;
    let callerEmail: string | null = null;

    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      callerEmail = user.email ?? null;
    }

    const body = (await req.json()) as SendEmailBody;
    const { template, to, data = {}, subject, from, reply_to } = body;

    if (!template || !to) {
      return new Response(JSON.stringify({ error: "template and to are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const templateId = TEMPLATE_IDS[template];
    if (!templateId) {
      return new Response(
        JSON.stringify({ error: `Unknown template: ${template}`, available: Object.keys(TEMPLATE_IDS) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Normalize recipients
    const recipients = Array.isArray(to) ? to : [to];

    // SECURITY: Non-service callers can only send to themselves
    if (!isServiceRole) {
      const invalid = recipients.find((r) => r.toLowerCase() !== (callerEmail ?? "").toLowerCase());
      if (invalid) {
        console.warn(`[send-email] Blocked: ${callerEmail} tried to send to ${invalid}`);
        return new Response(JSON.stringify({ error: "Cannot send email to other users" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Build SendGrid v3 Mail Send request
    const sgPayload: Record<string, unknown> = {
      personalizations: recipients.map((email) => ({
        to: [{ email }],
        dynamic_template_data: data,
        ...(subject ? { subject } : {}),
      })),
      from: from ?? DEFAULT_FROM,
      template_id: templateId,
      ...(reply_to ? { reply_to: { email: reply_to } } : {}),
      mail_settings: {
        sandbox_mode: { enable: false },
      },
      tracking_settings: {
        click_tracking: { enable: true, enable_text: false },
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
      console.error(`[send-email] SendGrid ${sgRes.status}: ${errText}`);
      return new Response(
        JSON.stringify({ error: "SendGrid API error", status: sgRes.status, detail: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const messageId = sgRes.headers.get("x-message-id") ?? null;
    console.log(`[send-email] Sent template=${template} to=${recipients.join(",")} message_id=${messageId}`);

    return new Response(
      JSON.stringify({ success: true, message_id: messageId, template, recipients }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[send-email] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
