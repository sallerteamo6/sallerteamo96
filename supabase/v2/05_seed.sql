-- ===========================================================================
--  Seed data
-- ===========================================================================
--  Reference data only. No user accounts and no credentials: the first
--  administrator is promoted by hand after signup, with
--      select public.promote_first_admin('<your-email>');
--  so there is no hard-coded credential in this repository. See 06_auth.sql.
-- ===========================================================================

begin;

-- Tradable markets. payout_pct here is only the default for a product added by
-- hand; the rate actually charged is product_durations.payout_pct, which is 20%
-- for 60s, 30% for 120s and 40% for 300s. price_symbol is the pair the
-- settlement runner quotes to decide the outcome.
insert into public.products (symbol, name, price_symbol, payout_pct, min_amount, quote_coin, sort_order) values
  ('BTC',  'Bitcoin',      'BTCUSDT',  30, 10, 'USDT', 1),
  ('ETH',  'Ethereum',     'ETHUSDT',  30, 10, 'USDT', 2),
  ('SOL',  'Solana',       'SOLUSDT',  30, 10, 'USDT', 3),
  ('BNB',  'BNB',          'BNBUSDT',  30, 10, 'USDT', 4),
  ('XRP',  'XRP',          'XRPUSDT',  30, 10, 'USDT', 5),
  ('DOGE', 'Dogecoin',     'DOGEUSDT', 30, 10, 'USDT', 6),
  ('ADA',  'Cardano',      'ADAUSDT',  30, 10, 'USDT', 7),
  ('DOT',  'Polkadot',     'DOTUSDT',  30, 10, 'USDT', 8),
  ('LINK', 'Chainlink',    'LINKUSDT', 30, 10, 'USDT', 9),
  ('AVAX', 'Avalanche',    'AVAXUSDT', 30, 10, 'USDT', 10),
  ('TRX',  'TRON',         'TRXUSDT',  30, 10, 'USDT', 11),
  ('LTC',  'Litecoin',     'LTCUSDT',  30, 10, 'USDT', 12)
on conflict (symbol) do update
  set payout_pct   = excluded.payout_pct,
      min_amount   = excluded.min_amount,
      price_symbol = excluded.price_symbol,
      sort_order   = excluded.sort_order;

-- Contract durations per product, mirroring the durations the original app
-- offered (60s / 120s / 300s).
-- 60s = 20%, 120s = 30%, 300s = 40%. These are the profit margins shown on the
-- order form and paid on a win, and they are stated here rather than derived
-- from products.payout_pct so the number the site shows is the number charged.
insert into public.product_durations (product_id, seconds, payout_pct)
select p.id, d.seconds, d.payout
from public.products p
cross join (values
  (60::integer,  20::numeric),
  (120,           30),
  (300,           40)
) as d(seconds, payout)
on conflict (product_id, seconds) do update
  set payout_pct = excluded.payout_pct,
      is_active  = true;

-- AI Quant products.
insert into public.investment_products (code, name, period_days, rate_min, rate_max) values
  ('AIQ_7',  'AI Quant 7-Day',  7,  1.2, 3.5),
  ('AIQ_15', 'AI Quant 15-Day', 15, 2.0, 5.5),
  ('AIQ_30', 'AI Quant 30-Day', 30, 3.0, 8.0)
on conflict (code) do update
  set period_days = excluded.period_days,
      rate_min    = excluded.rate_min,
      rate_max    = excluded.rate_max;

-- Platform settings read by the pages before sign-in.
insert into public.app_settings (key, value) values
  ('site', '{"name":"Trust","defaultLanguage":"en","withdrawalFeeRate":0.02}'::jsonb),
  ('trading', '{"weekendTradingEnabled":false,"showCountdownStatus":true}'::jsonb),
  ('kyc', '{"advancedEnabled":true}'::jsonb)
on conflict (key) do update set value = excluded.value;

-- Deposit addresses. REPLACE THESE before launch: they are placeholders and
-- must be the wallets you actually control, or funds will go somewhere you
-- cannot recover them from.
insert into public.coin_addresses (coin, network, address, min_deposit, is_active) values
  ('USDT', 'TRC20', 'CHANGE_ME_TRC20_USDT_ADDRESS', 10, true),
  ('USDT', 'ERC20', 'CHANGE_ME_ERC20_USDT_ADDRESS', 10, true),
  ('BTC',  'BTC',   'CHANGE_ME_BTC_ADDRESS',         0.0001, true),
  ('ETH',  'ERC20', 'CHANGE_ME_ETH_ADDRESS',         0.005, true),
  ('TRX',  'TRC20', 'CHANGE_ME_TRX_ADDRESS',         10, true),
  ('SOL',  'SOL',   'CHANGE_ME_SOL_ADDRESS',         0.05, true),
  ('BNB',  'BEP20', 'CHANGE_ME_BNB_ADDRESS',         0.01, true)
on conflict (coin, network) do update
  set address     = excluded.address,
      min_deposit = excluded.min_deposit,
      is_active   = excluded.is_active;

commit;
