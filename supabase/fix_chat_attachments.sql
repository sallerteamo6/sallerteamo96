-- The live chat_messages table has no attachments column, so pictures/files
-- users send to customer service are dropped on write and never reach the
-- admin. Run once in the Supabase SQL Editor, then redeploy.
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS attachments json NOT NULL DEFAULT '[]';