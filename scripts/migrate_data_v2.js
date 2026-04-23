#!/usr/bin/env node
/**
 * MediaForge Database + Storage Migration Script — V2
 *
 * Improvements over v1 (scripts/migrate_data.js):
 *   1. NULLABLE-FK HANDLING: For orphan rows, if the FK column is nullable
 *      we SET IT TO NULL instead of dropping the whole row (preserves data).
 *   2. AUTH.USERS PARENT SET: All user_id FKs are validated against the set
 *      of stub auth.users we insert (built from union of every user_id seen
 *      in any source table).
 *   3. SELF-REFERENTIAL FK (admin_accounts.created_by → admin_accounts.id): 2-pass insert —
 *      first pass with created_by=NULL, second pass UPDATE to original value
 *      if parent now exists.
 *   4. EXPANDED FK_DEPENDENCIES: Covers every FK relationship in the schema,
 *      including tables that point at auth.users (profiles, notifications,
 *      brand_contexts, user_credits, user_roles, demo_links, etc.).
 *   5. NULLABLE COLUMN INTROSPECTION: Queries information_schema once per
 *      table to know which FK columns are nullable.
 *   6. DEFENSIVE FALLBACK: Per-row retry on batch failure now also
 *      auto-nullifies any FK that triggers a 23503 (foreign_key_violation).
 *
 * Prerequisites:
 *   npm install @supabase/supabase-js dotenv pg
 *
 * Usage — Local destination (Docker):
 *   SOURCE_SUPABASE_URL=... SOURCE_SERVICE_ROLE_KEY=... \
 *   DEST_SUPABASE_URL=http://localhost:54321 DEST_SERVICE_ROLE_KEY=... \
 *   node scripts/migrate_data_v2.js
 *
 * Usage — Remote destination (e.g. another Supabase project):
 *   SOURCE_SUPABASE_URL=... SOURCE_SERVICE_ROLE_KEY=... \
 *   DEST_SUPABASE_URL=https://xyz.supabase.co DEST_SERVICE_ROLE_KEY=... \
 *   DEST_DB_URL=postgres://postgres:PASSWORD@db.xyz.supabase.co:5432/postgres \
 *   SKIP_SCHEMA=true \
 *   node scripts/migrate_data_v2.js
 *
 * The script auto-detects local vs remote based on DEST_SUPABASE_URL hostname.
 * Local destinations use Docker psql; remote destinations use pg (node-postgres).
 *
 * Options:
 *   SKIP_STORAGE=true | SKIP_DATA=true | SKIP_SCHEMA=true
 *   ONLY_TABLES=flows,profiles
 *   DEST_DB_CONTAINER=supabase_db_qywqanfbmnhcleojzwtq  (local only: override docker container)
 *   DEST_DB_URL=postgres://...  (remote: direct Postgres connection string)
 *   SUPABASE_ACCESS_TOKEN=sbp_...  (remote fallback: if direct pg fails, uses Management API)
 */

import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: ".env.local" });

// ── Config ──────────────────────────────────────────────────────────────────
const SOURCE_URL = process.env.SOURCE_SUPABASE_URL;
const SOURCE_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const DEST_URL = process.env.DEST_SUPABASE_URL;
const DEST_KEY = process.env.DEST_SERVICE_ROLE_KEY;
const SKIP_STORAGE = process.env.SKIP_STORAGE === "true";
const SKIP_DATA = process.env.SKIP_DATA === "true";
const SKIP_SCHEMA = process.env.SKIP_SCHEMA === "true";
const ONLY_TABLES = process.env.ONLY_TABLES?.split(",").filter(Boolean) || [];
const DB_CONTAINER = process.env.DEST_DB_CONTAINER || "supabase_db_qywqanfbmnhcleojzwtq";
const DEST_DB_URL = process.env.DEST_DB_URL; // e.g. postgres://user:pass@host:5432/postgres
const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN; // For Management API fallback
let LOVABLE_AUTH_TOKEN = process.env.LOVABLE_AUTH_TOKEN; // Firebase JWT from Lovable session (~1hr expiry)
const LOVABLE_PROJECT_ID = process.env.LOVABLE_PROJECT_ID || "760c99a0-8ed1-4f30-9f28-4afbbb9adb18";

// ── Lovable token management ──────────────────────────────────────
// The Firebase JWT (LOVABLE_AUTH_TOKEN) expires after ~1hr.
// The /cloud/query endpoint ONLY accepts the original Firebase JWT —
// project tokens from /auth-token do NOT work for SQL queries.
// So we just validate the token is still alive, but do NOT replace it.

