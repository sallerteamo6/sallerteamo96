-- ===========================================================================
--  Server-side price feed: prices refresh in Supabase, not on your laptop.
-- ===========================================================================
--
--  Run this file once, in full, in the Supabase SQL Editor, AFTER 27.
--  It is additive. It creates the pg_net extension, a config table, a queue
--  table, two functions, one trigger and one cron job. It replaces no existing
--  table, column, function or grant, and touches no balance, contract,
--  investment, member number, role or price.
--
--  ---------------------------------------------------------------------------
--  Why this file exists
--  ---------------------------------------------------------------------------
--  Found live: public.prices stopped moving. It was written by scripts/prices.mjs
--  running on a Windows machine, and when that machine was switched off the feed
--  stopped with it. The site then showed figures nine and a half hours old and,
--  correctly, refused to swap:
--
--      1 USDT = 0.00127845 BNB (price 10h ago - too old to swap)
--
--  Nothing was broken. The safety rule from 27 did exactly what it was written to
--  do: a price nobody is refreshing is not a price. But a trading site whose
--  prices depend on one laptop being switched on is not running, and the failure
--  is invisible until someone tries to trade.
--
--  The fix is to stop depending on the laptop. pg_net lets Postgres make the HTTP
--  call itself and pg_cron already schedules work in this database, so the feed
--  runs inside Supabase and no browser, laptop, script or process is involved.
--  scripts/prices.mjs stays useful for local development and as a manual
--  override, but it is no longer load-bearing.
--
--  ---------------------------------------------------------------------------
--  Why the write path is still closed to browsers
--  ---------------------------------------------------------------------------
--  Nothing here changes the arrangement from 27. public.prices is still written
--  only by the database, and the rate still travels one way: the server quotes,
--  the browser is told. A member still cannot influence what a coin is worth,
--  by calling this function or any other.
--
--  The trigger is SECURITY DEFINER because it runs inside pg_net's worker, and it
--  is deliberately unable to raise: that transaction is the one draining the HTTP
--  queue, so an unhandled error here would silently stop every future request.
--
--  ---------------------------------------------------------------------------
--  After running this file
--  ---------------------------------------------------------------------------
--  Check it worked, any time:
--
--      select * from public.price_feed_health();
--
--  and confirm the feed is moving:
--
--      select symbol, price_usdt, fetched_at from public.prices order by symbol;
--
--  Wait a minute or two before checking; the first tick fires on the next whole
--  minute. To force one immediately, without waiting:
--
--      select public.kick_price_feed();
--
-- ===========================================================================

begin;

create extension if not exists pg_net;

-- pg_net grants USAGE on its schema to PUBLIC, which means anon and
-- authenticated can read the request queue and every raw response body. Close
-- that before anything is written into it.
revoke all on schema net from public;
revoke all on schema net from anon, authenticated;
do $$
begin
  execute 'revoke all on all tables in schema net from public';
  execute 'revoke all on all tables in schema net from anon, authenticated';
end $$;


-- ---------------------------------------------------------------------------
--  Which coins to price, and which are pegged rather than quoted
-- ---------------------------------------------------------------------------
--  Every Binance pair below was checked against /api/v3/ticker/price and exists.
--  That matters more than it looks: Binance rejects the entire request if one
--  symbol in the array is unknown, so a single wrong pair would take all nineteen
--  prices down, not one.
--
--  USDT is the unit prices are quoted in, so it is pinned to 1 rather than
--  fetched. It still needs a fresh fetched_at on every pass - see the trigger -
--  because a peg that ages out makes USDT->X swaps fail.
--
--  BSV is deliberately absent. It is not quoted on Binance spot, and a price for
--  it would have to be invented. The account page keeps showing it at its seeded
--  figure and says so.
-- ---------------------------------------------------------------------------
create table if not exists public.price_feed_config (
  symbol        text primary key,
  binance_pair  text unique,
  fixed_price   numeric(38, 18),
  enabled       boolean not null default true,
  note          text
);

