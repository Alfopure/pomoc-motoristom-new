-- What was said on a demo call, and the shape of the exchange.
--
-- `latency_probe` holds milliseconds and a direction; it deliberately holds no
-- words. Evaluating a demo — was she quick, did she talk over anybody, where
-- did she go quiet — needs the words too, and it is a different decision from
-- measuring latency. So it is a separate column, written only when
-- `AI_DEMO_STORE_TRANSCRIPT` is on, and the runbook says what that means.
--
-- Both columns cover the opening of the call only. Without a process running
-- for its whole length there is nothing listening after that, and this is the
-- one place where that limit is visible to whoever reads the data.

begin;

alter table public.motorist_ai_demo_attempts
  add column if not exists transcript jsonb,
  add column if not exists conversation_stats jsonb;

comment on column public.motorist_ai_demo_attempts.transcript is
  'Opening-of-call transcript as [{ms, dir, text}]; null unless transcript storage was enabled for that call.';
comment on column public.motorist_ai_demo_attempts.conversation_stats is
  'Turn counts, speaking time per side, overlaps, longest silence and backchannel count for the opening of the call.';

commit;
