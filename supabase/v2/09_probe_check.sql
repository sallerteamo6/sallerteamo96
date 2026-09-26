-- ===========================================================================
--  09_probe_check.sql
--  Fixes sign-up, then proves it worked. Paste the WHOLE file and press Run
--  once. Do not split it, do not remove the "--" from any line.
--
--  Supersedes 07 and 08. 08 in particular must not be run: it wrapped the fix
--  and the probe in one transaction and ended with ROLLBACK, so it undid the
--  very fix it applied.
--
--  Cause being fixed
--  -----------------
--  prepare_user() generated the referral code with gen_random_bytes(), which
--  belongs to pgcrypto. Supabase installs pgcrypto into the `extensions`
--  schema, but this trigger runs with search_path = public, so the function
--  could not be resolved, the insert aborted, and GoTrue reported only the
--  generic "Database error saving new user". gen_random_uuid() is built into
--  pg_catalog on PostgreSQL 13+ and needs no extension at all.
--
--  What you get
--  ------------
--  One row in the results grid:
--
--    normalised_account  = mixed_case_probe
--    referral_code       = 10 random characters, e.g. 7KQ2M9XB4D
--    referral_len        = 10
--    pgcrypto_refs       = 0
--    builtin_uuid_refs   = 1
--
--  pgcrypto_refs = 0 with a non-empty referral_code means the trigger now
--  resolves and sign-up should no longer 500.
--
--  If the run errors instead, copy the error text back verbatim -- that pins
--  the cause exactly.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Step 1. Apply the fix, and commit it on its own.
--
-- The commit is deliberate: if the probe in step 2 fails, the repair must
-- already be permanent rather than disappearing with the failed transaction.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.prepare_user() returns trigger
language plpgsql set search_path = public as $$
begin
  new.account := lower(trim(new.account));
  if new.referral_code is null then
    new.referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  end if;
  return new;
end $$;

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

commit;


-- ---------------------------------------------------------------------------
-- Step 2. Prove it by really running prepare_user() over a throwaway table
-- with deliberately messy input, so the grid also shows the normalisation
-- working. The table is temporary, so it disappears with the session and
-- never touches your data.
--
-- No transaction wrapper here on purpose: fewer moving parts, and a failure
-- here can no longer roll back the committed fix from step 1.
-- ---------------------------------------------------------------------------
drop table if exists probe_users;

create temporary table probe_users (
  id            uuid,
  account       text,
  email         text,
  referral_code text
);

create trigger probe_prepare
  before insert on probe_users
  for each row execute function public.prepare_user();

insert into probe_users (id, account, email)
values (gen_random_uuid(), '  MiXeD_CaSe_Probe  ', 'probe@local.invalid');


-- ---------------------------------------------------------------------------
-- Step 3. The verdict. This is the LAST statement in the file, so it is the
-- one the results grid shows.
-- ---------------------------------------------------------------------------
select
  (select account                        from probe_users limit 1)              as normalised_account,
  (select referral_code                  from probe_users limit 1)              as referral_code,
  (select length(referral_code)          from probe_users limit 1)              as referral_len,
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('prepare_user', 'handle_new_auth_user')
      and position('gen_random_bytes' in pg_get_functiondef(p.oid)) > 0)       as pgcrypto_refs,
  (select count(*)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('prepare_user', 'handle_new_auth_user')
      and position('gen_random_uuid'  in pg_get_functiondef(p.oid)) > 0)       as builtin_uuid_refs;


-- ===========================================================================
--  After this succeeds
--  -------------------
--  1. Sign up on the site with your own email, then confirm it.
--  2. Promote yourself to administrator exactly once:
--
--         select public.promote_first_admin('your-email@example.com');
--
--     It refuses to run if an admin already exists, so it cannot be replayed
--     to escalate later.
--
--  3. This file is safe to run more than once. The functions are replaced,
--     the trigger is dropped and recreated, and the probe table is temporary.
-- ===========================================================================