insert into public.price_feed_config (symbol, binance_pair, fixed_price, note) values
  ('BTC',   'BTCUSDT',   null, null),
  ('ETH',   'ETHUSDT',   null, null),
  ('BNB',   'BNBUSDT',   null, null),
  ('LTC',   'LTCUSDT',   null, null),
  ('ADA',   'ADAUSDT',   null, null),
  ('XRP',   'XRPUSDT',   null, null),
  ('TON',   'TONUSDT',   null, null),
  ('SOL',   'SOLUSDT',   null, null),
  ('DOGE',  'DOGEUSDT',  null, null),
  ('TRX',   'TRXUSDT',   null, null),
  ('AVAX',  'AVAXUSDT',  null, null),
  ('LINK',  'LINKUSDT',  null, null),
  ('BCH',   'BCHUSDT',   null, null),
  ('DOT',   'DOTUSDT',   null, null),
  ('UNI',   'UNIUSDT',   null, null),
  ('IOTA',  'IOTAUSDT',  null, null),
  ('ETC',   'ETCUSDT',   null, null),
  ('USDC',  'USDCUSDT',  null, 'stablecoin, quoted not pinned'),
  ('TUSD',  'TUSDUSDT',  null, 'stablecoin, quoted not pinned'),
  ('USDT',  null,        1,    'the unit prices are quoted in')
on conflict (symbol) do update
   set binance_pair = excluded.binance_pair,
       fixed_price  = excluded.fixed_price,
       note         = excluded.note;


-- ---------------------------------------------------------------------------
--  Which HTTP request is which
--  ---------------------------------------------------------------------------
--  pg_net is asynchronous: http_get queues a request and returns an id, and the
--  body shows up later in net._http_response with no indication of what it was
--  for. This table is the link back. Kept for a day so there is something to
--  look at when the feed stops.
-- ---------------------------------------------------------------------------
create table if not exists public.price_fetch_queue (
  request_id    bigint primary key,
  requested_at  timestamptz not null default now(),
  pairs         text[] not null,
  ok            boolean,
  rows_written  integer,
  error         text
);

create index if not exists price_fetch_queue_recent_idx
  on public.price_fetch_queue (requested_at desc);


-- ---------------------------------------------------------------------------
--  Ask Binance for every enabled pair
-- ---------------------------------------------------------------------------
--  One request a minute for nineteen coins. The symbols array is passed as a
--  query parameter rather than pasted into the URL so pg_net does the escaping.
-- ---------------------------------------------------------------------------
create or replace function public.kick_price_feed()
returns bigint
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_pairs text[];
  v_json  text;
  v_rid   bigint;
begin
  select coalesce(array_agg(binance_pair order by binance_pair), '{}'::text[])
    into v_pairs
    from public.price_feed_config
   where enabled
     and binance_pair is not null;

  if coalesce(array_length(v_pairs, 1), 0) = 0 then
    raise exception 'price_feed_config has no enabled Binance pairs';
  end if;

  v_json := array_to_json(v_pairs)::text;

  v_rid := net.http_get(
    url                  := 'https://api.binance.com/api/v3/ticker/price',
    params               := jsonb_build_object('symbols', v_json),
    headers              := jsonb_build_object(
                              'User-Agent', 'sallerteamo6-price-feed',
                              'Accept', 'application/json'),
    timeout_milliseconds := 15000
  );

  insert into public.price_fetch_queue (request_id, pairs) values (v_rid, v_pairs);

  -- Housekeeping. pg_net keeps every response for six hours by default; left
  -- alone that is a table growing by a row a minute for no reason.
  delete from public.price_fetch_queue where requested_at < now() - interval '1 day';
  delete from net._http_response        where created      < now() - interval '10 minutes';

  return v_rid;
end $$;

comment on function public.kick_price_feed() is
  'Queue one Binance price request. Idempotent to call by hand; the cron job calls it every minute.';


-- ---------------------------------------------------------------------------
--  Store the response
-- ---------------------------------------------------------------------------
--  Runs as a trigger on pg_net's response table, so it has to be a row trigger.
--
--  Two rules it must not break. First, it returns without touching anything when
--  the response is not one of ours: pg_net's queue is shared with Supabase's
--  webhooks, and a failure here would break those too. Second, it never raises.
--  This function runs inside the worker transaction that drains the HTTP queue,
--  so an escaping exception would not just lose one price, it would stop every
--  request after it. Hence the nested handler, which swallows its own errors too.
-- ---------------------------------------------------------------------------
create or replace function public.on_price_feed_response()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  q    record;
  arr  jsonb;
  e    jsonb;
  base text;
  pair text;
  px   numeric(38, 18);
  n    integer := 0;
