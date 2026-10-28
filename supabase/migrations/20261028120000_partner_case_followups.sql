-- Partner follow-up on cases with a saved partner origin. Additive and server-only:
-- the office marks an insurance event, the partner account takes it and records
-- contact, and the partner appends its own notes. Nothing here changes the case,
-- its internal fields or the partner settlement. All reads/writes go through
-- SECURITY DEFINER RPCs that re-check the office profile or the current versioned
-- partner membership; tables have RLS with no browser grants.
begin;

create table public.motorist_partner_case_followups (
 case_id uuid primary key references public.motorist_partner_case_contexts(case_id),
 organization_id uuid not null references public.motorist_organizations(id),
 partner_id uuid not null references public.motorist_partner_directory(id),
 insurance_event boolean not null default false,
 insurance_label text check (insurance_label is null or char_length(insurance_label) between 1 and 80),
 insurance_marked_by uuid references public.motorist_profiles(id),
 insurance_marked_at timestamptz,
 status text not null default 'new' check (status in ('new','taken','contacted')),
 taken_by uuid references public.motorist_partner_memberships(id),
 taken_at timestamptz,
 contacted_by uuid references public.motorist_partner_memberships(id),
 contacted_at timestamptz,
 revision bigint not null default 1 check (revision > 0),
 updated_at timestamptz not null default now(),
 check (insurance_event = (insurance_marked_at is not null)),
 check ((status = 'new') = (taken_at is null) and (taken_at is null) = (taken_by is null)),
 check ((status = 'contacted') = (contacted_at is not null) and (contacted_at is null) = (contacted_by is null))
);
create index motorist_partner_followup_partner on public.motorist_partner_case_followups(organization_id, partner_id, status) where insurance_event;

-- Partner-owned, append-only. The author is the partner account, never a guessed person.
create table public.motorist_partner_case_notes (
 id uuid primary key,
 organization_id uuid not null references public.motorist_organizations(id),
 case_id uuid not null references public.motorist_partner_case_contexts(case_id),
 partner_id uuid not null references public.motorist_partner_directory(id),
 membership_id uuid not null references public.motorist_partner_memberships(id),
 author_label text not null,
 body text not null check (char_length(btrim(body)) between 1 and 2000),
 created_at timestamptz not null default now()
);
create index motorist_partner_case_notes_case on public.motorist_partner_case_notes(organization_id, partner_id, case_id, created_at);

create table public.motorist_partner_followup_commands (
 organization_id uuid not null references public.motorist_organizations(id),
 command_id uuid not null,
 actor_kind text not null check (actor_kind in ('office','partner')),
 actor_id uuid not null,
 fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key (organization_id, command_id)
);

create function public.motorist_partner_followup_append_only() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 raise exception 'Partner follow-up history is append-only' using errcode = '42501';
end $$;
create trigger motorist_partner_case_notes_append_only before update or delete on public.motorist_partner_case_notes
 for each row execute function public.motorist_partner_followup_append_only();
create trigger motorist_partner_followup_commands_append_only before update or delete on public.motorist_partner_followup_commands
 for each row execute function public.motorist_partner_followup_append_only();

-- Current active partner membership of the given version, with an active partner.
create function public.motorist_partner_followup_member(p_user_id uuid, p_organization_id uuid, p_membership_version bigint)
returns public.motorist_partner_memberships language plpgsql security definer set search_path = '' as $$
declare m public.motorist_partner_memberships;
begin
 select pm.* into m from public.motorist_partner_memberships pm
  join public.motorist_partner_directory d on d.id = pm.partner_id and d.organization_id = pm.organization_id and d.active
  where pm.auth_user_id = p_user_id and pm.organization_id = p_organization_id and pm.status = 'active'
   and pm.membership_version = p_membership_version
  for share of pm;
 if m.id is null then raise insufficient_privilege; end if;
 return m;
end $$;

create function public.motorist_partner_followup_office(p_user_id uuid, p_organization_id uuid)
returns public.motorist_profiles language plpgsql security definer set search_path = '' as $$
declare a public.motorist_profiles;
begin
 select * into a from public.motorist_profiles where user_id = p_user_id and organization_id = p_organization_id and active
  and role in ('dispatcher','senior_dispatcher','manager','admin');
 if a.id is null then raise insufficient_privilege; end if;
 return a;
end $$;

