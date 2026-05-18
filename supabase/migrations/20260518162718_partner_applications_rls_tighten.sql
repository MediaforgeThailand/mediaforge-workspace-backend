-- Tighten partner_applications RLS so users can't self-approve.
--
-- The base schema in 20260417061700 created "own_kyc_insert" / "own_kyc_update_draft"
-- with no status constraint on the post-image. 20260417072238 then ADDED a
-- second pair of policies in parallel — and since multiple PERMISSIVE policies
-- are ORed, the looser pair won, and a user could:
--   * INSERT a partner_applications row with status='approved' directly
--   * UPDATE non-status columns like reviewed_by on their own row
-- After Taksin's affiliate-portal submitApplication landed, that meant a
-- determined user could PATCH `status='approved'` (via the loose INSERT path
-- or via UPDATE on a fresh row), then every subsequent legit submit preserves
-- the forged approval because of `existing?.status === "approved" ? "approved" : "submitted"`.
--
-- Fix: drop the loose policies, keep only the tight ones with status
-- constraints in WITH CHECK, AND lock down column-level UPDATE so even a
-- regressed policy can't let users mutate review/state columns. Service-role
-- bypasses both grants and RLS, so submitApplication and admin endpoints
-- keep working.

BEGIN;

-- Drop the loose duplicates so they cannot be ORed with the tight ones.
DROP POLICY IF EXISTS "own_kyc_insert" ON public.partner_applications;
DROP POLICY IF EXISTS "own_kyc_update_draft" ON public.partner_applications;

-- Replace any old tight policies with the status-constrained versions.
DROP POLICY IF EXISTS "Users can insert own application" ON public.partner_applications;
CREATE POLICY "Users can insert own application"
ON public.partner_applications FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND status = 'draft'
);

DROP POLICY IF EXISTS "Users can update own draft application" ON public.partner_applications;
CREATE POLICY "Users can update own draft application"
ON public.partner_applications FOR UPDATE
TO authenticated
USING (auth.uid() = user_id AND status IN ('draft','needs_info'))
WITH CHECK (
  auth.uid() = user_id
  AND status IN ('draft','submitted','needs_info')
);

-- Belt-and-braces: revoke table-level UPDATE and re-grant only the
-- columns a user can legitimately edit on their own draft. Column-level
-- GRANT semantics require revoking the table grant first.
REVOKE UPDATE ON public.partner_applications FROM authenticated;
GRANT UPDATE (
  legal_first_name, legal_last_name,
  phone_e164, national_id,
  address_line1, address_line2, city, postal_code, country_code,
  bank_name, bank_account_no, bank_account_name,
  id_card_front_url, id_card_back_url, bank_book_url, selfie_with_id_url,
  social_profile_url, social_platform, follower_count,
  updated_at
) ON public.partner_applications TO authenticated;

COMMIT;
