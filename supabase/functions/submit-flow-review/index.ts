import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rejectIfOrgUser } from "../_shared/orgUserGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const orgBlock = await rejectIfOrgUser(req);
  if (orgBlock) return orgBlock;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const { flow_run_id, rating, comment } = await req.json();
    if (!flow_run_id || !rating) return json({ error: "flow_run_id and rating required" }, 400);
    if (rating < 1 || rating > 5) return json({ error: "Rating must be 1-5" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Get flow run
    const { data: run, error: runErr } = await admin
      .from("flow_runs")
      .select("id, flow_id, user_id, status, credits_used")
      .eq("id", flow_run_id)
      .single();

    if (runErr || !run) return json({ error: "Flow run not found" }, 404);
    if (run.user_id !== userId) return json({ error: "Not your flow run" }, 403);
    if (run.status !== "completed") return json({ error: "Can only review completed runs" }, 400);

    // Check existing review
    const { data: existing } = await admin
      .from("flow_user_reviews")
      .select("id")
      .eq("flow_run_id", flow_run_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (existing) return json({ error: "Already reviewed" }, 409);

    // Get user's subscription plan for cashback
    const { data: profile } = await admin
      .from("profiles")
      .select("subscription_plan_id")
      .eq("user_id", userId)
      .single();

    let cashbackPercent = 0;
    if (profile?.subscription_plan_id) {
      const { data: plan } = await admin
        .from("subscription_plans")
        .select("cashback_percent")
        .eq("id", profile.subscription_plan_id)
        .single();
      cashbackPercent = plan?.cashback_percent ?? 0;
    }

    const cashbackCredits = cashbackPercent > 0
      ? Math.ceil(run.credits_used * cashbackPercent / 100)
      : 0;

    // Insert review
    const { data: review, error: reviewErr } = await admin
      .from("flow_user_reviews")
      .insert({
        flow_id: run.flow_id,
        flow_run_id,
        user_id: userId,
        rating,
        comment: comment || null,
        cashback_credits: cashbackCredits,
        cashback_granted: cashbackCredits > 0,
      })
      .select()
      .single();

    if (reviewErr) return json({ error: reviewErr.message }, 500);

    // Grant cashback credits via atomic RPC
    if (cashbackCredits > 0) {
      const { error: grantErr } = await admin.rpc("grant_credits", {
        p_user_id: userId,
        p_amount: cashbackCredits,
        p_source_type: "cashback",
        p_expiry_days: 90,
        p_description: `Cashback ${cashbackPercent}% from Flow review`,
        p_reference_id: `review-${review.id}`,
      });

      if (grantErr) {
        console.error("[submit-flow-review] grant_credits error:", grantErr);
      } else {
        console.log(`[submit-flow-review] Granted ${cashbackCredits} cashback credits to ${userId}`);
      }
    }

    // Update flow_metrics avg_rating
    const { data: allReviews } = await admin
      .from("flow_user_reviews")
      .select("rating")
      .eq("flow_id", run.flow_id);

    if (allReviews && allReviews.length > 0) {
      const avg = allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length;
      await admin
        .from("flow_metrics")
        .upsert({ flow_id: run.flow_id, avg_rating: Math.round(avg * 10) / 10 }, { onConflict: "flow_id" });
    }

    return json({ success: true, review, cashback_credits: cashbackCredits });
  } catch (err) {
    console.error(err);
    return json({ error: "Server error" }, 500);
  }
});
