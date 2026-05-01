# Codex Notes

Before changing this repo, read:

- `C:\Users\taksi\Documents\GitHub2\CODEX_CONTEXT.md`
- This repo's `CLAUDE.md`

Do not commit or print secret values. ERP runtime wiring depends on Supabase secrets documented in the root `CODEX_CONTEXT.md`.

## Supabase Schema And Seed Changes

Never change production Supabase schema, functions, policies, indexes, triggers, or seed/reference data directly without also creating a local migration file under `supabase/migrations/`.

Default workflow:
- Create or update a migration in `supabase/migrations/`.
- Test it locally or on a branch database when feasible.
- Apply it through Supabase migration tooling.

If a direct remote database change is unavoidable:
- Explain why it must be done directly.
- Make the exact same change in a local migration file immediately.
- Verify `npx supabase migration list` and `npx supabase db push --dry-run` stay clean.

Do not use direct SQL edits as the source of truth. The local migration directory is the source of truth.