async function validateLovableToken() {
  if (!LOVABLE_AUTH_TOKEN) return;
  try {
    const resp = await fetch(
      `https://api.lovable.dev/projects/${LOVABLE_PROJECT_ID}/auth-token`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${LOVABLE_AUTH_TOKEN}`,
          "Content-Type": "application/json",
          "Origin": "https://lovable.dev",
        },
      }
    );
    if (!resp.ok) {
      if (resp.status === 401) {
        console.log("  ⚠ Lovable Firebase JWT expired — auth.users will be stubs.");
        console.log("    To fix: open Lovable in browser, copy a fresh LOVABLE_AUTH_TOKEN from DevTools,");
        console.log("    paste it into .env.local, and re-run.");
        LOVABLE_AUTH_TOKEN = null;
      } else {
        console.error(`  ✗ Token validation failed (${resp.status}): ${await resp.text()}`);
      }
      return;
    }
    const data = await resp.json();
    console.log(`  ✓ Lovable Firebase JWT valid (project token expires: ${data.expires_at})`);
    // Keep LOVABLE_AUTH_TOKEN as the original Firebase JWT — do NOT replace
  } catch (e) {
    console.error(`  ✗ Token validation error: ${e.message}`);
  }
}

// Auto-detect local vs remote destination
function isLocalDest() {
  try {
    const u = new URL(DEST_URL);
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(u.hostname) || u.hostname.endsWith(".local");
  } catch {
    return true;
  }
}
const IS_REMOTE_DEST = !isLocalDest();

// Extract project ref from DEST_URL (e.g. "https://xyz.supabase.co" → "xyz")
function extractProjectRef() {
  try {
    const u = new URL(DEST_URL);
    const match = u.hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
const DEST_PROJECT_REF = extractProjectRef();

// Postgres client for remote destinations (direct connection)
let pgPool = null;
let pgConnectionFailed = false;

function getPgPool() {
  if (pgPool) return pgPool;
  if (pgConnectionFailed) return null;
  if (!DEST_DB_URL) {
    pgConnectionFailed = true;
    return null;
  }
  pgPool = new pg.Pool({
    connectionString: DEST_DB_URL,
    ssl: DEST_DB_URL.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
  });
  return pgPool;
}

// ── Supabase Management API fallback ───────────────────────────────────────
// Used when direct pg connection is unavailable (e.g. IPv6-only hosts)
async function managementApiSQL(sql) {
  if (!SUPABASE_ACCESS_TOKEN || !DEST_PROJECT_REF) {
    throw new Error(
      "Cannot reach database directly. Set SUPABASE_ACCESS_TOKEN and ensure " +
      "DEST_SUPABASE_URL is a Supabase-hosted URL (https://xyz.supabase.co) " +
      "to use the Management API fallback."
    );
  }
  const resp = await fetch(
    `https://api.supabase.com/v1/projects/${DEST_PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Management API error (${resp.status}): ${body}`);
  }
  const data = await resp.json();
  // Management API returns an array of row objects
  return data;
}

if (!SOURCE_URL || !SOURCE_KEY || !DEST_URL || !DEST_KEY) {
  console.error(
    "Missing env vars. Set SOURCE_SUPABASE_URL, SOURCE_SERVICE_ROLE_KEY, DEST_SUPABASE_URL, DEST_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const source = createClient(SOURCE_URL, SOURCE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const dest = createClient(DEST_URL, DEST_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Tables in FK-safe insert order ──────────────────────────────────────────
const TABLE_ORDER = [
  // Root / independent
  "admin_accounts",
  "subscription_plans",
  "subscription_settings",
  "credit_packages",
  "credit_costs",
  "topup_packages",
  "copilot_system_prompts",
  "system_prompt_versions",
  "prompt_knowledge",
  "preset_sections",
  "homepage_sections",
  "flow_categories",
  "demo_budget",
  "demo_links",
  "redemption_codes",
  "phone_otps",

  // User-linked
  "profiles",
  "user_roles",
  "user_credits",
  "brand_contexts",
  "user_personas",
  "cash_wallets",
  "cash_wallet_transactions",

  "presets",

  // Flows
  "flows",
  "flow_category_mappings",
  "flow_nodes",
  "flow_versions",
  "flow_runs",
  "flow_reviews",
  "flow_badges",
  "flow_metrics",
  "flow_test_runs",
  "flow_user_reviews",
  "pipeline_executions",
  "provider_retry_queue",

  // Bundles
  "bundles",
  "bundle_flows",

  // Credits/payments
  "credit_batches",
  "credit_transactions",
  "payment_transactions",
  "topup_redemptions",

  // Angle prompts
  "angle_prompts",
  "angle_prompt_inputs",
  "angle_prompt_steps",

  // Homepage
  "homepage_featured",

  // Community
  "community_posts",
  "community_likes",
  "community_comments",

  // Chat
  "chat_conversations",
  "chat_messages",

  // Misc
  "notifications",
  "partner_leads",
  "stock_downloads",
  "processing_jobs",
  "user_assets",

  // Spaces
  "spaces",
  "space_nodes",
  "space_edges",

  // Referrals/Partners
  "referral_codes",
  "referral_clicks",
  "referrals",
  "referral_credit_grants",
  "partner_applications",
  "partners",
  "commission_events",
  "payout_requests",
  "fraud_flags",
  "cash_wallet_withdrawals",
  "partner_admin_notes",

  // Logs
  "admin_audit_logs",
  "affiliate_audit_log",
  "rate_limits",
];

const STORAGE_BUCKETS = [
  { name: "ai-media", public: false },
  { name: "user_assets", public: false },
  { name: "videos", public: false },
  { name: "kyc-docs", public: false },
  { name: "landing-videos", public: true },
  { name: "preset-thumbnails", public: true },
  { name: "angle-prompt-media", public: true },
  { name: "flow-assets", public: true },
];

// PK overrides
const PK_MAP = {
  flow_metrics: "flow_id",
  user_credits: "user_id",
  subscription_settings: "key",
  cash_wallets: "user_id",
  partners: "user_id",
};

// Generated columns (cannot be inserted)
const GENERATED_COLUMNS = {
  flow_reviews: ["total_score"],
};

// FK constraints to temporarily drop before inserting (orphan references)
// Format: { table: [{ constraint, restore_sql? }] }
// If restore_sql is omitted, the FK is left dropped (e.g. references a table that doesn't exist)
const DROP_FK_BEFORE_INSERT = {
  flow_reviews: [
    { constraint: "flow_reviews_reviewer_id_fkey" },
  ],
};

// Special parent table: AUTH_USERS — virtual table representing auth.users.
// Any FK pointing to auth.users.id is checked against this set.
const AUTH_USERS = "__auth_users__";

// ── FK_DEPENDENCIES ─────────────────────────────────────────────────────────
// Format: { child_table: [{ column, parent, parentKey?, optional? }] }
//   parent          = table name (or AUTH_USERS for auth.users)
//   parentKey       = parent column referenced (defaults to PK)
//   optional        = if true, skip the check entirely when value is non-null
//                     (use ONLY when source data integrity is trusted)
const FK_DEPENDENCIES = {
  // Self-referential — handled by 2-pass logic
  admin_accounts: [
    { column: "created_by", parent: "admin_accounts", selfRef: true },
  ],

  // User-linked
  profiles: [{ column: "user_id", parent: AUTH_USERS }],
  user_roles: [{ column: "user_id", parent: AUTH_USERS }],
  user_credits: [{ column: "user_id", parent: AUTH_USERS }],
  brand_contexts: [{ column: "user_id", parent: AUTH_USERS }],
  user_personas: [{ column: "user_id", parent: AUTH_USERS }],
  cash_wallets: [{ column: "user_id", parent: AUTH_USERS }],
  cash_wallet_transactions: [{ column: "user_id", parent: AUTH_USERS }],

  // Demo / redemption
  demo_links: [
    { column: "created_by", parent: AUTH_USERS },
    { column: "redeemed_by", parent: AUTH_USERS },
  ],
  redemption_codes: [{ column: "redeemed_by", parent: AUTH_USERS }],

  // Presets
  presets: [{ column: "section", parent: "preset_sections", parentKey: "key" }],

  // Flows
  flows: [{ column: "user_id", parent: AUTH_USERS }],
  flow_category_mappings: [
    { column: "flow_id", parent: "flows" },
    { column: "category_id", parent: "flow_categories" },
  ],
  flow_nodes: [{ column: "flow_id", parent: "flows" }],
  flow_versions: [
    { column: "flow_id", parent: "flows" },
    { column: "created_by", parent: AUTH_USERS },
  ],
  flow_runs: [
    { column: "flow_id", parent: "flows" },
    { column: "user_id", parent: AUTH_USERS },
  ],
  flow_reviews: [
    { column: "flow_id", parent: "flows" },
    { column: "reviewer_id", parent: "admin_accounts" },
  ],
  flow_badges: [
    { column: "flow_id", parent: "flows" },
    { column: "assigned_by", parent: AUTH_USERS },
  ],
  flow_metrics: [{ column: "flow_id", parent: "flows" }],
  flow_test_runs: [
    { column: "flow_id", parent: "flows" },
    { column: "node_id", parent: "flow_nodes" },
    { column: "user_id", parent: AUTH_USERS },
  ],
  flow_user_reviews: [
    { column: "flow_id", parent: "flows" },
    { column: "flow_run_id", parent: "flow_runs" },
    { column: "user_id", parent: AUTH_USERS },
  ],
  pipeline_executions: [
    { column: "flow_id", parent: "flows" },
    { column: "flow_run_id", parent: "flow_runs" },
    { column: "user_id", parent: AUTH_USERS },
  ],
  provider_retry_queue: [
    { column: "flow_run_id", parent: "flow_runs" },
  ],

  // Bundles
  bundles: [{ column: "user_id", parent: AUTH_USERS }],
  bundle_flows: [
    { column: "bundle_id", parent: "bundles" },
    { column: "flow_id", parent: "flows" },
  ],

  // Credits/payments
  credit_batches: [{ column: "user_id", parent: AUTH_USERS }],
  credit_transactions: [{ column: "user_id", parent: AUTH_USERS }],
  payment_transactions: [
    { column: "user_id", parent: AUTH_USERS },
    { column: "package_id", parent: "credit_packages" },
  ],
  topup_redemptions: [
    { column: "user_id", parent: AUTH_USERS },
    { column: "topup_package_id", parent: "topup_packages" },
  ],

  // Angle prompts
  angle_prompt_inputs: [{ column: "angle_prompt_id", parent: "angle_prompts" }],
  angle_prompt_steps: [{ column: "angle_prompt_id", parent: "angle_prompts" }],

  // Homepage
  homepage_featured: [
    { column: "flow_id", parent: "flows" },
    { column: "section_id", parent: "homepage_sections" },
  ],

  // Community
  community_posts: [{ column: "user_id", parent: AUTH_USERS }],
  community_likes: [
    { column: "post_id", parent: "community_posts" },
    { column: "user_id", parent: AUTH_USERS },
  ],
  community_comments: [
    { column: "post_id", parent: "community_posts" },
    { column: "user_id", parent: AUTH_USERS },
  ],

  // Chat
  chat_conversations: [{ column: "user_id", parent: AUTH_USERS }],
  chat_messages: [
    { column: "conversation_id", parent: "chat_conversations" },
    { column: "user_id", parent: AUTH_USERS },
  ],

  // Misc
  notifications: [{ column: "user_id", parent: AUTH_USERS }],
  partner_leads: [{ column: "user_id", parent: AUTH_USERS }],
  stock_downloads: [{ column: "user_id", parent: AUTH_USERS }],
  processing_jobs: [{ column: "user_id", parent: AUTH_USERS }],
  user_assets: [{ column: "user_id", parent: AUTH_USERS }],

  // Spaces
  spaces: [{ column: "user_id", parent: AUTH_USERS }],
  space_nodes: [{ column: "space_id", parent: "spaces" }],
  space_edges: [{ column: "space_id", parent: "spaces" }],

  // Referrals
  referral_codes: [{ column: "user_id", parent: AUTH_USERS }],
  referral_clicks: [{ column: "code_id", parent: "referral_codes" }],
  referrals: [
    { column: "code_id", parent: "referral_codes" },
    { column: "referrer_user_id", parent: AUTH_USERS },
    { column: "referred_user_id", parent: AUTH_USERS },
  ],
  referral_credit_grants: [
    { column: "referral_id", parent: "referrals" },
    { column: "user_id", parent: AUTH_USERS },
  ],
  partner_applications: [
    { column: "user_id", parent: AUTH_USERS },
    { column: "reviewed_by", parent: AUTH_USERS },
  ],
  partners: [
    { column: "user_id", parent: AUTH_USERS },
    { column: "application_id", parent: "partner_applications" },
  ],
  commission_events: [
    { column: "referral_id", parent: "referrals" },
    { column: "partner_user_id", parent: AUTH_USERS },
    { column: "referred_user_id", parent: AUTH_USERS },
    { column: "payout_id", parent: "payout_requests", optional: true },
  ],
  payout_requests: [
    { column: "partner_user_id", parent: AUTH_USERS },
    { column: "processed_by", parent: AUTH_USERS },
    { column: "approved_by", parent: AUTH_USERS },
    { column: "paid_by", parent: "profiles" },
    { column: "rejected_by", parent: "profiles" },
  ],
  fraud_flags: [
    { column: "partner_id", parent: "partners", parentKey: "user_id" },
    { column: "referred_user_id", parent: AUTH_USERS },
    { column: "actioned_by", parent: AUTH_USERS },
  ],
  cash_wallet_withdrawals: [
    { column: "user_id", parent: AUTH_USERS },
    { column: "paid_by", parent: AUTH_USERS },
    { column: "rejected_by", parent: AUTH_USERS },
  ],
  partner_admin_notes: [
    { column: "partner_user_id", parent: AUTH_USERS },
    { column: "admin_user_id", parent: AUTH_USERS },
  ],

  // Logs
  admin_audit_logs: [
    { column: "admin_user_id", parent: AUTH_USERS },
    { column: "target_user_id", parent: AUTH_USERS },
  ],
  affiliate_audit_log: [{ column: "actor_id", parent: AUTH_USERS }],
  rate_limits: [{ column: "user_id", parent: AUTH_USERS }],
};

// State buckets
const insertedIds = {};            // insertedIds[table][parentKey] = Set
const nullableCols = {};           // nullableCols[table] = Set of nullable column names
const destColumnsCache = {};       // destColumnsCache[table] = Set
const authUserIdSet = new Set();   // all known auth.users IDs (after sync)

// ── SQL execution helpers ───────────────────────────────────────────────────
const IS_WIN = process.platform === "win32";

// Local: execute SQL via docker exec + psql
function psqlLocal(sql, opts = {}) {
  if (IS_WIN) {
    const tmpFile = join(tmpdir(), `mf_migrate_${Date.now()}.sql`);
    const containerFile = `/tmp/mf_migrate_${Date.now()}.sql`;
    try {
      writeFileSync(tmpFile, sql, "utf8");
      execSync(`docker cp "${tmpFile}" ${DB_CONTAINER}:${containerFile}`, {
        stdio: ["pipe", "pipe", "pipe"], timeout: 10000
      });
      const result = execSync(
        `docker exec ${DB_CONTAINER} psql -U postgres -d postgres ${opts.flags || ""} -f ${containerFile}`,
        { stdio: ["pipe", "pipe", "pipe"], timeout: opts.timeout || 30000 }
      );
      try { execSync(`docker exec ${DB_CONTAINER} rm -f ${containerFile}`, { stdio: "pipe" }); } catch {}
      return result;
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
  return execSync(
    `docker exec -i ${DB_CONTAINER} psql -U postgres -d postgres ${opts.flags || ""}`,
    { input: sql, stdio: ["pipe", "pipe", "pipe"], timeout: opts.timeout || 30000 }
  );
}

// Remote: execute SQL via pg Pool, with Management API fallback
async function psqlRemote(sql) {
  // Try direct pg connection first
  const pool = getPgPool();
  if (pool && !pgConnectionFailed) {
    try {
      const result = await pool.query(sql);
      return result;
    } catch (e) {
      if (e.message?.includes("ENOTFOUND") || e.message?.includes("ETIMEDOUT") || e.message?.includes("ECONNREFUSED")) {
        console.log(`  ⚠ Direct pg connection failed, switching to Management API fallback`);
        pgConnectionFailed = true;
        try { await pool.end(); } catch {}
        pgPool = null;
      } else {
        throw e;
      }
    }
  }
  // Fallback to Management API
  const rows = await managementApiSQL(sql);
  // Normalize to pg-compatible result shape
  return { rows: Array.isArray(rows) ? rows : [] };
}

// Execute raw SQL — returns string[] of pipe-delimited rows (matching psqlQuery interface)
async function execSQL(sql) {
  if (IS_REMOTE_DEST) {
    try {
      const result = await psqlRemote(sql);
      return result.rows.map((row) => Object.values(row).join("|"));
    } catch (e) {
      console.error(`  ✗ SQL query failed: ${e.message}`);
      return [];
    }
  }
  // Local path
  try {
    const result = psqlLocal(sql, { flags: `-t -A -F"|"`, timeout: 15000 });
    return result.toString().trim().split("\n").filter(Boolean);
  } catch (e) {
    console.error(`  ✗ psql query failed: ${e.stderr?.toString() || e.message}`);
    return [];
  }
}

// Execute raw SQL statement (no return value needed)
async function execSQLStatement(sql, opts = {}) {
  if (IS_REMOTE_DEST) {
    try {
      await psqlRemote(sql);
    } catch (e) {
      if (opts.silent) return;
      throw e;
    }
    return;
  }
  psqlLocal(sql, { timeout: opts.timeout || 30000 });
}

// Execute SQL as superuser (for auth schema operations)
async function execSQLSuperuser(sql) {
  if (IS_REMOTE_DEST) {
    // Remote: DEST_DB_URL should already have sufficient privileges (service_role / postgres user)
    await psqlRemote(sql);
    return;
  }
  // Local: use supabase_admin via docker
  const escaped = sql.replace(/"/g, '\\"');
  execSync(
    `docker exec -e PGPASSWORD=postgres ${DB_CONTAINER} psql -h 127.0.0.1 -U supabase_admin -d postgres -c "${escaped}"`,
    { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }
  );
}

// ── Schema introspection ────────────────────────────────────────────────────
async function loadDestSchema(table) {
  if (destColumnsCache[table]) return;
  const rows = await execSQL(
    `SELECT column_name, is_nullable FROM information_schema.columns ` +
    `WHERE table_schema='public' AND table_name='${table}' ORDER BY ordinal_position;`
  );
  if (rows.length === 0) {
    destColumnsCache[table] = null; // table doesn't exist
    nullableCols[table] = new Set();
    return;
  }
  const cols = new Set();
  const nulls = new Set();
  for (const r of rows) {
    const [name, isNullable] = r.split("|");
    cols.add(name);
    if (isNullable === "YES") nulls.add(name);
  }
  destColumnsCache[table] = cols;
  nullableCols[table] = nulls;
}

async function getDestColumns(table) {
  await loadDestSchema(table);
  return destColumnsCache[table];
}

async function isNullableAsync(table, column) {
  await loadDestSchema(table);
  return nullableCols[table]?.has(column) ?? true;
}

// Sync version for use in processFKs (schema must be pre-loaded)
function isNullable(table, column) {
  return nullableCols[table]?.has(column) ?? true;
}

// ── Utilities ───────────────────────────────────────────────────────────────
function recordInsertedIds(table, rows) {
  if (!rows || rows.length === 0) return;
  const pk = PK_MAP[table] || "id";
  if (!insertedIds[table]) insertedIds[table] = {};
  if (!insertedIds[table][pk]) insertedIds[table][pk] = new Set();
  const set = insertedIds[table][pk];
  for (const row of rows) {
    const val = row[pk];
    if (val !== undefined && val !== null) set.add(val);
  }
  // Also index user_id for cross-reference convenience
  if (pk !== "user_id" && rows[0] && "user_id" in rows[0]) {
    if (!insertedIds[table]["user_id"]) insertedIds[table]["user_id"] = new Set();
    const uset = insertedIds[table]["user_id"];
    for (const row of rows) if (row.user_id) uset.add(row.user_id);
  }
}

function getParentSet(parentTable, parentKey) {
  if (parentTable === AUTH_USERS) return authUserIdSet;
  return insertedIds[parentTable]?.[parentKey];
}

/**
 * Process FK constraints for each row:
 *   - If FK value is null/undefined → leave as is
 *   - If FK value points to existing parent → leave as is
 *   - If FK value is orphan AND column nullable → SET NULL (preserve row)
 *   - If FK value is orphan AND column NOT nullable → DROP row
 *   - selfRef columns → always set null on first pass (resolved in pass 2)
 */
function processFKs(table, rows) {
  const deps = FK_DEPENDENCIES[table];
  if (!deps || rows.length === 0) {
    return { kept: rows, dropped: 0, nulled: {}, deferredSelfRef: [] };
  }
  // Schema must be pre-loaded before calling processFKs

  const nulled = {};   // { column: count }
  const droppedReasons = {};
  const kept = [];
  const deferredSelfRef = []; // [{ pkValue, column, originalValue }]
  const pk = PK_MAP[table] || "id";

  for (const row of rows) {
    let dropRow = false;
    let dropReason = null;

    for (const dep of deps) {
      const value = row[dep.column];

      // Self-referential columns: always null on pass 1, defer to pass 2
      if (dep.selfRef && value !== null && value !== undefined) {
        deferredSelfRef.push({
          pkValue: row[pk],
          column: dep.column,
          originalValue: value,
        });
        row[dep.column] = null;
        continue;
      }

      if (value === null || value === undefined) continue;

      const parentKey = dep.parentKey || PK_MAP[dep.parent] || "id";
      const parentSet = getParentSet(dep.parent, parentKey);

      // Parent table never populated → if optional flag set, trust source data
      if (!parentSet) {
        if (dep.optional) continue;
        // Cannot validate; trust source rather than mass-drop
        continue;
      }

      if (parentSet.has(value)) continue; // FK valid

      // Orphan
      const colNullable = isNullable(table, dep.column);
      if (colNullable) {
        row[dep.column] = null;
        nulled[dep.column] = (nulled[dep.column] || 0) + 1;
      } else {
        dropRow = true;
        dropReason = `${dep.column}→${dep.parent} (NOT NULL, orphan)`;
        break;
      }
    }

    if (dropRow) {
      droppedReasons[dropReason] = (droppedReasons[dropReason] || 0) + 1;
    } else {
      kept.push(row);
    }
  }

  return {
    kept,
    dropped: rows.length - kept.length,
    droppedReasons,
    nulled,
    deferredSelfRef,
  };
}

function filterColumns(rows, destColumns, table) {
  if (!destColumns || rows.length === 0) return rows;
  const sourceColumns = Object.keys(rows[0]);
  const dropped = sourceColumns.filter((c) => !destColumns.has(c));
  if (dropped.length > 0) {
    console.log(`\n  ⚠ ${table}: dropping unknown columns [${dropped.join(", ")}]`);
  }
  if (dropped.length === 0) return rows;
  return rows.map((row) => {
    const f = {};
    for (const [k, v] of Object.entries(row)) if (destColumns.has(k)) f[k] = v;
    return f;
  });
}

function stripGenerated(rows, table) {
  const cols = GENERATED_COLUMNS[table];
  if (!cols) return rows;
  return rows.map((row) => {
    const c = { ...row };
    for (const col of cols) delete c[col];
    return c;
  });
}

// ── Schema reset ────────────────────────────────────────────────────────────
async function resetSchema() {
  console.log("\n┌──────────────────────────────────────────────────┐");
  console.log("│  Phase 0: Schema Reset                           │");
  console.log("└──────────────────────────────────────────────────┘\n");

  if (IS_REMOTE_DEST) {
    console.log("  ⚠ Schema reset is not supported for remote destinations.");
    console.log("  Remote databases should have migrations applied via Supabase dashboard or CLI.");
    console.log("  Skipping schema reset. Set SKIP_SCHEMA=true to suppress this message.\n");
    return { success: true, skipped: true };
  }

  try {
    console.log("  Running supabase db reset...");
    const out = execSync("npx supabase db reset", {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 180000,
    });
    if (out.toString()) console.log("  " + out.toString().trim().split("\n").join("\n  "));
    console.log("  ✅ Schema reset complete\n");
    return { success: true };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;
    if (stderr.includes("Finished supabase db reset") || stderr.includes("Restarting containers")) {
      console.log("  ✅ Schema reset complete\n");
      await new Promise((r) => setTimeout(r, 5000));
      return { success: true };
    }
    console.error("  ✗ Schema reset failed:", stderr);
    return { success: false };
  }
}

// ── Lovable API: fetch real auth.users from source ─────────────────────────
async function fetchSourceAuthUsers() {
  if (!LOVABLE_AUTH_TOKEN) return null;
  const url = `https://api.lovable.dev/projects/${LOVABLE_PROJECT_ID}/cloud/query?env=prod`;
  const sql = `SELECT id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous, created_at, updated_at FROM auth.users`;
  try {
    console.log("  Fetching real auth.users via Lovable API...");
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LOVABLE_AUTH_TOKEN}`,
        "Content-Type": "application/json",
        "Origin": "https://lovable.dev",
      },
      body: JSON.stringify({ query: sql, source: "sql-editor" }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`  ✗ Lovable API error (${resp.status}): ${body}`);
      return null;
    }
    const data = await resp.json();
    // The API returns { result: [...] }
    const rows = Array.isArray(data) ? data : data?.result ?? data?.rows ?? data?.data ?? [];
    console.log(`  ✓ Fetched ${rows.length} real auth.users from Lovable API`);
    return rows;
  } catch (e) {
    console.error(`  ✗ Lovable API fetch failed: ${e.message}`);
    return null;
  }
}

// ── auth.users sync ─────────────────────────────────────────────────────────
async function syncAuthUsers() {
  console.log("  Collecting all user_id values from source...");

  // Step 1: Try to fetch real auth.users from Lovable API
  const realAuthUsers = await fetchSourceAuthUsers();
  const realUserMap = new Map(); // id → row
  if (realAuthUsers && realAuthUsers.length > 0) {
    for (const row of realAuthUsers) {
      if (row.id) realUserMap.set(row.id, row);
    }
    console.log(`  ✓ ${realUserMap.size} real auth.users available for insert`);
  } else {
    console.log("  ⚠ No real auth.users data — will use stubs for all users");
  }

  // Step 2: Collect every user_id from public tables (safety net for orphan IDs)
  const userIds = new Set();

  try {
    const profiles = await fetchAll(source, "profiles");
    profiles.forEach((p) => p.user_id && userIds.add(p.user_id));
  } catch (e) {
    console.log(`  ⚠ Could not fetch profiles: ${e.message}`);
  }

  for (const [table, deps] of Object.entries(FK_DEPENDENCIES)) {
    const userCols = deps.filter((d) => d.parent === AUTH_USERS).map((d) => d.column);
    if (userCols.length === 0) continue;
    try {
      const rows = await fetchAll(source, table);
      for (const row of rows) {
        for (const col of userCols) {
          if (row[col]) userIds.add(row[col]);
        }
      }
    } catch {
      // Table doesn't exist in source; skip silently
    }
  }

  // Also include IDs from real auth.users that may not appear in public tables
  for (const id of realUserMap.keys()) {
    userIds.add(id);
  }

  if (userIds.size === 0) {
    console.log("  No user IDs found, skipping auth.users sync.\n");
    return;
  }

  console.log(`  Inserting ${userIds.size} auth.users (${realUserMap.size} real, ${userIds.size - realUserMap.size} stubs)...`);

  const ids = [...userIds];
  const chunkSize = 500;
  let inserted = 0;

  // Strategy depends on whether we can disable triggers
  const useReplicaRole = IS_REMOTE_DEST && pgConnectionFailed;

  if (!useReplicaRole) {
    try {
      await execSQLSuperuser(`ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created;`);
      console.log("  (disabled on_auth_user_created trigger for insert)");
    } catch (e) {
      console.log(`  ⚠ Could not disable trigger: ${e.message}`);
    }
  }

  // Helper: escape a SQL string value (single quotes)
  const esc = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  // Helper: escape JSONB — stringify objects, pass strings as-is
  const escJson = (v) => {
    if (v == null) return "'{}'::jsonb";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `'${s.replace(/'/g, "''")}'::jsonb`;
  };
  // Helper: escape timestamp
  const escTs = (v) => (v == null ? "NULL" : `'${v}'::timestamptz`);
  // Helper: escape boolean
  const escBool = (v) => (v === true ? "true" : v === false ? "false" : "false");

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const values = chunk
      .map((id) => {
        const real = realUserMap.get(id);
        if (real) {
          // Insert with real data
          return `(${esc(real.instance_id || "00000000-0000-0000-0000-000000000000")},${esc(real.id)},${esc(real.aud || "authenticated")},${esc(real.role || "authenticated")},${esc(real.email)},${esc(real.encrypted_password || "")},${escTs(real.created_at)},${escTs(real.updated_at)},${escJson(real.raw_app_meta_data)},${escJson(real.raw_user_meta_data)},${escTs(real.email_confirmed_at)},${escBool(real.is_sso_user)},${escBool(real.is_anonymous)},${esc(real.phone)},${escTs(real.phone_confirmed_at)})`;
        }
        // Stub fallback
        return `('00000000-0000-0000-0000-000000000000',${esc(id)},'authenticated','authenticated','stub-${id}@local.dev','',now(),now(),'{}'::jsonb,'{}'::jsonb,now(),false,false,NULL,NULL)`;
      })
      .join(",");

    const insertSQL = `INSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,is_sso_user,is_anonymous,phone,phone_confirmed_at) VALUES ${values} ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, encrypted_password=EXCLUDED.encrypted_password, raw_app_meta_data=EXCLUDED.raw_app_meta_data, raw_user_meta_data=EXCLUDED.raw_user_meta_data, email_confirmed_at=EXCLUDED.email_confirmed_at, phone=EXCLUDED.phone, phone_confirmed_at=EXCLUDED.phone_confirmed_at, updated_at=EXCLUDED.updated_at, is_sso_user=EXCLUDED.is_sso_user, is_anonymous=EXCLUDED.is_anonymous;`;
    const sql = useReplicaRole
      ? `SET session_replication_role = 'replica';\n${insertSQL}\nSET session_replication_role = 'origin';`
      : insertSQL;

    try {
      await execSQLStatement(sql, { timeout: 30000 });
      inserted += chunk.length;
    } catch (e) {
      console.error(`  ✗ chunk ${i}: ${e.message}`);
    }
  }

  if (!useReplicaRole) {
    try {
      await execSQLSuperuser(`ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created;`);
    } catch {}
  }

  // Verify
  try {
    const verifyRows = await execSQL(`SELECT count(*) FROM auth.users;`);
    const actualCount = parseInt(verifyRows[0] || "0", 10);
    if (actualCount === 0 && ids.length > 0) {
      console.error(`  ⚠ Verification failed: 0 auth.users found after insert!`);
      console.log(`  Retrying with session_replication_role = replica...`);
      try {
        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const values = chunk
            .map((id) => {
              const real = realUserMap.get(id);
              if (real) {
                return `(${esc(real.instance_id || "00000000-0000-0000-0000-000000000000")},${esc(real.id)},${esc(real.aud || "authenticated")},${esc(real.role || "authenticated")},${esc(real.email)},${esc(real.encrypted_password || "")},${escTs(real.created_at)},${escTs(real.updated_at)},${escJson(real.raw_app_meta_data)},${escJson(real.raw_user_meta_data)},${escTs(real.email_confirmed_at)},${escBool(real.is_sso_user)},${escBool(real.is_anonymous)},${esc(real.phone)},${escTs(real.phone_confirmed_at)})`;
              }
              return `('00000000-0000-0000-0000-000000000000',${esc(id)},'authenticated','authenticated','stub-${id}@local.dev','',now(),now(),'{}'::jsonb,'{}'::jsonb,now(),false,false,NULL,NULL)`;
            })
            .join(",");
          const retrySql = `SET session_replication_role = 'replica';\nINSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,is_sso_user,is_anonymous,phone,phone_confirmed_at) VALUES ${values} ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, encrypted_password=EXCLUDED.encrypted_password, raw_app_meta_data=EXCLUDED.raw_app_meta_data, raw_user_meta_data=EXCLUDED.raw_user_meta_data, email_confirmed_at=EXCLUDED.email_confirmed_at, phone=EXCLUDED.phone, phone_confirmed_at=EXCLUDED.phone_confirmed_at, updated_at=EXCLUDED.updated_at, is_sso_user=EXCLUDED.is_sso_user, is_anonymous=EXCLUDED.is_anonymous;\nSET session_replication_role = 'origin';`;
          await execSQLStatement(retrySql, { timeout: 30000 });
        }
        const retryRows = await execSQL(`SELECT count(*) FROM auth.users;`);
        inserted = parseInt(retryRows[0] || "0", 10);
        console.log(`  ✅ Retry result: ${inserted} auth.users now exist`);
      } catch (retryErr) {
        console.error(`  ✗ Retry failed: ${retryErr.message}`);
      }
    } else {
      console.log(`  ✓ Verified: ${actualCount} auth.users in database`);
    }
  } catch {}

  ids.forEach((id) => authUserIdSet.add(id));
  const realCount = ids.filter((id) => realUserMap.has(id)).length;
  const stubCount = ids.length - realCount;
  console.log(`  ✅ Inserted ${inserted}/${ids.length} auth.users (${realCount} real, ${stubCount} stubs)\n`);
}

// ── DB helpers ──────────────────────────────────────────────────────────────
async function fetchAll(client, table, batchSize = 1000) {
  const rows = [];
  let from = 0;
  while (true) {
    let res = await client
      .from(table)
      .select("*")
      .range(from, from + batchSize - 1)
      .order("created_at", { ascending: true, nullsFirst: true });
    if (res.error?.message?.includes("created_at")) {
      res = await client.from(table).select("*").range(from, from + batchSize - 1);
    }
    if (res.error) throw new Error(`Fetch ${table}: ${res.error.message}`);
    if (!res.data || res.data.length === 0) break;
    rows.push(...res.data);
    if (res.data.length < batchSize) break;
    from += batchSize;
  }
  return rows;
}

/**
 * Upsert with smart per-row recovery on FK violations.
 */
async function upsertBatch(client, table, rows, batchSize = 500) {
  const pk = PK_MAP[table] || "id";
  const successful = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await client
      .from(table)
      .upsert(batch, { onConflict: pk, ignoreDuplicates: false });

    if (!error) {
      successful.push(...batch);
      continue;
    }

    console.error(`  ✗ Upsert ${table} [${i}-${i + batch.length}]: ${error.message}`);
    // Per-row fallback with FK auto-nullify on 23503
    for (const row of batch) {
      let attempt = { ...row };
      let lastErr = null;
      for (let tryNo = 0; tryNo < 3; tryNo++) {
        const { error: e2 } = await client
          .from(table)
          .upsert(attempt, { onConflict: pk, ignoreDuplicates: false });
        if (!e2) {
          successful.push(attempt);
          lastErr = null;
          break;
        }
        lastErr = e2;
        // Try to auto-recover from FK violations
        const fkMatch = e2.message?.match(/foreign key constraint "([^"]+)"/i);
        const colMatch = e2.message?.match(/Key \(([^)]+)\)=/);
        if (fkMatch && colMatch) {
          const col = colMatch[1];
          if (col in attempt && isNullable(table, col)) {
            attempt = { ...attempt, [col]: null };
            continue;
          }
        }
        break;
      }
      if (lastErr) {
        console.error(`    ✗ Row ${row[pk] || "?"}: ${lastErr.message}`);
      }
    }
  }
  return successful;
}

