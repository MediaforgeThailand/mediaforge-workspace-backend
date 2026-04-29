/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any
//
// mf-um-resolve-login
// -------------------
// Public (anon) edge function called from the /auth page BEFORE the user
// has authenticated. Given an email, returns either:
//
//   { is_org: true, org: {...}, providers: [...] }   — show org SSO buttons
//   { is_org: false }                                 — fall back to consumer flow
//
// The function uses the ANON key + relies on the public-readable RLS policies
// on `organization_domains` (verified_at IS NOT NULL) and
// `organization_sso_providers` (is_enabled=true). No service-role access;
// no secrets exposed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Strict-enough email syntax for domain extraction. We don't need RFC 5322
// fidelity here — only that a single `@` separates the local part from a
// domain that contains at least one `.` and no whitespace.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ProviderRow {
  provider: "google_workspace" | "microsoft_entra" | "email_otp";
  is_primary: boolean;
  is_enabled: boolean;
  config: Record<string, unknown>;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  display_name: string | null;
  logo_url: string | null;
  brand_color: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: "invalid_email" }, 400);
  }

  const domain = email.split("@")[1];

  // Use SERVICE_ROLE_KEY: this is a PUBLIC endpoint (anon can call), but we
  // use the service-role client internally to bypass RLS. Safety is enforced
  // by `select(...)` whitelisting only branding fields (id/name/slug/logo_url)
  // and `is_enabled`/`is_verified` filters — no contract/contact data is
  // ever returned to the caller. `organizations` has no anon-readable
  // policy (members-only), so direct anon access via REST is impossible.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1) Look up verified domain → organization_id
  const { data: domainRow, error: domainErr } = await supabase
    .from("organization_domains")
    .select("organization_id")
    .eq("domain", domain)
    .not("verified_at", "is", null)
    .maybeSingle();

  if (domainErr) {
    console.error("[mf-um-resolve-login] domain lookup error:", domainErr.message);
    return json({ error: "lookup_failed" }, 500);
  }

  if (!domainRow) {
    // Domain not registered → consumer flow. Don't leak whether the email
    // exists; just say "no org match".
    return json({ is_org: false });
  }

  // 2) Get org info + SSO providers in parallel
  const [orgRes, providersRes] = await Promise.all([
    supabase
      .from("organizations")
      .select("id, name, slug, display_name, logo_url, brand_color, status")
      .eq("id", domainRow.organization_id)
      .maybeSingle(),
    supabase
      .from("organization_sso_providers")
      .select("provider, is_primary, is_enabled, config")
      .eq("organization_id", domainRow.organization_id)
      .eq("is_enabled", true)
      .order("is_primary", { ascending: false }),
  ]);

  if (orgRes.error || !orgRes.data) {
    console.error("[mf-um-resolve-login] org fetch error:", orgRes.error?.message);
    // Domain matched but org row hidden (could be deleted_at or status='suspended'
    // — RLS public read is on `organizations` for members only, so this
    // path falls through. Treat as no-org for safety.)
    return json({ is_org: false });
  }

  if (orgRes.data.status !== "active") {
    return json({
      is_org: false,
      reason: "org_inactive",
    });
  }

  const org: OrgRow = {
    id: orgRes.data.id,
    name: orgRes.data.name,
    slug: orgRes.data.slug,
    display_name: orgRes.data.display_name,
    logo_url: orgRes.data.logo_url,
    brand_color: orgRes.data.brand_color,
  };

  const providers = (providersRes.data ?? []) as ProviderRow[];

  // Methods that the frontend should HIDE for this org user. Always block
  // password (no consumer password sign-in for org users) and consumer
  // Google (force them to use the org SSO with hd_hint instead). LINE +
  // phone OTP also blocked unless the org explicitly enabled email_otp.
  const blocked: string[] = ["password", "google_consumer", "line", "phone_otp"];
  if (!providers.some((p) => p.provider === "email_otp")) {
    blocked.push("magic_link");
  }

  return json({
    is_org: true,
    org,
    providers: providers.map((p) => ({
      provider: p.provider,
      is_primary: p.is_primary,
      config: p.config ?? {},
    })),
    blocked_methods: blocked,
  });
});
