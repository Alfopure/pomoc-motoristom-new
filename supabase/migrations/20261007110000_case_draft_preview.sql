-- Unsaved form contents are fetched only through the authenticated HTTP API.
-- Presence and realtime broadcasts continue to contain no customer draft data.
create table public.motorist_case_draft_previews (
  session_id uuid primary key references public.motorist_case_editor_sessions(id) on delete cascade,
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  preview jsonb not null check (
    jsonb_typeof(preview) = 'object'
    and preview->'version' = '1'::jsonb
    and jsonb_typeof(preview->'fields') = 'object'
    -- jsonb adds insignificant spaces; HTTP validation enforces 48,000 compact
    -- UTF-8 bytes, and this ceiling includes bounded PostgreSQL formatting.
    and octet_length(preview::text) <= 48512
  ),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.motorist_case_draft_previews enable row level security;
revoke all on public.motorist_case_draft_previews from public, anon, authenticated;

create function app_private.motorist_clear_case_draft_preview()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Expired sessions can resume via heartbeat; they must not revive old content.
  if new.ended_at is not null or new.case_id is not null
    or old.expires_at <= clock_timestamp()
    or new.organization_id is distinct from old.organization_id
    or new.profile_id is distinct from old.profile_id then
    delete from public.motorist_case_draft_previews where session_id = new.id;
  end if;
  return new;
end $$;
create trigger motorist_clear_case_draft_preview
  after update on public.motorist_case_editor_sessions
  for each row execute function app_private.motorist_clear_case_draft_preview();
revoke all on function app_private.motorist_clear_case_draft_preview() from public, anon, authenticated;

create function public.motorist_case_draft_preview(
  p_organization_id uuid, p_actor_profile_id uuid, p_session_id uuid,
  p_action text, p_input jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.motorist_case_editor_sessions%rowtype;
  v_sequence bigint;
  v_result jsonb;
begin
  if not exists (
    select 1 from public.motorist_profiles p
    join public.motorist_organizations o on o.id = p.organization_id and o.active
    where p.id = p_actor_profile_id and p.organization_id = p_organization_id
      and p.active and p.access_status = 'active'
      and p.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
  ) then raise exception 'Case access denied' using errcode = '42501'; end if;
  if p_session_id is null or p_action is null or p_action not in ('read', 'publish')
    then raise exception 'Invalid draft action' using errcode = '22023'; end if;

  -- Lock the same row modified by leave/commit. A late publish cannot pass an
  -- earlier check and recreate content after the session has ended.
  select * into v_session from public.motorist_case_editor_sessions
    where id = p_session_id for update;
  if not found then raise exception 'Draft unavailable' using errcode = 'P0002'; end if;
  if v_session.organization_id <> p_organization_id
    or (p_action = 'publish' and v_session.profile_id <> p_actor_profile_id)
    then raise exception 'Draft access denied' using errcode = '42501'; end if;
  if v_session.ended_at is not null or v_session.case_id is not null
    or v_session.expires_at <= clock_timestamp()
    then raise exception 'Draft unavailable' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.motorist_profiles p
    where p.id = v_session.profile_id and p.organization_id = p_organization_id
      and p.active and p.access_status = 'active'
      and p.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
  ) then
    if v_session.profile_id = p_actor_profile_id then raise exception 'Case access denied' using errcode = '42501'; end if;
    raise exception 'Draft unavailable' using errcode = 'P0002';
  end if;

  if p_action = 'publish' then
    if jsonb_typeof(p_input) is distinct from 'object'
      or p_input - array['sequence', 'preview'] <> '{}'::jsonb
      or jsonb_typeof(p_input->'sequence') is distinct from 'number'
      or (p_input->>'sequence') !~ '^[1-9][0-9]{0,15}$'
      or (p_input->>'sequence')::numeric > 9007199254740991
      or jsonb_typeof(p_input->'preview') is distinct from 'object'
      or (p_input->'preview') - array['version', 'fields'] <> '{}'::jsonb
      or p_input->'preview'->'version' is distinct from '1'::jsonb
      or jsonb_typeof(p_input->'preview'->'fields') is distinct from 'object'
      or octet_length((p_input->'preview')::text) > 48512
      then raise exception 'Invalid draft preview' using errcode = '22023'; end if;
    if exists (select 1 from jsonb_each(p_input->'preview'->'fields') f
      where jsonb_typeof(f.value) <> 'string' or length(f.value #>> '{}') > 4000
        or f.key not in (
          'jobTypes', 'priority', 'sourceType', 'incidentType', 'participants', 'passengers', 'note',
          'customerType', 'contacts', 'companyName', 'companyIdNumber', 'assistance', 'assistanceReference', 'customerNote',
          'plate', 'vin', 'make', 'model', 'year', 'color', 'category', 'vehicleType', 'transmission', 'transmissionNote',
          'driveType', 'weight', 'issue', 'driveable', 'conditions', 'vehicleNote', 'damageAreas', 'damageNote',
          'pickup', 'destination', 'road', 'kilometer', 'direction', 'placeType', 'complications', 'access', 'destinationNote',
          'replacementNeeded', 'replacementType', 'replacementCategory', 'replacementPreferences', 'replacementDelivery',
          'replacementEntitlement', 'replacementExtension', 'replacementDays', 'replacementNote',
          'paymentMethod', 'paymentStatus', 'closureType', 'closureStatus', 'insurancePortal', 'closureNote', 'attachments', 'attachmentNote'
        ))
      then raise exception 'Invalid draft fields' using errcode = '22023'; end if;
    v_sequence := (p_input->>'sequence')::bigint;
    insert into public.motorist_case_draft_previews(session_id, sequence, preview)
      values (p_session_id, v_sequence, p_input->'preview')
      on conflict (session_id) do update
        set sequence = excluded.sequence, preview = excluded.preview, updated_at = clock_timestamp()
        where motorist_case_draft_previews.sequence < excluded.sequence;
  end if;

  -- No scheduler: valid requests discard at most 100 expired previews. Lock
  -- sessions before deleting, skipping busy writers and heartbeat renewals.
  delete from public.motorist_case_draft_previews where session_id in (
    select s.id from public.motorist_case_editor_sessions s
    join public.motorist_case_draft_previews d on d.session_id = s.id
    where s.organization_id = p_organization_id
      and (s.ended_at is not null or s.case_id is not null or s.expires_at <= clock_timestamp())
    order by s.expires_at, s.id limit 100 for update of s skip locked
  );

  select jsonb_build_object(
    'available', true, 'preview', d.preview, 'sequence', coalesce(d.sequence, 0),
    'updatedAt', d.updated_at, 'expiresAt', s.expires_at, 'displayName', p.display_name
  ) into v_result
  from public.motorist_case_editor_sessions s
  join public.motorist_profiles p on p.id = s.profile_id and p.organization_id = s.organization_id
    and p.active and p.access_status = 'active'
    and p.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
  left join public.motorist_case_draft_previews d on d.session_id = s.id
  where s.id = p_session_id and s.organization_id = p_organization_id
    and s.ended_at is null and s.case_id is null and s.expires_at > clock_timestamp()
    -- Recheck in the same statement as the content read: access may have been
    -- revoked while this request waited for the session lock.
    and exists (
      select 1 from public.motorist_profiles viewer
      join public.motorist_organizations o on o.id = viewer.organization_id and o.active
      where viewer.id = p_actor_profile_id and viewer.organization_id = p_organization_id
        and viewer.active and viewer.access_status = 'active'
        and viewer.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
    );
  if v_result is null then
    if not exists (
      select 1 from public.motorist_profiles viewer
      join public.motorist_organizations o on o.id = viewer.organization_id and o.active
      where viewer.id = p_actor_profile_id and viewer.organization_id = p_organization_id
        and viewer.active and viewer.access_status = 'active'
        and viewer.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')
    ) then raise exception 'Case access denied' using errcode = '42501'; end if;
    raise exception 'Draft unavailable' using errcode = 'P0002';
  end if;
  return v_result;
end $$;
revoke all on function public.motorist_case_draft_preview(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.motorist_case_draft_preview(uuid, uuid, uuid, text, jsonb) to service_role;
