-- ===========================================================================
--  Functions / RPCs for backend v2
-- ===========================================================================
--  Every path that moves money or changes a protected status goes through one
--  of these, inside a single transaction, with a ledger row and an audit row
--  written alongside. v1 let the browser settle its own contracts and adjust
--  its own balance, which is why "balance edit" and "admin adjustment" ended
--  up as the same code path.
--
--  There is no login function here on purpose: authentication is GoTrue's job
--  (supabase.auth.signInWithPassword), which signs a JWT the client cannot
--  forge. Every function below identifies the caller with auth.uid().
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Ledger posting. Internal: execute is revoked from every role, so the only
-- way to move money is through the vetted wrappers further down.
-- ---------------------------------------------------------------------------
create or replace function public.post_ledger(
  p_uid       uuid,
  p_coin      text,
  p_delta     numeric,
  p_reason    txn_type,
  p_ref_table text default null,
  p_ref_id    text default null,
  p_note      text default null
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_balance numeric(24,8);
begin
  insert into public.balances (uid, coin, amount)
  values (p_uid, p_coin, 0)
  on conflict (uid, coin) do nothing;

  -- Serialise every movement for this (uid, coin). Without this row lock two
  -- concurrent settlements interleave their read-modify-write and one update
  -- is lost.
  select amount into v_balance
  from public.balances
  where uid = p_uid and coin = p_coin
  for update;

  if v_balance + p_delta < 0 then
    raise exception 'insufficient % balance: available %, required %',
      p_coin, v_balance, abs(p_delta)
      using errcode = 'P0001';
  end if;

  update public.balances
     set amount = amount + p_delta
   where uid = p_uid and coin = p_coin;

  insert into public.ledger_entries
    (uid, coin, delta, balance_after, reason, ref_table, ref_id, note, created_by)
  values
    (p_uid, p_coin, p_delta, v_balance + p_delta, p_reason, p_ref_table, p_ref_id,
     p_note, auth.uid());

  return v_balance + p_delta;
end $$;

revoke all on function public.post_ledger from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Contract open / settle
-- ---------------------------------------------------------------------------

-- Opens a binary-options contract.
--
-- The payout multiplier is READ from product_durations rather than accepted
-- from the caller: a crafted request cannot promise itself a 10x payout, which
-- is exactly the bug a client-supplied multiplier invites.
create or replace function public.open_contract(
  p_product_id   integer,
  p_coin         text,
  p_side         text,
  p_amount       numeric,
  p_duration_sec integer,
  p_entry_price  numeric
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_payout   numeric(6,2);
  v_min      numeric(24,8);
  v_contract uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if (select status from public.users where id = v_uid) <> 'active' then
    raise exception 'account is not active' using errcode = '42501';
  end if;
  if p_side not in ('up', 'down') then
    raise exception 'side must be up or down' using errcode = '22023';
  end if;
  if p_entry_price is null or p_entry_price <= 0 then
    raise exception 'entry price unavailable' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;

  select pd.payout_pct, p.min_amount
    into v_payout, v_min
  from public.product_durations pd
  join public.products p on p.id = pd.product_id
  where pd.product_id = p_product_id
    and pd.seconds = p_duration_sec
    and pd.is_active and p.is_active;

  if v_payout is null then
    raise exception 'unknown product or duration' using errcode = '22023';
  end if;
  if p_amount < v_min then
    raise exception 'minimum amount is %', v_min using errcode = '22023';
  end if;

  -- The contract is inserted before the stake is debited so the ledger row can
  -- carry its real id. The original order debited with ref_id = null and then
  -- searched for the row with `created_at >= now() - interval '1 minute'`, which
  -- attaches the id to the wrong row whenever a user opens two contracts inside
  -- the same minute.
  --
  -- Ordering is safe because the whole function body is one transaction: if the
  -- debit then fails on an insufficient balance, the raise rolls the contract
  -- insert back with it, and if the insert failed the debit never ran.
  insert into public.contracts
    (uid, product_id, coin, side, amount, duration_sec, payout_pct, entry_price, expires_at)
  values
    (v_uid, p_product_id, p_coin, p_side, p_amount, p_duration_sec, v_payout,
     p_entry_price, now() + make_interval(secs => p_duration_sec))
  returning id into v_contract;

  perform public.post_ledger(v_uid, p_coin, -p_amount, 'trade', 'contracts',
                             v_contract::text, 'contract stake');

  return v_contract;
end $$;

-- Settles one contract against an observed exit price.
--
-- Idempotent by construction: the row is locked, and a contract that is no
-- longer 'open' returns its stored result without paying again. A double
-- submit, or a retry after a timeout, cannot double-credit a user.
create or replace function public.settle_contract(
  p_contract_id  uuid,
  p_settle_price numeric
) returns public.contracts
language plpgsql security definer set search_path = public as $$
declare
  v        public.contracts;
  v_won    boolean;
  v_payout numeric(24,8) := 0;
begin
  if p_settle_price is null or p_settle_price <= 0 then
    raise exception 'settle price unavailable' using errcode = '22023';
  end if;

  select * into v from public.contracts where id = p_contract_id for update;

  if not found then
    raise exception 'unknown contract' using errcode = 'P0002';
  end if;
  if v.status <> 'open' then
    return v;   -- already settled: return the stored result, pay nothing
  end if;
  if now() < v.expires_at then
    raise exception 'contract has not expired yet' using errcode = '22023';
  end if;

  v_won := (v.side = 'up'   and p_settle_price > v.entry_price)
        or (v.side = 'down' and p_settle_price < v.entry_price);

  if v_won then
    v_payout := round(v.amount * (1 + v.payout_pct / 100), 8);
  end if;

  update public.contracts
     set status      = case when v_won then 'won' else 'lost' end,
         settle_price = p_settle_price,
         payout       = v_payout,
         settled_at   = now(),
         settled_by   = auth.uid()
   where id = p_contract_id
  returning * into v;

  if v_payout > 0 then
    perform public.post_ledger(v.uid, v.coin, v_payout, 'trade', 'contracts',
                               v.id::text, 'contract payout');
  end if;

  return v;
end $$;

-- Sweeps every expired contract using the supplied prices.
-- p_prices: {"<product_id>": 64000.5}. service_role only: this is the price
-- feed's job, and a client must not be able to declare the market price that
-- decides who wins.
create or replace function public.settle_expired(p_prices jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare
  c       record;
  v_price numeric;
  v_n     integer := 0;
begin
  for c in
    select ct.id, ct.product_id
    from public.contracts ct
    where ct.status = 'open' and ct.expires_at <= now()
  loop
    v_price := (p_prices ->> c.product_id::text)::numeric;
    if v_price is not null then
      perform public.settle_contract(c.id, v_price);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- Cancels a contract the user opened, refunding the stake. Only allowed before
-- it settles, and only once: the status guard makes a repeat call a no-op.
create or replace function public.cancel_contract(p_contract_id uuid) returns public.contracts
language plpgsql security definer set search_path = public as $$
declare
  v public.contracts;
begin
  select * into v from public.contracts where id = p_contract_id for update;

  if not found then
    raise exception 'unknown contract' using errcode = 'P0002';
  end if;
  if v.uid <> auth.uid() then
    raise exception 'not your contract' using errcode = '42501';
  end if;
  if v.status <> 'open' then
    return v;
  end if;

  update public.contracts
     set status = 'void', settled_at = now(), settled_by = auth.uid(), payout = v.amount
   where id = p_contract_id
  returning * into v;

  perform public.post_ledger(v.uid, v.coin, v.amount, 'trade', 'contracts',
                             v.id::text, 'contract cancelled, stake refunded');

  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Admin: balance adjustment. The operation that must always be traceable.
-- ---------------------------------------------------------------------------
create or replace function public.admin_adjust_balance(
  p_uid   uuid,
  p_coin  text,
  p_delta numeric,
  p_note  text
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_new numeric;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'delta must be non-zero' using errcode = '22023';
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'a written reason is required for every adjustment'
      using errcode = '22023';
  end if;

  v_new := public.post_ledger(p_uid, p_coin, p_delta, 'adjustment', 'admin', null, p_note);

  insert into public.audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'adjust_balance', 'balances', p_uid::text || ':' || p_coin,
          jsonb_build_object('delta', p_delta, 'balance_after', v_new, 'note', p_note));

  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- Admin: review queues
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_transaction_status(
  p_txn_id bigint,
  p_status txn_status,
  p_note   text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_txn public.transactions;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select * into v_txn from public.transactions where id = p_txn_id for update;
  if not found then
    raise exception 'unknown transaction' using errcode = 'P0002';
  end if;
  if v_txn.status <> 'pending' then
    raise exception 'transaction is already %', v_txn.status using errcode = '22023';
  end if;

  -- Crediting inside the same transaction as the status change: if the process
  -- dies between the two, neither happens, rather than the deposit being
  -- approved with no credit or credited with no approval.
  if p_status = 'approved' then
    if v_txn.type = 'deposit' then
      perform public.post_ledger(v_txn.uid, v_txn.coin,  v_txn.amount, 'deposit',
                                 'transactions', v_txn.id::text, p_note);
    elsif v_txn.type = 'withdrawal' then
      perform public.post_ledger(v_txn.uid, v_txn.coin, -v_txn.amount, 'withdrawal',
                                 'transactions', v_txn.id::text, p_note);
    end if;
  end if;

  update public.transactions
     set status      = p_status,
         note        = coalesce(p_note, note),
         reviewed_by = auth.uid(),
         reviewed_at = now()
   where id = p_txn_id;

  insert into public.audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'txn_' || p_status::text, 'transactions', p_txn_id::text,
          jsonb_build_object('status', v_txn.status),
          jsonb_build_object('status', p_status));
end $$;

create or replace function public.admin_set_loan_status(
  p_loan_id  bigint,
  p_status   loan_status,
  p_note     text  default null,
  -- Terms are set at approval, not by the applicant: the insert trigger in
  -- 02_rls.sql pins a non-admin's interest to 0, so without this parameter
  -- every loan would be interest-free.
  p_interest numeric default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_loan     public.loans;
  v_interest numeric(24,8);
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select * into v_loan from public.loans where id = p_loan_id for update;
  if not found then
    raise exception 'unknown loan' using errcode = 'P0002';
  end if;

  if p_status = 'approved' and v_loan.status <> 'pending' then
    raise exception 'loan is % and cannot be approved', v_loan.status
      using errcode = '22023';
  end if;
  if p_status = 'repaid' and v_loan.status <> 'approved' then
    raise exception 'only an approved loan can be repaid, this one is %', v_loan.status
      using errcode = '22023';
  end if;

  -- Lock the terms in at approval so the figure the operator approved is the
  -- figure the repayment debits, and it cannot move afterwards.
  v_interest := case when p_status = 'approved'
                     then coalesce(p_interest, v_loan.interest)
                     else v_loan.interest end;
  if v_interest < 0 then
    raise exception 'interest cannot be negative' using errcode = '22023';
  end if;

  if p_status = 'approved' and v_loan.status = 'pending' then
    perform public.post_ledger(v_loan.uid, 'USDT', v_loan.principal, 'loan',
                               'loans', v_loan.id::text, 'loan disbursed');
  elsif p_status = 'repaid' and v_loan.status = 'approved' then
    perform public.post_ledger(v_loan.uid, 'USDT', -(v_loan.principal + v_interest),
                               'loan', 'loans', v_loan.id::text, 'loan repaid');
  end if;

  update public.loans
     set status      = p_status,
         note        = p_note,
         interest    = v_interest,
         approved_by = case when p_status = 'approved' then auth.uid() else approved_by end,
         approved_at = case when p_status = 'approved' then now()   else approved_at end,
         repaid_at   = case when p_status = 'repaid'   then now()   else repaid_at   end
   where id = p_loan_id;

  insert into public.audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'loan_' || p_status::text, 'loans', p_loan_id::text,
          jsonb_build_object('status', v_loan.status, 'interest', v_loan.interest),
          jsonb_build_object('status', p_status, 'interest', v_interest));
end $$;

-- Admin KYC decision. The trigger in 02_rls.sql stamps reviewed_by/_at.
create or replace function public.admin_review_verification(
  p_uid    uuid,
  p_status kyc_status,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_status = 'rejected' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required when rejecting' using errcode = '22023';
  end if;

  update public.verifications
     set status = p_status, rejection_reason = p_reason
   where uid = p_uid;

  if not found then
    raise exception 'no verification on file for that user' using errcode = 'P0002';
  end if;

  insert into public.audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'kyc_' || p_status::text, 'verifications', p_uid::text,
          jsonb_build_object('status', p_status, 'reason', p_reason));
end $$;

-- Suspend or reinstate an account. Banning is deliberately absent: a ban that
-- only sets a status is reversible by the same admin code, so use status and
-- record the reason.
create or replace function public.admin_set_user_status(
  p_uid    uuid,
  p_status user_status,
  p_note    text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  update public.users set status = p_status where id = p_uid;
  if not found then
    raise exception 'unknown user' using errcode = 'P0002';
  end if;

  insert into public.audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'user_' || p_status::text, 'users', p_uid::text,
          jsonb_build_object('status', p_status, 'note', p_note));
end $$;

-- ---------------------------------------------------------------------------
-- AI Quant investments
--
-- v1 created ai_orders with a direct client INSERT. v2 has no INSERT policy on
-- investments, deliberately, because the principal is debited from the balance
-- and the rate must come from the product table rather than the request. So the
-- money path and the row creation have to happen together, which is what this
-- function is for.
-- ---------------------------------------------------------------------------

-- Opens an investment. The rate is drawn here, server-side, from the product's
-- own min/max band: accepting p_rate from the caller would let a crafted request
-- pick the top of the band every time.
create or replace function public.open_investment(
  p_product_code text,
  p_principal    numeric,
  p_coin         text default 'USDT'
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_prod   public.investment_products;
  v_rate   numeric(6,2);
  v_id     bigint;
  v_sched  jsonb;
  v_day    integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if (select status from public.users where id = v_uid) <> 'active' then
    raise exception 'account is not active' using errcode = '42501';
  end if;
  if p_principal is null or p_principal <= 0 then
    raise exception 'principal must be positive' using errcode = '22023';
  end if;

  select * into v_prod from public.investment_products
   where code = p_product_code and is_active;
  if not found then
    raise exception 'unknown investment product %', p_product_code using errcode = '22023';
  end if;

  -- Draw the rate in the band. Two decimal places, matching numeric(6,2).
  v_rate := round(v_prod.rate_min + random() * (v_prod.rate_max - v_prod.rate_min), 2);

  -- Precompute the daily schedule so the front end can draw a progress bar
  -- without re-deriving the maths, and so every run of the same product shows
  -- the same amounts.
  v_sched := '[]'::jsonb;
  for v_day in 1..v_prod.period_days loop
    v_sched := v_sched || jsonb_build_object(
      'day',     v_day,
      'rate',    v_rate,
      'profit',  round(p_principal * v_rate / 100, 8),
      'due_at',  (now() + make_interval(days => v_day))::text
    );
  end loop;

  insert into public.investments
    (uid, product_id, principal, rate, period_days, start_at, end_at, schedules)
  values
    (v_uid, v_prod.id, p_principal, v_rate, v_prod.period_days, now(),
     now() + make_interval(days => v_prod.period_days), v_sched)
  returning id into v_id;

  perform public.post_ledger(v_uid, p_coin, -p_principal, 'adjustment', 'investments',
                             v_id::text, 'investment principal: ' || p_product_code);

  return v_id;
end $$;

-- Advances the settled-day counter. Idempotent per day and never past the term.
create or replace function public.update_investment_progress(
  p_investment_id bigint,
  p_settled_days  integer
) returns public.investments
language plpgsql security definer set search_path = public as $$
declare
  v public.investments;
begin
  select * into v from public.investments where id = p_investment_id for update;
  if not found then
    raise exception 'unknown investment' using errcode = 'P0002';
  end if;
  if not (public.is_admin() or v.uid = auth.uid()) then
    raise exception 'not your investment' using errcode = '42501';
  end if;
  if v.status <> 'active' then
    raise exception 'investment is %', v.status using errcode = '22023';
  end if;

  update public.investments
     set settled_days = greatest(v.settled_days, p_settled_days)
   where id = p_investment_id
  returning * into v;
  return v;
end $$;

-- Pays out a matured investment. Idempotent: the status guard means a second
-- call returns the stored row and credits nothing.
create or replace function public.admin_settle_investment(
  p_investment_id bigint,
  p_note          text default null
) returns public.investments
language plpgsql security definer set search_path = public as $$
declare
  v         public.investments;
  v_profit  numeric(24,8);
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select * into v from public.investments where id = p_investment_id for update;
  if not found then
    raise exception 'unknown investment' using errcode = 'P0002';
  end if;
  if v.status <> 'active' then
    return v;   -- already settled
  end if;

  v_profit := round(v.principal * v.rate / 100, 8);

  update public.investments
     set status = 'matured', settled_days = v.period_days
   where id = p_investment_id
  returning * into v;

  perform public.post_ledger(v.uid, 'USDT', v.principal + v_profit, 'bonus',
                             'investments', v.id::text,
                             'investment matured: principal + profit');

  insert into public.audit_log (actor, action, entity, entity_id, after)
  values (auth.uid(), 'settle_investment', 'investments', p_investment_id::text,
          jsonb_build_object('principal', v.principal, 'profit', v_profit));

  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- The caller's balances. Defaults to self; an admin may pass a uid.
create or replace function public.get_balances(p_uid uuid default null)
returns table (coin text, amount numeric, locked_amount numeric, available numeric)
language sql stable security definer set search_path = public as $$
  select b.coin, b.amount, b.locked_amount, b.amount - b.locked_amount
  from public.balances b
  where b.uid = coalesce(p_uid, auth.uid())
    and (p_uid is null or public.owns_or_admin(p_uid));
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

-- Aggregate stats for the admin dashboard. service_role only.
create or replace function public.admin_stats() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'users',        (select count(*) from public.users),
    'new_users_24h',(select count(*) from public.users
                      where created_at > now() - interval '24 hours'),
    'open_contracts',(select count(*) from public.contracts where status = 'open'),
    'pending_deposits',(select count(*) from public.transactions
                         where type = 'deposit' and status = 'pending'),
    'pending_withdrawals',(select count(*) from public.transactions
                            where type = 'withdrawal' and status = 'pending'),
    'pending_kyc',  (select count(*) from public.verifications where status = 'pending'),
    'total_liabilities', (select coalesce(sum(amount), 0) from public.balances)
  );
end $$;

-- Expired sessions live in auth.sessions, owned by GoTrue. Deleting them is a
-- GoTrue concern; this is kept only for the audit trail of staff sign-outs.
create or replace function public.log_staff_signout() returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor, action, entity, entity_id)
  values (auth.uid(), 'signout', 'auth', coalesce(auth.uid()::text, 'unknown'));
end $$;

-- ===========================================================================
-- Client-callable surface.
-- ===========================================================================
--  post_ledger is deliberately absent: granting it would let any caller move
--  money directly, bypassing every check above. settle_expired is
--  service_role only, so a browser cannot decide the price that settles trades.

grant execute on function public.open_contract(integer, text, text, numeric, integer, numeric)
  to authenticated;
grant execute on function public.settle_contract(uuid, numeric) to service_role;
grant execute on function public.settle_expired(jsonb) to service_role;
grant execute on function public.cancel_contract(uuid) to authenticated;
grant execute on function public.open_investment(text, numeric, text) to authenticated;
grant execute on function public.update_investment_progress(bigint, integer) to authenticated;
grant execute on function public.admin_settle_investment(bigint, text) to authenticated;
grant execute on function public.admin_adjust_balance(uuid, text, numeric, text)
  to authenticated;
grant execute on function public.admin_set_transaction_status(bigint, txn_status, text)
  to authenticated;
grant execute on function public.admin_set_loan_status(bigint, loan_status, text, numeric)
  to authenticated;
grant execute on function public.admin_review_verification(uuid, kyc_status, text)
  to authenticated;
grant execute on function public.admin_set_user_status(uuid, user_status, text)
  to authenticated;
grant execute on function public.get_balances(uuid) to anon, authenticated;
grant execute on function public.admin_stats() to authenticated;
grant execute on function public.log_staff_signout() to authenticated;

commit;
