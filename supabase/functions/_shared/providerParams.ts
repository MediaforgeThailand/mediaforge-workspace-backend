/// <reference lib="deno.ns" />

import { isNonRetryableQuotaError } from "./providerRetry.ts";

function optionalBoolParam(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === false) return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function audioPreferenceParam(
  params: Record<string, unknown>,
  defaultValue = false,
): boolean {
  const generateAudio = optionalBoolParam(params.generate_audio);
  if (generateAudio !== undefined) return generateAudio;
  const hasAudio = optionalBoolParam(params.has_audio);
  if (hasAudio !== undefined) return hasAudio;
  const replicateGenerateAudio = optionalBoolParam(params.replicate_generate_audio);
  if (replicateGenerateAudio !== undefined) return replicateGenerateAudio;
  return defaultValue;
}

export function enforcePrimaryProviderParams(provider: string, params?: Record<string, unknown>): void {
  if (!params) return;
  if (provider === "veo") {
    // Google Veo 3.1 direct always returns audio and has no no-audio
    // request parameter. Preserve the user's explicit audio preference so
    // capability/quota fallback providers that do support silent output can
    // honor it instead of being forced into the expensive audio tier.
    delete params.replicate_generate_audio;
  }
}

export function shouldGenerateFallbackVeoAudio(params: Record<string, unknown>): boolean {
  const envValue = String(Deno.env.get("REPLICATE_VEO_GENERATE_AUDIO") ?? "").trim().toLowerCase();
  if (envValue === "1" || envValue === "true" || envValue === "yes" || envValue === "on" || envValue === "force") {
    return true;
  }
  if (envValue === "0" || envValue === "false" || envValue === "no" || envValue === "off" || envValue === "never") {
    return false;
  }
  return audioPreferenceParam(params, false);
}

export function canUseGemini2Veo(): boolean {
  return Boolean(Deno.env.get("GEMINI2_API_KEY"));
}

export function shouldFallbackVeoQuota(errMsg: string): boolean {
  return (
    isNonRetryableQuotaError(errMsg) ||
    /HTTP 429|RESOURCE_EXHAUSTED|exceeded your current quota|rate-limits|ai\.dev\/rate-limit/i.test(errMsg)
  );
}

/** Coerce `params[key]` to a number clamped to [min,max]; falls back
 *  to `def` for anything that isn't a finite number in range. Used by
 *  TTS executors to keep slider knobs within each provider's documented
 *  bounds (e.g. ElevenLabs stability 0–1, Google speakingRate 0.25–2.0). */
export function clampNum(
  raw: unknown,
  min: number,
  max: number,
  def: number,
): number {
  const n =
    typeof raw === "number" ? raw : raw === undefined || raw === null || raw === "" ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
