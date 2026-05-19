-- Round-2 audit follow-up + review-round corrections: add the missing FK +
-- index on commission_events.payout_id.
--
-- The column has existed since the initial 20260417061700 migration as a
-- plain UUID. Both v1 (mark_payout_paid / request_payout) and the v2 RPC
-- (after PR #40) write the column when a payout flips to 'paid', so it is
-- in active use — but with no FK and no index, lookups by payout_id do
-- full sequential scans and the column could be left dangling.
--
-- Two review corrections from the original draft:
--   * ON DELETE: changed SET NULL → RESTRICT. payout_requests is never
--     DELETEd by any code path (verified by grep across migrations and edge
--     functions). RESTRICT prevents accidental admin DELETEs from severing
--     audit/clawback provenance — a paid commission should always be able
--     to point at the payout that cleared it.
--   * Re-runnability: ADD CONSTRAINT does not support IF NOT EXISTS
--     natively, so we wrap it in a DO block that checks pg_constraint
--     first. The CREATE INDEX already uses IF NOT EXISTS.

BEGIN;

-- Sanitize: set payout_id = NULL for any commission_event whose payout_id
-- doesn't match a real payout_requests row. There should be zero such rows
-- in a healthy DB, but the ALTER TABLE below will refuse to add the FK if
-- any exist.
UPDATE public.commission_events ce
   SET payout_id = NULL
 WHERE payout_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.payout_requests pr WHERE pr.id = ce.payout_id
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commission_events_payout_id_fkey'
      AND conrelid = 'public.commission_events'::regclass
  ) THEN
    ALTER TABLE public.commission_events
      ADD CONSTRAINT commission_events_payout_id_fkey
      FOREIGN KEY (payout_id)
      REFERENCES public.payout_requests(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_commission_events_payout_id
  ON public.commission_events (payout_id)
  WHERE payout_id IS NOT NULL;

COMMIT;
