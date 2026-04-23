import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function hashCode(code: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "+66" + cleaned.substring(1);
  }
  if (cleaned.startsWith("66") && !cleaned.startsWith("+")) {
    cleaned = "+" + cleaned;
  }
  return cleaned;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { phone, code } = await req.json();

    if (!phone || !code) {
      return new Response(
        JSON.stringify({ error: "กรุณากรอกเบอร์โทรและรหัส OTP" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return new Response(
        JSON.stringify({ error: "รหัส OTP ต้องเป็นตัวเลข 6 หลัก" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const normalizedPhone = normalizePhone(phone);
    const codeHash = await hashCode(code);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Find the latest non-expired, non-verified OTP for this phone
    const { data: otpRecord, error: fetchError } = await supabase
      .from("phone_otps")
      .select("*")
      .eq("phone", normalizedPhone)
      .eq("verified", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      console.error("Fetch OTP error:", fetchError);
      return new Response(
        JSON.stringify({ error: "เกิดข้อผิดพลาดในระบบ" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!otpRecord) {
      return new Response(
        JSON.stringify({ error: "OTP หมดอายุหรือไม่พบ กรุณาขอรหัสใหม่" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check max attempts
    if (otpRecord.attempts >= otpRecord.max_attempts) {
      return new Response(
        JSON.stringify({ error: "ใส่รหัสผิดเกินจำนวนครั้งที่กำหนด กรุณาขอรหัสใหม่" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Increment attempts
    await supabase
      .from("phone_otps")
      .update({ attempts: otpRecord.attempts + 1 })
      .eq("id", otpRecord.id);

    // Verify code
    if (otpRecord.code_hash !== codeHash) {
      const remainingAttempts = otpRecord.max_attempts - (otpRecord.attempts + 1);
      return new Response(
        JSON.stringify({
          error: `รหัส OTP ไม่ถูกต้อง (เหลือ ${remainingAttempts} ครั้ง)`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mark OTP as verified
    await supabase
      .from("phone_otps")
      .update({ verified: true })
      .eq("id", otpRecord.id);

    // Find or create user by phone
    // Check if a user with this phone already exists
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(
      (u) => u.phone === normalizedPhone
    );

    let session;

    if (existingUser) {
      // Generate a magic link / session for existing user
      const { data: signInData, error: signInError } =
        await supabase.auth.admin.generateLink({
          type: "magiclink",
          email: existingUser.email || `${normalizedPhone.replace("+", "")}@phone.mediaforge.app`,
        });

      if (signInError) {
        console.error("Sign in error:", signInError);
        // Fallback: create a session using signInWithPassword won't work
        // Use admin update to set a temp session
      }

      // Use the token hash to verify the OTP on client side
      // Better approach: sign in directly
      const { data: tokenData, error: tokenError } =
        await supabase.auth.admin.generateLink({
          type: "magiclink",
          email: existingUser.email || `${normalizedPhone.replace("+", "")}@phone.mediaforge.app`,
        });

      if (tokenError) {
        console.error("Token generation error:", tokenError);
        return new Response(
          JSON.stringify({ error: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      session = {
        type: "existing",
        email: existingUser.email,
        token_hash: tokenData?.properties?.hashed_token,
        verification_url: tokenData?.properties?.action_link,
      };
    } else {
      // Create new user with phone number
      const fakeEmail = `${normalizedPhone.replace("+", "")}@phone.mediaforge.app`;
      const tempPassword = crypto.randomUUID();

      const { data: newUser, error: createError } =
        await supabase.auth.admin.createUser({
          email: fakeEmail,
          phone: normalizedPhone,
          password: tempPassword,
          email_confirm: true,
          phone_confirm: true,
          user_metadata: {
            full_name: normalizedPhone,
            auth_method: "phone_otp",
          },
        });

      if (createError) {
        console.error("Create user error:", createError);
        return new Response(
          JSON.stringify({ error: "ไม่สามารถสร้างบัญชีได้" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Generate session for the new user
      const { data: tokenData, error: tokenError } =
        await supabase.auth.admin.generateLink({
          type: "magiclink",
          email: fakeEmail,
        });

      if (tokenError) {
        console.error("Token generation error:", tokenError);
        return new Response(
          JSON.stringify({ error: "เกิดข้อผิดพลาดในการเข้าสู่ระบบ" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      session = {
        type: "new",
        email: fakeEmail,
        user_id: newUser.user?.id,
        token_hash: tokenData?.properties?.hashed_token,
        verification_url: tokenData?.properties?.action_link,
      };
    }

    return new Response(
      JSON.stringify({
        success: true,
        session,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("phone-otp-verify error:", error);
    return new Response(
      JSON.stringify({ error: "เกิดข้อผิดพลาด กรุณาลองใหม่" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
