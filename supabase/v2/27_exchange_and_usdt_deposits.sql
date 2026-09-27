-- ===========================================================================
--  Coin exchange at live prices, and USDT conversion on deposit approval.
-- ===========================================================================
--
--  Run this file once, in full, in the Supabase SQL Editor, AFTER 26.
--  It is additive: no table, column, function body or grant that already exists
--  is changed except admin_set_transaction_status, which is replaced on purpose
--  and behaves identically for every case except an approved non-USDT deposit.
--  No balance, contract, investment, member number or role is touched.
--
--  ---------------------------------------------------------------------------
--  Why the rate can never come from the browser
--  ---------------------------------------------------------------------------
--  An exchange that accepts a rate from the client is not an exchange, it is a
--  give-away: a member could post {coin_in: BTC, amount_in: 1, rate: 1000000}
--  and be credited a million USDT for one bitcoin. So the price is read from
--  public.prices, which no browser can write, and the browser is never asked
--  what the rate is. The member is told the rate afterwards, in the response,
--  which is the only direction that information can safely travel.
--
--  This is the same arrangement trading already uses: scripts/settle.mjs quotes
--  Binance and hands the quote to the database, which does the arithmetic. The
--  difference is that here the quote is stored rather than passed per call, so
--  a member's own request path never carries a price at all.
--
--  ---------------------------------------------------------------------------
--  Why a stale price is refused
--  ---------------------------------------------------------------------------
--  A price table that nobody refreshes is a way to lose money quietly. If the
--  refresher is not running, prices stop moving, and an exchange would keep
--  filling at yesterday's rate while the market moves. So every read checks
--  fetched_at and refuses rather than guessing. That means the refresher has to
--  be running; see scripts/prices.mjs, and the check below:
--
--    select symbol, price_usdt, fetched_at from public.prices order by symbol;
--
--  Two ages, deliberately different. A member swapping coins is told a rate
--  immediately, so five minutes is already generous. An administrator approving
--  a deposit is doing a deliberate, auditable act and may be working through a
--  backlog, so half an hour is allowed before the approval is refused. Both are
--  refusals with a named cause, never a silent fallback to an old number.
--
--  ---------------------------------------------------------------------------
--  Rounding
--  ---------------------------------------------------------------------------
--  balances.amount is numeric(24,8), so anything credited is rounded to 8
--  decimal places. Rounding happens once, on the way out, and the rounded figure
--  is what is both credited and reported. A member is never credited a number
--  that differs by a rounding step from the one they were shown.
-- ===========================================================================


-- ===========================================================================
--  Transaction 1 of 2: the enum value, on its own.
--
--  ALTER TYPE ... ADD VALUE is only visible to the rest of the transaction after
--  it commits, so a function created in the same transaction that mentions
--  'exchange' would fail to parse. The enum is therefore committed on its own
--  before any function that uses it is created.
--
--  A ledger entry for a swap has to be distinguishable from a deposit, a trade
--  and an adjustment, or a later reconciliation cannot tell what moved the
--  money. 'exchange' is that reason.
-- ===========================================================================
begin;

alter type public.txn_type add value if not exists 'exchange';

commit;


-- ===========================================================================
--  Transaction 2 of 2: the price table, the freshness rule, the exchange, and
--  the deposit conversion.
-- ===========================================================================
begin;

-- ---------------------------------------------------------------------------
--  1. The price table.
--
--  symbol is the base coin, always priced in USDT. USDT itself is seeded at
--  exactly 1 so that every pair, including USDT to USDT, resolves through the
--  same arithmetic with no special case anywhere else.
--
--  No insert or update policy is granted to anybody, so this table is written
--  only by the service role, which is what scripts/prices.mjs holds. Prices are
--  public market data, so reading them is deliberately open to signed-out
--  visitors: the exchange page shows a rate before anybody signs in.
-- ---------------------------------------------------------------------------
create table if not exists public.prices (
  symbol     text primary key
                         check (symbol = upper(symbol) and symbol ~ '^[A-Z0-9]{2,15}$'),
  price_usdt numeric(36,18) not null
                         check (price_usdt > 0),
  source     text not null default 'binance',
  fetched_at timestamptz not null default now()
);

create index if not exists prices_fetched_idx on public.prices (fetched_at desc);

insert into public.prices (symbol, price_usdt, source, fetched_at)
values ('USDT', 1, 'fixed', now())
on conflict (symbol) do update
  set price_usdt = 1, source = 'fixed', fetched_at = now();

alter table public.prices enable row level security;

drop policy if exists prices_read on public.prices;
create policy prices_read on public.prices for select to anon, authenticated using (true);

revoke all on public.prices from anon, authenticated;
grant select on public.prices to anon, authenticated;


