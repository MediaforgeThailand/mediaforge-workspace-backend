import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthUser } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FREEPIK_BASE = "https://api.freepik.com/v1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("FREEPIK_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "FREEPIK_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authUser = await getAuthUser(req);
    if (!authUser) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = authUser.id;

    // Create service role client for DB operations
    const supabaseService = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const body = await req.json();
    const { action } = body;

    const freepikHeaders = {
      "x-freepik-api-key": apiKey,
      "Accept-Language": "en",
    };

    // ── Search Resources (photos, vectors, PSDs) ──
    if (action === "search-resources") {
      const { query, page = 1, limit = 20, orientation, contentType, order } = body;
      const params = new URLSearchParams();
      if (query) params.set("term", query);
      params.set("page", String(page));
      params.set("limit", String(Math.min(limit, 50)));
      if (orientation) params.set("orientation", orientation);
      if (contentType) params.set("filters[content_type][photo]", contentType === "photo" ? "1" : "0");
      if (order) params.set("order", order);

      const res = await fetch(`${FREEPIK_BASE}/resources?${params}`, {
        headers: freepikHeaders,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Freepik resources error:", errText);
        return new Response(
          JSON.stringify({ error: `Freepik API error: ${res.status}` }),
          { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Search Videos ──
    if (action === "search-videos") {
      const { query, page = 1, limit = 20, order } = body;
      const params = new URLSearchParams();
      if (query) params.set("term", query);
      params.set("page", String(page));
      params.set("limit", String(Math.min(limit, 50)));
      if (order) params.set("order", order);

      const res = await fetch(`${FREEPIK_BASE}/videos?${params}`, {
        headers: freepikHeaders,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Freepik videos error:", errText);
        return new Response(
          JSON.stringify({ error: `Freepik API error: ${res.status}` }),
          { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Download Resource ──
    if (action === "download-resource") {
      const { resourceId } = body;
      if (!resourceId) {
        return new Response(JSON.stringify({ error: "resourceId required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(`${FREEPIK_BASE}/resources/${resourceId}/download`, {
        headers: freepikHeaders,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Freepik download error:", errText);
        return new Response(
          JSON.stringify({ error: `Download failed: ${res.status}` }),
          { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await res.json();

      // Log the download
      await supabaseService.from("stock_downloads").insert({
        user_id: userId,
        resource_id: String(resourceId),
        resource_title: body.title || null,
        source: "freepik",
        download_url: data?.data?.url || null,
      });

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Download Video ──
    if (action === "download-video") {
      const { videoId } = body;
      if (!videoId) {
        return new Response(JSON.stringify({ error: "videoId required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(`${FREEPIK_BASE}/videos/${videoId}/download`, {
        headers: freepikHeaders,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("Freepik video download error:", errText);
        return new Response(
          JSON.stringify({ error: `Download failed: ${res.status}` }),
          { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const data = await res.json();

      await supabaseService.from("stock_downloads").insert({
        user_id: userId,
        resource_id: String(videoId),
        resource_title: body.title || null,
        source: "freepik-video",
        download_url: data?.data?.url || null,
      });

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("freepik-stock error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
