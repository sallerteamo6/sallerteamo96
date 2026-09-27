-- Apply after 24_wallet_login_challenges.sql (and keep existing upgrades).
-- No balances, orders, admin roles, or existing member numbers are changed.
begin;

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
