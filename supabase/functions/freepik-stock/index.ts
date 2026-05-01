import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthUser } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FREEPIK_BASE = "https://api.freepik.com/v1";
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function setIfPresent(params: URLSearchParams, key: string, value: unknown): void {
  const s = typeof value === "string" ? value.trim() : "";
  if (s) params.set(key, s);
}

async function readFreepik(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("FREEPIK_API_KEY");
    if (!apiKey) return json({ error: "FREEPIK_API_KEY not configured" }, 500);

    const authUser = await getAuthUser(req);
    if (!authUser) return json({ error: "Unauthorized" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseService = supabaseUrl && serviceKey
      ? createClient(supabaseUrl, serviceKey)
      : null;

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    const freepikHeaders = {
      Accept: "application/json",
      "Accept-Language": String(body?.language ?? "en-US"),
      // Freepik's public docs reference x-freepik-api-key. The docs
      // currently redirect to Magnific pages that use x-magnific-api-key,
      // so send both to keep this proxy compatible during the transition.
      "x-freepik-api-key": apiKey,
      "x-magnific-api-key": apiKey,
    };

    if (action === "search-resources") {
      const params = new URLSearchParams();
      params.set("page", String(clampInt(body?.page, 1, 1, 100)));
      params.set("limit", String(clampInt(body?.limit, 30, 1, 50)));
      setIfPresent(params, "term", body?.query);
      setIfPresent(params, "order", body?.order);
      setIfPresent(params, "filters[orientation]", body?.orientation);
      setIfPresent(params, "filters[content_type]", body?.contentType);
      setIfPresent(params, "filters[license]", body?.license);

      const res = await fetch(`${FREEPIK_BASE}/resources?${params.toString()}`, {
        headers: freepikHeaders,
      });
      const payload = await readFreepik(res);
      if (!res.ok) {
        console.error("Freepik resources error:", res.status, payload);
        return json({ error: "Freepik API error", status: res.status, details: payload }, res.status);
      }
      return json(payload);
    }

    if (action === "download-resource") {
      const resourceId = String(body?.resourceId ?? "").trim();
      if (!resourceId) return json({ error: "resourceId required" }, 400);

      const params = new URLSearchParams();
      setIfPresent(params, "image_size", body?.imageSize);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`${FREEPIK_BASE}/resources/${resourceId}/download${suffix}`, {
        headers: freepikHeaders,
      });
      const payload = await readFreepik(res);
      if (!res.ok) {
        console.error("Freepik download error:", res.status, payload);
        return json({ error: "Freepik download failed", status: res.status, details: payload }, res.status);
      }

      if (supabaseService) {
        const downloadUrl = (payload as { data?: { url?: string; signed_url?: string } } | null)?.data?.url ??
          (payload as { data?: { url?: string; signed_url?: string } } | null)?.data?.signed_url ??
          null;
        const { error } = await supabaseService.from("stock_downloads").insert({
          user_id: authUser.id,
          resource_id: resourceId,
          resource_title: typeof body?.title === "string" ? body.title : null,
          source: "freepik",
          download_url: downloadUrl,
        });
        if (error) console.warn("stock_downloads insert skipped:", error.message);
      }

      return json(payload);
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("freepik-stock error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});
