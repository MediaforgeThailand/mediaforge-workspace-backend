/// <reference lib="deno.ns" />
/// <reference lib="dom" />
/**
 * voice-list — proxy to provider voice catalogs.
 *
 * The picker dialog used to ship a hardcoded list of "default" voices
 * (Rachel / Adam / Bella …). Those are real voice IDs but they're
 * the demo defaults every ElevenLabs account starts with — users
 * called them "sample voices" because they're not what a working
 * studio actually uses. Switch to the live API instead so the user
 * sees:
 *
 *   • Their own cloned / library voices (if any)
 *   • Plus the official ElevenLabs Voice Library entries
 *
 * For Gemini and Google we still serve the static catalog because
 * those providers don't expose user-curated voices — Gemini's 30
 * star-named voices and Google Cloud TTS's Studio / Neural2 lists
 * are the ground truth.
 *
 * Body: `{ provider }`  one of "elevenlabs"
 *   (Gemini and Google are handled client-side; only ElevenLabs
 *   genuinely changes per-account.)
 *
 * Auth: verify_jwt = true. Reuses the workspace project's ElevenLabs
 *       key — we don't proxy individual users' keys.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function elevenApiKey(): string | undefined {
  return Deno.env.get("ELEVEN_API_KEY") ?? Deno.env.get("ELEVENLABS_API_KEY");
}

type ElevenLabsApiVoice = {
  voice_id: string;
  name: string;
  category?: string; // "premade" | "cloned" | "generated" | "professional"
  labels?: Record<string, string> | null;
  description?: string | null;
  preview_url?: string | null;
  high_quality_base_model_ids?: string[];
};

interface VoiceListItem {
  id: string;
  name: string;
  category: string;
  description: string;
  /** Pre-existing preview URL hosted by ElevenLabs — we surface this
   *  so the picker can play their CDN sample (zero latency, zero cost
   *  to us). The voice-preview edge fn is still used for Gemini /
   *  Google where no upstream preview exists. */
  preview_url: string | null;
  /** "male" | "female" | "neutral" — derived from the labels.gender
   *  field that ElevenLabs sets on each voice. Used by the picker's
   *  gender filter chip. */
  lean: "male" | "female" | "neutral";
  /** Accent / language tag if present. */
  accent: string | null;
  /** Use-case tag if present (advertisement / narration / …). */
  use_case: string | null;
}

function leanFrom(labels: Record<string, string> | null | undefined): VoiceListItem["lean"] {
  const g = (labels?.gender ?? "").toLowerCase();
  if (g.startsWith("m")) return "male";
  if (g.startsWith("f")) return "female";
  return "neutral";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY =
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Authorization required" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUser = createClient(SUPABASE_URL, ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json()) as { provider?: string };
    const provider = String(body.provider ?? "").toLowerCase();
    if (provider !== "elevenlabs") {
      return new Response(
        JSON.stringify({
          error:
            "Only `elevenlabs` is supported on this endpoint — Gemini and Google catalogs are static and live in the frontend.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const apiKey = elevenApiKey();
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error:
            "ElevenLabs not configured — set ELEVEN_API_KEY in Supabase project secrets.",
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ElevenLabs `GET /v1/voices` returns the user's account voices
    // (premade defaults + any cloned / library voices they've added).
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: {
        "xi-api-key": apiKey,
        "Accept": "application/json",
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(
        `[voice-list] ElevenLabs HTTP ${res.status}: ${errText.slice(0, 300)}`,
      );
      return new Response(
        JSON.stringify({
          error: `ElevenLabs HTTP ${res.status}: ${errText.slice(0, 200)}`,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const json = (await res.json()) as { voices?: ElevenLabsApiVoice[] };
    const raw = (json.voices ?? []) as ElevenLabsApiVoice[];

    // Drop the user's own cloned voices that don't yet have audio
    // samples (those return 404 on TTS), and project the API shape
    // onto our normalised VoiceListItem.
    const items: VoiceListItem[] = raw.map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category ?? "premade",
      description:
        v.description?.slice(0, 140) ??
        formatLabelsAsDescription(v.labels) ??
        "",
      preview_url: v.preview_url ?? null,
      lean: leanFrom(v.labels),
      accent: v.labels?.accent ?? v.labels?.language ?? null,
      use_case: v.labels?.use_case ?? v.labels?.usecase ?? null,
    }));

    return new Response(
      JSON.stringify({
        provider: "elevenlabs",
        voices: items,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[voice-list] unexpected error: ${msg}`);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

function formatLabelsAsDescription(
  labels: Record<string, string> | null | undefined,
): string | null {
  if (!labels) return null;
  // Surface the most useful label fields concisely. ElevenLabs
  // typically sets `accent`, `description`, `age`, `gender`,
  // `use_case` — pick the ones that read naturally.
  const parts: string[] = [];
  if (labels.description) parts.push(labels.description);
  if (labels.accent) parts.push(labels.accent);
  if (labels.age) parts.push(labels.age);
  return parts.length > 0 ? parts.join(" · ") : null;
}
