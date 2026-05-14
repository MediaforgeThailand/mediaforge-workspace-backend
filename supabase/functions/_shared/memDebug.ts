/// <reference lib="deno.ns" />
/**
 * Throwaway memory instrumentation for the stream-all-mirror-uploads PR.
 *
 * `snapMem(label)` logs a `Deno.memoryUsage()` snapshot tagged with a
 * caller-provided label. Wrap a mirror call site with a BEFORE call
 * right before `fetch(url)` and an AFTER call right after the storage
 * upload — the diff of the `external` field shows whether streaming
 * is working. With streaming, the delta is ~0 regardless of file size;
 * a regression to `new Uint8Array(await res.arrayBuffer())` will show
 * a delta roughly equal to the downloaded payload size.
 *
 * Logs use the `[mem-debug]` prefix so they're trivial to grep + strip
 * before this branch merges. Try/catch around `Deno.memoryUsage()` so
 * a missing global (e.g. inside vitest) never breaks the actual code
 * path.
 */

export function snapMem(label: string): void {
  try {
    const m = Deno.memoryUsage();
    const fmt = (n: number) => (n / 1024 / 1024).toFixed(2);
    console.log(
      `[mem-debug] ${label} external=${fmt(m.external)}MB heap=${fmt(m.heapUsed)}MB rss=${fmt(m.rss)}MB`,
    );
  } catch {
    /* Deno.memoryUsage unavailable in this runtime — skip silently */
  }
}
