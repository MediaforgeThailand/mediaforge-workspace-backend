-- Let class teachers open the student spaces shown in the School Center
-- live monitor. Teachers get read access to every space in their classes
-- and edit access only while the space is still active/submitted.

BEGIN;

CREATE OR REPLACE FUNCTION public.workspace_can_read_workspace(workspace_id_arg text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces w
    WHERE w.id = workspace_id_arg
      AND (
        auth.uid() = w.user_id
        OR public.workspace_same_team_member(w.user_id)
        OR public.workspace_share_grant_for_workspace(w.id, 'viewer')
        OR EXISTS (
          SELECT 1
          FROM public.education_student_spaces ess
          WHERE ess.workspace_id = w.id
            AND public.is_class_teacher(auth.uid(), ess.class_id)
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.workspace_can_edit_workspace(workspace_id_arg text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces w
    WHERE w.id = workspace_id_arg
      AND (
        (
          auth.uid() = w.user_id
          AND public.can_write_workspace_for_user(auth.uid(), w.id, w.class_id)
        )
        OR public.workspace_same_team_member(w.user_id)
        OR public.workspace_share_grant_for_workspace(w.id, 'editor')
        OR EXISTS (
          SELECT 1
          FROM public.education_student_spaces ess
          WHERE ess.workspace_id = w.id
            AND ess.status IN ('active', 'submitted')
            AND public.is_class_teacher(auth.uid(), ess.class_id)
        )
      )
  );
$$;

DROP POLICY IF EXISTS "users can read their own workspaces" ON public.workspaces;
CREATE POLICY "users can read their own workspaces"
  ON public.workspaces FOR SELECT
  USING (public.workspace_can_read_workspace(id));

DROP POLICY IF EXISTS "users can update their own workspaces" ON public.workspaces;
CREATE POLICY "users can update their own workspaces"
  ON public.workspaces FOR UPDATE
  USING (public.workspace_can_edit_workspace(id))
  WITH CHECK (public.workspace_can_edit_workspace(id));

GRANT EXECUTE ON FUNCTION public.workspace_can_read_workspace(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_can_edit_workspace(text) TO authenticated;

COMMIT;
