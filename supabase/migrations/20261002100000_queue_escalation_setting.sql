-- ---------------------------------------------------------------------------
-- The queue escalation becomes the dispatcher's decision
-- ---------------------------------------------------------------------------
-- How long the waiting-room queue may find nobody to ring before it tries the
-- backup numbers once. It was `QUEUE_ESCALATE_AFTER_MS` in the reducer, and it
-- dials a real number and is billed — so it belongs to whoever pays for it,
-- not to the code.
--
--   0   the queue never escalates; the caller waits out `park_max_minutes`
--   120 the behaviour every row has today, which is why it is the default
--
-- Additive and backfilled by the default, so existing organisations keep
-- behaving exactly as they did the moment before this ran.

alter table public.motorist_telephony_settings
  add column if not exists queue_escalate_after_seconds integer not null default 120;

alter table public.motorist_telephony_settings
  drop constraint if exists motorist_telephony_settings_queue_escalate_check;

alter table public.motorist_telephony_settings
  add constraint motorist_telephony_settings_queue_escalate_check
  check (queue_escalate_after_seconds >= 0 and queue_escalate_after_seconds <= 1800);

comment on column public.motorist_telephony_settings.queue_escalate_after_seconds is
  'Seconds the queue may find nobody to ring before dialling the backup numbers once; 0 disables it.';
