-- Attachment proof columns are missing from the live transactions table, so the
-- deposit/withdrawal proof images users upload never survive the write.
-- Run once in the Supabase SQL Editor, then redeploy.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS proof     text not null default '',
  ADD COLUMN IF NOT EXISTS proof_name text not null default '';