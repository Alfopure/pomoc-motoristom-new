# Read-only measurement queries (PostgreSQL 17, Supabase copy `ifpaeegaesdmljfkdvcn` only)

All statements are SELECT only. Run them in the SQL editor of THIS copy's project or through a read-only session. Column names verified against `supabase/migrations/20260903100000_telnyx_telephony_foundation.sql`, `20260520192000_foundation_schema.sql`, `20260929190000_webhook_retry_contract.sql`, `20260929200000_fenced_telephony_commands.sql` on origin/main f8cb071. Replace the interval as needed. Percentiles need ≥30 rows to be quoted as a p95.

## A. Inbound: operator answered → bridge confirmed (the number the client feels)

```sql
with legs as (
  select s.id as session_id, s.started_at, s.writer_contract, l.profile_id,
         l.answered_at, l.bridged_at,
         extract(epoch from (l.bridged_at - l.answered_at)) as answer_to_bridge_s
  from public.motorist_call_legs l
  join public.motorist_call_sessions s on s.id = l.session_id
  where s.direction = 'inbound' and l.role = 'operator' and l.answered_at is not null
    and s.started_at >= now() - interval '7 days'
)
select count(*) as n,
       count(*) filter (where bridged_at is null) as bridge_unconfirmed,
       percentile_cont(0.5) within group (order by answer_to_bridge_s) as p50_s,
       percentile_cont(0.95) within group (order by answer_to_bridge_s) as p95_s,
       max(answer_to_bridge_s) as max_s,
       count(*) filter (where writer_contract = 2) as contract2_rows
from legs;
-- per-call detail: select * from legs order by started_at desc;
```

## B. Outbound: click → operator leg → customer leg → bridge

```sql
select s.id, s.started_at,
       min(o.initiated_at) as operator_leg_initiated,
       min(o.answered_at)  as operator_answered,
       min(c.initiated_at) as customer_leg_initiated,
       min(c.answered_at)  as customer_answered,
       min(c.bridged_at)   as customer_bridged,
       extract(epoch from (min(c.initiated_at) - s.started_at)) as start_to_customer_dial_s,
       extract(epoch from (min(c.bridged_at) - min(c.answered_at))) as customer_answer_to_bridge_s
from public.motorist_call_sessions s
left join public.motorist_call_legs o on o.session_id = s.id and o.role = 'operator'
left join public.motorist_call_legs c on c.session_id = s.id and c.role = 'customer'
where s.direction = 'outbound' and s.started_at >= now() - interval '7 days'
group by s.id, s.started_at
order by s.started_at desc;
```

## C. Webhook runner timing per event type (lease wait, processing) from the app's own audit rows

```sql
select event_type,
       count(*) as n,
       percentile_cont(0.5) within group (order by (normalized_payload->'timing'->>'lease_wait_ms')::numeric) as lease_wait_p50_ms,
       percentile_cont(0.95) within group (order by (normalized_payload->'timing'->>'lease_wait_ms')::numeric) as lease_wait_p95_ms,
       percentile_cont(0.5) within group (order by (normalized_payload->'timing'->>'processing_ms')::numeric) as processing_p50_ms,
       percentile_cont(0.95) within group (order by (normalized_payload->'timing'->>'processing_ms')::numeric) as processing_p95_ms,
       max((normalized_payload->'timing'->>'processing_ms')::numeric) as processing_max_ms
from public.motorist_call_events
where received_at >= now() - interval '7 days'
  and normalized_payload ? 'timing'
group by event_type
order by n desc;
```

## D. Per-command effect time (bridge, dial, hangup, playback_stop, conference_*) — whole effect incl. DB checkpoints, not provider RTT

