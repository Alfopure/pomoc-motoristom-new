create table if not exists public.motorist_task_reminders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_id uuid not null references public.motorist_cases(id) on delete cascade,
  task_id uuid not null references public.motorist_case_tasks(id) on delete cascade,
  recipient_profile_id uuid references public.motorist_profiles(id) on delete set null,
  visibility text not null default 'team' check (visibility in ('private', 'team')),
  channels text[] not null default array['in_app']::text[],
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  dedupe_key text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  last_attempt_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references public.motorist_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedupe_key)
);

create table if not exists public.motorist_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  case_id uuid references public.motorist_cases(id) on delete cascade,
  task_id uuid references public.motorist_case_tasks(id) on delete cascade,
  reminder_id uuid references public.motorist_task_reminders(id) on delete set null,
  recipient_profile_id uuid references public.motorist_profiles(id) on delete set null,
  visibility text not null default 'team' check (visibility in ('private', 'team')),
  kind text not null default 'task_due' check (kind in ('task_due', 'task_overdue', 'handover', 'system')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'urgent')),
  title text not null,
  body text,
  status text not null default 'unread' check (status in ('unread', 'read', 'archived')),
  delivery_status text not null default 'in_app' check (delivery_status in ('in_app', 'email_sent', 'email_failed', 'failed')),
  dedupe_key text not null,
  read_at timestamptz,
  archived_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedupe_key)
);

create index if not exists motorist_task_reminders_due_idx
  on public.motorist_task_reminders (organization_id, status, scheduled_for);

create index if not exists motorist_task_reminders_task_status_idx
  on public.motorist_task_reminders (organization_id, task_id, status);

create index if not exists motorist_task_reminders_recipient_idx
  on public.motorist_task_reminders (organization_id, recipient_profile_id, status);

create index if not exists motorist_notifications_recipient_status_idx
  on public.motorist_notifications (organization_id, recipient_profile_id, status, created_at desc);

create index if not exists motorist_notifications_team_status_idx
  on public.motorist_notifications (organization_id, visibility, status, created_at desc);

create index if not exists motorist_notifications_task_status_idx
  on public.motorist_notifications (organization_id, task_id, status);

alter table public.motorist_task_reminders enable row level security;
alter table public.motorist_notifications enable row level security;

drop policy if exists motorist_task_reminders_member_access on public.motorist_task_reminders;
create policy motorist_task_reminders_member_access
  on public.motorist_task_reminders
  for all
  using (app_private.motorist_is_org_member(organization_id))
  with check (app_private.motorist_is_org_member(organization_id));

drop policy if exists motorist_notifications_member_select on public.motorist_notifications;
create policy motorist_notifications_member_select
  on public.motorist_notifications
  for select
  using (
    app_private.motorist_is_org_member(organization_id)
    and (
      visibility = 'team'
      or exists (
        select 1
        from public.motorist_profiles profiles
        where profiles.id = recipient_profile_id
          and profiles.organization_id = motorist_notifications.organization_id
          and profiles.user_id = auth.uid()
          and profiles.active = true
      )
    )
  );

drop policy if exists motorist_notifications_member_insert on public.motorist_notifications;
create policy motorist_notifications_member_insert
  on public.motorist_notifications
  for insert
  with check (app_private.motorist_is_org_member(organization_id));

drop policy if exists motorist_notifications_member_update on public.motorist_notifications;
create policy motorist_notifications_member_update
  on public.motorist_notifications
  for update
  using (
    app_private.motorist_is_org_member(organization_id)
    and (
      visibility = 'team'
      or exists (
        select 1
        from public.motorist_profiles profiles
        where profiles.id = recipient_profile_id
          and profiles.organization_id = motorist_notifications.organization_id
          and profiles.user_id = auth.uid()
          and profiles.active = true
      )
    )
  )
  with check (
    app_private.motorist_is_org_member(organization_id)
    and (
      visibility = 'team'
      or exists (
        select 1
        from public.motorist_profiles profiles
        where profiles.id = recipient_profile_id
          and profiles.organization_id = motorist_notifications.organization_id
          and profiles.user_id = auth.uid()
          and profiles.active = true
      )
    )
  );

create trigger task_reminders_updated_at before update on public.motorist_task_reminders
  for each row execute function public.motorist_set_updated_at();

create trigger notifications_updated_at before update on public.motorist_notifications
  for each row execute function public.motorist_set_updated_at();
