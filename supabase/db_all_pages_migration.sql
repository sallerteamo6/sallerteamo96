-- DB-All-Pages Migration for TrustCom (additive, safe to re-run)
-- Adds server-side sessions, per-user language/profit/guest/greeted flags,
-- and completes trades / ai_orders / chat_messages write support.
-- Run in Supabase SQL Editor.

-- 1) Extra per-user columns
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS profit_mode BOOLEAN DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS greeted BOOLEAN DEFAULT FALSE;

-- 2) Sessions table (login / guest / admin-lock state, DB-backed)
-- uid type is matched to public.users.uid so the FK can always be created.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON public.users(uid);
DO $$
BEGIN
  EXECUTE 'CREATE TABLE IF NOT EXISTS public.sessions (
    token TEXT PRIMARY KEY,
    uid ' || (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
              WHERE a.attrelid = 'public.users'::regclass AND a.attname = 'uid')
         || ' REFERENCES public.users(uid) ON DELETE CASCADE,
    admin BOOLEAN DEFAULT FALSE,
    is_guest BOOLEAN DEFAULT FALSE,
    language TEXT DEFAULT ''en'',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  )';
END $$;
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON public.sessions(uid);

-- 3) Trades: app uses duration/sell price/settlement + account label + opened_at
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 0;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS sell_price NUMERIC(20,8);
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS account TEXT;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;

-- 4) AI orders: app deposit-plan fields
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS product TEXT;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS period INTEGER DEFAULT 7;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS rate_min NUMERIC(10,4) DEFAULT 0;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS rate_max NUMERIC(10,4) DEFAULT 0;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS profit NUMERIC(20,8) DEFAULT 0;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS settled_days INTEGER DEFAULT 0;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS principal NUMERIC(20,8) DEFAULT 0;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;
ALTER TABLE public.ai_orders ADD COLUMN IF NOT EXISTS schedules JSONB DEFAULT '[]'::jsonb;

-- 5) Chat messages: edit + soft-delete
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- 5b) Verifications: advanced (handheld photo) review fields
ALTER TABLE public.verifications ADD COLUMN IF NOT EXISTS advanced TEXT;
ALTER TABLE public.verifications ADD COLUMN IF NOT EXISTS advanced_status TEXT;
ALTER TABLE public.verifications ADD COLUMN IF NOT EXISTS advanced_submitted_at TIMESTAMPTZ;
ALTER TABLE public.verifications ADD COLUMN IF NOT EXISTS advanced_reviewed_at TIMESTAMPTZ;
ALTER TABLE public.verifications ADD COLUMN IF NOT EXISTS advanced_note TEXT;

-- 6) RLS on sessions
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_sessions_all" ON public.sessions;
DROP POLICY IF EXISTS "service_sessions_all" ON public.sessions;
CREATE POLICY "anon_sessions_all" ON public.sessions FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "service_sessions_all" ON public.sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 7) Trades: anon writes (feature flow)
DROP POLICY IF EXISTS "anon_insert_trades" ON public.trades;
DROP POLICY IF EXISTS "anon_update_trades" ON public.trades;
DROP POLICY IF EXISTS "anon_delete_trades" ON public.trades;
CREATE POLICY "anon_insert_trades" ON public.trades FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_trades" ON public.trades FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_trades" ON public.trades FOR DELETE TO anon USING (true);

-- 8) AI orders: anon writes
DROP POLICY IF EXISTS "anon_insert_ai" ON public.ai_orders;
DROP POLICY IF EXISTS "anon_update_ai" ON public.ai_orders;
DROP POLICY IF EXISTS "anon_delete_ai" ON public.ai_orders;
CREATE POLICY "anon_insert_ai" ON public.ai_orders FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_ai" ON public.ai_orders FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_ai" ON public.ai_orders FOR DELETE TO anon USING (true);

-- 9) Chat: anon edit + soft-delete
DROP POLICY IF EXISTS "anon_update_chat" ON public.chat_messages;
DROP POLICY IF EXISTS "anon_delete_chat" ON public.chat_messages;
CREATE POLICY "anon_update_chat" ON public.chat_messages FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_chat" ON public.chat_messages FOR DELETE TO anon USING (true);

-- 10) Realtime (idempotent adds)
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions; EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.trades; EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_orders; EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages; EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;