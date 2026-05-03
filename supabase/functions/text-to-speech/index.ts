import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logApiUsage } from "../_shared/posthogCapture.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DEFAULT_GEMINI_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_TTS_MODELS = new Set([
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
]);
const GEMINI_TTS_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-flash-tts-preview": "gemini-2.5-flash-preview-tts",
};

const GEMINI_TTS_VOICES = new Set([
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
]);
const DEFAULT_VOICE = "Kore";

function pcmToWav(pcmData: Uint8Array, sampleRate: number, numChannels: number, bitsPerSample: number): Uint8Array {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + dataSize);
  const view = new DataView(wav.buffer);

  // RIFF header
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt subchunk
  wav.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  wav.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);
  wav.set(pcmData, headerSize);

  return wav;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  let loggedUserId: string | null = null;
  let loggedTtsCost = 0;
  let loggedModelName = DEFAULT_GEMINI_TTS_MODEL;
  try {
    const GEMINI_API_KEY =
      Deno.env.get("GOOGLE_AI_STUDIO_KEY") ??
      Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("Gemini API key is not configured");
    }

    // Auth
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey!, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limiting — 15 requests/min for TTS
    const rlAdmin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: rateLimitOk } = await rlAdmin.rpc("check_rate_limit", {
      p_user_id: user.id, p_endpoint: "text-to-speech", p_max_requests: 15, p_window_seconds: 60,
    });
    if (rateLimitOk === false) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Please wait a moment." }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { text, voice, model, style_prompt } = await req.json();
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "Text is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (text.length > 5000) {
      return new Response(JSON.stringify({ error: "Text too long (max 5,000 characters)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const requestedVoice = typeof voice === "string" ? voice.trim() : "";
    if (requestedVoice && !GEMINI_TTS_VOICES.has(requestedVoice)) {
      return new Response(JSON.stringify({ error: "Invalid voice selection" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const requestedModelRaw = typeof model === "string" ? model.trim() : "";
    const requestedModel = GEMINI_TTS_MODEL_ALIASES[requestedModelRaw] ?? requestedModelRaw;
    if (requestedModel && !GEMINI_TTS_MODELS.has(requestedModel)) {
      return new Response(JSON.stringify({ error: "Invalid Gemini TTS model" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const voiceName = requestedVoice || DEFAULT_VOICE;
    const modelName = requestedModel || DEFAULT_GEMINI_TTS_MODEL;
    loggedModelName = modelName;
    const stylePrompt =
      typeof style_prompt === "string" ? style_prompt.trim() : "";

    // Deduct credits using consume_credits RPC
    const supabaseAdmin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    
    // Fetch TTS credit cost from DB
    const { data: exactCostRow } = await supabaseAdmin
      .from("credit_costs")
      .select("cost, pricing_type")
      .eq("feature", "text_to_speech")
      .eq("model", modelName)
      .limit(1)
      .maybeSingle();
    let fallbackCostRows: Array<{ cost: number; pricing_type?: string | null }> | null = null;
    if (!exactCostRow) {
      const { data } = await supabaseAdmin
        .from("credit_costs")
        .select("cost, pricing_type")
        .eq("feature", "text_to_speech")
        .limit(1);
      fallbackCostRows = (data ?? null) as Array<{ cost: number; pricing_type?: string | null }> | null;
    }
    const costRow = exactCostRow ?? fallbackCostRows?.[0] ?? null;
    const baseTtsCost = Number(costRow?.cost ?? 5);
    const ttsCost =
      costRow?.pricing_type === "per_1k_chars"
        ? Math.max(1, Math.ceil((baseTtsCost * Math.max(text.length, 1)) / 1000))
        : baseTtsCost;

    loggedUserId = user.id;
    loggedTtsCost = ttsCost;

    const { data: consumed, error: rpcErr } = await supabaseAdmin.rpc("consume_credits", {
      p_user_id: user.id,
      p_amount: ttsCost,
      p_feature: "text_to_speech",
      p_description: `TTS generation (-${ttsCost} credits)`,
    });

    if (rpcErr || consumed === false) {
      const { data: credits } = await supabaseAdmin.from("user_credits").select("balance").eq("user_id", user.id).single();
      const bal = credits?.balance || 0;
      return new Response(JSON.stringify({ error: `Insufficient credits. Need ${ttsCost}, have ${bal}.`, creditsNeeded: ttsCost, currentBalance: bal }), {
        status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`TTS request: model=${modelName}, voice=${voiceName}, text length=${text.length}`);

    // Call Gemini TTS API
    // Call Gemini TTS API with retry logic
    let audioData: any = null;
    const maxRetries = 3;
    const spokenPrompt = stylePrompt
      ? `${stylePrompt}\n\nRead the following text aloud exactly as written, without adding any extra words or commentary:\n\n${text}`
      : `Please read the following text aloud exactly as written, without adding any extra words or commentary:\n\n${text}`;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: spokenPrompt }] }
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Gemini TTS error (attempt ${attempt + 1}):`, response.status, errText);
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error("Voice generation failed. Please try again.");
      }

      const result = await response.json();
      console.log(`Attempt ${attempt + 1}: finishReason=${result.candidates?.[0]?.finishReason}, parts=${result.candidates?.[0]?.content?.parts?.length}`);
      
      audioData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (audioData?.data) {
        console.log(`TTS success on attempt ${attempt + 1}, audio size: ${audioData.data.length}`);
        break;
      }
      
      console.warn(`No audio data on attempt ${attempt + 1}. Response: ${JSON.stringify(result).slice(0, 300)}`);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    
    if (!audioData?.data) {
      throw new Error("No audio data in Gemini response after retries");
    }

    // Decode base64 PCM audio
    const binaryStr = atob(audioData.data);
    const pcmBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      pcmBytes[i] = binaryStr.charCodeAt(i);
    }

    // Convert PCM to WAV (24000Hz, 1 channel, 16-bit)
    const wavData = pcmToWav(pcmBytes, 24000, 1, 16);

    // Upload to Supabase storage (reuse supabaseAdmin from above)
    const fileName = `${user.id}/tts/${Date.now()}.wav`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("user_assets")
      .upload(fileName, wavData, { contentType: "audio/wav", upsert: true });

    if (uploadError) {
      console.error("Storage upload error:", uploadError);
      throw new Error("Failed to save audio. Please try again.");
    }

    const { data: signedData, error: signError } = await supabaseAdmin.storage
      .from("user_assets")
      .createSignedUrl(fileName, 60 * 60 * 24 * 365);

    if (signError || !signedData?.signedUrl) {
      console.error("Signed URL error:", signError);
      throw new Error("Failed to save audio. Please try again.");
    }
    const audioUrl = signedData.signedUrl;

    // Save to user_assets table (store signed URL)
    await supabaseAdmin.from("user_assets").insert({
      user_id: user.id,
      name: `TTS: ${text.slice(0, 40)}${text.length > 40 ? "..." : ""}`,
      file_url: audioUrl,
      file_type: "audio",
      source: "ai_generated",
      metadata: {
        voice: voiceName,
        model: modelName,
        text_length: text.length,
        style_prompt: stylePrompt || null,
      },
    });

    await logApiUsage(supabaseAdmin, {
      user_id: user.id,
      endpoint: "text-to-speech",
      feature: "tts",
      model: modelName,
      status: "success",
      credits_used: ttsCost,
      duration_ms: Date.now() - startTime,
      request_metadata: { voice: voiceName, text_length: text.length, style_prompt: stylePrompt || null },
    });

    return new Response(JSON.stringify({ audioUrl, voice: voiceName, model: modelName }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("TTS error:", e);
    // Refund credits on failure (create a refund batch)
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      const authHeader = req.headers.get("authorization");
      if (authHeader) {
        const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
        const userClient = createClient(supabaseUrl, supabaseAnonKey!, { global: { headers: { Authorization: authHeader } } });
        const { data: { user } } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
        if (user) {
          const { data: costRows } = await adminClient.from("credit_costs").select("cost").eq("feature", "text_to_speech").limit(1);
          const ttsCost = costRows?.[0]?.cost || 5;
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 30);
          await adminClient.from("credit_batches").insert({
            user_id: user.id, amount: ttsCost, remaining: ttsCost, source_type: "topup",
            expires_at: expiresAt.toISOString(), reference_id: `refund_tts_${Date.now()}`,
          });
          await adminClient.from("user_credits").update({ balance: (await adminClient.from("user_credits").select("balance").eq("user_id", user.id).single()).data!.balance + ttsCost }).eq("user_id", user.id);
          await adminClient.from("credit_transactions").insert({
            user_id: user.id, amount: ttsCost, type: "refund", feature: "text_to_speech",
            description: `Refund: TTS failed (+${ttsCost} credits)`, balance_after: 0,
          });
          console.log(`[REFUND] Refunded ${ttsCost} for TTS failure. User ${user.id}`);
        }
      }
    } catch (refundErr) {
      console.error("[REFUND] TTS refund failed:", refundErr);
    }
    const msg = e instanceof Error ? e.message : "Voice generation failed. Please try again.";
    const safeMessages = ["Text is required", "Text too long", "Invalid voice selection", "Invalid Gemini TTS model", "Voice generation failed. Please try again.", "Failed to save audio. Please try again.", "No audio data in Gemini response after retries"];
    const clientMsg = safeMessages.some(s => msg.includes(s)) ? msg : "Voice generation failed. Please try again.";

    try {
      const logClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      );
      await logApiUsage(logClient, {
        user_id: loggedUserId ?? "system",
        endpoint: "text-to-speech",
        feature: "tts",
        model: loggedModelName,
        status: "error",
        credits_used: loggedTtsCost,
        credits_refunded: loggedTtsCost,
        duration_ms: Date.now() - startTime,
        error_message: msg.substring(0, 500),
      });
    } catch (_) { /* best-effort */ }

    return new Response(JSON.stringify({ error: clientMsg, creditsRefunded: true }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
