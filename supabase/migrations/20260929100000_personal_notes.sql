-- Personal notebook. Apply only to the separate copy after explicit authorization.
-- No contents enter dispatch snapshots, case events or realtime payloads.
create schema if not exists app_private;
create unique index if not exists motorist_profiles_id_organization_unique on public.motorist_profiles(id, organization_id);
create table public.motorist_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  owner_profile_id uuid not null,
  title text not null default '' check (char_length(title) <= 200),
  body text not null default '' check (char_length(body) <= 50000),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id, organization_id),
  foreign key(owner_profile_id, organization_id) references public.motorist_profiles(id, organization_id) on delete cascade
);
create table public.motorist_note_shares (
  note_id uuid not null,
  recipient_profile_id uuid not null,
  organization_id uuid not null,
  primary key(note_id, recipient_profile_id),
  foreign key(note_id, organization_id) references public.motorist_notes(id, organization_id) on delete cascade,
  foreign key(recipient_profile_id, organization_id) references public.motorist_profiles(id, organization_id) on delete cascade
);
create index motorist_notes_owner on public.motorist_notes(organization_id, owner_profile_id, updated_at desc);
create index motorist_note_shares_recipient on public.motorist_note_shares(organization_id, recipient_profile_id, note_id);

create function app_private.motorist_note_access(p_note_id uuid, p_owner_only boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.motorist_notes n
    join public.motorist_organizations o on o.id = n.organization_id and o.active
    join public.motorist_profiles p on p.organization_id = n.organization_id and p.user_id = auth.uid() and p.active
    where n.id = p_note_id and (n.owner_profile_id = p.id or (not p_owner_only and exists (
      select 1 from public.motorist_note_shares s where s.note_id = n.id and s.organization_id = n.organization_id and s.recipient_profile_id = p.id
    )))
  );
$$;
revoke all on function app_private.motorist_note_access(uuid,boolean) from public, anon, service_role;
grant usage on schema app_private to authenticated;
grant execute on function app_private.motorist_note_access(uuid,boolean) to authenticated;
alter table public.motorist_notes enable row level security;
alter table public.motorist_note_shares enable row level security;
create policy motorist_notes_read on public.motorist_notes for select to authenticated using (app_private.motorist_note_access(id));
-- Readers need the note, not the owner's recipient list.
create policy motorist_note_shares_read on public.motorist_note_shares for select to authenticated using (app_private.motorist_note_access(note_id, true));
revoke all on public.motorist_notes, public.motorist_note_shares from public, anon, authenticated, service_role;
grant select on public.motorist_notes, public.motorist_note_shares to authenticated;

create function app_private.motorist_note_dto(p_note public.motorist_notes, p_actor uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_note.id, 'ownerProfileId', p_note.owner_profile_id, 'title', p_note.title, 'body', p_note.body,
    'revision', p_note.revision, 'updatedAt', p_note.updated_at, 'canEdit', p_note.owner_profile_id = p_actor,
    'recipientProfileIds', case when p_note.owner_profile_id = p_actor then coalesce((
      select jsonb_agg(s.recipient_profile_id order by s.recipient_profile_id) from public.motorist_note_shares s where s.note_id = p_note.id
    ), '[]'::jsonb) else '[]'::jsonb end
  );
$$;
-- Internal serialization must never become an alternate content read endpoint.
revoke all on function app_private.motorist_note_dto(public.motorist_notes,uuid) from public, anon, authenticated, service_role;

