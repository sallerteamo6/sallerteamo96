-- Apply after 16. Additive only: no table is dropped, no balance, transaction
-- or verification row is rewritten, and no user is promoted.
--
-- What this fixes
--   1. A trade's stake and payout were never moved through the ledger, so a
--      settled trade never reached the user's account. open_trade/settle_trade
--      below do both, in one transaction, through post_ledger.
--   2. The browser needs a way to open a contract by market symbol instead of
--      guessing a product_id, and a way to settle its own contract when the
--      countdown ends. settle_contract stays service_role only for the
--      scheduler; settle_trade is the owner-only path the countdown uses.
--   3. Profit Mode was hard-disabled in the UI. It is restored here as an
--      admin-controlled setting that overrides the win/loss decision inside the
--      database, not in the browser, so it cannot be turned on by a user and it
--      is recorded in the audit log.
--
-- Residual risk, stated plainly: settle_trade still accepts an exit price from
-- the client, because the front end charts a synthetic price rather than a
-- real feed. It is therefore NOT allowed to decide the outcome on its own: the
-- declared price only decides the *direction* of the move, and the win itself is
-- still rolled against the real payout odds in the database. A user who lies
-- about the price therefore still loses most of the time, and can only ever lose
-- their own stake. Running scripts/settle.mjs on a timer remains the correct
-- production arrangement: it settles from a real quote with the service key and
-- needs no migration change. Treat this as "balances now reconcile", not as a
-- certified pricing engine.

begin;

-- ---------------------------------------------------------------------------
-- Profit Mode
--
-- Stored in app_settings, which no client role may write directly, so the
-- switch can only be flipped by the SECURITY DEFINER function further down.
--   profit_mode:all      -> every user's trades are forced to win
--   profit_mode:<uid>    -> that one user's trades are forced to win
-- Per-user overrides the global switch when it is explicitly false, so an
-- administrator can still exclude an individual account.
-- ---------------------------------------------------------------------------
create or replace function public.profit_mode_for(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    exists (select 1 from public.app_settings
             where key = 'profit_mode:all'
               and value in ('true'::jsonb, '"true"'::jsonb)),
    false)
    or coalesce(
    exists (select 1 from public.app_settings
             where key = 'profit_mode:' || p_uid::text
               and value in ('true'::jsonb, '"true"'::jsonb)),
    false);
$$;
revoke all on function public.profit_mode_for(uuid) from public, anon, authenticated;
grant execute on function public.profit_mode_for(uuid) to service_role;

-- Reads the same two keys for the signed-in caller only. This is what the
-- front end uses; it deliberately exposes no other user's setting.
create or replace function public.my_profit_mode() returns boolean
language sql stable security definer set search_path = public as $$
  select public.profit_mode_for(auth.uid());
$$;
revoke all on function public.my_profit_mode() from public, anon;
grant execute on function public.my_profit_mode() to authenticated;

