import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getAuthUser } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function respond(success: boolean, data: unknown) {
  return new Response(
    JSON.stringify(success ? { success: true, data } : { success: false, error: data }),
    { status: 200, headers: jsonHeaders },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authUser = await getAuthUser(req);
    if (!authUser) return respond(false, "Unauthorized");

    const { code: rawCode } = await req.json();
    const user_id = authUser.id;
    const user_email = authUser.email;

    if (!rawCode || !user_id) {
      return respond(false, "Missing code or user_id");
    }

    // Normalize: trim, uppercase, fix Unicode dashes
    const code = String(rawCode).trim().toUpperCase().replace(/[‐‑‒–—―]/g, "-");

    // Validate code format: MF-XXXX-XXXX-XXXX
    const codePattern = /^MF-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    if (!codePattern.test(code)) {
      return respond(false, "รูปแบบ Code ไม่ถูกต้อง");
    }

    console.log(`[REDEEM-CODE] Validating code=${code} for user=${user_id} (${user_email})`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[REDEEM-CODE] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return respond(false, "Server configuration error");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // ── Step 1: Look up the code in redemption_codes table ──
    const { data: codeRow, error: lookupErr } = await supabase
      .from("redemption_codes")
      .select("*")
      .eq("code", code)
      .maybeSingle();

    if (lookupErr) {
      console.error("[REDEEM-CODE] DB lookup error:", lookupErr);
      return respond(false, "ไม่สามารถตรวจสอบ Code ได้");
    }

    if (!codeRow) {
      return respond(false, "ไม่พบ Code นี้ในระบบ");
    }

    // ── Step 2: Validate code status ──
    if (codeRow.status === "redeemed") {
      return respond(false, "Code นี้ถูกใช้ไปแล้ว");
    }

    if (codeRow.status === "expired" || (codeRow.expires_at && new Date(codeRow.expires_at) < new Date())) {
      return respond(false, "Code นี้หมดอายุแล้ว");
    }

    // ── Step 3: Mark code as redeemed (atomically via status check) ──
    const { data: updated, error: updateErr } = await supabase
      .from("redemption_codes")
      .update({
        status: "redeemed",
        redeemed_by: user_id,
        redeemed_at: new Date().toISOString(),
        customer_email: user_email || null,
      })
      .eq("id", codeRow.id)
      .not("status", "eq", "redeemed") // Optimistic lock — only update if NOT already redeemed
      .select()
      .maybeSingle();

    if (updateErr || !updated) {
      console.error("[REDEEM-CODE] Failed to mark as redeemed:", updateErr);
      return respond(false, "Code นี้ถูกใช้ไปแล้วหรือเกิดข้อผิดพลาด");
    }

    // ── Step 4: Grant credits via RPC ──
    const creditsToGrant = codeRow.credits || 1000;

    const { error: grantError } = await supabase.rpc("grant_credits", {
      p_user_id: user_id,
      p_amount: creditsToGrant,
      p_source_type: "redemption",
      p_expiry_days: 90,
      p_description: `Redemption Code: ${code} (${codeRow.plan_name})`,
      p_reference_id: `code:${code}`,
    });

    if (grantError) {
      console.error("[REDEEM-CODE] grant_credits error:", grantError);
      // Rollback: revert code status (best-effort)
      try {
        await supabase
          .from("redemption_codes")
          .update({ status: "pending", redeemed_by: null, redeemed_at: null })
          .eq("id", codeRow.id);
      } catch (rollbackErr) {
        console.error("[REDEEM-CODE] Rollback also failed:", rollbackErr);
      }

      return respond(false, "ไม่สามารถเพิ่มเครดิตได้ กรุณาลองใหม่");
    }

    // ── Step 5: Update user profile subscription ──
    let periodMonths = 1;
    const cycle = codeRow.billing_cycle || "";
    if (cycle.includes("12") || cycle.includes("annual")) periodMonths = 12;
    else if (cycle.includes("6")) periodMonths = 6;
    else if (cycle.includes("3")) periodMonths = 3;

    let subStatus = "professional";
    const planLower = (codeRow.plan_name || "").toLowerCase();
    if (planLower.includes("enterprise") || planLower.includes("studio") || planLower.includes("agency")) {
      subStatus = "agency";
    }

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + periodMonths);

    const profileUpdate: Record<string, unknown> = {
      subscription_status: subStatus,
      current_period_end: periodEnd.toISOString(),
      billing_interval: periodMonths >= 12 ? "annual" : "monthly",
    };

    if (codeRow.plan_id) {
      const { data: localPlan } = await supabase
        .from("subscription_plans")
        .select("id")
        .eq("id", codeRow.plan_id)
        .maybeSingle();

      if (localPlan) {
        profileUpdate.subscription_plan_id = codeRow.plan_id;
        profileUpdate.current_plan_id = codeRow.plan_id;
      }
    }

    const { error: profileError } = await supabase
      .from("profiles")
      .update(profileUpdate)
      .eq("user_id", user_id);

    if (profileError) {
      console.error("[REDEEM-CODE] profile update error:", profileError);
      // Don't fail — credits already granted
    }

    const erpData = {
      plan_name: codeRow.plan_name,
      billing_cycle: codeRow.billing_cycle,
      credits: creditsToGrant,
      plan_id: codeRow.plan_id,
      customer_email: user_email,
    };

    console.log(`[REDEEM-CODE] SUCCESS: +${creditsToGrant} credits, plan=${codeRow.plan_name}, sub=${subStatus} for user=${user_id}`);

    return respond(true, erpData);
  } catch (err) {
    console.error("[REDEEM-CODE] Error:", err);
    return respond(false, err instanceof Error ? err.message : "Internal server error");
  }
});
