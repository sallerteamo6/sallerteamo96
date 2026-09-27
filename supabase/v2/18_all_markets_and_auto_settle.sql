-- Apply after 17. Additive only: nothing is dropped, no balance, contract,
-- investment or user row is rewritten, and no account is promoted.
--
-- What this fixes
--   1. `products` was seeded with 12 of the coins the home page offers, so any
--      order on the other seven crypto pairs, the four metals and the five
--      forex pairs was refused with `unknown market`. Every coin the front end
--      lists is now a tradable product, with the same 60s/120s/300s durations.
--   2. The AI Quant page offers five plans but only two of them existed in
--      investment_products, so three plans were rejected by name.
--   3. investment_products had no minimum or maximum, so the minimum the page
--      enforces was only cosmetic: a crafted request could open a 0.01 USDT
--      investment. Both bounds are now columns and are enforced in the server.
--   4. Investment settlements have to run without anyone watching, so a
--      service_role sweep settles every day that has elapsed and returns the
--      principal when the term completes.
--
-- Running it again is safe: every statement is an upsert on a natural key.

begin;

-- ---------------------------------------------------------------------------
-- 1. Every coin the front end lists.
--
-- price_symbol is the Binance pair scripts/settle.mjs quotes to decide an
-- outcome. The metals and forex pairs have no Binance market, so they carry a
-- sentinel that will never resolve. That is deliberate and matches the
-- documented rule in settle.mjs: an unquotable product blocks rather than
-- guessing, because settling on a wrong price pays real money to the wrong
-- side. Those markets still settle through the countdown path (settle_trade),
-- which uses the price the page is displaying. Run settle.mjs and it will report
-- them as unquotable and leave them alone rather than mispricing them.
-- ---------------------------------------------------------------------------
insert into public.products (symbol, name, price_symbol, payout_pct, min_amount, quote_coin, sort_order) values
  -- crypto, quoted in USDT
  ('BTC',  'Bitcoin',      'BTCUSDT',  185, 10, 'USDT', 1),
  ('ETH',  'Ethereum',     'ETHUSDT',  184, 10, 'USDT', 2),
  ('SOL',  'Solana',       'SOLUSDT',  183, 10, 'USDT', 3),
  ('BNB',  'BNB',          'BNBUSDT',  182, 10, 'USDT', 4),
  ('XRP',  'XRP',          'XRPUSDT',  181, 10, 'USDT', 5),
  ('DOGE', 'Dogecoin',     'DOGEUSDT', 180, 10, 'USDT', 6),
  ('ADA',  'Cardano',      'ADAUSDT',  180, 10, 'USDT', 7),
  ('DOT',  'Polkadot',     'DOTUSDT',  179, 10, 'USDT', 8),
  ('LINK', 'Chainlink',    'LINKUSDT', 179, 10, 'USDT', 9),
  ('AVAX', 'Avalanche',    'AVAXUSDT', 178, 10, 'USDT', 10),
  ('TRX',  'TRON',         'TRXUSDT',  178, 10, 'USDT', 11),
  ('LTC',  'Litecoin',     'LTCUSDT',  177, 10, 'USDT', 12),
  ('TON',  'Toncoin',      'TONUSDT',  177, 10, 'USDT', 13),
  ('UNI',  'Uniswap',      'UNIUSDT',  176, 10, 'USDT', 14),
  ('BCH',  'Bitcoin Cash', 'BCHUSDT',  176, 10, 'USDT', 15),
  ('BSV',  'Bitcoin SV',   'BSVUSDT',  175, 10, 'USDT', 16),
  ('IOTA', 'IOTA',         'IOTAUSDT', 175, 10, 'USDT', 17),
  ('ETC',  'Ethereum Classic', 'ETCUSDT', 174, 10, 'USDT', 18),
  ('USDC', 'USD Coin',     'USDCUSDT', 174, 10, 'USDT', 19),
  ('TUSD', 'TrueUSD',      'TUSDUSDT', 173, 10, 'USDT', 20),
  -- metals, quoted in USD
  ('XAU',  'Gold',         'METAL_XAU', 173, 10, 'USD', 21),
  ('XAG',  'Silver',       'METAL_XAG', 173, 10, 'USD', 22),
  ('XPD',  'Palladium',    'METAL_XPD', 172, 10, 'USD', 23),
  ('XPT',  'Platinum',     'METAL_XPT', 172, 10, 'USD', 24),
  -- forex, quoted in USD
  ('EUR',  'Euro',         'FX_EURUSD', 172, 10, 'USD', 25),
  ('AUD',  'Australian Dollar', 'FX_AUDUSD', 172, 10, 'USD', 26),
  ('GBP',  'Pound Sterling',    'FX_GBPUSD', 171, 10, 'USD', 27),
  -- USD/CNY and USD/JPY have USD as the base, which products.symbol cannot
  -- express (it is the unique key and 'USD' is already taken as a quote coin),
  -- so they are recorded under a distinct symbol that no page will offer. Add
  -- them properly only after deciding how a USD-base pair should be keyed.
  ('USDCNY', 'US Dollar / Chinese Yuan', 'FX_USDCNY', 171, 10, 'CNY', 28),
  ('USDJPY', 'US Dollar / Japanese Yen',  'FX_USDJPY', 171, 10, 'JPY', 29)
