-- Per-browser subscriptions for this copy of the dispatch application only.
-- API handlers use the service role after checking the authenticated actor.
create unique index if not exists motorist_profiles_organization_id_id_push_idx
  on public.motorist_profiles (organization_id, id);

create table public.motorist_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null,
  endpoint text not null unique check (length(endpoint) between 20 and 2048),
  p256dh text not null check (length(p256dh) between 86 and 90),
  auth text not null check (length(auth) between 22 and 24),
  sound_enabled boolean not null default true,
  expires_at timestamptz,
  last_test_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, profile_id)
    references public.motorist_profiles (organization_id, id) on delete cascade
);

create index motorist_push_subscriptions_recipient_idx
  on public.motorist_push_subscriptions (organization_id, profile_id);

alter table public.motorist_push_subscriptions enable row level security;
-- Endpoint and auth keys are credentials: no direct browser access or policies.
revoke all on public.motorist_push_subscriptions from anon, authenticated;
grant all on public.motorist_push_subscriptions to service_role;

create trigger push_subscriptions_updated_at before update on public.motorist_push_subscriptions
  for each row execute function public.motorist_set_updated_at();
