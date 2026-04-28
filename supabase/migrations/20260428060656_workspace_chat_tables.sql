-- Workspace V2 AI assistant chat persistence.
-- One conversation per (user, canvas). Messages stored in a separate
-- table for fast inserts + ordered fetch.
CREATE TABLE IF NOT EXISTS public.workspace_chat_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  canvas_id   text NOT NULL,
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, canvas_id)
);

CREATE INDEX IF NOT EXISTS workspace_chat_conv_user_canvas_idx
  ON public.workspace_chat_conversations (user_id, canvas_id);

CREATE TABLE IF NOT EXISTS public.workspace_chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.workspace_chat_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','system')),
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_chat_msg_conv_created_idx
  ON public.workspace_chat_messages (conversation_id, created_at);

ALTER TABLE public.workspace_chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_chat_messages      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wcc_owner_all" ON public.workspace_chat_conversations;
CREATE POLICY "wcc_owner_all"
  ON public.workspace_chat_conversations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Messages — owner derived through the parent conversation.
DROP POLICY IF EXISTS "wcm_owner_select" ON public.workspace_chat_messages;
CREATE POLICY "wcm_owner_select"
  ON public.workspace_chat_messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.workspace_chat_conversations c
    WHERE c.id = workspace_chat_messages.conversation_id
      AND c.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "wcm_owner_insert" ON public.workspace_chat_messages;
CREATE POLICY "wcm_owner_insert"
  ON public.workspace_chat_messages FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.workspace_chat_conversations c
    WHERE c.id = workspace_chat_messages.conversation_id
      AND c.user_id = auth.uid()
  ));