create function public.motorist_partner_followup_period(p_from timestamptz, p_to timestamptz) returns void language plpgsql immutable set search_path = '' as $$
begin
 if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '400 days' then
  raise exception 'Neplatné obdobie' using errcode = '22023';
 end if;
end $$;

-- The exact server allowlist. Customer contact only for an insurance event and only
-- when the caller asks for it (partner follow-up view).
create function public.motorist_partner_followup_projection(p_organization_id uuid, p_case_id uuid, p_with_contact boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'caseId', c.id, 'caseNumber', c.case_number, 'createdAt', c.created_at, 'caseType', c.case_type,
  'workStatus', case when c.status in ('new','triage') then 'received'
   when c.status in ('completed_assisted','completed_no_assistance') then 'completed'
   when c.status in ('rejected','cancelled','futile_trip') then 'cancelled' else 'in_progress' end,
  'vehicle', jsonb_build_object('make', nullif(btrim(v.make), ''), 'model', nullif(btrim(v.model), ''), 'plate', nullif(btrim(v.license_plate), '')),
  'insuranceEvent', coalesce(f.insurance_event, false), 'insuranceLabel', f.insurance_label, 'insuranceMarkedAt', f.insurance_marked_at,
  'status', coalesce(f.status, 'new'), 'revision', coalesce(f.revision, 0),
  'takenAt', f.taken_at, 'takenBy', tm.display_name, 'contactedAt', f.contacted_at, 'contactedBy', cm.display_name,
  'customer', case when p_with_contact and coalesce(f.insurance_event, false) then jsonb_build_object(
   'name', coalesce(nullif(btrim(k.name), ''),
    nullif(btrim(concat_ws(' ', c.customer_details->>'firstName', c.customer_details->>'lastName')), ''),
    nullif(btrim(c.customer_details->>'companyName'), '')),
   'phone', coalesce(nullif(btrim(k.phone), ''), (
    select nullif(btrim(e.value->>'phone'), '') from jsonb_array_elements(
     case when jsonb_typeof(c.customer_details->'contacts') = 'array' then c.customer_details->'contacts' else '[]'::jsonb end
    ) with ordinality e(value, position)
    where nullif(btrim(e.value->>'phone'), '') is not null
    order by coalesce(e.value->>'isPrimary' = 'true', false) desc, e.position limit 1))) end,
  'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'author', n.author_label, 'createdAt', n.created_at) order by n.created_at, n.id), '[]'::jsonb)
   from public.motorist_partner_case_notes n where n.organization_id = x.organization_id and n.partner_id = x.partner_id and n.case_id = x.case_id))
 from public.motorist_partner_case_contexts x
 join public.motorist_cases c on c.id = x.case_id and c.organization_id = x.organization_id
 left join public.motorist_vehicles v on v.id = c.vehicle_id and v.organization_id = c.organization_id
 left join public.motorist_contacts k on k.id = c.contact_id and k.organization_id = c.organization_id
 left join public.motorist_partner_case_followups f on f.case_id = x.case_id and f.organization_id = x.organization_id and f.partner_id = x.partner_id
 left join public.motorist_partner_memberships tm on tm.id = f.taken_by
 left join public.motorist_partner_memberships cm on cm.id = f.contacted_by
 where x.organization_id = p_organization_id and x.case_id = p_case_id
$$;

