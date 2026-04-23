CREATE OR REPLACE FUNCTION public.redeem_demo_link(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_demo demo_links%ROWTYPE;
  v_existing_tx credit_transactions%ROWTYPE;
  v_credits int;
  v_budget demo_budget%ROWTYPE;
  v_current_month text;
  v_updated_count int;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'ต้องเข้าสู่ระบบก่อน');
  END IF;

  IF p_token IS NULL OR length(trim(p_token)) < 4 THEN
    RETURN jsonb_build_object('error', 'Token ไม่ถูกต้อง');
  END IF;

  SELECT * INTO v_demo FROM demo_links WHERE token = trim(p_token);
  IF v_demo.id IS NULL THEN
    RETURN jsonb_build_object('error', 'ลิงก์ Demo ไม่ถูกต้อง');
  END IF;

  IF NOT v_demo.is_active THEN
    RETURN jsonb_build_object('error', 'ลิงก์ Demo นี้ถูกปิดใช้งานแล้ว');
  END IF;

  IF v_demo.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'ลิงก์ Demo นี้หมดอายุแล้ว');
  END IF;

  IF v_demo.redeemed_by IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'ลิงก์ Demo นี้ถูกใช้ไปแล้ว', 'already_redeemed', true);
  END IF;

  v_credits := COALESCE(v_demo.credits_budget, 500);

  SELECT * INTO v_existing_tx FROM credit_transactions
    WHERE user_id = v_user_id AND reference_id = 'demo:' || trim(p_token)
    LIMIT 1;

  IF v_existing_tx.id IS NOT NULL THEN
    UPDATE demo_links SET
      redeemed_by = COALESCE(redeemed_by, v_user_id),
      redeemed_at = COALESCE(redeemed_at, v_existing_tx.created_at, now()),
      is_active = false
    WHERE id = v_demo.id;
    RETURN jsonb_build_object('success', true, 'credits', v_credits, 'already_redeemed', true, 'repaired_link', true);
  END IF;

  v_current_month := to_char(now(), 'YYYY-MM');
  SELECT * INTO v_budget FROM demo_budget WHERE month = v_current_month;

  IF v_budget.id IS NOT NULL AND (COALESCE(v_budget.total_credits_granted, 0) + v_credits) > COALESCE(v_budget.max_monthly_credits, 100000) THEN
    RETURN jsonb_build_object('error', 'เครดิต Demo ประจำเดือนหมดแล้ว กรุณาลองใหม่เดือนหน้า');
  END IF;

  UPDATE demo_links SET
    redeemed_by = v_user_id,
    redeemed_at = now(),
    is_active = false
  WHERE id = v_demo.id AND redeemed_by IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count = 0 THEN
    RETURN jsonb_build_object('error', 'ลิงก์ Demo นี้ถูกใช้ไปแล้ว', 'already_redeemed', true);
  END IF;

  BEGIN
    PERFORM grant_credits(
      p_user_id := v_user_id,
      p_amount := v_credits,
      p_source_type := 'bonus',
      p_expiry_days := 90,
      p_description := 'Demo Link Credits',
      p_reference_id := 'demo:' || trim(p_token)
    );
  EXCEPTION WHEN OTHERS THEN
    UPDATE demo_links SET redeemed_by = NULL, redeemed_at = NULL, is_active = true WHERE id = v_demo.id;
    RETURN jsonb_build_object('error', 'ไม่สามารถเพิ่มเครดิตได้ กรุณาลองใหม่');
  END;

  IF v_budget.id IS NOT NULL THEN
    UPDATE demo_budget SET
      total_credits_granted = COALESCE(total_credits_granted, 0) + v_credits,
      updated_at = now()
    WHERE id = v_budget.id;
  ELSE
    INSERT INTO demo_budget (month, total_credits_granted) VALUES (v_current_month, v_credits);
  END IF;

  RETURN jsonb_build_object('success', true, 'credits', v_credits);
END;
$$;