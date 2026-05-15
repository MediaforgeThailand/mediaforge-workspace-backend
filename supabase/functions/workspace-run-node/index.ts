/// <reference lib="deno.ns" />
/// <reference lib="dom" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  applyModelDiscountToCredits,
  fetchFeatureMultipliers,
  lookupBaseCost,
  lookupModelDiscountPercent,
  PricingConfigError,
  refundCreditsAtomic,
  type FeatureMultipliers,
  type ProviderDef,
  type ProviderKey,
} from "../_shared/pricing.ts";
import {
  classifyError,
  classifyProviderError,
  shouldFastFallbackProviderError,
  TOTAL_MAX_RETRIES,
} from "../_shared/providerRetry.ts";
import { recordGenerationEvent } from "../_shared/analytics.ts";
import { acceptPendingOrgInviteForUser } from "../_shared/orgInvite.ts";
import { isPublicEmailDomain } from "../_shared/publicEmailDomains.ts";
import {
  SEEDANCE_BASE,
  SEEDANCE_TASKS_PATH,
  executeSeedance,
  humanizeSeedanceErrorMessage,
  loadSeedanceCredentials,
  pollSeedanceOnce,
} from "../_shared/seedance.ts";
import { executeSeedream } from "../_shared/seedream.ts";
import {
  HYPER3D_BASE,
  HYPER3D_TASKS_PATH,
  executeHyper3D,
  pickHyper3dModelUrl,
  pollHyper3dOnce,
} from "../_shared/hyper3d.ts";
import {
  extractVeoVideoUri,
  loadVeoApiKey,
  normalizeVeoOperationName,
  pollVeoOnce,
} from "../_shared/veo.ts";
import { extractImageDimensions, extractProviderMediaUrl } from "../_shared/imageUtils.ts";
import {
  canUseReplicate,
  loadMagnificApiKey,
} from "../_shared/magnific.ts";
import {
  enforcePrimaryProviderParams,
} from "../_shared/providerParams.ts";
import { executeKling, generateKlingJWT } from "../_shared/kling.ts";
import { appendMentionContext, rewriteMentionsInline, type MentionedAssetSrv } from "../_shared/mentions.ts";
import type { ProviderResult } from "../_shared/providerResult.ts";
import { executeMergeAudio } from "../_shared/mergeAudio.ts";
import { executeChatAi } from "../_shared/chatAi.ts";
import { executeTripo3D } from "../_shared/tripo3d.ts";
import { executeRemoveBg } from "../_shared/removeBg.ts";
import {
  executeMagnificUpscale,
  MAGNIFIC_UPSCALE_MODEL,
  MAGNIFIC_UPSCALE_PATH,
  MAGNIFIC_VIDEO_UPSCALE_PATH,
} from "../_shared/magnificUpscale.ts";
import { executeVideoToPrompt } from "../_shared/videoToPrompt.ts";
import { executeUrlAsset, validateUrlAssetParams } from "../_shared/urlAsset.ts";
import { executeGoogleTts } from "../_shared/googleTts.ts";
import { executeElevenLabsTts } from "../_shared/elevenLabsTts.ts";
import { executeGeminiTts } from "../_shared/geminiTts.ts";
import {
  executeElevenLabsDubbing,
  elevenLabsDubbingStatusCode,
  pollElevenLabsDubbing,
} from "../_shared/elevenLabsDubbing.ts";
import {
  executeReplicateImage,
  executeReplicateVeo,
  executeReplicateVideo,
  executeVeo,
  extractReplicateOutputUrl,
  REPLICATE_SEEDANCE_MODEL_SLUG,
  REPLICATE_VEO_MODEL_SLUG,
} from "../_shared/replicate.ts";
import { parseSupabaseStorageUrl } from "../_shared/storageUrl.ts";
import { executeBanana } from "../_shared/banana.ts";
import { executeOpenAIImage2 } from "../_shared/openAIImage.ts";
import {
  appendUniqueStringParam,
  normalizeHandleForModel,
  validateEdgeValue,
} from "./handleNormalization.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, x-workspace-worker-secret, x-workspace-worker-user-id, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ═══════════════════════════════════════════════════════════
   Provider Executors
   ═══════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════
   Generation-analytics recorder
   ───────────────────────────────────────────────────────────
   Helpers (classifyOutputTier, deriveAnalyticsFromRun,
   recordGenerationEvent) live in ../_shared/analytics.ts so the
   dispatcher source stays small enough to round-trip through the
   MCP deploy tool. The recordGenerationEvent call site is
   unchanged — see the post-execution block in serve().
   ═══════════════════════════════════════════════════════════ */



/* ═══════════════════════════════════════════════════════════
   WORKSPACE V2 ENTRY HANDLER
   ───────────────────────────────────────────────────────────
   Lifted from execute-pipeline-step. The legacy serve() at the
   bottom of the original file walked DB rows (pipeline_executions
   + pipeline_steps) and orchestrated multi-step pipelines with
   credit refund / retry queue. Workspace V2 is a sandbox: every
   Run is a single, stateless node call — no DB rows, no credit
   ledger, no retries. We re-use the per-provider executors above
   verbatim (executeBanana / executeKling / executeChatAi /
   executeRemoveBg / executeMergeAudio) so the model-side
   behaviour stays identical to the legacy editor.

   Request body shape (sent by the workspace frontend):
     {
       node_type:    "bananaProNode" | "imageGenNode" | "klingVideoNode"
                    | "videoGenNode" | "removeBackgroundNode"
                    | "mergeAudioNode" | "chatAiNode",
       params:       Record<string, unknown>,
       inputs:       Record<string, unknown>,
       mentioned_assets?: Array<{ label, nodeId, url, fieldType }>,
     }

   Response shape:
     { type, url, outputs, prompt_used, prompt_source, provider_meta }
     OR { error: string }
   ═══════════════════════════════════════════════════════════ */

/**
 * Resolve the provider from node_type AND the picked model.
 *
 * The unified `imageGenNode` / `videoGenNode` exposes models from
 * multiple providers in a single dropdown (e.g. nano-banana-* and
 * seedream-* both live under imageGenNode). So the dispatch must look
 * at `model_name` first, falling back to node_type for legacy keys.
 *
 * Provider keys must match HANDLE_SCHEMA above.
 */

function getProviderForNodeType(
  nodeType: string,
  modelName?: string,
): string {
  const m = String(modelName ?? "").toLowerCase();

  if (nodeType === "urlAssetNode") return "url_asset";

  if (nodeType === "bananaProNode" || nodeType === "imageGenNode") {
    if (m.startsWith("replicate-gpt-image") || m.startsWith("replicate-nano-banana")) return "replicate_image";
    if (m.startsWith("seedream")) return "seedream";
    if (m.startsWith("gpt-image") || m.startsWith("dall-e")) return "openai";
    return "banana";
  }
  if (nodeType === "klingVideoNode" || nodeType === "videoGenNode") {
    if (m.startsWith("replicate-veo")) return "replicate_veo";
    if (m.startsWith("replicate-kling")) return "replicate_video";
    if (m.startsWith("replicate-seedance")) return "replicate_video";
    if (m.startsWith("seedance") || m.startsWith("dreamina-seedance")) return "seedance";
    if (m.startsWith("veo-")) return "veo";
    return "kling";
  }
  if (nodeType === "seedDreamNode") return "seedream";
  if (nodeType === "seedDanceNode") return m.startsWith("replicate-seedance") ? "replicate_video" : "seedance";
  if (nodeType === "removeBackgroundNode") return "remove_bg";
  if (nodeType === "upscaleImageNode") {
    if (m.startsWith("gpt-image-2-enhance") || m === "gpt-image-2") return "openai";
    return "upscale_image";
  }
  if (nodeType === "mergeAudioNode") return "merge_audio";
  if (nodeType === "voiceTranslateNode") return "elevenlabs_dubbing";
  if (nodeType === "chatAiNode") return "chat_ai";
  if (nodeType === "videoToPromptNode") return "video_understanding";
  // 3D nodes: Hyper3D rides BytePlus ModelArk; Tripo3D is its own API.
  // Route by model slug so a single node type can serve both providers.
  if (nodeType === "imageTo3dNode") {
    if (m.startsWith("hyper3d")) return "hyper3d";
    return "tripo3d";
  }

  // Audio generation — provider chosen by model_name. Default to
  // google_tts (Studio / Neural2 / WaveNet); fall back to the legacy
  // gemini_tts proxy when the user picks a `gemini-2.5-*-tts` model;
  // route to ElevenLabs when the model slug starts with `elevenlabs-`
  // or matches one of the raw ElevenLabs model_ids
  // (`eleven_multilingual_v2`, `eleven_turbo_v2_5`, `eleven_flash_v2_5`).
  if (nodeType === "audioGenNode") {
    if (m.startsWith("gemini-")) return "gemini_tts";
    if (m.startsWith("elevenlabs-") || m.startsWith("eleven_")) return "elevenlabs_tts";
    return "google_tts";
  }

  throw new Error(`Workspace: no provider mapping for node_type "${nodeType}"`);
}

function workspaceProviderDef(
  nodeType: string,
  provider: string,
): ProviderDef {
  const p = provider as ProviderKey;
  const output: ProviderDef["output_type"] =
    p === "kling" || p === "seedance" || p === "veo" || p === "replicate_veo" || p === "replicate_video" || p === "merge_audio" || p === "elevenlabs_dubbing"
      ? "video_url"
      : p === "tripo3d" || p === "hyper3d"
        ? "model_3d"
      : p === "chat_ai" || p === "video_understanding"
        ? "text"
        : p === "google_tts" || p === "gemini_tts" ||
          p === "elevenlabs_tts" || p === "mp3_input"
          ? "audio_url"
          : "image_url";
  const feature =
    p === "openai" && nodeType === "upscaleImageNode" ? "upscale_image" :
    p === "url_asset" ? "url_to_asset" :
    p === "openai" ? "generate_openai_image" :
    p === "replicate_image" ? "generate_openai_image" :
    p === "seedream" ? "generate_seedream_image" :
    p === "banana" ? "generate_freepik_image" :
    p === "kling" || p === "seedance" || p === "veo" || p === "replicate_veo" || p === "replicate_video" ? "generate_freepik_video" :
    p === "remove_bg" ? "remove_background" :
    p === "upscale_image" ? "upscale_image" :
    p === "merge_audio" ? "merge_audio_video" :
    p === "elevenlabs_dubbing" ? "voice_translate" :
    p === "chat_ai" ? "chat_ai" :
    p === "tripo3d" || p === "hyper3d" ? "model_3d" :
    p === "google_tts" || p === "gemini_tts" || p === "elevenlabs_tts" ? "text_to_speech" :
    p === "video_understanding" ? "video_to_prompt" :
    nodeType;
  return {
    provider: p,
    feature,
    output_type: output,
    is_async: p === "kling" || p === "seedance" || p === "veo" || p === "replicate_veo" || p === "replicate_video" || p === "replicate_image" || p === "upscale_image" || p === "tripo3d" || p === "hyper3d" || p === "merge_audio" || p === "elevenlabs_dubbing",
  };
}

function shouldChargeWorkspaceProvider(provider: string): boolean {
  // Workspace-run-node owns charging for generation providers. Input/import
  // utilities do not call a paid AI provider.
  return provider !== "mp3_input" && provider !== "url_asset";
}

function workspaceMultiplierForProvider(
  def: ProviderDef,
  multipliers: FeatureMultipliers,
): number {
  switch (def.provider) {
    case "banana":
    case "openai":
    case "seedream":
    case "remove_bg":
    case "upscale_image":
    case "tripo3d":
    case "hyper3d":
      return multipliers.image;
    case "kling":
    case "seedance":
    case "veo":
    case "replicate_veo":
    case "replicate_video":
    case "merge_audio":
      return multipliers.video;
    case "replicate_image":
      return multipliers.image;
    case "chat_ai":
    case "video_understanding":
      return multipliers.chat;
    case "google_tts":
    case "gemini_tts":
    case "elevenlabs_tts":
    case "elevenlabs_dubbing":
    case "mp3_input":
      return multipliers.audio ?? multipliers.chat;
    case "url_asset":
      return 1;
    default:
      return multipliers.chat;
  }
}

function workspaceCreditFeature(def: ProviderDef, params: Record<string, unknown>): string {
  if (def.provider !== "replicate_image") return def.feature;
  const model = String(params.model_name ?? params.model ?? "").toLowerCase();
  return model.startsWith("replicate-gpt-image")
    ? "generate_openai_image"
    : "generate_freepik_image";
}

type WorkspaceCreditCharge = {
  amount: number;
  scope: "user" | "organization" | "team" | "education_space";
  teamId: string | null;
  organizationId: string | null;
  classId: string | null;
  creditUserId: string | null;
  referenceId: string;
  feature: string;
};

const DEFAULT_EDUCATION_BLOCKED_MODELS = [
  "seedance-2-0-lite",
  "seedance-2-0-pro",
  "dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0-fast-260128",
];

type WorkspaceCreditOwner =
  | {
      scope: "organization";
      organizationId: string;
      organizationName: string | null;
      poolDomain: string | null;
      email: string | null;
      organizationType?: string | null;
      classId?: string | null;
    }
  | {
      scope: "user";
      creditUserId: string;
      email: string | null;
      organizationId?: string | null;
      organizationName?: string | null;
      organizationType?: string | null;
      classId?: string | null;
      className?: string | null;
      classRole?: string | null;
    };

function normalizeWorkspaceDiscountPercent(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(100, Math.max(0, parsed));
}

function applyWorkspacePackageDiscount(amount: number, discountPercent: number): number {
  const fullAmount = Math.max(0, Math.ceil(Number(amount) || 0));
  const pct = normalizeWorkspaceDiscountPercent(discountPercent);
  if (fullAmount <= 0 || pct <= 0) return fullAmount;
  return Math.max(1, Math.floor(fullAmount * (100 - pct) / 100));
}

function workspacePackageDiscountForOwner(owner: WorkspaceCreditOwner): number {
  if (owner.scope !== "organization") return 0;
  const orgType = String(owner.organizationType ?? "").toLowerCase();
  return orgType === "enterprise" ? 20 : 0;
}

