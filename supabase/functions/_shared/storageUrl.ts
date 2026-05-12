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
