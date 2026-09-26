-- ===========================================================================
--  TrustCom clone — backend v2 schema
-- ===========================================================================
--  Run against a BRAND NEW Supabase project, in this order:
--     01_schema.sql      tables, types, indexes, triggers
--     02_rls.sql         row level security policies
--     03_functions.sql   RPCs the app calls (contract open/settle, admin ops)
--     04_realtime.sql    realtime publication
--     05_seed.sql        reference data (markets, products, settings)
--     06_auth.sql        Supabase Auth wiring + first-admin trigger
--
--  ---------------------------------------------------------------------------
--  Why identity comes from Supabase Auth and not from our own table
--  ---------------------------------------------------------------------------
--  v1 kept every account in a JSON blob in `app_meta` with the password in
--  cleartext, readable by the anonymous key. The obvious "fix" is to roll your
--  own session table and read the caller's id out of request.jwt.claims — but
--  this is a static site: it holds only the anon key and has no signing secret,
--  so anything it sends in `Authorization: Bearer` is attacker-controlled. A
--  hand-rolled scheme here is a full authentication bypass, because forging
--  `sub` is just editing a JSON string.
--
--  So identity is Supabase Auth's job. GoTrue signs the JWT with the project's
--  JWT secret, which never leaves the server, and PostgREST verifies that
--  signature before any policy runs. auth.uid() is therefore trustworthy, and
--  every policy below is built on it. `public.users` is a profile table keyed
--  by auth.users.id, holding app-specific fields only.
--
--  Other changes from v1:
--    * one table per entity instead of JSON blobs in app_meta
--    * NUMERIC(24,8) for money, never float — binary options settle a fixed
--      payout and float rounding on a balance is a real bug
--    * a double-entry style ledger; the balances table is a cache of it
--    * every money movement and privileged status change goes through a
--      SECURITY DEFINER function, so it is transactional and audited
-- ===========================================================================

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enumerated domains, so 'pendign' is rejected by the database instead of
-- silently becoming a status nothing matches.
-- ---------------------------------------------------------------------------
do $$ begin create type user_status     as enum ('active', 'suspended', 'banned');
exception when duplicate_object then null; end $$;

do $$ begin create type kyc_status      as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin create type txn_type        as enum ('deposit', 'withdrawal', 'trade', 'loan', 'adjustment', 'bonus');
exception when duplicate_object then null; end $$;