on conflict (symbol) do update
  set name        = excluded.name,
      price_symbol = excluded.price_symbol,
      payout_pct   = excluded.payout_pct,
      min_amount   = excluded.min_amount,
      quote_coin   = excluded.quote_coin,
      sort_order   = excluded.sort_order,
      is_active    = true;

-- 60s / 120s / 300s per product, mirroring 05_seed.sql: longer contracts pay a
-- little more. Written as one statement over the whole table so a product added
-- by hand also gets its durations.
insert into public.product_durations (product_id, seconds, payout_pct)
select p.id, d.seconds, p.payout_pct + d.adjust
  from public.products p
 cross join (values
   (60::integer,  -2::numeric),
   (120,          -1),
   (300,           0)
 ) as d(seconds, adjust)
 where p.is_active
on conflict (product_id, seconds) do update
  set payout_pct = excluded.payout_pct,
      is_active  = true;

-- ---------------------------------------------------------------------------
-- 2 + 3. AI Quant plans.
--
-- The five plans the page offers, with the bounds it displays. The bounds become
-- real columns here and are enforced by open_investment below, so the minimum is
-- no longer something a crafted request can step around.
-- ---------------------------------------------------------------------------
alter table public.investment_products
  add column if not exists min_principal numeric(24,8);
alter table public.investment_products
  add column if not exists max_principal numeric(24,8);

insert into public.investment_products (code, name, period_days, rate_min, rate_max, is_active, min_principal, max_principal) values
  ('AIQ_1',   'AI Quant Demo',         1,   2.0, 2.0, true,    10,   1000),
  ('AIQ_7',   'AI Quant 7-Day',        7,   2.5, 2.5, true,   100,  10000),
  ('AIQ_15',  'AI Quant 15-Day',      15,   2.5, 2.5, true,   100,  10000),
  ('AIQ_30',  'AI Quant 30-Day',      30,   3.0, 3.0, true,  1000,  50000),
  ('AIQ_90',  'AI Quant 90-Day',      90,   4.0, 4.0, true,  5000, 100000),
  ('AIQ_180', 'AI Quant 180-Day',    180,   5.0, 5.0, true, 10000,        0)
on conflict (code) do update
  set name         = excluded.name,
      period_days  = excluded.period_days,
      rate_min     = excluded.rate_min,
      rate_max     = excluded.rate_max,
      is_active    = true,
      min_principal = excluded.min_principal,
      max_principal = excluded.max_principal;

-- Older rows predate the bound columns; give them a sane default rather than
-- leaving them null, which would mean "no minimum" on any pre-existing plan.
update public.investment_products
   set min_principal = 10
 where min_principal is null;

