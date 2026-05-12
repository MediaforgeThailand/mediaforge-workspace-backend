/// <reference lib="deno.ns" />
/// <reference lib="dom" />

/** Server-side mirror of the frontend `MentionedAsset` shape. */
export interface MentionedAssetSrv {
  /** "asset" = AssetNode (image/video); "element" = saved/creator
   *  ElementNode resolved to a Kling Omni element entry. */
  kind?: "asset" | "element";
  label?: string;
  nodeId?: string;
  /** Asset-only. */
  url?: string | null;
  fieldType?: "image" | "video" | "audio" | null;
  role?: string;
  /** Element-only. */
  name?: string;
  reference_image_urls?: string[];
  frontal_image_url?: string;
  brand_element_id?: string;
}

/**
 * Provider-aware @-mention rewriter for the workspace V2 handler.
 *
 * The frontend tokenises mentions as plain `@<label>` (not the legacy
 * `@[Label](nodeId)` form) and passes the resolved assets in the
 * payload's `mentioned_assets` array. This helper:
 *   - Rewrites tokens inline (provider-specific format)
 *   - Appends a `[Context: …]` block at the end of the prompt
 *
 * For Banana the inline tokens are stripped and the context block
 * speaks naturally about each attached image. For OpenAI gpt-image-2
 * the tokens become `Image N (Label)` so the model can address each
 * reference by index — matching OpenAI's prompting guide.
 *
 * Stateless on purpose — the legacy `resolveMentionsInPrompt` depends
 * on graph rows + pipeline_executions which V2 doesn't have.
 */
/**
 * The mention token format used everywhere in the workspace —
 * produced by the legacy PromptMentionTextarea (atomic blue chips).
 *
 *   @[Label](nodeId)
 */
const MENTION_REGEX = /@\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Role-aware context instructions per provider — ported from the main
 * project's `getBananaRoleInstruction` / `getOpenAIImageRoleInstruction`
 * (mediaforge-backend execute-pipeline-step v18+). Roles come from
 * the asset node's `referenceType` field — creator picks one of:
 *   subject | scene | style | object | pose | general
 * "general" is the default and matches the pre-role behaviour.
 */
function getBananaRoleInstruction(role: string): string {
  switch (role) {
    case "subject":
      return "SUBJECT reference — preserve the face, identity, body type, and clothing from this image with maximum fidelity. This is the primary subject of the generated image.";
    case "scene":
      return "SCENE/BACKGROUND reference — use ONLY for the setting, environment, lighting, atmosphere, and composition behind the subject. Do NOT copy any people, faces, or characters from this image.";
    case "style":
      return "STYLE reference — use ONLY for the visual style, color palette, mood, lighting tone, and artistic aesthetic. Do NOT copy any specific subjects, faces, scenes, or compositions from this image.";
    case "object":
      return "OBJECT/PRODUCT reference — include this exact item in the generated image. Preserve its shape, colors, branding, and proportions accurately. Do NOT change the object's design.";
    case "pose":
      return "POSE/COMPOSITION reference — copy ONLY the body posture, hand placement, camera angle, and framing from this image. Do NOT copy the face, identity, clothing, or background.";
    case "general":
    default:
      return "use as visual reference";
  }
}

function getOpenAIImageRoleInstruction(role: string): string {
  switch (role) {
    case "subject":
      return "[SUBJECT] Preserve the face, identity, body type, and clothing from this image exactly. This is the primary subject of the generated image — do NOT alter facial features.";
    case "scene":
      return "[BACKGROUND] Use ONLY for setting, environment, lighting, atmosphere, and composition. Do NOT copy any people, faces, or characters from this image.";
    case "style":
      return "[STYLE] Use ONLY for the visual style, color palette, mood, and artistic aesthetic. Do NOT copy specific subjects, faces, scenes, or compositions.";
    case "object":
      return "[OBJECT] Include this exact item in the generated image. Preserve shape, colors, branding, and proportions accurately. Do NOT alter the object's design.";
    case "pose":
      return "[POSE] Copy ONLY the body posture, hand placement, camera angle, and framing. Do NOT copy the face, identity, clothing, or background.";
    case "general":
    default:
      return "use as reference";
  }
}

