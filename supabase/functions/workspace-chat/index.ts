/// <reference lib="deno.ns" />
/// <reference lib="dom" />
/**
 * workspace-chat — multi-provider chat proxy for the workspace's
 * "คุยกับ Max" assistant panel.
 *
 * Routing is by model slug prefix:
 *   - `gemini-*`  → Google Generative Language API
 *   - else (`gpt-*`, etc.) → OpenAI Chat Completions
 *
 * Body shape:
 *   {
 *     model: "gpt-5.5" | "gemini-3.1-pro-preview" | …,   // required
 *     system_prompt: string,                              // assistant persona
 *     messages: [{ role: "user" | "assistant", content }],
 *     canvas_context?: {                                  // optional snapshot
 *       canvas_id, canvas_name,
 *       nodes: [{ id, type, label, model }],
 *       edges: [{ source, target, sourceHandle, targetHandle }]
 *     }
 *   }
 *
 * Returns:
 *   { content: string }
 *
 * **AUTH** — requires a Supabase user JWT in the Authorization header.
 * Anonymous calls are rejected (401) so neither provider's API key is
 * drainable by anyone with the URL. Per-user rate limit (in-memory
 * burst guard) blunts a single client spamming.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ── Naive in-memory burst guard ───────────────────────────────
 * Edge functions can be cold-started, so this rate map is per-warm-
 * instance — not a global limit. Still useful to blunt a single-
 * client burst (someone scripting Enter spam in the UI). For real
 * abuse defence add Supabase / Cloudflare-level rate limits. */
const _userHits = new Map<string, number[]>();
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 12; // 12 chats / 10s / instance / user
function rateLimitOk(userId: string): boolean {
  const now = Date.now();
  const arr = (_userHits.get(userId) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (arr.length >= RATE_LIMIT) {
    _userHits.set(userId, arr);
    return false;
  }
  arr.push(now);
  _userHits.set(userId, arr);
  return true;
}

interface ChatAttachment {
  /** "image/png", "image/jpeg", … */
  mime: string;
  /** Full base64 `data:<mime>;base64,<…>` URL. */
  dataUrl: string;
}

interface ChatBody {
  model?: string;
  system_prompt?: string;
  messages?: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    /** Optional image attachments — OpenAI / Gemini both accept these
     *  inline (base64 data URL); the provider helpers below translate
     *  to the right wire format. */
    attachments?: ChatAttachment[];
  }>;
  canvas_context?: {
    canvas_id?: string;
    canvas_name?: string;
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
  };
}

const DEFAULT_SYSTEM_FALLBACK = `You are a helpful assistant inside the MediaForge workspace. Help the user write good prompts for image and video generation.`;

/** GPT-5 family rejects custom temperature — must use the default. */
function modelExpectsDefaultTemperature(model: string): boolean {
  return /^gpt-5(?:[.\-]|$)/i.test(model);
}

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: ChatAttachment[];
};

/** Strip the `data:<mime>;base64,` prefix from a data URL, returning
 *  just the raw base64 payload that Gemini's `inline_data.data`
 *  expects. Returns null if the URL isn't a base64 data URL. */
function dataUrlToBase64(dataUrl: string): string | null {
  const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl);
  return m ? m[1] : null;
}

/* ── OpenAI Chat Completions ──────────────────────────────── */

