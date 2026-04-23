/// <reference lib="deno.ns" />
import { getAuthUser, isServiceRole, unauthorized } from "../_shared/auth.ts";
/**
 * remove-background — Removes background from an image using Replicate's BiRefNet model.
 * Returns a transparent PNG uploaded to the ai-media bucket.
 *
 * Model: lucataco/remove-bg (BiRefNet) — fast, free-tier friendly, ~$0.003/run.
 * Input: image_url (https URL or data URI)
 * Output: signed URL of transparent PNG in ai-media bucket
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const REPLICATE_MODEL_VERSION =
  // lucataco/remove-bg — pinned community version that proxies BiRefNet, accepts a public image URL
  "95fcc2a26d3899cd6c2691c900465aaeff466285a65c14638cc5f36f34befaf1";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
}

async function pollPrediction(
  predictionId: string,
  apiToken: string,
  maxWaitMs = 90_000,
): Promise<ReplicatePrediction> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Replicate poll failed (${res.status}): ${txt.substring(0, 200)}`);
    }
    const pred = (await res.json()) as ReplicatePrediction;
    if (pred.status === "succeeded" || pred.status === "failed" || pred.status === "canceled") {
      return pred;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Replicate prediction timed out after 90s");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Auth: require authenticated user or service_role
  if (!isServiceRole(req)) {
    const user = await getAuthUser(req);
    if (!user) return unauthorized();
  }

  try {
    const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN");
    if (!REPLICATE_API_TOKEN) {
      throw new Error("REPLICATE_API_TOKEN is not configured");
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = await req.json().catch(() => ({}));
    const imageUrl = String(body.image_url ?? "").trim();

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: "image_url is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!/^(https?:\/\/|data:image\/)/i.test(imageUrl)) {
      return new Response(
        JSON.stringify({ error: "image_url must be a http(s) URL or data:image/* URI" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`[remove-background] Starting Replicate prediction for image (len=${imageUrl.length})`);

    // 1) Create prediction
    const createRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: REPLICATE_MODEL_VERSION,
        input: { image: imageUrl },
      }),
    });

    if (!createRes.ok) {
      const errTxt = await createRes.text();
      console.error(`[remove-background] Replicate create error ${createRes.status}:`, errTxt.substring(0, 500));
      if (createRes.status === 402 || /billing|payment|insufficient/i.test(errTxt)) {
        throw new Error("PROVIDER_BILLING_ERROR");
      }
      throw new Error(`Replicate create failed (${createRes.status}): ${errTxt.substring(0, 200)}`);
    }

    const created = (await createRes.json()) as ReplicatePrediction;
    console.log(`[remove-background] Prediction created: ${created.id}, status=${created.status}`);

    // 2) Poll until done
    const final = await pollPrediction(created.id, REPLICATE_API_TOKEN);

    if (final.status !== "succeeded" || !final.output) {
      const errMsg = final.error || `Replicate status: ${final.status}`;
      console.error(`[remove-background] Prediction failed:`, errMsg);
      throw new Error(`Background removal failed: ${errMsg}`);
    }

    const outputUrl = Array.isArray(final.output) ? final.output[0] : final.output;
    if (!outputUrl || typeof outputUrl !== "string") {
      throw new Error("Replicate returned no output URL");
    }

    console.log(`[remove-background] Downloading result PNG from Replicate...`);

    // 3) Download the transparent PNG
    const pngRes = await fetch(outputUrl);
    if (!pngRes.ok) {
      throw new Error(`Failed to download Replicate output: ${pngRes.status}`);
    }
    const pngBytes = new Uint8Array(await pngRes.arrayBuffer());

    // 4) Upload to ai-media bucket
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const fileName = `pipeline/nobg-${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from("ai-media")
      .upload(fileName, pngBytes, { contentType: "image/png", upsert: true });

    let publicUrl = outputUrl; // fallback
    if (uploadError) {
      console.error("[remove-background] Upload error:", uploadError);
    } else {
      const { data: urlData, error: signError } = await supabase.storage
        .from("ai-media")
        .createSignedUrl(fileName, 60 * 60 * 24 * 7);
      if (!signError && urlData?.signedUrl) {
        publicUrl = urlData.signedUrl;
      } else {
        const { data: pubData } = supabase.storage.from("ai-media").getPublicUrl(fileName);
        publicUrl = pubData.publicUrl;
      }
    }

    console.log(`[remove-background] Success — uploaded to ai-media`);

    return new Response(
      JSON.stringify({
        result_url: publicUrl,
        outputs: { output_image: publicUrl },
        output_type: "image_url",
        provider_meta: { model: "replicate-birefnet", prediction_id: created.id },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[remove-background] Error:", message);
    const status = message === "PROVIDER_BILLING_ERROR" ? 402 : 500;
    return new Response(
      JSON.stringify({ error: message }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
