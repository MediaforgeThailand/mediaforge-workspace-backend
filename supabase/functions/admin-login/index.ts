/// <reference lib="deno.ns" />
/// <reference lib="dom" />
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function hashPw(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256);
  return btoa(String.fromCharCode(...salt)) + ":" + btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function verifyPw(password: string, stored: string): Promise<boolean> {
  const [sB, hB] = stored.split(":");
  const salt = Uint8Array.from(atob(sB), (c: string) => c.charCodeAt(0));
  const expected = Uint8Array.from(atob(hB), (c: string) => c.charCodeAt(0));
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256);
  const hash = new Uint8Array(bits);
  return hash.length === expected.length && hash.every((b, i) => b === expected[i]);
}

async function signJWT(payload: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const h = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const p = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", enc.encode(Deno.env.get("JWT_SECRET")!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${h}.${p}`));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${p}.${s}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { email, password, action } = await req.json();
    if (!email || !password) return json({ error: "Email and password required" }, 400);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Reseed mode: update existing admin or create new one
    if (action === "reseed") {
      const hash = await hashPw(password);
      // Try update first
      const { data: existing } = await supabase
        .from("admin_accounts")
        .select("id")
        .eq("email", email)
        .single();
      
      if (existing) {
        const { error: upErr } = await supabase
          .from("admin_accounts")
          .update({ password_hash: hash, is_active: true })
          .eq("id", existing.id);
        if (upErr) return json({ error: upErr.message }, 500);
        return json({ message: "Admin reseeded", admin: { id: existing.id, email } });
      }
      // No account exists, create new
      const { data, error } = await supabase.from("admin_accounts").insert({
        email,
        password_hash: hash,
        display_name: email.split("@")[0],
        admin_role: "super_admin",
      }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ message: "Admin reseeded (created)", admin: { id: data.id, email: data.email } });
    }

    // Seed mode: create first super_admin if none exist
    if (action === "seed") {
      const { count } = await supabase.from("admin_accounts").select("*", { count: "exact", head: true });
      if ((count ?? 0) > 0) return json({ error: "Admin accounts already exist. Use 'reseed' to replace." }, 403);
      const hash = await hashPw(password);
      const { data, error } = await supabase.from("admin_accounts").insert({
        email,
        password_hash: hash,
        display_name: email.split("@")[0],
        admin_role: "super_admin",
      }).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ message: "Super admin created", admin: { id: data.id, email: data.email } });
    }

    // Force reset password for existing admin
    if (action === "force_reset") {
      const newHash = await hashPw(password);
      const { data: updated, error: updateErr } = await supabase
        .from("admin_accounts")
        .update({ password_hash: newHash })
        .eq("email", email)
        .select("id, email")
        .single();
      if (updateErr || !updated) return json({ error: "Account not found" }, 404);
      return json({ message: "Password reset successful", admin: { id: updated.id, email: updated.email } });
    }

    // Normal login — with auto-bootstrap for first admin
    const { data: admin, error } = await supabase
      .from("admin_accounts")
      .select("*")
      .eq("email", email)
      .eq("is_active", true)
      .single();

    if (!admin) return json({ error: "Invalid credentials" }, 401);

    const valid = await verifyPw(password, admin.password_hash);
    if (!valid) return json({ error: "Invalid credentials" }, 401);

    await supabase.from("admin_accounts").update({ last_login_at: new Date().toISOString() }).eq("id", admin.id);

    const token = await signJWT({
      sub: admin.id, email: admin.email, role: admin.admin_role,
      display_name: admin.display_name, type: "admin",
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    });

    return json({
      token,
      admin: { id: admin.id, email: admin.email, role: admin.admin_role, display_name: admin.display_name },
    });
  } catch (err) {
    console.error(err);
    return json({ error: "Server error" }, 500);
  }
});
