-- Traditional Tables Migration for TrustCom (Clean - drops and recreates)
-- Run this in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop existing tables (CASCADE handles foreign keys)
DROP TABLE IF EXISTS public.user_balances CASCADE;
DROP TABLE IF EXISTS public.verifications CASCADE;
DROP TABLE IF EXISTS public.loans CASCADE;
DROP TABLE IF EXISTS public.transactions CASCADE;
DROP TABLE IF EXISTS public.trades CASCADE;
DROP TABLE IF EXISTS public.ai_orders CASCADE;
DROP TABLE IF EXISTS public.chat_messages CASCADE;
DROP TABLE IF EXISTS public.coin_addresses CASCADE;
DROP TABLE IF EXISTS public.admin_settings CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;

-- Users table (uid as BIGINT)
CREATE TABLE public.users (
  uid BIGINT PRIMARY KEY,
  account TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_admin BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active',
  referral_code TEXT,
  referred_by BIGINT REFERENCES public.users(uid)
);

CREATE INDEX idx_users_account ON public.users(account);
CREATE INDEX idx_users_referral ON public.users(referral_code);

-- User balances table
CREATE TABLE public.user_balances (
  id BIGSERIAL PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  coin TEXT NOT NULL,
  amount NUMERIC(20,8) DEFAULT 0,
  locked_amount NUMERIC(20,8) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(uid, coin)
);

-- Verifications table
CREATE TABLE public.verifications (
  uid BIGINT PRIMARY KEY REFERENCES public.users(uid) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  id_number TEXT,
  phone TEXT,
  id_front TEXT,
  id_back TEXT,
  status TEXT DEFAULT 'pending',
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES public.users(uid),
  rejection_reason TEXT
);

-- Loans table
CREATE TABLE public.loans (
  id TEXT PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  account TEXT NOT NULL,
  amount NUMERIC(20,2) NOT NULL,
  days INTEGER NOT NULL,
  rate NUMERIC(10,2) NOT NULL,
  interest NUMERIC(20,2) NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES public.users(uid),
  repaid_at TIMESTAMPTZ
);

CREATE INDEX idx_loans_uid ON public.loans(uid);
CREATE INDEX idx_loans_status ON public.loans(status);

