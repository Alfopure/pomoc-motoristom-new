-- Per-operator contact-directory favorites and normalized contact search.
create table if not exists public.motorist_contact_favorites (
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  profile_id uuid not null references public.motorist_profiles(id) on delete cascade,
  contact_id uuid not null references public.motorist_contacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, contact_id)
);

create index if not exists motorist_contact_favorites_profile_created_idx
  on public.motorist_contact_favorites (profile_id, created_at desc);

create index if not exists motorist_contact_favorites_organization_contact_idx
  on public.motorist_contact_favorites (organization_id, contact_id);

create index if not exists motorist_contact_favorites_contact_idx
  on public.motorist_contact_favorites (contact_id);

alter table public.motorist_contact_favorites enable row level security;

drop policy if exists motorist_contact_favorites_select_own on public.motorist_contact_favorites;
create policy motorist_contact_favorites_select_own
  on public.motorist_contact_favorites
  for select
  using (
    exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_contact_favorites.profile_id
        and profiles.organization_id = motorist_contact_favorites.organization_id
        and profiles.user_id = (select auth.uid())
        and profiles.active = true
    )
  );

drop policy if exists motorist_contact_favorites_insert_own on public.motorist_contact_favorites;
create policy motorist_contact_favorites_insert_own
  on public.motorist_contact_favorites
  for insert
  with check (
    exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_contact_favorites.profile_id
        and profiles.organization_id = motorist_contact_favorites.organization_id
        and profiles.user_id = (select auth.uid())
        and profiles.active = true
    )
    and exists (
      select 1
      from public.motorist_contacts contacts
      where contacts.id = motorist_contact_favorites.contact_id
        and contacts.organization_id = motorist_contact_favorites.organization_id
    )
  );

drop policy if exists motorist_contact_favorites_delete_own on public.motorist_contact_favorites;
create policy motorist_contact_favorites_delete_own
  on public.motorist_contact_favorites
  for delete
  using (
    exists (
      select 1
      from public.motorist_profiles profiles
      where profiles.id = motorist_contact_favorites.profile_id
        and profiles.organization_id = motorist_contact_favorites.organization_id
        and profiles.user_id = (select auth.uid())
        and profiles.active = true
    )
  );

revoke all on table public.motorist_contact_favorites from public, anon;
grant select, insert, delete on table public.motorist_contact_favorites to authenticated, service_role;

create or replace function app_private.motorist_directory_normalize(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.lower(
    pg_catalog.translate(
      coalesce(value, ''),
      'ÁÄČĎÉĚÍĹĽŇÓÔÖŔŘŠŤÚŮÜÝŽáäčďéěíĺľňóôöŕřšťúůüýž',
      'AACDEEILLNOOORRSTUUUYZaacdeeillnooorrstuuuyz'
    )
  );
$$;

create or replace function app_private.motorist_directory_phone_digits(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  with raw as (
    select pg_catalog.regexp_replace(coalesce(value, ''), '[^0-9]', '', 'g') as digits
  )
  select case
    when pg_catalog.length(digits) > 8 and digits like '00%' then pg_catalog.substr(digits, 3)
    when pg_catalog.length(digits) > 8 and digits like '0%' then '421' || pg_catalog.substr(digits, 2)
    else digits
  end
  from raw;
$$;

revoke all on function app_private.motorist_directory_normalize(text) from public, anon;
revoke all on function app_private.motorist_directory_phone_digits(text) from public, anon;
grant execute on function app_private.motorist_directory_normalize(text) to authenticated, service_role;
grant execute on function app_private.motorist_directory_phone_digits(text) to authenticated, service_role;

create or replace function public.motorist_search_contacts(
  p_organization_id uuid,
  p_query text,
  p_limit integer default 12
)
returns table (
  id uuid,
  name text,
  phone text,
  email text,
  role text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with query_parts as (
    select
      pg_catalog.btrim(app_private.motorist_directory_normalize(p_query)) as normalized_text,
      app_private.motorist_directory_phone_digits(p_query) as normalized_phone
  )
  select
    contacts.id,
    contacts.name,
    contacts.phone,
    contacts.email,
    contacts.role
  from public.motorist_contacts contacts
  cross join query_parts query
  where contacts.organization_id = p_organization_id
    and contacts.phone is not null
    and pg_catalog.btrim(contacts.phone) <> ''
    and (
      (
        query.normalized_text <> ''
        and pg_catalog.strpos(
          app_private.motorist_directory_normalize(contacts.name),
          query.normalized_text
        ) > 0
      )
      or (
        query.normalized_phone <> ''
        and pg_catalog.strpos(
          app_private.motorist_directory_phone_digits(contacts.phone),
          query.normalized_phone
        ) > 0
      )
    )
  order by
    case
      when app_private.motorist_directory_phone_digits(contacts.phone) = query.normalized_phone then 0
      when app_private.motorist_directory_normalize(contacts.name) = query.normalized_text then 1
      when pg_catalog.strpos(app_private.motorist_directory_normalize(contacts.name), query.normalized_text) = 1 then 2
      else 3
    end,
    contacts.name asc,
    contacts.id asc
  limit least(greatest(coalesce(p_limit, 12), 1), 25);
$$;

revoke all on function public.motorist_search_contacts(uuid, text, integer) from public, anon;
grant execute on function public.motorist_search_contacts(uuid, text, integer) to authenticated, service_role;
