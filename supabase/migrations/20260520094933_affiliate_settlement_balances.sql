-- Read-only aggregation for the admin "settle creator" dashboard.
-- Returns one row per partner who currently has unsettled available commissions.
-- The admin UI shows these as a "needs paying" list; clicking Pay calls
-- admin_settle_partner with the same partner_user_id + balance_thb as
-- expected_amount_thb (race guard against a new commission releasing mid-click).
CREATE OR REPLACE FUNCTION public.affiliate_settlement_balances()
RETURNS TABLE(
  partner_user_id uuid,
  tier text,
  commission_rate numeric,
  suspended_at timestamptz,
  bank_name text,
  bank_account_no text,
  bank_account_name text,
  available_count integer,
  balance_thb numeric,
  oldest_available_at timestamptz,
  newest_available_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  SELECT
    p.user_id AS partner_user_id,
    p.tier,
    p.commission_rate,
    p.suspended_at,
    pa.bank_name,
    pa.bank_account_no,
    pa.bank_account_name,
    COUNT(ce.id)::int AS available_count,
    COALESCE(SUM(ce.commission_amount_thb), 0)::numeric AS balance_thb,
    MIN(ce.available_at) AS oldest_available_at,
    MAX(ce.available_at) AS newest_available_at
  FROM public.partners p
  JOIN public.commission_events ce
    ON ce.partner_user_id = p.user_id
   AND ce.status = 'available'
   AND NOT EXISTS (
     SELECT 1 FROM public.payout_requests pr
     WHERE ce.id = ANY(pr.commission_ids)
       AND pr.status NOT IN ('failed','rejected','cancelled')
   )
  LEFT JOIN public.partner_applications pa ON pa.user_id = p.user_id
  GROUP BY p.user_id, p.tier, p.commission_rate, p.suspended_at,
           pa.bank_name, pa.bank_account_no, pa.bank_account_name
  HAVING SUM(ce.commission_amount_thb) > 0
  ORDER BY MIN(ce.available_at) ASC;
$function$;

REVOKE EXECUTE ON FUNCTION public.affiliate_settlement_balances() FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.affiliate_settlement_balances() TO service_role;
