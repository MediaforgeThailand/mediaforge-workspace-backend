-- Legacy v1 payout RPCs are now dead code (admin_settle_partner replaces them).
-- They had internal admin-role guards so weren't directly exploitable, but
-- leaving them callable via anon/authenticated is unnecessary attack surface.
-- Lock to service_role only — admin tooling that historically called them
-- via service_role still works.
REVOKE EXECUTE ON FUNCTION public.approve_payout(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_payout_paid(uuid, text) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reject_payout(uuid, text) FROM anon, authenticated, PUBLIC;