begin
  select * into q from public.price_fetch_queue where request_id = new.id;
  if not found then
    return new;   -- someone else's response
  end if;

  begin
    if new.timed_out then
      update public.price_fetch_queue
         set ok = false, error = 'request timed out'
       where request_id = new.id;
      return new;
    end if;

    if new.status_code is distinct from 200 then
      update public.price_fetch_queue
         set ok = false,
             error = coalesce(new.error_msg, 'HTTP ' || coalesce(new.status_code::text, 'no status'))
       where request_id = new.id;
      return new;
    end if;

    arr := coalesce(new.content, 'null')::jsonb;
    if jsonb_typeof(arr) is distinct from 'array' then
      update public.price_fetch_queue
         set ok = false, error = 'response was not a JSON array'
       where request_id = new.id;
      return new;
    end if;

    for e in select * from jsonb_array_elements(arr) loop
      pair := e ->> 'symbol';
      if pair is null or right(pair, 4) is distinct from 'USDT' then
        continue;
      end if;
      base := left(pair, length(pair) - 4);
      px   := (e ->> 'price')::numeric(38, 18);

      -- A zero or unparseable price must not overwrite a good one. A feed that
      -- writes nulls is worse than a feed that writes nothing.
      if px is null or px <= 0 then
        continue;
      end if;

      insert into public.prices (symbol, price_usdt, source, fetched_at)
      values (base, px, 'binance', now())
      on conflict (symbol) do update
         set price_usdt = excluded.price_usdt,
             source     = excluded.source,
             fetched_at = excluded.fetched_at;
      n := n + 1;
    end loop;

    -- Re-assert the pegs on every pass. USDT is the unit everything is quoted in
    -- and is defined as 1; letting its timestamp age out is how a working feed
    -- ends up refusing USDT->X swaps.
    insert into public.prices (symbol, price_usdt, source, fetched_at)
    select symbol, fixed_price, 'fixed', now()
      from public.price_feed_config
     where enabled
       and fixed_price is not null
    on conflict (symbol) do update
       set price_usdt = excluded.price_usdt,
           source     = excluded.source,
           fetched_at = excluded.fetched_at;

    update public.price_fetch_queue
       set ok = (n > 0),
           rows_written = n,
           error = case when n = 0 then 'no usable rows in response' else null end
     where request_id = new.id;

  exception when others then
    begin
      update public.price_fetch_queue
         set ok = false, error = left(sqlerrm, 300)
       where request_id = new.id;
    exception when others then
      null;   -- nothing left to do, and raising here would be worse
    end;
  end;

  return new;
end $$;

comment on function public.on_price_feed_response() is
  'Trigger on net._http_response. Writes Binance prices into public.prices. Ignores responses that are not the price feed.';

drop trigger if exists on_price_feed_response_tg on net._http_response;
create trigger on_price_feed_response_tg
  after insert on net._http_response
  for each row
  execute function public.on_price_feed_response();


-- ---------------------------------------------------------------------------
--  Health, for when someone asks why the exchange says the price is too old
-- ---------------------------------------------------------------------------
create or replace function public.price_feed_health()
returns table (
  feed_alive    boolean,
  newest_age_sec integer,
  oldest_age_sec integer,
  tracked       integer,
  quoted        integer,
  fresh         integer,
  requests      integer,
  failed        integer,
  last_ok       timestamptz,
  last_error    text
)
language sql
stable
as $$
  with ages as (
    select round(extract(epoch from (now() - fetched_at)))::int as age
      from public.prices
  ),
  recent as (
    select ok, count(*)::int as c
      from public.price_fetch_queue
     where requested_at > now() - interval '1 hour'
     group by ok
  )
  select
    coalesce(min(age) < 180, false)                       as feed_alive,
    coalesce(min(age), -1)                                as newest_age_sec,
    coalesce(max(age), -1)                                as oldest_age_sec,
    (select count(*)::int from public.price_feed_config where enabled) as tracked,
    (select count(*)::int from public.price_feed_config where enabled and binance_pair is not null) as quoted,
    (select count(*)::int from public.prices where fetched_at > now() - interval '180 seconds') as fresh,
    (select coalesce(sum(c), 0) from recent)              as requests,
    (select coalesce(sum(c), 0) from recent where ok is false) as failed,
    (select max(requested_at) from public.price_fetch_queue where ok) as last_ok,
    (select error from public.price_fetch_queue
      where error is not null order by requested_at desc limit 1) as last_error
    from ages;
$$;

comment on function public.price_feed_health() is
  'Is the server price feed alive? feed_alive is false once any price is older than 3 minutes, the point at which the exchange starts refusing to swap.';


-- ---------------------------------------------------------------------------
--  Run it every minute
-- ---------------------------------------------------------------------------
--  A named job is unscheduled first so re-running this file does not leave two
--  jobs writing prices.
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'binance-price-feed';

select cron.schedule(
  'binance-price-feed',
  '* * * * *',
  $$select public.kick_price_feed();$$
);

grant execute on function public.kick_price_feed()   to service_role;
grant execute on function public.price_feed_health() to anon, authenticated, service_role;

commit;
