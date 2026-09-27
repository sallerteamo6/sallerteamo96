-- Wallet login installation for the existing sallerteam096 v2 database.
-- Run the complete file once in Supabase SQL Editor, then deploy wallet-login.
-- Combines migrations 24 and 26 in a single transaction; safe to rerun.
-- Preserves users, member numbers, balances, orders, and administrator roles.
begin;

-- Apply after 23. Additive only: no existing table, column, function body or grant
-- is changed, and no user, balance, contract or investment row is touched.
--
-- What this is for
--   The Connect Wallet button on the index, login and register pages connects a
--   wallet perfectly well, and then sign-in always failed with "Wallet sign-in is
--   not available on this build". The refusal in app.js was correct: signing in
--   with a wallet means recovering the signer from an Ethereum signature and
--   checking it against the claimed address, and that has to happen somewhere the
--   person signing cannot influence. Verifying it in the browser would let anyone
--   claim any address, so the browser does not do it.
--
--   This file is the half that belongs in the database: issuing a single-use
--   challenge and consuming it exactly once. The signature itself is checked by
--   supabase/functions/wallet-login, an Edge Function, because Postgres cannot
--   recover an Ethereum signer.
--
--   The schema was already ready for this and nothing here changes it:
--   users.login_method has a 'wallet' value, users.account holds a 0x address,
--   and users_account_ci_idx makes 0xAbC and 0xabc one account rather than two.
--
-- ---------------------------------------------------------------------------
-- Replay protection is the whole point of putting the challenge here.
--
-- A nonce that can be reused is a login token that can be copied. So each nonce
-- is bound to one address, expires in ten minutes, and is marked used inside the
-- same transaction that hands it out. wallet_consume_nonce burns the nonce even
-- when the signature then turns out to be wrong, which is deliberate: it means a
-- captured signature cannot be retried against a different address, and it caps
-- how many guesses a single challenge is worth.
--
-- The message is built here and stored, not assembled by the browser. If the
-- client built the text it signed, a tampered message would still verify, because
-- the verifier and the signer would be reading the same tampered string. The
-- client only ever displays what this returns.

