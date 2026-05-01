-- Workspace education portal.
--
-- Keeps schools/universities administratively separate from business SSO
-- organizations while reusing the existing organizations/classes/members
-- primitives. Adds the missing classroom layer:
--   - class sessions for live teaching windows
--   - realtime screen/presence rows teachers can watch
--   - org/class attribution on generation events/jobs
--   - service-role RPC for ERP-admin class credit grants/revokes

BEGIN;

ALTER TABLE public.workspace_generation_jobs
  ADD COLUMN IF NOT EXISTS credit_class_id UUID REFERENCES public.classes(id) ON DELETE SET NULL;

ALTER TABLE public.class_members
  ADD COLUMN IF NOT EXISTS student_code TEXT;

CREATE OR REPLACE VIEW public.class_memberships AS
SELECT
  cm.id,
  cm.class_id,
  cm.user_id,
  cm.status,
  cm.joined_at AS enrolled_at,
  cm.student_code,
  cm.credits_balance,
  cm.credits_lifetime_received,
  cm.credits_lifetime_used,
  cm.created_at,
  cm.updated_at
FROM public.class_members cm
WHERE cm.role = 'student';

GRANT SELECT ON public.class_memberships TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS workspace_generation_jobs_credit_class_idx
  ON public.workspace_generation_jobs (credit_class_id, created_at DESC)
  WHERE credit_class_id IS NOT NULL;

