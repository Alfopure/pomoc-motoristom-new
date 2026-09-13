-- Additive limited external case grants. Existing cases and telephony are not rewritten.
begin;
create schema if not exists app_private;
create table public.motorist_case_handoffs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 case_id uuid not null references public.motorist_cases(id) on delete cascade,
 created_by uuid references public.motorist_profiles(id) on delete set null,
 recipient_name text not null check(length(recipient_name) between 1 and 160), recipient_phone text not null check(length(recipient_phone) between 5 and 30),
 published jsonb not null, published_version integer not null default 1, revision integer not null default 1,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'), token_generation integer not null default 1,
 status text not null default 'offered' check(status in ('offered','accepted','en_route','arrived','completed','rejected','cancelled','expired')),
 expires_at timestamptz not null, opened_at timestamptz, eta timestamptz,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create unique index motorist_case_handoff_active on public.motorist_case_handoffs(organization_id,case_id) where status in ('offered','accepted','en_route','arrived');
create table public.motorist_handoff_sessions (
 token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'), handoff_id uuid not null references public.motorist_case_handoffs(id) on delete cascade,
 generation integer not null, expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp()
);
create index motorist_handoff_sessions_grant on public.motorist_handoff_sessions(handoff_id,created_at);
create table public.motorist_handoff_events (
 id uuid primary key default gen_random_uuid(), handoff_id uuid not null references public.motorist_case_handoffs(id) on delete cascade,
 action text not null, comment text not null default '', actor_profile_id uuid references public.motorist_profiles(id) on delete set null,
 command_id uuid, revision integer not null, created_at timestamptz not null default clock_timestamp()
);
create table public.motorist_handoff_receipts (
 actor_key text not null, command_id uuid not null, handoff_id uuid not null references public.motorist_case_handoffs(id) on delete cascade,
 payload jsonb not null, committed_revision integer not null, created_at timestamptz not null default clock_timestamp(), primary key(actor_key,command_id)
);
alter table public.motorist_case_handoffs enable row level security;
alter table public.motorist_handoff_sessions enable row level security;
alter table public.motorist_handoff_events enable row level security;
alter table public.motorist_handoff_receipts enable row level security;
revoke all on public.motorist_case_handoffs,public.motorist_handoff_sessions,public.motorist_handoff_events,public.motorist_handoff_receipts from public,anon,authenticated,service_role;

-- Fixed snapshot projection: no arbitrary JSON, note, VIN, price, attachment or transcript.
create function app_private.motorist_handoff_case(p_org uuid,p_case uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('caseNumber',c.case_number,'action',coalesce(c.case_type,'Asistenčný úkon'),
  'contact',jsonb_build_object('name',coalesce(n.name,''),'phone',coalesce(n.phone,'')),
  'vehicle',jsonb_build_object('make',coalesce(v.make,''),'model',coalesce(v.model,''),'plate',coalesce(v.license_plate,'')),
  'pickup',case when p.id is not null then jsonb_build_object('address',p.address,'lat',p.lat,'lng',p.lng) when nullif(btrim(c.location_details->>'manualPickupAddress'),'') is not null then jsonb_build_object('address',c.location_details->>'manualPickupAddress','lat',null,'lng',null) else null end,
  'destination',case when d.id is not null then jsonb_build_object('address',d.address,'lat',d.lat,'lng',d.lng) when nullif(btrim(c.location_details->>'manualDestinationAddress'),'') is not null then jsonb_build_object('address',c.location_details->>'manualDestinationAddress','lat',null,'lng',null) else null end)
 from public.motorist_cases c
 left join public.motorist_contacts n on n.id=c.contact_id and n.organization_id=c.organization_id
 left join public.motorist_vehicles v on v.id=c.vehicle_id and v.organization_id=c.organization_id
 left join public.motorist_locations p on p.id=c.pickup_location_id and p.organization_id=c.organization_id
 left join public.motorist_locations d on d.id=c.destination_location_id and d.organization_id=c.organization_id
 where c.id=p_case and c.organization_id=p_org
$$;
create function app_private.motorist_handoff_dto(p_id uuid,p_public boolean default false) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',h.id,'status',case when h.expires_at<=clock_timestamp() and h.status in ('offered','accepted','en_route','arrived') then 'expired' else h.status end,
  'revision',h.revision,'publishedVersion',h.published_version,'recipientName',h.recipient_name,
  'expiresAt',h.expires_at,'createdAt',h.created_at,'openedAt',h.opened_at,'eta',h.eta,
  'published',case when p_public and h.status in ('completed','rejected') then null else h.published end,
  'events',case when p_public and h.status in ('completed','rejected') then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'comment',e.comment,
    'actor',case when e.actor_profile_id is null then 'Držiteľ odkazu' else 'Dispečing' end,'createdAt',e.created_at) order by e.created_at,e.id)
    from public.motorist_handoff_events e where e.handoff_id=h.id),'[]'::jsonb) end)
  || case when p_public then '{}'::jsonb else jsonb_build_object('recipientPhone',h.recipient_phone,'canRenew',h.status in ('offered','accepted','en_route','arrived')) end
 from public.motorist_case_handoffs h where h.id=p_id
