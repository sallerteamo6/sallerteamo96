-- ===========================================================================
--  Realtime publication
-- ===========================================================================
--  v1 published app_meta, which meant every browser subscribed to a channel
--  carrying every user's balances and chat as JSON. v2 publishes only the
--  tables a user legitimately needs pushed, and row-level security still
--  filters each subscriber's events: Realtime applies the subscriber's RLS,
--  so a user is never sent another user's balance change.
-- ===========================================================================

begin;

-- Drop and recreate so re-running this file does not fail on an existing
-- publication, and so tables removed from the list actually leave the channel.
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'app_public') then
    for t in
      select schemaname || '.' || tablename
      from pg_publication_tables
      where pubname = 'app_public'
    loop
      execute format('alter publication app_public drop table %s', t);
    end loop;
  end if;
end $$;

drop publication if exists app_public;

create publication app_public
  for table
    public.balances,        -- balance chips update without a refresh
    public.contracts,       -- countdown and settlement result
    public.transactions,    -- deposit / withdrawal status
    public.investments,     -- AI Quant progress bar
    public.loans,           -- loan application status
    public.chat_threads,    -- support inbox
    public.chat_messages,   -- live support chat
    public.verifications,   -- KYC status
    public.coin_addresses;  -- admin address rotation

-- The table list here and the list in scripts/db.js _startRealtime() have to
-- agree. A table the client subscribes to but that is missing from the
-- publication is not an error anywhere: the channel connects, the subscription
-- is accepted, and no event ever arrives. It fails silently, which looks
-- exactly like "realtime is broken".

-- public.audit_log is deliberately NOT published: it holds a record of who
-- did what, and there is no reason for a browser to subscribe to it.
--
-- Realtime applies the SUBSCRIBER's RLS policies when deciding which rows to
-- send, so a user is never pushed another user's balance or chat message. This
-- holds only if DB_PRIVILEGE is `anon` and RLS is enabled on every published
-- table (see 06_auth.sql step 4). With DB_PRIVILEGE = `postgres` the
-- publication bypasses RLS and every subscriber receives every row.
commit;