-- ---------------------------------------------------------------------------
--  2. Reading a price, with the freshness rule attached.
--
--  Every consumer goes through here rather than selecting from the table, so
--  the age check cannot be forgotten at one call site and honoured at another.
--  p_max_age is in seconds.
--
--  A missing symbol and a stale one are reported differently on purpose: a coin
--  the feed has never seen is an operator problem, a coin that has gone quiet is
--  a refresher problem, and the two need different fixes.
-- ---------------------------------------------------------------------------
create or replace function public.price_of_usdt(p_symbol text, p_max_age_sec integer)
returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  v_price   numeric(36,18);
  v_fetched timestamptz;
  v_symbol  text := upper(trim(coalesce(p_symbol, '')));
begin
  if v_symbol = '' then
    raise exception 'no coin was named' using errcode = '22023';
  end if;

  select price_usdt, fetched_at into v_price, v_fetched
    from public.prices
   where symbol = v_symbol;

  if not found then
    raise exception 'no live price for %: the price feed has never reported it', v_symbol
      using errcode = '22023';
  end if;

  if v_fetched < now() - make_interval(secs => greatest(p_max_age_sec, 1)) then
    raise exception 'the price for % is % seconds old, which is over the % second limit: restart scripts/prices.mjs',
      v_symbol, extract(epoch from (now() - v_fetched))::int, greatest(p_max_age_sec, 1)
      using errcode = '22023';
  end if;

  return v_price;
end $$;

