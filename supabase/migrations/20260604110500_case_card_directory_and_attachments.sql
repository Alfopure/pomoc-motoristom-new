create table if not exists public.motorist_partner_directory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  kind text not null check (kind in ('assistance', 'company')),
  name text not null,
  ico text,
  phone text,
  email text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists partner_directory_org_kind_idx
  on public.motorist_partner_directory (organization_id, kind, active, name);

alter table public.motorist_partner_directory
  drop constraint if exists motorist_partner_directory_organization_id_kind_name_key;

create unique index if not exists partner_directory_active_name_unique_idx
  on public.motorist_partner_directory (organization_id, kind, name)
  where active;

alter table public.motorist_partner_directory enable row level security;

drop policy if exists partner_directory_organization_access on public.motorist_partner_directory;
create policy partner_directory_organization_access
  on public.motorist_partner_directory
  for all
  using (public.motorist_is_org_member(organization_id))
  with check (public.motorist_is_org_member(organization_id));

drop trigger if exists partner_directory_updated_at on public.motorist_partner_directory;
create trigger partner_directory_updated_at before update on public.motorist_partner_directory
  for each row execute function public.motorist_set_updated_at();

update public.motorist_cases
set vehicle_details = jsonb_set(
  coalesce(vehicle_details, '{}'::jsonb),
  '{jobTypes}',
  case
    when case_type ~* 'vyslobod' then '["vehicle_recovery"]'::jsonb
    when destination_location_id is not null and case_type ~* 'n[áa]hrad' then '["tow", "replacement_vehicle"]'::jsonb
    when destination_location_id is not null then '["tow"]'::jsonb
    when case_type ~* 'n[áa]hrad' then '["replacement_vehicle"]'::jsonb
    when case_type ~* 'asist' then '["onsite_assistance"]'::jsonb
    else '[]'::jsonb
  end,
  true
)
where not coalesce(vehicle_details, '{}'::jsonb) ? 'jobTypes'
  and (
    destination_location_id is not null
    or case_type ~* 'od[ťt]ah|vyslobod|n[áa]hrad|asist'
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'motorist-case-attachments',
  'motorist-case-attachments',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists case_attachments_select_member on storage.objects;
create policy case_attachments_select_member
  on storage.objects
  for select
  using (
    bucket_id = 'motorist-case-attachments'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.motorist_is_org_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists case_attachments_insert_member on storage.objects;
drop policy if exists case_attachments_update_member on storage.objects;
drop policy if exists case_attachments_delete_member on storage.objects;
