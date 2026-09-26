-- trustcom.vip static clone -> Supabase schema
-- Run this in the Supabase SQL editor (or psql) once.
-- Supabase is used ONLY as a database (no Auth, no Edge Functions).
-- API access: the static site reads via the PUBLIC (anon) key; the only
-- thing anon can write is the app_meta blob store. Detailed tables are
-- written by the service-role import tool (which bypasses RLS) or SQL only.

BEGIN;

-- ===========================================================================
-- APP META (singleton "id" rows, mirrors localStorage keys)
-- ===========================================================================
create table if not exists app_meta (
  id           text primary key,          -- e.g. 'users','balmap','txns','loans','trades','orders','aiorders','chat','greeted','verifications','addresses','profitMode','config'
  json         text not null,             -- JSON payload as the app stores it
  version      integer not null default 1,
  updated_at   timestamptz not null default now()
);
comment on column app_meta.json is 'JSON as the app keeps it in localStorage (single authoritative blob per key).';

-- ===========================================================================
-- TABLES (per-item, semantically useful / queryable)
-- ===========================================================================

-- Users (app's OWN account table; password kept as in the app)
create table if not exists users (
  uid         text primary key,
  account     text not null,
  password    text not null default '',
  is_wallet   boolean not null default false,
  status      text not null default 'active',
  referred_by text,
  invited     json not null default '[]',
  role        text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists users_account_idx on users (lower(account));
create index if not exists users_referred_by_idx on users (referred_by);

-- Balances map
create table if not exists balances (
  uid         text not null,
  coin        text not null,
  amount      double precision not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (uid, coin)
);
create index if not exists balances_uid_idx on balances (uid);

-- Transactions
create table if not exists txns (
  id          text primary key,
  uid         text not null,
  account     text not null default '',
  type        text not null default 'deposit',
  coin        text not null default 'USDT',
  amount      double precision not null default 0,
  status      text not null default 'pending',
  note        text not null default '',
  proof       text not null default '',
  proof_name  text not null default '',
  dir         text,
  created_at  text not null
);
create index if not exists txns_uid_idx on txns (uid);
create index if not exists txns_created_idx on txns (created_at);

-- Loans
create table if not exists loans (
  id          text primary key,
  uid         text not null,
  account     text not null default '',
  amount      double precision not null default 0,
  days        integer not null default 0,
  rate        double precision not null default 0,
  interest    double precision not null default 0,
  status      text not null default 'pending',
  created_at  text not null
);
create index if not exists loans_uid_idx on loans (uid);

-- Trades
create table if not exists trades (
  id          text primary key,
  pair        text not null default 'BTC/USDT',
  side        text not null default 'up',
  amount      double precision not null default 0,
  price       double precision not null default 0,
  "user"      text not null default 'unknown',
  duration    integer not null default 0,
  sell_price  double precision,
  settled_at  text,
  profit      double precision not null default 0,
  status      text not null default 'open',
  created_at  text not null
);
create index if not exists trades_user_idx on trades using btree ("user");

-- AI Quant orders
create table if not exists aiorders (
  id          text primary key,
  uid         text not null default '',
  account     text not null default '',
  product_id  integer not null default 1,
  product     text not null default 'AI Quant',
  period      integer not null default 7,
  rate_min    double precision not null default 0,
  rate_max    double precision not null default 0,
  amount      double precision not null default 0,
  principal   double precision not null default 0,
  profit      double precision not null default 0,
  settled_days integer not null default 0,
  status      text not null default 'pending',
  start_at    text,
  end_at      text,
  schedules   json not null default '[]',
  created_at  text not null
);
create index if not exists aiorders_uid_idx on aiorders (uid);

-- Purchase orders (market)
create table if not exists orders (
  id          text primary key,
  "user"      text not null default 'unknown',
  pair        text not null default 'BTC/USDT',
  side        text not null default 'up',
  amount      double precision not null default 0,
  price       double precision not null default 0,
  duration    integer not null default 0,
  sold        boolean not null default false,
  status      text not null default 'open',
  created_at  text not null default '',
  details     json not null default '{}'
);
create index if not exists orders_user_idx on orders using btree ("user");

-- Support chat messages
create table if not exists chat_messages (
  mid         text primary key,
  uid         text not null,
  from_who    text not null default 'user',   -- 'admin' | 'user'
  text        text not null default '',
  attachments json not null default '[]',
  edited      boolean not null default false,
  edited_at   text,
  at          text not null                  -- ISO timestamp kept verbatim
);
create index if not exists chat_messages_uid_at_idx on chat_messages (uid, at);

-- Greeting flags (per-user, once)
create table if not exists chat_greeted (
  uid         text primary key,
  greeted_at  timestamptz not null default now()
);

-- KYC verifications
create table if not exists verifications (
  uid           text primary key,
  name          text not null default '',
  email         text not null default '',
  id_number     text not null default '',
  phone         text not null default '',
  id_front      text not null default '',
  id_back       text not null default '',
  advanced      text not null default '',
  advanced_status text,
  status        text not null default 'pending',
  note          text not null default '',
  advanced_note text not null default '',
  submitted_at  text,
  reviewed_at   text,
  advanced_submitted_at text,
  advanced_reviewed_at  text
);

-- Coin deposit/withdrawal addresses
create table if not exists coin_addresses (
  coin      text primary key,
  net       text not null default '',
  addr      text not null default ''
);

-- Per-user "profit mode" toggle
create table if not exists profit_mode (
  uid      text primary key,
  enabled  boolean not null default true,
  updated_at timestamptz not null default now()
);

-- App config (mirrors localStorage trustAppConfig)
create table if not exists app_config (
  id      int primary key default 1,
  json    text not null,
  updated_at timestamptz not null default now()
);

-- Backups (service-role import tool writes here)
create table if not exists backups (
  id          bigint generated always as identity primary key,
  label       text not null default 'backup',
  full_json   json not null default '{}',
  created_at  timestamptz not null default now()
);

-- ===========================================================================
-- READABLE VIA ANON/PUBLIC + writable app_meta blob store only
-- ===========================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, update on app_meta to anon;
grant select, insert, update on app_meta to authenticated;
grant select on app_config to anon;
grant select on coin_addresses to anon;
grant select, insert, update on app_config to authenticated;

-- app_meta is the app's blob store: anon MUST be able to read every blob
-- and write its own updates. RLS on this table may come pre-enabled on some
-- projects, so we explicitly enable it and add a fully permissive policy
-- (deterministic behavior everywhere).
alter table app_meta enable row level security;
drop policy if exists app_meta_all on app_meta;
create policy app_meta_all on app_meta for all to anon, authenticated using (true) with check (true);

-- ===========================================================================
-- RLS
-- ===========================================================================
alter table users          enable row level security;
alter table balances       enable row level security;
alter table txns           enable row level security;
alter table loans          enable row level security;
alter table trades         enable row level security;
alter table aiorders       enable row level security;
alter table orders         enable row level security;
alter table chat_messages  enable row level security;
alter table chat_greeted   enable row level security;
alter table verifications  enable row level security;
alter table coin_addresses enable row level security;
alter table profit_mode    enable row level security;
alter table app_config     enable row level security;
alter table backups        enable row level security;

-- Block all anon/authenticated writes/updates/deletes to business data.
-- Writes happen via the service-role import tool (bypasses RLS) or
-- SQL-only admin. (App uses anon for reads only.)
drop policy if exists block_all_on_users         on users         ;
drop policy if exists block_all_on_balances      on balances      ;
drop policy if exists block_all_on_txns          on txns          ;
drop policy if exists block_all_on_loans         on loans         ;
drop policy if exists block_all_on_trades        on trades        ;
drop policy if exists block_all_on_aiorders      on aiorders      ;
drop policy if exists block_all_on_orders        on orders        ;
drop policy if exists block_all_on_chat_messages on chat_messages ;
drop policy if exists block_all_on_chat_greeted  on chat_greeted  ;
drop policy if exists block_all_on_verifications on verifications ;
drop policy if exists block_all_on_profit_mode   on profit_mode   ;
drop policy if exists block_all_on_backups       on backups       ;

create policy block_all_on_users         on users          for all using (false) with check (false);
create policy block_all_on_balances      on balances       for all using (false) with check (false);
create policy block_all_on_txns          on txns           for all using (false) with check (false);
create policy block_all_on_loans         on loans          for all using (false) with check (false);
create policy block_all_on_trades        on trades         for all using (false) with check (false);
create policy block_all_on_aiorders      on aiorders       for all using (false) with check (false);
create policy block_all_on_orders        on orders         for all using (false) with check (false);
create policy block_all_on_chat_messages on chat_messages  for all using (false) with check (false);
create policy block_all_on_chat_greeted  on chat_greeted   for all using (false) with check (false);
create policy block_all_on_verifications on verifications  for all using (false) with check (false);
create policy block_all_on_profit_mode   on profit_mode    for all using (false) with check (false);
create policy block_all_on_backups       on backups        for all using (false) with check (false);

-- Makes the tables readable by the service role at all times (the
-- authenticated/anon roles are the only ones locked down).

END;