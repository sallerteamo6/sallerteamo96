-- AI Quant orders: add the account column used by the client.
-- NOTE: the real blocker was legacy NOT NULL symbol/side columns; run
-- fix_ai_orders_schema.sql as well (or this file is superseded by it).
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS account TEXT;
ALTER TABLE public.ai_orders ALTER COLUMN symbol DROP NOT NULL;
ALTER TABLE public.ai_orders ALTER COLUMN side DROP NOT NULL;