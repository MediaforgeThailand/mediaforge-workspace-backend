/// <reference lib="deno.ns" />
/// <reference lib="dom" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ProviderResult } from "./providerResult.ts";
import { extractProviderMediaUrl } from "./imageUtils.ts";
import { MAGNIFIC_BASE, loadMagnificApiKey } from "./magnific.ts";
import {
  WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS,
  workspaceAiMediaPipelinePath,
} from "./storageUrl.ts";

/**
 * executeRemoveBg — calls Freepik's Remove Background endpoint (Magnific API).
 *
 * Swap-in for the legacy Replicate BiRefNet path (kept below as
 * `executeRemoveBgReplicate_legacy` for fast rollback if Freepik QA fails).
 *
 * Reuses the same FREEPIK_API_KEY / MAGNIFIC_API_KEY env vars as our other
 * Freepik integrations (loadMagnificApiKey).
 *
 * Endpoint: POST {MAGNIFIC_BASE}/ai/beta/remove-background
 *   - Auth header: x-freepik-api-key (or x-magnific-api-key for magnific.com)
 *   - Body: application/x-www-form-urlencoded { image_url: <public-image-url> }
 *   - Response: { high_resolution, preview, original, url }.
 *     Keep defensive extraction because old Freepik responses wrapped fields
 *     under `data`.
 */
export async function executeRemoveBg(
  params: Record<string, unknown>,
  supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  userId?: string | null,
): Promise<ProviderResult> {
  const imageUrl = String(params.image_url ?? "");
  if (!imageUrl) {
    throw new Error("Remove Background requires an image input.");
  }
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Remove Background service credentials are not configured.");
  }

  const apiKey = loadMagnificApiKey();
  const endpoint = `${MAGNIFIC_BASE}/ai/beta/remove-background`;
  const endpointHost = new URL(endpoint).hostname;
  const authHeaderName = endpointHost.includes("magnific.com")
    ? "x-magnific-api-key"
    : "x-freepik-api-key";

  console.log(`[remove-bg-pipeline] Calling Freepik remove-background (${endpoint})`);

  // Freepik remove-background expects a public image URL in form data.
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      [authHeaderName]: apiKey,
    },
    body: new URLSearchParams({ image_url: imageUrl }),
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 402 || /billing|payment|insufficient|quota/i.test(text)) {
      throw new Error("PROVIDER_BILLING_ERROR");
    }
    throw new Error(
      `Freepik remove-background failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(
      `Freepik remove-background returned non-JSON: ${text.slice(0, 200)}`,
    );
  }

  const data = parsed.data && typeof parsed.data === "object"
    ? (parsed.data as Record<string, unknown>)
    : parsed;

  // Try common Freepik/Magnific response shapes:
  //   1) { high_resolution|url: "https://..." }      (current docs)
  //   2) { data: { high_resolution|url: "..." } }    (legacy wrapper)
  //   3) { data: { base64: <base64> } }              (alt sync)
  //   4) deep search via extractProviderMediaUrl     (URL anywhere)
  const directUrl = extractProviderMediaUrl(data);
  const candidateB64 = String(
    (data.high_resolution as string | undefined) ??
      (data.base64 as string | undefined) ??
      (data.image as string | undefined) ??
      "",
  );

  let publicUrl = directUrl;
  let storagePath: string | null = null;

  // If we got base64, upload it to ai-media and return a signed URL.
  if (!publicUrl && candidateB64) {
    try {
      const cleaned = candidateB64.replace(/^data:image\/\w+;base64,/, "");
      const bin = atob(cleaned);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const supabase = createClient(supabaseUrl, serviceRoleKey);
      const fileName = workspaceAiMediaPipelinePath(
        userId,
        `mediaforge_nobg_${Date.now()}.png`,
      );
      const { error: uploadError } = await supabase.storage
        .from("ai-media")
        .upload(fileName, bytes, { contentType: "image/png", upsert: true });
      if (!uploadError) {
        storagePath = fileName;
        const { data: urlData, error: signError } = await supabase.storage
          .from("ai-media")
          .createSignedUrl(fileName, WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS);
        if (!signError && urlData?.signedUrl) {
          publicUrl = urlData.signedUrl;
        } else {
          const { data: pubData } = supabase.storage
            .from("ai-media")
            .getPublicUrl(fileName);
          publicUrl = pubData.publicUrl;
        }
      } else {
        console.error("[remove-bg-pipeline] Upload error:", uploadError);
      }
    } catch (err) {
      console.error("[remove-bg-pipeline] base64 decode/upload failed:", err);
    }
  }

  if (!publicUrl) {
    throw new Error(
      "Freepik remove-background returned no usable image URL or base64",
    );
  }

  return {
    result_url: publicUrl,
    outputs: { output_image: publicUrl },
    output_type: "image_url" as const,
    provider_meta: {
      provider: "freepik",
      model: "freepik-remove-bg",
      endpoint,
      ...(storagePath
        ? {
            storage_bucket: "ai-media",
            storage_path: storagePath,
            signed_url_ttl_seconds: WORKSPACE_STORAGE_SIGNED_URL_TTL_SECONDS,
          }
        : {}),
    },
  };
}