async function callOpenAI({
  model,
  systemPrompt,
  messages,
}: {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
}): Promise<string> {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY not configured — set it in Supabase project secrets before using ChatGPT.",
    );
  }

  /* Translate `attachments` → OpenAI's multipart content array. When
   * a message has no attachments we keep the simple `content: string`
   * form; when it does, content becomes
   *   [{ type: "text", text }, { type: "image_url", image_url: { url } }]
   * which is the documented vision input shape (works for gpt-4o,
   * gpt-5, gpt-5.5, etc.). */
  const translatedMessages = messages.map((m) => {
    if (!m.attachments || m.attachments.length === 0) {
      return { role: m.role, content: m.content };
    }
    const parts: Array<Record<string, unknown>> = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const att of m.attachments) {
      parts.push({
        type: "image_url",
        image_url: { url: att.dataUrl },
      });
    }
    return { role: m.role, content: parts };
  });

  const openaiBody: Record<string, unknown> = {
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      ...translatedMessages,
    ],
  };
  // GPT-5 family requires the default temperature; older / GPT-4o
  // family is happier with explicit 0.7 for chat-style replies.
  if (!modelExpectsDefaultTemperature(model)) {
    openaiBody.temperature = 0.7;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(openaiBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[workspace-chat] OpenAI ${res.status}:`, errText.substring(0, 500));
    let detail = errText.substring(0, 400);
    try {
      const j = JSON.parse(errText);
      detail = j?.error?.message ?? detail;
    } catch {
      /* not JSON, keep raw */
    }
    throw new Error(`OpenAI API error (HTTP ${res.status}): ${detail}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/* ── Google Gemini ────────────────────────────────────────── */

async function callGemini({
  model,
  systemPrompt,
  messages,
}: {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
}): Promise<string> {
  // Workspace dev names this secret `GEMINI_API_KEY`; legacy edge
  // functions in the same project use `GOOGLE_AI_STUDIO_KEY`. Accept
  // either so a single secret can drive every Gemini-touching
  // function instead of duplicating it.
  const KEY =
    Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
  if (!KEY) {
    throw new Error(
      "Neither GOOGLE_AI_STUDIO_KEY nor GEMINI_API_KEY is configured — set one in Supabase project secrets before using Gemini.",
    );
  }

  // Gemini's chat shape:
  //   - `system_instruction` carries the persona separately
  //   - `contents[]` holds the conversation; assistant role is "model"
  //     (not "assistant"); user role stays "user".
  //   - System messages from the caller (rare here) are folded into
  //     system_instruction so the model still sees them.
  const sysExtras = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const fullSystem = sysExtras ? `${systemPrompt}\n\n${sysExtras}` : systemPrompt;

  /* Build Gemini `parts[]`. Text part first, then any attached images
   * as `inline_data` parts. Gemini's inline_data wants RAW base64
   * (no `data:image/…;base64,` prefix), so each attachment goes
   * through dataUrlToBase64 to strip it. */
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) parts.push({ text: m.content });
      for (const att of m.attachments ?? []) {
        const b64 = dataUrlToBase64(att.dataUrl);
        if (!b64) continue;
        parts.push({
          inline_data: {
            mime_type: att.mime || "image/png",
            data: b64,
          },
        });
      }
      // Empty parts[] is invalid in Gemini; insert a placeholder so
      // an attachment-only user message still makes it through.
      if (parts.length === 0) parts.push({ text: "" });
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: fullSystem }] },
      contents,
      generationConfig: {
        temperature: 0.7,
        // No max_output_tokens — let the model decide; system prompt
        // already steers Max toward concise answers.
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[workspace-chat] Gemini ${res.status}:`, errText.substring(0, 500));
    let detail = errText.substring(0, 400);
    try {
      const j = JSON.parse(errText);
      detail = j?.error?.message ?? detail;
    } catch {
      /* not JSON, keep raw */
    }
    throw new Error(`Gemini API error (HTTP ${res.status}): ${detail}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  // Gemini may return multiple parts (rare in chat); concat all text.
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    /* ── Auth — require a valid Supabase user JWT ────────────
     * Without this, anyone with the function URL can call OpenAI
     * on our key. Per-user rate limit (above) blunts burst abuse
     * once we know who they are. */
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "").replace(/^bearer\s+/i, "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (!rateLimitOk(user.id)) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded — please slow down" }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = (await req.json().catch(() => ({}))) as ChatBody;
    const model = String(body.model ?? "gpt-5").trim();
    const userMessages = Array.isArray(body.messages) ? body.messages : [];

    if (userMessages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Build system prompt ────────────────────────────────
     * Combine the caller's system_prompt with a compact JSON dump
     * of the live canvas, so the assistant can give advice grounded
     * in what the user actually has on screen (current model picks,
     * connected refs, etc.). The compact JSON keeps the token cost
     * predictable — we deliberately strip params/values that aren't
     * relevant to a prompt-writing helper. */
    const sysPromptUser =
      typeof body.system_prompt === "string" && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : DEFAULT_SYSTEM_FALLBACK;

    let canvasBlock = "";
    if (body.canvas_context) {
      const ctx = body.canvas_context;
      const lines: string[] = [];
      lines.push(`Canvas: "${ctx.canvas_name ?? "Untitled"}"`);
      const nodes = Array.isArray(ctx.nodes) ? ctx.nodes : [];
      if (nodes.length > 0) {
        lines.push(`Nodes (${nodes.length}):`);
        for (const n of nodes.slice(0, 40)) {
          const type = n.type ?? "?";
          const label = n.label ?? "—";
          const m = n.model ? ` model=${n.model}` : "";
          lines.push(`  - ${type} "${label}"${m}`);
        }
        if (nodes.length > 40) lines.push(`  …and ${nodes.length - 40} more`);
      }
      const edges = Array.isArray(ctx.edges) ? ctx.edges : [];
      if (edges.length > 0) {
        lines.push(`Edges: ${edges.length} (skipped detail)`);
      }
      canvasBlock = `\n\n[Live canvas snapshot]\n${lines.join("\n")}`;
    }

    const fullSystemPrompt = sysPromptUser + canvasBlock;

    console.log(
      `[workspace-chat] model=${model} msgs=${userMessages.length} canvas=${
        body.canvas_context ? "yes" : "no"
      }`,
    );

    /* ── Provider routing ───────────────────────────────────
     * The model slug picks the provider. Each branch is responsible
     * for translating the unified `userMessages` into its own wire
     * format and pulling the reply text back out. */
    const isGemini = /^gemini[-_./]/i.test(model) || /^gemini$/i.test(model);

    let content = "";
    if (isGemini) {
      content = await callGemini({
        model,
        systemPrompt: fullSystemPrompt,
        messages: userMessages,
      });
    } else {
      content = await callOpenAI({
        model,
        systemPrompt: fullSystemPrompt,
        messages: userMessages,
      });
    }

    return new Response(
      JSON.stringify({ content }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[workspace-chat] error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