create function public.motorist_notebook(
  p_organization_id uuid, p_actor_profile_id uuid, p_action text,
  p_note_id uuid default null, p_expected_revision integer default null,
  p_title text default '', p_body text default '', p_recipients uuid[] default '{}'::uuid[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_note public.motorist_notes;
  v_result jsonb;
  v_recipient uuid;
  v_previous_recipients uuid[];
begin
  if auth.uid() is null or not exists (
    select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id = p.organization_id and o.active
    where p.id = p_actor_profile_id and p.organization_id = p_organization_id and p.user_id = auth.uid() and p.active
  ) then raise exception 'Notebook access denied' using errcode = '42501'; end if;

  if p_action = 'colleagues' then
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'displayName', p.display_name) order by p.display_name), '[]'::jsonb) into v_result
      from public.motorist_profiles p where p.organization_id = p_organization_id and p.active and p.user_id is not null and p.id <> p_actor_profile_id;
    return v_result;
  elsif p_action = 'list' then
    select coalesce(jsonb_agg(app_private.motorist_note_dto(n, p_actor_profile_id) order by n.updated_at desc, n.id), '[]'::jsonb) into v_result
      from public.motorist_notes n where n.organization_id = p_organization_id and app_private.motorist_note_access(n.id);
    return v_result;
  elsif p_action not in ('create', 'get', 'save', 'delete') then
    raise exception 'Invalid notebook operation' using errcode = '22023';
  end if;

  if p_action <> 'create' then
    -- Serialize owner writes and share revocations against the same note row.
    select * into v_note from public.motorist_notes n where n.id = p_note_id and n.organization_id = p_organization_id for update;
    if not found or not app_private.motorist_note_access(p_note_id, p_action <> 'get') then
      raise exception 'Note unavailable' using errcode = 'P0002';
    end if;
    if p_action = 'get' then return app_private.motorist_note_dto(v_note, p_actor_profile_id); end if;
    if p_expected_revision is null or p_expected_revision <> v_note.revision then
      raise exception 'Note revision conflict' using errcode = '40001';
    end if;
    select coalesce(array_agg(recipient_profile_id), '{}'::uuid[]) into v_previous_recipients from public.motorist_note_shares where note_id = v_note.id;
  end if;

  if p_action = 'delete' then
    delete from public.motorist_notes where id = v_note.id;
    v_result := jsonb_build_object('deleted', true);
  else
    if p_title is null or p_body is null or char_length(p_title) > 200 or char_length(p_body) > 50000 or p_recipients is null or cardinality(p_recipients) > 100
      or cardinality(p_recipients) <> (select count(distinct r) from unnest(p_recipients) r)
      or exists (select 1 from unnest(p_recipients) r where r is null or r = p_actor_profile_id or not exists (
        select 1 from public.motorist_profiles p where p.id = r and p.organization_id = p_organization_id and p.active and p.user_id is not null
      )) then raise exception 'Invalid note or recipients' using errcode = '22023'; end if;
    if p_action = 'create' then
      insert into public.motorist_notes(organization_id, owner_profile_id, title, body)
        values(p_organization_id, p_actor_profile_id, p_title, p_body) returning * into v_note;
    else
      update public.motorist_notes set title = p_title, body = p_body, revision = revision + 1, updated_at = clock_timestamp()
        where id = v_note.id returning * into v_note;
    end if;
    delete from public.motorist_note_shares where note_id = v_note.id and not (recipient_profile_id = any(p_recipients));
    insert into public.motorist_note_shares(note_id, organization_id, recipient_profile_id)
      select v_note.id, p_organization_id, r from unnest(p_recipients) r on conflict do nothing;
    v_result := app_private.motorist_note_dto(v_note, p_actor_profile_id);
  end if;
  -- Content-free invalidations only, including removed recipients. Polling/focus
  -- rechecks remain authoritative when Broadcast is unavailable or ACL is stale.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    for v_recipient in select distinct r from unnest(coalesce(v_previous_recipients, '{}'::uuid[]) || coalesce(p_recipients, '{}'::uuid[]) || array[p_actor_profile_id]) r loop
      perform realtime.send('{}'::jsonb, 'invalidate', 'notebook:' || p_organization_id::text || ':' || v_recipient::text, true);
    end loop;
  end if;
  return v_result;
end;
$$;
revoke all on function public.motorist_notebook(uuid,uuid,text,uuid,integer,text,text,uuid[]) from public, anon, service_role;
grant execute on function public.motorist_notebook(uuid,uuid,text,uuid,integer,text,text,uuid[]) to authenticated;

do $$ begin
  if to_regclass('realtime.messages') is not null then
    execute $policy$ create policy motorist_notebook_broadcast_read on realtime.messages for select to authenticated using (
      extension = 'broadcast' and exists (
        select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id = p.organization_id and o.active
        where p.user_id = auth.uid() and p.active and realtime.topic() = 'notebook:' || p.organization_id::text || ':' || p.id::text
      )
    ) $policy$;
  end if;
end $$;
