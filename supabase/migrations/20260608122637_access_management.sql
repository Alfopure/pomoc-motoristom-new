create extension if not exists citext;

alter table public.motorist_profiles
  add column if not exists email citext,
  add column if not exists access_status text not null default 'not_invited',
  add column if not exists invited_at timestamptz,
  add column if not exists invite_last_sent_at timestamptz,
  add column if not exists invited_by uuid references public.motorist_profiles(id) on delete set null,
  add column if not exists password_set_at timestamptz,
  add column if not exists access_disabled_at timestamptz,
  add column if not exists access_disabled_by uuid references public.motorist_profiles(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'motorist_profiles_access_status_check'
      and conrelid = 'public.motorist_profiles'::regclass
  ) then
    alter table public.motorist_profiles
      add constraint motorist_profiles_access_status_check
      check (access_status in ('not_invited', 'invited', 'active', 'disabled'));
  end if;
end $$;

update public.motorist_profiles profiles
set
  email = users.email,
  access_status = case
    when profiles.active = false then 'disabled'
    when profiles.user_id is not null then 'active'
    else profiles.access_status
  end,
  password_set_at = case
    when profiles.user_id is not null and profiles.password_set_at is null then profiles.updated_at
    else profiles.password_set_at
  end
from auth.users users
where profiles.user_id = users.id
  and profiles.email is null
  and users.email is not null;

update public.motorist_profiles
set access_status = 'disabled',
    access_disabled_at = coalesce(access_disabled_at, updated_at)
where active = false
  and access_status <> 'disabled';

create unique index if not exists motorist_profiles_organization_email_key
  on public.motorist_profiles (organization_id, email)
  where email is not null;

create table if not exists public.motorist_auth_email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid references public.motorist_profiles(id) on delete set null,
  purpose text not null check (purpose in ('invite', 'resend_invite', 'reset_password', 'forgot_password')),
  recipient_email citext not null,
  provider text not null default 'resend',
  delivery_status text not null check (delivery_status in ('requested', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  idempotency_key text,
  error_message text,
  requested_by uuid references public.motorist_profiles(id) on delete set null,
  request_ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.motorist_auth_email_events enable row level security;

drop policy if exists motorist_auth_email_events_manager_read on public.motorist_auth_email_events;
create policy motorist_auth_email_events_manager_read
  on public.motorist_auth_email_events
  for select
  using (public.motorist_has_org_role(organization_id, array['manager', 'admin']));

drop policy if exists motorist_profiles_organization_access on public.motorist_profiles;
drop policy if exists motorist_profiles_select_member on public.motorist_profiles;
drop policy if exists motorist_profiles_manager_insert on public.motorist_profiles;
drop policy if exists motorist_profiles_manager_update on public.motorist_profiles;
drop policy if exists motorist_profiles_admin_delete on public.motorist_profiles;

create policy motorist_profiles_select_member
  on public.motorist_profiles
  for select
  using (public.motorist_is_org_member(organization_id));

create policy motorist_profiles_manager_insert
  on public.motorist_profiles
  for insert
  with check (
    public.motorist_has_org_role(organization_id, array['admin'])
    or (
      public.motorist_has_org_role(organization_id, array['manager'])
      and role in ('dispatcher', 'senior_dispatcher')
    )
  );

create policy motorist_profiles_manager_update
  on public.motorist_profiles
  for update
  using (
    public.motorist_has_org_role(organization_id, array['admin'])
    or (
      public.motorist_has_org_role(organization_id, array['manager'])
      and role in ('dispatcher', 'senior_dispatcher')
    )
  )
  with check (
    public.motorist_has_org_role(organization_id, array['admin'])
    or (
      public.motorist_has_org_role(organization_id, array['manager'])
      and role in ('dispatcher', 'senior_dispatcher')
    )
  );

create policy motorist_profiles_admin_delete
  on public.motorist_profiles
  for delete
  using (public.motorist_has_org_role(organization_id, array['admin']));

create or replace function public.motorist_prevent_last_admin_profile_loss()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining_admins integer;
begin
  if old.role <> 'admin' or old.active = false then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE'
    and new.role = 'admin'
    and new.active = true
    and new.access_status <> 'disabled'
  then
    return new;
  end if;

  select count(*)
    into remaining_admins
  from public.motorist_profiles profiles
  where profiles.organization_id = old.organization_id
    and profiles.id <> old.id
    and profiles.role = 'admin'
    and profiles.active = true
    and profiles.access_status <> 'disabled';

  if remaining_admins = 0 then
    raise exception 'Nedá sa odstrániť alebo deaktivovať posledný admin.';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists motorist_profiles_prevent_last_admin_loss on public.motorist_profiles;
create trigger motorist_profiles_prevent_last_admin_loss
  before update or delete on public.motorist_profiles
  for each row execute function public.motorist_prevent_last_admin_profile_loss();