/**
 * Resolve self-referential FKs after the table is fully populated.
 */
async function resolveSelfReferences(table, deferredList) {
  if (deferredList.length === 0) return;
  const pk = PK_MAP[table] || "id";
  console.log(`  Resolving ${deferredList.length} self-references in ${table}...`);
  let ok = 0;
  for (const { pkValue, column, originalValue } of deferredList) {
    // Only set if the parent key now exists in inserted set
    const parentSet = insertedIds[table]?.[pk];
    if (!parentSet || !parentSet.has(originalValue)) continue;
    const { error } = await dest
      .from(table)
      .update({ [column]: originalValue })
      .eq(pk, pkValue);
    if (!error) ok++;
    else console.error(`    ✗ ${pkValue}.${column}: ${error.message}`);
  }
  console.log(`  ✅ Resolved ${ok}/${deferredList.length} self-references`);
}

// ── Storage helpers ─────────────────────────────────────────────────────────
async function listAllFiles(client, bucket, folder = "", allFiles = []) {
  const { data, error } = await client.storage.from(bucket).list(folder, { limit: 1000, offset: 0 });
  if (error) {
    console.error(`  ✗ List ${bucket}/${folder}: ${error.message}`);
    return allFiles;
  }
  for (const item of data || []) {
    const path = folder ? `${folder}/${item.name}` : item.name;
    if (item.id) allFiles.push(path);
    else await listAllFiles(client, bucket, path, allFiles);
  }
  return allFiles;
}