-- Transactions table
CREATE TABLE public.transactions (
  id BIGSERIAL PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  type TEXT NOT NULL,
  coin TEXT NOT NULL,
  amount NUMERIC(20,8) NOT NULL,
  status TEXT DEFAULT 'completed',
  reference_id TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_txns_uid ON public.transactions(uid);
CREATE INDEX idx_txns_type ON public.transactions(type);
CREATE INDEX idx_txns_created ON public.transactions(created_at DESC);

-- Trades table
CREATE TABLE public.trades (
  id BIGSERIAL PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  pair TEXT NOT NULL,
  side TEXT NOT NULL,
  amount NUMERIC(20,8) NOT NULL,
  price NUMERIC(20,8) NOT NULL,
  fee NUMERIC(20,8) DEFAULT 0,
  status TEXT DEFAULT 'open',
  profit NUMERIC(20,8) DEFAULT 0,
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- AI Orders table
CREATE TABLE public.ai_orders (
  id BIGSERIAL PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  amount NUMERIC(20,8) NOT NULL,
  entry_price NUMERIC(20,8),
  tp_price NUMERIC(20,8),
  sl_price NUMERIC(20,8),
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- Chat messages table
CREATE TABLE public.chat_messages (
  id BIGSERIAL PRIMARY KEY,
  uid BIGINT NOT NULL REFERENCES public.users(uid) ON DELETE CASCADE,
  from_role TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX idx_chat_uid ON public.chat_messages(uid);
CREATE INDEX idx_chat_created ON public.chat_messages(created_at DESC);

-- Coin addresses table
CREATE TABLE public.coin_addresses (
  id BIGSERIAL PRIMARY KEY,
  coin TEXT UNIQUE NOT NULL,
  address TEXT NOT NULL,
  network TEXT,
  qr_code TEXT,
  min_deposit NUMERIC(20,8) DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin settings table
CREATE TABLE public.admin_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coin_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies - Drop all first, then create
DROP POLICY IF EXISTS "anon_register" ON public.users;
DROP POLICY IF EXISTS "service_all" ON public.users;
DROP POLICY IF EXISTS "auth_select_own" ON public.users;
CREATE POLICY "anon_register" ON public.users FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "service_all" ON public.users FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "auth_select_own" ON public.users FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "service_all_bal" ON public.user_balances;
DROP POLICY IF EXISTS "anon_select_own_bal" ON public.user_balances;
DROP POLICY IF EXISTS "anon_insert_user_balances" ON public.user_balances;
DROP POLICY IF EXISTS "anon_update_user_balances" ON public.user_balances;
DROP POLICY IF EXISTS "anon_select_own_balances" ON public.user_balances;
CREATE POLICY "service_all_bal" ON public.user_balances FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_own_bal" ON public.user_balances FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_user_balances" ON public.user_balances FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_user_balances" ON public.user_balances FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_own_balances" ON public.user_balances FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "service_all_ver" ON public.verifications;
DROP POLICY IF EXISTS "anon_insert_own_ver" ON public.verifications;
DROP POLICY IF EXISTS "anon_select_own_ver" ON public.verifications;
DROP POLICY IF EXISTS "anon_insert_verifications" ON public.verifications;
DROP POLICY IF EXISTS "anon_select_own_verifications" ON public.verifications;
CREATE POLICY "service_all_ver" ON public.verifications FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_insert_verifications" ON public.verifications FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_own_verifications" ON public.verifications FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "service_all_loans" ON public.loans;
DROP POLICY IF EXISTS "anon_insert_own_loan" ON public.loans;
DROP POLICY IF EXISTS "anon_select_own_loan" ON public.loans;
DROP POLICY IF EXISTS "anon_insert_loans" ON public.loans;
DROP POLICY IF EXISTS "anon_select_own_loans" ON public.loans;
CREATE POLICY "service_all_loans" ON public.loans FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_insert_loans" ON public.loans FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_own_loans" ON public.loans FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "service_all_txns" ON public.transactions;
DROP POLICY IF EXISTS "anon_insert_txns" ON public.transactions;
DROP POLICY IF EXISTS "anon_select_own_txns" ON public.transactions;
CREATE POLICY "service_all_txns" ON public.transactions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_insert_txns" ON public.transactions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_own_txns" ON public.transactions FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "service_all_trades" ON public.trades;
DROP POLICY IF EXISTS "anon_select_own_trades" ON public.trades;
CREATE POLICY "service_all_trades" ON public.trades FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_own_trades" ON public.trades FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "service_all_ai" ON public.ai_orders;
DROP POLICY IF EXISTS "anon_select_own_ai" ON public.ai_orders;
CREATE POLICY "service_all_ai" ON public.ai_orders FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_own_ai" ON public.ai_orders FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "service_all_chat" ON public.chat_messages;
DROP POLICY IF EXISTS "anon_insert_own_chat" ON public.chat_messages;
DROP POLICY IF EXISTS "anon_select_own_chat" ON public.chat_messages;
CREATE POLICY "service_all_chat" ON public.chat_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_insert_own_chat" ON public.chat_messages FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_select_own_chat" ON public.chat_messages FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "public_read_addresses" ON public.coin_addresses;
DROP POLICY IF EXISTS "service_all_addresses" ON public.coin_addresses;
CREATE POLICY "public_read_addresses" ON public.coin_addresses FOR SELECT TO anon USING (is_active = true);
CREATE POLICY "service_all_addresses" ON public.coin_addresses FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_all_settings" ON public.admin_settings;
CREATE POLICY "service_all_settings" ON public.admin_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_balances;
ALTER PUBLICATION supabase_realtime ADD TABLE public.verifications;
ALTER PUBLICATION supabase_realtime ADD TABLE public.loans;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;
ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.coin_addresses;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_balances_updated_at BEFORE UPDATE ON public.user_balances FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_loans_updated_at BEFORE UPDATE ON public.loans FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_addresses_updated_at BEFORE UPDATE ON public.coin_addresses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON public.admin_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Seed default coin addresses
INSERT INTO public.coin_addresses (coin, address, network, min_deposit) VALUES
('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TRC20', 10),
('TRX', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TRC20', 100),
('BTC', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'BTC', 0.0005),
('ETH', '0x742d35Cc6634C0532925a3b844Bc9e7595f8E5D3', 'ERC20', 0.01),
('BNB', '0x742d35Cc6634C0532925a3b844Bc9e7595f8E5D3', 'BEP20', 0.01)
ON CONFLICT (coin) DO NOTHING;