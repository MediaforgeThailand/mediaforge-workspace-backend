import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logApiUsage } from "../_shared/posthogCapture.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
    if (!apiKey) throw new Error("GOOGLE_AI_STUDIO_KEY is not configured");

    // Auth check
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey!, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await supabaseUser.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { text, flow_id } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(
        JSON.stringify({ error: "text is required (string)" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (text.length > 10000) {
      return new Response(
        JSON.stringify({ error: "Text too long (max 10,000 chars)" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Call Gemini Embedding API
    const apiStart = Date.now();
    const response = await fetch(`${EMBEDDING_API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini Embedding API error:", response.status, errText);

      // Log failed API call
      const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await logApiUsage(adminClient, {
        user_id: user.id,
        endpoint: "generate-embedding",
        feature: "embedding",
        model: EMBEDDING_MODEL,
        status: "error",
        duration_ms: Date.now() - apiStart,
        error_message: `HTTP ${response.status}: ${errText.substring(0, 200)}`,
        request_metadata: { flow_id: flow_id || null, text_length: text.length },
      });

      throw new Error("Failed to generate embedding");
    }

    const result = await response.json();
    const embedding = result?.embedding?.values;

    if (!embedding || !Array.isArray(embedding)) {
      console.error("Unexpected response shape:", JSON.stringify(result).slice(0, 500));
      throw new Error("No embedding returned from API");
    }

    console.log(`Embedding generated: ${embedding.length} dimensions`);

    // Log successful API call
    const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await logApiUsage(adminClient, {
      user_id: user.id,
      endpoint: "generate-embedding",
      feature: "embedding",
      model: EMBEDDING_MODEL,
      status: "success",
      duration_ms: Date.now() - apiStart,
      request_metadata: { flow_id: flow_id || null, text_length: text.length, dimensions: embedding.length },
    });

    // If flow_id is provided, update the flows table directly
    if (flow_id) {
      const supabaseAdmin = createClient(
        supabaseUrl,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } }
      );

      // Verify the user owns this flow
      const { data: flow, error: flowErr } = await supabaseAdmin
        .from("flows")
        .select("user_id")
        .eq("id", flow_id)
        .single();

      if (flowErr || !flow) {
        return new Response(JSON.stringify({ error: "Flow not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (flow.user_id !== user.id) {
        return new Response(
          JSON.stringify({ error: "Not authorized to update this flow" }),
          {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Store embedding as vector string format for pgvector
      const vectorStr = `[${embedding.join(",")}]`;
      const { error: updateErr } = await supabaseAdmin
        .from("flows")
        .update({ embedding: vectorStr } as any)
        .eq("id", flow_id);

      if (updateErr) {
        console.error("Failed to store embedding:", updateErr);
        throw new Error("Failed to store embedding in database");
      }

      console.log(`Embedding stored for flow ${flow_id}`);
      return new Response(
        JSON.stringify({ success: true, flow_id, dimensions: embedding.length }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Return raw embedding if no flow_id
    return new Response(
      JSON.stringify({ embedding, dimensions: embedding.length }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("generate-embedding error:", e);
    const msg = e instanceof Error ? e.message : "Embedding generation failed";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
