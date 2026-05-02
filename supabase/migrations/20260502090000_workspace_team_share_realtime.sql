-- Team-visible workspace sharing + realtime canvas collaboration.
--
-- Goals:
--   1. A share link grants the signed-in recipient access through a
--      per-user grant, so RLS never opens a workspace just because a
--      random visitor knows its id.
--   2. Active members in the same org team / education class can see
--      each other's projects, spaces, and canvas pages.
--   3. Canvas rows carry a revision + audit trail so autosave and
--      unload flushes can be inspected when something looks off.
--   4. Supabase Realtime private broadcast channels can authorize
--      websocket messages for workspace-canvas:<canvas_id>.

BEGIN;

ALTER TABLE public.workspace_projects
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS last_opened_at timestamptz;

ALTER TABLE public.workspace_canvases
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.workspace_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  token text NOT NULL UNIQUE,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_shares_workspace_idx
  ON public.workspace_shares (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_shares_token_idx
  ON public.workspace_shares (token);

CREATE TABLE IF NOT EXISTS public.workspace_share_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id uuid NOT NULL REFERENCES public.workspace_shares(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_resolved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (share_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_share_grants_user_workspace_idx
  ON public.workspace_share_grants (user_id, workspace_id);

CREATE TABLE IF NOT EXISTS public.workspace_canvas_save_audit (
  id bigserial PRIMARY KEY,
  canvas_id uuid NOT NULL,
  workspace_id text NOT NULL,
  owner_user_id uuid NOT NULL,
  actor_user_id uuid,
  revision bigint NOT NULL,
  node_count integer NOT NULL DEFAULT 0,
  edge_count integer NOT NULL DEFAULT 0,
  payload_bytes integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'upsert',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_canvas_save_audit_canvas_idx
  ON public.workspace_canvas_save_audit (canvas_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.workspace_role_rank(role text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE role
    WHEN 'owner' THEN 3
    WHEN 'editor' THEN 2
    WHEN 'viewer' THEN 1
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public.workspace_same_team_member(owner_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND (
      auth.uid() = owner_user_id
      OR EXISTS (
        SELECT 1
        FROM public.organization_memberships me
        JOIN public.organization_memberships owner_m
          ON owner_m.organization_id = me.organization_id
        WHERE me.user_id = auth.uid()
          AND owner_m.user_id = owner_user_id
          AND me.status = 'active'
          AND owner_m.status = 'active'
          AND (
            me.role = 'org_admin'
            OR (
              me.team_id IS NOT NULL
              AND owner_m.team_id = me.team_id
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.class_members me_cm
        JOIN public.class_members owner_cm
          ON owner_cm.class_id = me_cm.class_id
        WHERE me_cm.user_id = auth.uid()
          AND owner_cm.user_id = owner_user_id
          AND me_cm.status = 'active'
          AND owner_cm.status = 'active'
      )
      OR EXISTS (
        SELECT 1
        FROM public.organization_memberships me
        JOIN public.class_members owner_cm
          ON owner_cm.user_id = owner_user_id
        JOIN public.classes c
          ON c.id = owner_cm.class_id
         AND c.organization_id = me.organization_id
        WHERE me.user_id = auth.uid()
          AND me.status = 'active'
          AND me.role = 'org_admin'
          AND owner_cm.status = 'active'
          AND c.deleted_at IS NULL
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.workspace_share_grant_for_workspace(
  workspace_id_arg text,
  required_role text DEFAULT 'viewer'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.workspace_share_grants g
      JOIN public.workspace_shares s ON s.id = g.share_id
      WHERE g.user_id = auth.uid()
        AND g.workspace_id = workspace_id_arg
        AND s.workspace_id = workspace_id_arg
        AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
        AND public.workspace_role_rank(g.role) >= public.workspace_role_rank(required_role)
    );
$$;

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
        auth.uid() = w.user_id
        OR public.workspace_same_team_member(w.user_id)
        OR public.workspace_share_grant_for_workspace(w.id, 'editor')
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.workspace_can_read_canvas(canvas_id_arg uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_canvases c
    WHERE c.id = canvas_id_arg
      AND (
        auth.uid() = c.user_id
        OR public.workspace_same_team_member(c.user_id)
        OR public.workspace_can_read_workspace(c.workspace_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.workspace_can_edit_canvas(canvas_id_arg uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_canvases c
    WHERE c.id = canvas_id_arg
      AND (
        auth.uid() = c.user_id
        OR public.workspace_same_team_member(c.user_id)
        OR public.workspace_can_edit_workspace(c.workspace_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.workspace_canvas_can_access_topic(
  topic text,
  required_role text DEFAULT 'viewer'
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  canvas_id_text text;
  canvas_id_value uuid;
BEGIN
  canvas_id_text := substring(topic from '^workspace-canvas:([0-9a-fA-F-]{36})$');
  IF canvas_id_text IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    canvas_id_value := canvas_id_text::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  IF public.workspace_role_rank(required_role) >= public.workspace_role_rank('editor') THEN
    RETURN public.workspace_can_edit_canvas(canvas_id_value);
  END IF;
  RETURN public.workspace_can_read_canvas(canvas_id_value);
END;
$$;

CREATE OR REPLACE FUNCTION public.workspace_canvases_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'canvas owner cannot be changed'
      USING errcode = '42501';
  END IF;

  NEW.updated_at = now();
  NEW.revision = CASE
    WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.revision, 0)
    ELSE COALESCE(OLD.revision, 0) + 1
  END;
  NEW.updated_by = COALESCE(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_canvas_workspace_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = NEW.workspace_id
      AND user_id = NEW.user_id
  ) THEN
    RETURN NEW;
  END IF;

  IF auth.uid() = NEW.user_id
     AND public.workspace_can_edit_workspace(NEW.workspace_id) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.user_id = OLD.user_id
     AND public.workspace_can_edit_workspace(NEW.workspace_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'workspace_id "%" does not belong to user or editable workspace', NEW.workspace_id
    USING errcode = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.workspace_canvas_save_audit_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.workspace_canvas_save_audit (
    canvas_id,
    workspace_id,
    owner_user_id,
    actor_user_id,
    revision,
    node_count,
    edge_count,
    payload_bytes,
    source
  )
  VALUES (
    NEW.id,
    NEW.workspace_id,
    NEW.user_id,
    COALESCE(auth.uid(), NEW.updated_by),
    NEW.revision,
    COALESCE(jsonb_array_length(NEW.nodes), 0),
    COALESCE(jsonb_array_length(NEW.edges), 0),
    pg_column_size(NEW.nodes) + pg_column_size(NEW.edges) + COALESCE(pg_column_size(NEW.viewport), 0),
    'upsert'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_canvas_save_audit_trg ON public.workspace_canvases;
CREATE TRIGGER workspace_canvas_save_audit_trg
  AFTER INSERT OR UPDATE ON public.workspace_canvases
  FOR EACH ROW
  EXECUTE FUNCTION public.workspace_canvas_save_audit_trg();

ALTER TABLE public.workspace_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_share_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_canvas_save_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_shares owner select" ON public.workspace_shares;
CREATE POLICY "workspace_shares owner select"
  ON public.workspace_shares FOR SELECT
  USING (auth.uid() = created_by);

DROP POLICY IF EXISTS "workspace_shares owner insert" ON public.workspace_shares;
CREATE POLICY "workspace_shares owner insert"
  ON public.workspace_shares FOR INSERT
  WITH CHECK (auth.uid() = created_by);

DROP POLICY IF EXISTS "workspace_shares owner update" ON public.workspace_shares;
CREATE POLICY "workspace_shares owner update"
  ON public.workspace_shares FOR UPDATE
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

DROP POLICY IF EXISTS "workspace_share_grants own select" ON public.workspace_share_grants;
CREATE POLICY "workspace_share_grants own select"
  ON public.workspace_share_grants FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "workspace_canvas_save_audit visible select" ON public.workspace_canvas_save_audit;
CREATE POLICY "workspace_canvas_save_audit visible select"
  ON public.workspace_canvas_save_audit FOR SELECT
  USING (
    auth.uid() = owner_user_id
    OR public.workspace_same_team_member(owner_user_id)
    OR public.workspace_share_grant_for_workspace(workspace_id, 'editor')
  );

DROP POLICY IF EXISTS "workspace_projects own select" ON public.workspace_projects;
CREATE POLICY "workspace_projects own select"
  ON public.workspace_projects FOR SELECT
  USING (
    auth.uid() = user_id
    OR (
      COALESCE(is_private, false) = false
      AND public.workspace_same_team_member(user_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.workspaces w
      WHERE w.project_id = workspace_projects.id
        AND public.workspace_share_grant_for_workspace(w.id, 'viewer')
    )
  );

DROP POLICY IF EXISTS "workspace_projects own update" ON public.workspace_projects;
CREATE POLICY "workspace_projects own update"
  ON public.workspace_projects FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "users can read their own workspaces" ON public.workspaces;
CREATE POLICY "users can read their own workspaces"
  ON public.workspaces FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.workspace_same_team_member(user_id)
    OR public.workspace_share_grant_for_workspace(id, 'viewer')
  );

DROP POLICY IF EXISTS "users can update their own workspaces" ON public.workspaces;
CREATE POLICY "users can update their own workspaces"
  ON public.workspaces FOR UPDATE
  USING (
    auth.uid() = user_id
    OR public.workspace_same_team_member(user_id)
    OR public.workspace_share_grant_for_workspace(id, 'editor')
  )
  WITH CHECK (
    auth.uid() = user_id
    OR public.workspace_same_team_member(user_id)
    OR public.workspace_share_grant_for_workspace(id, 'editor')
  );

DROP POLICY IF EXISTS "workspace_canvases own select" ON public.workspace_canvases;
CREATE POLICY "workspace_canvases own select"
  ON public.workspace_canvases FOR SELECT
  USING (
    auth.uid() = user_id
    OR public.workspace_same_team_member(user_id)
    OR public.workspace_can_read_workspace(workspace_id)
  );

DROP POLICY IF EXISTS "workspace_canvases own insert" ON public.workspace_canvases;
CREATE POLICY "workspace_canvases own insert"
  ON public.workspace_canvases FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    OR public.workspace_can_edit_workspace(workspace_id)
  );

DROP POLICY IF EXISTS "workspace_canvases own update" ON public.workspace_canvases;
CREATE POLICY "workspace_canvases own update"
  ON public.workspace_canvases FOR UPDATE
  USING (
    auth.uid() = user_id
    OR public.workspace_same_team_member(user_id)
    OR public.workspace_can_edit_workspace(workspace_id)
  )
  WITH CHECK (
    auth.uid() = user_id
    OR public.workspace_same_team_member(user_id)
    OR public.workspace_can_edit_workspace(workspace_id)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_canvases;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF to_regclass('realtime.messages') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "workspace canvas broadcast read" ON realtime.messages';
    EXECUTE 'DROP POLICY IF EXISTS "workspace canvas broadcast send" ON realtime.messages';
    EXECUTE 'CREATE POLICY "workspace canvas broadcast read" ON realtime.messages FOR SELECT TO authenticated USING (realtime.topic() LIKE ''workspace-canvas:%'' AND public.workspace_canvas_can_access_topic(realtime.topic(), ''viewer''))';
    EXECUTE 'CREATE POLICY "workspace canvas broadcast send" ON realtime.messages FOR INSERT TO authenticated WITH CHECK (realtime.topic() LIKE ''workspace-canvas:%'' AND public.workspace_canvas_can_access_topic(realtime.topic(), ''editor''))';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.workspace_same_team_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_share_grant_for_workspace(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_can_read_workspace(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_can_edit_workspace(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_can_read_canvas(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_can_edit_canvas(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_canvas_can_access_topic(text, text) TO authenticated;

COMMIT;