do $$ begin create type txn_status      as enum ('pending', 'approved', 'rejected', 'completed', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin create type loan_status     as enum ('pending', 'approved', 'rejected', 'repaid', 'defaulted');
exception when duplicate_object then null; end $$;

do $$ begin create type contract_status as enum ('open', 'won', 'lost', 'void');
exception when duplicate_object then null; end $$;

do $$ begin create type chat_role       as enum ('user', 'admin', 'system');
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- 1. IDENTITY
-- ===========================================================================
--  This is a PROFILE table, not an account table. The account, its password
--  and its sessions live in auth.users / auth.sessions, which we never read
--  or write directly. id is the GoTrue user id.

create table if not exists public.users (
  id             uuid        primary key references auth.users (id) on delete cascade,
  -- Login handle: email, username, or 0x-wallet. Kept for display and for the
  -- app's account lookups; the authoritative credential is auth.users.email.
  account        text        not null,
  -- Copy of auth.users.email, written once by the trigger in 06_auth.sql.
  -- GoTrue remains the authority; this is a denormalised copy so admin search
  -- and the profile page do not need to read auth.users (which no client
  -- policy can reach). It is readable only by the owner and admins, because
  -- users_select_own restricts rows to auth.uid().
  email          text,
  login_method   text        not null default 'email'
                             check (login_method in ('email', 'username', 'wallet')),
  display_name   text,
  is_admin       boolean     not null default false,
  is_guest       boolean     not null default false,
  status         user_status not null default 'active',
  referral_code  text        unique,
  referred_by    uuid        references public.users (id) on delete set null,
  language       text,
  greeted        boolean     not null default false,
  -- Optimistic concurrency: a stale tab cannot clobber a newer write.
  version        integer     not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint users_account_unique unique (account)
);

-- Wallet addresses are lowercased by the insert trigger, so 0xAbC and 0xabc
-- are one account rather than two.
create unique index if not exists users_account_ci_idx on public.users (lower(account));
create index if not exists users_referred_by_idx on public.users (referred_by);
create index if not exists users_admin_idx on public.users (is_admin) where is_admin;

-- ===========================================================================
-- 2. WALLETS AND MONEY
-- ===========================================================================

create table if not exists public.balances (
  uid           uuid          not null references public.users (id) on delete cascade,
  coin          text          not null,
  amount        numeric(24,8) not null default 0 check (amount >= 0),
  -- Portion committed to open contracts. available = amount - locked_amount.
  locked_amount numeric(24,8) not null default 0 check (locked_amount >= 0),
  updated_at    timestamptz   not null default now(),
  primary key (uid, coin),
  constraint balances_lock_within_balance check (locked_amount <= amount)
);

-- Append-only. The balances table is a cache of this; the ledger is the record
-- of truth and is never updated or deleted.
create table if not exists public.ledger_entries (
  id            bigint generated always as identity primary key,
  uid           uuid          not null references public.users (id) on delete restrict,
  coin          text          not null,
  delta         numeric(24,8) not null check (delta <> 0),   -- + credit, - debit
  balance_after numeric(24,8),
  reason        txn_type      not null,
  ref_table     text,
  ref_id        text,
  note          text,
  created_by    uuid          references public.users (id) on delete set null,
  created_at    timestamptz   not null default now()
);
create index if not exists ledger_uid_idx on public.ledger_entries (uid, created_at desc);
create index if not exists ledger_ref_idx on public.ledger_entries (ref_table, ref_id);

-- Public read: the deposit page shows addresses to signed-out visitors.
-- Composite key, not coin alone: USDT on TRC20 and on ERC20 are two addresses.
create table if not exists public.coin_addresses (
  coin        text          not null,
  network     text          not null,
  address     text          not null,
  qr_code     text,
  min_deposit numeric(24,8) check (min_deposit is null or min_deposit >= 0),
  is_active   boolean       not null default true,
  updated_at  timestamptz   not null default now(),
  primary key (coin, network)
);

-- ===========================================================================
-- 3. DEPOSITS AND WITHDRAWALS
-- ===========================================================================

create table if not exists public.transactions (
  id           bigint generated always as identity primary key,
  uid          uuid          not null references public.users (id) on delete restrict,
  type         txn_type      not null,
  coin         text          not null,
  amount       numeric(24,8) not null check (amount > 0),
  status       txn_status    not null default 'pending',
  reference_id text,
  proof_url    text,
  proof_name   text,
  note         text,
  reviewed_by  uuid          references public.users (id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now()
);
create index if not exists transactions_uid_idx on public.transactions (uid, created_at desc);
create index if not exists transactions_status_idx on public.transactions (status, created_at desc);
-- One on-chain reference can back at most one transaction, so a replayed
-- deposit reference cannot be credited twice.
create unique index if not exists transactions_ref_unique
  on public.transactions (coin, reference_id) where reference_id is not null;

-- ===========================================================================
-- 4. TRADING
-- ===========================================================================

-- Odds live in the database, not hardcoded in the front end, so they can be
-- changed without shipping a build.
create table if not exists public.products (
  id         serial primary key,
  symbol     text          not null unique,
  name       text          not null,
  -- Binance pair the settlement script quotes, e.g. 'BTCUSDT'. Kept beside the
  -- symbol rather than derived from it, so a product can track a pair that is
  -- not simply symbol + quote_coin.
  price_symbol text        not null,
  payout_pct numeric(6,2)  not null check (payout_pct > 0),
  min_amount numeric(24,8) not null default 10 check (min_amount > 0),
  quote_coin text          not null default 'USDT',
  is_active  boolean       not null default true,
  sort_order integer       not null default 0,
  created_at timestamptz   not null default now()
);

create table if not exists public.product_durations (
  id         serial primary key,
  product_id integer       not null references public.products (id) on delete cascade,
  seconds    integer       not null check (seconds > 0),
  payout_pct numeric(6,2)  not null check (payout_pct > 0),
  is_active  boolean       not null default true,
  unique (product_id, seconds)
);

create table if not exists public.contracts (
  id           uuid              primary key default gen_random_uuid(),
  uid          uuid              not null references public.users (id) on delete restrict,
  product_id   integer           not null references public.products (id) on delete restrict,
  coin         text              not null,
  side         text              not null check (side in ('up', 'down')),
  amount       numeric(24,8)     not null check (amount > 0),
  duration_sec integer           not null check (duration_sec > 0),
  payout_pct   numeric(6,2)      not null check (payout_pct > 0),
  entry_price  numeric(24,8)     not null check (entry_price > 0),
  settle_price numeric(24,8),
  payout       numeric(24,8),
  status       contract_status   not null default 'open',
  opened_at    timestamptz       not null default now(),
  expires_at   timestamptz       not null,
  settled_at   timestamptz,
  -- Settlement is idempotent: a second call sees this and returns the stored
  -- result instead of paying out twice.
  settled_by   uuid              references public.users (id) on delete set null,
  constraint contracts_expiry_after_open check (expires_at > opened_at),
  constraint contracts_open_iff_unsettled check ((status = 'open') = (settled_at is null))
);
create index if not exists contracts_uid_idx on public.contracts (uid, opened_at desc);
create index if not exists contracts_open_idx on public.contracts (expires_at)
  where status = 'open';

-- ===========================================================================
-- 5. AI QUANT
-- ===========================================================================

create table if not exists public.investment_products (
  id          serial primary key,
  code        text        not null unique,
  name        text        not null,
  period_days integer     not null check (period_days > 0),
  rate_min    numeric(6,2) not null check (rate_min >= 0),
  rate_max    numeric(6,2) not null check (rate_max >= rate_min),
  is_active   boolean     not null default true
);

create table if not exists public.investments (
  id           bigint generated always as identity primary key,
  uid          uuid          not null references public.users (id) on delete restrict,
  product_id   integer       not null references public.investment_products (id) on delete restrict,
  principal    numeric(24,8) not null check (principal > 0),
  profit       numeric(24,8) not null default 0,
  rate         numeric(6,2)  not null,
  period_days  integer       not null check (period_days > 0),
  settled_days integer       not null default 0 check (settled_days >= 0),
  status       text          not null default 'active'
                             check (status in ('active', 'matured', 'cancelled')),
  schedules    jsonb         not null default '[]'::jsonb,
  start_at     timestamptz,
  end_at       timestamptz,
  created_at   timestamptz   not null default now(),
  constraint investments_settled_within_period check (settled_days <= period_days)
);
create index if not exists investments_uid_idx on public.investments (uid, created_at desc);
create index if not exists investments_active_idx on public.investments (end_at)
  where status = 'active';

-- ===========================================================================
-- 6. LOANS
-- ===========================================================================

create table if not exists public.loans (
  id         bigint generated always as identity primary key,
  uid        uuid          not null references public.users (id) on delete restrict,
  principal  numeric(24,8) not null check (principal > 0),
  days       integer       not null check (days > 0),
  rate       numeric(6,2)  not null check (rate >= 0),
  interest   numeric(24,8) not null default 0 check (interest >= 0),
  status     loan_status   not null default 'pending',
  note       text,
  created_at timestamptz   not null default now(),
  approved_at timestamptz,
  approved_by uuid         references public.users (id) on delete set null,
  repaid_at  timestamptz,
  updated_at timestamptz   not null default now()
);
create index if not exists loans_uid_idx on public.loans (uid, created_at desc);
create index if not exists loans_status_idx on public.loans (status, created_at desc);

-- ===========================================================================
-- 7. KYC
-- ===========================================================================

create table if not exists public.verifications (
  uid                  uuid primary key references public.users (id) on delete cascade,
  full_name            text,
  email                text,
  id_number            text,
  phone                text,
  id_front_url         text,
  id_back_url          text,
  status               kyc_status not null default 'pending',
  -- "Advanced" verification is the second, higher tier in the original app.
  advanced             text,
  advanced_status      kyc_status,
  advanced_note        text,
  rejection_reason     text,
  submitted_at         timestamptz not null default now(),
  reviewed_at          timestamptz,
  reviewed_by          uuid references public.users (id) on delete set null,
  advanced_submitted_at timestamptz,
  advanced_reviewed_at  timestamptz
);

-- ===========================================================================
-- 8. SUPPORT CHAT
-- ===========================================================================

create table if not exists public.chat_threads (
  id        bigint generated always as identity primary key,
  uid       uuid        not null references public.users (id) on delete cascade,
  subject   text,
  last_at   timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.chat_messages (
  id          bigint generated always as identity primary key,
  thread_id   bigint      not null references public.chat_threads (id) on delete cascade,
  uid         uuid        not null references public.users (id) on delete cascade,
  from_role   chat_role   not null default 'user',
  body        text        not null default '',
  attachments jsonb       not null default '[]'::jsonb,
  edited      boolean     not null default false,
  edited_at   timestamptz,
  deleted     boolean     not null default false,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint chat_body_or_attachment
    check (length(body) > 0 or jsonb_array_length(attachments) > 0)
);
create index if not exists chat_messages_thread_idx on public.chat_messages (thread_id, created_at);

-- One open thread per user: many closed over time, exactly one open at a time.
create unique index if not exists chat_threads_one_open_idx
  on public.chat_threads (uid) where closed_at is null;

-- ===========================================================================
-- 9. SETTINGS AND AUDIT
-- ===========================================================================

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id) on delete set null
);

-- Insert-only. No update or delete policy is granted to any role, so rows are
-- immutable to everyone else. Changes come from the SECURITY DEFINER
-- functions in 03_functions.sql, which write here.
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  actor      uuid references public.users (id) on delete set null,
  action     text        not null,
  entity     text        not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         inet,
  created_at timestamptz not null default now()
);
create index if not exists audit_actor_idx on public.audit_log (actor, created_at desc);
create index if not exists audit_entity_idx on public.audit_log (entity, entity_id);

