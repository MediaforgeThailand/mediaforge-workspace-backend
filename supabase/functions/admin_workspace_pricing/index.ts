// admin_workspace_pricing — workspace-side credit-system admin reads + writes.
//
// Purpose
// -------
// The admin-hub has two pricing pages (Subscription Builder, Pricing Manager)
// that historically only spoke to the consumer project's bridge. When the
// operator flips the top-bar target pill to "Workspace" we want those pages
// to actually read and edit the workspace project's pricing tables.
//
// This function is the workspace-side equivalent of the consumer bridge.
// It exposes a tiny POST-action surface so the admin frontend has a single
// endpoint per project to talk to (matches the existing
// `admin_dashboard_stats` style — same auth model, same CORS, same shape).
//
// Auth
// ----
// `verify_jwt: false` (declared in supabase config when deployed). Same
// reason as `admin_dashboard_stats`: the admin user's JWT is signed by the
// admin DB project (`jonueleuisfarcepwkuo`) and would not verify here.
// Federating admin auth across projects is out of scope for this wave.
// The function returns aggregate / config rows only — no user PII, no
// message bodies — so the blast radius is the pricing surface, which the
// admin already has read access to in the consumer project too.
//
// Mutations
// ---------
// Mutations (`upsert_credit_cost`, `delete_credit_cost`,
// `set_markup_multipliers`, `recalculate_all_prices`) are now wired to
// real implementations using the service-role client. Each mutation
// returns a `{ data: ... }` envelope identical to the consumer bridge so
// the admin-hub doesn't have to branch.
//
// Storage shape note
// ------------------
// Markup multipliers live in `subscription_settings` under
// `markup_multiplier_<feature>` keys (image / video / chat / audio).
// The earlier read code stripped a `markup_` prefix (which would also
// match an unrelated `markup_xxx` key). We now strip the full
// `markup_multiplier_` prefix to match the actual storage convention.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-email",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Multiplier keys we accept on the wire. Centralised so the read + write
// paths stay in lock-step: if a new feature gets a multiplier later we
// only have to add it here.
const MULTIPLIER_KEYS = ["image", "video", "chat", "audio"] as const;
type MultiplierKey = (typeof MULTIPLIER_KEYS)[number];
const MULTIPLIER_PREFIX = "markup_multiplier_";
const FLOW_CREDITS_PER_THB = 125;
const WORKSPACE_CREDITS_PER_THB = 50;
const FLOW_TO_WORKSPACE_RATIO = WORKSPACE_CREDITS_PER_THB / FLOW_CREDITS_PER_THB;

type CreditCostWriteRow = {
  feature: string;
  model: string | null;
  label: string;
  cost: number;
  pricing_type: string | null;
  duration_seconds?: number | null;
  has_audio?: boolean | null;
  provider?: string | null;
  price_key?: string | null;
  resolution?: string | null;
  quality?: string | null;
  source?: string | null;
  source_url?: string | null;
  source_ratio?: number | null;
  provider_unit?: string | null;
  notes?: string | null;
};

const GPT_IMAGE_2_ROWS: CreditCostWriteRow[] = [
  ["1k", "low", 3], ["1k", "medium", 20], ["1k", "high", 80],
  ["2k", "low", 8], ["2k", "medium", 50], ["2k", "high", 200],
  ["4k", "low", 18], ["4k", "medium", 120], ["4k", "high", 480],
].map(([tier, quality, cost]) => ({
  feature: "generate_openai_image",
  model: `gpt-image-2:${tier}:${quality}`,
  label: `GPT Image 2 ${String(tier).toUpperCase()} ${String(quality)[0].toUpperCase()}${String(quality).slice(1)}`,
  cost: Number(cost),
  pricing_type: "per_operation",
  provider: "openai",
  price_key: `gpt-image-2:${tier}:${quality}`,
  resolution: String(tier).toUpperCase(),
  quality: String(quality),
  source: tier === "1k" ? "flow_erp_converted" : "workspace_catalog",
  source_url: "https://platform.openai.com/docs/pricing",
  source_ratio: FLOW_TO_WORKSPACE_RATIO,
  provider_unit: "per image",
  notes:
    tier === "1k"
      ? "Flow ERP quality row converted from 125 credits/THB to Workspace 50 credits/THB."
      : "Workspace recommended tier. Keep this easy to override after invoice reconciliation.",
}));

