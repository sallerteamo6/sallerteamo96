-- ===========================================================================
--  Supabase Auth wiring
-- ===========================================================================
--  Run LAST. Auth must already be enabled on the project
--  (Dashboard -> Authentication -> Providers -> Email).
--
--  This file creates the profile row whenever GoTrue creates an account, and
--  promotes the very first account to administrator. It contains no password
--  and no API key: GoTrue owns credentials, we only mirror app-specific fields.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Create a public.users profile for each new auth user.
--
--  The client calls supabase.auth.signUp({ email, password }), which inserts
--  into auth.users. Without this trigger the account exists but has no
--  profile, so every RLS policy using auth.uid() would match nothing.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, account, email, login_method, is_guest)
  values (
    new.id,
    lower(coalesce(new.email, new.id::text)),
    new.email,
    -- GoTrue only ever stores a real address here, so '0x%' can never match.
    -- Wallet and username sign-in would need their own provider wired up in
    -- the dashboard; until then every account is an email account.
    'email',
    coalesce(new.raw_user_meta_data ->> 'is_guest', 'false')::boolean
  )
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- First administrator, promoted deliberately rather than by the trigger.
--
--  v2 originally made "the first account that ever signs up" an admin, checked
--  with `if not exists (select 1 from users where id <> new.id)`. That is
--  wrong twice over: two signups racing each other can both see themselves as
--  the only user and both become admin, and on a public site the first signup
--  is usually a stranger. Whoever reaches the form first would own the
--  platform, including the ability to credit themselves balances.
--
--  So the trigger only creates the profile. You run the promotion yourself,
--  as the project owner, from the SQL editor, right after signing up:
--
--      select public.promote_first_admin('<your-email@example.com>');
--
--  It refuses to run once any admin exists, so it cannot be replayed to
--  escalate later.
-- ---------------------------------------------------------------------------
create or replace function public.promote_first_admin(p_account text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.users where is_admin) then
    raise exception 'an administrator already exists; promote further admins with an explicit update'
      using errcode = '42501';
  end if;

  select id into v_id from public.users where account = lower(trim(p_account));
  if v_id is null then
    raise exception 'no account %', p_account using errcode = 'P0002';
  end if;

  update public.users set is_admin = true where id = v_id;

  insert into public.audit_log (actor, action, entity, entity_id, after)
  values (v_id, 'promote_admin', 'users', v_id::text,
          jsonb_build_object('is_admin', true, 'reason', 'first administrator'));

  return v_id;
end $$;

revoke all on function public.promote_first_admin(text) from public, anon, authenticated;

-- Mirror profile deletion. auth.users already cascades to public.users, but an
-- explicit trigger keeps the intent visible and logs it.
create or replace function public.handle_auth_user_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (action, entity, entity_id)
  values ('auth_delete', 'users', old.id::text);
  return old;
end $$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted before delete on auth.users
  for each row execute function public.handle_auth_user_deleted();

commit;

-- ===========================================================================
--  Dashboard settings to apply manually (no SQL can set these)
-- ===========================================================================
--
--  1. Authentication -> Providers -> Email: ENABLED. Keep "Confirm email" ON
--     for production; turn it OFF only for local testing.
--
--  2. Authentication -> URL Configuration:
--       Site URL  = https://your-domain.example
--       Redirect URLs = https://your-domain.example/**
--                   + http://localhost:5500/**
--
--  3. Authentication -> JWT Settings:
--       JWT expiry = 3600 seconds
--       "Verify JWT expiry" = ON
--
--  4. API -> Data API Settings:
--       "Exposed schemas"      = public, graphql_public
--       DB_PRIVILEGE (advanced) = anon
--       Using `anon` rather than `postgres` is what makes RLS apply to every
--       request from the browser instead of bypassing it.
--
--  5. Re-authentication / leaked password protection: ON.
--
--  6. Remove every anon grant that is not listed in 02_rls.sql. Supabase
--     grants some tables to anon by default via the `public` schema defaults;
--     a stray grant silently overrides a restrictive policy.
--
--  7. Do NOT ship the service_role key to the browser. It is only ever used
--     from a trusted server or a local script, and it bypasses RLS entirely.
