alter table public.motorist_sms_messages
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists retry_count integer not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.motorist_sms_messages'::regclass
      and conname = 'sms_messages_retry_count_check'
  ) then
    alter table public.motorist_sms_messages
      add constraint sms_messages_retry_count_check
      check (retry_count >= 0);
  end if;
end $$;

create unique index if not exists sms_messages_idempotency_idx
  on public.motorist_sms_messages (organization_id, provider, idempotency_key)
  where idempotency_key is not null;

create index if not exists sms_messages_outbox_claim_idx
  on public.motorist_sms_messages (organization_id, status, next_attempt_at, created_at)
  where direction = 'outbound'
    and status = 'queued';

create table if not exists public.motorist_sms_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  sms_message_id uuid not null references public.motorist_sms_messages(id) on delete cascade,
  provider text not null default 'viptel_sms',
  attempt_number integer not null check (attempt_number >= 1),
  claim_id uuid not null default gen_random_uuid(),
  idempotency_key text not null,
  request_fingerprint text not null,
  status text not null check (status in ('queued', 'sending', 'accepted', 'failed', 'skipped')),
  provider_status_code integer,
  provider_message_id text,
  request_payload_safe jsonb not null default '{}'::jsonb,
  provider_response_safe jsonb not null default '{}'::jsonb,
  error_class text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sms_attempts_message_attempt_number_idx
  on public.motorist_sms_attempts (sms_message_id, attempt_number);

create index if not exists sms_attempts_idempotency_idx
  on public.motorist_sms_attempts (organization_id, provider, idempotency_key, created_at desc);

create index if not exists sms_attempts_status_idx
  on public.motorist_sms_attempts (organization_id, provider, status, created_at desc);

create index if not exists sms_attempts_provider_message_idx
  on public.motorist_sms_attempts (organization_id, provider, provider_message_id)
  where provider_message_id is not null;

alter table public.motorist_sms_attempts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'motorist_sms_attempts'
      and policyname = 'motorist_sms_attempts_organization_access'
  ) then
    create policy motorist_sms_attempts_organization_access
      on public.motorist_sms_attempts
      for all
      using (app_private.motorist_is_org_member(organization_id))
      with check (app_private.motorist_is_org_member(organization_id));
  end if;
end $$;

drop trigger if exists sms_attempts_updated_at on public.motorist_sms_attempts;
create trigger sms_attempts_updated_at before update on public.motorist_sms_attempts
  for each row execute function public.motorist_set_updated_at();
