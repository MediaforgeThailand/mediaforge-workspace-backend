DO $$
DECLARE
  v_user uuid := '20756cd6-6c3e-43f2-914f-dfa45ff3a1a8';
  v_amount int := 100000;
  v_new_bal int;
BEGIN
  -- Insert batch
  INSERT INTO public.credit_batches (user_id, amount, remaining, source_type, reference_id, expires_at)
  VALUES (v_user, v_amount, v_amount, 'redemption', 'direct-fix-004', now() + interval '90 days');
  
  -- Update balance
  UPDATE public.user_credits 
  SET balance = balance + v_amount, updated_at = now()
  WHERE user_id = v_user;
  
  -- Get new balance
  SELECT balance INTO v_new_bal FROM public.user_credits WHERE user_id = v_user;
  
  -- Insert transaction  
  INSERT INTO public.credit_transactions (user_id, amount, type, feature, description, reference_id, balance_after)
  VALUES (v_user, v_amount, 'redemption', 'credit_grant', 'Direct credit fix', 'direct-fix-004', v_new_bal);
  
  RAISE NOTICE 'Done. New balance: %', v_new_bal;
END $$;