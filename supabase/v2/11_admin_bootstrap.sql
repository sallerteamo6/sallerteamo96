-- ===========================================================================
--  11_admin_bootstrap.sql
--  Lets a real database administrator grant the first is_admin flag.
--
--  Run this AFTER 02_rls.sql. Safe to run more than once.
--
--  The bug being fixed
--  ------------------
--  02_rls.sql installs a trigger that stops privilege escalation:
--
--    create trigger users_guard_privileges before update on public.users
--      for each row execute function public.guard_user_privileges();
--
--  and the function refuses any is_admin change unless public.is_admin() is
--  already true:
--
--    if public.is_admin() then return new; end if;
--    if new.is_admin is distinct from old.is_admin then
--      raise exception 'is_admin cannot be changed by the account owner';
--
--  That is correct as far as it goes, but it left NO WAY to create the very
--  first administrator:
--
--    * Running the UPDATE by hand from the SQL editor failed with
--          ERROR: 42501 is_admin cannot be changed by the account owner
--      because the SQL editor sends no user JWT, so auth.uid() is NULL and
--      is_admin() is false.
--
--    * public.promote_first_admin() failed the same way. SECURITY DEFINER
--      changes the *role* the function runs as, but auth.uid() reads
--      request.jwt.claim.sub from the JWT, which a SQL editor session does not
--      have. So the one function written to bootstrap the first admin was
--      blocked by the trigger guarding the column it had to set.
--
--  A user could therefore never become an administrator at all, and because
--  every read policy keys off is_admin(), the admin pages stayed permanently
--  empty: a deadlock that only an owner with direct table access could break.
--
--  The fix
--  -------
--  Distinguish "a database owner deliberately promoting someone" from "an
--  account owner promoting themselves". Only the first is allowed.
--
--  session_user is the role the client actually connected as, and it is the
--  right thing to test here. current_user is NOT: inside a SECURITY DEFINER
--  function Postgres rewrites current_user to the function owner, so testing
--  it would return 'postgres' for every caller and the guard would be
--  permanently disabled -- the exact opposite of what it is for.
--
--  session_user is not rewritten, so it distinguishes the two cases cleanly:
--
--    SQL editor / migration  ->  session_user = 'postgres'   -> allowed
--    browser via PostgREST   ->  session_user = 'authenticated' -> guard applies
--    anonymous browser       ->  session_user = 'anon'      -> guard applies
--
--  The guard therefore still blocks self-promotion for every browser caller.
--  Only someone who already has direct database access can grant the flag,
--  which is the intended trust boundary.
-- ===========================================================================


begin;

-- ---------------------------------------------------------------------------
-- The same guard, plus the DBA escape hatch.
--
-- The role list covers the names Supabase actually uses for a SQL editor or
-- CLI session. A deployment that renamed them simply keeps the stricter
-- behaviour: the guard applies, and the first admin is granted with the
-- explicit override shown at the bottom of this file.
-- ---------------------------------------------------------------------------
create or replace function public.guard_user_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Direct database access, no end-user JWT. This is the project owner doing
  -- maintenance, not a user escalating their own privileges.
  if session_user in ('postgres', 'supabase_admin', 'supabase_admin_admin', 'cli_user_postgres') then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.is_admin is distinct from old.is_admin then
    raise exception 'is_admin cannot be changed by the account owner'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    raise exception 'status can only be changed by an admin' using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists users_guard_privileges on public.users;
create trigger users_guard_privileges before update on public.users
  for each row execute function public.guard_user_privileges();


-- ---------------------------------------------------------------------------
-- Confirm the guard is actually installed and armed.
--
-- A trigger can exist while being disabled, in which case the whole guard is
-- inert. Disabled is reported as 'no' so a silent hole is visible.
-- ---------------------------------------------------------------------------
select
  t.tgname                                       as trigger_name,
  t.tgenabled                                    as trigger_enabled,
  t.tgrelid::regclass::text                      as on_table,
  p.proname                                      as function_name,
  p.prosecdef                                    as is_security_definer,
  position('session_user' in pg_get_functiondef(p.oid)) > 0
                                                 as has_dba_escape_hatch,
  case
    when t.tgenabled = 'O'
     and p.prosecdef
     and position('session_user' in pg_get_functiondef(p.oid)) > 0
      then 'correct'
    else 'CHECK THIS'
  end                                            as verdict
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
where t.tgname = 'users_guard_privileges';


-- ===========================================================================
--  After running this
--  -----------------
--  Grant the first administrator, using the function that also writes an
--  audit_log entry:
--
--      select public.promote_first_admin('your-email@example.com');
--
--  It raises 'no account <email>' if that account does not exist yet, so sign
--  up and confirm the email address FIRST. It also refuses to run once any
--  administrator exists, so it cannot be replayed to escalate later; promote
--  further admins from an existing admin's session instead.
--
--  Verify:
--
--      select account, is_admin, login_method, status from public.users
--       order by created_at;
--
--  If the verdict above says CHECK THIS, or promote_first_admin still reports
--  42501, use the explicit override once, which needs no function at all:
--
--      alter table public.users disable trigger users_guard_privileges;
--      update public.users set is_admin = true
--       where lower(account) = lower('your-email@example.com');
--      alter table public.users enable trigger users_guard_privileges;
--
--  Re-enabling matters: a left-disabled trigger removes the escalation guard
--  for the whole table.
-- ===========================================================================
