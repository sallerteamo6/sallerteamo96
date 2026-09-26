-- Fix: live loans UPDATE fails with 42703 "record new has no field updated_at"
--
-- traditional_tables_migration.sql created a BEFORE UPDATE trigger
-- (update_loans_updated_at) on public.loans that executes
-- update_updated_at_column(), which writes NEW.updated_at = NOW(). But the
-- loans table definition has no updated_at column, so EVERY UPDATE to loans
-- (e.g. admin Approve/Reject) returns HTTP 400 and nothing persists.
--
-- Idempotent fix: run once in the Supabase SQL Editor with the service role.
ALTER TABLE public.loans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();