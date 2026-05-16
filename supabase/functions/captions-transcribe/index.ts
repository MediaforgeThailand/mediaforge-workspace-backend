/**
 * captions-transcribe edge function
 *
 * Proxies OpenAI speech-to-text for caption / subtitle generation.
 * The primary transcript comes from gpt-4o-transcribe for better language
 * accuracy. Whisper is still queried for verbose word/segment timestamps,
 * because the newer transcription models do not provide word timestamps.
 * For Thai and other spaceless scripts, the client uses the GPT transcript
 * as text and Whisper timing only as rough alignment.
 *
 * Auth: requires a valid Supabase user JWT.
 * Secrets: OPENAI_API_KEY must be set via `supabase secrets set`.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getAuthUser, unauthorized } from "../_shared/auth.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const TRANSCRIPT_MODEL = Deno.env.get("CAPTIONS_TRANSCRIBE_MODEL")?.trim() ||
  "gpt-4o-transcribe";
const TIMING_MODEL = "whisper-1";
const NORMALIZE_MODEL = Deno.env.get("CAPTIONS_NORMALIZE_MODEL")?.trim() ||
  "gpt-5";
const NORMALIZE_WITH_GPT =
  (Deno.env.get("CAPTIONS_NORMALIZE_WITH_GPT") ?? "true").toLowerCase() !==
    "false";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = {
  "Content-Type": "application/json",
  ...corsHeaders,
};

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens?: number[];
  temperature?: number;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
}

interface WhisperVerboseResponse {
  task?: string;
  language?: string;
  duration?: number;
  text?: string;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
}

interface OpenAITranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: WhisperWord[];
  segments?: WhisperSegment[];
}

interface TranscriptNormalizerResult {
  text: string;
  cues?: string[];
}

type SegmentationMode = "sentence" | "words";

class OpenAIHttpError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "OpenAIHttpError";
    this.status = status;
    this.details = details;
  }
}

function normalizeSpace(value?: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function textLooksLikeSpacelessScript(value?: string | null): boolean {
  return /[\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(
    value ?? "",
  );
}

function languageLooksLikeSpacelessScript(value?: string | null): boolean {
  const key = normalizeSpace(value).toLowerCase().replace(/_/g, "-");
  return (
    key === "th" ||
    key === "tha" ||
    key === "thai" ||
    key.startsWith("th-") ||
    key === "ja" ||
    key.startsWith("ja-") ||
    key === "zh" ||
    key.startsWith("zh-") ||
    key === "ko" ||
    key.startsWith("ko-")
  );
}

function textLooksThai(value?: string | null): boolean {
  return /[\u0E00-\u0E7F]/.test(value ?? "");
}

function languageLooksThai(value?: string | null): boolean {
  const key = normalizeSpace(value).toLowerCase().replace(/_/g, "-");
  return (
    key === "th" ||
    key === "tha" ||
    key === "thai" ||
    key.startsWith("th-")
  );
}

async function parseOpenAIError(resp: Response): Promise<unknown> {
  const errorText = await resp.text();
  try {
    return JSON.parse(errorText);
  } catch {
    return errorText;
  }
}

function errorDetailText(details: unknown): string {
  if (typeof details === "string") return details.slice(0, 500);
  const maybe = details as { error?: { message?: string }; message?: string };
  return (
    maybe?.error?.message ??
    maybe?.message ??
    JSON.stringify(details).slice(0, 500)
  );
}

async function callOpenAITranscription({
  audio,
  filename,
  model,
  responseFormat,
  language,
  prompt,
  includeWordTimestamps,
}: {
  audio: File;
  filename: string;
  model: string;
  responseFormat: "json" | "verbose_json";
  language: string;
  prompt: string | null;
  includeWordTimestamps: boolean;
}): Promise<OpenAITranscriptionResponse> {
  const openaiForm = new FormData();
  openaiForm.append("file", audio, filename);
  openaiForm.append("model", model);
  openaiForm.append("response_format", responseFormat);
  if (includeWordTimestamps) {
    openaiForm.append("timestamp_granularities[]", "word");
  }
  if (language && language !== "auto") {
    openaiForm.append("language", language);
  }
  if (prompt) {
    openaiForm.append("prompt", prompt);
  }

  let resp: Response;
  try {
    resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: openaiForm,
    });
  } catch (err) {
    throw new Error(`OpenAI request failed: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    const details = await parseOpenAIError(resp);
    throw new OpenAIHttpError(
      `OpenAI transcription API error (HTTP ${resp.status}): ${
        errorDetailText(details)
      }`,
      resp.status,
      details,
    );
  }

  try {
    return await resp.json();
  } catch (err) {
    throw new Error(
      `Failed to parse OpenAI transcription response: ${(err as Error).message}`,
    );
  }
}

function extractOpenAIResponseText(data: unknown): string {
  const response = data as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };

  if (typeof response.output_text === "string") return response.output_text;

  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("");
}

function parseNormalizerResult(raw: string): TranscriptNormalizerResult | null {
  const text = raw.trim();
  if (!text) return null;
  const jsonText = (() => {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced?.[1]) return fenced[1].trim();
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) return text.slice(first, last + 1);
    return text;
  })();

  try {
    const parsed = JSON.parse(jsonText) as { text?: unknown; cues?: unknown };
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      const cues = Array.isArray(parsed.cues)
        ? parsed.cues
          .filter((cue): cue is string => typeof cue === "string")
          .map((cue) => normalizeSpace(cue))
          .filter(Boolean)
          .slice(0, 120)
        : undefined;
      return { text: normalizeSpace(parsed.text), cues };
    }
  } catch {
    // Keep fallback below.
  }
  return { text: normalizeSpace(text) };
}

function comparableTranscriptText(value?: string | null): string {
  return normalizeSpace(value)
    .toLowerCase()
    .replace(/[\s"'`.,;:!?…。，、！？()[\]{}<>|\/\\\-–—_*+=~@#$%^&]+/g, "");
}

function extractAsciiTerms(value?: string | null): string[] {
  const terms = new Set<string>();
  const matches = (value ?? "").match(/[A-Za-z][A-Za-z0-9+._-]*/g) ?? [];
  for (const match of matches) {
    const normalized = comparableTranscriptText(match);
    if (normalized.length >= 2) terms.add(normalized);
  }
  return Array.from(terms);
}

