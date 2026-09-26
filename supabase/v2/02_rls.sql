-- ===========================================================================
--  Row level security for backend v2
-- ===========================================================================
--  v1 granted the anonymous key SELECT on app_meta, which held every user's
--  accounts, balances, KYC documents and chat as JSON blobs. Any visitor could
--  read every record on the platform. v2 has no world-readable business table.
--
--  Every policy is built on auth.uid(), which comes from a JWT signed by the
--  Supabase auth server. The client holds the anon key and cannot forge it.
--  See the header of 01_schema.sql for why a hand-rolled session table is not
--  viable in a static site.
--
--  Two roles are recognised:
--    * the owner      — auth.uid() = row.uid
--    * an admin       — public.is_admin(), sourced from public.users
--  Everything else is denied by default: Postgres has no access without a
--  matching policy, so forgetting a policy fails closed, not open.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The caller's verified user id, or NULL when unauthenticated.
create or replace function public.current_uid() returns uuid
language sql stable as $$
  select auth.uid();
$$;

-- Admin flag for the caller. SECURITY DEFINER so the lookup of public.users
-- does not itself re-enter the users policy (which would recurse).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select u.is_admin from public.users u where u.id = auth.uid()),
    false
  );
$$;

-- Owner-or-admin, the predicate almost every policy needs.
create or replace function public.owns_or_admin(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_uid = auth.uid() or public.is_admin();
$$;

grant execute on function public.current_uid() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.owns_or_admin(uuid) to anon, authenticated;

-- ===========================================================================
--  users
-- ===========================================================================
alter table public.users enable row level security;

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- The profile is created by the auth trigger in 06_auth.sql, not by the
-- client: allowing client INSERT would let anyone mint a profile row with
-- is_admin = true for an arbitrary id.
drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- No INSERT and no DELETE policy. Accounts are created by GoTrue and
-- deactivated, never deleted, so ledger rows keep valid references.

-- Privilege-escalation guard. "id = auth.uid()" permits the row but not the
-- column, so without this a user could set is_admin = true on their own row.
create or replace function public.guard_user_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
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

-- ===========================================================================
--  balances / ledger — read own, or all for admin. NO write policy: money
--  moves only through the functions in 03_functions.sql, which are the
--  audited and transactional path.
-- ===========================================================================
alter table public.balances enable row level security;
alter table public.ledger_entries enable row level security;

drop policy if exists balances_select_own on public.balances;
create policy balances_select_own on public.balances for select to authenticated
  using (public.owns_or_admin(uid));

drop policy if exists ledger_select_own on public.ledger_entries;
create policy ledger_select_own on public.ledger_entries for select to authenticated
  using (public.owns_or_admin(uid));

-- ===========================================================================
--  coin_addresses — public read (the deposit page works signed out), admin
--  write.
-- ===========================================================================
alter table public.coin_addresses enable row level security;

drop policy if exists coin_addresses_public_read on public.coin_addresses;
create policy coin_addresses_public_read on public.coin_addresses for select to anon, authenticated
  using (true);

drop policy if exists coin_addresses_admin_write on public.coin_addresses;
create policy coin_addresses_admin_write on public.coin_addresses for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===========================================================================
--  products — public read, admin write.
-- ===========================================================================
alter table public.products enable row level security;
alter table public.product_durations enable row level security;

drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products for select to anon, authenticated
  using (true);

drop policy if exists product_durations_public_read on public.product_durations;
create policy product_durations_public_read on public.product_durations for select to anon, authenticated
  using (true);

drop policy if exists products_admin_write on public.products;
create policy products_admin_write on public.products for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists product_durations_admin_write on public.product_durations;
create policy product_durations_admin_write on public.product_durations for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===========================================================================
--  transactions — own rows, or all for admin. A user may file a deposit or
--  withdrawal but only ever as 'pending'; approval is an admin action and the
--  trigger below refuses any other status transition from a non-admin.
-- ===========================================================================
alter table public.transactions enable row level security;

drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own on public.transactions for select to authenticated
  using (public.owns_or_admin(uid));

drop policy if exists transactions_insert_own on public.transactions;
create policy transactions_insert_own on public.transactions for insert to authenticated
  with check (uid = auth.uid() and status = 'pending' and reviewed_by is null
              and reviewed_at is null);

-- Lets a user cancel their own pending request, and nothing else: the USING
-- clause requires the old row to be pending and owned, the WITH CHECK requires
-- the new row to still be pending and owned, so amount/type cannot be changed
-- while pending either.
drop policy if exists transactions_update_own on public.transactions;
create policy transactions_update_own on public.transactions for update to authenticated
  using (uid = auth.uid() and status = 'pending')
  with check (uid = auth.uid() and status = 'pending'
              and reviewed_by is null and reviewed_at is null);

create or replace function public.guard_transaction_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.amount is distinct from old.amount
     or new.type is distinct from old.type
     or new.uid is distinct from old.uid then
    raise exception 'only an admin may review or alter a transaction'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists transactions_guard_review on public.transactions;
create trigger transactions_guard_review before update on public.transactions
  for each row execute function public.guard_transaction_review();

-- ===========================================================================
--  contracts
-- ===========================================================================
alter table public.contracts enable row level security;

drop policy if exists contracts_select_own on public.contracts;
create policy contracts_select_own on public.contracts for select to authenticated
  using (public.owns_or_admin(uid));

-- No INSERT policy: a contract is opened through public.open_contract(), which
-- validates the payout multiplier server-side and debits the balance inside
-- one transaction.

-- ===========================================================================
--  investments / loans
-- ===========================================================================
alter table public.investments enable row level security;
alter table public.investment_products enable row level security;
alter table public.loans enable row level security;

drop policy if exists investment_products_public_read on public.investment_products;
create policy investment_products_public_read on public.investment_products for select to anon, authenticated
  using (true);

drop policy if exists investment_products_admin_write on public.investment_products;
create policy investment_products_admin_write on public.investment_products for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists investments_select_own on public.investments;
create policy investments_select_own on public.investments for select to authenticated
  using (public.owns_or_admin(uid));

drop policy if exists loans_select_own on public.loans;
create policy loans_select_own on public.loans for select to authenticated
  using (public.owns_or_admin(uid));

drop policy if exists loans_insert_own on public.loans;
create policy loans_insert_own on public.loans for insert to authenticated
  with check (uid = auth.uid() and status = 'pending'
              and approved_by is null and approved_at is null);

create or replace function public.guard_loan_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at
     or new.repaid_at is distinct from old.repaid_at
     or new.principal is distinct from old.principal
     or new.uid is distinct from old.uid then
    raise exception 'only an admin may review or alter a loan' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists loans_guard_review on public.loans;
create trigger loans_guard_review before update on public.loans
  for each row execute function public.guard_loan_review();

-- The insert policy above constrains uid, status and the reviewer columns, but
-- not `interest`. admin_set_loan_status debits principal + interest on
-- repayment, so a client-chosen interest is money moving on the client's terms:
-- file a loan with interest = 0, get the principal credited on approval, and
-- never repay it. Pin both interest fields to zero for a non-admin applicant;
-- an operator sets the real terms at approval time.
create or replace function public.guard_loan_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    return new;
  end if;
  new.interest := 0;
  return new;
end $$;

drop trigger if exists loans_guard_insert on public.loans;
create trigger loans_guard_insert before insert on public.loans
  for each row execute function public.guard_loan_insert();

-- ===========================================================================
--  verifications (KYC) — the most sensitive table here. Documents readable
--  only by the owner and admins.
-- ===========================================================================
alter table public.verifications enable row level security;

drop policy if exists verifications_select_own on public.verifications;
create policy verifications_select_own on public.verifications for select to authenticated
  using (public.owns_or_admin(uid));

-- Filing a KYC application: must be your own, and must start pending with no
-- reviewer attached.
drop policy if exists verifications_insert_own on public.verifications;
create policy verifications_insert_own on public.verifications for insert to authenticated
  with check (uid = auth.uid() and status = 'pending'
              and reviewed_by is null and reviewed_at is null);

-- The owner may only add documents to an application that is still pending.
drop policy if exists verifications_update_own on public.verifications;
create policy verifications_update_own on public.verifications for update to authenticated
  using (uid = auth.uid() and status = 'pending')
  with check (uid = auth.uid() and status = 'pending'
              and reviewed_by is null and reviewed_at is null);

create or replace function public.guard_verification_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
    return new;
  end if;
  if new.status is distinct from old.status
     or new.reviewed_at is distinct from old.reviewed_at
     or new.reviewed_by is distinct from old.reviewed_by
     or new.advanced_status is distinct from old.advanced_status then
    raise exception 'only an admin may review a verification' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists verifications_guard_review on public.verifications;
create trigger verifications_guard_review before update on public.verifications
  for each row execute function public.guard_verification_review();

-- ===========================================================================
--  chat
-- ===========================================================================
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists chat_threads_select on public.chat_threads;
create policy chat_threads_select on public.chat_threads for select to authenticated
  using (public.owns_or_admin(uid));

drop policy if exists chat_threads_insert_own on public.chat_threads;
create policy chat_threads_insert_own on public.chat_threads for insert to authenticated
  with check (uid = auth.uid());

drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select on public.chat_messages for select to authenticated
  using (public.owns_or_admin(uid));

-- You may post into your own thread, as yourself.
drop policy if exists chat_messages_insert on public.chat_messages;
create policy chat_messages_insert on public.chat_messages for insert to authenticated
  with check (
    uid = auth.uid()
    and exists (select 1 from public.chat_threads t
                where t.id = chat_messages.thread_id and t.uid = auth.uid())
  );

-- Force from_role on insert. The insert policy above checks that the row is the
-- caller's own and sits in their own thread, but it does not constrain
-- from_role, and the client sends that field verbatim. Without this, any user
-- could post `from_role: 'admin'` and impersonate support in their own thread —
-- convincing another agent to wire them a withdrawal, or leaking an operator's
-- workflow back at a customer. The value is overwritten rather than rejected so
-- a tampered request still files as the user it came from.
create or replace function public.guard_chat_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    return new;
  end if;
  new.from_role := 'user';
  -- read_at is the reader's marker, never something a sender may set for
  -- themselves or, worse, clear on support's messages.
  if new.read_at is not null then
    raise exception 'read_at cannot be set on insert' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists chat_messages_guard_insert on public.chat_messages;
create trigger chat_messages_guard_insert before insert on public.chat_messages
  for each row execute function public.guard_chat_insert();

-- Editing history out from under support is not allowed: once an admin has
-- replied in the thread, the user's earlier messages become immutable.
create or replace function public.guard_chat_mutation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if exists (
    select 1 from public.chat_messages m
    where m.thread_id = old.thread_id
      and m.from_role = 'admin'
      and m.created_at < old.created_at
  ) then
    raise exception 'cannot modify a message after an admin reply'
      using errcode = '42501';
  end if;

  if new.from_role is distinct from old.from_role
     or new.uid is distinct from old.uid
     or new.thread_id is distinct from old.thread_id then
    raise exception 'cannot change message identity or role' using errcode = '42501';
  end if;

  new.edited := true;
  new.edited_at := now();
  return new;
end $$;

drop trigger if exists chat_messages_guard on public.chat_messages;
create trigger chat_messages_guard before update on public.chat_messages
  for each row execute function public.guard_chat_mutation();

-- ===========================================================================
--  app_settings — public read for the config pages need before sign-in.
-- ===========================================================================
alter table public.app_settings enable row level security;

drop policy if exists app_settings_public_read on public.app_settings;
create policy app_settings_public_read on public.app_settings for select to anon, authenticated
  using (true);

drop policy if exists app_settings_admin_write on public.app_settings;
create policy app_settings_admin_write on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===========================================================================
--  audit_log — admins read. No INSERT/UPDATE/DELETE policy is granted to any
--  client role, so rows are immutable from outside the SECURITY DEFINER
--  functions that write them.
-- ===========================================================================
alter table public.audit_log enable row level security;

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin on public.audit_log for select to authenticated
  using (public.is_admin());

-- ===========================================================================
--  Explicit per-operation grants.
-- ===========================================================================
--  RLS filters rows; GRANT decides whether the operation is possible at all.
--  Both are required, and a table with no grant is unreachable no matter what
--  the policies say.

-- anon: only the two genuinely public reads.
grant select on public.coin_addresses, public.products, public.product_durations,
                public.investment_products, public.app_settings to anon;

-- authenticated: everything the signed-in app legitimately touches.
grant select, update on public.users to authenticated;
grant select on public.balances, public.ledger_entries, public.contracts,
                public.investments to authenticated;
grant select, insert, update on public.transactions, public.loans,
                                 public.verifications to authenticated;
grant select, insert on public.chat_threads to authenticated;
grant select, insert, update on public.chat_messages to authenticated;
grant select, insert, update, delete on public.coin_addresses,
                                    public.products, public.product_durations,
                                    public.investment_products, public.app_settings
  to authenticated;
grant select on public.audit_log to authenticated;

-- Nothing above grants INSERT on balances, ledger_entries or contracts, and
-- nothing grants INSERT on users or audit_log. Those paths are functions only.

commit;
