
CREATE OR REPLACE FUNCTION public.cleanup_old_analytics_rpc()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.api_usage_logs WHERE created_at < now() - interval '90 days';
  DELETE FROM public.rate_limits WHERE created_at < now() - interval '5 minutes';
END;
$function$;