async function migrateFile(srcClient, destClient, bucket, filePath) {
  const { data: blob, error: dlErr } = await srcClient.storage.from(bucket).download(filePath);
  if (dlErr) {
    console.error(`    ✗ Download ${bucket}/${filePath}: ${dlErr.message}`);
    return false;
  }
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const mimeMap = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
    mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    pdf: "application/pdf", json: "application/json",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";
  const { error: upErr } = await destClient.storage
    .from(bucket)
    .upload(filePath, blob, { contentType, upsert: true });
  if (upErr) {
    console.error(`    ✗ Upload ${bucket}/${filePath}: ${upErr.message}`);
    return false;
  }
  return true;
}

async function ensureBucket(client, bucket, isPublic) {
  const { error } = await client.storage.createBucket(bucket, { public: isPublic });
  if (error && !error.message?.includes("already exists")) {
    console.error(`  ⚠ Create bucket ${bucket}: ${error.message}`);
  }
}

// ── Database migration ──────────────────────────────────────────────────────
async function migrateDatabase() {
  console.log("\n┌──────────────────────────────────────────────────┐");
  console.log("│  Phase 1: Database Migration                     │");
  console.log("└──────────────────────────────────────────────────┘\n");

  await syncAuthUsers();

  console.log("  Clearing seed data from migration-seeded tables...");
  const seedTables = [
    "credit_costs", "copilot_system_prompts", "system_prompt_versions",
    "preset_sections", "subscription_plans", "homepage_sections",
    "user_roles", "flow_categories", "topup_packages",
    // Also clear trigger-created rows so upsert doesn't conflict
    "profiles", "user_credits", "referral_codes", "cash_wallets",
  ];
  // Skip seed truncation when ONLY_TABLES is set to avoid wiping unrelated data
  if (ONLY_TABLES.length > 0) {
    const relevant = seedTables.filter((t) => ONLY_TABLES.includes(t));
    if (relevant.length > 0) {
      for (const t of relevant) {
        try { await execSQLStatement(`TRUNCATE public.${t} CASCADE;`, { timeout: 10000, silent: true }); } catch {}
      }
      console.log(`  ✅ Cleared seed data for: ${relevant.join(", ")}\n`);
    } else {
      console.log("  ⏭ Skipped seed cleanup (ONLY_TABLES doesn't include seed tables)\n");
    }
  } else {
    for (const t of seedTables) {
      try { await execSQLStatement(`TRUNCATE public.${t} CASCADE;`, { timeout: 10000, silent: true }); } catch {}
    }
    console.log("  ✅ Seed data cleared\n");
  }
  console.log("  ✅ Seed data cleared\n");

  const tables = ONLY_TABLES.length > 0
    ? TABLE_ORDER.filter((t) => ONLY_TABLES.includes(t))
    : TABLE_ORDER;

  const results = [];
  let totalRows = 0;
  let totalNulled = 0;

  for (const table of tables) {
    const t0 = Date.now();
    process.stdout.write(`⏳ ${table.padEnd(28)}`);

    try {
      let rows;
      try {
        rows = await fetchAll(source, table);
      } catch (fetchErr) {
        if (fetchErr.message?.includes("Could not find the table") || fetchErr.message?.includes("does not exist")) {
          console.log(`  → table not in source, skipping`);
          results.push({ table, rows: 0, inserted: 0, ms: Date.now() - t0, status: "skip" });
          continue;
        }
        throw fetchErr;
      }
      if (rows.length === 0) {
        console.log("  → 0 rows (skipped)");
        results.push({ table, rows: 0, inserted: 0, ms: Date.now() - t0, status: "skip" });
        continue;
      }

      const destColumns = await getDestColumns(table);
      if (!destColumns) {
        console.log(`  → table not in destination, skipping`);
        results.push({ table, rows: rows.length, inserted: 0, ms: Date.now() - t0, status: "skip" });
        continue;
      }

      let prepared = filterColumns(rows, destColumns, table);
      prepared = stripGenerated(prepared, table);

      // Ensure schema is loaded for FK processing (isNullable uses sync cache)
      await loadDestSchema(table);
      const { kept, dropped, droppedReasons, nulled, deferredSelfRef } = processFKs(table, prepared);

      if (Object.keys(nulled).length > 0) {
        const ns = Object.entries(nulled).map(([k, v]) => `${k}:${v}`).join(", ");
        console.log(`\n  ↳ ${table}: nullified orphan FKs (${ns})`);
        totalNulled += Object.values(nulled).reduce((a, b) => a + b, 0);
      }

      if (dropped > 0) {
        const rs = Object.entries(droppedReasons).map(([k, v]) => `${k}:${v}`).join(", ");
        console.log(`\n  ⚠ ${table}: dropped ${dropped} rows (${rs})`);
      }

      if (kept.length === 0) {
        console.log(`  → ${rows.length} exported, 0 upserted (all dropped)`);
        results.push({ table, rows: rows.length, inserted: 0, dropped, ms: Date.now() - t0, status: "skip" });
        continue;
      }

      // Temporarily drop problematic FK constraints before insert
      const fksToDropp = DROP_FK_BEFORE_INSERT[table];
      if (fksToDropp) {
        for (const fk of fksToDropp) {
          try {
            await execSQLStatement(`ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${fk.constraint};`, { silent: true });
          } catch {}
        }
      }

      const successfulRows = await upsertBatch(dest, table, kept);
      recordInsertedIds(table, successfulRows);

      // Restore FK constraints if restore_sql is provided
      if (fksToDropp) {
        for (const fk of fksToDropp) {
          if (fk.restore_sql) {
            try { await execSQLStatement(fk.restore_sql, { silent: true }); } catch {}
          }
        }
      }

      // Resolve any deferred self-references
      if (deferredSelfRef.length > 0) {
        await resolveSelfReferences(table, deferredSelfRef);
      }

      const ms = Date.now() - t0;
      const inserted = successfulRows.length;
      totalRows += inserted;
      console.log(`  → ${rows.length} exported, ${inserted} upserted${dropped ? `, ${dropped} dropped` : ""} (${ms}ms)`);
      results.push({ table, rows: rows.length, inserted, dropped, ms, status: "ok" });
    } catch (err) {
      const ms = Date.now() - t0;
      console.log(`  ✗ ERROR: ${err.message} (${ms}ms)`);
      results.push({ table, rows: 0, inserted: 0, ms, status: "error", error: err.message });
    }
  }

  const ok = results.filter((r) => r.status === "ok");
  const skipped = results.filter((r) => r.status === "skip");
  const errors = results.filter((r) => r.status === "error");
  const totalDropped = results.reduce((s, r) => s + (r.dropped || 0), 0);

  console.log(`\n  ✅ Migrated: ${ok.length} tables (${totalRows} total rows)`);
  console.log(`  ⏭  Skipped:  ${skipped.length} tables`);
  if (totalNulled > 0) console.log(`  🔧 Nullified: ${totalNulled} orphan FK values`);
  if (totalDropped > 0) console.log(`  🧹 Dropped:  ${totalDropped} rows (NOT NULL FK orphans)`);
  if (errors.length > 0) {
    console.log(`  ❌ Errors:   ${errors.length} tables:`);
    errors.forEach((e) => console.log(`     - ${e.table}: ${e.error}`));
  }
  return { ok: ok.length, errors: errors.length, totalRows, totalDropped, totalNulled };
}