async function resolveTeamPackageDiscountPercent(
  supabase: ReturnType<typeof createClient>,
  teamId: string,
): Promise<number> {
  let teamPlanId: string | null = null;
  try {
    const { data } = await supabase
      .from("teams")
      .select("subscription_plan_id")
      .eq("id", teamId)
      .maybeSingle();
    teamPlanId = typeof (data as any)?.subscription_plan_id === "string"
      ? String((data as any).subscription_plan_id)
      : null;
  } catch {
    teamPlanId = null;
  }

  try {
    if (!teamPlanId) {
      const { data } = await supabase
        .from("subscription_plans")
        .select("id")
        .eq("target", "team")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      teamPlanId = typeof (data as any)?.id === "string" ? String((data as any).id) : null;
    }
    if (!teamPlanId) return 0;
    const { data } = await supabase
      .from("subscription_plans")
      .select("credit_discount_percent")
      .eq("id", teamPlanId)
      .maybeSingle();
    return normalizeWorkspaceDiscountPercent((data as any)?.credit_discount_percent);
  } catch (err) {
    console.warn(
      "[workspace-credits] team package discount lookup skipped:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

async function resolveEffectiveWorkspaceChargeAmount(args: {
  supabase: ReturnType<typeof createClient>;
  scope: "user" | "team";
  fallbackAmount: number;
  referenceId: string;
  userId: string;
  teamId?: string | null;
  workspaceId?: string | null;
  canvasId?: string | null;
}): Promise<number> {
  const fallbackAmount = Math.max(1, Math.ceil(Number(args.fallbackAmount) || 0));
  try {
    if (args.scope === "user") {
      const { data, error } = await args.supabase
        .from("credit_transactions")
        .select("amount,effective_amount,discount_percent")
        .eq("user_id", args.userId)
        .eq("reference_id", args.referenceId)
        .eq("type", "usage")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const effective = Number((data as any)?.effective_amount ?? (data as any)?.amount);
      return Number.isFinite(effective) && effective !== 0 ? Math.abs(Math.trunc(effective)) : fallbackAmount;
    }

    if (args.scope === "team" && args.teamId) {
      const packageDiscountPercent = await resolveTeamPackageDiscountPercent(args.supabase, args.teamId);
      if (packageDiscountPercent > 0) {
        return applyWorkspacePackageDiscount(fallbackAmount, packageDiscountPercent);
      }
      let query = args.supabase
        .from("team_credit_transactions")
        .select("amount,effective_amount,discount_percent")
        .eq("team_id", args.teamId)
        .eq("triggered_by", args.userId)
        .eq("reason", "node_run");
      query = args.workspaceId ? query.eq("workspace_id", args.workspaceId) : query.is("workspace_id", null);
      query = args.canvasId ? query.eq("canvas_id", args.canvasId) : query.is("canvas_id", null);
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const effective = Number((data as any)?.effective_amount ?? (data as any)?.amount);
      return Number.isFinite(effective) && effective !== 0 ? Math.abs(Math.trunc(effective)) : fallbackAmount;
    }
  } catch (err) {
    console.warn(
      "[workspace-credits] effective charge lookup skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return fallbackAmount;
}

async function resolveWorkspaceEducationCreditScope(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{
  organizationId: string;
  organizationName: string | null;
  organizationType: string | null;
  classId: string | null;
  className: string | null;
  classRole: string | null;
} | null> {
  try {
    const { data, error } = await supabase.rpc("workspace_education_credit_scope", {
      p_user_id: userId,
    });
    if (error) {
      if (!/function .*workspace_education_credit_scope/i.test(error.message)) {
        console.warn("[workspace-credits] education credit scope skipped:", error.message);
      }
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.organization_id) return null;
    return {
      organizationId: String(row.organization_id),
      organizationName: row.organization_name ? String(row.organization_name) : null,
      organizationType: row.organization_type ? String(row.organization_type) : null,
      classId: row.class_id ? String(row.class_id) : null,
      className: row.class_name ? String(row.class_name) : null,
      classRole: row.class_role ? String(row.class_role) : null,
    };
  } catch (err) {
    console.warn(
      "[workspace-credits] education credit scope unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function resolveWorkspaceCreditOwner(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  email?: string | null,
): Promise<WorkspaceCreditOwner> {
  let resolvedEmail = email ?? null;
  if (!resolvedEmail) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (!error) resolvedEmail = data.user?.email ?? null;
    } catch (err) {
      console.warn(
        "[workspace-credits] shared pool email lookup skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (resolvedEmail) {
    try {
      await acceptPendingOrgInviteForUser(
        supabase,
        { id: userId, email: resolvedEmail },
        "workspace_run_node",
      );
    } catch (err) {
      console.warn(
        "[workspace-credits] pending org invite accept skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  try {
    const { data, error } = await supabase.rpc("workspace_org_credit_scope", {
      p_user_id: userId,
    });
    if (error && !/function .*workspace_org_credit_scope/i.test(error.message)) {
      console.warn("[workspace-credits] org credit scope lookup skipped:", error.message);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.organization_id) {
      const orgType = row.organization_type ? String(row.organization_type) : null;
      if (orgType === "school" || orgType === "university") {
        const edu = await resolveWorkspaceEducationCreditScope(supabase, userId);
        if (edu?.classRole === "student" && edu.classId) {
          return {
            scope: "user",
            creditUserId: userId,
            email: resolvedEmail,
            organizationId: edu.organizationId,
            organizationName: edu.organizationName,
            organizationType: edu.organizationType,
            classId: edu.classId,
            className: edu.className,
            classRole: edu.classRole,
          };
        }
        if (!edu?.classId) {
          return {
            scope: "user",
            creditUserId: userId,
            email: resolvedEmail,
            organizationId: String(row.organization_id),
            organizationName: row.organization_name ? String(row.organization_name) : null,
            organizationType: orgType,
            classId: null,
            className: null,
            classRole: null,
          };
        }
      }
      return {
        scope: "organization",
        organizationId: String(row.organization_id),
        organizationName: row.organization_name ? String(row.organization_name) : null,
        poolDomain: row.primary_domain ? String(row.primary_domain) : null,
        email: resolvedEmail,
        organizationType: orgType,
      };
    }
  } catch (err) {
    console.warn(
      "[workspace-credits] org credit scope unavailable:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Repair older profiles that signed in before the post-auth org trigger
  // existed. If their email domain is now verified, pin membership so future
  // calls resolve through workspace_org_credit_scope.
  const domain = String(resolvedEmail ?? "").toLowerCase().split("@")[1] ?? "";
  if (domain && !isPublicEmailDomain(domain)) {
    try {
      const { data: domainRow } = await supabase
        .from("organization_domains")
        .select("organization_id, domain")
        .eq("domain", domain)
        .not("verified_at", "is", null)
        .maybeSingle();
      if (domainRow?.organization_id) {
        const { data: org } = await supabase
          .from("organizations")
          .select("id, name, display_name, status, type")
          .eq("id", domainRow.organization_id)
          .eq("status", "active")
          .is("deleted_at", null)
          .maybeSingle();
        if (org?.id) {
          await supabase
            .from("profiles")
            .update({
              organization_id: org.id,
              account_type: "org_user",
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId)
            .is("organization_id", null);
          await supabase.from("organization_memberships").upsert(
            {
              organization_id: org.id,
              user_id: userId,
              role: "member",
              status: "active",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "organization_id,user_id" },
          );
          if (String((org as { type?: unknown }).type ?? "") === "school" || String((org as { type?: unknown }).type ?? "") === "university") {
            return {
              scope: "user",
              creditUserId: userId,
              organizationId: String(org.id),
              organizationName: String(org.display_name ?? org.name ?? ""),
              organizationType: String((org as { type?: unknown }).type ?? ""),
              classId: null,
              className: null,
              classRole: null,
              email: resolvedEmail,
            };
          }
          return {
            scope: "organization",
            organizationId: String(org.id),
            organizationName: String(org.display_name ?? org.name ?? ""),
            poolDomain: String(domainRow.domain ?? domain),
            email: resolvedEmail,
            organizationType: String((org as { type?: unknown }).type ?? ""),
          };
        }
      }
    } catch (err) {
      console.warn(
        "[workspace-credits] org membership repair skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    scope: "user",
    creditUserId: userId,
    email: resolvedEmail,
  };
}

function buildChargeParams(
  body: WorkspaceRunBody,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(body.params ?? {}) };
  const inputs = body.inputs ?? {};
  if (
    typeof inputs.text === "string" &&
    !String(params.prompt ?? "").trim()
  ) {
    params.prompt = inputs.text;
  }
  for (const key of [
    "source_duration_seconds",
    "duration_seconds",
    "duration",
    "source_content_type",
    "source_media_type",
    "media_type",
  ]) {
    if (params[key] === undefined && inputs[key] !== undefined) {
      params[key] = inputs[key];
    }
  }
  return params;
}

async function resolveWorkspaceTeamId(
  supabase: ReturnType<typeof createClient>,
  workspaceId?: string | null,
): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const { data, error } = await supabase.rpc("workspace_team_id", {
      p_workspace_id: workspaceId,
    });
    if (error) {
      console.warn("[workspace-credits] workspace_team_id skipped:", error.message);
      return null;
    }
    return typeof data === "string" && data ? data : null;
  } catch (err) {
    console.warn(
      "[workspace-credits] workspace_team_id unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function normalizedModelKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function educationBlockedModelsFromSettings(settings: unknown): string[] {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).blocked_model_ids
      : null;
  if (Array.isArray(raw)) {
    return raw.map(normalizedModelKey).filter(Boolean);
  }
  return DEFAULT_EDUCATION_BLOCKED_MODELS;
}

function educationModelMatchesBlock(model: string, blocked: string): boolean {
  if (!model || !blocked) return false;
  if (model === blocked) return true;
  if (model.includes(blocked) || blocked.includes(model)) return true;
  if (blocked.includes("seedance-2-0")) {
    return model.includes("seedance-2-0") || model.includes("dreamina-seedance-2-0");
  }
  return false;
}

async function assertEducationModelAllowed(args: {
  supabase: ReturnType<typeof createClient>;
  classId: string;
  modelId: string;
}): Promise<void> {
  const model = normalizedModelKey(args.modelId);
  if (!model) return;
  const { data, error } = await args.supabase
    .from("classes")
    .select("settings")
    .eq("id", args.classId)
    .maybeSingle();
  if (error) {
    throw new Error(`Class model policy lookup failed: ${error.message}`);
  }
  const blocked = educationBlockedModelsFromSettings((data as { settings?: unknown } | null)?.settings);
  if (blocked.some((blockedModel) => educationModelMatchesBlock(model, blockedModel))) {
    throw new Error("MODEL_BLOCKED_BY_CLASS");
  }
}

async function ensureSpendableUserCreditBatch(
  supabase: ReturnType<typeof createClient>,
  creditUserId: string,
  requiredAmount: number,
): Promise<void> {
  if (!creditUserId || requiredAmount <= 0) return;

  try {
    const nowIso = new Date().toISOString();
    const [creditsRes, batchesRes] = await Promise.all([
      supabase
        .from("user_credits")
        .select("balance")
        .eq("user_id", creditUserId)
        .maybeSingle(),
      supabase
        .from("credit_batches")
        .select("remaining")
        .eq("user_id", creditUserId)
        .gt("remaining", 0)
        .gt("expires_at", nowIso),
    ]);

    if (creditsRes.error) {
      console.warn("[workspace-credits] balance repair skipped:", creditsRes.error.message);
      return;
    }
    if (batchesRes.error) {
      console.warn("[workspace-credits] batch repair skipped:", batchesRes.error.message);
      return;
    }

    const scalarBalance = Math.max(0, Math.floor(Number(creditsRes.data?.balance ?? 0)));
    const activeBatchBalance = (batchesRes.data ?? []).reduce(
      (sum, row: { remaining?: number | null }) => sum + Math.max(0, Math.floor(Number(row.remaining ?? 0))),
      0,
    );

    if (activeBatchBalance >= requiredAmount || scalarBalance <= activeBatchBalance) {
      return;
    }

    const repairAmount = scalarBalance - activeBatchBalance;
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase.from("credit_batches").insert({
      user_id: creditUserId,
      amount: repairAmount,
      remaining: repairAmount,
      source_type: "topup",
      expires_at: expiresAt,
      reference_id: `balance-repair-${Date.now()}`,
    });

    if (error) {
      console.warn("[workspace-credits] balance repair insert failed:", error.message);
      return;
    }

    console.log(
      `[workspace-credits] repaired spendable batch user=${creditUserId} amount=${repairAmount} active_before=${activeBatchBalance} scalar=${scalarBalance}`,
    );
  } catch (err) {
    console.warn(
      "[workspace-credits] balance repair failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function consumeWorkspaceCredits(args: {
  supabase: ReturnType<typeof createClient>;
  userId: string;
  body: WorkspaceRunBody;
  nodeType: string;
  provider: string;
  params: Record<string, unknown>;
  userEmail?: string | null;
}): Promise<WorkspaceCreditCharge | null> {
  if (args.body.skip_credit_charge || !shouldChargeWorkspaceProvider(args.provider)) {
    return null;
  }
  const def = workspaceProviderDef(args.nodeType, args.provider);
  const baseAmount = await lookupBaseCost(args.supabase, def, args.params);
  const multipliers = await fetchFeatureMultipliers(args.supabase);
  const fullAmount = Math.max(1, Math.ceil(baseAmount * workspaceMultiplierForProvider(def, multipliers)));
  const discountPercent = await lookupModelDiscountPercent(args.supabase, def, args.params);
  const amount = applyModelDiscountToCredits(fullAmount, discountPercent);
  if (amount <= 0) return null;
  const feature = workspaceCreditFeature(def, args.params);

  const teamId = await resolveWorkspaceTeamId(args.supabase, args.body.workspace_id ?? null);
  const referenceId = String(
    args.body.job_id ??
      args.body.node_id ??
      crypto.randomUUID(),
  );
  const creditOwner = await resolveWorkspaceCreditOwner(args.supabase, args.userId, args.userEmail);
  const descriptionBase = `${args.nodeType} ${String(args.params.model_name ?? args.params.model ?? args.provider)}`;
  const description =
    creditOwner.scope === "organization"
      ? `${descriptionBase} (${creditOwner.organizationName ?? "org"} shared pool; actual user ${creditOwner.email ?? args.userId})`
      : descriptionBase;

  if (
    creditOwner.scope === "user" &&
    creditOwner.organizationType &&
    ["school", "university"].includes(String(creditOwner.organizationType)) &&
    creditOwner.classRole !== "teacher"
  ) {
    if (!creditOwner.classId) {
      throw new Error("EDUCATION_CLASS_REQUIRED");
    }
    if (!args.body.workspace_id) {
      throw new Error("EDUCATION_SPACE_REQUIRED");
    }
    const modelId = String(args.params.model_name ?? args.params.model ?? args.provider);
    await assertEducationModelAllowed({
      supabase: args.supabase,
      classId: creditOwner.classId,
      modelId,
    });
    const { data, error } = await args.supabase.rpc("consume_education_space_credits", {
      p_user_id: args.userId,
      p_workspace_id: args.body.workspace_id,
      p_amount: amount,
      p_feature: feature,
      p_description: description,
      p_reference_id: referenceId,
      p_canvas_id: args.body.canvas_id ?? null,
      p_model_id: modelId,
    });
    if (error) {
      throw new Error(error.message);
    }
    if (data !== true) {
      throw new Error("INSUFFICIENT_CREDITS");
    }
    console.log(
      `[workspace-credits] charged ${amount} education-space credits user=${args.userId} class=${creditOwner.classId} workspace=${args.body.workspace_id} ref=${referenceId} full=${fullAmount} discount=${discountPercent}%`,
    );
    return {
      amount,
      scope: "education_space",
      teamId: null,
      organizationId: creditOwner.organizationId ?? null,
      classId: creditOwner.classId,
      creditUserId: args.userId,
      referenceId,
      feature,
    };
  }

  if (!teamId && creditOwner.scope === "organization") {
    const packageDiscountPercent = workspacePackageDiscountForOwner(creditOwner);
    const chargedAmount = applyWorkspacePackageDiscount(amount, packageDiscountPercent);
    const { data, error } = await args.supabase.rpc("consume_workspace_org_credits", {
      p_user_id: args.userId,
      p_organization_id: creditOwner.organizationId,
      p_amount: chargedAmount,
      p_feature: feature,
      p_description: description,
      p_reference_id: referenceId,
      p_workspace_id: args.body.workspace_id ?? null,
      p_canvas_id: args.body.canvas_id ?? null,
    });
    if (error) {
      // Shared-credit users must not silently fall back to personal billing.
      throw new Error(`Org credit deduction failed: ${error.message}`);
    } else {
      // Success path — actually charged from org pool.
      if (data !== true) {
        throw new Error("INSUFFICIENT_CREDITS");
      }
      console.log(
        `[workspace-credits] charged ${chargedAmount} credits user=${args.userId} org=${creditOwner.organizationId} ref=${referenceId} full=${fullAmount} model_discount=${discountPercent}% package_discount=${packageDiscountPercent}% model_price=${amount}`,
      );
      return {
        amount: chargedAmount,
        scope: "organization",
        teamId: null,
        organizationId: creditOwner.organizationId,
        classId: creditOwner.classId ?? null,
        creditUserId: null,
        referenceId,
        feature,
      };
    }
  }

  const creditUserId = creditOwner.scope === "user" ? creditOwner.creditUserId : args.userId;

  if (!teamId) {
    await ensureSpendableUserCreditBatch(args.supabase, creditUserId, amount);
  }

  const { data, error } = await args.supabase.rpc("consume_credits_for", {
    p_user_id: creditUserId,
    p_team_id: teamId,
    p_amount: amount,
    p_feature: feature,
    p_description: description,
    p_reference_id: referenceId,
    p_workspace_id: args.body.workspace_id ?? null,
    p_canvas_id: args.body.canvas_id ?? null,
  });
  if (error) {
    if (/function .*consume_credits_for/i.test(error.message)) {
      if (teamId) {
        throw new Error(`Team credit deduction unavailable: ${error.message}`);
      }
      const fallback = await args.supabase.rpc("consume_credits", {
        p_user_id: creditUserId,
        p_amount: amount,
        p_feature: feature,
        p_description: description,
        p_reference_id: referenceId,
      });
      if (fallback.error) {
        throw new Error(`Credit deduction failed: ${fallback.error.message}`);
      }
      if (fallback.data !== true) {
        throw new Error("INSUFFICIENT_CREDITS");
      }
    } else {
      throw new Error(`Credit deduction failed: ${error.message}`);
    }
  } else if (data !== true) {
    throw new Error("INSUFFICIENT_CREDITS");
  }

  const chargedAmount = await resolveEffectiveWorkspaceChargeAmount({
    supabase: args.supabase,
    scope: teamId ? "team" : "user",
    fallbackAmount: amount,
    referenceId,
    userId: creditUserId,
    teamId,
    workspaceId: args.body.workspace_id ?? null,
    canvasId: args.body.canvas_id ?? null,
  });

  console.log(
    `[workspace-credits] charged ${chargedAmount} credits user=${args.userId} credit_user=${creditUserId} team=${teamId ?? "personal"} ref=${referenceId} full=${fullAmount} model_discount=${discountPercent}% model_price=${amount}`,
  );
  return {
    amount: chargedAmount,
    scope: teamId ? "team" : "user",
    teamId,
    organizationId: creditOwner.scope === "user" ? creditOwner.organizationId ?? null : null,
    classId: creditOwner.scope === "user" ? creditOwner.classId ?? null : null,
    creditUserId,
    referenceId,
    feature,
  };
}

async function refundWorkspaceCredits(args: {
  supabase: ReturnType<typeof createClient>;
  userId: string;
  charge: WorkspaceCreditCharge | null;
  reason: string;
  workspaceId?: string | null;
  canvasId?: string | null;
}): Promise<void> {
  if (!args.charge || args.charge.amount <= 0) return;
  try {
    if (args.charge.scope === "education_space") {
      const { error } = await args.supabase.rpc("refund_education_space_credits", {
        p_user_id: args.charge.creditUserId ?? args.userId,
        p_workspace_id: args.workspaceId ?? null,
        p_amount: args.charge.amount,
        p_reason: args.reason,
        p_reference_id: args.charge.referenceId,
        p_canvas_id: args.canvasId ?? null,
      });
      if (error) throw error;
      return;
    }

    if (args.charge.scope === "organization" && args.charge.organizationId) {
      const { error } = await args.supabase.rpc("refund_workspace_org_credits", {
        p_user_id: args.userId,
        p_organization_id: args.charge.organizationId,
        p_amount: args.charge.amount,
        p_reason: args.reason,
        p_reference_id: args.charge.referenceId,
        p_workspace_id: args.workspaceId ?? null,
        p_canvas_id: args.canvasId ?? null,
      });
      if (error) throw error;
      return;
    }

    const owner = args.charge.creditUserId
      ? null
      : await resolveWorkspaceCreditOwner(args.supabase, args.userId);
    const creditUserId = args.charge.creditUserId ??
      (owner?.scope === "user" ? owner.creditUserId : args.userId);
    const { error } = await args.supabase.rpc("refund_credits_for", {
      p_user_id: creditUserId,
      p_team_id: args.charge.teamId,
      p_amount: args.charge.amount,
      p_reason: args.reason,
      p_reference_id: args.charge.referenceId,
      p_workspace_id: args.workspaceId ?? null,
      p_canvas_id: args.canvasId ?? null,
    });
    if (!error) return;
    if (!/function .*refund_credits_for/i.test(error.message)) {
      throw error;
    }
    await refundCreditsAtomic(
      args.supabase,
      creditUserId,
      args.charge.amount,
      args.reason,
      args.charge.referenceId,
    );
  } catch (err) {
    console.error(
      "[workspace-credits] refund failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function refundWorkspaceJobCharge(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  reason: string;
}): Promise<void> {
  const charged = Number(args.job.credits_charged ?? 0);
  const refunded = Number(args.job.credits_refunded ?? 0);
  const remaining = charged - refunded;
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  await refundWorkspaceCredits({
    supabase: args.supabase,
    userId: args.job.user_id,
    charge: {
      amount: remaining,
      scope: (args.job.credit_scope as WorkspaceCreditCharge["scope"] | null) ??
        (args.job.credit_organization_id ? "organization" : args.job.credit_team_id ? "team" : "user"),
      teamId: args.job.credit_team_id ?? null,
      organizationId: args.job.credit_organization_id ?? null,
      classId: args.job.credit_class_id ?? null,
      creditUserId: null,
      referenceId: args.job.id,
      feature: String(args.job.provider ?? args.job.node_type),
    },
    reason: args.reason,
    workspaceId: args.job.workspace_id ?? null,
    canvasId: args.job.canvas_id ?? null,
  });
  await args.supabase
    .from("workspace_generation_jobs")
    .update({ credits_refunded: refunded + remaining })
    .eq("id", args.job.id);
}

interface WorkspaceRunBody {
  node_type?: string;
  params?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  mentioned_assets?: MentionedAssetSrv[];
  /** Async-poll mode (Kling video tasks, Tripo3D 3D-model tasks).
   *  Frontend resends after the initial Run returned a `task_id`
   *  and an empty URL. Each provider has its own action so we can
   *  whitelist the upstream URL per provider. */
  action?:
    | "enqueue_workspace_job"
    | "get_workspace_job"
    | "poll_workspace_job"
    | "run_workspace_job_worker"
    | "poll_kling"
    | "poll_seedance"
    | "poll_veo"
    | "poll_replicate_veo"
    | "poll_replicate_video"
    | "poll_replicate_image"
    | "poll_elevenlabs_dubbing"
    | "poll_freepik_veo"
    | "poll_freepik_video"
    | "poll_freepik_image"
    | "poll_magnific_upscale"
    | "poll_hyper3d"
    | "poll_tripo3d"
    | "mirror_tripo_url"
    | "refresh_storage_url"
    | "delete_workspace_asset";
  job_id?: string;
  asset_id?: string;
  asset_source?: "generation" | "user_asset" | "upload" | string;
  storage_bucket?: string;
  storage_path?: string;
  task_id?: string;
  poll_endpoint?: string;
  model?: string;
  provider_model_id?: string;
  api_key_alias?: string;
  output_type?: string;
  target_lang?: string;
  output_language?: string;
  /** For action="mirror_tripo_url": the Tripo3D CDN URL to mirror
   *  into Supabase storage so model-viewer can fetch it across
   *  CORS. Used to migrate generations that were created before
   *  the inline mirror was deployed in poll_tripo3d. */
  url?: string;
  /** Optional context the frontend may pass for analytics attribution.
   *  Recorded in workspace_generation_events alongside user_id. None of
   *  these affect generation behaviour — they're informational only. */
  workspace_id?: string;
  project_id?: string;
  canvas_id?: string;
  node_id?: string;
  /** Internal: background jobs are charged once at enqueue time, so
   *  the worker replays the request with charging disabled. */
  skip_credit_charge?: boolean;
  precharged_credits?: number;
  credit_scope?: "user" | "organization" | "team" | "education_space";
  credit_organization_id?: string | null;
  credit_class_id?: string | null;
  provider_fallback?: {
    original_provider?: string;
    original_model?: string;
    route_index?: number;
    history?: Array<Record<string, unknown>>;
  };
}

const WORKSPACE_JOB_MAX_MS = 60 * 60_000;
// Supabase Edge requests can be terminated by the platform well before
// long image providers return. Keep each synchronous provider attempt under
// that ceiling, then let the durable queue retry until the 60 minute deadline.
const WORKSPACE_JOB_ATTEMPT_TIMEOUT_MS = 150_000;
const WORKSPACE_JOB_BACKOFF_MS = [3_000, 5_000, 10_000, 15_000, 30_000, 60_000];
const BANANA_JOB_BACKOFF_MS = [60_000, 180_000, 300_000, 600_000, 900_000];
function positiveIntEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WORKSPACE_JOB_WORKER_BATCH_SIZE = positiveIntEnv("WORKSPACE_JOB_WORKER_BATCH_SIZE", 3);
const WORKSPACE_JOB_LOCK_SEC = 360;
const WORKSPACE_JOB_HEARTBEAT_MS = 45_000;
const WORKSPACE_JOB_EXPIRE_SWEEP_LIMIT = 25;
const WORKSPACE_VIDEO_MIRROR_MAX_BYTES =
  positiveIntEnv("WORKSPACE_VIDEO_MIRROR_MAX_MB", 48) * 1024 * 1024;
const WORKSPACE_IMAGE_MIRROR_MAX_BYTES =
  positiveIntEnv("WORKSPACE_IMAGE_MIRROR_MAX_MB", 16) * 1024 * 1024;
const DIRECT_REPLICATE_PRIMARY_MODELS: Record<string, string> = {
  "replicate-seedance-2-0": "seedance-2-0-pro",
  "replicate-kling-v3-pro": "kling-v3-pro",
  "replicate-kling-v3-motion-pro": "kling-v3-motion-pro",
  "replicate-kling-v3-omni": "kling-v3-omni",
  "replicate-veo-3-1": "veo-3.1-generate-001",
  "replicate-nano-banana-2": "nano-banana-2",
  "replicate-nano-banana-pro": "nano-banana-pro",
  "replicate-gpt-image-2": "gpt-image-2",
};

function readContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function mirrorRemoteMedia(args: {
  supabase: any;
  sourceUrl: string;
  bucket: string;
  path: string;
  fallbackContentType: string;
  signedUrlTtlSeconds: number;
  /**
   * Legacy memory-safety cap. The previous buffered implementation pulled
   * the entire response into a `Uint8Array` before upload, so a hard byte
   * cap was the only thing standing between an 80 MB seedance render and a
   * 256 MB Edge Function isolate (`546 WORKER_LIMIT Memory limit exceeded`).
   * The streaming upload below holds only the in-flight chunk in external
   * memory, so the cap is no longer load-bearing. Kept in the signature
   * for caller compatibility (and as documentation of historical intent);
   * the value is no longer consulted.
   */
  maxBufferBytes?: number;
  /**
   * Legacy escape hatch that returned the raw provider URL when the
   * pre-flight content-length check tripped the cap above. Streaming
   * removed the need for that bypass — every successful download is now
   * mirrored. Kept in the signature for caller compatibility; the value
   * is no longer consulted.
   */
  allowRawUrlFallback?: boolean;
  label: string;
}): Promise<{ url: string; mirrored: boolean; contentType: string; skippedReason?: string }> {
  const res = await fetch(args.sourceUrl);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  if (!res.body) throw new Error(`[${args.label}] download response missing body`);

  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ||
    args.fallbackContentType;

  // Stream the response body straight to storage. The supabase-js client
  // forwards `ReadableStream<Uint8Array>` to the underlying fetch as a
  // chunked request body, so peak external memory stays at the chunk
  // buffer (~64 KB) regardless of file size. Verified locally with
  // `Deno.memoryUsage()`: a 1.4 MB seedance render kept `external` flat
  // at 2.9 MB through the entire mirror, vs +2.6 MB held with the
  // previous buffered path.
  const upload = await args.supabase.storage
    .from(args.bucket)
    .upload(args.path, res.body, { contentType, upsert: true });
  if (upload.error) throw upload.error;

  const signed = await args.supabase.storage
    .from(args.bucket)
    .createSignedUrl(args.path, args.signedUrlTtlSeconds);
  if (signed.error || !signed.data?.signedUrl) {
    throw signed.error ?? new Error("no signed URL");
  }

  return { url: signed.data.signedUrl, mirrored: true, contentType };
}

function workspaceJobMaxAttempts(provider: string): number {
  // Sync image calls consume request/compute on every retry because there is no
  // task id to resume. Keep them conservative and hand off to fallback routes
  // instead of letting users stare at a running row for half an hour.
  if (provider === "url_asset") return 2;
  if (provider === "banana") return 6;
  if (provider === "openai") return 3;
  if (provider === "remove_bg") return 4;
  return 18;
}

const REMOVE_BG_MODEL = "freepik-remove-bg";

function normalizeWorkspaceProviderModel(provider: string, params: Record<string, unknown>): string | null {
  const normalized =
    provider === "remove_bg"
      ? REMOVE_BG_MODEL
      : provider === "upscale_image"
        ? MAGNIFIC_UPSCALE_MODEL
        : null;
  if (!normalized) return null;
  params.model_name = normalized;
  if (params.model != null) params.model = normalized;
  return normalized;
}

function normalizeDirectReplicateModelForPrimary(body: WorkspaceRunBody): string | null {
  const params = body.params;
  if (!params || body.provider_fallback) return null;
  const rawModel = String(params.model_name ?? params.model ?? "").trim().toLowerCase();
  const primaryModel = DIRECT_REPLICATE_PRIMARY_MODELS[rawModel];
  if (!primaryModel) return null;
  params.model_name = primaryModel;
  if (params.model != null) params.model = primaryModel;
  return primaryModel;
}

type WorkspaceJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "permanent_failed";

type WorkspaceJobRow = {
  id: string;
  user_id: string;
  project_id?: string | null;
  workspace_id?: string | null;
  canvas_id?: string | null;
  node_id?: string | null;
  node_type: string;
  provider?: string | null;
  model?: string | null;
  request: WorkspaceRunBody;
  status: WorkspaceJobStatus;
  attempts: number;
  max_attempts: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
  last_error?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  run_after?: string | null;
  deadline_at?: string | null;
  locked_by?: string | null;
  lock_expires_at?: string | null;
  worker_heartbeat_at?: string | null;
  notification_sent_at?: string | null;
  credits_charged?: number | null;
  credits_refunded?: number | null;
  credit_team_id?: string | null;
  credit_organization_id?: string | null;
  credit_class_id?: string | null;
  credit_scope?: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type WorkspaceFallbackRoute = {
  provider: string;
  model: string;
  reason: string;
  params?: Record<string, unknown>;
};

function fallbackOriginalModel(job: WorkspaceJobRow): string {
  return String(
    job.request?.provider_fallback?.original_model ??
      job.model ??
      job.request?.params?.model_name ??
      job.request?.params?.model ??
      "",
  ).toLowerCase();
}

function routeForReplicateKling(originalModel: string): WorkspaceFallbackRoute | null {
  if (originalModel === "kling-v3-omni") {
    return {
      provider: "replicate_video",
      model: "replicate-kling-v3-omni",
      reason: "kling_3_omni_replicate_capacity",
    };
  }
  if (originalModel === "kling-v3-motion-pro") {
    return {
      provider: "replicate_video",
      model: "replicate-kling-v3-motion-pro",
      reason: "kling_3_motion_replicate_capacity",
    };
  }
  if (originalModel === "kling-v3-pro") {
    return {
      provider: "replicate_video",
      model: "replicate-kling-v3-pro",
      reason: "kling_3_pro_replicate_capacity",
    };
  }
  return null;
}

function buildWorkspaceFallbackRoutes(job: WorkspaceJobRow): WorkspaceFallbackRoute[] {
  if (!canUseReplicate()) return [];
  const originalProvider = String(job.request?.provider_fallback?.original_provider ?? job.provider ?? "").toLowerCase();
  const originalModel = fallbackOriginalModel(job);
  const routes: WorkspaceFallbackRoute[] = [];

  if (originalProvider === "veo" || originalModel.startsWith("veo-")) {
    routes.push({
      provider: "replicate_veo",
      model: REPLICATE_VEO_MODEL_SLUG,
      reason: "veo_3_1_replicate_capacity",
    });
  } else if (
    originalProvider === "seedance" ||
    originalModel.startsWith("seedance-2-0") ||
    originalModel.startsWith("dreamina-seedance-2-0")
  ) {
    routes.push({
      provider: "replicate_video",
      model: REPLICATE_SEEDANCE_MODEL_SLUG,
      reason: "seedance_2_0_replicate_capacity",
    });
  } else if (originalProvider === "kling" || originalModel.startsWith("kling-v3")) {
    const klingRoute = routeForReplicateKling(originalModel);
    if (klingRoute) routes.push(klingRoute);
  } else if (originalProvider === "banana" || originalModel.startsWith("nano-banana")) {
    routes.push({
      provider: "replicate_image",
      model: originalModel === "nano-banana-2" ? "replicate-nano-banana-2" : "replicate-nano-banana-pro",
      reason: "gemini_image_replicate_capacity",
    });
  } else if (originalProvider === "openai" || originalModel.startsWith("gpt-image-2")) {
    routes.push({
      provider: "replicate_image",
      model: "replicate-gpt-image-2",
      reason: "gpt_image_2_replicate_capacity",
    });
  }

  return routes.filter((route) => route.model && route.model !== String(job.model ?? "").toLowerCase());
}

async function advanceWorkspaceJobFallbackRoute(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  workerId?: string;
  error: string;
  trigger: "fast_fallback" | "attempts_exhausted" | "async_failed" | "deadline";
}): Promise<WorkspaceFallbackRoute | null> {
  const routes = buildWorkspaceFallbackRoutes(args.job);
  const meta = args.job.request?.provider_fallback ?? {};
  const currentIndex = Math.max(0, Number(meta.route_index ?? 0) || 0);
  const nextRoute = routes[currentIndex];
  if (!nextRoute) return null;

  const originalProvider = String(meta.original_provider ?? args.job.provider ?? "");
  const originalModel = String(
    meta.original_model ??
      args.job.model ??
      args.job.request?.params?.model_name ??
      args.job.request?.params?.model ??
      "",
  );
  const nextParams = {
    ...(args.job.request?.params ?? {}),
    ...(nextRoute.params ?? {}),
    model_name: nextRoute.model,
    model: nextRoute.model,
    fallback_from_provider: args.job.provider ?? originalProvider,
    fallback_from_model: args.job.model ?? originalModel,
  };
  if (
    (nextRoute.provider === "replicate_video" || nextRoute.provider === "replicate_veo") &&
    nextParams.generate_audio === undefined &&
    nextParams.has_audio === undefined &&
    nextParams.replicate_generate_audio === undefined
  ) {
    // The workspace UI renders audio as Off by default, but older/saved
    // nodes may not have that default persisted in params. Fallback
    // providers must preserve the visible silent-default UX instead of
    // silently upgrading to an audio-generating SKU.
    nextParams.generate_audio = "false";
  }
  const history = Array.isArray(meta.history) ? meta.history : [];
  const nextRequest: WorkspaceRunBody = {
    ...args.job.request,
    params: nextParams,
    provider_fallback: {
      original_provider: originalProvider,
      original_model: originalModel,
      route_index: currentIndex + 1,
      history: [
        ...history,
        {
          at: new Date().toISOString(),
          trigger: args.trigger,
          from_provider: args.job.provider,
          from_model: args.job.model,
          to_provider: nextRoute.provider,
          to_model: nextRoute.model,
          reason: nextRoute.reason,
          error: args.error.substring(0, 500),
        },
      ],
    },
  };

  const message =
    `Fallback route ${currentIndex + 1}/${routes.length}: ` +
    `${args.job.provider ?? originalProvider}/${args.job.model ?? originalModel} -> ` +
    `${nextRoute.provider}/${nextRoute.model} (${nextRoute.reason}). ` +
    `Previous error: ${args.error}`;

  const { error } = await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      provider: nextRoute.provider,
      model: nextRoute.model,
      request: nextRequest,
      result: null,
      attempts: 0,
      max_attempts: workspaceJobMaxAttempts(nextRoute.provider),
      error: null,
      last_error: message,
      locked_by: null,
      lock_expires_at: null,
      worker_heartbeat_at: new Date().toISOString(),
      run_after: new Date(Date.now() + 1000).toISOString(),
    })
    .eq("id", args.job.id);
  if (error) {
    console.error("[workspace-fallback] failed to advance route", args.job.id, error.message);
    return null;
  }
  console.warn(`[workspace-fallback] job=${args.job.id} ${message.substring(0, 700)}`);
  return nextRoute;
}

function hasRecoverableAsyncResult(job: WorkspaceJobRow): boolean {
  const result =
    job.result && typeof job.result === "object"
      ? (job.result as Record<string, unknown>)
      : null;
  const providerMeta =
    result?.provider_meta && typeof result.provider_meta === "object"
      ? (result.provider_meta as Record<string, unknown>)
      : null;
  return Boolean(
    result?.task_id &&
      !result.url &&
      providerMeta?.poll_endpoint,
  );
}

function isPermanentWorkspaceJobError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    classifyError(msg) === "permanent" ||
    /authentication|unauthor(ized|ised)|invalid.*api.?key/i.test(msg) ||
    /content[\s_-]*polic|moderation|blocked|safety (?:system|filter)|privacy-sensitive|Seedance rejected the reference media/i.test(msg) ||
    /unsupported node type|No executor for provider/i.test(msg) ||
    /\bnot configured\b|missing.*key|credentials missing/i.test(msg) ||
    /is not defined|is not a function|cannot read prop(?:erty|erties) of (?:undefined|null)/i.test(msg) ||
    /ReferenceError|TypeError|SyntaxError/i.test(msg) ||
    /HTTP (?:400|401|403|404|422)\b/i.test(msg) ||
    /Veo: failed to fetch start\/end frame \((?:400|401|403|404|410)\)/i.test(msg) ||
    /(prompt|input|argument).*required|Validation/i.test(msg) ||
    // Kling parameter errors (mode/model mismatch, unsupported feature
    // combinations, etc.) are deterministic — retrying just re-burns
    // wall-clock and leaves the job stuck in "running".
    /Kling.*API error.*(?:not supported|is not supported|model\/mode)/i.test(msg) ||
    /Seedance reference video is invalid|reference videos?.*(?:must|duration|invalid)|video duration.*(?:must|invalid|exceed)|total reference video duration|total duration of all videos/i.test(msg) ||
    // Supabase platform errors when workspace-run-node calls itself for
    // async polling and the inner worker hits CPU/memory/boot limits.
    // The function body returned for these is fixed Supabase wording —
    // matching it lets us fail fast + refund instead of looping until
    // the 1-hour deadline (each retry just hits the same limit). Users
    // can re-run manually once worker pool has capacity again.
    /Function failed due to not having enough compute resources|Function exceeded resource limit|Function failed to start|workspace-run-node HTTP 5\d\d/i.test(msg)
  );
}

async function readJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text };
  }
}

function firstSupabaseGatewayKey(): string {
  const names = [
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_ANON_KEY",
  ];
  const extract = (raw: string): string => {
    const value = raw.trim();
    if (!value) return "";
    if (value.startsWith("[") || value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        const values = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object"
            ? Object.values(parsed)
            : [];
        const found = values.find((item) => typeof item === "string" && item.trim());
        return typeof found === "string" ? found.trim() : "";
      } catch {
        // Fall through to comma/plain parsing.
      }
    }
    return value.split(",").map((part) => part.trim()).find(Boolean) ?? "";
  };

  for (const name of names) {
    const key = extract(Deno.env.get(name) ?? "");
    if (key) return key;
  }
  return "";
}

function safeJsonSnippet(value: unknown, maxLength = 1200): string {
  try {
    const text = JSON.stringify(value);
    if (!text) return "";
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return String(value);
  }
}

function formatVeoPollFailure(statusObj: unknown): string {
  const status =
    statusObj && typeof statusObj === "object"
      ? (statusObj as Record<string, unknown>)
      : {};
  const rawError =
    status.error && typeof status.error === "object"
      ? (status.error as Record<string, unknown>)
      : null;
  if (rawError) {
    const code = rawError.code != null ? `code=${String(rawError.code)}` : "";
    const statusCode = rawError.status != null ? `status=${String(rawError.status)}` : "";
    const message = String(rawError.message ?? "").trim();
    const prefix = [code, statusCode].filter(Boolean).join(" ");
    if (message) {
      return `Veo operation failed${prefix ? ` (${prefix})` : ""}: ${message}`;
    }
    return `Veo operation failed${prefix ? ` (${prefix})` : ""}: ${safeJsonSnippet(rawError)}`;
  }
  return `Veo operation finished without a video URL: ${safeJsonSnippet(statusObj)}`;
}

async function invokeWorkspaceRunOnce(args: {
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
  body: WorkspaceRunBody;
}): Promise<Record<string, unknown>> {
  const gatewayApiKey = firstSupabaseGatewayKey();
  // Inline retry budget for Supabase platform 546 (the inner edge worker
  // hit CPU/memory/boot limits during cold start). These blips usually
  // succeed on a warm worker on the next attempt, so spending ~2.3s on
  // a fresh try keeps the failure invisible to the user. Persistent
  // overload still falls through to the outer fast-fallback +
  // permanent-classification path that already lives downstream.
  const PLATFORM_RETRY_DELAYS_MS = [0, 800, 1500];
  let lastPlatformErrorMsg = "workspace-run-node HTTP 546";
  for (let attempt = 0; attempt < PLATFORM_RETRY_DELAYS_MS.length; attempt++) {
    if (PLATFORM_RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, PLATFORM_RETRY_DELAYS_MS[attempt]));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WORKSPACE_JOB_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(args.functionUrl, {
        method: "POST",
        headers: {
          Authorization: args.authHeader,
          ...(gatewayApiKey ? { apikey: gatewayApiKey } : {}),
          ...(args.extraHeaders ?? {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      });
      const payload = await readJsonSafe(res);
      const platformOverload =
        res.status === 546 ||
        (!res.ok &&
          typeof payload.message === "string" &&
          /Function failed due to not having enough compute resources|Function exceeded resource limit|Function failed to start/i.test(
            payload.message,
          ));
      if (platformOverload && attempt < PLATFORM_RETRY_DELAYS_MS.length - 1) {
        lastPlatformErrorMsg = String(payload.message ?? `workspace-run-node HTTP ${res.status}`);
        console.warn(
          `[invokeWorkspaceRunOnce] Supabase platform overload (HTTP ${res.status}), retrying attempt ${attempt + 2}/${PLATFORM_RETRY_DELAYS_MS.length} after ${PLATFORM_RETRY_DELAYS_MS[attempt + 1]}ms`,
        );
        continue;
      }
      if (!res.ok || payload.error) {
        throw new Error(
          String(payload.error ?? payload.message ?? `workspace-run-node HTTP ${res.status}`),
        );
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
  // Exhausted inline platform retries — propagate so the outer
  // fast-fallback + permanent-classification path can decide.
  throw new Error(lastPlatformErrorMsg);
}

function startWorkspaceJobHeartbeat(args: {
  supabase: ReturnType<typeof createClient>;
  jobId: string;
  workerId: string;
}): () => void {
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    const now = new Date();
    const { error } = await args.supabase
      .from("workspace_generation_jobs")
      .update({
        worker_heartbeat_at: now.toISOString(),
        lock_expires_at: new Date(now.getTime() + WORKSPACE_JOB_LOCK_SEC * 1000).toISOString(),
      })
      .eq("id", args.jobId)
      .eq("locked_by", args.workerId)
      .eq("status", "running");
    if (error) {
      console.warn("[workspace-job-worker] heartbeat failed", args.jobId, error.message);
    }
  };
  const timer = setInterval(() => void beat(), WORKSPACE_JOB_HEARTBEAT_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function pollWorkspaceAsyncResult(args: {
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
  response: Record<string, unknown>;
  budgetEndsAt: number;
}): Promise<Record<string, unknown>> {
  const taskId = String(args.response.task_id ?? "").trim();
  const providerMeta =
    args.response.provider_meta && typeof args.response.provider_meta === "object"
      ? (args.response.provider_meta as Record<string, unknown>)
      : {};
  const pollEndpoint = String(providerMeta.poll_endpoint ?? "").trim();
  if (!taskId || args.response.url || !pollEndpoint) return args.response;

  const provider = inferAsyncPollProvider(providerMeta, taskId, pollEndpoint);
  const pollAction =
    provider === "tripo3d"
      ? "poll_tripo3d"
      : provider === "hyper3d"
        ? "poll_hyper3d"
      : provider === "seedance"
        ? "poll_seedance"
      : provider === "veo"
        ? "poll_veo"
      : provider === "replicate_veo"
        ? "poll_replicate_veo"
      : provider === "replicate_video"
        ? "poll_replicate_video"
      : provider === "replicate_image"
        ? "poll_replicate_image"
      : provider === "elevenlabs_dubbing"
        ? "poll_elevenlabs_dubbing"
      : provider === "freepik_veo" || provider === "freepik_seedance"
        ? "poll_freepik_video"
      : provider === "magnific_upscale"
        ? "poll_magnific_upscale"
      : provider === "freepik_image"
        ? "poll_freepik_image"
        : "poll_kling";
  const intervalMs = provider === "tripo3d" ? 4_000 : provider === "hyper3d" ? 6_000 : 5_000;
  const successStatuses = new Set([
    "succeed",
    "success",
    "succeeded",
    "completed",
    "complete",
    "done",
  ]);
  const failedStatuses = new Set([
    "failed",
    "fail",
    "error",
    "errored",
    "cancelled",
    "canceled",
  ]);
  let lastStatus = "submitted";
  let lastMessage = "";

  while (Date.now() + intervalMs < args.budgetEndsAt) {
    await sleep(intervalMs);
    const pollResp = await invokeWorkspaceRunOnce({
      functionUrl: args.functionUrl,
      authHeader: args.authHeader,
      extraHeaders: args.extraHeaders,
      body: {
        action: pollAction,
        task_id: taskId,
        poll_endpoint: pollEndpoint,
        model: String(providerMeta.model ?? providerMeta.provider_model_id ?? ""),
        provider_model_id: String(providerMeta.provider_model_id ?? ""),
        api_key_alias: String(providerMeta.api_key_alias ?? ""),
        output_type: String(providerMeta.output_type ?? ""),
        target_lang: String(providerMeta.target_lang ?? ""),
        output_language: String(providerMeta.output_language ?? ""),
      } as WorkspaceRunBody,
    });
    lastStatus = String(pollResp.status ?? "").toLowerCase();
    lastMessage = String(pollResp.message ?? "");
    if (lastStatus === "polling_error") continue;

    if (successStatuses.has(lastStatus)) {
      const url = String(pollResp.url ?? "");
      if (!url) {
        throw new Error(`${provider} task succeeded but returned no URL`);
      }
      const responseType = String(args.response.type ?? args.response.output_type ?? "");
      const outputKey =
        responseType === "video" || responseType === "video_url"
          ? "output_video"
          : responseType === "audio" || responseType === "audio_url"
            ? "output_audio"
            : "output_image";
      const currentOutputs =
        args.response.outputs && typeof args.response.outputs === "object"
          ? (args.response.outputs as Record<string, string>)
          : {};
      const nextOutputs =
        provider === "elevenlabs_dubbing"
          ? { ...currentOutputs, [outputKey]: url, output_media: url }
          : { ...currentOutputs, [outputKey]: url };
      const nextProviderMeta = {
        ...providerMeta,
        ...(pollResp.provider_meta && typeof pollResp.provider_meta === "object"
          ? (pollResp.provider_meta as Record<string, unknown>)
          : {}),
        ...(pollResp.model_url ? { model_url: pollResp.model_url } : {}),
        ...(pollResp.preview_image ? { rendered_image: pollResp.preview_image } : {}),
      };
      return {
        ...args.response,
        url,
        outputs: nextOutputs,
        provider_meta: nextProviderMeta,
      };
    }

    if (failedStatuses.has(lastStatus)) {
      throw new Error(`${provider} task failed: ${lastMessage || "no detail"}`);
    }
  }

  throw new Error(`${provider} polling timed out (last status: ${lastStatus || "empty"})`);
}

type WorkspaceAsyncPollOnceResult =
  | { state: "not_async"; result: Record<string, unknown> }
  | { state: "pending"; status: string; message: string }
  | { state: "succeeded"; result: Record<string, unknown> }
  | { state: "failed"; message: string };

async function pollWorkspaceAsyncResultOnce(args: {
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
  response: Record<string, unknown>;
}): Promise<WorkspaceAsyncPollOnceResult> {
  const taskId = String(args.response.task_id ?? "").trim();
  const providerMeta =
    args.response.provider_meta && typeof args.response.provider_meta === "object"
      ? (args.response.provider_meta as Record<string, unknown>)
      : {};
  const pollEndpoint = String(providerMeta.poll_endpoint ?? "").trim();
  if (!taskId || args.response.url || !pollEndpoint) {
    return { state: "not_async", result: args.response };
  }

  const provider = inferAsyncPollProvider(providerMeta, taskId, pollEndpoint);
  const pollAction =
    provider === "tripo3d"
      ? "poll_tripo3d"
      : provider === "hyper3d"
        ? "poll_hyper3d"
      : provider === "seedance"
        ? "poll_seedance"
      : provider === "veo"
        ? "poll_veo"
      : provider === "replicate_veo"
        ? "poll_replicate_veo"
      : provider === "replicate_video"
        ? "poll_replicate_video"
      : provider === "replicate_image"
        ? "poll_replicate_image"
      : provider === "elevenlabs_dubbing"
        ? "poll_elevenlabs_dubbing"
      : provider === "freepik_veo" || provider === "freepik_seedance"
        ? "poll_freepik_video"
      : provider === "magnific_upscale"
        ? "poll_magnific_upscale"
      : provider === "freepik_image"
        ? "poll_freepik_image"
        : "poll_kling";

  const pollResp = await invokeWorkspaceRunOnce({
    functionUrl: args.functionUrl,
    authHeader: args.authHeader,
    extraHeaders: args.extraHeaders,
    body: {
      action: pollAction,
      task_id: taskId,
      poll_endpoint: pollEndpoint,
      model: String(providerMeta.model ?? providerMeta.provider_model_id ?? ""),
      provider_model_id: String(providerMeta.provider_model_id ?? ""),
      api_key_alias: String(providerMeta.api_key_alias ?? ""),
      output_type: String(providerMeta.output_type ?? ""),
      target_lang: String(providerMeta.target_lang ?? ""),
      output_language: String(providerMeta.output_language ?? ""),
    } as WorkspaceRunBody,
  });

  const status = String(pollResp.status ?? "").toLowerCase();
  const message = String(pollResp.message ?? "");
  if (status === "polling_error") {
    return { state: "pending", status, message };
  }

  const successStatuses = new Set([
    "succeed",
    "success",
    "succeeded",
    "completed",
    "complete",
    "done",
  ]);
  const failedStatuses = new Set([
    "failed",
    "fail",
    "error",
    "errored",
    "cancelled",
    "canceled",
  ]);

  if (successStatuses.has(status)) {
    const url = String(pollResp.url ?? "");
    if (!url) {
      return { state: "failed", message: `${provider} task succeeded but returned no URL` };
    }
    const nextProviderMeta = {
      ...providerMeta,
      ...(pollResp.provider_meta && typeof pollResp.provider_meta === "object"
        ? (pollResp.provider_meta as Record<string, unknown>)
        : {}),
      ...(pollResp.model_url ? { model_url: pollResp.model_url } : {}),
      ...(pollResp.preview_image ? { rendered_image: pollResp.preview_image } : {}),
    };
    const currentOutputs =
      args.response.outputs && typeof args.response.outputs === "object"
        ? (args.response.outputs as Record<string, string>)
        : {};
    const responseType = String(args.response.type ?? args.response.output_type ?? "");
    const outputKey =
      responseType === "video" || responseType === "video_url"
        ? "output_video"
        : responseType === "audio" || responseType === "audio_url"
          ? "output_audio"
          : "output_image";
    const nextOutputs =
      provider === "elevenlabs_dubbing"
        ? { ...currentOutputs, [outputKey]: url, output_media: url }
        : { ...currentOutputs, [outputKey]: url };
    return {
      state: "succeeded",
      result: {
        ...args.response,
        url,
        outputs: nextOutputs,
        provider_meta: nextProviderMeta,
      },
    };
  }

  if (failedStatuses.has(status)) {
    return { state: "failed", message: message || `${provider} task failed` };
  }

  return { state: "pending", status: status || "submitted", message };
}

function inferAsyncPollProvider(
  providerMeta: Record<string, unknown>,
  taskId: string,
  pollEndpoint: string,
): string {
  const explicit = String(providerMeta.provider ?? "").toLowerCase();
  if (explicit) return explicit;
  const endpoint = pollEndpoint.toLowerCase();
  const task = taskId.toLowerCase();
  if (
    endpoint.includes("api.magnific.com") ||
    endpoint.includes("api.freepik.com")
  ) {
    if (
      endpoint.includes("/image-upscaler-precision-v2") ||
      endpoint.includes("/video-upscaler-precision")
    ) return "magnific_upscale";
    if (endpoint.includes("/text-to-image/")) return "freepik_image";
    if (endpoint.includes("/seedance-")) return "freepik_seedance";
    return "freepik_veo";
  }
  if (endpoint.includes("api.replicate.com")) {
    const model = String(providerMeta.model ?? providerMeta.provider_model_id ?? "").toLowerCase();
    if (model.includes("gpt-image") || model.includes("nano-banana")) return "replicate_image";
    if (model.includes("veo")) return "replicate_veo";
    return "replicate_video";
  }
  if (
    endpoint.includes("generativelanguage.googleapis.com") ||
    task.startsWith("operations/") ||
    task.startsWith("models/")
  ) {
    return "veo";
  }
  if (
    endpoint.includes("byteplus") ||
    endpoint.includes("volces.com") ||
    endpoint.includes("/contents/generations/tasks")
  ) {
    return "seedance";
  }
  if (endpoint.includes("hyper3d")) return "hyper3d";
  if (endpoint.includes("tripo3d")) return "tripo3d";
  return "kling";
}

function collectProviderMediaUrls(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^https:\/\//i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProviderMediaUrls(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const preferredKeys = ["url", "image", "image_url", "output", "download_url"];
    const seenPreferred = new Set(preferredKeys);
    for (const key of preferredKeys) collectProviderMediaUrls(row[key], out);
    for (const [key, nested] of Object.entries(row)) {
      if (!seenPreferred.has(key)) collectProviderMediaUrls(nested, out);
    }
  }
  return out;
}

function uniqueProviderMediaUrls(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

async function probeRemoteImageDimensions(url: string): Promise<{ width: number; height: number } | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-65535" },
    });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const maxBytes = 65_536;
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (value.byteLength > remaining) break;
    }
    await reader.cancel().catch(() => {});
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return extractImageDimensions(bytes);
  } catch (err) {
    console.warn("[magnific_upscale] dimension probe failed:", err);
    return null;
  }
}

async function chooseLargestImageCandidate(
  candidates: string[],
): Promise<{
  url: string;
  index: number;
  width?: number;
  height?: number;
}> {
  const fallbackIndex = Math.max(0, candidates.length - 1);
  let best: {
    url: string;
    index: number;
    width?: number;
    height?: number;
  } = { url: candidates[fallbackIndex] ?? "", index: fallbackIndex };
  let bestArea = -1;

  for (let i = 0; i < candidates.length; i++) {
    const dims = await probeRemoteImageDimensions(candidates[i]);
    if (!dims) continue;
    const area = dims.width * dims.height;
    if (area > bestArea) {
      bestArea = area;
      best = { url: candidates[i], index: i, width: dims.width, height: dims.height };
    }
  }

  return best;
}

function workspaceJobDeadlineMs(job: WorkspaceJobRow): number {
  const explicitDeadline = Date.parse(String(job.deadline_at ?? ""));
  if (Number.isFinite(explicitDeadline)) return explicitDeadline;

  const started = Date.parse(String(job.started_at ?? ""));
  const created = Date.parse(String(job.created_at ?? ""));
  const base = Number.isFinite(started)
    ? started
    : Number.isFinite(created)
      ? created
      : Date.now();
  return base + WORKSPACE_JOB_MAX_MS;
}

function workspaceJobLink(job: WorkspaceJobRow): string {
  if (job.workspace_id) return `/app/workspace/${encodeURIComponent(job.workspace_id)}`;
  const section =
    job.node_type === "klingVideoNode" || job.node_type === "videoGenNode"
      ? "video_gen"
      : job.node_type === "upscaleImageNode"
        ? "image_upscale"
      : job.node_type === "googleTtsNode" || job.node_type === "geminiTtsNode"
        ? "voice_gen"
      : job.node_type === "voiceTranslateNode"
        ? "voice_translate"
        : job.node_type === "tripo3dNode" || job.node_type === "hyper3dNode"
          ? "model_3d"
          : "image_gen";
  return `/app/workspace?section=${section}`;
}

function workspaceJobProviderLabel(job: WorkspaceJobRow): string {
  return String(job.model ?? job.provider ?? job.node_type ?? "generation");
}

function workspaceJobBackoffMs(attempt: number, provider?: string): number {
  const schedule = provider === "banana" ? BANANA_JOB_BACKOFF_MS : WORKSPACE_JOB_BACKOFF_MS;
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)];
}

function workspaceJobBackoffSeconds(attempt: number, provider?: string): number {
  const ms = workspaceJobBackoffMs(attempt, provider);
  return Math.max(5, Math.ceil(ms / 1000));
}

function workspaceJobPollDelaySeconds(result: Record<string, unknown>): number {
  const providerMeta =
    result.provider_meta && typeof result.provider_meta === "object"
      ? (result.provider_meta as Record<string, unknown>)
      : {};
  const provider = inferAsyncPollProvider(
    providerMeta,
    String(result.task_id ?? ""),
    String(providerMeta.poll_endpoint ?? ""),
  );
  if (provider === "tripo3d") return 8;
  if (provider === "hyper3d") return 10;
  return 5;
}

function workspaceWorkerHeaders(secret: string, userId: string): Record<string, string> {
  return {
    "x-cron-secret": secret,
    "x-workspace-worker-secret": secret,
    "x-workspace-worker-user-id": userId,
  };
}

async function getWorkspaceWorkerSecret(
  supabase: ReturnType<typeof createClient>,
): Promise<string | null> {
  const envSecret =
    Deno.env.get("WORKSPACE_WORKER_SECRET") ??
    Deno.env.get("CRON_SECRET") ??
    "";
  if (envSecret) return envSecret;

  try {
    const { data, error } = await supabase.rpc("get_retry_worker_cron_secret");
    if (!error && data) return String(data);
  } catch (err) {
    console.warn(
      "[workspace-job-worker] secret lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return null;
}

async function verifyWorkspaceWorkerSecret(
  supabase: ReturnType<typeof createClient>,
  req: Request,
): Promise<string | null> {
  const provided =
    req.headers.get("x-cron-secret") ??
    req.headers.get("x-workspace-worker-secret") ??
    "";
  if (!provided) return null;

  const expected = await getWorkspaceWorkerSecret(supabase);
  return expected && provided === expected ? provided : null;
}

async function loadWorkspaceWorkerUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ id: string; email?: string | null } | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    console.error("[workspace-job-worker] user lookup failed", userId, error);
    return null;
  }
  return { id: data.user.id, email: data.user.email ?? null };
}

async function releaseWorkspaceJobLock(args: {
  supabase: ReturnType<typeof createClient>;
  jobId: string;
  workerId: string;
  runAfterSeconds: number;
}): Promise<void> {
  const { error } = await args.supabase.rpc("release_workspace_generation_job", {
    p_job_id: args.jobId,
    p_worker_id: args.workerId,
    p_run_after_seconds: args.runAfterSeconds,
  });
  if (error) {
    console.warn("[workspace-job-worker] release lock failed", args.jobId, error.message);
  }
}

async function notifyWorkspaceJobTerminal(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  status: "completed" | "failed" | "permanent_failed";
  message?: string;
}): Promise<void> {
  if (args.job.notification_sent_at) return;

  const { data: claimed, error: claimErr } = await args.supabase
    .from("workspace_generation_jobs")
    .update({ notification_sent_at: new Date().toISOString() })
    .eq("id", args.job.id)
    .is("notification_sent_at", null)
    .select("id")
    .maybeSingle();

  if (claimErr || !claimed) {
    if (claimErr) console.warn("[workspace-job] notification claim failed", claimErr.message);
    return;
  }

  const isSuccess = args.status === "completed";
  const providerLabel = workspaceJobProviderLabel(args.job);
  const title = isSuccess ? "Generation complete" : "Generation failed";
  const message = isSuccess
    ? `${providerLabel} is ready.`
    : (args.message?.trim() || `${providerLabel} could not finish. Credits were refunded.`);

  const { error } = await args.supabase.from("notifications").insert({
    user_id: args.job.user_id,
    type: isSuccess ? "workspace_generation_complete" : "workspace_generation_failed",
    title,
    message: message.substring(0, 300),
    icon: isSuccess ? "sparkles" : "alert-circle",
    link: workspaceJobLink(args.job),
    metadata: {
      job_id: args.job.id,
      project_id: args.job.project_id ?? null,
      workspace_id: args.job.workspace_id ?? null,
      canvas_id: args.job.canvas_id ?? null,
      node_id: args.job.node_id ?? null,
      provider: args.job.provider ?? null,
      model: args.job.model ?? null,
      status: args.status,
    },
  });
  if (error) {
    console.warn("[workspace-job] notification insert failed", args.job.id, error.message);
  }
}

async function completeWorkspaceJob(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  result: Record<string, unknown>;
}): Promise<WorkspaceJobRow | null> {
  const charged = Number(args.job.credits_charged ?? 0);
  const resultWithCredits = {
    ...args.result,
    credits_spent: Number.isFinite(charged) ? charged : 0,
  };
  const { data, error } = await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "completed",
      result: resultWithCredits,
      error: null,
      last_error: null,
      locked_by: null,
      lock_expires_at: null,
      run_after: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.job.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const updated = (data as WorkspaceJobRow | null) ?? { ...args.job, result: resultWithCredits, status: "completed" };
  await notifyWorkspaceJobTerminal({ supabase: args.supabase, job: updated, status: "completed" });
  return updated;
}

async function failWorkspaceJob(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  status?: "failed" | "permanent_failed";
  error: string;
  refundReason: string;
}): Promise<WorkspaceJobRow | null> {
  const msg = args.error;
  await refundWorkspaceJobCharge({
    supabase: args.supabase,
    job: args.job,
    reason: args.refundReason.substring(0, 300),
  });
  const { data, error } = await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: args.status ?? "failed",
      error: msg,
      last_error: msg,
      locked_by: null,
      lock_expires_at: null,
      run_after: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .eq("id", args.job.id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  const updated = (data as WorkspaceJobRow | null) ?? {
    ...args.job,
    status: args.status ?? "failed",
    error: msg,
    last_error: msg,
  };
  await notifyWorkspaceJobTerminal({
    supabase: args.supabase,
    job: updated,
    status: args.status ?? "failed",
    message: msg,
  });
  return updated;
}

async function scheduleWorkspaceJobRetry(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  workerId: string;
  message: string;
  delaySeconds: number;
  result?: Record<string, unknown>;
}): Promise<void> {
  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      ...(args.result ? { result: args.result } : {}),
      error: null,
      last_error: args.message,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", args.job.id);
  await releaseWorkspaceJobLock({
    supabase: args.supabase,
    jobId: args.job.id,
    workerId: args.workerId,
    runAfterSeconds: args.delaySeconds,
  });
}

async function scheduleWorkspaceJobProviderResubmit(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  workerId: string;
  message: string;
  delaySeconds: number;
}): Promise<void> {
  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      result: null,
      error: null,
      last_error: args.message,
      worker_heartbeat_at: new Date().toISOString(),
    })
    .eq("id", args.job.id);
  await releaseWorkspaceJobLock({
    supabase: args.supabase,
    jobId: args.job.id,
    workerId: args.workerId,
    runAfterSeconds: args.delaySeconds,
  });
}