const RECOMMENDED_WORKSPACE_PRICING: CreditCostWriteRow[] = [
  ...GPT_IMAGE_2_ROWS,
  { feature: "generate_openai_image", model: "gpt-image-2-low", label: "GPT Image 2 Low (fallback)", cost: 3, pricing_type: "per_operation", provider: "openai", price_key: "gpt-image-2:1k:low", resolution: "1K", quality: "low", source: "flow_erp_converted", source_url: "https://platform.openai.com/docs/pricing", source_ratio: FLOW_TO_WORKSPACE_RATIO, provider_unit: "per image" },
  { feature: "generate_openai_image", model: "gpt-image-2-medium", label: "GPT Image 2 Medium (fallback)", cost: 20, pricing_type: "per_operation", provider: "openai", price_key: "gpt-image-2:1k:medium", resolution: "1K", quality: "medium", source: "flow_erp_converted", source_url: "https://platform.openai.com/docs/pricing", source_ratio: FLOW_TO_WORKSPACE_RATIO, provider_unit: "per image" },
  { feature: "generate_openai_image", model: "gpt-image-2-high", label: "GPT Image 2 High (fallback)", cost: 80, pricing_type: "per_operation", provider: "openai", price_key: "gpt-image-2:1k:high", resolution: "1K", quality: "high", source: "flow_erp_converted", source_url: "https://platform.openai.com/docs/pricing", source_ratio: FLOW_TO_WORKSPACE_RATIO, provider_unit: "per image" },
  { feature: "text_to_speech", model: "google-tts-studio", label: "Google Cloud TTS Studio / 1K chars", cost: 280, pricing_type: "per_1k_chars", provider: "google", price_key: "google-tts-studio", quality: "studio", source: "official_docs", source_url: "https://cloud.google.com/text-to-speech/pricing", provider_unit: "per 1K chars" },
  { feature: "text_to_speech", model: "google-tts-neural2", label: "Google Cloud TTS Neural2 / 1K chars", cost: 28, pricing_type: "per_1k_chars", provider: "google", price_key: "google-tts-neural2", quality: "neural2", source: "official_docs", source_url: "https://cloud.google.com/text-to-speech/pricing", provider_unit: "per 1K chars" },
  { feature: "text_to_speech", model: "google-tts-wavenet", label: "Google Cloud TTS WaveNet / 1K chars", cost: 28, pricing_type: "per_1k_chars", provider: "google", price_key: "google-tts-wavenet", quality: "wavenet", source: "official_docs", source_url: "https://cloud.google.com/text-to-speech/pricing", provider_unit: "per 1K chars" },
  { feature: "video_to_prompt", model: "gemini-video-understanding", label: "Video to Prompt (Gemini)", cost: 10, pricing_type: "per_operation", provider: "google", price_key: "gemini-video-understanding", source: "workspace_catalog", source_url: "https://ai.google.dev/gemini-api/docs/pricing", provider_unit: "per analysis" },
  { feature: "model_3d", model: "tripo3d-v3.1", label: "Tripo3D v3.1", cost: 80, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-v3.1", quality: "detailed", source: "workspace_catalog", source_url: "https://www.tripo3d.ai/", provider_unit: "per model" },
  { feature: "model_3d", model: "tripo3d-p1", label: "Tripo3D P1", cost: 120, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-p1", quality: "premium", source: "workspace_catalog", source_url: "https://www.tripo3d.ai/", provider_unit: "per model" },
  { feature: "model_3d", model: "tripo3d-turbo", label: "Tripo3D Turbo", cost: 50, pricing_type: "per_operation", provider: "tripo3d", price_key: "tripo3d-turbo", quality: "fast", source: "workspace_catalog", source_url: "https://www.tripo3d.ai/", provider_unit: "per model" },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Wrap a select() call so we can return a consistent envelope to the
// frontend — `{ data: [...] }` matches what the consumer admin-api
// returns, which keeps the React Query callsites identical regardless of
// which project is active.
async function listRows(
  client: SupabaseClient,
  table: string,
  order: { column: string; ascending?: boolean }[],
): Promise<{ data: unknown[] }> {
  let q = client.from(table).select("*");
  for (const o of order) {
    q = q.order(o.column, { ascending: o.ascending ?? true });
  }
  const { data, error } = await q;
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  return { data: data ?? [] };
}

// Pull markup_multiplier_* rows out of subscription_settings and shape
// them into the flat `{ image, video, chat, audio }` object the Pricing
// Manager UI expects. Storage shape is `key`/`value` text — we coerce
// to numbers here so the frontend doesn't have to know the table layout.
async function getMarkupMultipliers(
  client: SupabaseClient,
): Promise<{ data: Record<MultiplierKey, number> }> {
  const { data, error } = await client
    .from("subscription_settings")
    .select("key, value")
    .like("key", `${MULTIPLIER_PREFIX}%`);
  if (error) {
    throw new Error(`subscription_settings read failed: ${error.message}`);
  }

  // Defaults match what Pricing Manager falls back to when nothing is set.
  const out: Record<MultiplierKey, number> = {
    image: 4.0,
    video: 4.0,
    chat: 4.0,
    audio: 4.0,
  };
  for (const row of data ?? []) {
    const key = String((row as { key: string }).key ?? "");
    const value = (row as { value: string }).value;
    const stripped = key.slice(MULTIPLIER_PREFIX.length);
    const num = Number(value);
    if (
      stripped &&
      Number.isFinite(num) &&
      (MULTIPLIER_KEYS as readonly string[]).includes(stripped)
    ) {
      out[stripped as MultiplierKey] = num;
    }
  }
  return { data: out };
}

// Best-effort audit row. Skipped silently if the table is missing or the
// insert fails — pricing mutations must not be blocked by audit issues.
// admin_audit_logs.admin_user_id is NOT NULL uuid; we don't have a real
// admin user uuid here (cross-project, no JWT verification), so we skip
// the insert when no resolvable uuid is supplied. The frontend doesn't
// pass one yet — leaving the hook in place so it lights up the day we
// federate admin auth.
async function tryAudit(
  client: SupabaseClient,
  args: {
    adminUserId: string | null;
    action: string;
    targetTable: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  if (!args.adminUserId) return;
  try {
    await client.from("admin_audit_logs").insert({
      admin_user_id: args.adminUserId,
      action: args.action,
      target_table: args.targetTable,
      details: args.details,
    });
  } catch (err) {
    // Don't fail the mutation just because audit logging hiccuped.
    console.warn(
      "admin_workspace_pricing: audit insert skipped:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function saveCreditCostRow(
  client: SupabaseClient,
  row: CreditCostWriteRow,
): Promise<unknown> {
  const duration = row.duration_seconds ?? null;
  const hasAudio = row.has_audio ?? false;
  let query = client
    .from("credit_costs")
    .select("id")
    .eq("feature", row.feature)
    .eq("has_audio", hasAudio)
    .limit(1);
  query = row.model === null ? query.is("model", null) : query.eq("model", row.model);
  query = duration === null
    ? query.is("duration_seconds", null)
    : query.eq("duration_seconds", duration);
  const { data: existing, error: readErr } = await query.maybeSingle();
  if (readErr) throw new Error(`credit_costs lookup failed: ${readErr.message}`);

  const payload = {
    feature: row.feature,
    model: row.model,
    label: row.label,
    cost: row.cost,
    pricing_type: row.pricing_type,
    duration_seconds: duration,
    has_audio: hasAudio,
    provider: row.provider ?? null,
    price_key: row.price_key ?? null,
    resolution: row.resolution ?? null,
    quality: row.quality ?? null,
    source: row.source ?? null,
    source_url: row.source_url ?? null,
    source_ratio: row.source_ratio ?? null,
    provider_unit: row.provider_unit ?? null,
    notes: row.notes ?? null,
    updated_at: new Date().toISOString(),
  };

  if ((existing as { id?: string } | null)?.id) {
    const { data, error } = await client
      .from("credit_costs")
      .update(payload)
      .eq("id", (existing as { id: string }).id)
      .select()
      .single();
    if (error) throw new Error(`credit_costs update failed: ${error.message}`);
    return data;
  }

  const { data, error } = await client
    .from("credit_costs")
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(`credit_costs insert failed: ${error.message}`);
  return data;
}

async function seedWorkspacePricingCatalog(
  client: SupabaseClient,
  audit: { adminUserId: string | null },
): Promise<{ data: { written: number; ratio: number; rows: unknown[] } }> {
  const rows: unknown[] = [];
  for (const row of RECOMMENDED_WORKSPACE_PRICING) {
    rows.push(await saveCreditCostRow(client, row));
  }
  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "workspace_pricing_catalog.seed",
    targetTable: "credit_costs",
    details: { written: rows.length, ratio: FLOW_TO_WORKSPACE_RATIO },
  });
  return { data: { written: rows.length, ratio: FLOW_TO_WORKSPACE_RATIO, rows } };
}

async function importFlowCreditCosts(
  client: SupabaseClient,
  audit: { adminUserId: string | null },
): Promise<{ data: { imported: number; ratio: number; rows: unknown[] } }> {
  const bridgeUrl = Deno.env.get("MAIN_BRIDGE_URL") ?? "";
  const secret = Deno.env.get("ERP_BRIDGE_SECRET") ?? "";
  if (!bridgeUrl || !secret) {
    throw new Error("MAIN_BRIDGE_URL and ERP_BRIDGE_SECRET must be configured before importing Flow ERP pricing.");
  }
  const u = new URL(bridgeUrl);
  u.pathname = "/functions/v1/erp-bridge";
  const res = await fetch(u.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "x-erp-secret": secret,
    },
    body: JSON.stringify({ action: "fetch_credit_costs", secret, payload: {} }),
  });
  const raw = await res.text();
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!res.ok) {
    throw new Error(`Flow ERP import failed (${res.status}): ${raw.slice(0, 300)}`);
  }
  const maybe = parsed as { data?: unknown; ok?: boolean; error?: unknown };
  const sourceRows = Array.isArray(maybe.data)
    ? maybe.data
    : Array.isArray(parsed)
      ? parsed as unknown[]
      : [];
  if (maybe.ok === false) {
    throw new Error(typeof maybe.error === "string" ? maybe.error : "Flow ERP bridge returned failure");
  }

  const written: unknown[] = [];
  for (const rawRow of sourceRows) {
    const r = rawRow as Record<string, unknown>;
    const cost = Math.max(1, Math.ceil(Number(r.cost ?? 0) * FLOW_TO_WORKSPACE_RATIO));
    if (!r.feature || !Number.isFinite(cost)) continue;
    written.push(await saveCreditCostRow(client, {
      feature: String(r.feature),
      model: r.model == null ? null : String(r.model),
      label: String(r.label ?? r.model ?? r.feature),
      cost,
      pricing_type: r.pricing_type == null ? "per_operation" : String(r.pricing_type),
      duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      has_audio: Boolean(r.has_audio),
      provider: r.provider == null ? null : String(r.provider),
      price_key: r.price_key == null ? null : String(r.price_key),
      resolution: r.resolution == null ? null : String(r.resolution),
      quality: r.quality == null ? null : String(r.quality),
      source: "flow_erp_converted",
      source_url: "Flow ERP",
      source_ratio: FLOW_TO_WORKSPACE_RATIO,
      provider_unit: r.provider_unit == null ? null : String(r.provider_unit),
      notes: `Imported from Flow ERP and converted ${FLOW_CREDITS_PER_THB}->${WORKSPACE_CREDITS_PER_THB} credits/THB.`,
    }));
  }
  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "flow_credit_costs.import",
    targetTable: "credit_costs",
    details: { imported: written.length, ratio: FLOW_TO_WORKSPACE_RATIO },
  });
  return { data: { imported: written.length, ratio: FLOW_TO_WORKSPACE_RATIO, rows: written } };
}

