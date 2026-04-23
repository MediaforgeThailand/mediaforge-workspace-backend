import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function generateOTP(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}

async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "");
  // Thai number without country code
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "+66" + cleaned.substring(1);
  }
  // Already has +66
  if (cleaned.startsWith("66") && !cleaned.startsWith("+")) {
    cleaned = "+" + cleaned;
  }
  return cleaned;
}

/**
 * Convert E.164 (+66XXXXXXXXX) to ThaiBulkSMS format (66XXXXXXXXX, no +)
 */
function toThaiBulkSmsMsisdn(e164: string): string {
  return e164.startsWith("+") ? e164.substring(1) : e164;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { phone } = await req.json();

    if (!phone || typeof phone !== "string" || phone.length < 9) {
      return new Response(
        JSON.stringify({ error: "กรุณากรอกเบอร์โทรที่ถูกต้อง" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const normalizedPhone = normalizePhone(phone);

    // Validate E.164 format
    if (!/^\+\d{10,15}$/.test(normalizedPhone)) {
      return new Response(
        JSON.stringify({ error: "รูปแบบเบอร์โทรไม่ถูกต้อง" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Rate limit: max 3 OTPs per phone in 10 minutes
    const { count } = await supabase
      .from("phone_otps")
      .select("*", { count: "exact", head: true })
      .eq("phone", normalizedPhone)
      .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

    if ((count ?? 0) >= 3) {
      return new Response(
        JSON.stringify({ error: "ส่ง OTP บ่อยเกินไป กรุณารอ 10 นาที" }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate OTP
    const otpCode = generateOTP();
    const codeHash = await hashCode(otpCode);

    // Store OTP (expires in 5 minutes)
    const { error: insertError } = await supabase.from("phone_otps").insert({
      phone: normalizedPhone,
      code_hash: codeHash,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });

    if (insertError) {
      console.error("Insert OTP error:", insertError);
      return new Response(
        JSON.stringify({ error: "เกิดข้อผิดพลาดในระบบ" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Send SMS via ThaiBulkSMS API v2
    // Docs: https://api.thaibulksms.com/api/v2/sms
    const apiKey = Deno.env.get("THAIBULKSMS_API_KEY");
    const apiSecret = Deno.env.get("THAIBULKSMS_API_SECRET");
    const sender = Deno.env.get("THAIBULKSMS_SENDER") ?? "MediaForge";

    if (!apiKey || !apiSecret) {
      console.error("ThaiBulkSMS credentials not configured");
      return new Response(
        JSON.stringify({ error: "SMS service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const msisdn = toThaiBulkSmsMsisdn(normalizedPhone);
    const message = `[MediaForge] รหัส OTP ของคุณคือ: ${otpCode} (หมดอายุใน 5 นาที)`;

    const tbsResponse = await fetch("https://api.thaibulksms.com/api/v2/sms", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${apiKey}:${apiSecret}`),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        msisdn,                  // 66XXXXXXXXX (no plus)
        message,
        sender,                  // approved sender name (e.g. MediaForge)
        force: "standard",       // standard route (cheaper); use "premium" for higher reliability
      }),
    });

    const tbsBodyText = await tbsResponse.text();
    let tbsBody: any = null;
    try {
      tbsBody = JSON.parse(tbsBodyText);
    } catch {
      tbsBody = { raw: tbsBodyText };
    }

    if (!tbsResponse.ok) {
      console.error("ThaiBulkSMS error:", tbsResponse.status, tbsBody);
      return new Response(
        JSON.stringify({
          error: "ส่ง SMS ไม่สำเร็จ กรุณาลองใหม่",
          fallback: true,
          provider_status: tbsResponse.status,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ThaiBulkSMS returns { remaining_credit, total_cost, queued_messages: [...] }
    // If queued_messages is empty or missing, treat as failure.
    const queued = Array.isArray(tbsBody?.queued_messages) ? tbsBody.queued_messages : [];
    if (queued.length === 0) {
      console.error("ThaiBulkSMS no queued messages:", tbsBody);
      return new Response(
        JSON.stringify({
          error: "ส่ง SMS ไม่สำเร็จ (provider rejected)",
          fallback: true,
          provider_response: tbsBody,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        phone: normalizedPhone,
        expires_in: 300,
        provider: "thaibulksms",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("phone-otp-send error:", error);
    return new Response(
      JSON.stringify({ error: "เกิดข้อผิดพลาด กรุณาลองใหม่" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