async function processWorkspaceGenerationJobTick(args: {
  supabase: ReturnType<typeof createClient>;
  job: WorkspaceJobRow;
  workerId: string;
  functionUrl: string;
  serviceRoleKey: string;
  workerSecret: string;
}): Promise<{ job_id: string; status: string; detail?: string }> {
  const job = args.job;
  const now = Date.now();
  const deadlineMs = workspaceJobDeadlineMs(job);
  if (now >= deadlineMs) {
    const msg = `Provider queue was busy for ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes. Generation timed out and credits were refunded.`;
    const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
      supabase: args.supabase,
      job,
      workerId: args.workerId,
      error: msg,
      trigger: "deadline",
    });
    if (fallbackRoute) {
      return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
    }
    await failWorkspaceJob({
      supabase: args.supabase,
      job,
      status: "failed",
      error: msg,
      refundReason: `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
    });
    return { job_id: job.id, status: "failed", detail: "deadline" };
  }

  const authHeader = `Bearer ${args.serviceRoleKey}`;
  const extraHeaders = workspaceWorkerHeaders(args.workerSecret, job.user_id);
  const charged = Number(job.credits_charged ?? 0);
  const currentResult =
    job.result && typeof job.result === "object"
      ? (job.result as Record<string, unknown>)
      : null;
  const currentAttempts = Math.max(0, Number(job.attempts ?? 0) || 0);
  const maxAttempts = Math.max(1, Number(job.max_attempts ?? TOTAL_MAX_RETRIES) || TOTAL_MAX_RETRIES);
  if (
    !currentResult?.task_id &&
    job.last_error &&
    shouldFastFallbackProviderError(job.last_error)
  ) {
    const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
      supabase: args.supabase,
      job,
      workerId: args.workerId,
      error: job.last_error,
      trigger: "fast_fallback",
    });
    if (fallbackRoute) {
      return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
    }
  }

  if (!currentResult?.task_id && currentAttempts >= maxAttempts) {
    const msg =
      `${workspaceJobProviderLabel(job)} could not finish after ${maxAttempts} attempts. ` +
      `${job.last_error ? `Last provider error: ${job.last_error}` : "Credits were refunded."}`;
    const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
      supabase: args.supabase,
      job,
      workerId: args.workerId,
      error: msg,
      trigger: "attempts_exhausted",
    });
    if (fallbackRoute) {
      return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
    }
    await failWorkspaceJob({
      supabase: args.supabase,
      job,
      status: "failed",
      error: msg,
      refundReason: `workspace job exhausted attempts: ${String(job.last_error ?? "").substring(0, 160)}`,
    });
    return { job_id: job.id, status: "failed", detail: "max_attempts_exhausted" };
  }

  if (currentResult?.task_id && !currentResult.url) {
    try {
      const outcome = await pollWorkspaceAsyncResultOnce({
        functionUrl: args.functionUrl,
        authHeader,
        extraHeaders,
        response: currentResult,
      });

      if (outcome.state === "succeeded") {
        await completeWorkspaceJob({ supabase: args.supabase, job, result: outcome.result });
        return { job_id: job.id, status: "completed" };
      }
      if (outcome.state === "failed") {
        const msg = outcome.message || `${job.provider ?? "provider"} task failed`;
        const failure = classifyProviderError(msg);
        if (failure.fast_fallback) {
          const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
            supabase: args.supabase,
            job,
            workerId: args.workerId,
            error: msg,
            trigger: "fast_fallback",
          });
          if (fallbackRoute) {
            return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
          }
        }
        if (!failure.permanent && currentAttempts < maxAttempts) {
          await scheduleWorkspaceJobProviderResubmit({
            supabase: args.supabase,
            job,
            workerId: args.workerId,
            message: msg,
            delaySeconds: workspaceJobBackoffSeconds(currentAttempts + 1, job.provider),
          });
          return { job_id: job.id, status: "running", detail: "provider_resubmit" };
        }
        if (!failure.permanent) {
          const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
            supabase: args.supabase,
            job,
            workerId: args.workerId,
            error: msg,
            trigger: "async_failed",
          });
          if (fallbackRoute) {
            return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
          }
        }
        await failWorkspaceJob({
          supabase: args.supabase,
          job,
          status: "failed",
          error: msg,
          refundReason: `workspace async task failed: ${msg.substring(0, 160)}`,
        });
        return { job_id: job.id, status: "failed", detail: msg.substring(0, 120) };
      }

      const delaySeconds = workspaceJobPollDelaySeconds(currentResult);
      await scheduleWorkspaceJobRetry({
        supabase: args.supabase,
        job,
        workerId: args.workerId,
        message: outcome.state === "pending"
          ? (outcome.message || `Provider status: ${outcome.status}`)
          : "Waiting for provider result",
        delaySeconds,
      });
      return { job_id: job.id, status: "running", detail: "provider_pending" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (shouldFastFallbackProviderError(msg)) {
        const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
          supabase: args.supabase,
          job,
          workerId: args.workerId,
          error: msg,
          trigger: "fast_fallback",
        });
        if (fallbackRoute) {
          return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
        }
      }
      const permanent = isPermanentWorkspaceJobError(msg);
      if (permanent) {
        await failWorkspaceJob({
          supabase: args.supabase,
          job,
          status: "permanent_failed",
          error: msg,
          refundReason: `workspace async polling failed: ${msg.substring(0, 160)}`,
        });
        return { job_id: job.id, status: "permanent_failed", detail: msg.substring(0, 120) };
      }
      // Poll-failure budget: thrown exceptions from the inner
      // workspace-run-node fetch (network glitch, transient 5xx,
      // Supabase worker-limit 546) must bump `attempts` so an
      // unrecognised error message can't loop forever until the
      // 1-hour deadline. The legitimate pending-wait path above
      // (state="pending") goes through scheduleWorkspaceJobRetry
      // directly and intentionally does NOT consume budget.
      const nextAttempt = currentAttempts + 1;
      if (nextAttempt >= maxAttempts) {
        const finalMsg =
          `${workspaceJobProviderLabel(job)} polling failed after ${maxAttempts} attempts. ` +
          `Last error: ${msg}`;
        await failWorkspaceJob({
          supabase: args.supabase,
          job: { ...job, attempts: nextAttempt, last_error: msg },
          status: "failed",
          error: finalMsg,
          refundReason: `workspace polling exhausted: ${msg.substring(0, 160)}`,
        });
        return { job_id: job.id, status: "failed", detail: "poll_attempts_exhausted" };
      }
      await args.supabase
        .from("workspace_generation_jobs")
        .update({ attempts: nextAttempt })
        .eq("id", job.id);
      await scheduleWorkspaceJobRetry({
        supabase: args.supabase,
        job: { ...job, attempts: nextAttempt },
        workerId: args.workerId,
        message: msg,
        delaySeconds: 30,
      });
      return { job_id: job.id, status: "running", detail: "poll_retry" };
    }
  }

  const attempt = currentAttempts + 1;
  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      attempts: attempt,
      started_at: job.started_at ?? new Date().toISOString(),
      worker_heartbeat_at: new Date().toISOString(),
      error: null,
      last_error: null,
      run_after: null,
    })
    .eq("id", job.id);

  try {
    const stopHeartbeat = startWorkspaceJobHeartbeat({
      supabase: args.supabase,
      jobId: job.id,
      workerId: args.workerId,
    });
    let initial: Record<string, unknown>;
    try {
      initial = await invokeWorkspaceRunOnce({
        functionUrl: args.functionUrl,
        authHeader,
        extraHeaders,
        body: job.request,
      });
    } finally {
      stopHeartbeat();
    }
    const initialWithCredits = {
      ...initial,
      credits_spent: Number.isFinite(charged) ? charged : 0,
    };
    const providerMeta =
      initial.provider_meta && typeof initial.provider_meta === "object"
        ? (initial.provider_meta as Record<string, unknown>)
        : {};

    if (initial.task_id && providerMeta.poll_endpoint && !initial.url) {
      await scheduleWorkspaceJobRetry({
        supabase: args.supabase,
        job,
        workerId: args.workerId,
        message: "Provider accepted the job and is processing.",
        delaySeconds: workspaceJobPollDelaySeconds(initialWithCredits),
        result: initialWithCredits,
      });
      return { job_id: job.id, status: "running", detail: "async_submitted" };
    }

    await completeWorkspaceJob({ supabase: args.supabase, job, result: initialWithCredits });
    return { job_id: job.id, status: "completed" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const permanent = isPermanentWorkspaceJobError(msg);
    if (shouldFastFallbackProviderError(msg)) {
      const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
        supabase: args.supabase,
        job: { ...job, attempts: attempt, last_error: msg },
        workerId: args.workerId,
        error: msg,
        trigger: "fast_fallback",
      });
      if (fallbackRoute) {
        return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
      }
    }
    if (permanent) {
      await failWorkspaceJob({
        supabase: args.supabase,
        job: { ...job, attempts: attempt, last_error: msg },
        status: "permanent_failed",
        error: msg,
        refundReason: `workspace job failed: ${msg.substring(0, 160)}`,
      });
      return { job_id: job.id, status: "permanent_failed", detail: msg.substring(0, 120) };
    }
    if (attempt >= maxAttempts) {
      const finalMsg =
        `${workspaceJobProviderLabel(job)} could not finish after ${maxAttempts} attempts. ` +
        `Last provider error: ${msg}`;
      const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
        supabase: args.supabase,
        job: { ...job, attempts: attempt, last_error: msg },
        workerId: args.workerId,
        error: finalMsg,
        trigger: "attempts_exhausted",
      });
      if (fallbackRoute) {
        return { job_id: job.id, status: "running", detail: `fallback_${fallbackRoute.provider}` };
      }
      await failWorkspaceJob({
        supabase: args.supabase,
        job: { ...job, attempts: attempt, last_error: msg },
        status: "failed",
        error: finalMsg,
        refundReason: `workspace job exhausted attempts: ${msg.substring(0, 160)}`,
      });
      return { job_id: job.id, status: "failed", detail: "max_attempts_exhausted" };
    }

    const delaySeconds = workspaceJobBackoffSeconds(attempt, job.provider);
    await args.supabase
      .from("workspace_generation_jobs")
      .update({
        status: "running",
        attempts: attempt,
        last_error: msg,
        worker_heartbeat_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    await releaseWorkspaceJobLock({
      supabase: args.supabase,
      jobId: job.id,
      workerId: args.workerId,
      runAfterSeconds: delaySeconds,
    });
    return { job_id: job.id, status: "running", detail: `retry_in_${delaySeconds}s` };
  }
}

async function expireWorkspaceGenerationJobs(args: {
  supabase: ReturnType<typeof createClient>;
}): Promise<number> {
  const { data, error } = await args.supabase
    .from("workspace_generation_jobs")
    .select("*")
    .in("status", ["queued", "running"])
    .lte("deadline_at", new Date().toISOString())
    .order("deadline_at", { ascending: true })
    .limit(WORKSPACE_JOB_EXPIRE_SWEEP_LIMIT);

  if (error) {
    console.error("[workspace-job-worker] expire query failed", error.message);
    return 0;
  }

  const jobs = (data ?? []) as WorkspaceJobRow[];
  for (const job of jobs) {
    const msg = `Provider queue was busy for ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes. Generation timed out and credits were refunded.`;
    try {
      const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
        supabase: args.supabase,
        job,
        error: msg,
        trigger: "deadline",
      });
      if (fallbackRoute) {
        console.warn(
          `[workspace-job-worker] expired job=${job.id} advanced to fallback provider=${fallbackRoute.provider}`,
        );
        continue;
      }
      await failWorkspaceJob({
        supabase: args.supabase,
        job,
        status: "failed",
        error: msg,
        refundReason: `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
      });
    } catch (err) {
      console.error(
        "[workspace-job-worker] expire failed",
        job.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return jobs.length;
}

async function runWorkspaceGenerationWorker(args: {
  supabase: ReturnType<typeof createClient>;
  functionUrl: string;
  serviceRoleKey: string;
  workerSecret: string;
  requestedJobId?: string | null;
}): Promise<Record<string, unknown>> {
  const workerId = `workspace-worker-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const expired = await expireWorkspaceGenerationJobs({ supabase: args.supabase });

  let jobs: WorkspaceJobRow[] = [];
  if (args.requestedJobId) {
    const { data, error } = await args.supabase.rpc("claim_workspace_generation_job", {
      p_job_id: args.requestedJobId,
      p_worker_id: workerId,
      p_lock_duration_sec: WORKSPACE_JOB_LOCK_SEC,
    });
    if (error) throw error;
    if (data) jobs = [data as WorkspaceJobRow];
  } else {
    const { data, error } = await args.supabase.rpc("claim_workspace_generation_jobs", {
      p_worker_id: workerId,
      p_batch_size: WORKSPACE_JOB_WORKER_BATCH_SIZE,
      p_lock_duration_sec: WORKSPACE_JOB_LOCK_SEC,
    });
    if (error) throw error;
    jobs = (data ?? []) as WorkspaceJobRow[];
  }

  const settled = await Promise.allSettled(
    jobs.map((job) =>
      processWorkspaceGenerationJobTick({
        supabase: args.supabase,
        job,
        workerId,
        functionUrl: args.functionUrl,
        serviceRoleKey: args.serviceRoleKey,
        workerSecret: args.workerSecret,
      }),
    ),
  );

  const results = settled.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    return {
      job_id: jobs[index]?.id ?? null,
      status: "worker_error",
      detail: item.reason instanceof Error ? item.reason.message : String(item.reason),
    };
  });

  return {
    worker: workerId,
    expired,
    claimed: jobs.length,
    results,
    duration_ms: Date.now() - startedAt,
  };
}

async function processWorkspaceGenerationJob(args: {
  supabase: any;
  jobId: string;
  userId: string;
  functionUrl: string;
  authHeader: string;
  extraHeaders?: Record<string, string>;
}): Promise<void> {
  const { data: jobRaw, error: jobErr } = await args.supabase
    .from("workspace_generation_jobs")
    .select("*")
    .eq("id", args.jobId)
    .eq("user_id", args.userId)
    .maybeSingle();

  if (jobErr || !jobRaw) {
    console.error("[workspace-job] missing job", args.jobId, jobErr);
    return;
  }

  const job = jobRaw as WorkspaceJobRow;
  const request = job.request ?? {};
  const budgetEndsAt = workspaceJobDeadlineMs(job);
  let attempt = Number(job.attempts ?? 0);
  let lastError = "";

  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", job.id);

  while (Date.now() < budgetEndsAt && attempt < (job.max_attempts || 18)) {
    attempt += 1;
    await args.supabase
      .from("workspace_generation_jobs")
      .update({ status: "running", attempts: attempt, last_error: null, run_after: null })
      .eq("id", job.id);

    try {
      const initial = await invokeWorkspaceRunOnce({
        functionUrl: args.functionUrl,
        authHeader: args.authHeader,
        extraHeaders: args.extraHeaders,
        body: request,
      });
      const charged = Number(job.credits_charged ?? 0);
      const initialWithCredits = {
        ...initial,
        credits_spent: Number.isFinite(charged) ? charged : 0,
      };
      const providerMeta =
        initial.provider_meta && typeof initial.provider_meta === "object"
          ? (initial.provider_meta as Record<string, unknown>)
          : {};
      if (initial.task_id && providerMeta.poll_endpoint && !initial.url) {
        await args.supabase
          .from("workspace_generation_jobs")
          .update({
            status: "running",
            result: initialWithCredits,
            error: null,
            last_error: null,
          })
          .eq("id", job.id);
      }
      const finalResult = await pollWorkspaceAsyncResult({
        functionUrl: args.functionUrl,
        authHeader: args.authHeader,
        extraHeaders: args.extraHeaders,
        response: initialWithCredits,
        budgetEndsAt,
      });
      const finalResultWithCredits = {
        ...finalResult,
        credits_spent: Number.isFinite(charged) ? charged : 0,
      };

      await args.supabase
        .from("workspace_generation_jobs")
        .update({
          status: "completed",
          result: finalResultWithCredits,
          error: null,
          last_error: null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      console.log(`[workspace-job] completed job=${job.id} attempts=${attempt}`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const permanent = isPermanentWorkspaceJobError(lastError);
      if (shouldFastFallbackProviderError(lastError)) {
        const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
          supabase: args.supabase,
          job: { ...job, attempts: attempt, last_error: lastError },
          error: lastError,
          trigger: "fast_fallback",
        });
        if (fallbackRoute) return;
      }
      await args.supabase
        .from("workspace_generation_jobs")
        .update({
          status: permanent ? "permanent_failed" : "running",
          last_error: lastError,
          ...(permanent
            ? {
                error: lastError,
                completed_at: new Date().toISOString(),
              }
            : {}),
        })
        .eq("id", job.id);
      if (permanent) {
        console.warn(`[workspace-job] permanent failure job=${job.id}: ${lastError}`);
        await refundWorkspaceJobCharge({
          supabase: args.supabase,
          job: { ...job, attempts: attempt, last_error: lastError },
          reason: `workspace job failed: ${lastError.substring(0, 160)}`,
        });
        return;
      }

      const remaining = budgetEndsAt - Date.now();
      const backoff = workspaceJobBackoffMs(attempt, job.provider);
      if (remaining < backoff + 1_000) break;
      if (job.provider === "banana") {
        await args.supabase
          .from("workspace_generation_jobs")
          .update({
            status: "running",
            attempts: attempt,
            last_error: lastError,
            run_after: new Date(Date.now() + backoff).toISOString(),
          })
          .eq("id", job.id);
        return;
      }
      await sleep(backoff);
    }
  }

  const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
    supabase: args.supabase,
    job: { ...job, attempts: attempt, last_error: lastError },
    error:
      lastError ||
      `Generation timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
    trigger: "attempts_exhausted",
  });
  if (fallbackRoute) return;

  await args.supabase
    .from("workspace_generation_jobs")
    .update({
      status: "failed",
      error:
        lastError ||
        `Generation timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
      last_error: lastError || null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);
  await refundWorkspaceJobCharge({
    supabase: args.supabase,
    job: { ...job, attempts: attempt, last_error: lastError },
    reason:
      lastError.substring(0, 160) ||
      `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
  });
  console.warn(`[workspace-job] failed job=${job.id} attempts=${attempt}: ${lastError}`);
}

