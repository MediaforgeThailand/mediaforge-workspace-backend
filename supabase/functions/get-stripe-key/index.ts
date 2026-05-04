import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { getAuthUser, unauthorized } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  const publishableKey =
    Deno.env.get("STRIPE_PUBLISHABLE_KEY") ||
    Deno.env.get("STRIPE_PUBLIC_KEY") ||
    Deno.env.get("VITE_STRIPE_PUBLISHABLE_KEY") ||
    Deno.env.get("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
  if (!publishableKey) {
    return new Response(JSON.stringify({
      error: "card_payment_not_configured",
      message: "Card payment is not configured yet. PromptPay QR can still be created server-side.",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ publishableKey }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
