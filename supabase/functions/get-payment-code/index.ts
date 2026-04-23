import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function jsonResp(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

/**
 * Public endpoint — no auth required.
 * Looks up a redemption code by Stripe session ID.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { session_id } = await req.json();

    if (!session_id) {
      return jsonResp(400, { error: "Missing session_id" });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase
      .from("redemption_codes")
      .select("*")
      .eq("stripe_session_id", session_id)
      .maybeSingle();

    if (error) {
      console.error("[get-payment-code] DB error:", error.message);
      return jsonResp(500, { error: "Database error" });
    }

    if (!data) {
      return jsonResp(404, { error: "Code not found yet" });
    }

    return jsonResp(200, { data });
  } catch (err: any) {
    console.error("[get-payment-code] Error:", err);
    return jsonResp(500, { error: err.message || "Internal server error" });
  }
});
