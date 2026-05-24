/// <reference lib="deno.ns" />
/// <reference lib="dom" />

export function parseSupabaseStorageUrl(
  rawUrl: string,
  supabaseUrl: string,
): { bucket: string; path: string } | null {
  try {
    const url = new URL(rawUrl);
    const expectedHost = new URL(supabaseUrl).hostname;
    if (url.hostname !== expectedHost) return null;
    const match = url.pathname.match(
      /^\/storage\/v1\/object\/(?:sign|public)\/([^/]+)\/(.+)$/,
    );
    if (!match) return null;
    const bucket = decodeURIComponent(match[1]);
    const path = decodeURIComponent(match[2]);
    if (!bucket || !path || path.split("/").some((part) => part === "..")) {
      return null;
    }
    return { bucket, path };
  } catch {
    return null;
  }
}

function isInternalSupabaseHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "kong" ||
    h === "supabase_kong" ||
    h.startsWith("supabase_kong_") ||
    h.endsWith("_kong") ||
    h.endsWith(".internal")
  );
}

export function publicizeSupabaseStorageUrl(
  rawUrl: string,
  options: {
    internalSupabaseUrl?: string | null;
    publicSupabaseUrl?: string | null;
  },
): string {
  const publicBase = String(options.publicSupabaseUrl ?? "").trim();
  if (!publicBase) return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (!url.pathname.startsWith("/storage/v1/")) return rawUrl;

    const publicUrl = new URL(publicBase);
    const internalHost = options.internalSupabaseUrl
      ? new URL(options.internalSupabaseUrl).host.toLowerCase()
      : "";
    const shouldRewrite =
      url.host.toLowerCase() === internalHost ||
      isInternalSupabaseHost(url.hostname);

    if (!shouldRewrite) return rawUrl;

    url.protocol = publicUrl.protocol;
    url.host = publicUrl.host;
    return url.toString();
  } catch {
    return rawUrl;
  }
}
