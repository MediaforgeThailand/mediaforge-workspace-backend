-- Secure flow deletion function that can remove dependent records
-- while enforcing ownership/admin authorization in one transaction.
CREATE OR REPLACE FUNCTION public.delete_flow_with_dependencies(p_flow_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT user_id INTO v_owner_id
  FROM public.flows
  WHERE id = p_flow_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Flow not found';
  END IF;

  IF v_owner_id <> auth.uid() AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'Not authorized to delete this flow';
  END IF;

  DELETE FROM public.flow_test_runs WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_runs WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_versions WHERE flow_id = p_flow_id;
  DELETE FROM public.flow_nodes WHERE flow_id = p_flow_id;
  DELETE FROM public.flows WHERE id = p_flow_id;

  RETURN true;
END;
$$;