// ── Mutation handlers ────────────────────────────────────────────────

async function upsertCreditCost(
  client: SupabaseClient,
  body: Record<string, unknown>,
  audit: { adminUserId: string | null },
): Promise<{ data: unknown }> {
  // Pull only the columns we know about. Anything else in `body` is
  // silently ignored — this keeps the contract narrow and prevents the
  // admin UI from accidentally writing freeform columns.
  const id = typeof body.id === "string" && body.id ? body.id : null;
  const feature = String(body.feature ?? "").trim();
  const model =
    body.model === null || body.model === undefined
      ? null
      : String(body.model).trim() || null;
  const label = String(body.label ?? "").trim();
  const cost = Number(body.cost);
  const pricing_type =
    body.pricing_type === null || body.pricing_type === undefined
      ? null
      : String(body.pricing_type).trim() || null;
  const duration_seconds =
    body.duration_seconds === null || body.duration_seconds === undefined
      ? null
      : Number(body.duration_seconds);
  const has_audio = Boolean(body.has_audio);
  const optionalText = (key: string) =>
    body[key] === null || body[key] === undefined
      ? null
      : String(body[key]).trim() || null;
  const source_ratio =
    body.source_ratio === null || body.source_ratio === undefined
      ? null
      : Number(body.source_ratio);

  if (!feature) throw new Error("`feature` is required");
  if (!label) throw new Error("`label` is required");
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("`cost` must be a positive number");
  }
  if (
    duration_seconds !== null &&
    (!Number.isFinite(duration_seconds) || duration_seconds < 0)
  ) {
    throw new Error("`duration_seconds` must be a non-negative number");
  }

  const row = {
    feature,
    model,
    label,
    cost,
    pricing_type,
    duration_seconds,
    has_audio,
    provider: optionalText("provider"),
    price_key: optionalText("price_key"),
    resolution: optionalText("resolution"),
    quality: optionalText("quality"),
    source: optionalText("source"),
    source_url: optionalText("source_url"),
    source_ratio: source_ratio !== null && Number.isFinite(source_ratio) ? source_ratio : null,
    provider_unit: optionalText("provider_unit"),
    notes: optionalText("notes"),
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { data, error } = await client
      .from("credit_costs")
      .update(row)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`credit_costs update failed: ${error.message}`);
    await tryAudit(client, {
      adminUserId: audit.adminUserId,
      action: "credit_cost.update",
      targetTable: "credit_costs",
      details: { id, ...row },
    });
    return { data };
  }

  const { data, error } = await client
    .from("credit_costs")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(`credit_costs insert failed: ${error.message}`);
  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "credit_cost.insert",
    targetTable: "credit_costs",
    details: { id: (data as { id?: string })?.id ?? null, ...row },
  });
  return { data };
}

