-- Lock down credit refund RPCs so browser-authenticated users cannot mint
-- workspace/org credits by calling SECURITY DEFINER helpers directly.
-- Edge Functions use service_role for legitimate refund paths.

DO $$
BEGIN
  IF to_regprocedure('public.refund_credits(uuid, integer, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.refund_credits(UUID, INTEGER, TEXT, TEXT)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.refund_credits(UUID, INTEGER, TEXT, TEXT)
      TO service_role;
  END IF;

  IF to_regprocedure('public.refund_credits_for(uuid, uuid, integer, text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.refund_credits_for(UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.refund_credits_for(UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT)
      TO service_role;
  END IF;

  IF to_regprocedure('public.refund_workspace_org_credits(uuid, uuid, integer, text, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.refund_workspace_org_credits(UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.refund_workspace_org_credits(UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT)
      TO service_role;
  END IF;

  IF to_regprocedure('public.refund_education_space_credits(uuid, text, integer, text, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.refund_education_space_credits(UUID, TEXT, INTEGER, TEXT, TEXT, TEXT)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.refund_education_space_credits(UUID, TEXT, INTEGER, TEXT, TEXT, TEXT)
      TO service_role;
  END IF;
END $$;