// ── Storage migration ───────────────────────────────────────────────────────
async function migrateStorage() {
  console.log("\n┌──────────────────────────────────────────────────┐");
  console.log("│  Phase 2: Storage Migration                      │");
  console.log("└──────────────────────────────────────────────────┘\n");

  let totalFiles = 0, totalSuccess = 0, totalFailed = 0;
  for (const bucket of STORAGE_BUCKETS) {
    const t0 = Date.now();
    process.stdout.write(`📦 ${bucket.name.padEnd(24)}`);
    await ensureBucket(dest, bucket.name, bucket.public);
    const files = await listAllFiles(source, bucket.name);
    if (files.length === 0) { console.log("  → 0 files"); continue; }
    console.log(`  → ${files.length} files found`);
    let success = 0, failed = 0;
    for (let i = 0; i < files.length; i++) {
      if ((i + 1) % 10 === 0 || i === files.length - 1) {
        process.stdout.write(`\r   Uploading ${bucket.name}: ${i + 1}/${files.length}...`);
      }
      const ok = await migrateFile(source, dest, bucket.name, files[i]);
      ok ? success++ : failed++;
    }
    const ms = Date.now() - t0;
    console.log(`\r   ✅ ${bucket.name}: ${success} uploaded, ${failed} failed (${(ms / 1000).toFixed(1)}s)`);
    totalFiles += files.length;
    totalSuccess += success;
    totalFailed += failed;
  }
  console.log(`\n  📁 Total: ${totalSuccess}/${totalFiles} files migrated, ${totalFailed} failed`);
  return { totalFiles, totalSuccess, totalFailed };
}

