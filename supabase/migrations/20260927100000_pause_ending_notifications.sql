-- One account-wide switch gates both in-app and Web Push pause-ending warnings.
-- Absence of a preference row remains opt-in by default for existing operators.
alter table public.motorist_call_notification_preferences
  add column if not exists pause_ending_enabled boolean not null default true;

comment on column public.motorist_call_notification_preferences.pause_ending_enabled
  is 'Create an in-app warning and send Web Push one minute before a timed pause reaches its configured maximum.';

notify pgrst, 'reload schema';
