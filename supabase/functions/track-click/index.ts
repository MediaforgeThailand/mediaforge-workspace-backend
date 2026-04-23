import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// In-memory rate limit: 10 req/IP/min
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, recent);
    return false;
  }
  recent.push(now);
  rateLimitMap.set(ip, recent);

  // Opportunistic cleanup to avoid memory growth
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap.entries()) {
      const filtered = v.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (filtered.length === 0) rateLimitMap.delete(k);
      else rateLimitMap.set(k, filtered);
    }
  }
  return true;
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function respond(success: boolean, payload: Record<string, unknown>, status = 200) {
  return new Response(
    JSON.stringify(success ? { ok: true, ...payload } : { ok: false, ...payload }),
    { status, headers: jsonHeaders },
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond(false, { error: "Method not allowed" }, 405);
  }

  try {
    const ip = getClientIp(req);

    if (!checkRateLimit(ip)) {
      return respond(false, { error: "Rate limit exceeded" }, 429);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return respond(false, { error: "Invalid JSON body" }, 400);
    }

    const {
      code: rawCode,
      device_fp,
      user_agent,
      referrer,
      landing_path,
      utm_source,
      utm_medium,
      utm_campaign,
    } = body as Record<string, unknown>;

    if (typeof rawCode !== "string") {
      return respond(false, { error: "Missing code" }, 400);
    }

    const code = rawCode.trim().toUpperCase();
    const codePattern = /^MF-[A-Z0-9-]{4,32}$/;
    if (!codePattern.test(code)) {
      return respond(false, { error: "Invalid code format" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[track-click] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return respond(false, { error: "Server configuration error" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    // Lookup code → code_id (active only)
    const { data: codeRow, error: lookupErr } = await supabase
      .from("referral_codes")
      .select("id")
      .eq("code", code)
      .eq("is_active", true)
      .maybeSingle();

    if (lookupErr) {
      console.error("[track-click] Lookup error:", lookupErr);
      return respond(false, { error: "Lookup failed" }, 500);
    }

    if (!codeRow) {
      // Skip silently — code not found or inactive
      return respond(true, { code_id: null, skipped: true });
    }

    const ipHash = await sha256(ip);
    const countryCode = req.headers.get("cf-ipcountry") || null;

    const { error: insertErr } = await supabase.from("referral_clicks").insert({
      code_id: codeRow.id,
      code,
      ip_hash: ipHash,
      device_fp: typeof device_fp === "string" ? device_fp : null,
      user_agent: typeof user_agent === "string" ? user_agent : (req.headers.get("user-agent") ?? null),
      referrer_url: typeof referrer === "string" ? referrer : null,
      landing_path: typeof landing_path === "string" ? landing_path : null,
      utm_source: typeof utm_source === "string" ? utm_source : null,
      utm_medium: typeof utm_medium === "string" ? utm_medium : null,
      utm_campaign: typeof utm_campaign === "string" ? utm_campaign : null,
      country_code: countryCode,
    });

    if (insertErr) {
      console.error("[track-click] Insert error:", insertErr);
      return respond(false, { error: "Insert failed" }, 500);
    }

    return respond(true, { code_id: codeRow.id });
  } catch (err) {
    console.error("[track-click] Error:", err);
    return respond(false, { error: err instanceof Error ? err.message : "Internal error" }, 500);
  }
});