-- Cases are counted by case creation in [from, to). Time to contact is measured
-- from insurance marking to recorded contact only when both timestamps exist.
-- contactPending: insurance events not yet contacted; contactUnknown: contacted,
-- but without a usable marking-to-contact interval (for example re-marked later).
create function public.motorist_partner_followup_stats(p_organization_id uuid, p_partner_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('from', p_from, 'to', p_to, 'cases', count(*),
  'insuranceEvents', count(*) filter (where f.insurance_event),
  'taken', count(*) filter (where f.insurance_event and f.taken_at is not null),
  'contacted', count(*) filter (where f.insurance_event and f.contacted_at is not null),
  'contactSample', count(*) filter (where f.insurance_event and f.contacted_at >= f.insurance_marked_at),
  'contactPending', count(*) filter (where f.insurance_event and f.contacted_at is null),
  'contactUnknown', count(*) filter (where f.insurance_event and f.contacted_at is not null and not coalesce(f.contacted_at >= f.insurance_marked_at, false)),
  'contactMedianMinutes', round((percentile_cont(0.5) within group (order by extract(epoch from f.contacted_at - f.insurance_marked_at) / 60)
   filter (where f.insurance_event and f.contacted_at >= f.insurance_marked_at))::numeric, 1))
 from public.motorist_partner_case_contexts x
 join public.motorist_cases c on c.id = x.case_id and c.organization_id = x.organization_id
 left join public.motorist_partner_case_followups f on f.case_id = x.case_id and f.organization_id = x.organization_id and f.partner_id = x.partner_id
 where x.organization_id = p_organization_id and x.partner_id = p_partner_id and c.created_at >= p_from and c.created_at < p_to
$$;

create function public.motorist_partner_portal_cases(p_user_id uuid, p_organization_id uuid, p_membership_version bigint, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.motorist_partner_memberships;
begin
 m := public.motorist_partner_followup_member(p_user_id, p_organization_id, p_membership_version);
 perform public.motorist_partner_followup_period(p_from, p_to);
 return jsonb_build_object(
  'partnerName', (select name from public.motorist_partner_directory where id = m.partner_id),
  'account', m.display_name,
  'newInsurance', (select count(*) from public.motorist_partner_case_followups f where f.organization_id = m.organization_id and f.partner_id = m.partner_id and f.insurance_event and f.status = 'new'),
  'stats', public.motorist_partner_followup_stats(m.organization_id, m.partner_id, p_from, p_to),
  -- Every still-new insurance event first (the badge stays actionable beyond the
  -- bound and the period), then the period list, newest first.
  'cases', (select coalesce(jsonb_agg(public.motorist_partner_followup_projection(m.organization_id, q.case_id, true) order by q.pinned desc, q.created_at desc, q.case_id), '[]'::jsonb)
   from (select x.case_id, c.created_at, coalesce(f.insurance_event and f.status = 'new', false) pinned from public.motorist_partner_case_contexts x
    join public.motorist_cases c on c.id = x.case_id and c.organization_id = x.organization_id
    left join public.motorist_partner_case_followups f on f.case_id = x.case_id and f.partner_id = x.partner_id
    where x.organization_id = m.organization_id and x.partner_id = m.partner_id
     and ((c.created_at >= p_from and c.created_at < p_to) or (f.insurance_event and f.status = 'new'))
    order by pinned desc, c.created_at desc, x.case_id limit 200) q));
end $$;

create function public.motorist_partner_followup_command(p_user_id uuid, p_organization_id uuid, p_membership_version bigint,
 p_command_id uuid, p_expected_revision bigint, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.motorist_partner_memberships; prior public.motorist_partner_followup_commands; x public.motorist_partner_case_contexts;
 f public.motorist_partner_case_followups; fp text; target uuid; note text; result jsonb;
begin
 m := public.motorist_partner_followup_member(p_user_id, p_organization_id, p_membership_version);
 if p_command_id is null or p_action is null or p_action not in ('take','contacted','note') or jsonb_typeof(p_payload) is distinct from 'object'
  or octet_length(p_payload::text) > 8000 or p_expected_revision is null then
  raise exception 'Neplatný príkaz' using errcode = '22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('partner-followup:' || p_organization_id::text || ':' || p_command_id::text, 0));
 fp := encode(sha256(convert_to(jsonb_build_array('partner', m.id, p_action, p_expected_revision, p_payload)::text, 'UTF8')), 'hex');
 select * into prior from public.motorist_partner_followup_commands where organization_id = p_organization_id and command_id = p_command_id;
 if found then
  if prior.actor_kind <> 'partner' or prior.actor_id <> m.id then raise insufficient_privilege; end if;
  if prior.fingerprint <> fp then raise exception 'command_content_conflict' using errcode = '40001'; end if;
  return prior.result;
 end if;
 target := (p_payload->>'caseId')::uuid;
 select * into x from public.motorist_partner_case_contexts where case_id = target and organization_id = m.organization_id and partner_id = m.partner_id for update;
 if x.case_id is null then raise insufficient_privilege; end if;
 if p_action = 'note' then
  note := btrim(coalesce(p_payload->>'body', ''));
  if char_length(note) not between 1 and 2000 then raise exception 'Poznámka musí mať 1 až 2000 znakov' using errcode = '22023'; end if;
  insert into public.motorist_partner_case_notes(id, organization_id, case_id, partner_id, membership_id, author_label, body)
   values (p_command_id, m.organization_id, target, m.partner_id, m.id, m.display_name, note);
  result := jsonb_build_object('ok', true, 'caseId', target, 'noteId', p_command_id);
 else
  select * into f from public.motorist_partner_case_followups where case_id = target for update;
  if coalesce(f.revision, 0) <> p_expected_revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
  if not coalesce(f.insurance_event, false) then raise exception 'Prevziať a kontaktovať možno iba poistnú udalosť' using errcode = '22023'; end if;
  if p_action = 'take' then
   if f.status <> 'new' then raise exception 'Prípad je už prevzatý' using errcode = '40001'; end if;
   update public.motorist_partner_case_followups set status = 'taken', taken_by = m.id, taken_at = now(), revision = revision + 1, updated_at = now()
    where case_id = target returning * into f;
  else
   if f.status <> 'taken' then raise exception 'Najprv prípad prevezmite; kontakt už môže byť zaznamenaný' using errcode = '40001'; end if;
   update public.motorist_partner_case_followups set status = 'contacted', contacted_by = m.id, contacted_at = now(), revision = revision + 1, updated_at = now()
    where case_id = target returning * into f;
  end if;
  result := jsonb_build_object('ok', true, 'caseId', target, 'status', f.status, 'revision', f.revision);
 end if;
 -- The shared partner account is recorded as the account, not as a person.
 insert into public.motorist_audit_log(organization_id, actor_profile_id, action, entity_type, entity_id, source, after_payload)
  values (m.organization_id, null, 'partner.followup.' || p_action, 'motorist_partner_case_followups', target, 'partner_portal',
   jsonb_build_object('actorKind', 'partner_account', 'membershipId', m.id, 'account', m.display_name, 'partnerId', m.partner_id, 'commandId', p_command_id) || (result - 'ok'));
 insert into public.motorist_partner_followup_commands(organization_id, command_id, actor_kind, actor_id, fingerprint, result)
  values (p_organization_id, p_command_id, 'partner', m.id, fp, result);
 return result;
end $$;

create function public.motorist_partner_followup_office_command(p_user_id uuid, p_organization_id uuid, p_command_id uuid,
 p_expected_revision bigint, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.motorist_profiles; prior public.motorist_partner_followup_commands; x public.motorist_partner_case_contexts;
 f public.motorist_partner_case_followups; fp text; target uuid; flag boolean; label text; result jsonb;
begin
 a := public.motorist_partner_followup_office(p_user_id, p_organization_id);
 if p_command_id is null or p_action is distinct from 'set_insurance' or jsonb_typeof(p_payload) is distinct from 'object'
  or jsonb_typeof(p_payload->'insuranceEvent') is distinct from 'boolean' or octet_length(p_payload::text) > 4000 or p_expected_revision is null then
  raise exception 'Neplatný príkaz' using errcode = '22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('partner-followup:' || p_organization_id::text || ':' || p_command_id::text, 0));
 fp := encode(sha256(convert_to(jsonb_build_array('office', a.id, p_action, p_expected_revision, p_payload)::text, 'UTF8')), 'hex');
 select * into prior from public.motorist_partner_followup_commands where organization_id = p_organization_id and command_id = p_command_id;
 if found then
  if prior.actor_kind <> 'office' or prior.actor_id <> a.id then raise insufficient_privilege; end if;
  if prior.fingerprint <> fp then raise exception 'command_content_conflict' using errcode = '40001'; end if;
  return prior.result;
 end if;
 target := (p_payload->>'caseId')::uuid;
 select * into x from public.motorist_partner_case_contexts where case_id = target and organization_id = p_organization_id for update;
 if x.case_id is null then raise insufficient_privilege; end if;
 flag := (p_payload->>'insuranceEvent')::boolean;
 label := case when flag then nullif(btrim(coalesce(p_payload->>'label', '')), '') end;
 if char_length(label) > 80 then raise exception 'Označenie poistnej udalosti má najviac 80 znakov' using errcode = '22023'; end if;
 select * into f from public.motorist_partner_case_followups where case_id = target for update;
 if coalesce(f.revision, 0) <> p_expected_revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
 if f.case_id is null then
  insert into public.motorist_partner_case_followups(case_id, organization_id, partner_id, insurance_event, insurance_label, insurance_marked_by, insurance_marked_at)
   values (target, x.organization_id, x.partner_id, flag, label, case when flag then a.id end, case when flag then now() end) returning * into f;
 else
  -- Unmarking/re-marking is an office correction of the classification: the partner's
  -- follow-up status and its taken/contacted history are kept, and a re-mark starts a
  -- new marking time (an earlier contact then has no measurable time to contact).
  update public.motorist_partner_case_followups set insurance_event = flag, insurance_label = label,
   insurance_marked_by = case when not flag then null when f.insurance_event then f.insurance_marked_by else a.id end,
   insurance_marked_at = case when not flag then null when f.insurance_event then f.insurance_marked_at else now() end,
   revision = revision + 1, updated_at = now()
   where case_id = target returning * into f;
 end if;
 result := jsonb_build_object('ok', true, 'caseId', target, 'insuranceEvent', f.insurance_event, 'revision', f.revision);
 insert into public.motorist_audit_log(organization_id, actor_profile_id, action, entity_type, entity_id, source, after_payload)
  values (p_organization_id, a.id, 'partner.followup.set_insurance', 'motorist_partner_case_followups', target, 'partner_workspace',
   jsonb_build_object('partnerId', x.partner_id, 'label', f.insurance_label, 'commandId', p_command_id) || (result - 'ok'));
 insert into public.motorist_partner_followup_commands(organization_id, command_id, actor_kind, actor_id, fingerprint, result)
  values (p_organization_id, p_command_id, 'office', a.id, fp, result);
 return result;
end $$;

create function public.motorist_partner_followup_office_read(p_user_id uuid, p_organization_id uuid, p_from timestamptz, p_to timestamptz, p_case_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
 perform public.motorist_partner_followup_office(p_user_id, p_organization_id);
 perform public.motorist_partner_followup_period(p_from, p_to);
 return jsonb_build_object(
  -- A case detail needs only its own projection, not the all-partner overview.
  'partners', case when p_case_id is not null then '[]'::jsonb else (select coalesce(jsonb_agg(jsonb_build_object('partnerId', d.id, 'partnerName', d.name,
    'newInsurance', (select count(*) from public.motorist_partner_case_followups f where f.organization_id = d.organization_id and f.partner_id = d.id and f.insurance_event and f.status = 'new'),
    'stats', public.motorist_partner_followup_stats(d.organization_id, d.id, p_from, p_to),
    'cases', (select coalesce(jsonb_agg(public.motorist_partner_followup_projection(d.organization_id, q.case_id, false) order by q.created_at desc, q.case_id), '[]'::jsonb)
     from (select x.case_id, c.created_at from public.motorist_partner_case_contexts x
      join public.motorist_cases c on c.id = x.case_id and c.organization_id = x.organization_id
      where x.organization_id = d.organization_id and x.partner_id = d.id and c.created_at >= p_from and c.created_at < p_to
      order by c.created_at desc, x.case_id limit 50) q)) order by d.name, d.id), '[]'::jsonb)
   from public.motorist_partner_directory d where d.organization_id = p_organization_id
    and exists(select 1 from public.motorist_partner_case_contexts x where x.organization_id = d.organization_id and x.partner_id = d.id)) end,
  'case', case when p_case_id is not null then public.motorist_partner_followup_projection(p_organization_id, p_case_id, false) end);
end $$;

do $$ declare t text; f regprocedure; begin
 foreach t in array array['motorist_partner_case_followups','motorist_partner_case_notes','motorist_partner_followup_commands'] loop
  execute format('alter table public.%I enable row level security', t);
  execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  execute format('grant select on public.%I to service_role', t);
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in (
  'motorist_partner_followup_append_only','motorist_partner_followup_member','motorist_partner_followup_office','motorist_partner_followup_period',
  'motorist_partner_followup_projection','motorist_partner_followup_stats','motorist_partner_portal_cases','motorist_partner_followup_command',
  'motorist_partner_followup_office_command','motorist_partner_followup_office_read') loop
  execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
 end loop;
end $$;
grant execute on function public.motorist_partner_portal_cases(uuid,uuid,bigint,timestamptz,timestamptz) to service_role;
grant execute on function public.motorist_partner_followup_command(uuid,uuid,bigint,uuid,bigint,text,jsonb) to service_role;
grant execute on function public.motorist_partner_followup_office_command(uuid,uuid,uuid,bigint,text,jsonb) to service_role;
grant execute on function public.motorist_partner_followup_office_read(uuid,uuid,timestamptz,timestamptz,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
