-- Additive: old web clients keep their existing credential and push preferences.
-- Mobile is deliberately absent from automatic SIP ring-plan queries.
create table public.motorist_operator_mobile_devices (
  like public.motorist_operator_devices including defaults including constraints,
  primary key (id),
  foreign key (organization_id) references public.motorist_organizations(id) on delete cascade,
  foreign key (profile_id) references public.motorist_profiles(id) on delete cascade,
  unique (organization_id, profile_id, environment)
);
create unique index operator_mobile_devices_sip_username_idx
  on public.motorist_operator_mobile_devices (environment, sip_username)
  where sip_username is not null;

alter table public.motorist_push_subscriptions
  add column client_kind text not null default 'unknown'
  check (client_kind in ('unknown', 'web', 'mobile_app'));

create table public.motorist_call_notification_preferences (
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  mobile_calls_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (organization_id, profile_id)
);

-- Authenticated, same-origin API only; never expose SIP credentials through RLS.
alter table public.motorist_operator_mobile_devices enable row level security;
alter table public.motorist_call_notification_preferences enable row level security;
revoke all on public.motorist_operator_mobile_devices from anon, authenticated;
revoke all on public.motorist_call_notification_preferences from anon, authenticated;
grant all on public.motorist_operator_mobile_devices to service_role;
grant all on public.motorist_call_notification_preferences to service_role;

notify pgrst, 'reload schema';
