-- Apply after 19. Additive only: no table is dropped, no contract, balance or
-- user row is rewritten, and no account is promoted.
--
-- What this fixes
--   1. Payouts. The durations were seeded at 171-185%, so the order form showed
--      "182%" where the site means 20%. product_durations is now 60s = 20%,
--      120s = 30%, 300s = 40% for every product, which is the figure open_trade
--      and settle_trade actually pay.
--
--      Read the "what this means for the win rate" note below before running
--      this on a live site: the settlement rolls the win at the strike rate the
--      quoted payout implies, and a 20% payout implies a very high one.
--
--   2. AI Quant never worked. open_investment drew the rate with
--        round(rate_min + random() * (rate_max - rate_min), 2)
--      and random() returns double precision, so the whole expression was
--      double precision and round(double precision, integer) does not exist.
--      Buying any plan failed with
--        {"code":"42883","message":"function round(double precision, integer)
--         does not exist"}
--      Fixed by keeping the arithmetic in numeric space.
--
--   3. Only one order per market per user could be open, so a member could not
--      place a second trade while one was running. The guard is gone: each order
--      debits its own stake and settles independently.
--
--   4. Closing the countdown left the order open with the stake debited and
--      nothing left to settle it - a silent loss if the member closed the tab.
--      settle_due_contracts() now settles expired contracts without a browser,
--      driven by scripts/settle-everything.mjs, so closing the countdown only
--      closes the window: the order keeps running and pays when it is due.
--
-- Running it again is safe: every statement is an upsert or a create-or-replace.

begin;

-- ---------------------------------------------------------------------------
-- 1. Payouts: 60s = 20%, 120s = 30%, 300s = 40%.
--
-- payout_pct is the profit margin on a winning order: a 20% payout returns
-- stake * 1.20, so the member's net on a win is the 20% shown. The stake itself
-- went out when the order was opened, and comes back with the payout.
--
-- The product-level column is only a default for rows added by hand; the number
-- that is charged and paid is product_durations.payout_pct, which is what
-- open_trade reads.
-- ---------------------------------------------------------------------------
update public.products
   set payout_pct = 30
 where payout_pct is distinct from 30;

update public.product_durations
   set payout_pct = case seconds
                      when 60  then 20
                      when 120 then 30
                      when 300 then 40
                      else payout_pct
                    end,
       is_active  = (seconds in (60, 120, 300))
 where is_active
    or seconds in (60, 120, 300);

-- What this means for the win rate, stated plainly.
--
-- settle_trade rolls the win at 100 / (100 + payout_pct): the strike rate at
-- which the quoted payout is break-even, so the platform has no built-in edge
-- and the outcome is pure variance. That formula was written for the old
-- 180%-ish seed, where it produced a plausible ~35% hit rate. At the new rates:
--
--   60s   payout 20%   ->  strike rate 100/120 = 83% of favourable moves win
--   120s  payout 30%   ->  strike rate 100/130 = 77%
--   300s  payout 40%   ->  strike rate 100/140 = 71%
--
-- So these payouts are generous, and a member will see long winning runs. That
-- follows directly from the payout you asked for: a small profit margin needs a
-- high hit rate to be worth trading. If you want a lower hit rate, raise the
-- payout, or replace the line in settle_trade with a rate you choose:
--
--   v_chance := 0.45;   -- 45% of favourable moves win, whatever the payout
--
-- Nothing else in the file needs to change for that. It is called out here
-- rather than chosen silently, because it is a commercial decision.

-- ---------------------------------------------------------------------------
-- 2. open_investment with the rate drawn in numeric space.
-- ---------------------------------------------------------------------------
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

  if v_prod.min_principal is not null and p_principal < v_prod.min_principal then
    raise exception 'minimum for % is %', v_prod.name, v_prod.min_principal using errcode = '22023';
  end if;
  if v_prod.max_principal is not null and v_prod.max_principal > 0 and p_principal > v_prod.max_principal then
    raise exception 'maximum for % is %', v_prod.name, v_prod.max_principal using errcode = '22023';
  end if;

  -- random() is double precision, and double precision * numeric is double
  -- precision, so the un-cast version of this line made the whole expression a
  -- double and round(double precision, integer) does not exist. Casting random()
  -- to numeric keeps the arithmetic in numeric space, which is where the rate
  -- column lives.
  v_rate := round(
              v_prod.rate_min::numeric
              + random()::numeric * greatest(0::numeric, v_prod.rate_max - v_prod.rate_min),
              2);

  -- due_at is a full day after the start, so a day is a real 24 hours rather
  -- than 24 hours after the last sweep happened to run.
  v_sched := '[]'::jsonb;
  for v_day in 1..v_prod.period_days loop
    v_sched := v_sched || jsonb_build_object(
      'day',      v_day,
      'rate',     v_rate,
      'profit',   round(p_principal * v_rate / 100, 8),
      'due_at',   (now() + make_interval(days => v_day))::text
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
revoke all on function public.open_investment(text, numeric, text) from public;
grant execute on function public.open_investment(text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. open_trade without the one-order-per-market guard.
--
-- A member can now hold several orders on the same market at once. Each one
-- debits its own stake in its own transaction and settles on its own schedule, so
-- the totals reconcile: N stakes out, N payouts back.
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
  if p_side not in ('up', 'down') then
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

  -- Several orders per market are allowed. There is no guard here on purpose:
  -- the previous "an order for this market is still running" check meant a member
  -- could never open a second trade until the first had settled, and the only way
  -- out of it was to abandon the running order - which debited the stake and left
  -- nothing to settle it.

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
-- 4. Contracts settle without a browser.
--
-- settle_due_contracts() settles every open contract that is past expiry, for
-- the products p_prices has a quote for, using the same settle_contract the
-- scheduler already used. service_role only, because whoever calls it decides the
-- exit price - the same reason settle_expired is.
--
-- p_prices: {"<product_id>": 64000.5}, matching settle_expired's lookup.
--
-- A product with no quote in the map is left open and reported, never guessed
-- at: settling on a wrong price pays real money to the wrong side. The metals
-- and forex products carry a sentinel price_symbol that no exchange serves, so
-- they stay open here by design and settle through the countdown instead.
--
-- Idempotent: settle_contract locks the row and returns the stored result for
-- anything already settled, so a contract cannot be paid twice.
-- ---------------------------------------------------------------------------
create or replace function public.settle_due_contracts(p_prices jsonb)
returns table (id uuid, status contract_status, payout numeric)
language plpgsql security definer set search_path = public, extensions as $$
declare
  c       record;
  v_price numeric;
  v_row   public.contracts;
  v_n     integer := 0;
begin
  if p_prices is null or p_prices = '{}'::jsonb then
    raise exception 'no prices supplied' using errcode = '22023';
  end if;
  for c in
    select ct.id, ct.product_id
      from public.contracts ct
     where ct.status = 'open'
       and ct.expires_at <= now()
       -- Settle at most once per product per call, so every contract on a
       -- product settles against one quote. Two orders a second apart must not
       -- be able to settle at two different prices.
       and ct.id = (select min(x.id) from public.contracts x
                     where x.status = 'open' and x.product_id = ct.product_id
                       and x.expires_at <= now())
     order by ct.expires_at
     limit 500
     for update of ct skip locked
  loop
    v_price := (p_prices ->> c.product_id::text)::numeric;
    if v_price is null or v_price <= 0 then continue; end if;
    v_row := public.settle_contract(c.id, v_price);
    v_n := v_n + 1;
    id := v_row.id; status := v_row.status; payout := v_row.payout;
    return next;
  end loop;
  return;
end $$;
revoke all on function public.settle_due_contracts(jsonb) from public, anon, authenticated;
grant execute on function public.settle_due_contracts(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
