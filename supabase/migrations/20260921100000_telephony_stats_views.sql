-- Phase 4 stage 4: the two statistics views the wallboard and the report
-- widgets read (design §4 Phase 4, plan "wallboard ... nad view z fázy 4").
--
-- Why views and not browser arithmetic: the wallboard is a wall display that
-- several screens keep open all day, and the reports view asks the same
-- questions. Shipping every raw `motorist_calls` row to each of them to be
-- counted in JavaScript would move the whole day's call log over the wire many
-- times per minute, and every reader would be free to invent its own
-- definition of "answered". The definitions therefore live here, once.
--
-- Both views are grouped by the *local* calendar day (Europe/Bratislava, the
-- organisation's only timezone), not by UTC: a shift that ends at 01:00 local
-- belongs to the day the dispatcher worked, and "prijaté dnes" on the
-- wallboard has to mean the same thing as the wall clock behind it.
--
-- `security_invoker = on` makes the views run with the *reader's* rights, so
-- the row-level policies on `motorist_calls` and `motorist_operator_statuses`
-- still decide what is visible. Nothing but the service role is granted select
-- today (the application reads them through `/api/telephony/stats`, which does
-- its own role check), but the flag means a later `grant select ... to
-- authenticated` cannot accidentally turn a view into an organisation-wide
-- data leak.
--
-- Cost note: a query with `where organization_id = … and day = …` is pushed
-- down into the grouped scan (the predicate is on grouping columns), but the
-- day expression is `stable`, not `immutable`, so it cannot be indexed and the
-- scan is bounded by the organisation, not by the day. That is why
-- `src/server/telephony/stats.ts` reads these views behind a short-lived
-- per-organisation cache instead of once per open wallboard.

-- ---------------------------------------------------------------------------
-- 1. Daily call statistics
-- ---------------------------------------------------------------------------
--
-- One row per organisation / local day / direction / operator. The consumer
-- sums the rows it needs, which keeps the operator breakdown and the
-- organisation total in one round trip and guarantees they agree.
--
-- Definitions (the same ones `src/lib/telephony/wallboard.ts` applies to raw
-- rows on the fallback path, kept in step by `stats.test.ts`):
--   * answered            — `answered_at` is set; an operator spoke to them
--   * unanswered          — the call ended and nobody ever answered it
--   * system_handled      — unanswered because the app closed the call on
--                           purpose: outside business hours, after the caller
--                           asked to be rung back, after an IVR closing
--                           message, or when every operator was busy. Those
--                           callers were served, so they must not count as
--                           abandoned
--   * abandoned           — the rest of the unanswered calls: the caller hung
--                           up while we were still trying to reach a human
--   * answered_within_20s — the service level from the plan (< 20 s)
--
-- `answer_seconds` prefers the timestamps over the stored `wait_seconds`
-- column, matching `callWaitSeconds` in `src/lib/reporting.ts`; the column is
-- written at several points in a call's life and can be a stale zero.

drop view if exists public.motorist_call_stats_daily;

create view public.motorist_call_stats_daily
with (security_invoker = on) as
with base as (
  select
    c.organization_id,
    (c.started_at at time zone 'Europe/Bratislava')::date as day,
    c.direction,
    c.operator_id,
    (c.answered_at is not null) as answered,
    (c.ended_at is not null) as completed,
    coalesce(c.end_reason, '') as end_reason,
    case
      when c.answered_at is null then null
      when c.answered_at >= c.started_at then extract(epoch from (c.answered_at - c.started_at))
      else nullif(greatest(coalesce(c.wait_seconds, 0), 0), 0)::numeric
    end as answer_seconds,
    greatest(coalesce(c.duration_seconds, 0), 0)::numeric as talk_seconds
  from public.motorist_calls c
  where c.started_at is not null
)
select
  base.organization_id,
  base.day,
  base.direction,
  base.operator_id,
  count(*)::bigint as calls,
  count(*) filter (where base.answered)::bigint as answered,
  count(*) filter (where not base.answered and base.completed)::bigint as unanswered,
  count(*) filter (
    where not base.answered
      and base.completed
      and base.end_reason = any (array['after_hours', 'callback_requested', 'ivr_message', 'all_busy'])
  )::bigint as system_handled,
  count(*) filter (
    where not base.answered
      and base.completed
      and base.end_reason <> all (array['after_hours', 'callback_requested', 'ivr_message', 'all_busy'])
  )::bigint as abandoned,
  count(*) filter (where base.answered and base.answer_seconds is not null)::bigint as answered_with_wait,
  count(*) filter (where base.answered and base.answer_seconds is not null and base.answer_seconds <= 20)::bigint as answered_within_20s,
  coalesce(sum(base.answer_seconds) filter (where base.answered), 0)::numeric as answer_seconds_total,
  coalesce(sum(base.talk_seconds) filter (where base.answered), 0)::numeric as talk_seconds
from base
group by base.organization_id, base.day, base.direction, base.operator_id;

comment on view public.motorist_call_stats_daily is
  'Denné štatistiky hovorov (miestny deň Europe/Bratislava) pre wallboard a reporty. Číta sa cez /api/telephony/stats.';

-- ---------------------------------------------------------------------------
-- 2. Operator status durations
-- ---------------------------------------------------------------------------
--
-- `motorist_operator_statuses` is an interval log: `appendPresenceHistory`
-- closes the open row and opens a new one on every presence change. This view
-- turns it into "how long did each operator spend in each status today".
--
-- An interval that is still open counts up to `now()`, which is what a live
-- wallboard needs. An interval is attributed in full to the day it *started*,
-- so an overnight pause is not split; the alternative (generate_series over
-- day boundaries) buys precision nobody reads on a shift that ends at 22:00.

drop view if exists public.motorist_operator_status_durations;

create view public.motorist_operator_status_durations
with (security_invoker = on) as
select
  s.organization_id,
  s.profile_id,
  (s.started_at at time zone 'Europe/Bratislava')::date as day,
  s.status,
  count(*)::bigint as entries,
  coalesce(
    sum(greatest(extract(epoch from (coalesce(s.ended_at, pg_catalog.now()) - s.started_at)), 0)),
    0
  )::numeric as seconds,
  max(s.started_at) as last_started_at,
  max(s.started_at) filter (where s.ended_at is null) as open_since
from public.motorist_operator_statuses s
group by s.organization_id, s.profile_id, (s.started_at at time zone 'Europe/Bratislava')::date, s.status;

comment on view public.motorist_operator_status_durations is
  'Čas strávený v jednotlivých stavoch operátora za miestny deň; otvorený interval sa počíta do now().';

-- ---------------------------------------------------------------------------
-- 3. Grants — service role only
-- ---------------------------------------------------------------------------
--
-- The browser never reads these through PostgREST; `/api/telephony/stats`
-- checks the role (senior dispatcher and above) and answers with a derived
-- payload. Keeping the grant narrow means the statistics cannot be pulled
-- number-by-number from a session token.

revoke all on table public.motorist_call_stats_daily from public, anon, authenticated;
revoke all on table public.motorist_operator_status_durations from public, anon, authenticated;

grant select on table public.motorist_call_stats_daily to service_role;
grant select on table public.motorist_operator_status_durations to service_role;

-- ---------------------------------------------------------------------------
-- 4. Supporting index
-- ---------------------------------------------------------------------------
--
-- Used by the fallback path in `stats.ts` (which asks for one day of raw calls
-- by timestamp range while these views are not applied yet) and by the report
-- dashboard's range queries. The view's own `day` predicate cannot use it —
-- `timestamptz at time zone text` is `stable`, so no expression index on it is
-- possible — which is the reason the stats route caches.

create index if not exists calls_org_started_at_idx
  on public.motorist_calls (organization_id, started_at desc);
