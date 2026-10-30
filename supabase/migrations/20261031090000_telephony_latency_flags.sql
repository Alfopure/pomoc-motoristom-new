-- ---------------------------------------------------------------------------
-- Call-speed latency switches without a deploy (call-speed plan S0.1, M1)
-- ---------------------------------------------------------------------------
-- `src/server/telephony/latency-flags.ts` merges these over the deployment's
-- `TELEPHONY_LATENCY_FLAGS`, key by key, and reuses the result for five
-- seconds per instance. Unknown keys and wrong types are ignored there. Every
-- default is today's behaviour, and an empty object changes nothing.
--
-- Additive only: the application reads env alone while this column is absent,
-- through its own select, so the live-call gate never depends on it.
-- No function, grant or policy changes: the column inherits the table's RLS
-- and the 20260919100000 lock-down (organisation members may select; only the
-- service role writes), like `live_calls_enabled` next to it.
begin;

alter table public.motorist_telephony_settings
  add column if not exists latency_flags jsonb not null default '{}'::jsonb check (jsonb_typeof(latency_flags) = 'object');

comment on column public.motorist_telephony_settings.latency_flags is
  'Call-speed switches merged over TELEPHONY_LATENCY_FLAGS; {} keeps current behaviour. Semantic switches are frozen per call in metadata.start_mode.';

notify pgrst, 'reload schema';
commit;
