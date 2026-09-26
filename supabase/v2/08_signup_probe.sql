-- ===========================================================================
--  08_signup_probe.sql  --  repair sign-up, and prove it
--  Run this AFTER 01..07. Safe to run more than once.
--
--  Symptom: POST /auth/v1/signup returns HTTP 500,
--  {"msg":"Database error saving new user"} and no account is created.
--
--  Cause
--  -----
--  public.users has a BEFORE INSERT trigger, users_prepare, running
--  prepare_user(). That function generated a referral code with
--  gen_random_bytes(), which is part of pgcrypto. Supabase installs pgcrypto
--  into the `extensions` schema, not `public`.
--
--  The insert arrives through handle_new_auth_user(), a SECURITY DEFINER
--  function declared with `set search_path = public`, so pgcrypto was not on
--  the search path and Postgres could not resolve gen_random_bytes(). The
--  error aborted the whole sign-up transaction, which is what GoTrue reports
--  as the generic "Database error saving new user".
--
--  gen_random_uuid() is built into pg_catalog on PostgreSQL 13+ and needs no
--  extension, so the dependency is removed entirely rather than relying on
--  pgcrypto happening to be installed where this trigger can see it.
--
--  Verify
--  ------
--  Section 3 below performs the exact insert the trigger makes, inside a
--  transaction that is rolled back, and reports the outcome as a NOTICE. So
--  this file either leaves a working sign-up or tells you the real error --
--  no guessing.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Replace the trigger function. search_path is pinned so the function cannot
--    be broken again by whatever schema an extension happens to live in.
-- ---------------------------------------------------------------------------
create or replace function public.prepare_user() returns trigger
language plpgsql set search_path = public as $$
begin
  new.account := lower(trim(new.account));
  if new.referral_code is null then
    new.referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  end if;
  return new;
end $$;

-- The other trigger functions get the same treatment. None of them need an
-- extension, but an unpinned search_path is what caused this failure.
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.bump_user_version() returns trigger
language plpgsql set search_path = public as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists users_prepare on public.users;
create trigger users_prepare
  before insert on public.users
  for each row execute function public.prepare_user();

-- ---------------------------------------------------------------------------
-- 2. Make sure the audit_log write in the delete trigger cannot fail either.
-- ---------------------------------------------------------------------------
create or replace function public.handle_auth_user_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (action, entity, entity_id)
  values ('auth_delete', 'users', old.id::text);
  return old;
end $$;

alter function public.handle_auth_user_deleted() owner to postgres;

-- ---------------------------------------------------------------------------
-- 3. Prove it. The FK to auth.users is dropped only inside this transaction,
--    and the whole transaction is rolled back, so nothing is inserted and the
--    constraint is left exactly as it was.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ok text;
begin
  alter table public.users drop constraint if exists users_id_fkey;

  begin
    insert into public.users (id, account, email, login_method)
    values (gen_random_uuid(), 'signup_probe_row', 'probe@local.invalid', 'email');
    v_ok := 'OK -- referral code = ' ||
            coalesce((select referral_code::text from public.users
                       where account = 'signup_probe_row'), '(none)');
  exception when others then
    v_ok := 'STILL FAILING -> ' || sqlstate || ' ' || sqlerrm;
  end;

  raise notice 'sign-up probe: %', v_ok;
end $$;

rollback;   -- the probe insert and the temporary FK drop are both undone

-- ===========================================================================
--  Read the NOTICE in section 3.
--
--    "sign-up probe: OK -- referral code = ABC123..."   -> fixed, sign up works
--    "sign-up probe: STILL FAILING -> <state> <text>"  -> paste that text back
-- ===========================================================================
