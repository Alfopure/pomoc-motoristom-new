create table if not exists public.motorist_attendance_shift_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  label text not null,
  kind text not null check (kind in ('fixed_8h', 'fixed_12h', 'custom')),
  starts_at_local time,
  ends_at_local time,
  planned_minutes integer check (planned_minutes is null or planned_minutes > 0),
  color text not null default '#71717a',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, label)
);

create table if not exists public.motorist_attendance_shifts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  template_id uuid references public.motorist_attendance_shift_templates(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published', 'confirmed', 'declined', 'completed', 'cancelled', 'no_show')),
  date_local date not null,
  timezone text not null default 'Europe/Bratislava',
  planned_start_at timestamptz not null,
  planned_end_at timestamptz not null,
  published_at timestamptz,
  confirmed_at timestamptz,
  declined_at timestamptz,
  confirmation_note text,
  notes text,
  created_by uuid references public.motorist_profiles(id) on delete set null,
  updated_by uuid references public.motorist_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (planned_end_at > planned_start_at)
);

create table if not exists public.motorist_attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  shift_id uuid references public.motorist_attendance_shifts(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'closed', 'adjusted')),
  source text not null default 'manual' check (source in ('login', 'manual', 'system')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  notes text,
  created_by uuid references public.motorist_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at)
);

create index if not exists attendance_shift_templates_org_sort_idx
  on public.motorist_attendance_shift_templates (organization_id, sort_order, label);

create index if not exists attendance_shifts_org_date_idx
  on public.motorist_attendance_shifts (organization_id, date_local, planned_start_at);

create index if not exists attendance_shifts_org_profile_idx
  on public.motorist_attendance_shifts (organization_id, profile_id, planned_start_at);

create index if not exists attendance_sessions_org_profile_idx
  on public.motorist_attendance_sessions (organization_id, profile_id, started_at desc);

create unique index if not exists attendance_sessions_one_open_per_profile_idx
  on public.motorist_attendance_sessions (organization_id, profile_id)
  where status = 'open';

alter table public.motorist_attendance_shift_templates enable row level security;
alter table public.motorist_attendance_shifts enable row level security;
alter table public.motorist_attendance_sessions enable row level security;

create policy attendance_shift_templates_read_member
  on public.motorist_attendance_shift_templates
  for select
  using (public.motorist_is_org_member(organization_id));

create policy attendance_shift_templates_manage_admin
  on public.motorist_attendance_shift_templates
  for all
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create policy attendance_shifts_read_member
  on public.motorist_attendance_shifts
  for select
  using (public.motorist_is_org_member(organization_id));

create policy attendance_shifts_manager_insert
  on public.motorist_attendance_shifts
  for insert
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create policy attendance_shifts_manager_delete
  on public.motorist_attendance_shifts
  for delete
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create policy attendance_shifts_manager_or_self_update
  on public.motorist_attendance_shifts
  for update
  using (
    public.motorist_has_org_role(organization_id, array['manager', 'admin'])
    or exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_shifts.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  )
  with check (
    public.motorist_has_org_role(organization_id, array['manager', 'admin'])
    or exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_shifts.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  );

create policy attendance_sessions_read_member
  on public.motorist_attendance_sessions
  for select
  using (public.motorist_is_org_member(organization_id));

create policy attendance_sessions_manager_or_self_insert
  on public.motorist_attendance_sessions
  for insert
  with check (
    public.motorist_has_org_role(organization_id, array['manager', 'admin'])
    or exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_sessions.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  );

create policy attendance_sessions_manager_or_self_update
  on public.motorist_attendance_sessions
  for update
  using (
    public.motorist_has_org_role(organization_id, array['manager', 'admin'])
    or exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_sessions.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  )
  with check (
    public.motorist_has_org_role(organization_id, array['manager', 'admin'])
    or exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_sessions.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  );

create trigger attendance_shift_templates_updated_at before update on public.motorist_attendance_shift_templates
  for each row execute function public.motorist_set_updated_at();

create trigger attendance_shifts_updated_at before update on public.motorist_attendance_shifts
  for each row execute function public.motorist_set_updated_at();

create trigger attendance_sessions_updated_at before update on public.motorist_attendance_sessions
  for each row execute function public.motorist_set_updated_at();