/**
 * Inline-only mention rewriter. Replaces `@[Label](nodeId)` and plain
 * `@<label>` tokens with provider-specific position references —
 * **without** appending the `[Context: …]` block.
 *
 * Use this on every string param that may carry mentions. Legacy
 * executeOneStep scans `Object.entries(stepParams)` and runs an
 * equivalent loop — V2 mirrors that pattern so multi-prompt nodes
 * (negative_prompt, system_prompt, etc.) stay consistent.
 */
export function rewriteMentionsInline(
  text: string,
  mentioned: Array<{ label?: string; nodeId?: string; url?: string | null; fieldType?: "image" | "video" | null; role?: string }>,
  provider: string,
): string {
  if (!text) return text;
  const imageMentions = mentioned.filter(
    (m) => m && m.fieldType === "image" && typeof m.url === "string" && m.url,
  );
  if (imageMentions.length === 0) {
    return text.replace(MENTION_REGEX, (_full, label) => label);
  }
  const indexByNodeId = new Map<string, number>();
  imageMentions.forEach((m, i) => {
    if (m.nodeId) indexByNodeId.set(m.nodeId, i);
  });
  const indexByLabel = new Map<string, number>();
  imageMentions.forEach((m, i) => {
    if (m.label) indexByLabel.set(m.label, i);
  });
  let out = text.replace(MENTION_REGEX, (_full, label: string, nodeId: string) => {
    const idx = indexByNodeId.get(nodeId);
    if (idx === undefined) return label;
    return provider === "openai" ? `Image ${idx + 1} (${label})` : `[${label}]`;
  });
  out = out.replace(/@([^\s@[]+)/g, (full, name: string) => {
    const idx = indexByLabel.get(name);
    if (idx === undefined) return full;
    return provider === "openai" ? `Image ${idx + 1} (${name})` : `[${name}]`;
  });
  return out;
}

/**
 * Append the `[Context: …]` block once, on the primary prompt field.
 * Banana names attachments by `[Label]` (matches the inline anchors
 * `rewriteMentionsInline` placed in the prompt). OpenAI names them
 * by `Image N (Label)` because gpt-image-2's multipart form keeps
 * text and attachments in separate fields.
 *
 * Each line ends with a role-specific instruction so the model knows
 * how to USE each attachment (subject vs scene vs style vs object vs
 * pose). Defaults to a generic "use as reference" when role is not
 * set — matches pre-role behaviour.
 */
export function appendMentionContext(
  text: string,
  mentioned: Array<{ label?: string; nodeId?: string; url?: string | null; fieldType?: "image" | "video" | null; role?: string }>,
  provider: string,
): string {
  const imageMentions = mentioned.filter(
    (m) => m && m.fieldType === "image" && typeof m.url === "string" && m.url,
  );
  if (imageMentions.length === 0) return text;
  const lines = imageMentions.map((m, i) => {
    const role = (m.role ?? "general").toLowerCase();
    if (provider === "openai") {
      const ri = getOpenAIImageRoleInstruction(role);
      return `Image ${i + 1} = "${m.label ?? ""}" — ${ri}`;
    }
    const ri = getBananaRoleInstruction(role);
    return `[${m.label ?? ""}] = image ${i + 1} (attached) — ${ri}`;
  });
  // Squash any double-spaces left over from earlier strip cases, then
  // append. Mirror the legacy whitespace cleanup at the same spot.
  const cleaned = text.replace(/\s{2,}/g, " ").trim();
  return `${cleaned}\n\n[Context: ${lines.join(". ")}.]`;
}

// Note: the old `applyMentionContext` wrapper has been removed —
// callers now use `rewriteMentionsInline` (per-string) +
// `appendMentionContext` (once on prompt) so role-aware context can
// be threaded through without re-walking every param.