```sql
select cmd->>'kind' as kind, cmd->>'phase' as phase,
       count(*) as n,
       count(*) filter (where (cmd->>'ok')::boolean = false) as failed,
       percentile_cont(0.5) within group (order by (cmd->>'effect_ms')::numeric) as p50_ms,
       percentile_cont(0.95) within group (order by (cmd->>'effect_ms')::numeric) as p95_ms,
       max((cmd->>'effect_ms')::numeric) as max_ms
from public.motorist_call_events e,
     jsonb_array_elements(e.normalized_payload->'commands') as cmd
where e.received_at >= now() - interval '7 days' and cmd ? 'effect_ms'
group by 1, 2
order by n desc;
```

## E. Controls: app request → first provider command dispatched (hold, transfer, consult, add party, hangup)

```sql
select e.event_type, e.received_at,
       e.normalized_payload->>'session_id' as session_id,
       min(p.first_dispatched_at) as first_provider_dispatch,
       extract(epoch from (min(p.first_dispatched_at) - e.received_at)) as request_to_dispatch_s
from public.motorist_call_events e
left join public.motorist_provider_commands p
       on p.session_id = (e.normalized_payload->>'session_id')::uuid
      and p.first_dispatched_at >= e.received_at
      and p.first_dispatched_at <  e.received_at + interval '60 seconds'
where e.event_type in ('app.hold','app.unhold','app.blind_transfer','app.consult','app.complete_transfer','app.add_party','app.hangup','app.pickup')
  and e.received_at >= now() - interval '7 days'
group by e.id, e.event_type, e.received_at, e.normalized_payload
order by e.received_at desc;
```

(`motorist_provider_commands` exists only for contract-2 sessions; older sessions show NULL.)

## F. Webhook ledger health: deliveries, deferrals, failures, dead letters, ack latency

```sql
select date_trunc('hour', received_at) as hour,
       count(*) as events,
       sum(delivery_count) as deliveries,
       sum(deferral_count) as deferrals,
       sum(effect_failure_count) as effect_failures,
       count(*) filter (where retry_state = 'dead_letter') as dead_letters,
       count(*) filter (where retry_state = 'awaiting_correlation') as awaiting_correlation,
       count(*) filter (where status = 'failed') as failed,
       percentile_cont(0.5) within group (order by extract(epoch from (processed_at - received_at))) as ack_p50_s,
       percentile_cont(0.95) within group (order by extract(epoch from (processed_at - received_at))) as ack_p95_s
from public.motorist_telnyx_webhook_events
where received_at >= now() - interval '7 days'
group by 1 order by 1 desc;
```

## G. Termination: stop intent → customer leg ended (contract 2)

```sql
select s.id, s.termination_requested_at, c.ended_at,
       extract(epoch from (c.ended_at - s.termination_requested_at)) as intent_to_customer_end_s
from public.motorist_call_sessions s
join public.motorist_call_legs c on c.session_id = s.id and c.role = 'customer'
where s.termination_requested_at is not null and s.started_at >= now() - interval '7 days'
order by s.termination_requested_at desc;
```

## H. Provider command outcomes (unknown / rejected / rate limited)

```sql
select path, outcome, count(*) as n
from public.motorist_provider_commands p
join public.motorist_call_sessions s on s.id = p.session_id
where s.started_at >= now() - interval '7 days'
group by 1, 2 order by 1, 2;
```

## I. Ring fan-out: first vs last member offered per step (serial dial cost)

```sql
select session_id, step_index, count(*) as members,
       min(offered_at) as first_offer, max(offered_at) as last_offer,
       extract(epoch from (max(offered_at) - min(offered_at))) as first_to_last_offer_s
from public.motorist_ring_attempts
where offered_at is not null and created_at >= now() - interval '7 days'
group by session_id, step_index
having count(*) > 1
order by first_to_last_offer_s desc;
```

## J. Per-request round-trip latency (Vercel logs, not SQL)

`request-performance` log lines (src/server/request-metrics.ts) carry `steps.db.count` and `steps.db.ms` per request. Average DB round trip = `db.ms / db.count`. Query in Vercel Observability: message contains `request-performance` and route in (`call.action`, `call.webhook`, `call.start`). Also `telnyx-http` lines carry provider `ms` per command.
