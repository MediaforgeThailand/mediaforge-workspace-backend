/// <reference lib="deno.ns" />
import { getAuthUser, isServiceRole, unauthorized } from "../_shared/auth.ts";
/**
 * merge-audio-video — Combines a video stream with an audio track via Shotstack.
 *
 * Input:
 *  - video_url: source video (https URL)
 *  - audio_url: source audio (https URL — typically signed URL of an MP3 in ai-media)
 *  - audio_mode: "replace" (default) | "mix" — controls volume of original video audio
 *  - audio_volume: 0..1 (default 1)
 *
 * Output: signed URL of muxed MP4 in ai-media bucket.
 *
 * Behavior:
 *  - Probes video duration via Shotstack's transcoded length (set by render).
 *  - Trims audio to video length and applies a 0.5s fade-out at the tail.
 *  - Polls Shotstack render until "done" or "failed" (max 5 min).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SHOTSTACK_BASE = "https://api.shotstack.io/edit/v1";
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_MS = 5 * 60 * 1000; // 5 min

interface ShotstackRenderResponse {
  success?: boolean;
  message?: string;
  response?: {
    id?: string;
    status?: "queued" | "fetching" | "rendering" | "saving" | "done" | "failed";
    url?: string;
    error?: string;
    data?: unknown;
  };
}

async function probeVideoDuration(apiKey: string, videoUrl: string): Promise<number | null> {
  // Use Shotstack's probe endpoint to read video metadata (duration in seconds).
  // Returns null on failure so the caller can fall back to a safe default.
  try {
    const url = `${SHOTSTACK_BASE}/probe/${encodeURIComponent(videoUrl)}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey } });
    if (!res.ok) {
      console.warn(`[merge-audio-video] probe HTTP ${res.status}`);
      await res.text();
      return null;
    }
    const json = await res.json();
    // Shotstack probe returns { response: { metadata: { streams: [{ duration: "12.345" }, ...] } } }
    const streams = json?.response?.metadata?.streams;
    if (Array.isArray(streams)) {
      for (const s of streams) {
        const d = Number(s?.duration);
        if (Number.isFinite(d) && d > 0) return d;
      }
    }
    // Fallback paths used by Shotstack in some responses
    const direct = Number(json?.response?.metadata?.format?.duration);
    if (Number.isFinite(direct) && direct > 0) return direct;
    return null;
  } catch (e) {
    console.warn("[merge-audio-video] probe failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function startShotstackRender(
  apiKey: string,
  videoUrl: string,
  audioUrl: string,
  opts: { audioMode: "replace" | "mix"; audioVolume: number },
): Promise<string> {
  // Timeline:
  //   - Track 1 (top, video): the source video clip
  //   - Track 2 (audio): the MP3, trimmed to video length with fade-out
  //
  // Shotstack requires explicit numeric `length` on each clip — neither "auto"
  // nor "end" reliably set the timeline duration. We probe the video first
  // and use its duration for both the video and audio clips.
  //
  // For "replace" mode we set the video clip's volume to 0 so original sound is muted.
  // For "mix" mode we leave the video's audio at full volume.

  const probedDuration = await probeVideoDuration(apiKey, videoUrl);
  // Safe fallback if probe fails: 30s. Most Kling clips are 5–10s so this is generous.
  const clipLength = probedDuration ?? 30;
  console.log(`[merge-audio-video] using length=${clipLength}s (probed=${probedDuration !== null})`);

  const videoClip: Record<string, unknown> = {
    asset: { type: "video", src: videoUrl, volume: opts.audioMode === "replace" ? 0 : 1 },
    start: 0,
    length: clipLength,
  };

  const audioClip: Record<string, unknown> = {
    asset: { type: "audio", src: audioUrl, volume: opts.audioVolume },
    start: 0,
    length: clipLength,
    transition: { out: "fade" },
  };

  const payload = {
    timeline: {
      tracks: [
        { clips: [videoClip] },   // top track = video (visual + optional original audio)
        { clips: [audioClip] },   // bottom track = the new MP3
      ],
    },
    output: {
      format: "mp4",
      resolution: "hd", // 1280x720 — final pass
      fps: 30,
    },
  };

  const res = await fetch(`${SHOTSTACK_BASE}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`[merge-audio-video] Shotstack render submit HTTP ${res.status}: ${text.substring(0, 500)}`);
    if (res.status === 402 || res.status === 429 || /quota|billing|insufficient/i.test(text)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(`Shotstack render submit failed (${res.status})`);
  }

  let parsed: ShotstackRenderResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Shotstack render returned invalid JSON");
  }

  const renderId = parsed.response?.id;
  if (!renderId) {
    throw new Error(`Shotstack render returned no render id: ${parsed.message ?? "unknown"}`);
  }
  console.log(`[merge-audio-video] Shotstack render submitted: id=${renderId}`);
  return renderId;
}

async function pollShotstackRender(apiKey: string, renderId: string): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_MS) {
    const res = await fetch(`${SHOTSTACK_BASE}/render/${renderId}`, {
      headers: { "x-api-key": apiKey },
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[merge-audio-video] Shotstack poll HTTP ${res.status}: ${text.substring(0, 200)}`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    let parsed: ShotstackRenderResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    const status = parsed.response?.status;
    const url = parsed.response?.url;
    console.log(`[merge-audio-video] poll: status=${status}`);
    if (status === "done" && url) return url;
    if (status === "failed") {
      const err = parsed.response?.error || "Shotstack render failed";
      throw new Error(err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Shotstack render timed out after 5 minutes");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth: require authenticated user or service_role
  if (!isServiceRole(req)) {
    const user = await getAuthUser(req);
    if (!user) return unauthorized();
  }

  try {
    const SHOTSTACK_API_KEY = Deno.env.get("SHOTSTACK_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!SHOTSTACK_API_KEY) {
      return new Response(JSON.stringify({ error: "SHOTSTACK_API_KEY not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const videoUrl = String(body.video_url ?? "");
    const audioUrl = String(body.audio_url ?? "");
    const audioMode: "replace" | "mix" = body.audio_mode === "mix" ? "mix" : "replace";
    const rawVolume = Number(body.audio_volume);
    const audioVolume = Number.isFinite(rawVolume) ? Math.max(0, Math.min(1, rawVolume)) : 1;

    if (!videoUrl) {
      return new Response(JSON.stringify({ error: "video_url is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!audioUrl) {
      return new Response(JSON.stringify({ error: "audio_url is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[merge-audio-video] mode=${audioMode} volume=${audioVolume} video=${videoUrl.substring(0, 80)}… audio=${audioUrl.substring(0, 80)}…`);

    // 1. Submit Shotstack render
    const renderId = await startShotstackRender(SHOTSTACK_API_KEY, videoUrl, audioUrl, {
      audioMode, audioVolume,
    });

    // 2. Poll until done
    const renderedUrl = await pollShotstackRender(SHOTSTACK_API_KEY, renderId);
    console.log(`[merge-audio-video] Shotstack render done: ${renderedUrl}`);

    // 3. Download the rendered MP4 and re-upload to ai-media so we get a stable signed URL
    let finalUrl = renderedUrl;
    try {
      const dl = await fetch(renderedUrl);
      if (dl.ok) {
        const bytes = new Uint8Array(await dl.arrayBuffer());
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const path = `merge/mediaforge_${Date.now()}_${renderId.substring(0, 8)}.mp4`;
        const { error: upErr } = await supabase.storage
          .from("ai-media")
          .upload(path, bytes, { contentType: "video/mp4", upsert: true });
        if (!upErr) {
          const { data: signed } = await supabase.storage
            .from("ai-media")
            .createSignedUrl(path, 60 * 60 * 24 * 7);
          if (signed?.signedUrl) finalUrl = signed.signedUrl;
        } else {
          console.warn("[merge-audio-video] re-upload failed, returning Shotstack URL:", upErr.message);
        }
      }
    } catch (mirrorErr) {
      console.warn("[merge-audio-video] mirror download failed (non-fatal):", mirrorErr);
    }

    return new Response(
      JSON.stringify({
        result_url: finalUrl,
        outputs: { output_video: finalUrl },
        output_type: "video_url",
        provider_meta: { provider: "shotstack", render_id: renderId, audio_mode: audioMode, audio_volume: audioVolume },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[merge-audio-video] Error:", msg);
    const isBilling = msg === "PROVIDER_BILLING_ERROR";
    return new Response(
      JSON.stringify({ error: msg }),
      { status: isBilling ? 402 : 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
