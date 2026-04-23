-- Force-fail stuck flow run 7ae1bd26-3753-40f7-9dc9-6ccf603fa8cd and refund 50 credits to the user
DO $$
DECLARE
  v_run_id uuid := '7ae1bd26-3753-40f7-9dc9-6ccf603fa8cd';
  v_user_id uuid := 'fb4de7e2-9f6e-459b-bb1b-464f6ae14bea';
  v_credits int := 50;
  v_balance int;
BEGIN
  -- Mark run as failed
  UPDATE public.flow_runs
  SET status = 'failed',
      completed_at = now(),
      error_message = 'Merge Audio: source handle mismatch (audio vs output_audio). Auto-refunded by system fix.'
  WHERE id = v_run_id AND status = 'running';

  -- Mark pipeline execution as failed
  UPDATE public.pipeline_executions
  SET status = 'failed',
      error_message = 'Merge Audio: source handle mismatch. Auto-refunded by system fix.',
      updated_at = now()
  WHERE flow_run_id = v_run_id AND status = 'running';

  -- Refund credits via a credit batch (60-day expiry, source = refund)
  INSERT INTO public.credit_batches (user_id, amount, remaining, expires_at, source_type, reference_id)
  VALUES (v_user_id, v_credits, v_credits, now() + interval '60 days', 'refund', v_run_id::text);

  -- Compute new balance and log the refund transaction
  SELECT COALESCE(SUM(remaining), 0) INTO v_balance
  FROM public.credit_batches
  WHERE user_id = v_user_id AND remaining > 0 AND expires_at > now();

  INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, feature, description, reference_id)
  VALUES (v_user_id, v_credits, v_balance, 'refund', 'merge_audio_video',
          'Refund for stuck run ' || v_run_id::text || ' (handle mismatch fix)',
          v_run_id::text);
END $$;