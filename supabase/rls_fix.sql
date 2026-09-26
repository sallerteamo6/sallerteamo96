-- RLS Fix for TrustCom — additive only, safe to run on existing DB.
-- Adds the anon UPDATE/DELETE policies the app needs for admin actions
-- (toggle admin/status, approve KYC, loan/txn status, delete user, chat read).
-- Re-runnable. Does NOT drop any table or data.

-- users: updates (admin toggles, password change) + deletes (removeUser)
DROP POLICY IF EXISTS "anon_update_users" ON public.users;
DROP POLICY IF EXISTS "anon_delete_users" ON public.users;
CREATE POLICY "anon_update_users" ON public.users FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_users" ON public.users FOR DELETE TO anon USING (true);

-- user_balances: delete (part of removeUser cleanup)
DROP POLICY IF EXISTS "anon_delete_user_balances" ON public.user_balances;
CREATE POLICY "anon_delete_user_balances" ON public.user_balances FOR DELETE TO anon USING (true);

-- verifications: update (approve/reject KYC), delete (removeUser)
DROP POLICY IF EXISTS "anon_update_verifications" ON public.verifications;
DROP POLICY IF EXISTS "anon_delete_verifications" ON public.verifications;
DROP POLICY IF EXISTS "anon_insert_verifications" ON public.verifications;
CREATE POLICY "anon_update_verifications" ON public.verifications FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_verifications" ON public.verifications FOR DELETE TO anon USING (true);
CREATE POLICY "anon_insert_verifications" ON public.verifications FOR INSERT TO anon WITH CHECK (true);

-- loans: update (approve/reject/repay), delete (removeUser)
DROP POLICY IF EXISTS "anon_update_loans" ON public.loans;
DROP POLICY IF EXISTS "anon_delete_loans" ON public.loans;
DROP POLICY IF EXISTS "anon_insert_loans" ON public.loans;
CREATE POLICY "anon_update_loans" ON public.loans FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_loans" ON public.loans FOR DELETE TO anon USING (true);
CREATE POLICY "anon_insert_loans" ON public.loans FOR INSERT TO anon WITH CHECK (true);

-- transactions: update (confirm/reject deposits/withdrawals), delete (removeUser)
DROP POLICY IF EXISTS "anon_update_txns" ON public.transactions;
DROP POLICY IF EXISTS "anon_delete_txns" ON public.transactions;
DROP POLICY IF EXISTS "anon_insert_txns" ON public.transactions;
CREATE POLICY "anon_update_txns" ON public.transactions FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_txns" ON public.transactions FOR DELETE TO anon USING (true);
CREATE POLICY "anon_insert_txns" ON public.transactions FOR INSERT TO anon WITH CHECK (true);

-- trades: update (settle/close), delete (removeUser)
DROP POLICY IF EXISTS "anon_update_trades" ON public.trades;
DROP POLICY IF EXISTS "anon_delete_trades" ON public.trades;
CREATE POLICY "anon_update_trades" ON public.trades FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_trades" ON public.trades FOR DELETE TO anon USING (true);

-- ai_orders: update (settle), delete (removeUser)
DROP POLICY IF EXISTS "anon_update_ai" ON public.ai_orders;
DROP POLICY IF EXISTS "anon_delete_ai" ON public.ai_orders;
CREATE POLICY "anon_update_ai" ON public.ai_orders FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_ai" ON public.ai_orders FOR DELETE TO anon USING (true);

-- chat_messages: update (mark read), delete (removeUser)
DROP POLICY IF EXISTS "anon_update_chat" ON public.chat_messages;
DROP POLICY IF EXISTS "anon_delete_chat" ON public.chat_messages;
CREATE POLICY "anon_update_chat" ON public.chat_messages FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_chat" ON public.chat_messages FOR DELETE TO anon USING (true);

-- coin_addresses: read, add (insert), update (edit address), delete (remove address)
DROP POLICY IF EXISTS "anon_read_addresses" ON public.coin_addresses;
DROP POLICY IF EXISTS "anon_insert_addresses" ON public.coin_addresses;
DROP POLICY IF EXISTS "anon_update_addresses" ON public.coin_addresses;
DROP POLICY IF EXISTS "anon_delete_addresses" ON public.coin_addresses;
CREATE POLICY "anon_read_addresses" ON public.coin_addresses FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_addresses" ON public.coin_addresses FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_addresses" ON public.coin_addresses FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_addresses" ON public.coin_addresses FOR DELETE TO anon USING (true);

-- admin_settings: read/write from the app
DROP POLICY IF EXISTS "anon_select_settings" ON public.admin_settings;
DROP POLICY IF EXISTS "anon_insert_settings" ON public.admin_settings;
DROP POLICY IF EXISTS "anon_update_settings" ON public.admin_settings;
CREATE POLICY "anon_select_settings" ON public.admin_settings FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_settings" ON public.admin_settings FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_settings" ON public.admin_settings FOR UPDATE TO anon USING (true) WITH CHECK (true);