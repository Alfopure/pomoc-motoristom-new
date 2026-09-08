-- Additive only. Apply to this copy only after explicit authorization.
alter table public.motorist_operator_telephony_settings
  add column if not exists delivery_mode text not null default 'web'
  check (delivery_mode in ('web', 'personal_mobile'));
alter table public.motorist_ring_group_members
  add column if not exists owner_profile_id uuid references public.motorist_profiles(id);

-- An explicit owner is constrained to the member's organization, including
-- direct configuration writes. Null keeps independent operational backup.
create or replace function public.motorist_validate_ring_member_owner()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.owner_profile_id is not null and (new.member_kind <> 'external_number' or not exists (
    select 1 from public.motorist_profiles p where p.id = new.owner_profile_id and p.organization_id = new.organization_id
  )) then raise exception 'invalid ring member owner'; end if;
  return new;
end;
$$;
create trigger motorist_ring_member_owner_check before insert or update
on public.motorist_ring_group_members for each row execute function public.motorist_validate_ring_member_owner();

-- Attempts retain profile_id for an owned PSTN target, so reservations and
-- answer/pause arbitration use the same owner as an application-phone target.
alter table public.motorist_ring_attempts drop constraint motorist_ring_attempts_check;
alter table public.motorist_ring_attempts add constraint motorist_ring_attempts_check check (
  (member_kind = 'operator' and profile_id is not null and external_number is null)
  or (member_kind = 'external_number' and external_number is not null)
);

-- Keep the existing replace transaction and version gate. Preserve ownership
-- for old clients that omit the additive JSON key, including full replacement.
alter function public.motorist_replace_ring_plan(uuid, jsonb, integer)
  rename to motorist_replace_ring_plan_pre_mobile;
create function public.motorist_replace_ring_plan(p_organization_id uuid, p_document jsonb, p_expected_version integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_previous jsonb;
  v_result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_organization_id::text));
  select coalesce(pg_catalog.jsonb_object_agg(id::text, owner_profile_id), '{}'::jsonb)
    into v_previous from public.motorist_ring_group_members where organization_id = p_organization_id;
  v_result := public.motorist_replace_ring_plan_pre_mobile(p_organization_id, p_document, p_expected_version);
  if p_document -> 'groups' is not null and p_document -> 'groups' <> 'null'::jsonb then
    update public.motorist_ring_group_members m set owner_profile_id = case
      when mm ? 'owner_profile_id' then (mm ->> 'owner_profile_id')::uuid
      else (v_previous ->> m.id::text)::uuid end
    from pg_catalog.jsonb_array_elements(p_document -> 'groups') g,
      lateral pg_catalog.jsonb_array_elements(coalesce(g -> 'members', '[]'::jsonb)) mm
    where m.organization_id = p_organization_id and m.id = (mm ->> 'id')::uuid;
  end if;
  return v_result;
end;
$$;
revoke all on function public.motorist_replace_ring_plan(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.motorist_replace_ring_plan(uuid, jsonb, integer) to service_role;

revoke all on function public.motorist_replace_ring_plan_pre_mobile(uuid, jsonb, integer) from public, anon, authenticated, service_role;