// ── Entry ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  MediaForge Migration V2 (FK-safe + nullable)   ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Source:  ${SOURCE_URL}`);
  console.log(`Dest:    ${DEST_URL}`);
  console.log(`Mode:    ${IS_REMOTE_DEST ? "REMOTE" : "LOCAL (docker psql)"}`);
  if (IS_REMOTE_DEST) {
    if (DEST_DB_URL) {
      const sanitized = DEST_DB_URL.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
      console.log(`DB URL:  ${sanitized}`);
    }
    if (SUPABASE_ACCESS_TOKEN) {
      console.log(`API:     Management API fallback available (project: ${DEST_PROJECT_REF})`);
    } else {
      console.log(`API:     No SUPABASE_ACCESS_TOKEN — Management API fallback disabled`);
    }
  }
  console.log(`Tables:  ${TABLE_ORDER.length}`);
  console.log(`Buckets: ${STORAGE_BUCKETS.length}`);
  if (!IS_REMOTE_DEST) console.log(`Container: ${DB_CONTAINER}`);
  if (LOVABLE_AUTH_TOKEN) {
    console.log(`Lovable:   ✓ Auth token set (project: ${LOVABLE_PROJECT_ID})`);
    // Exchange short-lived Firebase JWT for long-lived project token (~7 days)
    await validateLovableToken();
  } else {
    console.log(`Lovable:   ✗ No LOVABLE_AUTH_TOKEN — auth.users will be stubs`);
  }
  if (SKIP_SCHEMA) console.log("⚠ SKIP_SCHEMA=true");
  if (SKIP_DATA) console.log("⚠ SKIP_DATA=true");
  if (SKIP_STORAGE) console.log("⚠ SKIP_STORAGE=true");
  if (ONLY_TABLES.length) console.log(`⚠ ONLY_TABLES=${ONLY_TABLES.join(",")}`);

  const t0 = Date.now();
  let schemaResult = null, dbResult = null, storageResult = null;
  if (!SKIP_SCHEMA) schemaResult = await resetSchema();
  if (!SKIP_DATA) dbResult = await migrateDatabase();
  if (!SKIP_STORAGE) storageResult = await migrateStorage();

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n════════════════════════════════════════════════════");
  console.log("MIGRATION COMPLETE");
  console.log("════════════════════════════════════════════════════");
  if (schemaResult) console.log(`  Schema:   ${schemaResult.success ? "✅" : "✗"}`);
  if (dbResult) {
    console.log(
      `  Database: ${dbResult.ok} tables, ${dbResult.totalRows} rows` +
      `${dbResult.totalNulled ? `, ${dbResult.totalNulled} FK nullified` : ""}` +
      `${dbResult.totalDropped ? `, ${dbResult.totalDropped} dropped` : ""}` +
      `${dbResult.errors > 0 ? `, ${dbResult.errors} errors` : ""}`
    );
  }
  if (storageResult) {
    console.log(`  Storage:  ${storageResult.totalSuccess}/${storageResult.totalFiles} files`);
  }
  console.log(`  Duration: ${totalSec}s`);

  // Cleanup pg pool if used
  if (pgPool) {
    await pgPool.end();
  }
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  if (pgPool) await pgPool.end().catch(() => {});
  process.exit(1);
});
