-- Apply after 20. Additive only: no table is dropped, no balance, contract or
-- user row is rewritten, and no account is promoted.
--
-- What this fixes
--   The metals and forex tabs showed "Balance: 0.00" and could not be traded at
--   all. The order form reads the wallet in the market's quote currency, and those
--   products were quoted in USD while the wallet holds USDT. The balance read was
--   only the symptom: the stake was debited from the USD balance too, so every
--   metals and forex order failed with
--     insufficient USD balance: available 0, required 100
--   even for a member holding a large USDT balance.
--
--   Two changes fix it:
--
--   1. Every product settles in USDT, the currency the wallet actually holds.
--      The price is still a USD price, and USDT is a dollar stablecoin, so the
--      number on screen is the same either way. This is also how every real venue
--      quotes gold and FX - XAU/USDT, not XAU/USD - so the pair a member sees now
--      matches the market convention.
--
--   2. open_trade ignores the currency the client asks for and uses the
--      product's own. The settlement currency is a property of the market, not
--      something a request should be able to choose, and letting the client pick
--      is what allowed a USD-denominated order to be debited from a balance the
--      member does not hold.
--
--   The two USD-base FX crosses (USD/CNY, USD/JPY) are deactivated. Their base
--   currency is USD, so products.symbol would have to be 'USD' to match the
--      market list - and a trade in them means buying a foreign currency with
--      dollars, which a USDT wallet cannot fund and which has no USDT price feed.
--      They are left visible on the home page and simply not tradable until you
--      decide how they should be priced. Re-enable with:
--        update public.products set is_active = true where symbol in ('USDCNY','USDJPY');

begin;

-- ---------------------------------------------------------------------------
-- 1. USDT everywhere, because that is what the wallet holds.
-- ---------------------------------------------------------------------------
update public.products set quote_coin = 'USDT' where quote_coin is distinct from 'USDT';

-- The USD-base crosses stay un-tradable; see the header.
update public.products set is_active = false where symbol in ('USDCNY', 'USDJPY');

-- Only the three durations the site offers remain active.
update public.product_durations
   set is_active = (seconds in (60, 120, 300))
 where is_active is distinct from (seconds in (60, 120, 300));

-- ---------------------------------------------------------------------------
-- 2. open_trade: the product decides the currency, not the request.
--
--    p_coin is kept in the signature so the RPC's argument list is unchanged for
--    the page, but it is no longer trusted. That is the whole point of the change.
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
  v_coin     text;
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

  -- The settlement currency comes from the market row. p_coin is accepted for
  -- call compatibility and then ignored: a request that could name the currency
  -- it is debited in is how a USD order reached a member with only USDT, and the
  -- balance read 0.00 with no way to tell why.
  v_coin := coalesce(nullif(upper(p_coin), ''), v_product.quote_coin);
  v_coin := coalesce(nullif(v_product.quote_coin, ''), v_coin, 'USDT');

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

  insert into public.contracts
    (uid, product_id, coin, side, amount, duration_sec, payout_pct, entry_price, expires_at)
  values
    (v_uid, v_product.id, v_coin, p_side, p_amount,
     p_duration_sec, v_payout, p_entry_price,
     now() + make_interval(secs => p_duration_sec))
  returning id into v_contract;

  v_balance := public.post_ledger(v_uid, v_coin, -p_amount,
                                  'trade', 'contracts', v_contract::text, 'contract stake');

  return jsonb_build_object(
    'id', v_contract,
    'symbol', v_product.symbol,
    'coin', v_coin,
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

notify pgrst, 'reload schema';
commit;