function collectUrlStrings(value: unknown, output = new Set<string>(), depth = 0): Set<string> {
  if (depth > 4 || value == null) return output;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) output.add(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectUrlStrings(item, output, depth + 1);
    }
  }
  return output;
}

async function validateVeoFrameInputs(
  supabaseClient: ReturnType<typeof createClient>,
  inputs: unknown,
  supabaseUrl: string,
): Promise<string | null> {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return null;
  const frameInputs = inputs as Record<string, unknown>;
  for (const key of ["start_frame", "end_frame"]) {
    const raw = frameInputs[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value !== "string" || value.startsWith("data:")) continue;
      const parsed = parseSupabaseStorageUrl(value, supabaseUrl);
      if (!parsed) continue;
      const { data, error } = await supabaseClient.storage
        .from(parsed.bucket)
        .download(parsed.path);
      if (error || !data) {
        return "Reference image is no longer available. Please select or upload the image again before generating Veo.";
      }
    }
  }
  return null;
}

function isOwnWorkspaceStoragePath(bucket: string, path: string, userId: string): boolean {
  if (!bucket || !path || path.split("/").some((part) => part === "..")) return false;
  if (bucket === "user_assets") {
    return path.startsWith(`${userId}/`) || path.startsWith(`tts/${userId}/`);
  }
  if (bucket === "ai-media") {
    return path.startsWith(`${userId}/`) || path.startsWith(`tripo3d-mirror/${userId}/`);
  }
  return false;
}

