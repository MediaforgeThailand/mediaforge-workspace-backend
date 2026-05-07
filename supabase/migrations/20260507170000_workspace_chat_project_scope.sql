-- Scope prompt-assistant chat history to a project instead of a single canvas.
-- Existing canvas-scoped conversations are backfilled from workspace_canvases
-- and merged so one user has at most one conversation per project.

ALTER TABLE public.workspace_chat_conversations
  ADD COLUMN IF NOT EXISTS project_id text;

UPDATE public.workspace_chat_conversations c
SET project_id = wc.project_id
FROM public.workspace_canvases wc
WHERE c.project_id IS NULL
  AND c.canvas_id = wc.id::text
  AND wc.project_id IS NOT NULL;

UPDATE public.workspace_chat_conversations c
SET project_id = w.project_id
FROM public.workspaces w
WHERE c.project_id IS NULL
  AND c.canvas_id = w.id::text
  AND w.project_id IS NOT NULL;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY user_id, project_id
      ORDER BY updated_at DESC, created_at DESC, id
    ) AS keep_id,
    row_number() OVER (
      PARTITION BY user_id, project_id
      ORDER BY updated_at DESC, created_at DESC, id
    ) AS rn
  FROM public.workspace_chat_conversations
  WHERE project_id IS NOT NULL
),
moved AS (
  UPDATE public.workspace_chat_messages m
  SET conversation_id = ranked.keep_id
  FROM ranked
  WHERE ranked.rn > 1
    AND m.conversation_id = ranked.id
  RETURNING m.id
)
DELETE FROM public.workspace_chat_conversations c
USING ranked
WHERE ranked.rn > 1
  AND c.id = ranked.id;

CREATE INDEX IF NOT EXISTS workspace_chat_conv_user_project_idx
  ON public.workspace_chat_conversations (user_id, project_id)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_chat_conv_user_project_uidx
  ON public.workspace_chat_conversations (user_id, project_id)
  WHERE project_id IS NOT NULL;
