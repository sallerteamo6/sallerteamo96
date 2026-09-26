-- ===========================================================================
-- 11_uid_code.sql -- 6-digit public member number
--
-- Every account gets a stable 6-digit number assigned at signup, in addition
-- to the uuid primary key. The uuid is the internal identity and is never shown
-- to a user; the 6-digit number is the handle people read out to support and
-- appear next to the email on admin screens.
--
-- Stored as text, not integer, so it is always exactly six characters and can
-- never be rendered as "1234" or "0000123" by a formatter. Zero is a legal
-- value (000042), which an integer column would also allow but a numeric type
-- makes far easier to get wrong in JavaScript.
--
-- Idempotent: safe to run more than once.
-- ===========================================================================

alter table public.users add column if not exists uid_code text;

comment on column public.users.uid_code is
  'Six-digit public member number, assigned on insert. Display handle only; the uuid id remains the identity.';

-- Partial: the column is nullable so this migration can be applied to a table
-- that already has rows without a second pass failing on NULLs.
create unique index if not exists users_uid_code_unique
  on public.users (uid_code) where uid_code is not null;

-- ---------------------------------------------------------------------------
--  Allocator. Retries on the (rare) collision instead of failing the signup.
--  1,000,000 candidates and a user base in the hundreds means a clash is very
--  unlikely, but "unlikely" is not "impossible" and a duplicate would abort the
--  insert trigger and lose the account.
-- ---------------------------------------------------------------------------
create or replace function public.next_uid_code() returns text
language plpgsql set search_path = public as $$
declare
  candidate text;
  tries     integer := 0;
begin
  loop
    -- random() is in pg_catalog, which is always implicitly on the search path,
    -- so it resolves even with search_path pinned to public.
    candidate := lpad(floor(random() * 1000000)::integer::text, 6, '0');
    tries := tries + 1;

    exit when not exists (select 1 from public.users where uid_code = candidate);
    -- Exhausted the search: fail loudly rather than return a duplicate and let
    -- the unique index produce a confusing error at signup time.
    if tries > 1000 then
      raise exception 'could not allocate a unique uid_code after % attempts', tries;
    end if;
  end loop;

  return candidate;
end $$;

-- ---------------------------------------------------------------------------
--  Backfill for accounts created before this column existed. Assigned in id
--  order so the numbers are stable across re-runs.
-- ---------------------------------------------------------------------------
do $$
declare
  r      record;
  n      text;
  tries  integer;
begin
  for r in select id from public.users where uid_code is null order by id loop
    tries := 0;
    loop
      n := public.next_uid_code();
      tries := tries + 1;
      exit when tries > 1000;
    end loop;
    update public.users set uid_code = n where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  Assign on insert. prepare_user() is a BEFORE INSERT trigger on public.users,
--  so the number exists by the time the row lands and the client never has to
--  supply one (a client-supplied value would also be a collision oracle).
-- ---------------------------------------------------------------------------
create or replace function public.prepare_user() returns trigger
language plpgsql set search_path = public as $$
begin
  new.account := lower(trim(new.account));

  if new.referral_code is null then
    -- gen_random_uuid() is built into pg_catalog on PostgreSQL 13+. The
    -- obvious gen_random_bytes() lives in pgcrypto, which Supabase installs
    -- into the `extensions` schema -- not `public`. This trigger is reached
    -- through a SECURITY DEFINER function pinned to search_path = public, so
    -- the pgcrypto call could not be resolved and every sign-up failed with
    -- "Database error saving new user". The uuid needs no extension at all.
    new.referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  end if;

  if new.uid_code is null then
    new.uid_code := public.next_uid_code();
  end if;

  return new;
end $$;

drop trigger if exists users_prepare on public.users;
create trigger users_prepare before insert on public.users
  for each row execute function public.prepare_user();
