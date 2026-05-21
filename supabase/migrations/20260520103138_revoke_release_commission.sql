-- release_commission promotes 'holding' → 'available' on commissions whose
-- hold_until has elapsed. It's invoked by pg_cron (postgres superuser, bypasses
-- grants). Default PUBLIC EXECUTE meant anyone with ANON_KEY could call it,
-- effectively releasing every partner's holding commissions on demand.
-- pg_cron still works after REVOKE because it runs as superuser.
REVOKE EXECUTE ON FUNCTION public.release_commission() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_commission() TO service_role;