function extractAsciiPromptTerms(value?: string | null): string[] {
  const terms = new Map<string, string>();
  const matches = (value ?? "").match(/[A-Za-z][A-Za-z0-9+._-]*/g) ?? [];
  for (const match of matches) {
    const normalized = comparableTranscriptText(match);
    if (normalized.length >= 2 && !terms.has(normalized)) {
      terms.set(normalized, match);
    }
  }
  return Array.from(terms.values());
}

function normalizerPreservesTranscript(
  result: TranscriptNormalizerResult,
  sourceText: string,
): boolean {
  const sourceComparable = comparableTranscriptText(sourceText);
  if (!sourceComparable) return true;

  const resultComparable = comparableTranscriptText(result.text);
  if (!resultComparable) return false;

  if (
    sourceComparable.length >= 24 &&
    resultComparable.length < sourceComparable.length * 0.72
  ) {
    return false;
  }

  const resultSurface = comparableTranscriptText(
    [result.text, ...(result.cues ?? [])].join(" "),
  );
  const missingAsciiTerm = extractAsciiTerms(sourceText).some((term) =>
    !resultSurface.includes(term)
  );
  return !missingAsciiTerm;
}

async function normalizeTranscriptWithGPT({
  text,
  language,
  requestedLanguage,
  prompt,
  segmentationMode,
}: {
  text: string;
  language?: string;
  requestedLanguage: string;
  prompt: string | null;
  segmentationMode: SegmentationMode;
}): Promise<TranscriptNormalizerResult | null> {
  if (!OPENAI_KEY || !NORMALIZE_WITH_GPT || !normalizeSpace(text)) return null;
  if (
    !textLooksLikeSpacelessScript(text) &&
    !languageLooksLikeSpacelessScript(language) &&
    !languageLooksLikeSpacelessScript(requestedLanguage)
  ) {
    return null;
  }

  const cueInstructions = segmentationMode === "sentence"
    ? [
      "Create cues by natural sentence, phrase, and speech-pause boundaries.",
      "Do not force a fixed word count, but avoid long paragraph cues.",
      "Prefer short spoken phrases that can fit on one subtitle line.",
      "Split when there is a natural pause, punctuation, completed clause, or a phrase becomes too long for one line.",
    ]
    : [
      "Each cue should be short, usually 2-4 natural words or one short phrase.",
      "Use the requested word-grouping style while keeping each cue readable.",
    ];

  const asciiPromptTerms = extractAsciiPromptTerms(text).slice(0, 24);
  const preserveTermInstructions = asciiPromptTerms.length
    ? [
      `Detected English/code-switch terms to preserve exactly: ${
        asciiPromptTerms.join(", ")
      }.`,
      "Keep those terms inside the natural spoken phrase. Do not make a detected term a standalone cue unless the speaker clearly said it as a standalone utterance.",
    ]
    : [];

  const thaiContextInstructions =
    textLooksThai(text) || languageLooksThai(language) ||
      languageLooksThai(requestedLanguage)
      ? [
        "Thai subtitle context: Thai speech often code-switches with English loanwords. Treat English loanwords as part of the Thai phrase around them.",
        "When an English term starts a Thai clause, keep it with the following Thai predicate, for example \"AI ก็จะถ่ายทอด\" instead of splitting \"AI\" and \"ก็จะถ่ายทอด\".",
        "Do not create standalone cues from Thai particles, auxiliaries, or connectors such as ก็, จะ, ได้, ให้, และ, ของ, จาก, ใน, ที่, เป็น.",
        "Keep Thai meaning units together: subject with predicate, verb phrase with object, and modifier phrase with the noun or action it modifies.",
        "For a phrase like \"AI ก็จะถ่ายทอดท่าทาง จังหวะ และแอ็กชั่น\", prefer cues like [\"AI ก็จะถ่ายทอด\", \"ท่าทาง จังหวะ และแอ็กชั่น\"], not [\"AI\", \"ก็จะถ่ายทอด\", \"ท่าทาง\"].",
      ]
      : [];

  const instructions = [
    "You are a subtitle transcript normalizer for MediaForge Auto Subtitle.",
    "Return strict JSON only: {\"text\":\"...\",\"cues\":[\"...\"]}.",
    "Do not translate. Keep the original spoken language and code-switching.",
    "Fix obvious ASR mistakes, spacing, punctuation, and Thai spelling.",
    "Preserve brand/product terms such as Motion Control, AI, MediaForge, and Workspace.",
    "Every English/code-switched ASCII token from the transcript must remain in the normalized text and one cue. Do not transliterate or omit these tokens.",
    "Create subtitle cues as single-line readable chunks in spoken order.",
    ...preserveTermInstructions,
    ...thaiContextInstructions,
    ...cueInstructions,
    "Do not split Thai compound words, loanwords, product names, or English terms across cues.",
    "Do not add explanations, speaker labels, timestamps, markdown, or extra fields.",
  ].join(" ");

  const userContent = [
    `Detected language: ${language ?? "unknown"}`,
    `Requested language: ${requestedLanguage || "auto"}`,
    `Subtitle segmentation: ${segmentationMode}`,
    prompt ? `User prompt/context: ${prompt}` : "",
    "Transcript:",
    text,
  ].filter(Boolean).join("\n");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NORMALIZE_MODEL,
      instructions,
      input: [{ role: "user", content: userContent }],
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      store: false,
    }),
  });

  if (!resp.ok) {
    const details = await parseOpenAIError(resp);
    throw new OpenAIHttpError(
      `OpenAI transcript normalizer error (HTTP ${resp.status}): ${
        errorDetailText(details)
      }`,
      resp.status,
      details,
    );
  }

  const data = await resp.json();
  return parseNormalizerResult(extractOpenAIResponseText(data));
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  // Verify caller JWT (verify_jwt=true at the gateway also enforces this,
  // but we double-check so the caller's identity is available for logging).
  const user = await getAuthUser(req);
  if (!user) return unauthorized();

  if (!OPENAI_KEY) {
    return new Response(
      JSON.stringify({
        error: "Captions transcription is not configured (missing OPENAI_API_KEY)",
      }),
      { status: 500, headers: jsonHeaders },
    );
  }

  // Parse the multipart form. OpenAI's transcription endpoints accept audio
  // up to 25 MB, so reject anything bigger up front.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Invalid form data: ${(err as Error).message}` }),
      { status: 400, headers: jsonHeaders },
    );
  }

  const audio = formData.get("audio") as File | null;
  if (!audio) {
    return new Response(JSON.stringify({ error: "Missing audio file" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  // 25 MB is OpenAI Whisper's hard cap.
  const MAX_SIZE = 25 * 1024 * 1024;
  if (audio.size > MAX_SIZE) {
    return new Response(
      JSON.stringify({
        error: `Audio too large (${(audio.size / 1024 / 1024).toFixed(1)}MB). OpenAI transcription accepts up to 25MB.`,
      }),
      { status: 413, headers: jsonHeaders },
    );
  }

  const language = (formData.get("language") as string | null) || "auto";
  const prompt = formData.get("prompt") as string | null;
  // Word-level timestamps are the whole point — always request them but allow
  // the caller to disable via `granularity=segment` if they don't want them.
  const granularity = (formData.get("granularity") as string | null) || "word";
  const rawSegmentationMode = (formData.get("segmentation_mode") as string | null) || "sentence";
  const segmentationMode: SegmentationMode =
    rawSegmentationMode === "words" ? "words" : "sentence";

  const filename = audio.name || "audio.wav";
  const startedAt = Date.now();
  const [transcriptResult, timingResult] = await Promise.allSettled([
    callOpenAITranscription({
      audio,
      filename,
      model: TRANSCRIPT_MODEL,
      responseFormat: "json",
      language,
      prompt,
      includeWordTimestamps: false,
    }),
    callOpenAITranscription({
      audio,
      filename,
      model: TIMING_MODEL,
      responseFormat: "verbose_json",
      language,
      prompt,
      includeWordTimestamps: granularity === "word",
    }),
  ]);

  const transcriptData =
    transcriptResult.status === "fulfilled" ? transcriptResult.value : null;
  const timingData =
    timingResult.status === "fulfilled"
      ? (timingResult.value as WhisperVerboseResponse)
      : null;

  if (!transcriptData && !timingData) {
    const reason =
      transcriptResult.status === "rejected"
        ? transcriptResult.reason
        : timingResult.status === "rejected"
          ? timingResult.reason
          : null;
    const status = reason instanceof OpenAIHttpError ? reason.status : 502;
    return new Response(
      JSON.stringify({
        error: "OpenAI transcription failed",
        status,
        details:
          reason instanceof Error
            ? reason.message
            : "Both transcript and timing transcription calls failed",
      }),
      { status, headers: jsonHeaders },
    );
  }

  if (transcriptResult.status === "rejected") {
    console.warn(
      `[captions-transcribe] ${TRANSCRIPT_MODEL} failed; falling back to ${TIMING_MODEL}: ${
        transcriptResult.reason instanceof Error
          ? transcriptResult.reason.message
          : String(transcriptResult.reason)
      }`,
    );
  }
  if (timingResult.status === "rejected") {
    console.warn(
      `[captions-transcribe] ${TIMING_MODEL} timing failed; returning transcript only: ${
        timingResult.reason instanceof Error
          ? timingResult.reason.message
          : String(timingResult.reason)
      }`,
    );
  }

  const transcriptText = normalizeSpace(transcriptData?.text ?? timingData?.text);
  let normalizedResult: TranscriptNormalizerResult | null = null;
  if (transcriptText) {
    try {
      normalizedResult = await normalizeTranscriptWithGPT({
        text: transcriptText,
        language: timingData?.language ?? transcriptData?.language,
        requestedLanguage: language,
        prompt,
        segmentationMode,
      });
    } catch (err) {
      console.warn(
        `[captions-transcribe] ${NORMALIZE_MODEL} normalizer failed; using raw transcript: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (normalizedResult && !normalizerPreservesTranscript(normalizedResult, transcriptText)) {
      console.warn(
        `[captions-transcribe] ${NORMALIZE_MODEL} normalizer dropped transcript content; using raw transcript`,
      );
      normalizedResult = null;
    }
  }

  const finalText = normalizedResult?.text ?? transcriptText;
  const finalLanguage =
    timingData?.language ?? transcriptData?.language ??
    (language !== "auto" ? language : undefined);

  const elapsed = Date.now() - startedAt;
  console.log(
    `[captions-transcribe] user=${user.id} transcript_model=${transcriptData ? TRANSCRIPT_MODEL : "failed"} timing_model=${timingData ? TIMING_MODEL : "failed"} normalizer=${normalizedResult ? NORMALIZE_MODEL : "skipped"} segmentation=${segmentationMode} cues=${normalizedResult?.cues?.length ?? 0} duration=${timingData?.duration ?? transcriptData?.duration ?? 0}s lang=${finalLanguage ?? "?"} words=${timingData?.words?.length ?? 0} elapsed=${elapsed}ms`,
  );

  return new Response(
    JSON.stringify({
      words: timingData?.words ?? [],
      segments: timingData?.segments ?? [],
      language: finalLanguage,
      text: finalText,
      duration: timingData?.duration ?? transcriptData?.duration,
      suggested_cues: normalizedResult?.cues ?? null,
      segmentation_mode: segmentationMode,
      transcript_model: transcriptData ? TRANSCRIPT_MODEL : null,
      timing_model: timingData ? TIMING_MODEL : null,
      normalizer_model: normalizedResult ? NORMALIZE_MODEL : null,
    }),
    { headers: jsonHeaders },
  );
});