-- ===========================================================================
-- 10. TRIGGERS
-- ===========================================================================

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['users', 'transactions', 'loans', 'balances', 'app_settings']
  loop
    execute format('drop trigger if exists trg_touch_%s on public.%I', t, t);
    execute format(
      'create trigger trg_touch_%s before update on public.%I
         for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- Bump the optimistic-concurrency counter on every user update.
create or replace function public.bump_user_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end $$;

drop trigger if exists users_version on public.users;
create trigger users_version before update on public.users
  for each row execute function public.bump_user_version();

-- Referral code + account normalisation, assigned on insert.
create or replace function public.prepare_user() returns trigger
language plpgsql as $$
begin
  new.account := lower(trim(new.account));
  if new.referral_code is null then
    new.referral_code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 10));
  end if;
  return new;
end $$;

drop trigger if exists users_prepare on public.users;
create trigger users_prepare before insert on public.users
  for each row execute function public.prepare_user();

-- Keep a thread's last_at current without the client having to write it.
create or replace function public.touch_chat_thread() returns trigger
language plpgsql as $$
begin
  update public.chat_threads set last_at = new.created_at where id = new.thread_id;
  return new;
end $$;

drop trigger if exists chat_messages_touch on public.chat_messages;
create trigger chat_messages_touch after insert on public.chat_messages
  for each row execute function public.touch_chat_thread();

commit;