-- ---------------------------------------------------------------------------
-- open_investment, with the bounds enforced and the schedules keyed by day.
--
-- The rate is still drawn once, at open, and stored on the row, so settlement
-- never needs an external price and the page cannot restate it.
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

  -- The page used to enforce these two in JavaScript, which a crafted request
  -- simply skipped. They are database facts now.
  if v_prod.min_principal is not null and p_principal < v_prod.min_principal then
    raise exception 'minimum for % is %', v_prod.name, v_prod.min_principal using errcode = '22023';
  end if;
  if v_prod.max_principal is not null and v_prod.max_principal > 0 and p_principal > v_prod.max_principal then
    raise exception 'maximum for % is %', v_prod.name, v_prod.max_principal using errcode = '22023';
  end if;

  -- random() is double precision and double precision * numeric is double
  -- precision, so the un-cast version made this round(double precision,
  -- integer), which does not exist. Keep the arithmetic in numeric space.
  v_rate := round(
              v_prod.rate_min::numeric
              + random()::numeric * greatest(0::numeric, v_prod.rate_max - v_prod.rate_min),
              2);

  -- due_at is a full day after the start, so a day is a real 24 hours rather
  -- than 24 hours after the last sweep happened to run. settle_due_investments
  -- reads these dates to decide what is owed, so a sweep never settles early.
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
-- settle_investment_day, superseded from 17.
--
-- Two changes: the principal is returned with the final day, and a call can ask
-- for "settle everything that is due now" by passing the term length, which is
-- what the page's Settle Day button does so an operator is not clicking a 180
-- day plan 180 times.
--
-- Idempotent throughout: the row is locked and settled_days only moves forward,
-- so a double click, a retry after a timeout, or the sweep and a manual click
-- racing each other pay the same days once. The principal is inside the same
-- locked transaction as the counter, which is what makes that true for it too.
-- ---------------------------------------------------------------------------
create or replace function public.settle_investment_day(
  p_investment_id bigint,
  p_settled_days  integer,
  p_note          text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v         public.investments;
  v_days    integer;
  v_profit  numeric(24,8) := 0;
  v_payout  numeric(24,8) := 0;
  v_matured boolean := false;
  v_item    jsonb;
  i         integer;
  v_sched   jsonb;
  v_actor   uuid;
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

  v_days := least(p_settled_days, v.period_days) - v.settled_days;
  if v_days <= 0 then
    -- Nothing new to pay. Report the stored state so a retry is a no-op rather
    -- than an error the caller has to special-case.
    return jsonb_build_object(
      'id', v.id, 'settled_days', v.settled_days, 'period_days', v.period_days,
      'paid', 0, 'profit', v.profit, 'status', v.status, 'credited', false,
      'matured', false, 'already_settled', true,
      'balance', (select b.amount from public.balances b where b.uid = v.uid and b.coin = 'USDT'));
  end if;

  -- The per-day amounts were drawn once when the investment opened and stored
  -- with it, so the page cannot restate them. Fall back to the drawn rate only
  -- if no schedule was stored.
  v_sched := coalesce(v.schedules, '[]'::jsonb);
  if jsonb_array_length(v_sched) > 0 then
    for i in 1..jsonb_array_length(v_sched) loop
      v_item := v_sched -> (i - 1);
      if (v_item ->> 'day')::integer > v.settled_days
         and (v_item ->> 'day')::integer <= v.settled_days + v_days then
        v_profit := v_profit + coalesce((v_item ->> 'profit')::numeric, 0);
      end if;
    end loop;
  end if;
  if v_profit = 0 then
    v_profit := round(v.principal * v.rate / 100, 8) * v_days;
  end if;

  v_matured := (v.settled_days + v_days) >= v.period_days;
  -- The principal comes back with the final day: a completed plan has returned
  -- everything the member put in, plus the profit.
  v_payout := v_profit + (case when v_matured then v.principal else 0 end);

  update public.investments
     set settled_days = v.settled_days + v_days,
         profit       = v.profit + v_profit,
         status       = case when v_matured then 'matured' else 'active' end
   where id = p_investment_id
  returning * into v;

  perform public.post_ledger(v.uid, 'USDT', v_payout, 'adjustment', 'investments', v.id::text,
    case when v_matured then coalesce(p_note, 'investment matured: profit plus principal returned')
         else coalesce(p_note, 'investment days') end);

  insert into public.audit_log(actor,action,entity,entity_id,before,after)
    values (v_actor, 'settle_investment_day', 'investments', v.id::text,
            jsonb_build_object('settled_days', v.settled_days - v_days),
            jsonb_build_object('settled_days', v.settled_days, 'paid', v_payout, 'matured', v_matured));

  return jsonb_build_object(
    'id', v.id, 'settled_days', v.settled_days, 'period_days', v.period_days,
    'days_paid', v_days, 'paid', v_payout, 'profit_paid', v_profit,
    'principal_returned', case when v_matured then v.principal else 0 end,
    'profit', v.profit, 'status', v.status, 'credited', true,
    'matured', v_matured, 'already_settled', false,
    'balance', (select b.amount from public.balances b where b.uid = v.uid and b.coin = 'USDT'));
end $$;
revoke all on function public.settle_investment_day(bigint, integer, text) from public;
grant execute on function public.settle_investment_day(bigint, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Unattended settlement.
--
-- settle_due_investments() settles every investment with a full day owed, pays
-- it through the ledger, and returns the principal when the term completes.
-- Idempotent and safe to run as often as you like: rows are locked with skip
-- locked so two sweeps cannot take the same one, settled_days only moves
-- forward, and a day already paid is skipped rather than paid twice.
--
-- service_role only, called by scripts/settle-investments.mjs on a timer. The
-- interval only affects how promptly a day is paid, never how much: the pay is
-- per elapsed day, not per run.
-- ---------------------------------------------------------------------------
create or replace function public.settle_due_investments()
returns table (id bigint, uid uuid, days_paid integer, paid numeric, matured boolean)
language plpgsql security definer set search_path = public, extensions as $$
declare
  c       record;
  v_days  integer := 0;
  v_profit numeric(24,8) := 0;
  v_paid  numeric(24,8) := 0;
  v_mat   boolean;
  v_item  jsonb;
  i       integer;
  v_sched jsonb;
begin
  for c in
    select i.id, i.uid, i.principal, i.rate, i.period_days, i.settled_days,
           i.schedules, i.start_at
      from public.investments i
     where i.status = 'active'
       and (
         -- A day is owed when the schedule says so and its date has passed. A
         -- sweep can therefore never settle a day early.
         exists (select 1
                   from jsonb_array_elements(coalesce(i.schedules, '[]'::jsonb)) s
                  where (s ->> 'day')::integer > i.settled_days
                    and (s ->> 'day')::integer <= i.period_days
                    and (s ->> 'due_at')::timestamptz <= now())
         -- No stored schedule: fall back to whole days since the start.
         or (coalesce(jsonb_array_length(i.schedules, 1), 0) = 0
             and i.start_at + make_interval(days => i.settled_days + 1) <= now())
       )
     order by i.start_at
     limit 500
     for update of i skip locked
  loop
    v_sched := coalesce(c.schedules, '[]'::jsonb);
    v_profit := 0;

    if jsonb_array_length(v_sched) > 0 then
      for i in 1..jsonb_array_length(v_sched) loop
        v_item := v_sched -> (i - 1);
        if (v_item ->> 'day')::integer > c.settled_days
           and (v_item ->> 'day')::integer <= c.period_days
           and (v_item ->> 'due_at')::timestamptz <= now() then
          v_days := v_days + 1;
          v_profit := v_profit + coalesce((v_item ->> 'profit')::numeric, 0);
        end if;
      end loop;
    else
      v_days := greatest(0, least(c.period_days - c.settled_days,
        floor(extract(epoch from (now() - c.start_at) / 86400))::integer - c.settled_days));
      v_profit := round(c.principal * c.rate / 100, 8) * v_days;
    end if;

    if v_days <= 0 then continue; end if;

    v_mat  := (c.settled_days + v_days) >= c.period_days;
    v_paid := v_profit + (case when v_mat then c.principal else 0 end);

    update public.investments
       set settled_days = c.settled_days + v_days,
           profit       = (select profit from public.investments where id = c.id) + v_profit,
           status       = case when v_mat then 'matured' else 'active' end
     where id = c.id;

    perform public.post_ledger(c.uid, 'USDT', v_paid, 'adjustment', 'investments', c.id::text,
      case when v_mat then 'investment matured: profit plus principal returned'
           else 'investment days ' || c.settled_days || '-' || (c.settled_days + v_days)
      end);

    insert into public.audit_log(actor,action,entity,entity_id,before,after)
      values (null, 'settle_due_investment', 'investments', c.id::text,
              jsonb_build_object('settled_days', c.settled_days),
              jsonb_build_object('settled_days', c.settled_days + v_days, 'paid', v_paid, 'matured', v_mat));

    id := c.id; uid := c.uid; days_paid := v_days; paid := v_paid; matured := v_mat;
    return next;

    v_days := 0;
  end loop;
end $$;
revoke all on function public.settle_due_investments() from public, anon, authenticated;
grant execute on function public.settle_due_investments() to service_role;

notify pgrst, 'reload schema';
commit;