$$;
revoke all on function app_private.motorist_handoff_case(uuid,uuid),app_private.motorist_handoff_dto(uuid,boolean) from public,anon,authenticated,service_role;

create function public.motorist_case_handoff(p_organization_id uuid,p_actor_id uuid,p_case_id uuid,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare h public.motorist_case_handoffs; receipt public.motorist_handoff_receipts; snapshot jsonb; fingerprint jsonb;
 cid uuid; v_actor_key text; handoff_id uuid; hours integer; comment text; token text;
begin
 if auth.uid() is null or not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
  where p.id=p_actor_id and p.user_id=auth.uid() and p.organization_id=p_organization_id and p.active and p.access_status='active'
  and p.role in ('dispatcher','senior_dispatcher','manager','admin')) then raise exception 'Forbidden' using errcode='42501'; end if;
 perform 1 from public.motorist_cases where id=p_case_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Case unavailable' using errcode='P0002'; end if;
 snapshot:=app_private.motorist_handoff_case(p_organization_id,p_case_id);
 if p_action='context' then return jsonb_build_object('preview',snapshot,'previewVersion',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),
  'handoffs',coalesce((select jsonb_agg(app_private.motorist_handoff_dto(t.id) order by t.created_at desc) from public.motorist_case_handoffs t where t.organization_id=p_organization_id and t.case_id=p_case_id),'[]'::jsonb)); end if;
 if p_action not in ('issue','publish','renew','revoke') or jsonb_typeof(p_input)<>'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 cid:=(p_input->>'commandId')::uuid; if cid is null then raise exception 'Command required' using errcode='22023'; end if;
 v_actor_key:='profile:'||p_actor_id; fingerprint:=jsonb_build_object('case',p_case_id,'action',p_action,'input',p_input-'tokenHash');
 select * into receipt from public.motorist_handoff_receipts r where r.actor_key=v_actor_key and r.command_id=cid;
 if found then
  if receipt.payload<>fingerprint then raise exception 'Command conflict' using errcode='PT409'; end if;
  return jsonb_build_object('handoff',app_private.motorist_handoff_dto(receipt.handoff_id),'commandId',cid,'committedRevision',receipt.committed_revision,'tokenAccepted',false);
 end if;
 if p_action in ('issue','publish') then
  if p_input->>'previewVersion' is distinct from encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') then raise exception 'Case changed' using errcode='PT409'; end if;
  comment:=btrim(coalesce(p_input->>'instructions',''));
  if length(comment)>2000 then raise exception 'Instructions too long' using errcode='22023'; end if;
  snapshot:=snapshot||jsonb_build_object('instructions',comment,'scheduledAt',nullif(p_input->>'scheduledAt','')::timestamptz);
 end if;
 if p_action in ('issue','renew') then
  hours:=coalesce((p_input->>'hours')::integer,24); token:=p_input->>'tokenHash';
  if hours<1 or hours>72 or token is null or token!~'^[a-f0-9]{64}$' then raise exception 'Invalid grant' using errcode='22023'; end if;
 end if;
 if p_action='issue' then
  if length(btrim(coalesce(p_input->>'recipientName',''))) not between 1 and 160 or coalesce(p_input->>'recipientPhone','')!~'^\+?[0-9 ()-]{5,30}$' then raise exception 'Recipient required' using errcode='22023'; end if;
  update public.motorist_case_handoffs set status='expired',revision=revision+1,updated_at=clock_timestamp() where organization_id=p_organization_id and case_id=p_case_id and status in ('offered','accepted','en_route','arrived') and expires_at<=clock_timestamp();
  if exists(select 1 from public.motorist_case_handoffs where organization_id=p_organization_id and case_id=p_case_id and status in ('offered','accepted','en_route','arrived')) then raise exception 'Active handoff exists' using errcode='PT409'; end if;
  insert into public.motorist_case_handoffs(organization_id,case_id,created_by,recipient_name,recipient_phone,published,token_hash,expires_at)
   values(p_organization_id,p_case_id,p_actor_id,btrim(p_input->>'recipientName'),p_input->>'recipientPhone',snapshot,token,clock_timestamp()+make_interval(hours=>hours)) returning * into h;
 else
  handoff_id:=(p_input->>'handoffId')::uuid;
  select * into h from public.motorist_case_handoffs where id=handoff_id and organization_id=p_organization_id and case_id=p_case_id for update;
  if not found then raise exception 'Handoff unavailable' using errcode='P0002'; end if;
  if h.revision is distinct from (p_input->>'expectedRevision')::integer then raise exception 'Handoff changed' using errcode='PT409'; end if;
  if h.status not in ('offered','accepted','en_route','arrived') then raise exception 'Terminal handoff' using errcode='PT409'; end if;
  if p_action='revoke' then
   comment:=regexp_replace(coalesce(p_input->>'comment',''),'^[[:space:]]+|[[:space:]]+$','','g'); if length(comment) not between 1 and 1000 then raise exception 'Reason required' using errcode='22023'; end if;
   h.status:='cancelled'; h.token_generation:=h.token_generation+1;
  elsif p_action='renew' then
   h.token_hash:=token; h.token_generation:=h.token_generation+1; h.expires_at:=clock_timestamp()+make_interval(hours=>hours);
  else
   if h.expires_at<=clock_timestamp() then raise exception 'Grant expired' using errcode='PT409'; end if;
   h.published:=snapshot; h.published_version:=h.published_version+1;
  end if;
  h.revision:=h.revision+1;
  update public.motorist_case_handoffs set status=h.status,token_hash=h.token_hash,token_generation=h.token_generation,expires_at=h.expires_at,
   published=h.published,published_version=h.published_version,revision=h.revision,updated_at=clock_timestamp() where id=h.id;
 end if;
 insert into public.motorist_handoff_events(handoff_id,action,comment,actor_profile_id,command_id,revision) values(h.id,p_action,case when p_action='revoke' then comment else '' end,p_actor_id,cid,h.revision);
 insert into public.motorist_handoff_receipts(actor_key,command_id,handoff_id,payload,committed_revision) values(v_actor_key,cid,h.id,fingerprint,h.revision);
 return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id),'commandId',cid,'committedRevision',h.revision,'tokenAccepted',p_action in ('issue','renew'));
