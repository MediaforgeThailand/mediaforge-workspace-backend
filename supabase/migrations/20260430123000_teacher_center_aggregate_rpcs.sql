-- Teacher Center aggregate RPCs.
--
-- Moves class analytics off raw client-side scans of workspace_activity.
-- These functions intentionally run as SECURITY INVOKER so tenant RLS on
-- workspace_activity still applies. They return already-aggregated rows for:
--   - per-class model usage
--   - per-class daily credits trend
--   - per-member model breakdown

BEGIN;

-- Support the most common Teacher Center filters:
--   class_id + activity_type + created_at
--   class_id + user_id + activity_type + created_at
CREATE INDEX IF NOT EXISTS idx_activity_class_type_time
  ON public.workspace_activity(class_id, activity_type, created_at DESC)
  WHERE class_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activity_class_user_type_time
  ON public.workspace_activity(class_id, user_id, activity_type, created_at DESC)
  WHERE class_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_class_members_class_role_joined
  ON public.class_members(class_id, role, joined_at DESC);

CREATE INDEX IF NOT EXISTS idx_class_members_class_role_status_used
  ON public.class_members(class_id, role, status, credits_lifetime_used DESC);

CREATE OR REPLACE FUNCTION public.teacher_class_model_usage(
  p_class_id UUID,
  p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days'
)
RETURNS TABLE (
  model_id TEXT,
  uses BIGINT,
  total_credits BIGINT,
  unique_users BIGINT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    wa.model_id,
    COUNT(*)::BIGINT AS uses,
    COALESCE(SUM(wa.credits_used), 0)::BIGINT AS total_credits,
    COUNT(DISTINCT wa.user_id)::BIGINT AS unique_users
  FROM public.workspace_activity wa
  WHERE wa.class_id = p_class_id
    AND wa.activity_type = 'model_use'
    AND wa.created_at >= p_since
    AND wa.model_id IS NOT NULL
  GROUP BY wa.model_id
  ORDER BY total_credits DESC, uses DESC, wa.model_id ASC;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_class_model_usage(UUID, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.teacher_class_model_usage(UUID, TIMESTAMPTZ) IS
  'Teacher Center aggregate: per-class model usage for a time window.';

CREATE OR REPLACE FUNCTION public.teacher_class_daily_usage(
  p_class_id UUID,
  p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '7 days',
  p_until TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  day TEXT,
  credits BIGINT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      date_trunc('day', p_since)::date AS start_day,
      date_trunc('day', p_until)::date AS end_day
  ),
  days AS (
    SELECT generate_series(start_day, end_day, INTERVAL '1 day')::date AS d
    FROM bounds
  ),
  usage_by_day AS (
    SELECT
      date_trunc('day', wa.created_at)::date AS d,
      COALESCE(SUM(wa.credits_used), 0)::BIGINT AS credits
    FROM public.workspace_activity wa
    WHERE wa.class_id = p_class_id
      AND wa.activity_type = 'model_use'
      AND wa.created_at >= p_since
      AND wa.created_at <= p_until
    GROUP BY date_trunc('day', wa.created_at)::date
  )
  SELECT
    to_char(days.d, 'MM-DD') AS day,
    COALESCE(usage_by_day.credits, 0)::BIGINT AS credits
  FROM days
  LEFT JOIN usage_by_day USING (d)
  ORDER BY days.d ASC;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_class_daily_usage(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.teacher_class_daily_usage(UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Teacher Center aggregate: contiguous per-day credits trend for a class.';

CREATE OR REPLACE FUNCTION public.teacher_member_model_breakdown(
  p_class_id UUID,
  p_user_id UUID,
  p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days'
)
RETURNS TABLE (
  model_id TEXT,
  uses BIGINT,
  total_credits BIGINT,
  unique_users BIGINT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    wa.model_id,
    COUNT(*)::BIGINT AS uses,
    COALESCE(SUM(wa.credits_used), 0)::BIGINT AS total_credits,
    1::BIGINT AS unique_users
  FROM public.workspace_activity wa
  WHERE wa.class_id = p_class_id
    AND wa.user_id = p_user_id
    AND wa.activity_type = 'model_use'
    AND wa.created_at >= p_since
    AND wa.model_id IS NOT NULL
  GROUP BY wa.model_id
  ORDER BY total_credits DESC, uses DESC, wa.model_id ASC;
$$;

GRANT EXECUTE ON FUNCTION public.teacher_member_model_breakdown(UUID, UUID, TIMESTAMPTZ)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.teacher_member_model_breakdown(UUID, UUID, TIMESTAMPTZ) IS
  'Teacher Center aggregate: per-member model usage for a class and time window.';

COMMIT;
