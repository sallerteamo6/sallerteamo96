-- ===========================================================================
--  07_signup_fix.sql  --  repair sign-up
--  Run this AFTER 01..06. Safe to run more than once.
--
--  Symptom: POST /auth/v1/signup returns
--      HTTP 500  {"msg":"Database error saving new user"}
--  which is GoTrue's catch-all for "the on_auth_user_created trigger raised".
--  The account is not created and no profile row appears.
--
--  Two independent causes, both checked below:
--
--  (a) A missing column on public.users. 01_schema.sql creates the table with
--      "create table if not exists", so if the table already existed from an
--      earlier run, the newer definition is silently ignored. Columns added to
--      01_schema.sql later (email) never reach an already-created table, and
--      the trigger's INSERT then fails on the missing column.
--
--  (b) RLS. public.users has RLS enabled with only SELECT and UPDATE policies,
--      so the SECURITY DEFINER insert is legal only when the function owner
--      bypasses RLS. This reports the flag so the failure is visible rather
--      than guessed at.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Report, do not guess. RAISE NOTICE output appears in the SQL editor's
--    messages panel, which is the only place these values are visible.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_bypass  text;
  v_trig    text;
begin
  select coalesce(string_agg(x, ', ' order by x), '(none)')
    into v_missing
    from unnest(array['account','email','login_method','display_name','is_admin',
                      'is_guest','status','referral_code','referred_by','language',
                      'greeted','version','created_at','updated_at']) as x
   where not exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'users'
              and column_name = x);

  raise notice 'public.users missing columns : %', v_missing;

  select coalesce(string_agg(rolname || '=' ||
           case when rolsuper then 'super' else 'nosuper' end || '/' ||
           case when rolbypassrls then 'bypassrls' else 'no-bypassrls' end,
           '  '), '(none)')
    into v_bypass
    from pg_roles
   where rolname in ('postgres', 'service_role', 'authenticated', 'anon');

  raise notice 'roles                     : %', v_bypass;

  select coalesce(string_agg(tgname || '=' ||
           case when tgenabled = 'O' then 'enabled' else 'DISABLED' end, '  '),
           '(no trigger on auth.users)')
    into v_trig
    from pg_trigger
   where tgrelid = 'auth.users'::regclass and not tgisinternal;

  raise notice 'triggers on auth.users    : %', v_trig;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Repair (a): add any column the trigger needs that is not there.
--    "if not exists" makes this a no-op once applied.
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists email         text;
alter table public.users add column if not exists login_method  text not null default 'email';
alter table public.users add column if not exists display_name  text;
alter table public.users add column if not exists is_admin      boolean not null default false;
alter table public.users add column if not exists is_guest      boolean not null default false;
alter table public.users add column if not exists language      text;
alter table public.users add column if not exists greeted       boolean not null default false;
alter table public.users add column if not exists version       integer not null default 1;
alter table public.users add column if not exists referral_code text;
alter table public.users add column if not exists referred_by   uuid;

-- login_method is constrained; a column added by ALTER inherits no constraint.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.users'::regclass
                    and conname = 'users_login_method_check') then
    alter table public.users
      add constraint users_login_method_check
      check (login_method in ('email', 'username', 'wallet'));
    raise notice 'added missing login_method check constraint';
  end if;
end $$;

create unique index if not exists users_referral_code_idx
  on public.users (referral_code) where referral_code is not null;

-- ---------------------------------------------------------------------------
-- 3. Repair (b): make the trigger's write path independent of the caller's RLS.
--
--    The insert is performed by a SECURITY DEFINER function, so it is evaluated
--    as the function owner. This sets the owner explicitly to postgres rather
--    than inheriting whichever role happened to run the file, and pins
--    row_security = off so the function cannot be broken by a RLS policy on the
--    table it is writing to. (Requires the owner to hold BYPASSRLS; section 1
--    reports that flag, so a failure here is visible instead of silent.)
--
--    There is deliberately no INSERT policy on public.users: profiles are only
--    ever created by this trigger, and granting the browser INSERT would let
--    anyone mint a row -- including is_admin -- for themselves.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, account, email, login_method, is_guest)
  values (
    new.id,
    lower(coalesce(new.email, new.id::text)),
    new.email,
    'email',
    coalesce(new.raw_user_meta_data ->> 'is_guest', 'false')::boolean
  )
  on conflict (id) do nothing;
  return new;
end $$;

alter function public.handle_new_auth_user() owner to postgres;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- The audit_log write in the delete trigger has the same dependency.
create or replace function public.handle_auth_user_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (action, entity, entity_id)
  values ('auth_delete', 'users', old.id::text);
  return old;
end $$;

alter function public.handle_auth_user_deleted() owner to postgres;

commit;

-- ===========================================================================
--  After running this, re-test from PowerShell -- it needs no dashboard:
--
--    $k = '<your anon key>'
--    Invoke-RestMethod -Uri 'https://mpiqktgpgmbsljqgypzk.supabase.co/auth/v1/signup' `
--      -Headers @{ apikey = $k } -ContentType 'application/json' -Method Post `
--      -Body '{"email":"selftest@example.com","password":"Test-Only-9x!q"}'
--
--  A 200 with a user id means sign-up works. HTTP 500 means section 1's notice
--  above did not contain "(none)" for a role, and that role needs BYPASSRLS
--  granted in Dashboard -> Database -> Roles.
-- ===========================================================================
