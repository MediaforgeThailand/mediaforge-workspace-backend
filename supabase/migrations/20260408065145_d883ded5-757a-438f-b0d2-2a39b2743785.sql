-- Function: auto-update flow_metrics when a flow_run completes
CREATE OR REPLACE FUNCTION public.update_flow_metrics_on_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Only act when status transitions TO 'completed'
  -- (not when an already-completed row is re-updated)
  IF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    INSERT INTO public.flow_metrics (flow_id, total_runs, total_revenue, last_run_at, updated_at)
    VALUES (NEW.flow_id, 1, COALESCE(NEW.credits_used, 0), now(), now())
    ON CONFLICT (flow_id) DO UPDATE SET
      total_runs    = flow_metrics.total_runs + 1,
      total_revenue = flow_metrics.total_revenue + COALESCE(NEW.credits_used, 0),
      last_run_at   = now(),
      updated_at    = now();
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger: fires after insert or update on flow_runs
CREATE TRIGGER trg_update_flow_metrics
AFTER INSERT OR UPDATE OF status ON public.flow_runs
FOR EACH ROW
EXECUTE FUNCTION public.update_flow_metrics_on_run();