end $$;
revoke all on function public.motorist_case_handoff(uuid,uuid,uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.motorist_case_handoff(uuid,uuid,uuid,text,jsonb) to authenticated;

create function public.motorist_public_handoff(p_action text,p_token_hash text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare h public.motorist_case_handoffs; s public.motorist_handoff_sessions; receipt public.motorist_handoff_receipts;
 cid uuid; action text; v_actor_key text; fingerprint jsonb; comment text; next_status text; session_hash text;
begin
 if p_token_hash is null or p_token_hash!~'^[a-f0-9]{64}$' then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 if p_action='session' then
  select * into h from public.motorist_case_handoffs where token_hash=p_token_hash for update;
 else
  select * into s from public.motorist_handoff_sessions where token_hash=p_token_hash and expires_at>clock_timestamp();
  if not found then raise exception 'Grant unavailable' using errcode='P0002'; end if;
  select * into h from public.motorist_case_handoffs where id=s.handoff_id for update;
  if h.token_generation is distinct from s.generation or s.expires_at<=clock_timestamp() then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 end if;
 if h.id is null or h.expires_at<=clock_timestamp() or h.status in ('cancelled','expired')
  or not exists(select 1 from public.motorist_organizations where id=h.organization_id and active)
  or not exists(select 1 from public.motorist_cases where id=h.case_id and organization_id=h.organization_id) then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 if p_action='session' then
  session_hash:=p_input->>'sessionHash';
  if session_hash is null or session_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid session' using errcode='22023'; end if;
  if (select count(*) from public.motorist_handoff_sessions where handoff_id=h.id and created_at>clock_timestamp()-interval '1 hour')>=60 then raise exception 'Too many sessions' using errcode='54000'; end if;
  insert into public.motorist_handoff_sessions(token_hash,handoff_id,generation,expires_at) values(session_hash,h.id,h.token_generation,least(h.expires_at,clock_timestamp()+interval '12 hours'));
  if h.opened_at is null then update public.motorist_case_handoffs set opened_at=clock_timestamp() where id=h.id; end if;
  return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id,true),'sessionExpiresAt',least(h.expires_at,clock_timestamp()+interval '12 hours'));
 end if;
 if h.id is distinct from (p_input->>'handoffId')::uuid then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 if p_action='read' then return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id,true)); end if;
 if p_action<>'command' or jsonb_typeof(p_input)<>'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 cid:=(p_input->>'commandId')::uuid; action:=p_input->>'action';
 if cid is null or action is null or action not in ('accept','reject','en_route','arrived','complete','update','blocked') then raise exception 'Invalid action' using errcode='22023'; end if;
 v_actor_key:='session:'||p_token_hash; fingerprint:=jsonb_build_object('handoff',h.id,'input',p_input);
 select * into receipt from public.motorist_handoff_receipts r where r.actor_key=v_actor_key and r.command_id=cid;
 if found then
  if receipt.payload<>fingerprint then raise exception 'Command conflict' using errcode='PT409'; end if;
  return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id,true),'commandId',cid,'committedRevision',receipt.committed_revision);
 end if;
 if h.revision is distinct from (p_input->>'expectedRevision')::integer or h.published_version is distinct from (p_input->>'publishedVersion')::integer then raise exception 'Handoff changed' using errcode='PT409'; end if;
 comment:=regexp_replace(coalesce(p_input->>'comment',''),'^[[:space:]]+|[[:space:]]+$','','g');
 if length(comment)>1000 or (action in ('reject','blocked') and comment='') then raise exception 'Reason required' using errcode='22023'; end if;
 next_status:=case
  when action='accept' and h.status='offered' then 'accepted'
  when action='reject' and h.status='offered' then 'rejected'
  when action='en_route' and h.status='accepted' then 'en_route'
  when action='arrived' and h.status='en_route' then 'arrived'
  when action='complete' and h.status='arrived' then 'completed'
  when action in ('update','blocked') and h.status in ('accepted','en_route','arrived') then h.status else null end;
 if next_status is null then raise exception 'Invalid transition' using errcode='PT409'; end if;
 if action='update' then
  if p_input ? 'eta' then
   h.eta:=nullif(p_input->>'eta','')::timestamptz;
   if h.eta is not null and (h.eta<clock_timestamp()-interval '5 minutes' or h.eta>h.expires_at) then raise exception 'Invalid ETA' using errcode='22023'; end if;
  end if;
  if h.eta is null and comment='' then raise exception 'Update required' using errcode='22023'; end if;
 end if;
 h.revision:=h.revision+1;
 update public.motorist_case_handoffs set status=next_status,revision=h.revision,eta=h.eta,updated_at=clock_timestamp() where id=h.id;
 insert into public.motorist_handoff_events(handoff_id,action,comment,command_id,revision) values(h.id,action,comment,cid,h.revision);
 insert into public.motorist_handoff_receipts(actor_key,command_id,handoff_id,payload,committed_revision) values(v_actor_key,cid,h.id,fingerprint,h.revision);
 -- The bell record and state are committed together, once. No new worker is needed.
 if h.created_by is not null and exists(select 1 from public.motorist_profiles where id=h.created_by and organization_id=h.organization_id and active and access_status='active') then
  insert into public.motorist_notifications(organization_id,case_id,recipient_profile_id,visibility,kind,severity,title,body,status,delivery_status,dedupe_key,payload)
   values(h.organization_id,h.case_id,h.created_by,'private','handover',case when action in ('reject','blocked') then 'warning' else 'info' end,
    'Externé odovzdanie prípadu',h.recipient_name||': '||case action when 'accept' then 'prijaté' when 'reject' then 'odmietnuté' when 'en_route' then 'na ceste' when 'arrived' then 'na mieste' when 'complete' then 'dokončené' when 'blocked' then 'problém pri realizácii' else 'aktualizovaný postup' end,
    'unread','in_app','case-handoff:'||h.id||':'||cid,jsonb_build_object('source','case_handoff','handoffId',h.id,'action',action))
   on conflict(organization_id,dedupe_key) do nothing;
 end if;
 return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id,true),'commandId',cid,'committedRevision',h.revision);
end $$;
revoke all on function public.motorist_public_handoff(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_public_handoff(text,text,jsonb) to service_role;
commit;
