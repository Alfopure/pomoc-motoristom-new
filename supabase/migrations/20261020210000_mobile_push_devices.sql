-- Push notifications of the native mobile app. Owner approval 2026-10-20:
-- TEST nzpnqdstvkfncflgqlny only; production needs a separate explicit approval.
-- One row per app installation; the Expo push token is a credential and is never
-- exposed to clients. Preferences hold the per-type switches from Účet.
-- Same composite key as the web push subscriptions; present wherever those exist.
create unique index if not exists motorist_profiles_organization_id_id_push_idx
  on public.motorist_profiles (organization_id, id);

create table public.motorist_mobile_push_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null,
  environment text not null check (environment in ('test', 'production')),
  installation_id uuid not null,
  expo_push_token text not null check (expo_push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$'),
  platform text not null check (platform in ('ios', 'android')),
  preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  app_version text check (app_version is null or length(app_version) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (organization_id, profile_id) references public.motorist_profiles (organization_id, id) on delete cascade,
  unique (environment, installation_id),
  unique (expo_push_token)
);

create index motorist_mobile_push_devices_recipient_idx
  on public.motorist_mobile_push_devices (organization_id, environment, profile_id);

alter table public.motorist_mobile_push_devices enable row level security;
-- Tokens are credentials: no direct browser or app access and no policies.
revoke all on public.motorist_mobile_push_devices from anon, authenticated;
grant all on public.motorist_mobile_push_devices to service_role;

notify pgrst, 'reload schema';
