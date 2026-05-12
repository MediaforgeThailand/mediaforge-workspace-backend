/// <reference lib="deno.ns" />
/// <reference lib="dom" />

export function isProviderBillingLike(status: number, text: string): boolean {
  // 429 ALWAYS stays transient — even when the body claims "exceeded your
  // current quota" or "check your plan and billing details". Google's
  // well-documented "ghost 429" / "free_tier_requests Limit 0" bugs return
  // billing-flavoured bodies on Tier-1 paid keys (esp. for the Pro image
  // models like gemini-3-pro-image-preview), and refunding the user
  // permanently for a Google-side glitch is wrong. The durable queue will
  // retry on its normal backoff; if it really IS exhausted the queue's
  // dead-letter budget will eventually catch it.
  if (status === 429) return false;
  // 402 Payment Required is the only HTTP code Google + most providers use
  // for genuine billing exhaustion.
  if (status === 402) return true;
  // Body-keyword fallback for providers that don't use 402 (Kling, Replicate,
  // Shotstack, etc.). Keep this list TIGHT — generic words like "billing" or
  // "quota exceeded" can appear in transient errors too. Only match phrases
  // that unambiguously mean "the account ran out of credit".
  return /account balance not enough|insufficient balance|payment required|prepaid|top[ -]?up/i.test(text);
}

export function summarizeProviderErrorBody(text: string, limit = 700): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const error = parsed.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === "string" ? error.message : "";
    const status = typeof error?.status === "string" ? error.status : "";
    const code = typeof error?.code === "number" || typeof error?.code === "string"
      ? String(error.code)
      : "";
    const detail = [code ? `code ${code}` : "", status, message]
      .filter(Boolean)
      .join(" ");
    if (detail) return detail.slice(0, limit);
  } catch {
    // Fall through to plain-text/html cleanup.
  }
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function summarizeProviderErrorText(raw: string, maxLength = 500): string {
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const source = title ?? raw;
  return source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export async function fetchWithAttemptTimeout(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: init.signal ?? aborter.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