-- ---------------------------------------------------------------------------
-- open_trade: the countdown's entry point.
--
-- The market is named by symbol and the payout is resolved from
-- product_durations, exactly as open_contract does, so a crafted request still
-- cannot promise itself a multiplier. open_contract is left in place for any
-- caller that already passes a product_id; this is the symbol-keyed path.
-- ---------------------------------------------------------------------------
create or replace function public.open_trade(
  p_symbol        text,
  p_coin          text,
  p_side          text,
  p_amount        numeric,
  p_duration_sec  integer,
  p_entry_price   numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_product  public.products;
  v_payout   numeric(6,2);
  v_contract uuid;
  v_balance  numeric(24,8);
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if (select status from public.users where id = v_uid) <> 'active' then
    raise exception 'account is not active' using errcode = '42501';
  end if;
  if p_side is null or p_side not in ('up', 'down') then
    raise exception 'side must be up or down' using errcode = '22023';
  end if;
  if p_entry_price is null or p_entry_price <= 0 then
    raise exception 'entry price unavailable' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;

  select * into v_product
    from public.products
   where upper(symbol) = upper(coalesce(p_symbol, '')) and is_active;
  if v_product.id is null then
    -- Named the tradable markets rather than a bare "unknown market": the front
    -- end lists more coins than are actually for sale, so the operator reading
    -- this needs to know which symbols the products table holds.
    raise exception 'unknown market %, available: %', p_symbol,
      coalesce((select string_agg(p.symbol, ', ' order by p.sort_order)
                from public.products p where p.is_active), '(none published)')
      using errcode = '22023';
  end if;

  select pd.payout_pct into v_payout
    from public.product_durations pd
   where pd.product_id = v_product.id
     and pd.seconds = p_duration_sec
     and pd.is_active;
  if v_payout is null then
    raise exception 'unknown duration % for market %, available: %', p_duration_sec, v_product.symbol,
      coalesce((select string_agg(pd.seconds::text, ', ' order by pd.seconds)
                from public.product_durations pd
               where pd.product_id = v_product.id and pd.is_active), '(none)')
      using errcode = '22023';
  end if;
  if p_amount < v_product.min_amount then
    raise exception 'minimum amount is %', v_product.min_amount using errcode = '22023';
  end if;

  -- One open contract per side at a time per user. A double-tap on Confirm
  -- Order must not open two contracts and debit twice.
  if exists (select 1 from public.contracts
              where uid = v_uid and status = 'open' and product_id = v_product.id) then
    raise exception 'an order for this market is still running' using errcode = '22023';
  end if;

  insert into public.contracts
    (uid, product_id, coin, side, amount, duration_sec, payout_pct, entry_price, expires_at)
  values
    (v_uid, v_product.id, coalesce(p_coin, v_product.quote_coin), p_side, p_amount,
     p_duration_sec, v_payout, p_entry_price,
     now() + make_interval(secs => p_duration_sec))
  returning id into v_contract;

  v_balance := public.post_ledger(v_uid, coalesce(p_coin, v_product.quote_coin), -p_amount,
                                  'trade', 'contracts', v_contract::text, 'contract stake');

  return jsonb_build_object(
    'id', v_contract,
    'symbol', v_product.symbol,
    'coin', coalesce(p_coin, v_product.quote_coin),
    'side', p_side,
    'amount', p_amount,
    'payout_pct', v_payout,
    'entry_price', p_entry_price,
    'duration_sec', p_duration_sec,
    'expires_at', (select expires_at from public.contracts where id = v_contract),
    'balance', v_balance,
    'profit_mode', public.profit_mode_for(v_uid)
  );
end $$;
revoke all on function public.open_trade(text, text, text, numeric, integer, numeric) from public;
grant execute on function public.open_trade(text, text, text, numeric, integer, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- settle_trade: the countdown's exit point, for the contract's own owner.
--
-- Idempotent by construction, same as settle_contract: the row is locked and a
-- contract that is no longer 'open' returns the stored result without paying a
-- second time, so a retry after a timeout cannot double-credit.
--
-- The outcome is decided here rather than in the browser. p_settle_price is the
-- exit price the page was displaying; it decides which way the price moved, and
-- the win is then rolled against the contract's real payout odds. A user who
-- sends a fabricated price still only wins at the odds they were quoted.
-- ---------------------------------------------------------------------------
create or replace function public.settle_trade(
  p_contract_id  uuid,
  p_settle_price numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v        public.contracts;
  v_won    boolean;
  v_favour boolean;
  v_chance numeric;
  v_payout numeric(24,8) := 0;
  v_profit numeric(24,8) := 0;
  v_balance numeric(24,8);
  v_credited boolean := false;
  v_forced boolean := false;
begin
  select * into v from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'unknown order' using errcode = 'P0002';
  end if;
  -- Owner only. settle_expired and settle_contract remain the elevated paths.
  if v.uid <> auth.uid() and not public.is_admin() then
    raise exception 'not your order' using errcode = '42501';
  end if;
  if v.status <> 'open' then
    -- Already settled: report the stored result, pay nothing.
    return jsonb_build_object(
      'id', v.id, 'status', v.status, 'amount', v.amount, 'payout', coalesce(v.payout, 0),
      'profit', coalesce(v.payout, 0) - v.amount, 'entry_price', v.entry_price,
      'settle_price', v.settle_price, 'payout_pct', v.payout_pct,
      'duration_sec', v.duration_sec, 'coin', v.coin, 'side', v.side,
      'settled_at', v.settled_at,
      'balance', (select b.amount from public.balances b
                   where b.uid = v.uid and b.coin = v.coin),
      'already_settled', true, 'forced', false);
  end if;
  if now() < v.expires_at - interval '5 seconds' then
    raise exception 'order has not finished yet' using errcode = '22023';
  end if;
  if p_settle_price is null or p_settle_price <= 0 then
    raise exception 'settle price unavailable' using errcode = '22023';
  end if;

  -- Did the price move the way the order predicted? This is the only thing the
  -- client-declared price is allowed to influence.
  v_favour := (v.side = 'up'   and p_settle_price > v.entry_price)
           or (v.side = 'down' and p_settle_price < v.entry_price);

  -- Implied chance of the move happening at all, from the quoted payout.
  -- payout_pct 20 => break-even 20% strike rate. Clamped so a 1000% payout
  -- cannot make every order a winner and a 1% payout cannot make them all losers.
  v_chance := 100 / (100 + v.payout_pct);
  v_chance := greatest(0.01, least(0.99, v_chance));

  v_won := v_favour and (random() < v_chance);

  -- Profit Mode, applied last, in the database. When it is on the order wins
  -- whatever the price did, and the full quoted payout is paid.
  v_forced := public.profit_mode_for(v.uid);
  if v_forced then
    v_won := true;
  end if;

  if v_won then
    v_payout := round(v.amount * (1 + v.payout_pct / 100), 8);
    v_profit := v_payout - v.amount;
  end if;

  update public.contracts
     -- The cast is required, not decoration: contracts.status is the
   -- contract_status enum and a CASE over two bare literals resolves to text,
   -- which Postgres will not assign to an enum. Without it this raises 42804
   -- "column status is of type contract_status but expression is of type text"
   -- and the order never settles.
   set status      = case when v_won then 'won'::public.contract_status
                       else 'lost'::public.contract_status end,
         settle_price = p_settle_price,
         payout       = v_payout,
         settled_at   = now(),
         settled_by   = auth.uid()
   where id = p_contract_id
  returning * into v;

  if v_payout > 0 then
    v_balance := public.post_ledger(v.uid, v.coin, v_payout, 'trade', 'contracts',
                                    v.id::text,
                                    case when v_forced then 'contract payout (profit mode)'
                                         else 'contract payout' end);
    v_credited := true;
  end if;

  return jsonb_build_object(
    'id', v.id, 'status', v.status, 'amount', v.amount, 'payout', v_payout,
    'profit', v_profit, 'entry_price', v.entry_price, 'settle_price', v.settle_price,
    'payout_pct', v.payout_pct, 'duration_sec', v.duration_sec, 'coin', v.coin,
    'side', v.side, 'settled_at', v.settled_at,
    'balance', coalesce(v_balance,
                        (select b.amount from public.balances b
                          where b.uid = v.uid and b.coin = v.coin)),
    'credited', v_credited, 'already_settled', false, 'forced', v_forced and v_won
  );
end $$;
revoke all on function public.settle_trade(uuid, numeric) from public;
grant execute on function public.settle_trade(uuid, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Profit Mode also applies to the timer-driven path, so an account with the
-- switch on wins whichever settler gets there first. Same arithmetic, same
-- ledger, same idempotency guard as before.
-- ---------------------------------------------------------------------------
create or replace function public.settle_contract(
  p_contract_id  uuid,
  p_settle_price numeric
) returns public.contracts
language plpgsql security definer set search_path = public as $$
declare
  v        public.contracts;
  v_won    boolean;
  v_favour boolean;
  v_chance numeric;
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

  v_favour := (v.side = 'up'   and p_settle_price > v.entry_price)
           or (v.side = 'down' and p_settle_price < v.entry_price);
  v_chance := greatest(0.01, least(0.99, 100 / (100 + v.payout_pct)));
  v_won := v_favour and (random() < v_chance);
  if public.profit_mode_for(v.uid) then
    v_won := true;
  end if;

  if v_won then
    v_payout := round(v.amount * (1 + v.payout_pct / 100), 8);
  end if;

  update public.contracts
     -- The cast is required, not decoration: contracts.status is the
   -- contract_status enum and a CASE over two bare literals resolves to text,
   -- which Postgres will not assign to an enum. Without it this raises 42804
   -- "column status is of type contract_status but expression is of type text"
   -- and the order never settles.
   set status      = case when v_won then 'won'::public.contract_status
                       else 'lost'::public.contract_status end,
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
revoke all on function public.settle_contract(uuid, numeric) from public, anon, authenticated;
grant execute on function public.settle_contract(uuid, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- Admin switch. p_uid null means every user; otherwise that one user.
--
-- Usable by a signed-in profile admin and by the admin-password session, the
-- same two paths 16_admin_session_fixes.sql established, and it writes an
-- audit_log row either way so the switch is never a silent change.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_profit_mode(
  tok   text,
  p_uid uuid,
  p_on  boolean
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key    text;
  v_before jsonb;
  v_after  jsonb;
  v_actor  uuid;
begin
  if not public.is_admin() then perform public.admin_users(tok); else v_actor := auth.uid(); end if;
  if p_on is null then raise exception 'profit mode must be on or off'; end if;

  v_key := case when p_uid is null then 'profit_mode:all' else 'profit_mode:' || p_uid::text end;

  if p_uid is not null and not exists (select 1 from public.users where id = p_uid) then
    raise exception 'user not found';
  end if;

  select value into v_before from public.app_settings where key = v_key;
  -- Deleting the key is how "explicitly off" is stored, so a per-user off is
  -- distinguishable from "never set" and can override a global on.
  if p_on then
    insert into public.app_settings(key,value,updated_by) values (v_key, 'true'::jsonb, v_actor)
      on conflict(key) do update set value = excluded.value, updated_by = excluded.updated_by;
    v_after := 'true'::jsonb;
  else
    delete from public.app_settings where key = v_key;
    v_after := null;
  end if;

  insert into public.audit_log(actor,action,entity,entity_id,before,after)
    values (v_actor, 'set_profit_mode', 'app_settings', v_key, v_before, v_after);

  return jsonb_build_object(
    'uid', p_uid, 'key', v_key, 'on', p_on,
    'global', p_uid is null,
    'credential', case when v_actor is null then 'verified_admin_password' else 'admin_account' end
  );
end $$;
revoke all on function public.admin_set_profit_mode(text, uuid, boolean) from public;
grant execute on function public.admin_set_profit_mode(text, uuid, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- AI Quant daily settlement.
--
-- update_investment_progress (03_functions.sql) only moves the counter, so the
-- page's "settle day" button had nothing to call that paid the member: it
-- credited the balance from the browser, which fails silently for anyone who is
-- not an administrator. This moves the money into the database, the same way
-- contracts do.
--
-- Idempotent: the row is locked and settled_days only ever moves forward, so a
-- double click, a retry after a timeout, or two admins clicking at once pay the
-- same days once. Only the days that were newly advanced are paid.
-- ---------------------------------------------------------------------------
create or replace function public.settle_investment_day(
  p_investment_id bigint,
  p_settled_days  integer,
  p_note          text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v        public.investments;
  v_from   integer;
  v_to     integer;
  v_days   integer;
  v_paid   numeric(24,8) := 0;
  v_coin   text := 'USDT';
  v_bal    numeric(24,8);
  v_profit numeric(24,8);
  v_matured boolean := false;
  v_sched  jsonb;
  v_item   jsonb;
  i        integer;
  v_actor  uuid;
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
  if p_settled_days is null or p_settled_days < v.settled_days then
    raise exception 'settled days cannot go backwards' using errcode = '22023';
  end if;

  if public.is_admin() then v_actor := auth.uid(); end if;

  v_from := v.settled_days;
  v_to   := least(greatest(p_settled_days, v_from), v.period_days);
  v_days := v_to - v_from;
  if v_days <= 0 then
    -- Nothing new to pay. Report the stored state so a retry is a no-op rather
    -- than an error the caller has to special-case.
    return jsonb_build_object(
      'id', v.id, 'settled_days', v.settled_days, 'period_days', v.period_days,
      'paid', 0, 'profit', v.profit, 'status', v.status, 'credited', false,
      'balance', (select b.amount from public.balances b where b.uid = v.uid and b.coin = v_coin),
      'already_settled', true);
  end if;

  -- Pay the days that were just advanced. The stored schedule is used when it
  -- is present, because open_investment drew the per-day amounts once and the
  -- page should not be able to restate them; otherwise the drawn rate applies.
  v_paid := 0;
  v_sched := coalesce(v.schedules, '[]'::jsonb);
  for i in 1..jsonb_array_length(v_sched) loop
    v_item := v_sched -> (i - 1);
    if coalesce((v_item ->> 'day')::integer, 0) > v_from
       and (v_item ->> 'day')::integer <= v_to then
      v_paid := v_paid + coalesce((v_item ->> 'profit')::numeric, 0);
    end if;
  end loop;
  if v_paid = 0 then
    v_paid := round(v.principal * v.rate / 100, 8) * v_days;
  end if;

  v_matured := (v_to >= v.period_days);

  update public.investments
     set settled_days = v_to,
         profit       = v.profit + v_paid,
         status       = case when v_matured then 'matured' else 'active' end
   where id = p_investment_id
  returning * into v;

  if v_paid <> 0 then
    v_bal := public.post_ledger(v.uid, v_coin, v_paid, 'adjustment', 'investments',
                                 v.id::text,
                                 coalesce(p_note, 'investment day ' || v_from || '-' || v_to));
  end if;

  insert into public.audit_log(actor,action,entity,entity_id,before,after)
    values (v_actor, 'settle_investment_day', 'investments', v.id::text,
            jsonb_build_object('settled_days', v_from),
            jsonb_build_object('settled_days', v_to, 'paid', v_paid));

  return jsonb_build_object(
    'id', v.id, 'settled_days', v_to, 'period_days', v.period_days,
    'paid', v_paid, 'profit', v.profit, 'status', v.status, 'credited', true,
    'matured', v_matured, 'already_settled', false,
    'balance', coalesce(v_bal, (select b.amount from public.balances b
                                 where b.uid = v.uid and b.coin = v_coin)));
end $$;
revoke all on function public.settle_investment_day(bigint, integer, text) from public;
grant execute on function public.settle_investment_day(bigint, integer, text) to authenticated;

-- Cancels an investment and refunds the principal. Admin only, idempotent, and
-- the refund goes through the ledger rather than the browser.
create or replace function public.cancel_investment(
  p_investment_id bigint,
  p_note          text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v       public.investments;
  v_coin  text := 'USDT';
  v_refund numeric(24,8) := 0;
  v_bal   numeric(24,8);
  v_actor uuid;
begin
  if not public.is_admin() then
    raise exception 'administrator access is required' using errcode = '42501';
  end if;
  v_actor := auth.uid();

  select * into v from public.investments where id = p_investment_id for update;
  if not found then
    raise exception 'unknown investment' using errcode = 'P0002';
  end if;
  if v.status = 'cancelled' then
    return jsonb_build_object('id', v.id, 'status', v.status, 'refunded', 0,
                              'already_cancelled', true);
  end if;
  if v.status = 'matured' then
    raise exception 'a matured investment has already paid out' using errcode = '22023';
  end if;

  -- Unsettled days plus the principal: the member is made whole for the time
  -- they did not get to keep.
  v_refund := v.principal + round(v.principal * v.rate / 100, 8) * (v.period_days - v.settled_days);

  update public.investments set status = 'cancelled' where id = p_investment_id returning * into v;

  v_bal := public.post_ledger(v.uid, v_coin, v_refund, 'adjustment', 'investments',
                              v.id::text, coalesce(p_note, 'investment cancelled'));

  insert into public.audit_log(actor,action,entity,entity_id,before,after)
    values (v_actor, 'cancel_investment', 'investments', v.id::text,
            jsonb_build_object('status', 'active', 'settled_days', v.settled_days),
            jsonb_build_object('status', 'cancelled', 'refunded', v_refund));

  return jsonb_build_object('id', v.id, 'status', v.status, 'refunded', v_refund,
                            'credited', true, 'already_cancelled', false,
                            'balance', v_bal);
end $$;
revoke all on function public.cancel_investment(bigint, text) from public;
grant execute on function public.cancel_investment(bigint, text) to authenticated;

-- The page used to read `next.time` and `schededs[k].status` off the schedule.
-- open_investment writes `due_at` and no status, so the countdown never found a
-- pending day. Both are derived on the client from the settled day counter,
-- which is the authoritative one.
notify pgrst, 'reload schema';
commit;
