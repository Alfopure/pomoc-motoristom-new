create table if not exists public.motorist_attendance_schedule_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  shift_mode text not null default 'fixed_12h' check (shift_mode in ('fixed_8h', 'fixed_12h', 'custom')),
  date_from_local date not null,
  date_to_local date not null,
  notes text,
  created_by uuid references public.motorist_profiles(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (date_to_local >= date_from_local)
);

alter table public.motorist_attendance_shifts
  add column if not exists schedule_batch_id uuid references public.motorist_attendance_schedule_batches(id) on delete set null,
  add column if not exists batch_created_order integer;

create table if not exists public.motorist_attendance_employee_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  default_available boolean not null default true,
  vacation_days_per_year integer not null default 20 check (vacation_days_per_year >= 0),
  max_weekly_minutes integer check (max_weekly_minutes is null or max_weekly_minutes > 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, profile_id)
);

create table if not exists public.motorist_attendance_unavailability_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  type text not null check (type in ('vacation', 'unavailable', 'sick_leave', 'doctor', 'other')),
  status text not null default 'pending' check (status in ('draft', 'pending', 'approved', 'declined', 'cancelled')),
  start_date_local date not null,
  end_date_local date not null,
  start_time_local time,
  end_time_local time,
  reason text,
  decision_note text,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references public.motorist_profiles(id) on delete set null,
  created_by uuid references public.motorist_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date_local >= start_date_local)
);

create table if not exists public.motorist_attendance_time_off_balances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  year integer not null check (year >= 2000),
  vacation_days_total numeric(6, 2) not null default 20 check (vacation_days_total >= 0),
  vacation_days_used numeric(6, 2) not null default 0 check (vacation_days_used >= 0),
  vacation_days_pending numeric(6, 2) not null default 0 check (vacation_days_pending >= 0),
  carried_over_days numeric(6, 2) not null default 0 check (carried_over_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, profile_id, year)
);

create index if not exists attendance_schedule_batches_org_dates_idx
  on public.motorist_attendance_schedule_batches (organization_id, date_from_local, date_to_local);

create index if not exists attendance_shifts_schedule_batch_idx
  on public.motorist_attendance_shifts (organization_id, schedule_batch_id, batch_created_order);

create index if not exists attendance_employee_settings_org_profile_idx
  on public.motorist_attendance_employee_settings (organization_id, profile_id);

create index if not exists attendance_requests_org_profile_dates_idx
  on public.motorist_attendance_unavailability_requests (organization_id, profile_id, start_date_local, end_date_local);

create index if not exists attendance_requests_org_status_idx
  on public.motorist_attendance_unavailability_requests (organization_id, status, start_date_local);

create index if not exists attendance_balances_org_profile_year_idx
  on public.motorist_attendance_time_off_balances (organization_id, profile_id, year);

alter table public.motorist_attendance_schedule_batches enable row level security;
alter table public.motorist_attendance_employee_settings enable row level security;
alter table public.motorist_attendance_unavailability_requests enable row level security;
alter table public.motorist_attendance_time_off_balances enable row level security;

drop policy if exists attendance_schedule_batches_read_member on public.motorist_attendance_schedule_batches;
drop policy if exists attendance_schedule_batches_manage_admin on public.motorist_attendance_schedule_batches;
drop policy if exists attendance_employee_settings_read_member on public.motorist_attendance_employee_settings;
drop policy if exists attendance_employee_settings_manage_admin on public.motorist_attendance_employee_settings;
drop policy if exists attendance_requests_read_member on public.motorist_attendance_unavailability_requests;
drop policy if exists attendance_requests_manager_update on public.motorist_attendance_unavailability_requests;
drop policy if exists attendance_requests_manager_delete on public.motorist_attendance_unavailability_requests;
drop policy if exists attendance_requests_self_insert on public.motorist_attendance_unavailability_requests;
drop policy if exists attendance_requests_self_cancel_pending on public.motorist_attendance_unavailability_requests;
drop policy if exists attendance_balances_read_member on public.motorist_attendance_time_off_balances;
drop policy if exists attendance_balances_manage_admin on public.motorist_attendance_time_off_balances;

create policy attendance_schedule_batches_read_member
  on public.motorist_attendance_schedule_batches
  for select
  using (public.motorist_is_org_member(organization_id));

create policy attendance_schedule_batches_manage_admin
  on public.motorist_attendance_schedule_batches
  for all
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create policy attendance_employee_settings_read_member
  on public.motorist_attendance_employee_settings
  for select
  using (public.motorist_is_org_member(organization_id));

create policy attendance_employee_settings_manage_admin
  on public.motorist_attendance_employee_settings
  for all
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create policy attendance_requests_read_member
  on public.motorist_attendance_unavailability_requests
  for select
  using (public.motorist_is_org_member(organization_id));

create policy attendance_requests_manager_update
  on public.motorist_attendance_unavailability_requests
  for update
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create policy attendance_requests_manager_delete
  on public.motorist_attendance_unavailability_requests
  for delete
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

create policy attendance_requests_self_insert
  on public.motorist_attendance_unavailability_requests
  for insert
  with check (
    public.motorist_has_org_role(organization_id, array['manager', 'admin'])
    or exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_unavailability_requests.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  );

create policy attendance_requests_self_cancel_pending
  on public.motorist_attendance_unavailability_requests
  for update
  using (
    status in ('draft', 'pending')
    and exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_unavailability_requests.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  )
  with check (
    status in ('draft', 'pending', 'cancelled')
    and exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_attendance_unavailability_requests.profile_id
        and profiles.user_id = auth.uid()
        and profiles.active = true
    )
  );

create policy attendance_balances_read_member
  on public.motorist_attendance_time_off_balances
  for select
  using (public.motorist_is_org_member(organization_id));

create policy attendance_balances_manage_admin
  on public.motorist_attendance_time_off_balances
  for all
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']))
  with check (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

drop trigger if exists attendance_schedule_batches_updated_at on public.motorist_attendance_schedule_batches;
drop trigger if exists attendance_employee_settings_updated_at on public.motorist_attendance_employee_settings;
drop trigger if exists attendance_unavailability_requests_updated_at on public.motorist_attendance_unavailability_requests;
drop trigger if exists attendance_time_off_balances_updated_at on public.motorist_attendance_time_off_balances;

create trigger attendance_schedule_batches_updated_at before update on public.motorist_attendance_schedule_batches
  for each row execute function public.motorist_set_updated_at();

create trigger attendance_employee_settings_updated_at before update on public.motorist_attendance_employee_settings
  for each row execute function public.motorist_set_updated_at();

create trigger attendance_unavailability_requests_updated_at before update on public.motorist_attendance_unavailability_requests
  for each row execute function public.motorist_set_updated_at();

create trigger attendance_time_off_balances_updated_at before update on public.motorist_attendance_time_off_balances
  for each row execute function public.motorist_set_updated_at();
