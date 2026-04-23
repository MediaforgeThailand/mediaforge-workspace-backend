DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, user_id, credits_used
    FROM public.flow_runs
    WHERE status IN ('pending','running','processing')
      AND started_at < now() - interval '15 minutes'
  LOOP
    IF r.credits_used IS NOT NULL AND r.credits_used > 0 THEN
      PERFORM public.refund_credits(
        r.user_id,
        r.credits_used,
        'Auto-refund: stuck run cleanup (>15 min)',
        r.id::text
      );
    END IF;
    UPDATE public.flow_runs
       SET status = 'failed_refunded',
           error_message = COALESCE(error_message, 'Auto-cleaned: stuck >15 min, credits refunded'),
           completed_at = COALESCE(completed_at, now())
     WHERE id = r.id;
  END LOOP;
END$$;