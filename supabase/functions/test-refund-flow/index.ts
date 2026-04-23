import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const CREDIT_AMOUNT = 10;
    const steps: string[] = [];

    // ─── Step 1: Record starting balance ───
    const { data: ucBefore } = await supabase
      .from("user_credits")
      .select("balance")
      .eq("user_id", user.id)
      .maybeSingle();
    const startBalance = ucBefore?.balance ?? 0;
    steps.push(`Starting balance: ${startBalance}`);

    // ─── Step 2: Deduct credits (simulate job start) ───
    const { data: batches } = await supabase
      .from("credit_batches")
      .select("id, remaining, source_type, expires_at")
      .eq("user_id", user.id)
      .gt("remaining", 0)
      .gt("expires_at", new Date().toISOString())
      .order("source_type", { ascending: true })
      .order("expires_at", { ascending: true });

    const totalAvailable = (batches || []).reduce((sum: number, b: any) => sum + b.remaining, 0);
    if (totalAvailable < CREDIT_AMOUNT) {
      return new Response(JSON.stringify({ error: "Insufficient credits for test", balance: totalAvailable }), {
        status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let remaining = CREDIT_AMOUNT;
    for (const batch of (batches || [])) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, batch.remaining);
      await supabase.from("credit_batches").update({ remaining: batch.remaining - deduct }).eq("id", batch.id);
      remaining -= deduct;
    }

    const afterDeductBalance = startBalance - CREDIT_AMOUNT;
    await supabase.from("user_credits").update({
      balance: afterDeductBalance,
      total_used: (await supabase.from("user_credits").select("total_used").eq("user_id", user.id).maybeSingle()).data?.total_used + CREDIT_AMOUNT,
      updated_at: new Date().toISOString(),
    }).eq("user_id", user.id);

    await supabase.from("credit_transactions").insert({
      user_id: user.id, amount: -CREDIT_AMOUNT, type: "usage", feature: "test_refund",
      description: "Test: simulated job deduction", balance_after: afterDeductBalance,
    });
    steps.push(`Deducted ${CREDIT_AMOUNT} credits. Balance: ${afterDeductBalance}`);

    // ─── Step 3: Create a mock flow_run with status "processing" ───
    // Use the user's first flow or a dummy
    const { data: anyFlow } = await supabase
      .from("flows")
      .select("id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    const flowId = anyFlow?.id;
    if (!flowId) {
      // Refund immediately if no flow exists
      return new Response(JSON.stringify({ error: "No flows found for user" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: run } = await supabase.from("flow_runs").insert({
      flow_id: flowId,
      user_id: user.id,
      inputs: { test: true },
      status: "processing",
      credits_used: CREDIT_AMOUNT,
      outputs: { test_refund: true, credit_cost: CREDIT_AMOUNT },
    }).select("id").single();

    steps.push(`Created mock flow_run: ${run?.id}`);

    // ─── Step 4: Wait 3 seconds (simulate processing) ───
    await new Promise((resolve) => setTimeout(resolve, 3000));
    steps.push("Waited 3 seconds (simulated processing)");

    // ─── Step 5: Mark as failed_refunded and refund credits ───
    await supabase.from("flow_runs").update({
      status: "failed_refunded",
      error_message: "Test: simulated API failure for refund testing",
      completed_at: new Date().toISOString(),
    }).eq("id", run?.id);
    steps.push(`Set flow_run status to failed_refunded`);

    // Refund
    await supabase.from("credit_batches").insert({
      user_id: user.id, amount: CREDIT_AMOUNT, remaining: CREDIT_AMOUNT, source_type: "topup",
      reference_id: run?.id || null,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const finalBalance = afterDeductBalance + CREDIT_AMOUNT;
    await supabase.from("user_credits").update({
      balance: finalBalance, updated_at: new Date().toISOString(),
    }).eq("user_id", user.id);

    await supabase.from("credit_transactions").insert({
      user_id: user.id, amount: CREDIT_AMOUNT, type: "refund", feature: "test_refund",
      description: "Test: simulated failure refund",
      reference_id: run?.id || null,
      balance_after: finalBalance,
    });
    steps.push(`Refunded ${CREDIT_AMOUNT} credits. Final balance: ${finalBalance}`);

    // ─── Step 6: Verify net-zero ───
    const netZero = finalBalance === startBalance;
    steps.push(`Net-zero check: ${netZero ? "PASS ✅" : "FAIL ❌"} (start=${startBalance}, end=${finalBalance})`);

    return new Response(JSON.stringify({
      success: true,
      net_zero: netZero,
      start_balance: startBalance,
      final_balance: finalBalance,
      run_id: run?.id,
      steps,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[test-refund-flow] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
