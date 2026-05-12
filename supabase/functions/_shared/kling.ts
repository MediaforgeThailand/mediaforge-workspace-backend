/// <reference lib="deno.ns" />
/// <reference lib="dom" />

export const KLING_MODEL_MAP: Record<string, { model: string; mode: string; isMotion?: boolean; isOmni?: boolean }> = {
  "kling-v1-pro":             { model: "kling-v1",          mode: "pro" },
  "kling-v1-5-pro":           { model: "kling-v1-5",        mode: "pro" },
  "kling-v1-6-pro":           { model: "kling-v1-6",        mode: "pro" },
  "kling-v2-master":          { model: "kling-v2-master",    mode: "pro" },
  "kling-v2-1-pro":           { model: "kling-v2-1",        mode: "pro" },
  "kling-v2-1-master":        { model: "kling-v2-1-master",  mode: "pro" },
  "kling-v2-5-turbo":         { model: "kling-v2-5-turbo",  mode: "pro" },
  "kling-v2-6-pro":           { model: "kling-v2-6",        mode: "pro" },
  "kling-v2-6-motion-pro":    { model: "kling-v2-6",        mode: "pro", isMotion: true },
  "kling-v3-pro":             { model: "kling-v3",          mode: "pro" },
  "kling-v3-motion-pro":      { model: "kling-v3",          mode: "pro", isMotion: true },

  "kling-v3-omni":            { model: "kling-v3-omni",     mode: "pro", isOmni: true },
};

/**
 * Format a Kling API error body into a user-friendly message.
 *
 * Kling validation failures arrive as JSON like:
 *   { code: 1201, message: "prompt: size must be between 0 and 2500", request_id: "..." }
 * Surfacing the raw payload (with JSON braces and request_id) in the
 * UI toast makes the error unreadable. Map known codes to clean
 * messages and otherwise extract `message` from the JSON when present.
 *
 * Code 1201 = prompt-size violation. We DO want this to reach the
 * client (it's an actionable user error, not a transient provider
 * fault), so do NOT classify it as PROVIDER_BILLING_ERROR.
 */
export function formatKlingApiError(label: string, status: number, errText: string): string {
  try {
    const parsed = JSON.parse(errText) as { code?: number; message?: string };
    if (typeof parsed?.message === "string" && parsed.message) {
      const base = `${label} (HTTP ${status}): ${parsed.message}`;
      // Code 1201 is Kling's generic "request parameter error" — it covers
      // mode/model mismatches, missing fields, and prompt-length issues
      // alike. Only append the prompt-shortening hint when the message
      // actually looks length-related; otherwise it misleads users with
      // 100-character prompts who hit a different parameter problem.
      const looksLengthRelated = /character|length|too long|exceed|2500/i.test(parsed.message);
      if (parsed.code === 1201 && looksLengthRelated) {
        return `${base} (Kling caps prompts at 2500 characters — try shortening.)`;
      }
      return base;
    }
  } catch {
    // not JSON — fall through to the raw substring fallback
  }
  return `${label} (HTTP ${status}): ${errText.substring(0, 200)}`;
}

export async function generateKlingJWT(accessKeyId: string, secretKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKeyId, exp: now + 1800, nbf: now - 5, iat: now };
  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signingInput}.${sigB64}`;
}
