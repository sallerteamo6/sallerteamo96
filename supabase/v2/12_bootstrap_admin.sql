-- ===========================================================================
-- 12_bootstrap_admin.sql -- grant the first real admin
--
-- WHY THIS IS NEEDED
-- ------------------
-- The shared "admin password" in app.js is a CLIENT-SIDE check. It hides the
-- lock overlay, but it writes nothing to the database and adds no claim to the
-- Supabase JWT. PostgREST therefore applies its normal row-level security:
--
--   create policy users_select_own on public.users for select to authenticated
--     using (id = auth.uid() or public.is_admin());
--
-- and public.is_admin() reads is_admin from the signed-in user's own row. So
-- an account without that flag reads back nothing from any protected table, and
-- every admin list looks empty. There is no way around this from the browser --
-- users_update_own lets you update your own row, but guard_user_privileges()
-- blocks a non-admin from changing is_admin. Bootstrap has to happen here.
--
-- ONCE THIS HAS RUN
-- -----------------
-- Sign in with that email on the admin pages. RLS grants full visibility, and
-- the lock will not even appear (the app detects is_admin in your profile).
-- From then on you can promote other accounts from Admin -> Users, because
-- guard_user_privileges() permits is_admin changes once you are an admin.
--
-- Idempotent: re-running does not demote anyone.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 -- see who exists. Run this first and read the output.
-- ---------------------------------------------------------------------------
select
  account,
  is_admin,
  status,
  created_at::date as joined,
  (select count(*) from public.balances b where b.uid = u.id) as balance_rows
from public.users u
order by created_at;

-- ---------------------------------------------------------------------------
-- STEP 2 -- promote your account.
--
-- Replace the email below with YOUR OWN, then run this. Do not run it as-is:
-- 'you@example.com' will not match any row and nothing will be promoted.
-- ---------------------------------------------------------------------------
update public.users
set is_admin = true
where lower(account) = lower('you@example.com');

-- Confirm it took. is_admin should read true for your account.
select account, is_admin from public.users where is_admin;

-- ---------------------------------------------------------------------------
-- Optional: promote every account that has never been given a flag, e.g. on a
-- fresh install where you are the only real user. Leave this commented unless
-- you are certain.
--
--   update public.users set is_admin = true
--    where is_admin = false
--      and created_at = (select min(created_at) from public.users);
-- ---------------------------------------------------------------------------
