-- payout_requests had inconsistent FK targets across the four "admin who acted" columns:
--   approved_by  → auth.users.id   ✓
--   processed_by → auth.users.id   ✓
--   paid_by      → profiles.id     ✗ inconsistent
--   rejected_by  → profiles.id     ✗ inconsistent
-- Both wrong columns had zero rows on prod + preview (verified), so
-- realigning to auth.users.id is safe and removes a footgun where any
-- new admin RPC would crash on FK violation when admins lack a profiles row.
ALTER TABLE public.payout_requests
  DROP CONSTRAINT IF EXISTS payout_requests_paid_by_fkey,
  DROP CONSTRAINT IF EXISTS payout_requests_rejected_by_fkey;

ALTER TABLE public.payout_requests
  ADD CONSTRAINT payout_requests_paid_by_fkey
    FOREIGN KEY (paid_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD CONSTRAINT payout_requests_rejected_by_fkey
    FOREIGN KEY (rejected_by) REFERENCES auth.users(id) ON DELETE SET NULL;
