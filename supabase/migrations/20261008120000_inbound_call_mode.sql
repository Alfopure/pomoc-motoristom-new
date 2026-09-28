-- Keep existing calls ringing by default; admins can opt into manual queue pickup.
alter table public.motorist_telephony_settings
  add column if not exists inbound_call_mode text not null default 'ring_first';

alter table public.motorist_telephony_settings
  drop constraint if exists motorist_telephony_settings_inbound_call_mode_check;

alter table public.motorist_telephony_settings
  add constraint motorist_telephony_settings_inbound_call_mode_check
  check (inbound_call_mode in ('ring_first', 'queue_first'));

comment on column public.motorist_telephony_settings.inbound_call_mode is
  'ring_first offers inbound calls to operators; queue_first lets operators select them from the waiting room.';