async function deleteCreditCost(
  client: SupabaseClient,
  body: Record<string, unknown>,
  audit: { adminUserId: string | null },
): Promise<{ data: { id: string } }> {
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) throw new Error("`id` is required");

  const { error } = await client.from("credit_costs").delete().eq("id", id);
  if (error) throw new Error(`credit_costs delete failed: ${error.message}`);

  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "credit_cost.delete",
    targetTable: "credit_costs",
    details: { id },
  });
  return { data: { id } };
}

async function setMarkupMultipliers(
  client: SupabaseClient,
  body: Record<string, unknown>,
  audit: { adminUserId: string | null },
): Promise<{ data: Record<MultiplierKey, number> }> {
  // Build the upsert rows in storage shape (`markup_multiplier_<key>`).
  // We only touch the four canonical keys — anything else in the body is
  // silently ignored.
  const out: Record<MultiplierKey, number> = {
    image: 4.0,
    video: 4.0,
    chat: 4.0,
    audio: 4.0,
  };
  const rows: { key: string; value: string }[] = [];
  for (const k of MULTIPLIER_KEYS) {
    const raw = body[k];
    if (raw === undefined || raw === null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`Multiplier "${k}" must be a positive number`);
    }
    out[k] = num;
    rows.push({ key: `${MULTIPLIER_PREFIX}${k}`, value: String(num) });
  }

  if (rows.length === 0) {
    throw new Error(
      "Provide at least one of: image, video, chat, audio multipliers.",
    );
  }

  // ON CONFLICT(key) DO UPDATE — `subscription_settings.key` has a UNIQUE
  // constraint (subscription_settings_key_key) so this is a clean upsert.
  const { error } = await client
    .from("subscription_settings")
    .upsert(rows, { onConflict: "key" });
  if (error) {
    throw new Error(`subscription_settings upsert failed: ${error.message}`);
  }

  // Re-read so the response reflects whatever's actually stored after
  // the upsert (in case other keys were already there with different
  // values that we didn't pass in this call).
  const fresh = await getMarkupMultipliers(client);

  await tryAudit(client, {
    adminUserId: audit.adminUserId,
    action: "markup_multipliers.set",
    targetTable: "subscription_settings",
    details: { written: out },
  });

  return fresh;
}

