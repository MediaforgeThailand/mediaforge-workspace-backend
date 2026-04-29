-- Backward-compatibility views for class_members split.
--
-- Schema C unified the old `class_teachers` (teacher roster) and
-- `class_memberships` (student roster) into ONE table `class_members`
-- with a role discriminator. The org-admin-api edge fn (and prod admin
-- pages) still query the two old names.
--
-- For demo we expose READ-ONLY views with the old names. Writes go
-- direct to class_members (the edge fn's INSERT paths still target
-- "class_teachers" / "class_memberships" — those will fail until the
-- edge fn is rewritten to use class_members directly. For demo
-- visibility we only need reads to work).
--
-- Cleanup: when edge fn is rewritten, DROP these views.

BEGIN;

-- ─── class_teachers view ─────────────────────────────────────────────
-- Old shape: { id, class_id, user_id, role: 'primary'|'co', invited_by, created_at }
-- The role mapping: a teacher is "primary" if classes.primary_instructor_id
-- matches them, otherwise "co".
CREATE OR REPLACE VIEW public.class_teachers AS
SELECT
  cm.id,
  cm.class_id,
  cm.user_id,
  CASE
    WHEN c.primary_instructor_id = cm.user_id THEN 'primary'
    ELSE 'co'
  END AS role,
  cm.invited_by,
  cm.joined_at AS created_at
FROM public.class_members cm
JOIN public.classes c ON c.id = cm.class_id
WHERE cm.role = 'teacher' AND cm.status = 'active';

GRANT SELECT ON public.class_teachers TO authenticated, service_role;

COMMENT ON VIEW public.class_teachers IS
  'Compat view (read-only). Schema-A class_teachers → Schema-C class_members WHERE role=teacher.';

-- ─── class_memberships view ──────────────────────────────────────────
-- Old shape: includes student-side credit columns
CREATE OR REPLACE VIEW public.class_memberships AS
SELECT
  cm.id,
  cm.class_id,
  cm.user_id,
  cm.status,
  cm.joined_at AS enrolled_at,
  NULL::text AS student_code,
  cm.credits_balance,
  cm.credits_lifetime_received,
  cm.credits_lifetime_used,
  cm.created_at,
  cm.updated_at
FROM public.class_members cm
WHERE cm.role = 'student';

GRANT SELECT ON public.class_memberships TO authenticated, service_role;

COMMENT ON VIEW public.class_memberships IS
  'Compat view (read-only). Schema-A class_memberships → Schema-C class_members WHERE role=student.';

COMMIT;
