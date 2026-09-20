-- One probe per call.
--
-- The bridge webhook hands the call to a listener and falls back to listening
-- itself if that hand-off fails. A hand-off that times out is not a hand-off
-- that failed: the listener may be running already, and then both of them greet
-- the caller. It happened on a live call — she said hello twice.
--
-- A timestamp claimed with a conditional update is the whole fix: whoever sets
-- it runs the probe, the other returns.

begin;

alter table public.motorist_ai_demo_attempts
  add column if not exists probe_started_at timestamptz;

comment on column public.motorist_ai_demo_attempts.probe_started_at is
  'Claimed by whichever invocation runs the sideband probe; a second one finds it set and does nothing.';

commit;
