-- Round-2 audit follow-up: add the missing FK + index on
-- commission_events.payout_id.
--
-- The column has existed since the initial 20260417061700 migration as a
-- plain UUID. Both v1 (mark_payout_paid / request_payout) and the recently
-- atomic v2 RPC write the column when a payout flips to 'paid', so it is
-- in active use — but with no foreign-key reference to payout_requests(id)
-- and no index, the column could (a) point at a non-existent payout if
-- the payout_requests row were ever deleted, and (b) lookups by payout_id
-- (the "show me everything paid through this payout" pattern that
-- reconciliation / refund-clawback uses) do a full sequential scan.
--
-- Fix: sanitize any existing orphans to NULL, ADD CONSTRAINT with
-- ON DELETE SET NULL (so deleting a payout_request never loses commission
-- history), and CREATE INDEX for the lookup pattern.

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

ALTER TABLE public.commission_events
  ADD CONSTRAINT commission_events_payout_id_fkey
  FOREIGN KEY (payout_id)
  REFERENCES public.payout_requests(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_commission_events_payout_id
  ON public.commission_events (payout_id)
  WHERE payout_id IS NOT NULL;

COMMIT;
