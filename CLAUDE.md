# CLAUDE.md — mediaforge-workspace-backend

## Overview

Supabase backend for the MediaForge **Workspace** product (split out
from the consumer app per CTO directive — workspace.mediaforge.co
will be the standalone subdomain). Migrations + edge functions for
the node-based canvas editor live here. Companion frontend repo:
`mediaforge-workspace-frontend`.

The original consumer app's backend (`mediaforge-backend`, project
`yonnvlhgwdxkuirhdfaz`) still exists for the rest of the consumer
product surface — workspace code there is being phased out as part
of the same split.

## Project

- **Supabase Project:** `fymncypboeubdikpbmqc` (ap-southeast-1, Singapore) — DEDICATED workspace project
- **Dashboard:** https://supabase.com/dashboard/project/fymncypboeubdikpbmqc

## Structure

```
supabase/
  config.toml          # Supabase project config
  migrations/          # PostgreSQL migrations (applied via supabase db push)
  functions/           # Deno edge functions
    _shared/           # Shared utilities (pricing, email, retry, etc.)
    admin-api/         # Admin panel CRUD operations
    admin-login/       # Admin JWT authentication
    run-flow-init/     # Single-node flow execution
    run-flow/          # Multi-node flow execution
    stripe-webhook/    # Stripe payment handling
    generate-stripe-link/  # Direct sales checkout creation
    get-payment-code/      # Lookup redemption code by Stripe session
    erp-affiliate-bridge/  # Affiliate/KYC/payout operations
    ...                # See config.toml for full list
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
| Consumer app | magic-media-lab | mediaforge.co |
| Admin panel | mediaforge-admin-hub | admin.mediaforge.co |

Both use `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` to connect.

## Key Patterns

- Edge functions use `SUPABASE_SERVICE_ROLE_KEY` for privileged DB access
- Admin auth: JWT-based via `admin-login` function, verified in `admin-api`
- Consumer auth: Supabase Auth (email + Google OAuth)
- Credit system: integer math, `pg_advisory_xact_lock` per user
- All AI execution: deduct credits upfront → call API → auto-refund on failure