// Workspace doesn't have flow-level pricing baked into a `flows.credit_cost`
// column the way the consumer product does — node costs are evaluated at
// run time. There's nothing to recalculate here, but the admin UI fires
// this action on every save so we return a friendly no-op shape rather
// than 501.
function recalculateAllPrices(): { data: Record<string, unknown> } {
  return {
    data: {
      updated_count: 0,
      skipped: true,
      reason:
        "Workspace product runs nodes individually; no per-flow price to recalc.",
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed — use POST" }, 405);
  }

  let body: { action?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";
  if (!action) {
    return json({ error: "Missing `action` in request body" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Audit context. We don't have a federated admin user uuid here — the
  // admin-hub JWT is signed by a different project. If the frontend
  // someday passes `x-admin-user-id`, we'll start writing audit rows.
  // `x-admin-email` is accepted for forward compat (logged into details).
  const adminUserHeader = req.headers.get("x-admin-user-id");
  const adminEmailHeader = req.headers.get("x-admin-email");
  const auditCtx = {
    adminUserId:
      adminUserHeader && /^[0-9a-f-]{36}$/i.test(adminUserHeader)
        ? adminUserHeader
        : null,
    adminEmail: adminEmailHeader || null,
  };

  try {
    switch (action) {
      // ── Reads ──────────────────────────────────────────────────────
      case "list_plans":
        return json(
          await listRows(admin, "subscription_plans", [
            { column: "sort_order", ascending: true },
          ]),
        );

      case "list_topup_packages":
        return json(
          await listRows(admin, "topup_packages", [
            { column: "sort_order", ascending: true },
          ]),
        );

      // Pricing Manager calls this `fetch_credit_costs` against the consumer
      // bridge — accept both names so the frontend can stay agnostic.
      case "list_credit_costs":
      case "fetch_credit_costs":
        return json(
          await listRows(admin, "credit_costs", [
            { column: "feature", ascending: true },
            { column: "model", ascending: true },
          ]),
        );

      case "get_markup_multipliers":
        return json(await getMarkupMultipliers(admin));

      case "get_pricing_catalog":
        return json({
          data: {
            ratios: {
              flow_credits_per_thb: FLOW_CREDITS_PER_THB,
              workspace_credits_per_thb: WORKSPACE_CREDITS_PER_THB,
              flow_to_workspace_ratio: FLOW_TO_WORKSPACE_RATIO,
            },
            rows: RECOMMENDED_WORKSPACE_PRICING,
          },
        });

      // ── Mutations ──────────────────────────────────────────────────
      case "upsert_credit_cost":
        return json(await upsertCreditCost(admin, body, auditCtx));

      case "delete_credit_cost":
        return json(await deleteCreditCost(admin, body, auditCtx));

      case "set_markup_multipliers":
        return json(await setMarkupMultipliers(admin, body, auditCtx));

      case "recalculate_all_prices":
        return json(recalculateAllPrices());

      case "seed_workspace_pricing_catalog":
        return json(await seedWorkspacePricingCatalog(admin, auditCtx));

      case "import_flow_credit_costs":
        return json(await importFlowCreditCosts(admin, auditCtx));

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("admin_workspace_pricing error:", msg);
    return json({ error: msg }, 500);
  }
});
