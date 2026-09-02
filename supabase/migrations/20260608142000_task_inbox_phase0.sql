alter table public.motorist_case_tasks
  add column if not exists priority text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  add column if not exists kind text not null default 'other' check (kind in ('callback', 'sms', 'dispatch', 'documents', 'billing', 'handover', 'other')),
  add column if not exists created_by uuid references public.motorist_profiles(id) on delete set null,
  add column if not exists completed_by uuid references public.motorist_profiles(id) on delete set null,
  add column if not exists completed_at timestamptz;

create index if not exists case_tasks_global_inbox_idx
  on public.motorist_case_tasks (organization_id, status, due_at, priority);

create index if not exists case_tasks_assignee_due_idx
  on public.motorist_case_tasks (organization_id, assigned_to, status, due_at);
