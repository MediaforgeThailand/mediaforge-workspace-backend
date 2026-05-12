/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import type { ProviderResult } from "./providerResult.ts";
import { isProviderBillingLike } from "./providerErrors.ts";

export async function executeChatAi(params: Record<string, unknown>): Promise<ProviderResult> {
  const requestedModel = String(params.model_name ?? "google/gemini-3-pro-preview");
  const model = requestedModel.startsWith("gemini-")
    ? `google/${requestedModel}`
    : requestedModel;
  const systemPrompt = String(params.system_prompt ?? "You are a helpful AI assistant.");
  const userPrompt = String(params.prompt ?? "");
  const temperature = Number(params.temperature ?? 0.7);
  const maxTokens = parseInt(String(params.max_tokens ?? "1024"), 10);
  const context = params.context_text as string | undefined;

  if (!userPrompt && !context) throw new Error("Prompt is required");

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];
  if (context) {
    messages.push({ role: "user", content: `Context:\n${context}\n\n${userPrompt}` });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  let content: string;
  // Captured per-provider so analytics can record cost-driving token
  // counts. Both OpenAI Chat Completions and Gemini generateContent
  // return usage metadata — fold whichever shape the provider gives us
  // into a normalized {tokens_in, tokens_out, tokens_total} shape.
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let tokensTotal: number | null = null;

  if (model.startsWith("google/")) {
    const GOOGLE_KEY = Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? Deno.env.get("GEMINI_API_KEY");
    if (!GOOGLE_KEY) throw new Error("GEMINI_API_KEY (or GOOGLE_AI_STUDIO_KEY) is not configured");
    const geminiModelMap: Record<string, string> = {
      "google/gemini-3-pro-preview": "gemini-3-pro-preview",
      // Legacy alias from the initial Workspace pricing sheet.
      "google/gemini-3.1-pro-preview": "gemini-3-pro-preview",
      "google/gemini-3-flash-preview": "gemini-3-flash-preview",
    };
    const geminiModel = geminiModelMap[model] ?? model.replace("google/", "");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${GOOGLE_KEY}`;
    const geminiContents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const msg of messages) {
      if (msg.role === "system") continue;
      geminiContents.push({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] });
    }
    const res = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (isProviderBillingLike(res.status, errText)) throw new Error("PROVIDER_BILLING_ERROR");
      throw new Error(`Google AI API error (${res.status})`);
    }
    const data = await res.json();
    content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    // Gemini usage shape: usageMetadata.{promptTokenCount, candidatesTokenCount, totalTokenCount}
    const usage = data.usageMetadata as
      | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
      | undefined;
    if (usage) {
      if (typeof usage.promptTokenCount === "number") tokensIn = usage.promptTokenCount;
      if (typeof usage.candidatesTokenCount === "number") tokensOut = usage.candidatesTokenCount;
      if (typeof usage.totalTokenCount === "number") tokensTotal = usage.totalTokenCount;
    }
  } else if (model.startsWith("openai/")) {
    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is not configured");
    const openaiModel = model.replace("openai/", "");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: openaiModel, messages, temperature, max_tokens: maxTokens }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (isProviderBillingLike(res.status, errText)) throw new Error("PROVIDER_BILLING_ERROR");
      throw new Error(`OpenAI API error (${res.status})`);
    }
    const data = await res.json();
    content = data.choices?.[0]?.message?.content ?? "";
    // OpenAI usage shape: usage.{prompt_tokens, completion_tokens, total_tokens}
    const usage = data.usage as
      | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      | undefined;
    if (usage) {
      if (typeof usage.prompt_tokens === "number") tokensIn = usage.prompt_tokens;
      if (typeof usage.completion_tokens === "number") tokensOut = usage.completion_tokens;
      if (typeof usage.total_tokens === "number") tokensTotal = usage.total_tokens;
    }
  } else {
    throw new Error(`Unsupported model: ${model}`);
  }

  const providerMeta: Record<string, unknown> = { model };
  if (tokensIn !== null) providerMeta.tokens_in = tokensIn;
  if (tokensOut !== null) providerMeta.tokens_out = tokensOut;
  if (tokensTotal !== null) providerMeta.tokens_total = tokensTotal;

  return {
    result_url: content,
    outputs: { output_text: content },
    output_type: "text",
    provider_meta: providerMeta,
  };
}
