import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;
const DELAY_MS = 500;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const geminiKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
    if (!geminiKey) throw new Error("GOOGLE_AI_STUDIO_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    // Optional: restrict to admin via auth header
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "");
      const anonClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
        { global: { headers: { Authorization: `Bearer ${token}` } } }
      );
      const { data: { user } } = await anonClient.auth.getUser(token);
      if (!user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Parse optional limit from body
    let limit = 100;
    try {
      const body = await req.json();
      if (body?.limit) limit = Math.min(body.limit, 500);
    } catch { /* no body is fine */ }

    // Fetch flows with NULL embedding
    const { data: flows, error: fetchErr } = await supabase
      .from("flows")
      .select("id, name, description, keywords")
      .is("embedding", null)
      .limit(limit);

    if (fetchErr) throw fetchErr;
    if (!flows || flows.length === 0) {
      return new Response(
        JSON.stringify({ message: "No flows need backfilling", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const results: { id: string; status: string }[] = [];

    for (const flow of flows) {
      const text = [flow.name, flow.description || "", ...(flow.keywords || [])]
        .filter(Boolean)
        .join(" ")
        .trim();

      if (!text) {
        results.push({ id: flow.id, status: "skipped_empty" });
        continue;
      }

      try {
        const res = await fetch(`${EMBEDDING_API_URL}?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text }] },
            outputDimensionality: 768,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(`Gemini error for ${flow.id}: status=${res.status} body=${errText.slice(0, 300)}`);
          results.push({ id: flow.id, status: `api_error_${res.status}` });
          continue;
        }

        const result = await res.json();
        const embedding = result?.embedding?.values;

        if (!embedding || !Array.isArray(embedding)) {
          results.push({ id: flow.id, status: "no_embedding_returned" });
          continue;
        }

        const vectorStr = `[${embedding.join(",")}]`;
        const { error: updateErr } = await supabase
          .from("flows")
          .update({ embedding: vectorStr } as any)
          .eq("id", flow.id);

        if (updateErr) {
          console.error(`DB update error for ${flow.id}:`, updateErr);
          results.push({ id: flow.id, status: "db_error" });
        } else {
          results.push({ id: flow.id, status: "ok" });
        }
      } catch (e) {
        console.error(`Error processing ${flow.id}:`, e);
        results.push({ id: flow.id, status: "exception" });
      }

      // Rate-limit delay
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    const success = results.filter((r) => r.status === "ok").length;
    return new Response(
      JSON.stringify({ processed: results.length, success, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("backfill-embeddings error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
