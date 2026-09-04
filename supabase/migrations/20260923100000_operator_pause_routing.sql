-- Per-operator fallback used only while that operator is manually paused.
-- The ring engine freezes the resolved destination into each new call, so a
-- settings edit never moves a call that is already ringing.

alter table public.motorist_operator_telephony_settings
  add column if not exists default_mobile_number text,
  add column if not exists pause_routing_mode text not null default 'none',
  add column if not exists pause_forward_profile_id uuid references public.motorist_profiles(id) on delete set null,
  add column if not exists pause_forward_number text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'operator_settings_pause_routing_mode_check'
      and conrelid = 'public.motorist_operator_telephony_settings'::regclass
  ) then
    alter table public.motorist_operator_telephony_settings
      add constraint operator_settings_pause_routing_mode_check
      check (pause_routing_mode in ('none', 'default_mobile', 'external_number', 'operator'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'operator_settings_default_mobile_e164_check'
      and conrelid = 'public.motorist_operator_telephony_settings'::regclass
  ) then
    alter table public.motorist_operator_telephony_settings
      add constraint operator_settings_default_mobile_e164_check
      check (default_mobile_number is null or default_mobile_number ~ '^[+][1-9][0-9]{6,14}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'operator_settings_pause_forward_e164_check'
      and conrelid = 'public.motorist_operator_telephony_settings'::regclass
  ) then
    alter table public.motorist_operator_telephony_settings
      add constraint operator_settings_pause_forward_e164_check
      check (pause_forward_number is null or pause_forward_number ~ '^[+][1-9][0-9]{6,14}$');
  end if;
end $$;

create index if not exists operator_settings_pause_forward_profile_idx
  on public.motorist_operator_telephony_settings (pause_forward_profile_id)
  where pause_forward_profile_id is not null;

comment on column public.motorist_operator_telephony_settings.pause_routing_mode is
  'Fallback selected for new ring-plan offers while this operator is paused; ignored in every other presence state.';
