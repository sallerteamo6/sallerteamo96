-- Apply after 17 and 18. Corrective only: no table is changed, no row is
-- rewritten, and nothing is seeded.
--
-- What this fixes
--   Settling a trade failed with
--     {"code":"42804","details":null,"hint":"You will need to rewrite or cast
--      the expression.","message":"column \"status\" is of type contract_status
--      but expression is of type text"}
--   and the result modal showed "Awaiting settlement" instead of the outcome.
--
--   The cause is one missing cast. contracts.status is the `contract_status`
--   enum, and `case when v_won then 'won' else 'lost' end` over two bare literals
--   resolves to text. PostgreSQL has no implicit cast from text to an enum, so
--   the UPDATE raised 42804 and the contract stayed open with the stake already
--   debited - the member saw no result and no refund.
--
--   It has been latent since 03_functions.sql was written; it only surfaced now
--   because settle_trade is the first path that actually runs this statement in
--   the browser. Both 03_functions.sql and 17 carry the cast now, so a fresh
--   install never hits it. This file exists because a project that already
--   applied 17 has the old function body stored in the database, and
--   re-applying 17 is not something to rely on an operator remembering.
--
--   Settling is idempotent, so re-running the page's own settle after this is
--   applied is safe: the contract is still open, so it pays once and only once.

begin;

-- ---------------------------------------------------------------------------
-- settle_trade: the countdown's exit point, for the contract's own owner.
-- ---------------------------------------------------------------------------
create or replace function public.settle_trade(
  p_contract_id  uuid,
  p_settle_price numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v         public.contracts;
  v_won     boolean;
  v_favour  boolean;
  v_chance  numeric;
  v_payout  numeric(24,8) := 0;
  v_profit  numeric(24,8) := 0;
  v_balance numeric(24,8);
  v_credited boolean := false;
  v_forced  boolean := false;
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
      'settled_at', v.settled_at, 'matured', false, 'forced', false,
      'already_settled', true,
      'balance', (select b.amount from public.balances b
                   where b.uid = v.uid and b.coin = v.coin));
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

  -- The cast is the whole point of this migration: contracts.status is the
  -- contract_status enum, and a CASE over two bare literals resolves to text,
  -- which PostgreSQL will not assign to an enum.
  update public.contracts
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
-- settle_contract: the timer-driven path, same cast, same arithmetic, so the
-- two settlers cannot disagree about what a win is.
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

notify pgrst, 'reload schema';
commit;
