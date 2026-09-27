-- Apply after 21. Additive only: no table, column, balance, contract, user or
-- investment row is touched, and it changes no existing function.
--
-- What this fixes
--   An AI Quant plan's day was only ever settled by one of two callers:
--
--     1. scripts/settle-everything.mjs, via settle_due_investments()
--     2. an operator pressing the button on admin-quants.html, via
--        settle_investment_day()
--
--   settle_due_investments() is granted to service_role, so no browser can reach
--   it, and no user page called the other one. Nothing in the database ever ran it
--   on a schedule. So a member who closed their browser got no daily credit unless
--   that one Node process happened to be running, and the balance was simply wrong
--   until it next ran. Arrears were never lost - the function pays every day whose
--   due_at has passed, so one late sweep pays the whole gap - but the member saw a
--   wrong balance in the meantime, which on a savings product is not acceptable.
--
--   This puts the sweep in Postgres itself, on pg_cron. It needs no server, no
--   Node process, no browser and no operator. The plan's rate and every per-day
--   amount are drawn once when the member opens the plan and stored on the row, so
--   settling a day is arithmetic the database can already do unaided: that is what
--   makes a plan settleable from a cron job with no external input.
--
--   Trades are deliberately NOT scheduled here. settle_due_contracts needs a live
--   exit price for each open market, and Postgres cannot reach Binance's API, so a
--   trade still needs scripts/settle-everything.mjs (or the member's own trade
--   page, which settles from the price it is displaying). Scheduling that from
--   here would settle trades at a stale or invented price, which pays real money
--   to the wrong side. Leave trades to the runner.
--
-- ---------------------------------------------------------------------------
-- The function is idempotent and locks rows with skip locked, so running it every
-- five minutes cannot pay a day twice and two runs cannot take the same plan. The
-- interval changes how promptly a member is paid, never how much.
--
-- To stop it, or change the interval:
--   select cron.unschedule('trust_settle_due_investments');
--   select cron.schedule('trust_settle_due_investments', '*/15 * * * *',
--                         $$select public.settle_due_investments()$$);
--
-- Re-running this file replaces the job rather than adding a second one.

begin;

-- ---------------------------------------------------------------------------
-- 1. The extension. pg_cron is available on Supabase projects, but not on every
--    self-hosted Postgres, and this file must not fail where it is missing - a
--    migration that aborts takes the whole deployment with it.
-- ---------------------------------------------------------------------------
do $$
begin
  -- execute, not a bare CREATE EXTENSION: a utility command run directly in a
  -- plpgsql block is not reliable across versions, and this has to be harmless
  -- wherever it fails.
  execute 'create extension if not exists pg_cron';
exception
  when insufficient_privilege then
    raise notice 'pg_cron: not permitted for this role, unattended AI settlement not scheduled';
  when undefined_file then
    raise notice 'pg_cron: extension not installed on this server, unattended AI settlement not scheduled';
  when others then
    raise notice 'pg_cron: could not be enabled (%), unattended AI settlement not scheduled', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Schedule it, only if there is something to schedule and somewhere to
--    schedule it.
-- ---------------------------------------------------------------------------
do $cron$
declare
  v_jobname constant text := 'trust_settle_due_investments';
begin
  -- Nothing to run. settle_due_investments arrives with migration 18; a project
  -- that has not applied it yet would get a job that failed into the log every
  -- five minutes forever.
  if to_regprocedure('public.settle_due_investments()') is null then
    raise notice 'settle_due_investments() is not present yet - apply migration 18 and re-run this file';
    return;
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not enabled, so unattended AI settlement was not scheduled';
    return;
  end if;

  -- Older pg_cron has no named schedule(), so the job is removed by id first.
  -- Naming it is what keeps a re-run from installing a second copy: a second
  -- copy is not harmless-looking, it is two sweeps racing over the same plans.
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(j.jobid)
      from cron.job j
     where j.jobname = v_jobname;
  end if;

  perform cron.schedule(v_jobname, '*/5 * * * *', 'select public.settle_due_investments()');
  raise notice 'scheduled % every 5 minutes', v_jobname;
exception
  when undefined_function then
    -- The % matters: RAISE takes one argument per % in the string and raises
    -- "too many parameters specified" at compile time if handed an extra one.
    raise notice 'this pg_cron has no named schedule(); schedule the job by hand in the Supabase SQL editor instead (%)', sqlerrm;
  when others then
    -- Losing the schedule is not worth losing the deployment over: the runner
    -- still settles, just only while it is running.
    raise notice 'could not schedule unattended AI settlement (%), so the settlement runner is still required', sqlerrm;
end $cron$;

commit;
