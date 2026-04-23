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
    JSON.stringify(success ? { success: true, ...((data && typeof data === "object") ? data : { data }) } : { success: false, error: data }),
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

    const { token, credits: requestedCredits } = await req.json();
    const user_id = authUser.id;
    const user_email = authUser.email;

    if (!token || !user_id) {
      return respond(false, "Missing token or user_id");
    }

    if (typeof token !== "string" || token.length < 4 || token.length > 100) {
      return respond(false, "Invalid token format");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[REDEEM-DEMO] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return respond(false, "Server configuration error");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // ── Step 1: Validate token against demo_links table ──
    const { data: demoLink, error: linkErr } = await supabase
      .from("demo_links")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (linkErr) {
      console.error("[REDEEM-DEMO] DB lookup error:", linkErr);
      return respond(false, "ไม่สามารถตรวจสอบ Token ได้");
    }

    if (!demoLink) {
      return respond(false, "ลิงก์ Demo ไม่ถูกต้อง");
    }

    if (!demoLink.is_active) {
      return respond(false, "ลิงก์ Demo นี้ถูกปิดใช้งานแล้ว");
    }

    if (new Date(demoLink.expires_at) < new Date()) {
      return respond(false, "ลิงก์ Demo นี้หมดอายุแล้ว");
    }

    if (demoLink.redeemed_by) {
      return new Response(
        JSON.stringify({ success: false, error: "ลิงก์ Demo นี้ถูกใช้ไปแล้ว", already_redeemed: true }),
        { status: 200, headers: jsonHeaders },
      );
    }

    // ── Step 2: Check idempotency via credit_transactions ──
    const { data: existingTx } = await supabase
      .from("credit_transactions")
      .select("id, created_at")
      .eq("user_id", user_id)
      .eq("reference_id", `demo:${token}`)
      .maybeSingle();

    if (existingTx) {
      const needsRepair = demoLink.is_active || !demoLink.redeemed_by || !demoLink.redeemed_at;

      if (needsRepair) {
        try {
          const repairedRedeemedAt = demoLink.redeemed_at ?? existingTx.created_at ?? new Date().toISOString();
          const { error: repairErr } = await supabase
            .from("demo_links")
            .update({
              redeemed_by: demoLink.redeemed_by ?? user_id,
              redeemed_at: repairedRedeemedAt,
              is_active: false,
            })
            .eq("id", demoLink.id);

          if (repairErr) {
            console.error("[REDEEM-DEMO] Failed to repair stale redeemed link:", repairErr);
            return respond(false, "ไม่สามารถอัปเดตสถานะ Demo link ได้");
          }
        } catch (repairCatch) {
          console.error("[REDEEM-DEMO] Repair exception:", repairCatch);
          return respond(false, "ไม่สามารถอัปเดตสถานะ Demo link ได้");
        }
      }

      return new Response(
        JSON.stringify({ success: true, credits: demoLink.credits_budget || 500, already_redeemed: true, repaired_link: needsRepair }),
        { status: 200, headers: jsonHeaders },
      );
    }

    // ── Step 3: Check monthly budget ──
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const { data: budget } = await supabase
      .from("demo_budget")
      .select("*")
      .eq("month", currentMonth)
      .maybeSingle();

    const creditsToGrant = demoLink.credits_budget || 500;
    const totalGranted = budget?.total_credits_granted || 0;
    const maxMonthly = budget?.max_monthly_credits || 100000;

    if (totalGranted + creditsToGrant > maxMonthly) {
      return respond(false, "เครดิต Demo ประจำเดือนหมดแล้ว กรุณาลองใหม่เดือนหน้า");
    }

    // ── Step 4: Mark demo link as redeemed (with row-count verification) ──
    const { data: updatedRows, error: markErr } = await supabase
      .from("demo_links")
      .update({
        redeemed_by: user_id,
        redeemed_at: new Date().toISOString(),
        is_active: false,
      })
      .eq("id", demoLink.id)
      .is("redeemed_by", null) // Optimistic lock
      .select("id");

    if (markErr) {
      console.error("[REDEEM-DEMO] Failed to mark redeemed:", markErr);
      return respond(false, "ไม่สามารถอัปเดตสถานะ Demo link ได้");
    }

    if (!updatedRows || updatedRows.length === 0) {
      console.warn("[REDEEM-DEMO] Race condition: link already redeemed by another request");
      return new Response(
        JSON.stringify({ success: false, error: "ลิงก์ Demo นี้ถูกใช้ไปแล้ว", already_redeemed: true }),
        { status: 200, headers: jsonHeaders },
      );
    }

    // ── Step 5: Grant credits ──
    const { error: grantError } = await supabase.rpc("grant_credits", {
      p_user_id: user_id,
      p_amount: creditsToGrant,
      p_source_type: "bonus",
      p_expiry_days: 90,
      p_description: `Demo Link Credits`,
      p_reference_id: `demo:${token}`,
    });

    if (grantError) {
      console.error("[REDEEM-DEMO] grant_credits error:", grantError);
      // Rollback demo link
      try {
        await supabase
          .from("demo_links")
          .update({ redeemed_by: null, redeemed_at: null, is_active: true })
          .eq("id", demoLink.id);
      } catch (rollbackErr) {
        console.error("[REDEEM-DEMO] Rollback also failed:", rollbackErr);
      }

      return respond(false, "ไม่สามารถเพิ่มเครดิตได้ กรุณาลองใหม่");
    }

    // ── Step 6: Update monthly budget ──
    if (budget) {
      await supabase
        .from("demo_budget")
        .update({
          total_credits_granted: totalGranted + creditsToGrant,
          updated_at: new Date().toISOString(),
        })
        .eq("id", budget.id);
    } else {
      await supabase
        .from("demo_budget")
        .insert({
          month: currentMonth,
          total_credits_granted: creditsToGrant,
        });
    }

    console.log(`[REDEEM-DEMO] Granted ${creditsToGrant} credits to ${user_id} (${user_email || "no-email"}) token=${token}`);

    return new Response(
      JSON.stringify({ success: true, credits: creditsToGrant }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    console.error("[REDEEM-DEMO] Error:", err);
    return respond(false, err instanceof Error ? err.message : "Internal server error");
  }
});
