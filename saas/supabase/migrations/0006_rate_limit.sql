-- 0006_rate_limit.sql
-- Request throttling, in the database, because that is where the shared counter
-- already is.
--
-- The alternative designs were considered and rejected:
--   - an in-process counter is decoration on a serverless platform, where the
--     next request may run in a different instance
--   - Redis would be a new piece of infrastructure bought for one counter
--   - platform rate limiting is real but deployment-specific, and there is no
--     deployment yet to configure
--
-- This costs one row write per request and no new dependency. It is a fixed
-- window rather than a sliding one: a caller can burst up to 2x the limit across
-- a window boundary, which is an acceptable trade for an atomic single-statement
-- implementation. The comment is here so that trade is a decision rather than a
-- surprise.

create table rate_limit_counters (
  -- 'key:<uuid>' or 'org:<uuid>'. Not a foreign key: this table is written on
  -- the request path and must not take a lock on api_keys, and a counter for a
  -- credential deleted mid-window is harmless.
  subject       text primary key,
  window_start  timestamptz not null,
  count         integer not null default 0,
  updated_at    timestamptz not null default now()
);

-- No policy is created below, deliberately. The application role reaches this
-- table only through the security-definer function, so a caller cannot read
-- another organization's request volume — which would be a small but real
-- business-intelligence leak.
alter table rate_limit_counters enable row level security;
alter table rate_limit_counters force row level security;

-- Atomic consume-and-report. One statement, so two concurrent requests cannot
-- both read the same count and both decide they are under the limit.
create or replace function app.consume_rate_limit(
  p_subject text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, used integer, limit_value integer, reset_at timestamptz)
language plpgsql volatile security definer set search_path = public, pg_temp as $FN$
declare
  bucket timestamptz;
  new_count integer;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'rate limit and window must be positive';
  end if;

  -- Floor now() to the window, so every caller in the same window shares a key.
  bucket := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into rate_limit_counters as c (subject, window_start, count)
       values (p_subject, bucket, 1)
  on conflict (subject) do update set
       -- A stale window resets rather than accumulating forever.
       window_start = case when c.window_start < bucket then bucket else c.window_start end,
       count        = case when c.window_start < bucket then 1 else c.count + 1 end,
       updated_at   = now()
  returning c.count into new_count;

  return query select new_count <= p_limit, new_count, p_limit, bucket + make_interval(secs => p_window_seconds);
end $FN$;

revoke all on function app.consume_rate_limit(text, integer, integer) from public;
grant execute on function app.consume_rate_limit(text, integer, integer) to revenue_swarm_app;

-- Housekeeping. Counters for windows long past are dead weight; nothing depends
-- on them, so a periodic call is enough and no scheduler is required for
-- correctness.
create or replace function app.prune_rate_limit_counters(p_older_than interval default interval '1 day')
returns integer
language plpgsql volatile security definer set search_path = public, pg_temp as $FN$
declare removed integer;
begin
  delete from rate_limit_counters where window_start < now() - p_older_than;
  get diagnostics removed = row_count;
  return removed;
end $FN$;

revoke all on function app.prune_rate_limit_counters(interval) from public;
grant execute on function app.prune_rate_limit_counters(interval) to revenue_swarm_app;