-- ---------------------------------------------------------------------------
-- 1. The challenge table.
--
-- One live challenge per address: a new request replaces the old one, so asking
-- twice does not leave two usable nonces behind.
-- ---------------------------------------------------------------------------
create table if not exists public.wallet_nonces (
  address     text        primary key
                        check (address ~ '^0x[0-9a-f]{40}$'),
  nonce       text        not null,
  message     text        not null,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index if not exists wallet_nonces_expires_idx
  on public.wallet_nonces (expires_at);

alter table public.wallet_nonces enable row level security;
revoke all on public.wallet_nonces from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Issue a challenge.
--
-- Callable by a signed-out visitor with the anon key, because that is exactly who
-- is asking: nobody is logged in yet. It reveals nothing beyond a nonce and a
-- sentence of text, and it writes nothing a member cares about.
--
-- Returns { ok, address, nonce, message, expires_at }.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_issue_nonce(p_address text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_addr   text;
  v_nonce  text;
  v_issued text;
  v_exp    text;
  v_msg    text;
  v_host   text;
  v_stmt   text;
begin
  v_addr := lower(trim(coalesce(p_address, '')));
  if v_addr !~ '^0x[0-9a-f]{40}$' then
    raise exception 'that is not a valid wallet address' using errcode = '22023';
  end if;

  -- The origin the function is served from is the domain the member is actually
  -- on, so the signed text names the site they are on rather than one we chose.
  v_host := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'host',
    'localhost'
  );
  -- Supabase forwards the public URL too; prefer it when the raw Host is internal.
  if v_host = '' or v_host like '%.internal' then
    v_host := 'localhost';
  end if;

  v_nonce  := encode(gen_random_bytes(16), 'hex');
  v_issued := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_exp    := to_char((now() + interval '10 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_stmt   := 'Sign in to ' || v_host || '. This request will not cost any gas.';

  -- EIP-4361. The address, domain, nonce and issue time are all fixed here, so
  -- the text cannot be edited after the member signs it.
  v_msg := v_host || ' wants you to sign in with your Ethereum account:' || chr(10)
        || v_addr || chr(10) || chr(10)
        || v_stmt || chr(10) || chr(10)
        || 'URI: https://' || v_host || chr(10)
        || 'Version: 1' || chr(10)
        || 'Nonce: ' || v_nonce || chr(10)
        || 'Issued At: ' || v_issued;

  -- Housekeeping: a challenge that can no longer be used is not worth keeping.
  delete from public.wallet_nonces where expires_at < now() - interval '1 day';

  insert into public.wallet_nonces (address, nonce, message, issued_at, expires_at)
  values (v_addr, v_nonce, v_msg, now(), now() + interval '10 minutes')
  on conflict (address) do update
     set nonce      = excluded.nonce,
         message    = excluded.message,
         issued_at  = excluded.issued_at,
         expires_at = excluded.expires_at,
         used_at    = null;

  return jsonb_build_object(
    'ok', true, 'address', v_addr, 'nonce', v_nonce,
    'message', v_msg, 'expires_at', v_exp
  );
end $$;

revoke all on function public.wallet_issue_nonce(text) from public;
grant  execute on function public.wallet_issue_nonce(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Consume a challenge, exactly once.
--
-- service_role only: this is the step that decides a login is legitimate, and it
-- runs inside the Edge Function that holds the service key. The anon role must
-- never be able to burn a challenge, or one person could invalidate another
-- member's in-flight sign-in.
--
-- Returns { ok, address, message } on success, or { ok: false, reason } without
-- raising, so the caller can tell "wrong signature" from "stale challenge"
-- without parsing an error string.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_consume_nonce(p_address text, p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_addr text := lower(trim(coalesce(p_address, '')));
  v_row  public.wallet_nonces;
begin
  if v_addr !~ '^0x[0-9a-f]{40}$' then
    return jsonb_build_object('ok', false, 'reason', 'bad_address');
  end if;

  -- FOR UPDATE plus the used_at test inside one transaction: two requests
  -- presenting the same challenge cannot both come back ok, whatever order they
  -- arrive in.
  select * into v_row
    from public.wallet_nonces
   where address = v_addr
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_challenge');
  end if;

  if v_row.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;
  if v_row.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_row.nonce is distinct from coalesce(p_nonce, '') then
    -- Wrong nonce is a guess, not a replay. Do not burn the real one.
    return jsonb_build_object('ok', false, 'reason', 'bad_nonce');
  end if;

  update public.wallet_nonces set used_at = now() where address = v_addr;

  return jsonb_build_object('ok', true, 'address', v_addr, 'message', v_row.message);
end $$;

revoke all on function public.wallet_consume_nonce(text, text) from public;
grant  execute on function public.wallet_consume_nonce(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Find the account already linked to a wallet, if any.
--
-- Also service_role only. The Edge Function uses it to tell a first-time wallet
-- (no account yet) from a returning one, which is the difference between creating
-- a user and issuing a session for an existing one. It returns the uid as well as
-- the email, because the profile link needs the uid and a second round trip to
-- look it up from the email would be a chance for the two to disagree.
--
-- Returns NULL when the address is not linked to anything yet, or
-- { uid, email } when it is.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_user_email(p_address text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_addr text := lower(trim(coalesce(p_address, '')));
begin
  return (
    select jsonb_build_object('uid', u.id, 'email', u.email)
      from public.users u
     where lower(u.account) = v_addr
     limit 1
  );
end $$;

revoke all on function public.wallet_user_email(text) from public;
grant  execute on function public.wallet_user_email(text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Record the wallet on the profile.
--
-- The insert trigger in 06_auth.sql sets account from the email, so a wallet
-- account is created with a derived placeholder address and then rewritten here
-- to the real 0x address. login_method is what the app uses to recognise it.
-- ---------------------------------------------------------------------------
create or replace function public.wallet_link_profile(p_uid uuid, p_address text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_addr  text := lower(trim(coalesce(p_address, '')));
  v_taken uuid;
begin
  if p_uid is null or v_addr !~ '^0x[0-9a-f]{40}$' then
    raise exception 'cannot link that wallet' using errcode = '22023';
  end if;

  -- One address, one account. If the address is already on a different profile
  -- then somebody is trying to attach it to a second one, and it must fail
  -- rather than quietly move the account and its money.
  select u.id into v_taken
    from public.users u
   where lower(u.account) = v_addr and u.id <> p_uid
   limit 1;
  if v_taken is not null then
    raise exception 'that wallet is already linked to another account' using errcode = '23505';
  end if;

  update public.users
     set account      = v_addr,
         email        = coalesce(nullif(p_email, ''), email),
         login_method = 'wallet',
         updated_at   = now()
   where id = p_uid;

  if not found then
    raise exception 'no profile to link' using errcode = 'P0002';
  end if;

  return jsonb_build_object('ok', true, 'account', v_addr);
end $$;

revoke all on function public.wallet_link_profile(uuid, text, text) from public;
grant  execute on function public.wallet_link_profile(uuid, text, text) to service_role;


-- Apply after 24_wallet_login_challenges.sql (and keep existing upgrades).
-- No balances, orders, admin roles, or existing member numbers are changed.

-- Challenge text is ordinary EIP-191 personal_sign text. The old text looked
-- like SIWE but omitted required fields and used the API host as the website.
-- Only the verifying server can choose the configured website origin.
drop function if exists public.wallet_issue_nonce(text);
create or replace function public.wallet_issue_nonce(p_address text, p_origin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_addr text := lower(trim(coalesce(p_address, '')));
  v_nonce text := encode(gen_random_bytes(16), 'hex');
  v_exp timestamptz := now() + interval '10 minutes';
  v_msg text;
begin
  if v_addr !~ '^0x[0-9a-f]{40}$' then
    raise exception 'that is not a valid wallet address' using errcode = '22023';
  end if;
  if p_origin is null or p_origin !~ '^https?://[^[:space:]/@]+$' or length(p_origin) > 255 then
    raise exception 'wallet sign-in origin is not configured' using errcode = '22023';
  end if;
  v_msg := 'Sign in to ' || p_origin || chr(10) || chr(10)
    || 'Wallet: ' || v_addr || chr(10) || chr(10)
    || 'This signature only signs you in. It does not approve transactions or token access.' || chr(10) || chr(10)
    || 'Nonce: ' || v_nonce || chr(10)
    || 'Issued at: ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || chr(10)
    || 'Expires at: ' || to_char(v_exp at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  delete from public.wallet_nonces where expires_at < now() - interval '1 day';
  insert into public.wallet_nonces (address, nonce, message, issued_at, expires_at)
  values (v_addr, v_nonce, v_msg, now(), v_exp)
  on conflict (address) do update set nonce = excluded.nonce,
    message = excluded.message, issued_at = excluded.issued_at,
    expires_at = excluded.expires_at, used_at = null;

  return jsonb_build_object('ok', true, 'address', v_addr, 'nonce', v_nonce,
    'message', v_msg, 'expires_at', v_exp);
end $$;
revoke all on function public.wallet_issue_nonce(text, text) from public, anon, authenticated;
grant execute on function public.wallet_issue_nonce(text, text) to service_role;

-- Use the Auth email, not a stale profile copy. Recover an interrupted first
-- login only from server-owned app_metadata, never user-editable metadata or a
-- predictable email address. A repeat login reuses the same UID and balance.
create or replace function public.wallet_user_email(p_address text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_addr text := lower(trim(coalesce(p_address, '')));
  v_ids uuid[];
begin
  if v_addr !~ '^0x[0-9a-f]{40}$' then
    raise exception 'that is not a valid wallet address' using errcode = '22023';
  end if;
  select array_agg(a.id) into v_ids
  from auth.users a left join public.users u on u.id = a.id
  where (u.login_method = 'wallet' and lower(u.account) = v_addr)
     or (a.raw_app_meta_data ->> 'login_method' = 'wallet'
         and lower(a.raw_app_meta_data ->> 'wallet_address') = v_addr);
  if coalesce(cardinality(v_ids), 0) > 1 then
    raise exception 'that wallet is already linked to another account' using errcode = '23505';
  end if;
  return (select jsonb_build_object('uid', a.id, 'email', a.email)
          from auth.users a where a.id = v_ids[1]);
end $$;
revoke all on function public.wallet_user_email(text) from public, anon, authenticated;
grant execute on function public.wallet_user_email(text) to service_role;

-- Save the real user row before issuing a session so both admin read paths
-- (profile-admin and passphrase-admin) see it through their existing users read.
create or replace function public.wallet_link_profile(p_uid uuid, p_address text, p_email text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_addr text := lower(trim(coalesce(p_address, '')));
  v_auth auth.users;
begin
  if p_uid is null or v_addr !~ '^0x[0-9a-f]{40}$' then
    raise exception 'cannot link that wallet' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('wallet:' || v_addr, 0));
  select * into v_auth from auth.users where id = p_uid for update;
  if not found or v_auth.email is null or lower(v_auth.email) is distinct from lower(p_email) then
    raise exception 'wallet auth identity does not match' using errcode = '22023';
  end if;
  if not (coalesce(v_auth.raw_app_meta_data ->> 'login_method', '') = 'wallet'
          and coalesce(lower(v_auth.raw_app_meta_data ->> 'wallet_address'), '') = v_addr)
     and not exists (select 1 from public.users where id = p_uid
                     and login_method = 'wallet' and lower(account) = v_addr) then
    raise exception 'wallet auth identity is not linked' using errcode = '42501';
  end if;
  if exists (select 1 from public.users u where lower(u.account) = v_addr and u.id <> p_uid) then
    raise exception 'that wallet is already linked to another account' using errcode = '23505';
  end if;
  if exists (select 1 from public.users where id = p_uid and status <> 'active') then
    raise exception 'this account is suspended or banned' using errcode = '42501';
  end if;
  insert into public.users (id, account, email, login_method, is_guest)
  values (p_uid, v_addr, v_auth.email, 'wallet', false)
  on conflict (id) do update set account = excluded.account, email = excluded.email,
    login_method = 'wallet', is_guest = false, updated_at = now();
  return jsonb_build_object('ok', true, 'uid', p_uid, 'account', v_addr);
end $$;
revoke all on function public.wallet_link_profile(uuid, text, text) from public, anon, authenticated;
grant execute on function public.wallet_link_profile(uuid, text, text) to service_role;


notify pgrst, 'reload schema';
commit;
