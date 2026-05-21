-- Lock remaining affiliate-scope SECURITY DEFINER functions that don't need
-- to be public. compute_referral_risk_score has NO internal auth guard and
-- mutates state — leaving it public lets anyone mark another partner's
-- referrals as 'fraud'. The debug_* functions have internal has_role guards
-- (anon → auth.uid()=NULL → has_role returns FALSE → block) but REVOKE here
-- is defense-in-depth so the check never even runs. flag_high_refund_partners
-- and detect_refund_velocity are cron-only / internal helpers.
REVOKE EXECUTE ON FUNCTION public.compute_referral_risk_score(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.debug_add_credits(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.debug_set_balance(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.flag_high_refund_partners() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.detect_refund_velocity() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.compute_referral_risk_score(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.debug_add_credits(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.debug_set_balance(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.flag_high_refund_partners() TO service_role;
GRANT EXECUTE ON FUNCTION public.detect_refund_velocity() TO service_role;
