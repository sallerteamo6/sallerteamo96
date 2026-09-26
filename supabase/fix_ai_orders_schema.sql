-- AI Quant orders "buy" fix.
--
-- The live ai_orders table was created in the old "trading" style where
-- symbol and side were NOT NULL. The AI Quant flow never writes those
-- columns, so every user buy insert was rejected with:
--   23502: null value in column "symbol"/"side" violates not-null constraint
-- and the order silently vanished (not in user positions, not in Admin AI Quant).
--
-- Fix:
--  1) make symbol/side optional (AI Quant orders don't have them), and
--  2) add the account column the client stores (kept idempotent).
ALTER TABLE public.ai_orders ALTER COLUMN symbol DROP NOT NULL;
ALTER TABLE public.ai_orders ALTER COLUMN side DROP NOT NULL;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS account TEXT;