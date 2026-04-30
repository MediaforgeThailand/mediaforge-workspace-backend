# CLAUDE.md — mediaforge-workspace-backend

## Overview

Supabase backend for the MediaForge **Workspace** product — a
node-based canvas editor for chaining AI tools, deployed at
**workspace.mediaforge.co**. Companion frontend repo:
`mediaforge-workspace-frontend`.

## Project

- **Supabase Project:** `fymncypboeubdikpbmqc` (ap-southeast-1, Singapore)
- **Dashboard:** https://supabase.com/dashboard/project/fymncypboeubdikpbmqc

## Structure

```
supabase/
  config.toml            # Supabase project config (function JWT settings)
  migrations/            # PostgreSQL migrations (applied via supabase db push)
  functions/             # Deno edge functions
    _shared/             # Shared utilities
      adminAuth.ts       # Admin JWT verifier (HMAC-SHA256, used by admin_workspace_* fns)
      auth.ts            # User JWT helpers (getAuthUser, isServiceRole, unauthorized)
      orgUserGuard.ts    # Rejects org-scoped users from consumer-only endpoints
      pricing.ts         # Credit consumption + refund logic
      providerRetry.ts   # Provider retry with inline budget + queue fallback
      analytics.ts       # workspace_generation_events recorder
      seedance.ts        # Seedance (ByteDance) video API helpers
      seedream.ts        # Seedream image API helpers
      hyper3d.ts         # Hyper3D/Tripo3D API helpers
      sendEmail.ts       # Email dispatch
      posthogCapture.ts  # Server-side PostHog events
    workspace-run-node/  # Single-node AI execution (main workspace dispatcher)
    workspace-chat/      # AI chat assistant for canvas context
    admin_workspace_pricing/    # Admin: credit cost CRUD
    admin_workspace_analytics/  # Admin: generation analytics aggregation
    admin_workspace_logs/       # Admin: generation log + retry queue reads
    admin_workspace_orgs/       # Admin: organization management
    mf-um-resolve-login/   # Org user sign-in resolution (email → org routing)
    mf-um-org-admin-api/   # Org/class admin CRUD (teacher center)
    mf-um-class-enroll/    # Student class enrollment via code/QR
    admin-api/           # Legacy admin panel CRUD
    admin-login/         # Admin JWT issuance
    run-flow-init/       # Legacy: single-node flow execution
    run-flow/            # Legacy: multi-node sequential flow execution
    stripe-webhook/      # Stripe payment webhook handler
    ...                  # See config.toml for full list (~55 functions)
```

## Commands

```bash
# Link to remote project
npx supabase link --project-ref fymncypboeubdikpbmqc

# Push migrations to remote
npx supabase db push

# Deploy all edge functions
npx supabase functions deploy --all

# Deploy a single function
npx supabase functions deploy <function-name>

# Set secrets
npx supabase secrets set KEY=value

# Local development (requires Docker)
npx supabase start
npx supabase functions serve
```

## Connected Frontends

| App | Repo | Domain |
|---|---|---|
| Workspace app | mediaforge-workspace-frontend | workspace.mediaforge.co |
| Admin panel | mediaforge-admin-hub | admin.mediaforge.co |

Both use `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` to connect.

## Key Tables

### Workspace Core
- **workspaces** — user workspace containers (RLS: `auth.uid() = user_id`)
- **workspace_canvases** — canvas graphs (nodes/edges/viewport), autosaved (RLS: owner-only)
- **workspace_generation_events** — analytics: one row per successful generation
- **workspace_generation_jobs** — durable background job tracking for node execution
- **workspace_chat_conversations / workspace_chat_messages** — AI assistant chat history
- **brand_elements** — Kling brand element references (per canvas)

### Organization / Multi-tenant
- **organizations** — institutional accounts (school/university/enterprise/agency) with credit pools
- **classes** — sub-groups under org with own roster + credit pool + credit policy (manual/monthly_reset/weekly_drip)
- **class_members** — student + co-teacher roster per class
- **sso_organization_domains** — email-domain → org mapping for SSO sign-in routing
- **pool_transactions** — polymorphic credit ledger (org/class/user movements)
- **workspace_activity** — append-only event stream (login, model_use, enrollment, credit grants)

### Auth & Credits
- **user_roles** — role assignments (admin, org_admin, teacher, etc.)
- **user_credits** — per-user credit balance (top-up + subscription batches)
- **credit_costs** — per-model pricing table
- **subscription_settings** — markup multipliers + config

## Auth Patterns

| Pattern | Used By | How |
|---|---|---|
| Supabase Auth JWT | workspace-run-node, workspace-chat, consumer functions | `supabase.auth.getUser(token)` via service-role client |
| Admin JWT (HMAC) | admin_workspace_*, admin-api | `verifyAdminJwt()` from `_shared/adminAuth.ts` — verifies HMAC-SHA256 signature + `type: "admin"` claim + expiry, signed by `JWT_SECRET` |
| Org user guard | workspace-run-node, consumer functions | `rejectIfOrgUser()` blocks org-scoped users from consumer endpoints |
| Service-role only | workspace_generation_events INSERT, pool_transactions | No user-facing RLS — writes go through service-role in edge functions |

## Key Patterns

- **Credit system:** 1 THB = 50 Workspace Credits (consumer app uses 125/THB). Integer math, `pg_advisory_xact_lock` per user.
- **Execution flow:** deduct credits upfront → call AI provider → auto-refund on failure
- **Provider retry:** inline budget (3 attempts) → retry queue → dead letter
- **RLS-first security:** all workspace tables enforce `auth.uid() = user_id`. Edge functions use service-role for cross-cutting writes (analytics, pool transactions).
- **Canvas ownership trigger:** `check_canvas_workspace_ownership` ensures `workspace_canvases.workspace_id` belongs to the same user
- **Analytics attribution:** `workspace-run-node` validates the caller owns `workspace_id`/`canvas_id` before recording to `workspace_generation_events`

## AI Providers

| Provider | Features | Edge Function |
|---|---|---|
| Kling AI | Video generation (v2.6, v3.0, v3 Omni), motion control | workspace-run-node |
| Seedance | Video generation (ByteDance) | workspace-run-node |
| SeedDream | Image generation (5.0, 5.0 Lite, 4.5) | workspace-run-node |
| OpenAI | Image generation (GPT-Image-2, DALL-E) | workspace-run-node |
| Google Gemini | Chat AI (3 Pro, 3 Flash), Image gen (Nano Banana) | workspace-run-node, workspace-chat |
| Tripo3D | 3D model generation (v1.4–v3.1, Turbo, P1) | workspace-run-node |
| ElevenLabs | Text-to-speech (Multilingual v2, Turbo v2.5) | workspace-run-node |
| Google Cloud TTS | Text-to-speech (Studio voices) | workspace-run-node |
| Replicate | Background removal (BiRefNet) | remove-background |
| Freepik | Stock image search | freepik-stock |
| Stripe | Payments, subscriptions | stripe-webhook, create-checkout |
