-- Per-device choices for task and call pushes in the separate Telnyx copy.
-- Existing opt-in subscriptions keep task notifications and gain call categories.
-- This is additive only: no endpoints, credentials, RLS or telephony routing change.
alter table public.motorist_push_subscriptions
  add column if not exists task_notifications_enabled boolean not null default true,
  add column if not exists incoming_calls_enabled boolean not null default true,
  add column if not exists available_calls_enabled boolean not null default true;

comment on column public.motorist_push_subscriptions.task_notifications_enabled
  is 'Send task assignments and reminders to this browser subscription.';
comment on column public.motorist_push_subscriptions.incoming_calls_enabled
  is 'Send pushes for an incoming call offered to this operator.';
comment on column public.motorist_push_subscriptions.available_calls_enabled
  is 'Send pushes for eligible waiting calls this operator may pick up.';
