CREATE OR REPLACE FUNCTION public.redeem_demo_link(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_demo_link public.demo_links%ROWTYPE;
  v_existing_tx RECORD;
  v_budget public.demo_budget%ROWTYPE;
  v_current_month text := to_char(now(), 'YYYY-MM');
  v_credits_to_grant integer;
  v_total_granted integer;
  v_max_monthly integer;
  v_redeemed_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RAISE EXCEPTION 'Missing token';
  END IF;

  IF length(btrim(p_token)) < 4 OR length(btrim(p_token)) > 100 THEN
    RAISE EXCEPTION 'Invalid token format';
  END IF;

  SELECT *
  INTO v_demo_link
  FROM public.demo_links
  WHERE token = btrim(p_token)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ลิงก์ Demo ไม่ถูกต้อง';
  END IF;

  IF NOT v_demo_link.is_active THEN
    RAISE EXCEPTION 'ลิงก์ Demo นี้ถูกปิดใช้งานแล้ว';
  END IF;

  IF v_demo_link.expires_at < now() THEN
    RAISE EXCEPTION 'ลิงก์ Demo นี้หมดอายุแล้ว';
  END IF;

  SELECT id, created_at
  INTO v_existing_tx
  FROM public.credit_transactions
  WHERE user_id = v_user_id
    AND reference_id = 'demo:' || btrim(p_token)
  ORDER BY created_at DESC
  LIMIT 1;

  v_credits_to_grant := COALESCE(v_demo_link.credits_budget, 500);

  IF FOUND THEN
    v_redeemed_at := COALESCE(v_demo_link.redeemed_at, v_existing_tx.created_at, now());

    UPDATE public.demo_links
    SET redeemed_by = COALESCE(redeemed_by, v_user_id),
        redeemed_at = v_redeemed_at,
        is_active = false
    WHERE id = v_demo_link.id;

    RETURN jsonb_build_object(
      'success', true,
      'credits', v_credits_to_grant,
      'already_redeemed', true,
      'repaired_link', (v_demo_link.is_active OR v_demo_link.redeemed_by IS NULL OR v_demo_link.redeemed_at IS NULL)
    );
  END IF;

  IF v_demo_link.redeemed_by IS NOT NULL THEN
    RAISE EXCEPTION 'ลิงก์ Demo นี้ถูกใช้ไปแล้ว';
  END IF;

  SELECT *
  INTO v_budget
  FROM public.demo_budget
  WHERE month = v_current_month
  ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  v_total_granted := COALESCE(v_budget.total_credits_granted, 0);
  v_max_monthly := COALESCE(v_budget.max_monthly_credits, 100000);

  IF v_total_granted + v_credits_to_grant > v_max_monthly THEN
    RAISE EXCEPTION 'เครดิต Demo ประจำเดือนหมดแล้ว กรุณาลองใหม่เดือนหน้า';
  END IF;

  v_redeemed_at := now();

  UPDATE public.demo_links
  SET redeemed_by = v_user_id,
      redeemed_at = v_redeemed_at,
      is_active = false
  WHERE id = v_demo_link.id;

  PERFORM public.grant_credits(
    v_user_id,
    v_credits_to_grant,
    'bonus',
    90,
    'Demo Link Credits',
    'demo:' || btrim(p_token)
  );

  IF v_budget.id IS NOT NULL THEN
    UPDATE public.demo_budget
    SET total_credits_granted = v_total_granted + v_credits_to_grant,
        updated_at = now()
    WHERE id = v_budget.id;
  ELSE
    INSERT INTO public.demo_budget (month, total_credits_granted)
    VALUES (v_current_month, v_credits_to_grant);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'credits', v_credits_to_grant,
    'already_redeemed', false,
    'repaired_link', false
  );
EXCEPTION
  WHEN OTHERS THEN
    IF v_demo_link.id IS NOT NULL AND SQLERRM = 'ไม่สามารถเพิ่มเครดิตได้ กรุณาลองใหม่' THEN
      UPDATE public.demo_links
      SET redeemed_by = NULL,
          redeemed_at = NULL,
          is_active = true
      WHERE id = v_demo_link.id;
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_demo_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_demo_link(text) TO authenticated;