revoke all on function public.price_of_usdt(text, integer) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
--  3. The exchange.
--
--  One call, one transaction. The member sends what they are selling, how much,
--  and what they want. They do not send a rate, and there is no parameter they
--  could put one in.
--
--  Both legs go through post_ledger, which locks the balance row, refuses to go
--  negative, and writes a ledger entry with the resulting balance. Two calls in
--  one transaction means a swap is all-or-nothing: if the second leg fails the
--  first is rolled back, so a member is never left having paid for coins they did
--  not receive. Two concurrent swaps of the same coin serialise on the same
--  balance row, so they cannot interleave into a lost update.
--
--  p_spread_bps is a fee in basis points, default 0. It exists so an operator
--  can turn on a spread without another migration, and it is applied against
--  the server's own price, never the member's.
-- ---------------------------------------------------------------------------
create or replace function public.exchange_coins(
  p_coin_in    text,
  p_amount_in  numeric,
  p_coin_out   text,
  p_spread_bps integer default 0
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_in       text := upper(trim(coalesce(p_coin_in, '')));
  v_out      text := upper(trim(coalesce(p_coin_out, '')));
  v_amount   numeric(24,8);
  v_price_in numeric(36,18);
  v_price_out numeric(36,18);
  v_gross    numeric(36,18);
  v_net      numeric(36,18);
  v_credit   numeric(24,8);
  v_spread   integer := coalesce(p_spread_bps, 0);
  v_status   user_status;
  v_note     text;
begin
  if v_uid is null then
    raise exception 'sign in to exchange coins' using errcode = '42501';
  end if;

  -- A suspended or banned account must not be able to swap its way out of a
  -- freeze. Without this, converting a balance into a different coin is a way to
  -- move money the operator has stopped, which is the opposite of what a freeze
  -- is for. Checked before anything is read or written.
  select status into v_status from public.users where id = v_uid;
  if not found then
    raise exception 'no profile for this account' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'this account is % and cannot exchange coins', v_status using errcode = '42501';
  end if;

  if v_in = '' or v_out = '' then
    raise exception 'choose both a coin to sell and a coin to buy' using errcode = '22023';
  end if;
  if v_in = v_out then
    raise exception 'choose two different coins' using errcode = '22023';
  end if;

  -- Bounded before it is rounded, not after. balances.amount is numeric(24,8),
  -- so an absurd amount would otherwise overflow on assignment and surface as an
  -- arithmetic error instead of being refused in words.
  if p_amount_in is null or p_amount_in <= 0 then
    raise exception 'enter an amount greater than zero' using errcode = '22023';
  end if;
  if p_amount_in > 1000000000000 then
    raise exception 'that is more than this exchange can move in one go' using errcode = '22023';
  end if;
  v_amount := round(p_amount_in, 8);

  if v_spread < 0 or v_spread > 1000 then
    raise exception 'the exchange spread must be between 0 and 1000 basis points' using errcode = '22023';
  end if;

  -- Five minutes. A member is shown a rate the instant they ask for one.
  v_price_in  := public.price_of_usdt(v_in, 300);
  v_price_out := public.price_of_usdt(v_out, 300);

  -- Through USDT, so BTC -> ETH prices as BTC/USDT over ETH/USDT and the two
  -- legs are never quoted directly against each other.
  v_gross := v_amount * v_price_in / v_price_out;
  v_net   := v_gross * (10000 - v_spread) / 10000;
  v_credit := round(v_net, 8);

  -- Dust is refused rather than rounded to nothing. Crediting a balance of 0.000
  -- would look like the exchange worked and the money vanished.
  if v_credit <= 0 then
    raise exception 'that amount is too small to exchange: it would round to % %', v_credit, v_out
      using errcode = '22023';
  end if;

  v_note := format('exchange %s %s -> %s %s at %s USDT per %s (spread %s bps)',
                   v_amount, v_in, v_credit, v_out, v_price_in, v_in, v_spread);

  -- post_ledger refuses to go negative, so an unaffordable swap raises here and
  -- nothing is written. The message names the coin and the shortfall.
  perform public.post_ledger(v_uid, v_in, -v_amount, 'exchange', 'exchange', null, v_note);
  perform public.post_ledger(v_uid, v_out,  v_credit, 'exchange', 'exchange', null, v_note);

  return jsonb_build_object(
    'ok', true,
    'coin_in', v_in,
    'amount_in', v_amount,
    'coin_out', v_out,
    'amount_out', v_credit,
    'price_in_usdt', v_price_in,
    'price_out_usdt', v_price_out,
    'rate', round(v_price_in / v_price_out, 12),
    'spread_bps', v_spread,
    'prices_fetched_at', (select max(fetched_at) from public.prices
                            where symbol in (v_in, v_out)),
    'note', v_note
  );
end $$;

revoke all on function public.exchange_coins(text, numeric, text, integer) from public, anon;
grant execute on function public.exchange_coins(text, numeric, text, integer) to authenticated;


-- ---------------------------------------------------------------------------
--  4. A deposit of any coin is credited as USDT.
--
--  admin_set_transaction_status is replaced, so this is the one existing
--  behaviour that changes. It is otherwise byte-for-byte the same, including
--  the admin check, the pending-only rule, the same-transaction crediting, the
--  reviewed_by/reviewed_at stamp and the audit_log row.
--
--  On approving a deposit whose coin is not USDT, the credited amount is
--  amount * the live price of that coin in USDT, and the transaction row keeps
--  the coin and amount the member actually sent. Nothing is rewritten: the
--  audit trail still shows 0.5 BTC arrived, and the note records the rate used,
--  so the two can never disagree later.
--
--  A member who sends 0.5 BTC is therefore credited 0.5 * price USDT and does
--  not hold any BTC. To send or withdraw BTC afterwards they convert USDT to BTC
--  through exchange_coins, at the same server price. That is a consequence of
--  crediting USDT, and it is the behaviour that was asked for.
--
--  Half an hour of price age is allowed here, not the five minutes a swap gets,
--  because approving a backlog of deposits is deliberate work. Past that the
--  approval is refused by name, and the fix is to restart scripts/prices.mjs and
--  approve again. No approval silently uses an old price.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_transaction_status(
  p_txn_id bigint,
  p_status txn_status,
  p_note   text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_txn   public.transactions;
  v_coin  text;
  v_price numeric(36,18);
  v_usdt  numeric(24,8);
  v_note  text;
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
      v_coin := upper(trim(coalesce(v_txn.coin, '')));
      if v_coin <> 'USDT' then
        v_price := public.price_of_usdt(v_coin, 1800);
        v_usdt  := round(v_txn.amount * v_price, 8);
        if v_usdt <= 0 then
          raise exception 'that deposit is worth % USDT at the current price, which is too small to credit', v_usdt
            using errcode = '22023';
        end if;
        -- The member sent `amount coin`; the account is credited the USDT value.
        -- Both facts are kept: the row is untouched, and the note carries the rate.
        v_note := coalesce(p_note || ' | ', '')
                  || format('credited %s USDT for %s %s at %s USDT per %s',
                            v_usdt, v_txn.amount, v_coin, v_price, v_coin);
        perform public.post_ledger(v_txn.uid, 'USDT', v_usdt, 'deposit',
                                   'transactions', v_txn.id::text, v_note);
      else
        perform public.post_ledger(v_txn.uid, v_txn.coin, v_txn.amount, 'deposit',
                                   'transactions', v_txn.id::text, p_note);
      end if;
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

revoke all on function public.admin_set_transaction_status(bigint, txn_status, text) from public, anon;
grant execute on function public.admin_set_transaction_status(bigint, txn_status, text) to authenticated;


-- ---------------------------------------------------------------------------
--  5. The read the exchange page uses.
--
--  Returns every coin with a usable price, newest first, and says how old each
--  one is. The page shows the age rather than pretending a price is current,
--  and greys out anything past the swap limit so a member is not invited to try
--  a swap that is going to be refused.
-- ---------------------------------------------------------------------------
create or replace function public.list_live_prices(p_max_age_sec integer default 300)
returns table (symbol text, price_usdt numeric, fetched_at timestamptz, age_sec integer, tradable boolean)
language sql stable security definer set search_path = public
as $$
  select p.symbol,
         p.price_usdt,
         p.fetched_at,
         extract(epoch from (now() - p.fetched_at))::int as age_sec,
         (p.fetched_at >= now() - make_interval(secs => greatest(p_max_age_sec, 1))) as tradable
    from public.prices p
   order by p.symbol;
$$;

revoke all on function public.list_live_prices(integer) from public, anon;
grant execute on function public.list_live_prices(integer) to anon, authenticated;


notify pgrst, 'reload schema';
commit;
