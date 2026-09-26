-- ===========================================================================
--  10_phone_auth.sql
--  Adds phone-number sign-in to the auth trigger.
--
--  Run this AFTER 06_auth.sql. Safe to run more than once.
--
--  Why it is needed
--  ---------------
--  06_auth.sql hardcoded two email assumptions:
--
--    1. account := lower(coalesce(new.email, new.id::text))
--       For a phone signup new.email is NULL, so the profile's account became
--       the raw UUID. The user could never look their own account up, and the
--       sign-in form had nothing meaningful to match on.
--
--    2. login_method := 'email'
--       Always wrote 'email' regardless of how the account was created, so
--       phone accounts were mislabelled in the admin panel and in any policy
--       or report that branches on login_method.
--
--  GoTrue stores phone numbers in E.164 form (+14155550100) and the Phone
--  provider rejects anything else, so new.phone is already normalised by the
--  time this trigger runs. The database must not reformat it, or the profile
--  would stop matching the auth identity.
--
--  Enabling the provider itself
--  ----------------------------
--  This file only teaches the database about phone accounts. Actually sending
--  an SMS is a dashboard setting and cannot be done from SQL:
--
--    Dashboard -> Authentication -> Providers -> Phone
--      -> enable "Phone"
--      -> set "Confirm phone" ON while testing
--
--  Then configure an SMS provider, or every phone signup fails with
--  "Phone logins are not enabled":
--
--    Dashboard -> Authentication -> SMS Provider
--      -> Twilio (or MessageBird)
--      -> Account SID / Auth Token  (from your Twilio console)
--      -> Messaging Service SID, or a Twilio number you have bought
--      -> Test Phone -> your own number, then "Send test SMS"
--
--  A Twilio trial account only sends to numbers you have verified, so use
--  your own phone for the first test.
-- ===========================================================================


begin;

-- ---------------------------------------------------------------------------
-- Profile creation for both identity kinds.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_account  text;
  v_email    text;
  v_phone    text;
  v_method   text;
begin
  -- Exactly one of these is set; GoTrue will not create an identity with both
  -- or with neither. Email wins if both somehow appear, matching the order the
  -- client sends them in.
  if new.email is not null and btrim(new.email) <> '' then
    v_account := lower(btrim(new.email));
    v_email   := lower(btrim(new.email));
    v_phone   := null;
    v_method  := 'email';
  else
    -- Keep GoTrue's own E.164 string verbatim. Only trim surrounding blanks.
    v_phone   := btrim(new.phone);
    v_account := v_phone;
    v_email   := null;
    v_method  := 'phone';
  end if;

  -- An identity with neither is malformed; refuse it rather than create a
  -- profile keyed on an empty string that nothing can ever sign in with.
  if v_account is null or v_account = '' then
    raise exception 'auth user % has neither an email nor a phone', new.id
      using errcode = '22023';
  end if;

  insert into public.users (id, account, email, phone, login_method, is_guest)
  values (
    new.id,
    v_account,
    v_email,
    v_phone,
    v_method,
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
-- The phone column the trigger now writes to.
--
-- 01_schema.sql does not define users.phone -- it was only ever intended for
-- verifications. Without this the trigger above fails on the column and every
-- signup breaks, including email signups, so the column is created here if it
-- is missing. IF NOT EXISTS keeps it harmless on a database that already has
-- it.
--
-- account stays the lookup key for both kinds, so it now needs a uniqueness
-- guarantee that did not matter when every account was an email address. The
-- partial/unique index below is created only when the data allows it; if other
-- rows already collide it is skipped rather than aborting the whole migration,
-- and the DO block says so in a message.
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists phone text;

comment on column public.users.phone is
  'E.164 phone number, set when login_method = ''phone''. Null for email accounts.';

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.users'::regclass and contype = 'u'
       and conkey = array[(select attnum from pg_attribute
                            where attrelid = 'public.users'::regclass
                              and attname = 'account')]::smallint[]
  ) then
    raise notice 'users.account is already unique; leaving it alone';
  elsif exists (select 1 from public.users group by account having count(*) > 1) then
    raise warning 'duplicate values exist in users.account, so no unique index was created. Resolve them before relying on account uniqueness.';
  else
    create unique index users_account_key on public.users (account);
    raise notice 'created unique index users_account_key';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- Verify. This is the LAST statement, so its row is what the grid shows.
-- Expected: login_method = phone for the phone row, email for the email row,
-- and profile_key populated in both cases.
-- ---------------------------------------------------------------------------
select
  'phone'::text                 as expected_login_method,
  login_method,
  account                       as profile_key,
  email,
  phone,
  (email is null)               as email_is_null,
  (phone is not null)           as phone_is_set,
  case
    when login_method = 'phone' and account = phone and email is null then 'correct'
    when login_method = 'email' and account = email then 'correct'
    else 'unexpected'
  end                           as verdict
from public.users
order by created_at desc
limit 5;


-- ===========================================================================
--  After running this
--  -----------------
--  1. Enable the Phone provider and an SMS provider in the dashboard (above).
--     Until then phone sign-in returns "Phone logins are not enabled" and
--     email sign-in continues to work normally.
--
--  2. Phone numbers must include a country code, for example +14155550100.
--     The app rejects a bare local number rather than guessing the region.
--
--  3. Existing email accounts are untouched. accounts created before this file
--     ran keep login_method = 'email' and a null phone, which is correct.
-- ===========================================================================