ALTER TABLE public.workspace_generation_events
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS class_id UUID REFERENCES public.classes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wge_org_created
  ON public.workspace_generation_events (organization_id, created_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wge_class_created
  ON public.workspace_generation_events (class_id, created_at DESC)
  WHERE class_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.education_class_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_education_sessions_class
  ON public.education_class_sessions (class_id, starts_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_education_sessions_live
  ON public.education_class_sessions (organization_id, status, starts_at DESC)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.education_sessions_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS education_sessions_touch_trg ON public.education_class_sessions;
CREATE TRIGGER education_sessions_touch_trg
  BEFORE UPDATE ON public.education_class_sessions
  FOR EACH ROW EXECUTE FUNCTION public.education_sessions_touch();

CREATE TABLE IF NOT EXISTS public.education_student_screen_presence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  session_id UUID REFERENCES public.education_class_sessions(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'offline'
    CHECK (status IN ('online', 'idle', 'offline', 'sharing', 'help_requested', 'blocked')),
  screen_state TEXT NOT NULL DEFAULT 'not_shared'
    CHECK (screen_state IN ('not_shared', 'requested', 'sharing', 'paused', 'blocked')),
  current_workspace_id TEXT,
  current_canvas_id TEXT,
  current_project_id TEXT,
  current_activity TEXT,
  screen_thumbnail_url TEXT,
  screen_stream_url TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (class_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_education_presence_class_seen
  ON public.education_student_screen_presence (class_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_education_presence_session_seen
  ON public.education_student_screen_presence (session_id, last_seen_at DESC)
  WHERE session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.education_presence_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS education_presence_touch_trg ON public.education_student_screen_presence;
CREATE TRIGGER education_presence_touch_trg
  BEFORE UPDATE ON public.education_student_screen_presence
  FOR EACH ROW EXECUTE FUNCTION public.education_presence_touch();

ALTER TABLE public.education_class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.education_student_screen_presence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS education_sessions_admin_all ON public.education_class_sessions;
CREATE POLICY education_sessions_admin_all ON public.education_class_sessions
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS education_sessions_teacher_read ON public.education_class_sessions;
CREATE POLICY education_sessions_teacher_read ON public.education_class_sessions
  FOR SELECT
  USING (public.is_class_teacher(auth.uid(), class_id));

DROP POLICY IF EXISTS education_presence_admin_all ON public.education_student_screen_presence;
CREATE POLICY education_presence_admin_all ON public.education_student_screen_presence
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS education_presence_teacher_read ON public.education_student_screen_presence;
CREATE POLICY education_presence_teacher_read ON public.education_student_screen_presence
  FOR SELECT
  USING (public.is_class_teacher(auth.uid(), class_id));

DROP POLICY IF EXISTS education_presence_student_upsert_own ON public.education_student_screen_presence;
CREATE POLICY education_presence_student_upsert_own ON public.education_student_screen_presence
  FOR ALL
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.class_members cm
      WHERE cm.class_id = education_student_screen_presence.class_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.class_members cm
      WHERE cm.class_id = education_student_screen_presence.class_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  );

CREATE OR REPLACE FUNCTION public.workspace_education_credit_scope(p_user_id UUID)
RETURNS TABLE (
  organization_id UUID,
  organization_name TEXT,
  organization_type TEXT,
  class_id UUID,
  class_name TEXT,
  class_code TEXT,
  class_role TEXT,
  credit_balance INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH memberships AS (
    SELECT
      o.id AS organization_id,
      COALESCE(o.display_name, o.name) AS organization_name,
      o.type AS organization_type,
      c.id AS class_id,
      c.name AS class_name,
      c.code AS class_code,
      cm.role AS class_role,
      cm.credits_balance AS credit_balance,
      CASE
        WHEN cm.role = 'student' THEN 0
        WHEN cm.role = 'teacher' THEN 1
        ELSE 2
      END AS priority,
      cm.joined_at
    FROM public.class_members cm
    JOIN public.classes c ON c.id = cm.class_id
    JOIN public.organizations o ON o.id = c.organization_id
    WHERE cm.user_id = p_user_id
      AND cm.status = 'active'
      AND c.status IN ('active', 'scheduled')
      AND c.deleted_at IS NULL
      AND o.status = 'active'
      AND o.deleted_at IS NULL
      AND o.type IN ('school', 'university')
    ORDER BY priority, cm.joined_at DESC
    LIMIT 1
  )
  SELECT
    organization_id,
    organization_name,
    organization_type,
    class_id,
    class_name,
    class_code,
    class_role,
    credit_balance
  FROM memberships;
$$;

GRANT EXECUTE ON FUNCTION public.workspace_education_credit_scope(UUID)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_adjust_class_member_credits(
  p_class_id UUID,
  p_user_id UUID,
  p_delta INT,
  p_actor_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_pool INT;
  v_class_consumed INT;
  v_class_end DATE;
  v_org_id UUID;
  v_member_balance INT;
  v_expires TIMESTAMPTZ;
  v_new_balance INT;
  v_revoke INT;
  v_remaining INT;
  v_batch RECORD;
  v_take INT;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'admin_adjust_class_member_credits: delta must be non-zero';
  END IF;

  SELECT c.credit_pool, c.credit_pool_consumed, c.end_date, c.organization_id, cm.credits_balance
    INTO v_class_pool, v_class_consumed, v_class_end, v_org_id, v_member_balance
    FROM public.classes c
    JOIN public.class_members cm ON cm.class_id = c.id
   WHERE c.id = p_class_id
     AND c.deleted_at IS NULL
     AND cm.user_id = p_user_id
     AND cm.role = 'student'
     AND cm.status = 'active'
   FOR UPDATE;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'admin_adjust_class_member_credits: active student membership not found';
  END IF;

  IF p_delta > 0 THEN
    IF v_class_pool - v_class_consumed < p_delta THEN
      RETURN -1;
    END IF;

    v_expires := CASE
      WHEN v_class_end IS NOT NULL THEN (v_class_end + INTERVAL '30 days')::timestamptz
      ELSE (NOW() + INTERVAL '1 year')
    END;

    UPDATE public.classes
       SET credit_pool_consumed = credit_pool_consumed + p_delta,
           updated_at = NOW()
     WHERE id = p_class_id;

    INSERT INTO public.credit_batches
      (user_id, source_type, amount, remaining, expires_at, reference_id)
    VALUES
      (p_user_id, 'class_grant', p_delta, p_delta, v_expires, p_class_id::text);

    INSERT INTO public.user_credits (user_id, balance)
    VALUES (p_user_id, p_delta)
    ON CONFLICT (user_id) DO UPDATE
      SET balance = public.user_credits.balance + EXCLUDED.balance,
          updated_at = NOW()
    RETURNING balance INTO v_new_balance;

    UPDATE public.class_members
       SET credits_balance = credits_balance + p_delta,
           credits_lifetime_received = credits_lifetime_received + p_delta,
           updated_at = NOW()
     WHERE class_id = p_class_id AND user_id = p_user_id;

    INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description)
    VALUES (p_class_id, p_actor_id, -p_delta, 'class_pool_consumed', COALESCE(p_reason, 'ERP class grant'));

    INSERT INTO public.pool_transactions (user_id, triggered_by, amount, reason, description, metadata)
    VALUES (p_user_id, p_actor_id, p_delta, 'member_grant', COALESCE(p_reason, 'ERP class grant'),
            jsonb_build_object('class_id', p_class_id));

    INSERT INTO public.workspace_activity (user_id, organization_id, class_id, activity_type, credits_used, metadata)
    VALUES (p_user_id, v_org_id, p_class_id, 'credits_granted', p_delta,
            jsonb_build_object('actor_id', p_actor_id, 'reason', p_reason));

    RETURN v_new_balance;
  END IF;

  v_revoke := LEAST(ABS(p_delta), COALESCE(v_member_balance, 0));
  IF v_revoke <= 0 THEN
    RETURN COALESCE(v_member_balance, 0);
  END IF;

  v_remaining := v_revoke;
  FOR v_batch IN
    SELECT id, remaining
      FROM public.credit_batches
     WHERE user_id = p_user_id
       AND source_type = 'class_grant'
       AND reference_id = p_class_id::text
       AND remaining > 0
     ORDER BY created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_remaining, v_batch.remaining);
    UPDATE public.credit_batches
       SET remaining = remaining - v_take
     WHERE id = v_batch.id;
    v_remaining := v_remaining - v_take;
  END LOOP;

  UPDATE public.user_credits
     SET balance = GREATEST(balance - v_revoke, 0),
         updated_at = NOW()
   WHERE user_id = p_user_id
   RETURNING balance INTO v_new_balance;

  UPDATE public.class_members
     SET credits_balance = GREATEST(credits_balance - v_revoke, 0),
         updated_at = NOW()
   WHERE class_id = p_class_id AND user_id = p_user_id;

  UPDATE public.classes
     SET credit_pool_consumed = GREATEST(credit_pool_consumed - v_revoke, 0),
         updated_at = NOW()
   WHERE id = p_class_id;

  INSERT INTO public.pool_transactions (user_id, triggered_by, amount, reason, description, metadata)
  VALUES (p_user_id, p_actor_id, -v_revoke, 'class_revoke', COALESCE(p_reason, 'ERP class revoke'),
          jsonb_build_object('class_id', p_class_id));

  INSERT INTO public.pool_transactions (class_id, triggered_by, amount, reason, description)
  VALUES (p_class_id, p_actor_id, v_revoke, 'class_pool_allocation', COALESCE(p_reason, 'ERP class revoke'));

  INSERT INTO public.workspace_activity (user_id, organization_id, class_id, activity_type, credits_used, metadata)
  VALUES (p_user_id, v_org_id, p_class_id, 'credits_revoked', v_revoke,
          jsonb_build_object('actor_id', p_actor_id, 'reason', p_reason));

  RETURN COALESCE(v_new_balance, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_class_member_credits(UUID, UUID, INT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_class_member_credits(UUID, UUID, INT, UUID, TEXT)
  TO service_role;

COMMIT;
