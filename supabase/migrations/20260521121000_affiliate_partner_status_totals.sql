-- Aggregate partner dashboard totals without relying on edge-function row
-- limits. The portal still returns the latest commission rows for display,
-- but totals and milestone eligibility must be computed over the full ledger.
CREATE OR REPLACE FUNCTION public.affiliate_partner_status_totals(p_partner_user_id uuid)
RETURNS TABLE(
  total numeric,
  holding numeric,
  available numeric,
  paid numeric,
  sales_total_thb numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $function$
  SELECT
    COALESCE(SUM(ce.commission_amount_thb) FILTER (
      WHERE ce.status IN ('holding', 'available', 'paid')
    ), 0)::numeric AS total,
    COALESCE(SUM(ce.commission_amount_thb) FILTER (
      WHERE ce.status = 'holding'
    ), 0)::numeric AS holding,
    COALESCE(SUM(ce.commission_amount_thb) FILTER (
      WHERE ce.status = 'available'
    ), 0)::numeric AS available,
    COALESCE(SUM(ce.commission_amount_thb) FILTER (
      WHERE ce.status = 'paid'
    ), 0)::numeric AS paid,
    COALESCE(SUM(COALESCE(
      ce.net_amount_thb,
      ce.gross_amount_thb,
      ce.commission_base_amount_thb,
      0
    )) FILTER (
      WHERE ce.status NOT IN ('void', 'clawback')
    ), 0)::numeric AS sales_total_thb
  FROM public.commission_events ce
  WHERE ce.partner_user_id = p_partner_user_id;
$function$;

REVOKE EXECUTE ON FUNCTION public.affiliate_partner_status_totals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.affiliate_partner_status_totals(uuid) TO service_role;
