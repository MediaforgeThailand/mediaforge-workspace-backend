
-- Add summary cache columns to chat_conversations
ALTER TABLE public.chat_conversations 
ADD COLUMN IF NOT EXISTS summary TEXT,
ADD COLUMN IF NOT EXISTS summary_message_count INTEGER DEFAULT 0;