function addStoragePointer(
  pointers: Map<string, string>,
  bucket: unknown,
  path: unknown,
  userId: string,
) {
  const b = String(bucket ?? "").trim();
  const p = String(path ?? "").trim().replace(/^\/+/, "");
  if (!isOwnWorkspaceStoragePath(b, p, userId)) return;
  pointers.set(`${b}:${p}`, `${b}\n${p}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let activeCreditCharge: WorkspaceCreditCharge | null = null;
  let activeUserId: string | null = null;
  let activeBody: WorkspaceRunBody | null = null;

  try {
    /* ─── Auth ─────────────────────────────────────────────── */
    let authHeader = req.headers.get("authorization") ?? "";
    if (
      !authHeader &&
      !req.headers.get("x-cron-secret") &&
      !req.headers.get("x-workspace-worker-secret")
    ) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = (await req.json()) as WorkspaceRunBody;
    activeBody = body;
    const workerSecret = await verifyWorkspaceWorkerSecret(supabase, req);
    const workerUserId = req.headers.get("x-workspace-worker-user-id") ?? "";

    if (body.action === "run_workspace_job_worker") {
      if (!workerSecret) {
        return new Response(
          JSON.stringify({ error: "unauthorized" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const summary = await runWorkspaceGenerationWorker({
        supabase,
        functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
        workerSecret,
        requestedJobId: body.job_id ?? null,
      });
      return new Response(
        JSON.stringify(summary),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let user: { id: string; email?: string | null } | null = null;
    if (workerSecret && workerUserId) {
      user = await loadWorkspaceWorkerUser(supabase, workerUserId);
      authHeader = authHeader || `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    } else {
      const token = String(authHeader ?? "").replace("Bearer ", "");
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authUser) {
        return new Response(
          JSON.stringify({ error: "Invalid token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      user = { id: authUser.id, email: authUser.email ?? null };
    }
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Invalid worker user" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    activeUserId = user.id;
    const isInternalWorkerReplay = Boolean(workerSecret && workerUserId);
    if (!isInternalWorkerReplay) {
      delete body.skip_credit_charge;
      delete body.precharged_credits;
      delete body.credit_scope;
      delete body.credit_organization_id;
      delete body.credit_class_id;
      delete body.provider_fallback;
    }

    /* ─── Parse body ───────────────────────────────────────── */
    if (body.action === "delete_workspace_asset") {
      const source = String(body.asset_source ?? "").trim();
      const assetId = String(body.asset_id ?? body.job_id ?? "")
        .trim()
        .replace(/^job-/, "")
        .replace(/^user-asset-/, "");
      const storagePointers = new Map<string, string>();
      addStoragePointer(storagePointers, body.storage_bucket, body.storage_path, user.id);
      const parsedBodyUrl = body.url ? parseSupabaseStorageUrl(String(body.url), SUPABASE_URL) : null;
      if (parsedBodyUrl) addStoragePointer(storagePointers, parsedBodyUrl.bucket, parsedBodyUrl.path, user.id);

      let deletedRows = 0;
      if (source === "generation") {
        if (!assetId) {
          return new Response(
            JSON.stringify({ error: "asset_id required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const { data: job, error: jobError } = await supabase
          .from("workspace_generation_jobs")
          .select("id,user_id,result")
          .eq("id", assetId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (jobError) {
          return new Response(
            JSON.stringify({ error: jobError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!job) {
          return new Response(
            JSON.stringify({ error: "Asset not found" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        for (const rawUrl of collectUrlStrings((job as { result?: unknown }).result)) {
          const parsed = parseSupabaseStorageUrl(rawUrl, SUPABASE_URL);
          if (parsed) addStoragePointer(storagePointers, parsed.bucket, parsed.path, user.id);
        }
        const { data: deleted, error: deleteError } = await supabase
          .from("workspace_generation_jobs")
          .delete()
          .eq("id", assetId)
          .eq("user_id", user.id)
          .select("id");
        if (deleteError) {
          return new Response(
            JSON.stringify({ error: deleteError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        deletedRows = deleted?.length ?? 0;
      } else if (source === "user_asset") {
        if (!assetId) {
          return new Response(
            JSON.stringify({ error: "asset_id required" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const { data: row, error: rowError } = await supabase
          .from("user_assets")
          .select("*")
          .eq("id", assetId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (rowError) {
          return new Response(
            JSON.stringify({ error: rowError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!row) {
          return new Response(
            JSON.stringify({ error: "Asset not found" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        for (const rawUrl of collectUrlStrings(row)) {
          const parsed = parseSupabaseStorageUrl(rawUrl, SUPABASE_URL);
          if (parsed) addStoragePointer(storagePointers, parsed.bucket, parsed.path, user.id);
        }
        const { data: deleted, error: deleteError } = await supabase
          .from("user_assets")
          .delete()
          .eq("id", assetId)
          .eq("user_id", user.id)
          .select("id");
        if (deleteError) {
          return new Response(
            JSON.stringify({ error: deleteError.message }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        deletedRows = deleted?.length ?? 0;
      } else if (source !== "upload") {
        return new Response(
          JSON.stringify({ error: "Unsupported asset source" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const removedStorage: Array<{ bucket: string; path: string }> = [];
      for (const value of storagePointers.values()) {
        const [bucket, path] = value.split("\n");
        const { error: removeError } = await supabase.storage.from(bucket).remove([path]);
        if (!removeError) removedStorage.push({ bucket, path });
      }

      return new Response(
        JSON.stringify({ ok: true, deleted_rows: deletedRows, removed_storage: removedStorage }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "refresh_storage_url") {
      const srcUrl = String(body.url ?? "").trim();
      const parsed = parseSupabaseStorageUrl(srcUrl, SUPABASE_URL);
      if (!parsed) {
        return new Response(
          JSON.stringify({ error: "A valid Supabase storage URL is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const ownUserAsset =
        parsed.bucket === "user_assets" &&
        (parsed.path.startsWith(`${user.id}/`) ||
          parsed.path.startsWith(`tts/${user.id}/`));
      const ownAiMedia =
        parsed.bucket === "ai-media" &&
        (parsed.path.startsWith(`${user.id}/`) ||
          parsed.path.startsWith(`tripo3d-mirror/${user.id}/`));

      if (!ownUserAsset && !ownAiMedia) {
        return new Response(
          JSON.stringify({ error: "Storage URL does not belong to this account." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: signed, error: signError } = await supabase.storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.path, 60 * 60 * 24 * 365);
      if (signError || !signed?.signedUrl) {
        return new Response(
          JSON.stringify({ error: signError?.message ?? "Could not refresh signed URL." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          url: signed.signedUrl,
          signed_url: signed.signedUrl,
          bucket: parsed.bucket,
          storage_path: parsed.path,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "get_workspace_job") {
      const jobId = String(body.job_id ?? "").trim();
      if (!jobId) {
        return new Response(
          JSON.stringify({ error: "job_id required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: job, error } = await supabase
        .from("workspace_generation_jobs")
        .select("*")
        .eq("id", jobId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!job) {
        return new Response(
          JSON.stringify({ error: "job not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ job }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "poll_workspace_job") {
      const jobId = String(body.job_id ?? "").trim();
      if (!jobId) {
        return new Response(
          JSON.stringify({ error: "job_id required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const loadJob = async () => {
        const { data: job, error } = await supabase
          .from("workspace_generation_jobs")
          .select("*")
          .eq("id", jobId)
          .eq("user_id", user.id)
          .maybeSingle();
        if (error) throw error;
        return job as WorkspaceJobRow | null;
      };

      let job = await loadJob();
      if (!job) {
        return new Response(
          JSON.stringify({ error: "job not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (
        !["completed", "failed", "permanent_failed"].includes(job.status) &&
        Date.now() >= workspaceJobDeadlineMs(job)
      ) {
        const msg = `Provider queue was busy for ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes. Generation timed out and credits were refunded.`;
        const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
          supabase,
          job,
          error: msg,
          trigger: "deadline",
        });
        if (!fallbackRoute) {
          await failWorkspaceJob({
            supabase,
            job,
            status: "failed",
            error: msg,
            refundReason: `workspace job timed out after ${Math.round(WORKSPACE_JOB_MAX_MS / 60_000)} minutes`,
          });
        }
        job = await loadJob();
        if (!job) {
          return new Response(
            JSON.stringify({ error: "job not found" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      if (["completed", "failed", "permanent_failed"].includes(job.status)) {
        return new Response(
          JSON.stringify({ job }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const currentResult =
        job.result && typeof job.result === "object"
          ? (job.result as Record<string, unknown>)
          : null;
      if (!currentResult?.task_id) {
        return new Response(
          JSON.stringify({ job }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      try {
        const outcome = await pollWorkspaceAsyncResultOnce({
          functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
          authHeader,
          response: currentResult,
        });

        if (outcome.state === "succeeded") {
          const charged = Number(job.credits_charged ?? 0);
          await completeWorkspaceJob({
            supabase,
            job,
            result: {
              ...outcome.result,
              credits_spent: Number.isFinite(charged) ? charged : 0,
            },
          });
        } else if (outcome.state === "failed") {
          const msg = outcome.message;
          const failure = classifyProviderError(msg);
          let handedOff = false;
          if (failure.fast_fallback) {
            const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
              supabase,
              job,
              error: msg,
              trigger: "fast_fallback",
            });
            handedOff = Boolean(fallbackRoute);
          }
          if (!handedOff && !failure.permanent) {
            if (Number(job.attempts ?? 0) < Math.max(1, Number(job.max_attempts ?? TOTAL_MAX_RETRIES) || TOTAL_MAX_RETRIES)) {
              await supabase
                .from("workspace_generation_jobs")
                .update({
                  status: "running",
                  result: null,
                  error: null,
                  last_error: msg.substring(0, 1000),
                  run_after: new Date().toISOString(),
                })
                .eq("id", job.id);
              handedOff = true;
            } else {
              const fallbackRoute = await advanceWorkspaceJobFallbackRoute({
                supabase,
                job,
                error: msg,
                trigger: "async_failed",
              });
              handedOff = Boolean(fallbackRoute);
            }
          }
          if (!handedOff) {
            await failWorkspaceJob({
              supabase,
              job,
              status: failure.permanent ? "permanent_failed" : "failed",
              error: msg,
              refundReason: `workspace async task failed: ${msg.substring(0, 160)}`,
            });
          }
        } else if (outcome.state === "pending") {
          await supabase
            .from("workspace_generation_jobs")
            .update({
              status: "running",
              last_error: outcome.message
                ? outcome.message.substring(0, 1000)
                : `Provider status: ${outcome.status}`,
            })
            .eq("id", job.id);
        }

        job = await loadJob();
        return new Response(
          JSON.stringify({ job }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("workspace_generation_jobs")
          .update({
            status: "running",
            last_error: msg,
          })
          .eq("id", job.id);
        job = await loadJob();
        return new Response(
          JSON.stringify({ job, warning: msg.substring(0, 300) }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (body.action === "enqueue_workspace_job") {
      const nodeType = String(body.node_type ?? "").trim();
      if (!nodeType) {
        return new Response(
          JSON.stringify({ error: "node_type is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Rate limit check temporarily disabled — was added in the
      // security audit pass but caused intermittent 500s for some
      // users (root cause TBD; possibly an interaction with the
      // service-role-scoped RPC + RLS context). Provider billing
      // protection is now relying on:
      //   1. Client-side button-state debounce
      //   2. Per-user advisory_xact_lock inside consume_credits
      //   3. Stripe billing alerts on the provider side
      // Will re-introduce after a focused investigation — see audit
      // Tier-2 follow-ups list.

      const { action: _action, job_id: _jobId, ...runRequest } = body;
      const normalizedReplicateModel = normalizeDirectReplicateModelForPrimary(runRequest);
      if (normalizedReplicateModel) {
        console.warn(
          `[workspace-job] direct Replicate model normalized to primary model=${normalizedReplicateModel}`,
        );
      }
      const provider = getProviderForNodeType(
        nodeType,
        runRequest.params?.model_name as string | undefined,
      );
      if (!runRequest.params) runRequest.params = {};
      normalizeWorkspaceProviderModel(provider, runRequest.params);
      const model = String(
        runRequest.params?.model_name ??
          runRequest.params?.model ??
          nodeType,
      );
      enforcePrimaryProviderParams(provider, runRequest.params);
      if (provider === "veo") {
        const frameInputError = await validateVeoFrameInputs(
          supabase,
          runRequest.inputs,
          SUPABASE_URL,
        );
        if (frameInputError) {
          return new Response(
            JSON.stringify({ error: frameInputError }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
      if (provider === "url_asset") {
        try {
          validateUrlAssetParams(runRequest.params as Record<string, unknown>);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return new Response(
            JSON.stringify({ error: msg }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }
      let jobCharge: WorkspaceCreditCharge | null = null;
      try {
        jobCharge = await consumeWorkspaceCredits({
          supabase,
          userId: user.id,
          userEmail: user.email ?? null,
          body: runRequest,
          nodeType,
          provider,
          params: buildChargeParams(runRequest),
        });
      } catch (chargeErr) {
        const msg = chargeErr instanceof Error ? chargeErr.message : String(chargeErr);
        const status = msg === "INSUFFICIENT_CREDITS" ? 402 : 400;
        return new Response(
          JSON.stringify({
            error:
              msg === "INSUFFICIENT_CREDITS"
                ? "เครดิตไม่พอสำหรับการเจนนี้"
                : msg,
          }),
          { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: inserted, error: insertErr } = await supabase
        .from("workspace_generation_jobs")
        .insert({
          user_id: user.id,
          project_id: runRequest.project_id ?? null,
          workspace_id: runRequest.workspace_id ?? null,
          canvas_id: runRequest.canvas_id ?? null,
          node_id: runRequest.node_id ?? null,
          node_type: nodeType,
          provider,
          model,
          request: {
            ...runRequest,
            skip_credit_charge: true,
            precharged_credits: jobCharge?.amount ?? 0,
            credit_scope: jobCharge?.scope ?? "user",
            credit_organization_id: jobCharge?.organizationId ?? null,
            credit_class_id: jobCharge?.classId ?? null,
          },
          status: "queued",
          run_after: new Date().toISOString(),
          deadline_at: new Date(Date.now() + WORKSPACE_JOB_MAX_MS).toISOString(),
          max_attempts: workspaceJobMaxAttempts(provider),
          credits_charged: jobCharge?.amount ?? 0,
          credit_team_id: jobCharge?.teamId ?? null,
          credit_organization_id: jobCharge?.organizationId ?? null,
          credit_class_id: jobCharge?.classId ?? null,
          credit_scope: jobCharge?.scope ?? "user",
        })
        .select("id")
        .single();
      if (insertErr || !inserted?.id) {
        await refundWorkspaceCredits({
          supabase,
          userId: user.id,
          charge: jobCharge,
          reason: "workspace job insert failed",
          workspaceId: runRequest.workspace_id ?? null,
          canvasId: runRequest.canvas_id ?? null,
        });
        return new Response(
          JSON.stringify({ error: insertErr?.message ?? "failed to create job" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const jobId = String(inserted.id);
      const immediateWorkerSecret = await getWorkspaceWorkerSecret(supabase);
      const bgTask = immediateWorkerSecret
        ? runWorkspaceGenerationWorker({
            supabase,
            functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
            serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
            workerSecret: immediateWorkerSecret,
            requestedJobId: jobId,
          })
        : processWorkspaceGenerationJob({
            supabase,
            jobId,
            userId: user.id,
            functionUrl: `${SUPABASE_URL}/functions/v1/workspace-run-node`,
            authHeader,
          });
      const guardedBgTask = bgTask.catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[workspace-job] bg crash job=${jobId}: ${msg}`);
        const { data: crashedJob } = await supabase
          .from("workspace_generation_jobs")
          .select("*")
          .eq("id", jobId)
          .maybeSingle();
        if (crashedJob) {
          const typedJob = crashedJob as WorkspaceJobRow;
          if (["completed", "failed", "permanent_failed"].includes(String(typedJob.status))) {
            return;
          }
          if (hasRecoverableAsyncResult(typedJob)) {
            await supabase
              .from("workspace_generation_jobs")
              .update({
                status: "running",
                error: null,
                last_error:
                  "Background worker stopped before the provider finished; durable worker will continue polling.",
                locked_by: null,
                lock_expires_at: null,
                run_after: new Date(Date.now() + 15_000).toISOString(),
              })
              .eq("id", jobId);
            return;
          }
          await refundWorkspaceJobCharge({
            supabase,
            job: typedJob,
            reason: `workspace job crashed: ${msg.substring(0, 160)}`,
          });
        }
        await supabase
          .from("workspace_generation_jobs")
          .update({
            status: "failed",
            error: msg,
            last_error: msg,
            completed_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      });
      const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(guardedBgTask);
      else guardedBgTask.catch((e) => console.error("[workspace-job][bg-fallback]", e));

      return new Response(
        JSON.stringify({
          job_id: jobId,
          status: "queued",
          background: true,
          node_type: nodeType,
          provider,
          model,
          credits_spent: jobCharge?.amount ?? 0,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── On-demand Tripo URL mirror ──────────────────────────
     *
     * Tripo3D's CDN (`tripo-data.*.tripo3d.com`) does NOT send
     * `Access-Control-Allow-Origin`, so the browser blocks
     * model-viewer's WebGL fetch — the GLB never loads, only the
     * still poster image renders. The poll_tripo3d action mirrors
     * GLB+PNG into Supabase storage at task-completion time, but
     * generations created BEFORE that fix was deployed kept the
     * raw Tripo URLs and stay broken.
     *
     * This endpoint is the migration path: hand it any Tripo URL
     * and it returns a Supabase signed URL for the same asset. The
     * frontend caches the mapping per session via a hook so a tile
     * triggers ONE mirror call and reuses the result everywhere.
     *
     * Hard-whitelisted to *.tripo3d.com hosts so this can't be
     * abused as a generic open proxy. */
    if (body.action === "mirror_tripo_url") {
      const srcUrl = String(body.url ?? "").trim();
      if (!srcUrl) {
        return new Response(
          JSON.stringify({ error: "url required for mirror_tripo_url" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let hostOk = false;
      try {
        const u = new URL(srcUrl);
        hostOk =
          u.protocol === "https:" &&
          (u.hostname.endsWith(".tripo3d.com") || u.hostname === "tripo3d.com");
      } catch {
        hostOk = false;
      }
      if (!hostOk) {
        return new Response(
          JSON.stringify({ error: "Only tripo3d.com URLs may be mirrored" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Pick the extension off the path (signed URLs append a
      // long query string we want to ignore).
      const pathOnly = srcUrl.split("?")[0].split("#")[0];
      const m = pathOnly.match(/\.(glb|gltf|usdz|obj|fbx|png|jpe?g|webp|avif)$/i);
      const ext = (m?.[1] ?? "glb").toLowerCase();
      const contentType =
        ext === "gltf" ? "model/gltf+json"
        : ext === "usdz" ? "model/vnd.usdz+zip"
        : ext === "glb" ? "model/gltf-binary"
        : ext === "obj" ? "model/obj"
        : ext === "fbx" ? "application/octet-stream"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
        : ext === "avif" ? "image/avif"
        : ext === "png" ? "image/png"
        : "application/octet-stream";

      try {
        const r = await fetch(srcUrl);
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              error: `Tripo fetch failed (HTTP ${r.status})`,
              http_status: r.status,
            }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (!r.body) {
          return new Response(
            JSON.stringify({ error: "Tripo fetch missing response body" }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        // User-scoped path so the asset is owned by THIS user's
        // bucket policy. Uniqueness via timestamp + a hash of the
        // source URL keeps re-mirrors from clobbering each other.
        const hashInput = new TextEncoder().encode(srcUrl);
        const hashBuf = await crypto.subtle.digest("SHA-1", hashInput);
        const hashHex = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 16);
        const fileName = `tripo3d-mirror/${user.id}/mediaforge_${hashHex}.${ext}`;

        const { error: upErr } = await supabase.storage
          .from("ai-media")
          .upload(fileName, r.body, { contentType, upsert: true });
        if (upErr) {
          console.warn(`[tripo3d-mirror] upload err: ${upErr.message}`);
          return new Response(
            JSON.stringify({ error: `Storage upload failed: ${upErr.message}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        const { data: signed, error: signErr } = await supabase.storage
          .from("ai-media")
          .createSignedUrl(fileName, 60 * 60 * 24 * 365);
        if (signErr || !signed?.signedUrl) {
          return new Response(
            JSON.stringify({ error: `Sign URL failed: ${signErr?.message ?? "unknown"}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        console.log(`[tripo3d-mirror] ok ${ext} bytes=${buf.byteLength} path=${fileName}`);
        return new Response(
          JSON.stringify({
            url: signed.signedUrl,
            storage_path: fileName,
            bytes: buf.byteLength,
            content_type: contentType,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[tripo3d-mirror] threw: ${msg}`);
        return new Response(
          JSON.stringify({ error: `Mirror failed: ${msg}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    if (body.action === "poll_elevenlabs_dubbing") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      const outputType = String(body.output_type ?? "").toLowerCase() === "audio" ? "audio" : "video";
      try {
        const poll = await pollElevenLabsDubbing({
          req,
          userId: user.id,
          taskId,
          pollEndpoint,
          targetLang: String(body.target_lang ?? ""),
          outputLanguage: String(body.output_language ?? ""),
          outputType,
        });
        return new Response(JSON.stringify(poll), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(
          JSON.stringify({
            status: "failed",
            task_id: taskId,
            url: "",
            message,
          }),
          {
            status: elevenLabsDubbingStatusCode(err),
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    /* ─── Async poll path (Kling video tasks) ──────────────── */
    if (body.action === "poll_kling") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_kling" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Whitelist Kling host AND constrain the path EXACTLY so this
      // can't be abused as an open proxy. The previous regex matched
      // only the prefix, so a poll_endpoint like
      // `https://api.klingai.com/v1/videos/../../foo` could in theory
      // pass (URL-normalisation-dependent). Tighten to: only the four
      // known endpoints. taskId is appended by THIS handler (line
      // below), not the caller, so the endpoint here must be exactly
      // 3 path segments.
      const ALLOWED_KIND = new Set([
        "omni-video",
        "image2video",
        "text2video",
        "motion-control",
      ]);
      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        const segs = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
        // Expected: ["v1","videos","<kind>"] — exactly 3 segments.
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === "api.klingai.com" &&
          segs.length === 3 &&
          segs[0] === "v1" &&
          segs[1] === "videos" &&
          ALLOWED_KIND.has(segs[2]);
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Kling video endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const KLING_AK =
        Deno.env.get("KLING_ACCESS_KEY_ID") ??
        Deno.env.get("KLING_AK") ??
        Deno.env.get("KLING_ACCESS_KEY");
      const KLING_SK =
        Deno.env.get("KLING_SECRET_KEY") ??
        Deno.env.get("KLING_SK") ??
        Deno.env.get("KLING_SECRET");
      if (!KLING_AK || !KLING_SK) {
        return new Response(
          JSON.stringify({ error: "Kling credentials missing on server" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const jwt = await generateKlingJWT(KLING_AK, KLING_SK);
      const pollUrl = `${pollEndpoint}/${encodeURIComponent(taskId)}`;
      const r = await fetch(pollUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return new Response(
          JSON.stringify({
            status: "polling_error",
            http_status: r.status,
            message: errText.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const payload = await r.json().catch(() => ({} as Record<string, unknown>));
      const data = (payload?.data ?? {}) as Record<string, unknown>;
      const status = String(data.task_status ?? "").toLowerCase();
      const statusMsg = String(data.task_status_msg ?? payload?.message ?? "");
      let videoUrl = "";
      if (status === "succeed" || status === "success") {
        const tr = (data.task_result ?? {}) as Record<string, unknown>;
        const videos = Array.isArray(tr.videos) ? (tr.videos as Array<Record<string, unknown>>) : [];
        videoUrl = videos.length > 0 ? String(videos[0]?.url ?? "") : "";

        // Mirror the Kling CDN video into `user_assets` so the workspace
        // library has a stable signed URL — Kling's hosted URLs expire
        // within a short TTL, and without this the saved generation
        // becomes a broken link a few hours/days later AND nothing
        // ever lands in the user's asset library. Matches the pattern
        // poll_veo and poll_replicate_* already use. Falls back to
        // the raw Kling URL on mirror failure so the run still
        // completes — the user just keeps an ephemeral link.
        if (videoUrl) {
          try {
            const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
            const path = `${user.id}/kling-renders/mediaforge_${safeTaskId}.mp4`;
            const mirrored = await mirrorRemoteMedia({
              supabase,
              sourceUrl: videoUrl,
              bucket: "user_assets",
              path,
              fallbackContentType: "video/mp4",
              signedUrlTtlSeconds: 60 * 60 * 24 * 365,
              maxBufferBytes: WORKSPACE_VIDEO_MIRROR_MAX_BYTES,
              allowRawUrlFallback: true,
              label: "poll_kling",
            });
            videoUrl = mirrored.url;
            if (mirrored.mirrored) console.log(`[poll_kling] mirrored video path=${path}`);
          } catch (err) {
            console.warn(
              `[poll_kling] storage mirror failed, falling back to Kling URL: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
      return new Response(
        JSON.stringify({
          status,             // "submitted" | "processing" | "succeed" | "failed"
          task_id: taskId,
          url: videoUrl,
          message: statusMsg,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Seedance / Volcengine Ark video tasks) ──
     * Bytedance Seedance jobs typically land in 30-180s. Like Kling we
     * return immediately on submit and let the frontend re-fire this
     * action every few seconds. Whitelisted host so the action can't
     * be abused as an open proxy. */
    if (body.action === "poll_seedance") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_seedance" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        const seedanceBaseHost = new URL(SEEDANCE_BASE).hostname;
        // Volcengine/BytePlus Ark hosts are allowed; path must be
        // exactly the tasks endpoint (we append /{taskId} below).
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === seedanceBaseHost ||
            u.hostname === "ark.cn-beijing.volces.com" ||
            u.hostname.endsWith(".bytepluses.com") ||
            u.hostname.endsWith(".byteplusapi.com")) &&
          u.pathname.replace(/\/+$/, "") === SEEDANCE_TASKS_PATH;
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Seedance tasks endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let creds;
      try {
        const pollModel = String(body.model ?? body.provider_model_id ?? "").toLowerCase();
        const isV2Poll = pollModel.includes("seedance-2-0");
        creds = loadSeedanceCredentials({ v2: isV2Poll });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let statusObj;
      try {
        statusObj = await pollSeedanceOnce(taskId, creds.apiKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const rawStatus = String(statusObj.status ?? "").toLowerCase();
      // Normalise Volcengine status terms to the same vocabulary as
      // poll_kling so the frontend can use one polling hook.
      const normalised =
        rawStatus === "succeeded" || rawStatus === "success"
          ? "succeed"
          : rawStatus === "failed" || rawStatus === "fail" || rawStatus === "cancelled"
            ? "failed"
            : rawStatus === "running"
              ? "processing"
              : rawStatus || "submitted";
      let videoUrl =
        normalised === "succeed" ? String(statusObj.content?.video_url ?? "") : "";
      const rawMessage =
        statusObj.error?.message ?? (normalised === "failed" ? "Task failed" : "");
      // Replace cryptic provider strings (e.g. "The request failed because
      // the output audio may contain sensitive information") with an
      // actionable message before the frontend writes it to
      // workspace_generation_jobs.error_message and surfaces it as a
      // toast.
      const message = humanizeSeedanceErrorMessage(rawMessage);

      // Mirror the BytePlus CDN video into `user_assets` — same rationale
      // as poll_kling: provider URL is short-lived and never reaches the
      // asset library otherwise. Fallback keeps the raw URL on mirror
      // failure.
      if (videoUrl) {
        try {
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const path = `${user.id}/seedance-renders/mediaforge_${safeTaskId}.mp4`;
          const mirrored = await mirrorRemoteMedia({
            supabase,
            sourceUrl: videoUrl,
            bucket: "user_assets",
            path,
            fallbackContentType: "video/mp4",
            signedUrlTtlSeconds: 60 * 60 * 24 * 365,
            maxBufferBytes: WORKSPACE_VIDEO_MIRROR_MAX_BYTES,
            allowRawUrlFallback: true,
            label: "poll_seedance",
          });
          videoUrl = mirrored.url;
          if (mirrored.mirrored) console.log(`[poll_seedance] mirrored video path=${path}`);
        } catch (err) {
          console.warn(
            `[poll_seedance] storage mirror failed, falling back to BytePlus URL: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: videoUrl,
          message,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Freepik/Magnific Veo 3.1 tasks) ───
     * Used as a capacity fallback when direct Google Gemini Veo quota is
     * exhausted. Magnific returns { data: { status, generated[] } }; on
     * terminal success we mirror the provider URL into Supabase storage so
     * the browser sees the same signed-URL shape as direct Veo. */
    if (body.action === "poll_replicate_veo" || body.action === "poll_replicate_video" || body.action === "poll_replicate_image") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      const isReplicateVeoPoll = body.action === "poll_replicate_veo";
      const isReplicateImagePoll = body.action === "poll_replicate_image";
      const replicateLabel = isReplicateImagePoll
        ? "Replicate image"
        : isReplicateVeoPoll
          ? "Replicate Veo"
          : "Replicate video";
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for Replicate polling" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === "api.replicate.com" &&
          /^\/v1\/predictions\/?$/.test(u.pathname);
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Replicate predictions endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const apiToken = Deno.env.get("REPLICATE_API_TOKEN")?.trim();
      if (!apiToken) {
        return new Response(
          JSON.stringify({ error: "REPLICATE_API_TOKEN is not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let payload: Record<string, unknown>;
      try {
        const r = await fetch(`${pollEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const text = await r.text();
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              status: "polling_error",
              message: `${replicateLabel} poll failed (HTTP ${r.status}): ${text.slice(0, 300)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const rawStatus = String(payload.status ?? "").toLowerCase();
      const providerOutputUrl = extractReplicateOutputUrl(payload.output);
      const normalised =
        rawStatus === "succeeded" || providerOutputUrl
          ? "succeed"
          : rawStatus === "failed" || rawStatus === "canceled" || rawStatus === "cancelled"
            ? "failed"
            : "processing";
      const errorMessage = String(payload.error ?? "");

      let publicUrl = "";
      if (normalised === "succeed" && providerOutputUrl) {
        try {
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const ext = isReplicateImagePoll ? "png" : "mp4";
          const bucket = isReplicateImagePoll ? "ai-media" : "user_assets";
          const folder = isReplicateImagePoll
            ? "pipeline"
            : isReplicateVeoPoll
              ? `${user.id}/veo-renders`
              : `${user.id}/replicate-video-renders`;
          const path = `${folder}/replicate_${safeTaskId}.${ext}`;
          const mirrored = await mirrorRemoteMedia({
            supabase,
            sourceUrl: providerOutputUrl,
            bucket,
            path,
            fallbackContentType: isReplicateImagePoll ? "image/png" : "video/mp4",
            signedUrlTtlSeconds: isReplicateImagePoll ? 60 * 60 * 24 * 7 : 60 * 60 * 24 * 365,
            maxBufferBytes: isReplicateImagePoll ? WORKSPACE_IMAGE_MIRROR_MAX_BYTES : WORKSPACE_VIDEO_MIRROR_MAX_BYTES,
            allowRawUrlFallback: !isReplicateImagePoll,
            label: "poll_replicate",
          });
          publicUrl = mirrored.url;
        } catch (err) {
          if (!isReplicateImagePoll) {
            console.warn(
              `[poll_replicate] video rehost failed, falling back to provider URL: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            publicUrl = providerOutputUrl;
          } else {
            console.error("[poll_replicate] rehost failed:", err);
          }
          if (!publicUrl) {
            return new Response(
              JSON.stringify({
                status: "failed",
                task_id: taskId,
                url: "",
                message: `${replicateLabel} finished but the output couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
          message: normalised === "failed" ? errorMessage || `${replicateLabel} task failed` : rawStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "poll_freepik_veo" || body.action === "poll_freepik_video") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_freepik_video" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === "api.magnific.com" || u.hostname === "api.freepik.com") &&
          /^\/v1\/ai\/(?:text-to-video|image-to-video|reference-to-video)\/(?:veo-3-1(?:-fast)?|seedance-(?:pro|lite)-(?:480p|720p|1080p)|seedance-1-5-pro-(?:480p|720p|1080p))\/?$/.test(
            u.pathname,
          );
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Magnific/Freepik video endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let apiKey: string;
      try {
        apiKey = loadMagnificApiKey();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const pollUrl = `${pollEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`;
      let payload: Record<string, unknown>;
      try {
        const endpointHost = new URL(pollEndpoint).hostname;
        const authHeaderName = endpointHost.includes("magnific.com")
          ? "x-magnific-api-key"
          : "x-freepik-api-key";
        const r = await fetch(pollUrl, {
          method: "GET",
          headers: {
            [authHeaderName]: apiKey,
          },
        });
        const text = await r.text();
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              status: "polling_error",
              message: `Freepik/Magnific video poll failed (HTTP ${r.status}): ${text.slice(0, 300)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const data = payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : payload;
      const rawStatus = String(data.status ?? payload.status ?? "").toUpperCase();
      const generated = Array.isArray(data.generated)
        ? data.generated
        : Array.isArray(payload.generated)
          ? payload.generated
          : [];
      const providerVideoUrl = generated
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const row = item as Record<string, unknown>;
            return String(row.url ?? row.video_url ?? row.download_url ?? "").trim();
          }
          return "";
        })
        .find((url) => /^https:\/\//i.test(url)) ?? "";
      const errorMessage = String(
        data.error ??
          data.message ??
          payload.error ??
          payload.message ??
          "",
      );
      const normalised =
        rawStatus === "COMPLETED" || rawStatus === "DONE" || rawStatus === "SUCCEEDED" || providerVideoUrl
          ? "succeed"
          : rawStatus === "FAILED" || rawStatus === "ERROR" || rawStatus === "CANCELLED" || rawStatus === "CANCELED"
            ? "failed"
            : "processing";

      let publicUrl = "";
      if (normalised === "succeed" && providerVideoUrl) {
        try {
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const path = `${user.id}/video-renders/freepik_${safeTaskId}.mp4`;
          const mirrored = await mirrorRemoteMedia({
            supabase,
            sourceUrl: providerVideoUrl,
            bucket: "user_assets",
            path,
            fallbackContentType: "video/mp4",
            signedUrlTtlSeconds: 60 * 60 * 24 * 365,
            maxBufferBytes: WORKSPACE_VIDEO_MIRROR_MAX_BYTES,
            allowRawUrlFallback: true,
            label: "poll_freepik_video",
          });
          publicUrl = mirrored.url;
        } catch (err) {
          console.warn(
            `[poll_freepik_video] rehost failed, falling back to provider URL: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          publicUrl = providerVideoUrl;
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
          message: normalised === "failed" ? errorMessage || "Freepik/Magnific Veo task failed" : rawStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Google Veo 3.1 video tasks) ─────────
     * Veo's REST API is a long-running operation: we POSTed a task
     * and got back a Gemini operation name (returned to the frontend
     * in `task_id`). Each poll is a GET against generativelanguage
     * with the API key. The frontend uses the same polling hook as
     * Kling/Seedance — we normalise statuses and surface the video URL
     * once the operation reports `done: true`. */
    if (body.action === "poll_freepik_image") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_freepik_image" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === "api.magnific.com" || u.hostname === "api.freepik.com") &&
          /^\/v1\/ai\/text-to-image\/(?:nano-banana-pro|nano-banana-pro-flash)\/?$/.test(u.pathname);
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Magnific/Freepik Banana image endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let apiKey: string;
      try {
        apiKey = loadMagnificApiKey();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const pollUrl = `${pollEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`;
      let payload: Record<string, unknown>;
      try {
        const endpointHost = new URL(pollEndpoint).hostname;
        const authHeaderName = endpointHost.includes("magnific.com")
          ? "x-magnific-api-key"
          : "x-freepik-api-key";
        const r = await fetch(pollUrl, {
          method: "GET",
          headers: {
            [authHeaderName]: apiKey,
          },
        });
        const text = await r.text();
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              status: "polling_error",
              message: `Freepik/Magnific Banana poll failed (HTTP ${r.status}): ${text.slice(0, 300)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const data = payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : payload;
      const rawStatus = String(data.status ?? payload.status ?? "").toUpperCase();
      const generated = Array.isArray(data.generated)
        ? data.generated
        : Array.isArray(payload.generated)
          ? payload.generated
          : [];
      const providerImageUrl = extractProviderMediaUrl(generated);
      const errorMessage = String(
        data.error ??
          data.message ??
          payload.error ??
          payload.message ??
          "",
      );
      const normalised =
        rawStatus === "COMPLETED" || rawStatus === "DONE" || rawStatus === "SUCCEEDED" || providerImageUrl
          ? "succeed"
          : rawStatus === "FAILED" || rawStatus === "ERROR" || rawStatus === "CANCELLED" || rawStatus === "CANCELED"
            ? "failed"
            : "processing";

      let publicUrl = "";
      if (normalised === "succeed" && providerImageUrl) {
        try {
          const imageRes = await fetch(providerImageUrl);
          if (!imageRes.ok) {
            throw new Error(`download HTTP ${imageRes.status}`);
          }
          if (!imageRes.body) throw new Error("download response missing body");
          const contentType = imageRes.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
          const ext =
            contentType.includes("jpeg") ? "jpg" :
            contentType.includes("webp") ? "webp" :
            contentType.includes("png") ? "png" :
            "png";
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const path = `pipeline/magnific_banana_${safeTaskId}.${ext}`;
          const upload = await supabase.storage
            .from("ai-media")
            .upload(path, imageRes.body, { contentType, upsert: true });
          if (upload.error) throw upload.error;
          const signed = await supabase.storage
            .from("ai-media")
            .createSignedUrl(path, 60 * 60 * 24 * 7);
          if (signed.error || !signed.data?.signedUrl) {
            throw signed.error ?? new Error("no signed URL");
          }
          publicUrl = signed.data.signedUrl;
        } catch (err) {
          console.error("[poll_freepik_image] rehost failed:", err);
          return new Response(
            JSON.stringify({
              status: "failed",
              task_id: taskId,
              url: "",
              message: `Freepik/Magnific Banana finished but the image couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
          message: normalised === "failed" ? errorMessage || "Freepik/Magnific Banana task failed" : rawStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "poll_magnific_upscale") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_magnific_upscale" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      let isVideoUpscale = false;
      try {
        const u = new URL(pollEndpoint);
        const normalizedPath = u.pathname.replace(/\/+$/, "");
        const normalizedEndpointPath = normalizedPath.startsWith("/v1/")
          ? normalizedPath.slice(3)
          : normalizedPath;
        const isImageUpscale = normalizedEndpointPath === MAGNIFIC_UPSCALE_PATH;
        isVideoUpscale = normalizedEndpointPath === MAGNIFIC_VIDEO_UPSCALE_PATH;
        pollUrlOk =
          u.protocol === "https:" &&
          (u.hostname === "api.magnific.com" || u.hostname === "api.freepik.com") &&
          (isImageUpscale || isVideoUpscale);
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Magnific image or video upscale endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let apiKey: string;
      try {
        apiKey = loadMagnificApiKey();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const pollUrl = `${pollEndpoint.replace(/\/+$/, "")}/${encodeURIComponent(taskId)}`;
      let payload: Record<string, unknown>;
      try {
        const endpointHost = new URL(pollEndpoint).hostname;
        const authHeaderName = endpointHost.includes("magnific.com")
          ? "x-magnific-api-key"
          : "x-freepik-api-key";
        const r = await fetch(pollUrl, {
          method: "GET",
          headers: { [authHeaderName]: apiKey },
        });
        const text = await r.text();
        if (!r.ok) {
          return new Response(
            JSON.stringify({
              status: "polling_error",
              message: `Magnific upscale poll failed (HTTP ${r.status}): ${text.slice(0, 300)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const data = payload.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : payload;
      const rawStatus = String(data.status ?? payload.status ?? "").toUpperCase();
      const generated = Array.isArray(data.generated)
        ? data.generated
        : Array.isArray(payload.generated)
          ? payload.generated
          : [];
      const providerCandidates = uniqueProviderMediaUrls([
        ...collectProviderMediaUrls(generated),
        ...collectProviderMediaUrls(data),
        ...collectProviderMediaUrls(payload),
      ]);
      const selectedCandidate = providerCandidates.length === 0
        ? null
        : isVideoUpscale
          ? { url: providerCandidates[0], index: 0 }
          : await chooseLargestImageCandidate(providerCandidates);
      const providerMediaUrl =
        selectedCandidate?.url ||
        extractProviderMediaUrl(generated) ||
        extractProviderMediaUrl(data) ||
        extractProviderMediaUrl(payload);
      const errorMessage = String(
        data.error ??
          data.message ??
          payload.error ??
          payload.message ??
          "",
      );
      const normalised =
        rawStatus === "COMPLETED" || rawStatus === "DONE" || rawStatus === "SUCCEEDED" || providerMediaUrl
          ? "succeed"
          : rawStatus === "FAILED" || rawStatus === "ERROR" || rawStatus === "CANCELLED" || rawStatus === "CANCELED"
            ? "failed"
            : "processing";

      let publicUrl = "";
      if (normalised === "succeed" && providerMediaUrl) {
        try {
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const mirrored = await mirrorRemoteMedia({
            supabase,
            sourceUrl: providerMediaUrl,
            bucket: "ai-media",
            path: `pipeline/magnific_upscale_${safeTaskId}.${isVideoUpscale ? "mp4" : "png"}`,
            fallbackContentType: isVideoUpscale ? "video/mp4" : "image/png",
            signedUrlTtlSeconds: 60 * 60 * 24 * 365,
            maxBufferBytes: isVideoUpscale ? WORKSPACE_VIDEO_MIRROR_MAX_BYTES : WORKSPACE_IMAGE_MIRROR_MAX_BYTES,
            allowRawUrlFallback: isVideoUpscale,
            label: "poll_magnific_upscale",
          });
          publicUrl = mirrored.url;
        } catch (err) {
          console.error("[poll_magnific_upscale] rehost failed:", err);
          return new Response(
            JSON.stringify({
              status: "failed",
              task_id: taskId,
              url: "",
              message: `Magnific upscale finished but the ${isVideoUpscale ? "video" : "image"} couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          type: isVideoUpscale ? "video" : "image",
          output_type: isVideoUpscale ? "video_url" : "image_url",
          url: publicUrl,
          provider_meta: {
            candidate_count: providerCandidates.length,
            selected_candidate_index: selectedCandidate?.index ?? null,
            ...(selectedCandidate?.width && selectedCandidate?.height
              ? {
                  selected_width: selectedCandidate.width,
                  selected_height: selectedCandidate.height,
                }
              : {}),
          },
          message: normalised === "failed" ? errorMessage || "Magnific upscale task failed" : rawStatus,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (body.action === "poll_veo") {
      const taskId = normalizeVeoOperationName(String(body.task_id ?? ""));
      if (!taskId) {
        return new Response(
          JSON.stringify({
            error:
              "task_id must be a Veo operation name (operations/... or models/.../operations/...)",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let apiKey: string;
      try {
        const apiKeyAlias = String(body.api_key_alias ?? "") === "gemini2" ? "gemini2" : "primary";
        apiKey = loadVeoApiKey(apiKeyAlias);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      let statusObj;
      try {
        statusObj = await pollVeoOnce(taskId, apiKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const isDone = statusObj.done === true;
      const videoUri = extractVeoVideoUri(statusObj);
      const opError = statusObj.error ? formatVeoPollFailure(statusObj) : "";
      const normalised = !isDone
        ? "processing"
        : opError
          ? "failed"
          : videoUri
            ? "succeed"
            : "failed";

      // Veo's `video.uri` requires the API key as `?key=` to download.
      // We never want that key exposed to the browser, so on success
      // we fetch the bytes server-side and re-host into the
      // `user_assets` Supabase bucket. The frontend gets a 1-year
      // signed URL — same pattern Google TTS uses for synthesised
      // audio. The taskId (operations/<id>) gives us a stable,
      // collision-free path so a second poll after success doesn't
      // re-upload (upsert: false would 409, which is fine — the
      // existing object stays usable).
      let publicUrl = "";
      if (normalised === "succeed" && videoUri) {
        try {
          const downloadUrl = `${videoUri}${videoUri.includes("?") ? "&" : "?"}key=${apiKey}`;
          const videoRes = await fetch(downloadUrl);
          if (!videoRes.ok) {
            throw new Error(`download HTTP ${videoRes.status}`);
          }
          if (!videoRes.body) throw new Error("download response missing body");
          const opId = taskId.replace(/^operations\//, "").replace(/[^a-zA-Z0-9_-]/g, "_");
          const path = `veo-renders/mediaforge_${opId}.mp4`;
          const upload = await supabase.storage
            .from("user_assets")
            .upload(path, videoRes.body, { contentType: "video/mp4", upsert: true });
          if (upload.error) throw upload.error;
          const signed = await supabase.storage
            .from("user_assets")
            .createSignedUrl(path, 60 * 60 * 24 * 365);
          if (signed.error || !signed.data?.signedUrl) {
            throw signed.error ?? new Error("no signed URL");
          }
          publicUrl = signed.data.signedUrl;
        } catch (err) {
          console.error("[poll_veo] rehost failed:", err);
          return new Response(
            JSON.stringify({
              status: "failed",
              task_id: taskId,
              url: "",
              message: `Veo finished but the video couldn't be saved: ${err instanceof Error ? err.message : String(err)}`,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      const message =
        opError || (normalised === "failed" ? formatVeoPollFailure(statusObj) : "");
      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: publicUrl,
          message,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Hyper3D / BytePlus Ark 3D tasks) ───
     * Same short-poll pattern as Seedance, but the terminal payload
     * carries a model URL instead of a video URL. */
    if (body.action === "poll_hyper3d") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_hyper3d" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        const allowedBase = new URL(HYPER3D_BASE);
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === allowedBase.hostname &&
          u.pathname.replace(/\/+$/, "") === HYPER3D_TASKS_PATH;
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be a Hyper3D tasks endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let creds;
      try {
        creds = loadSeedanceCredentials();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({ error: msg }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      let statusObj;
      try {
        statusObj = await pollHyper3dOnce(taskId, creds.apiKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(
          JSON.stringify({
            status: "polling_error",
            message: msg.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const rawStatus = String(statusObj.status ?? "").toLowerCase();
      const normalised =
        rawStatus === "succeeded" || rawStatus === "success"
          ? "succeed"
          : rawStatus === "failed" || rawStatus === "fail" || rawStatus === "cancelled"
            ? "failed"
            : rawStatus === "running"
              ? "processing"
              : rawStatus || "submitted";
      let modelUrl = normalised === "succeed" ? pickHyper3dModelUrl(statusObj) : "";
      let previewImage =
        normalised === "succeed" ? String(statusObj.content?.rendered_image_url ?? "") : "";
      const message =
        statusObj.error?.message ?? (normalised === "failed" ? "Task failed" : "");

      // Mirror both the GLB and the rendered preview into `ai-media`.
      // Same rationale as poll_tripo3d (line 10755+): BytePlus URLs are
      // short-lived and CORS-restricted, so model-viewer fails to load
      // the GLB cross-origin AND nothing reaches the asset library.
      // Either mirror failing falls back to the raw URL so the run
      // still surfaces something useful.
      if (normalised === "succeed") {
        const mirror = async (
          srcUrl: string,
          ext: string,
          contentType: string,
        ): Promise<string | null> => {
          try {
            const r = await fetch(srcUrl);
            if (!r.ok) {
              console.warn(`[hyper3d] mirror ${ext} fetch ${r.status}`);
              return null;
            }
            if (!r.body) {
              console.warn(`[hyper3d] mirror ${ext} missing response body`);
              return null;
            }
            const fileName = `hyper3d/${taskId}/mediaforge_${Date.now()}.${ext}`;
            const { error: upErr } = await supabase.storage
              .from("ai-media")
              .upload(fileName, r.body, { contentType, upsert: true });
            if (upErr) {
              console.warn(`[hyper3d] mirror ${ext} upload err: ${upErr.message}`);
              return null;
            }
            const { data: signed, error: signErr } = await supabase.storage
              .from("ai-media")
              .createSignedUrl(fileName, 60 * 60 * 24 * 365);
            if (signErr || !signed?.signedUrl) {
              console.warn(`[hyper3d] mirror ${ext} sign err: ${signErr?.message}`);
              return null;
            }
            return signed.signedUrl;
          } catch (err) {
            console.warn(`[hyper3d] mirror ${ext} threw:`, err);
            return null;
          }
        };

        if (modelUrl) {
          const m = modelUrl.match(/\.(glb|gltf|usdz|obj|fbx)(?=\?|#|$)/i);
          const ext = (m?.[1] ?? "glb").toLowerCase();
          const contentType =
            ext === "gltf" ? "model/gltf+json"
            : ext === "usdz" ? "model/vnd.usdz+zip"
            : "model/gltf-binary";
          const mirrored = await mirror(modelUrl, ext, contentType);
          if (mirrored) modelUrl = mirrored;
        }
        if (previewImage) {
          const m = previewImage.match(/\.(png|jpe?g|webp|avif)(?=\?|#|$)/i);
          const ext = (m?.[1] ?? "png").toLowerCase();
          const contentType =
            ext === "jpg" || ext === "jpeg" ? "image/jpeg"
            : ext === "webp" ? "image/webp"
            : ext === "avif" ? "image/avif"
            : "image/png";
          const mirrored = await mirror(previewImage, ext, contentType);
          if (mirrored) previewImage = mirrored;
        }
      }

      return new Response(
        JSON.stringify({
          status: normalised,
          task_id: taskId,
          url: previewImage || modelUrl,
          model_url: modelUrl,
          preview_image: previewImage,
          message,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    /* ─── Async poll path (Tripo3D 3D-model tasks) ──────────
     * Each call is one quick GET to api.tripo3d.ai/v2/openapi/task
     * — no risk of edge-fn worker timeout even on multi-minute
     * jobs. Frontend re-fires this every 4-5s until status flips
     * to success / failed. */
    if (body.action === "poll_tripo3d") {
      const taskId = String(body.task_id ?? "").trim();
      const pollEndpoint = String(body.poll_endpoint ?? "").trim();
      if (!taskId || !pollEndpoint) {
        return new Response(
          JSON.stringify({ error: "task_id and poll_endpoint required for poll_tripo3d" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      // Whitelist Tripo3D host so this can't be abused as an open
      // proxy. Path must be exactly `/v2/openapi/task` (we append
      // `/{taskId}` here on the server).
      let pollUrlOk = false;
      try {
        const u = new URL(pollEndpoint);
        pollUrlOk =
          u.protocol === "https:" &&
          u.hostname === "api.tripo3d.ai" &&
          u.pathname.replace(/\/+$/, "") === "/v2/openapi/task";
      } catch {
        pollUrlOk = false;
      }
      if (!pollUrlOk) {
        return new Response(
          JSON.stringify({ error: "poll_endpoint must be the Tripo3D /v2/openapi/task endpoint" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const KEY =
        Deno.env.get("TRIO_API_KEY") ??
        Deno.env.get("TRIPO_API_KEY") ??
        Deno.env.get("TRIPO3D_API_KEY");
      if (!KEY) {
        return new Response(
          JSON.stringify({ error: "Tripo3D credentials missing on server" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const pollUrl = `${pollEndpoint}/${encodeURIComponent(taskId)}`;
      const r = await fetch(pollUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${KEY}` },
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return new Response(
          JSON.stringify({
            status: "polling_error",
            http_status: r.status,
            message: errText.substring(0, 300),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const payload = (await r.json().catch(() => ({}))) as {
        code?: number;
        data?: Record<string, unknown>;
      };
      const data = (payload?.data ?? {}) as Record<string, unknown>;
      const status = String(data.status ?? "").toLowerCase();
      const progress = Number(data.progress ?? 0);
      const block = (data.output ?? data.result ?? {}) as Record<string, unknown>;

      // Dump the raw output object so we can see EXACTLY what fields
      // Tripo3D returns. Crucial for debugging when the user reports
      // "got a webm not a GLB" — the offending field is right here.
      // Truncate to keep edge-fn logs readable.
      console.log(
        `[tripo3d] task=${taskId.slice(0, 8)} status=${status} progress=${progress} ` +
          `output_keys=${Object.keys(block).join(",")} ` +
          `output_preview=${JSON.stringify(block).slice(0, 600)}`,
      );

      const extractUrl = (v: unknown): string => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object" && "url" in (v as Record<string, unknown>)) {
          const inner = (v as Record<string, unknown>).url;
          if (typeof inner === "string") return inner;
        }
        return "";
      };

      /* Strict GLB filter — Tripo3D's `output` object contains a
       * MIX of asset URLs. Some fields point to GLB / GLTF (3D
       * meshes), others to PNG / WebM (preview thumbnails or
       * turntable videos). model-viewer can ONLY render mesh
       * formats; hand it a webm and it silently shows the poster,
       * which looks like the previous "static image" bug.
       *
       * We extract every candidate URL, then pick the first one
       * whose extension is a known 3D mesh format. Anything else
       * lands in the preview-image fallback path. */
      const isMeshUrl = (u: string): boolean =>
        /\.(glb|gltf|usdz|obj|fbx)(\?|#|$)/i.test(u);
      const isImageUrl = (u: string): boolean =>
        /\.(png|jpe?g|webp|avif)(\?|#|$)/i.test(u);

      // Pull every URL the response carries — under every common
      // field name we've seen Tripo3D use.
      const candidateFields = [
        "pbr_model",
        "model",
        "base_model",
        "glb",
        "gltf",
        "usdz",
        "rendered_image",
        "preview_image",
        "thumbnail_image",
        "image",
        "video_thumbnail",
        "rendered_video",
      ];
      const candidates: string[] = [];
      for (const k of candidateFields) {
        const u = extractUrl(block[k]);
        if (u) candidates.push(u);
      }
      // Also walk any unknown string-valued fields — Tripo could
      // rename a field on a future model version and we'd miss it.
      for (const [k, v] of Object.entries(block)) {
        if (candidateFields.includes(k)) continue;
        const u = extractUrl(v);
        if (u && !candidates.includes(u)) candidates.push(u);
      }

      const tripoModelUrl = candidates.find(isMeshUrl) ?? "";
      const tripoRenderedImage = candidates.find(isImageUrl) ?? "";

      /* Mirror Tripo3D outputs into our own storage —
       * Tripo's CDN (`tripo-data.cdn.bcebos.com`) doesn't serve the
       * `Access-Control-Allow-Origin` header that <model-viewer>
       * needs for its WebGL fetch, so the GLB silently fails to
       * load and the user sees only the poster image. Re-hosting in
       * Supabase storage solves both CORS and URL expiry in one
       * shot, the same way we already mirror OpenAI / Kling outputs.
       *
       * Mirror only fires on the terminal "succeed" status so we
       * don't waste bandwidth on every progress poll. If mirroring
       * fails (network blip, oversize file, etc.) we silently fall
       * back to the raw Tripo URL — model-viewer will use the
       * poster as before, but at least the GLB stays downloadable. */
      let modelUrl = tripoModelUrl;
      let renderedImage = tripoRenderedImage;
      const isTerminalSuccess = status === "succeed" || status === "success";
      if (isTerminalSuccess) {
        const mirror = async (
          srcUrl: string,
          ext: string,
          contentType: string,
        ): Promise<string | null> => {
          try {
            const r = await fetch(srcUrl);
            if (!r.ok) {
              console.warn(`[tripo3d] mirror ${ext} fetch ${r.status}`);
              return null;
            }
            if (!r.body) {
              console.warn(`[tripo3d] mirror ${ext} missing response body`);
              return null;
            }
            const fileName = `tripo3d/${taskId}/mediaforge_${Date.now()}.${ext}`;
            const { error: upErr } = await supabase.storage
              .from("ai-media")
              .upload(fileName, r.body, { contentType, upsert: true });
            if (upErr) {
              console.warn(`[tripo3d] mirror ${ext} upload err: ${upErr.message}`);
              return null;
            }
            const { data: signed, error: signErr } = await supabase.storage
              .from("ai-media")
              .createSignedUrl(fileName, 60 * 60 * 24 * 365); // 1 year
            if (signErr || !signed?.signedUrl) {
              console.warn(`[tripo3d] mirror ${ext} sign err: ${signErr?.message}`);
              return null;
            }
            return signed.signedUrl;
          } catch (err) {
            console.warn(`[tripo3d] mirror ${ext} threw:`, err);
            return null;
          }
        };

        if (tripoModelUrl) {
          // Pick the actual extension from the URL so we keep .glb /
          // .gltf / .usdz semantics intact for model-viewer.
          const m = tripoModelUrl.match(/\.(glb|gltf|usdz|obj|fbx)(?=\?|#|$)/i);
          const ext = (m?.[1] ?? "glb").toLowerCase();
          const contentType = ext === "gltf" ? "model/gltf+json"
            : ext === "usdz" ? "model/vnd.usdz+zip"
            : "model/gltf-binary"; // .glb default; .obj/.fbx fall through
          const mirrored = await mirror(tripoModelUrl, ext, contentType);
          if (mirrored) modelUrl = mirrored;
        }
        if (tripoRenderedImage) {
          const m = tripoRenderedImage.match(/\.(png|jpe?g|webp|avif)(?=\?|#|$)/i);
          const ext = (m?.[1] ?? "png").toLowerCase();
          const contentType =
            ext === "jpg" || ext === "jpeg" ? "image/jpeg"
            : ext === "webp" ? "image/webp"
            : ext === "avif" ? "image/avif"
            : "image/png";
          const mirrored = await mirror(tripoRenderedImage, ext, contentType);
          if (mirrored) renderedImage = mirrored;
        }
        console.log(
          `[tripo3d] mirror done glb=${modelUrl !== tripoModelUrl ? "ok" : "passthru"} ` +
            `img=${renderedImage !== tripoRenderedImage ? "ok" : "passthru"}`,
        );
      }

      // Surface a normalised payload — frontend treats `succeed` /
      // `success` as terminal-positive, `failed` as terminal-negative,
      // anything else as still-running.
      return new Response(
        JSON.stringify({
          status,           // queued | running | success | failed
          progress,
          task_id: taskId,
          // For UI parity with poll_kling we put the rendered image
          // URL here so the frontend can swap the placeholder for a
          // real preview the moment it lands.
          url: renderedImage || modelUrl,
          model_url: modelUrl,
          preview_image: renderedImage,
          message: payload?.data?.message ?? "",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const normalizedReplicateModel = normalizeDirectReplicateModelForPrimary(body);
    if (normalizedReplicateModel) {
      console.warn(
        `[workspace-run] direct Replicate model normalized to primary model=${normalizedReplicateModel}`,
      );
    }

    const nodeType = String(body.node_type ?? "");
    const rawParams = body.params ?? {};
    const inputs = body.inputs ?? {};
    const mentioned = body.mentioned_assets ?? [];

    if (!nodeType) {
      return new Response(
        JSON.stringify({ error: "node_type is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const provider = getProviderForNodeType(
      nodeType,
      rawParams.model_name as string | undefined,
    );

    /* ─── Build resolved params ───────────────────────────── */
    // Start from caller params, then overlay edge-resolved inputs
    // (mapped through HANDLE_SCHEMA so e.g. ref_image → image_url)
    // and mention URLs as a fallback ref_image / mention_image_urls.
    const params: Record<string, unknown> = { ...rawParams };
    normalizeWorkspaceProviderModel(provider, params);

    // Did the caller provide a text prompt via an upstream Text edge?
    // Used to populate the response's prompt_source field.
    const textInputUsed =
      typeof inputs.text === "string" ||
      typeof inputs.context === "string" ||
      typeof inputs.context_text === "string";
    // Prefer the upstream Text wire whenever the node's own Prompt
    // field is empty OR whitespace-only. The previous truthy check
    // let prompts of "\n" (or " ") through, which both made
    // executeBanana receive a literal newline AND skipped the
    // @[mention](id) tokens that lived in `inputs.text` — the model
    // then saw context block but no instruction, and just remixed
    // the refs randomly.
    const promptParamIsBlank = !String(params.prompt ?? "").trim();
    if (typeof inputs.text === "string" && promptParamIsBlank) {
      params.prompt = inputs.text;
    }
    const contextParamIsBlank = !String(params.context_text ?? "").trim();
    if (typeof inputs.context === "string" && contextParamIsBlank) {
      params.context_text = inputs.context;
    }

    // Edge inputs → internal_key via HANDLE_SCHEMA.
    // Frontend may send a single value OR an array of values per
    // targetHandle (when the user wires multiple sources into the same
    // image port — e.g. 14 refs into Banana). Normalise to array first.
    const edgeImageUrls: string[] = [];
    for (const [targetHandle, value] of Object.entries(inputs)) {
      // text/context already mapped above
      if (targetHandle === "text" || targetHandle === "context") continue;

      const values = Array.isArray(value) ? value : [value];

      // Object/array values bypass the URL string path entirely —
      // they're complex payloads (e.g. ElementNode → Kling Omni
      // `elements`: [{name, reference_image_urls, frontal_image_url}]).
      // Map through HANDLE_SCHEMA when the handle is registered, else
      // pass through to params verbatim.
      const objectVals = values.filter(
        (v): v is Record<string, unknown> =>
          v !== null && typeof v === "object" && !Array.isArray(v),
      );
      if (objectVals.length > 0 && objectVals.length === values.length) {
        const handleDef = normalizeHandleForModel(
          provider,
          targetHandle,
          String(params.model_name ?? params.model ?? ""),
        );
        const key = handleDef?.internal_key ?? targetHandle;
        const existing = params[key];
        const merged = Array.isArray(existing)
          ? [...(existing as unknown[]), ...objectVals]
          : objectVals;
        params[key] = merged;
        continue;
      }

      const stringVals = values.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (stringVals.length === 0) continue;

      const handleDef = normalizeHandleForModel(
        provider,
        targetHandle,
        String(params.model_name ?? params.model ?? ""),
      );
      if (handleDef) {
        for (const v of stringVals) {
          try {
            validateEdgeValue(v, handleDef.data_type, targetHandle);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return new Response(
              JSON.stringify({ error: msg }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          if (handleDef.internal_key === "image_url" && handleDef.data_type === "image") {
            edgeImageUrls.push(v);
          }
        }
        if (handleDef.internal_key === "image_url" && handleDef.data_type === "image") {
          // Use the first ref as the primary image_url; the rest live
          // in mention_image_urls (merged below) for multi-image
          // dispatchers (Banana, OpenAI gpt-image-2).
          if (provider === "tripo3d") {
            const existing = Array.isArray(params.image_urls)
              ? (params.image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
              : [];
            const merged = Array.from(new Set([...existing, ...stringVals]));
            params.image_urls = merged;
            if (!params[handleDef.internal_key]) {
              params[handleDef.internal_key] = merged[0];
            }
            continue;
          }
          if (!params[handleDef.internal_key]) {
            params[handleDef.internal_key] = stringVals[0];
          }
        } else if (handleDef.internal_key === "reference_image_urls" && handleDef.data_type === "image") {
          appendUniqueStringParam(params, "reference_image_urls", stringVals, 9);
        } else if (handleDef.internal_key === "ref_image_urls" && handleDef.data_type === "image") {
          appendUniqueStringParam(params, "ref_image_urls", stringVals, 7);
        } else if (handleDef.internal_key === "reference_video_urls" && handleDef.data_type === "video") {
          appendUniqueStringParam(params, "reference_video_urls", stringVals, 3);
        } else if (handleDef.internal_key === "reference_audio_urls" && handleDef.data_type === "audio") {
          appendUniqueStringParam(params, "reference_audio_urls", stringVals, 3);
        } else {
          // Non-image keys: last value wins (uncommon for them to
          // duplicate; keep behaviour simple).
          params[handleDef.internal_key] = stringVals[stringVals.length - 1];
        }
      } else {
        // Unknown handle for this provider — pass through (array-ify
        // back to scalar when there's just one).
        params[targetHandle] = stringVals.length === 1 ? stringVals[0] : stringVals;
      }
    }

    // Mentioned assets → image_url / mention_image_urls fallback.
    // Kling owns its mentions inside executeKlingOmni (positional
    // `@Element{N}` / `@Image{N}` rewrite), so this fallback is for
    // banana / openai / chat_ai only.
    // Image refs come from native image mentions (m.url) AND from
    // video mentions that carry a browser-extracted end-frame
    // (m.imageFrameUrl). The mention chip targets the same node id in
    // both cases — the URL we plug in changes based on the source's
    // media type.
    const mentionImageUrls = mentioned
      .map((m) => {
        if (!m || m.kind === "element") return null;
        if (m.fieldType === "image" && typeof m.url === "string" && m.url) return m.url;
        if (m.fieldType === "video" && typeof m.imageFrameUrl === "string" && m.imageFrameUrl) return m.imageFrameUrl;
        return null;
      })
      .filter((u): u is string => u !== null);
    if (provider !== "kling" && (mentionImageUrls.length > 0 || edgeImageUrls.length > 0)) {
      if (provider === "banana" || provider === "openai" || provider === "replicate_image") {
        const merged = Array.from(new Set([
          ...((params.mention_image_urls as string[] | undefined) ?? []),
          ...mentionImageUrls,
          ...edgeImageUrls,
        ]));
        params.mention_image_urls = merged;
        if (!params.image_url) params.image_url = merged[0];
      } else if (provider === "tripo3d") {
        const existing = Array.isArray(params.image_urls)
          ? (params.image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
          : [];
        const merged = Array.from(new Set([
          ...existing,
          ...mentionImageUrls,
          ...edgeImageUrls,
        ]));
        params.image_urls = merged;
        if (!params.image_url) params.image_url = merged[0];
      } else if (provider === "seedance" || provider === "replicate_video") {
        const model = String(params.model_name ?? params.model ?? "").toLowerCase();
        const isSeedanceV2 =
          model.startsWith("seedance-2-0") ||
          model.startsWith("dreamina-seedance-2-0") ||
          model.startsWith("replicate-seedance-2-0");
        if (isSeedanceV2) {
          const hasKeyframeInput = Boolean(
            params.image_url ||
              params.start_frame ||
              params.image_tail_url ||
              params.end_frame,
          );
          if (!hasKeyframeInput) {
            const existing = Array.isArray(params.reference_image_urls)
              ? (params.reference_image_urls as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0)
              : typeof params.reference_image_urls === "string"
                ? [params.reference_image_urls]
                : [];
            const merged = Array.from(new Set([...existing, ...mentionImageUrls, ...edgeImageUrls])).slice(0, 9);
            if (merged.length > 0) params.reference_image_urls = merged;
          }
        } else if (!params.image_url) {
          params.image_url = mentionImageUrls[0] ?? edgeImageUrls[0];
        }
      } else {
        if (!params.image_url) params.image_url = mentionImageUrls[0];
      }
    }

    /* ─── Mention rewrite (mirrors legacy executeOneStep) ─── */
    // Kling owns its rewrite (positional indexing — different syntax
    // from Banana/OpenAI). Skip the generic helpers when provider is
    // kling to avoid stripping `@[Label](nodeId)` tokens before the
    // Kling executor can see them.
    if (provider !== "kling") {
      // Step 1: inline-rewrite tokens in EVERY string param so that
      // negative_prompt / system_prompt / context_text / etc. all get
      // their `@[Label](id)` anchors converted, not just `prompt`.
      // Legacy iterates `Object.entries(stepParams)` for the same reason.
      for (const [key, val] of Object.entries(params)) {
        if (typeof val !== "string") continue;
        if (!val.includes("@")) continue; // fast-path: no token at all
        params[key] = rewriteMentionsInline(val, mentioned, provider);
      }
      // Step 2: append the `[Context: …]` block once, on the primary
      // prompt. Banana / OpenAI both need the model to know which
      // attachment maps to which name; doing this per-param would
      // duplicate the block on every field.
      if (typeof params.prompt === "string") {
        params.prompt = appendMentionContext(params.prompt, mentioned, provider);
      }
    }

    /* ─── Dispatch ────────────────────────────────────────── */
    enforcePrimaryProviderParams(provider, params);

    activeCreditCharge = await consumeWorkspaceCredits({
      supabase,
      userId: user.id,
      userEmail: user.email ?? null,
      body,
      nodeType,
      provider,
      params,
    });

    let result: ProviderResult;
    switch (provider) {
      case "banana":
        result = await executeBanana(params, supabase);
        break;
      case "kling":
        result = await executeKling(params, supabase, mentioned);
        break;
      case "chat_ai":
        result = await executeChatAi(params);
        break;
      case "remove_bg":
        result = await executeRemoveBg(params, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        break;
      case "upscale_image":
        result = await executeMagnificUpscale(params);
        break;
      case "merge_audio":
        result = await executeMergeAudio(params);
        break;
      case "elevenlabs_dubbing":
        result = await executeElevenLabsDubbing(params);
        break;
      case "openai":
        result = await executeOpenAIImage2(params, supabase);
        break;
      case "replicate_image":
        result = await executeReplicateImage(params);
        break;
      case "video_understanding":
        result = await executeVideoToPrompt(params);
        break;
      case "url_asset":
        result = await executeUrlAsset(params, supabase, user.id, {
          projectId: body.project_id ?? null,
          workspaceId: body.workspace_id ?? null,
          canvasId: body.canvas_id ?? null,
        });
        break;
      case "tripo3d":
        result = await executeTripo3D(params);
        break;
      case "hyper3d":
        result = await executeHyper3D(params);
        break;
      case "google_tts":
        // Pass the service-role supabase client + user id so the
        // executor can upload the MP3 and insert into user_assets
        // without going through another auth round-trip.
        result = await executeGoogleTts(params, supabase, user.id);
        break;
      case "gemini_tts":
        // Calls the Gemini API directly via the shared geminiTts.ts
        // helper (no proxy through a separate edge function). Same
        // upload-to-user_assets contract as executeGoogleTts.
        result = await executeGeminiTts(params, supabase, user.id);
        break;
      case "elevenlabs_tts":
        // ElevenLabs TTS — direct call into ElevenLabs API,
        // mirrors executeGoogleTts in shape (synth → upload →
        // user_assets row). Requires ELEVEN_API_KEY or
        // ELEVENLABS_API_KEY in Supabase project secrets.
        result = await executeElevenLabsTts(params, supabase, user.id);
        break;
      case "seedance":
        result = await executeSeedance(params);
        break;
      case "replicate_video":
        result = await executeReplicateVideo(params);
        break;
      case "replicate_veo":
        result = await executeReplicateVeo(params);
        break;
      case "veo":
        result = await executeVeo(params, supabase);
        break;
      case "seedream":
        result = await executeSeedream(params, supabase);
        break;
      default:
        throw new Error(`No executor for provider "${provider}"`);
    }

    /* ─── Format response ─────────────────────────────────── */
    const responseType =
      result.output_type === "video_url" ? "video" :
      result.output_type === "text"      ? "text"  :
      result.output_type === "audio_url" ? "audio" :
      "image";

    const promptUsed = String(params.prompt ?? params.system_prompt ?? "");
    const promptSource = textInputUsed ? "text_input_edge" : "prompt_param";

    const durationMs = Date.now() - startTime;
    console.log(
      `[workspace-run-node] ${nodeType} (${provider}) done in ${durationMs}ms ` +
      `-> ${responseType}${result.task_id ? " task=" + result.task_id : ""}`,
    );

    // Record an analytics event. Wrapped helper is best-effort and never
    // throws — a failed insert must not fail the user's run. Logs every
    // output_type now (text included) so chat-AI usage gets billed for
    // CMO-agency seats. Helper maps text → feature="chat_ai" to align
    // with credit_costs naming, and pulls token counts out of
    // provider_meta when the executor exposes them.
    const creditsSpent =
      activeCreditCharge?.amount ??
      (Number.isFinite(Number(body.precharged_credits))
        ? Number(body.precharged_credits)
        : 0);
    await recordGenerationEvent({
      supabase,
      userId: user.id,
      organizationId: activeCreditCharge?.organizationId ?? body.credit_organization_id ?? null,
      classId: activeCreditCharge?.classId ?? body.credit_class_id ?? null,
      provider,
      nodeType,
      params,
      result,
      projectId: body.project_id ?? null,
      workspaceId: body.workspace_id ?? null,
      canvasId: body.canvas_id ?? null,
      nodeId: body.node_id ?? null,
      creditsSpent,
    });

    // Surface text outputs at the top level so the frontend's `r.text`
    // path picks them up (used by Chat AI, Video to Prompt, etc.).
    const textOut =
      result.output_type === "text"
        ? (result.outputs?.text as string | undefined) ??
          (result.outputs ? Object.values(result.outputs)[0] : undefined)
        : undefined;

    return new Response(
      JSON.stringify({
        type: responseType,
        url: result.result_url,
        text: textOut,
        outputs: result.outputs,
        task_id: result.task_id,
        prompt_used: promptUsed,
        prompt_source: promptSource,
        provider_meta: result.provider_meta,
        node_type: nodeType,
        credits_spent: creditsSpent,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[workspace-run-node] error:", msg);
    if (activeCreditCharge && activeUserId) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await refundWorkspaceCredits({
        supabase,
        userId: activeUserId,
        charge: activeCreditCharge,
        reason: `workspace run failed: ${msg.substring(0, 160)}`,
        workspaceId: activeBody?.workspace_id ?? null,
        canvasId: activeBody?.canvas_id ?? null,
      });
    }
    const status =
      msg === "INSUFFICIENT_CREDITS"
        ? 402
        : e instanceof PricingConfigError
          ? 400
          : 500;
    return new Response(
      JSON.stringify({
        error: msg === "INSUFFICIENT_CREDITS" ? "เครดิตไม่พอสำหรับการเจนนี้" : msg,
      }),
      { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
