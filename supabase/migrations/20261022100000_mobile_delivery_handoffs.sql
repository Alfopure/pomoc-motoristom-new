-- Pristavovač in the mobile app (owner request 2026-10-22). Applies to TEST
-- nzpnqdstvkfncflgqlny only after the owner's explicit approval; production
-- needs its own. Requires the handoff expansion (20261009100000), the field
-- memberships (20261013120000) and the push devices (20261020210000).
-- A pristavovač is a field member, never a dispatch profile: organization-wide
-- case policies apply to dispatch profiles only, so a field member sees only
-- the handoffs sent to them, through these server-side functions.
begin;

do $$ begin
  if to_regclass('public.motorist_mobile_push_devices') is null then
    raise exception 'Run 20261020210000_mobile_push_devices.sql first' using errcode = '55000';
  end if;
end $$;

-- 1. The delivery role ("pristavovač") of a field member.
alter table public.motorist_towing_memberships drop constraint motorist_towing_memberships_roles_check;
alter table public.motorist_towing_memberships add constraint motorist_towing_memberships_roles_check
  check (roles <@ array['driver','dispatch','billing','manager','delivery']::text[] and cardinality(roles) > 0);
create or replace function app_private.towing_capabilities(p_roles text[]) returns text[] language sql immutable set search_path='' as $$
 select coalesce(array_agg(distinct c),'{}'::text[]) from unnest(p_roles) r cross join lateral unnest(case r
 when 'driver' then array['drive'] when 'dispatch' then array['operate','price','documents']
 when 'billing' then array['price','bill','cash','documents','report']
 when 'manager' then array['operate','price','bill','cash','correct','members','documents','report']
 when 'delivery' then array['deliver'] else '{}'::text[] end) c
$$;

-- 2. A handoff delivered to a pristavovač in the app; the link stays a fallback.
alter table public.motorist_case_handoffs add column recipient_member_id uuid;
alter table public.motorist_case_handoffs add constraint motorist_case_handoffs_member_fk
  foreign key (organization_id, recipient_member_id) references public.motorist_towing_memberships(organization_id, id);
create index motorist_case_handoffs_member_idx on public.motorist_case_handoffs (recipient_member_id, created_at desc) where recipient_member_id is not null;
alter table public.motorist_handoff_events add column actor_member_id uuid references public.motorist_towing_memberships(id) on delete set null;

-- 3. Where the pristavovač is during an active delivery; kept 30 days.
create table public.motorist_handoff_positions (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  handoff_id uuid not null references public.motorist_case_handoffs(id) on delete cascade,
  member_id uuid not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m real check (accuracy_m is null or (accuracy_m >= 0 and accuracy_m <= 100000)),
  recorded_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  foreign key (organization_id, member_id) references public.motorist_towing_memberships(organization_id, id) on delete cascade
);
create index motorist_handoff_positions_handoff_idx on public.motorist_handoff_positions (handoff_id, recorded_at desc);
create index motorist_handoff_positions_received_idx on public.motorist_handoff_positions (received_at);
alter table public.motorist_handoff_positions enable row level security;
revoke all on public.motorist_handoff_positions from public, anon, authenticated, service_role;
revoke all on sequence public.motorist_handoff_positions_id_seq from public, anon, authenticated, service_role;

-- 4. Push notifications to a field member's phone.
alter table public.motorist_mobile_push_devices alter column profile_id drop not null;
alter table public.motorist_mobile_push_devices add column member_id uuid;
alter table public.motorist_mobile_push_devices add constraint motorist_mobile_push_devices_member_fk
  foreign key (organization_id, member_id) references public.motorist_towing_memberships(organization_id, id) on delete cascade;
alter table public.motorist_mobile_push_devices add constraint motorist_mobile_push_devices_owner_check check (num_nonnulls(profile_id, member_id) = 1);
create index motorist_mobile_push_devices_member_idx on public.motorist_mobile_push_devices (organization_id, environment, member_id) where member_id is not null;

-- 5. The history says who acted: the pristavovač in the app, the link holder or
-- dispatch. The fields are unchanged, so a server from before this migration
-- (other Preview branches share the TEST database) still reads every handoff.
create or replace function app_private.motorist_handoff_dto(p_id uuid,p_public boolean default false) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',h.id,'status',case when h.expires_at<=clock_timestamp() and h.status in ('offered','accepted','en_route','arrived') then 'expired' else h.status end,
  'revision',h.revision,'publishedVersion',h.published_version,'recipientName',h.recipient_name,
  'expiresAt',h.expires_at,'createdAt',h.created_at,'openedAt',h.opened_at,'eta',h.eta,
  'createdBy',h.created_by_name,'publishedAt',h.published_at,
  'published',case when p_public and h.status in ('completed','rejected') then null else h.published end,
  'events',case when p_public and h.status in ('completed','rejected') then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'comment',e.comment,
   'actor',case when e.actor_member_id is not null then 'Pristavovač' when e.actor_profile_id is null then 'Držiteľ odkazu' else 'Dispečing' end,'createdAt',e.created_at) order by e.created_at,e.id)
   from public.motorist_handoff_events e where e.handoff_id=h.id),'[]'::jsonb) end)
  || case when p_public then '{}'::jsonb else jsonb_build_object('recipientPhone',h.recipient_phone,'canRenew',h.status in ('offered','accepted','en_route','arrived'),
   'tokenGeneration',h.token_generation,'recoverable',h.token_envelope is not null) end
 from public.motorist_case_handoffs h where h.id=p_id
$$;
revoke all on function app_private.motorist_handoff_dto(uuid,boolean) from public,anon,authenticated,service_role;

-- A pristavovač who can work in the app: an active field member with the delivery
-- capability and a sign-in, whom the field checks admit, and who has no dispatch
-- profile (such an account opens the dispatcher app, which has no deliveries).
create function app_private.motorist_delivery_member_ready(m public.motorist_towing_memberships) returns boolean language sql stable security definer set search_path='' as $$
 select m.active and 'deliver'=any(m.capabilities) and m.auth_user_id is not null
  and exists(select 1 from public.motorist_organizations o where o.id=m.organization_id and o.active)
  and (m.office_profile_id is null or exists(select 1 from public.motorist_profiles p where p.id=m.office_profile_id and p.user_id=m.auth_user_id
   and p.organization_id=m.organization_id and p.active and p.access_status<>'disabled'))
  and not exists(select 1 from public.motorist_profiles p where p.user_id=m.auth_user_id and p.organization_id=m.organization_id and p.active
   and p.access_status='active' and p.kind<>'ai' and p.role in ('dispatcher','senior_dispatcher','manager','admin'))
$$;
revoke all on function app_private.motorist_delivery_member_ready(public.motorist_towing_memberships) from public,anon,authenticated,service_role;

-- What the pristavovač sees. The customer's card and the car's position only
-- while the delivery is open; once it is completed, rejected, cancelled or
-- expired only the history, without other people's comments. `tracking`: this
-- pristavovač shares their position, from their own first step in the app
-- until the delivery closes.
create function app_private.motorist_member_handoff_view(p_id uuid,p_member_id uuid) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',h.id,'status',case when not s.live and h.status in ('offered','accepted','en_route','arrived') then 'expired' else h.status end,
  'revision',h.revision,'publishedVersion',h.published_version,'caseNumber',c.case_number,
  'expiresAt',h.expires_at,'createdAt',h.created_at,'openedAt',h.opened_at,'eta',h.eta,'createdBy',h.created_by_name,
  'published',case when s.live then h.published else null end,
  'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'comment',case when s.live or e.actor_member_id=p_member_id then e.comment else '' end,
    'actor',case when e.actor_member_id is not null then 'Pristavovač' when e.actor_profile_id is null then 'Držiteľ odkazu' else 'Dispečing' end,'createdAt',e.created_at) order by e.created_at,e.id)
   from public.motorist_handoff_events e where e.handoff_id=h.id),'[]'::jsonb),
  'tracking',s.live and h.status in ('accepted','en_route','arrived') and exists(select 1 from public.motorist_handoff_events e
   where e.handoff_id=h.id and e.actor_member_id=p_member_id and e.action in ('accept','en_route','arrived')),
  'replacementPosition',case when s.live then (
   select jsonb_build_object('lat',p.lat,'lng',p.lng,'recordedAt',p.gps_time)
   from (select a.id from public.motorist_fleet_assets a where a.organization_id=h.organization_id and a.kind='replacement_car'
     and (a.occupancy_case_id=h.case_id or (a.id=c.selected_asset_id and a.occupancy_case_id is null))) car
   join public.motorist_fleet_current_positions p on p.fleet_asset_id=car.id and p.organization_id=h.organization_id
   where (select count(*) from public.motorist_fleet_assets a where a.organization_id=h.organization_id and a.kind='replacement_car'
     and (a.occupancy_case_id=h.case_id or (a.id=c.selected_asset_id and a.occupancy_case_id is null)))=1
   order by p.gps_time desc limit 1) else null end)
 from public.motorist_case_handoffs h join public.motorist_cases c on c.id=h.case_id and c.organization_id=h.organization_id
 cross join lateral (select h.status in ('offered','accepted','en_route','arrived') and h.expires_at>clock_timestamp() as live) s
 where h.id=p_id
$$;
revoke all on function app_private.motorist_member_handoff_view(uuid,uuid) from public,anon,authenticated,service_role;

-- 6. The pristavovač's own work: list, read, the same steps as the link, position.
-- A closed delivery stays listed and readable for a day, without customer data.
create function public.motorist_member_handoff(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.motorist_towing_memberships; h public.motorist_case_handoffs; receipt public.motorist_handoff_receipts;
 cid uuid; action text; v_actor_key text; fingerprint jsonb; comment text; next_status text; last_at timestamptz; v_since timestamptz;
 v_lat double precision; v_lng double precision; v_accuracy real; v_recorded timestamptz;
begin
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if not 'deliver'=any(m.capabilities) then raise exception 'Delivery access denied' using errcode='42501'; end if;
 if jsonb_typeof(p_input)<>'object' then raise exception 'Invalid input' using errcode='22023'; end if;
 if p_action='list' then
  return jsonb_build_object('handoffs',coalesce((select jsonb_agg(app_private.motorist_member_handoff_view(t.id,m.id) order by t.live desc,t.created_at desc)
   from (select x.id,x.created_at,x.status in ('offered','accepted','en_route','arrived') and x.expires_at>clock_timestamp() as live
    from public.motorist_case_handoffs x where x.organization_id=m.organization_id and x.recipient_member_id=m.id
     and coalesce(case when x.status in ('offered','accepted','en_route','arrived') then x.expires_at end,x.updated_at)>clock_timestamp()-interval '24 hours'
    order by live desc,x.created_at desc limit 100) t),'[]'::jsonb));
 end if;
 select * into h from public.motorist_case_handoffs where id=(p_input->>'handoffId')::uuid and organization_id=m.organization_id and recipient_member_id=m.id for update;
 if h.id is null or not exists(select 1 from public.motorist_cases where id=h.case_id and organization_id=h.organization_id)
  or coalesce(case when h.status in ('offered','accepted','en_route','arrived') then h.expires_at end,h.updated_at)<=clock_timestamp()-interval '24 hours' then
  raise exception 'Grant unavailable' using errcode='P0002';
 end if;
 if p_action='read' then
  -- Opening the delivery tells the dispatcher it was seen, as opening the link does.
  if h.opened_at is null and h.status='offered' and h.expires_at>clock_timestamp() then update public.motorist_case_handoffs set opened_at=clock_timestamp() where id=h.id; end if;
  return jsonb_build_object('handoff',app_private.motorist_member_handoff_view(h.id,m.id));
 end if;
 if h.expires_at<=clock_timestamp() or h.status in ('cancelled','expired') then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 if p_action='position' then
  v_lat:=(p_input->>'lat')::double precision; v_lng:=(p_input->>'lng')::double precision;
  v_accuracy:=nullif(p_input->>'accuracy','')::real; v_recorded:=(p_input->>'recordedAt')::timestamptz;
  if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 or v_recorded is null
   or (v_accuracy is not null and (v_accuracy<0 or v_accuracy>100000)) then raise exception 'Invalid position' using errcode='22023'; end if;
  -- Only the pristavovač who took a step in the app, until the delivery closes;
  -- `active` false tells the phone to stop.
  select min(e.created_at) into v_since from public.motorist_handoff_events e where e.handoff_id=h.id and e.actor_member_id=m.id and e.action in ('accept','en_route','arrived');
  if v_since is null or h.status not in ('accepted','en_route','arrived') then return jsonb_build_object('stored',false,'active',false); end if;
  -- A reading from before that step, a stale or a future one is not stored.
  if v_recorded<greatest(clock_timestamp()-interval '15 minutes',v_since-interval '1 minute') or v_recorded>clock_timestamp()+interval '2 minutes' then
   return jsonb_build_object('stored',false,'active',true);
  end if;
  select max(recorded_at) into last_at from public.motorist_handoff_positions where handoff_id=h.id;
  if last_at is not null and v_recorded<last_at+interval '10 seconds' then return jsonb_build_object('stored',false,'active',true); end if;
  insert into public.motorist_handoff_positions(organization_id,handoff_id,member_id,lat,lng,accuracy_m,recorded_at)
   values(h.organization_id,h.id,m.id,v_lat,v_lng,v_accuracy,v_recorded);
  return jsonb_build_object('stored',true,'active',true);
 end if;
 if p_action<>'command' then raise exception 'Invalid command' using errcode='22023'; end if;
 cid:=(p_input->>'commandId')::uuid; action:=p_input->>'action';
 if cid is null or action is null or action not in ('accept','reject','en_route','arrived','complete','update','blocked') then raise exception 'Invalid action' using errcode='22023'; end if;
 v_actor_key:='member:'||m.id; fingerprint:=jsonb_build_object('handoff',h.id,'input',p_input);
 select * into receipt from public.motorist_handoff_receipts r where r.actor_key=v_actor_key and r.command_id=cid;
 if found then
  if receipt.payload<>fingerprint then raise exception 'Command conflict' using errcode='PT409'; end if;
  return jsonb_build_object('handoff',app_private.motorist_member_handoff_view(h.id,m.id),'commandId',cid,'committedRevision',receipt.committed_revision);
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
 update public.motorist_case_handoffs set status=next_status,revision=h.revision,eta=h.eta,opened_at=coalesce(opened_at,clock_timestamp()),updated_at=clock_timestamp() where id=h.id;
 insert into public.motorist_handoff_events(handoff_id,action,comment,command_id,revision,actor_member_id) values(h.id,action,comment,cid,h.revision,m.id);
 insert into public.motorist_handoff_receipts(actor_key,command_id,handoff_id,payload,committed_revision) values(v_actor_key,cid,h.id,fingerprint,h.revision);
 if h.created_by is not null and exists(select 1 from public.motorist_profiles where id=h.created_by and organization_id=h.organization_id and active and access_status='active') then
  insert into public.motorist_notifications(organization_id,case_id,recipient_profile_id,visibility,kind,severity,title,body,status,delivery_status,dedupe_key,payload)
   values(h.organization_id,h.case_id,h.created_by,'private','handover',case when action in ('reject','blocked') then 'warning' else 'info' end,
    'Pristavenie v aplikácii',m.display_name||': '||case action when 'accept' then 'prijaté' when 'reject' then 'odmietnuté' when 'en_route' then 'na ceste' when 'arrived' then 'na mieste' when 'complete' then 'dokončené' when 'blocked' then 'problém pri realizácii' else 'aktualizovaný postup' end,
    'unread','in_app','case-handoff:'||h.id||':'||cid,jsonb_build_object('source','case_handoff','handoffId',h.id,'action',action))
   on conflict(organization_id,dedupe_key) do nothing;
 end if;
 return jsonb_build_object('handoff',app_private.motorist_member_handoff_view(h.id,m.id),'commandId',cid,'committedRevision',h.revision);
end $$;
revoke all on function public.motorist_member_handoff(uuid,uuid,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_member_handoff(uuid,uuid,bigint,text,jsonb) to service_role;

-- 7. The dispatcher's side: who can receive in the app, which handoffs of the case
-- are in someone's app (and where that pristavovač is), and sending one there.
create function public.motorist_case_handoff_app(p_organization_id uuid,p_actor_id uuid,p_case_id uuid,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare h public.motorist_case_handoffs; m public.motorist_towing_memberships;
begin
 perform 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
  where p.id=p_actor_id and p.user_id=auth.uid() and p.organization_id=p_organization_id and p.active and p.access_status='active'
  and p.role in ('dispatcher','senior_dispatcher','manager','admin');
 if auth.uid() is null or not found then raise exception 'Forbidden' using errcode='42501'; end if;
 if jsonb_typeof(p_input)<>'object' then raise exception 'Invalid input' using errcode='22023'; end if;
 if p_action='members' then
  return jsonb_build_object('members',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'displayName',t.display_name,
    'lastPhone',(select x.recipient_phone from public.motorist_case_handoffs x where x.organization_id=t.organization_id and x.recipient_member_id=t.id order by x.created_at desc limit 1))
    order by t.display_name,t.id)
   from public.motorist_towing_memberships t where t.organization_id=p_organization_id and app_private.motorist_delivery_member_ready(t)),'[]'::jsonb));
 end if;
 perform 1 from public.motorist_cases where id=p_case_id and organization_id=p_organization_id;
 if not found then raise exception 'Case unavailable' using errcode='P0002'; end if;
 if p_action='app' then
  return jsonb_build_object('handoffs',coalesce((select jsonb_agg(jsonb_build_object('handoffId',x.id,'memberId',x.recipient_member_id,
    'position',case when x.status in ('accepted','en_route','arrived') and x.expires_at>clock_timestamp() then (
     select jsonb_build_object('lat',q.lat,'lng',q.lng,'accuracy',q.accuracy_m,'recordedAt',q.recorded_at)
     from public.motorist_handoff_positions q where q.handoff_id=x.id order by q.recorded_at desc limit 1) end) order by x.created_at desc)
   from public.motorist_case_handoffs x where x.organization_id=p_organization_id and x.case_id=p_case_id and x.recipient_member_id is not null),'[]'::jsonb));
 end if;
 if p_action<>'assign' then raise exception 'Invalid command' using errcode='22023'; end if;
 select * into h from public.motorist_case_handoffs where id=(p_input->>'handoffId')::uuid and organization_id=p_organization_id and case_id=p_case_id for update;
 if h.id is null then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 select * into m from public.motorist_towing_memberships where id=(p_input->>'memberId')::uuid and organization_id=p_organization_id;
 if not found then raise exception 'Invalid member' using errcode='22023'; end if;
 -- Sending to the same pristavovač again changes nothing, whatever happened since.
 if h.recipient_member_id=m.id then return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id),'assigned',false,'memberId',m.id); end if;
 if h.recipient_member_id is not null then raise exception 'Already sent' using errcode='PT409'; end if;
 if p_input ? 'expectedRevision' and h.revision is distinct from (p_input->>'expectedRevision')::integer then raise exception 'Handoff changed' using errcode='PT409'; end if;
 if h.status<>'offered' or h.expires_at<=clock_timestamp() then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 if not app_private.motorist_delivery_member_ready(m) then raise exception 'Invalid member' using errcode='22023'; end if;
 update public.motorist_case_handoffs set recipient_member_id=m.id,updated_at=clock_timestamp() where id=h.id;
 -- An ordinary update without the name: the link holder reads this history too.
 insert into public.motorist_handoff_events(handoff_id,action,comment,actor_profile_id,command_id,revision)
  values(h.id,'update','Odoslané do aplikácie pristavovača',p_actor_id,(p_input->>'commandId')::uuid,h.revision);
 return jsonb_build_object('handoff',app_private.motorist_handoff_dto(h.id),'assigned',true,'memberId',m.id);
end $$;
revoke all on function public.motorist_case_handoff_app(uuid,uuid,uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.motorist_case_handoff_app(uuid,uuid,uuid,text,jsonb) to authenticated;

-- 8. Positions are kept 30 days.
create function public.motorist_handoff_positions_prune() returns integer language plpgsql security definer set search_path='' as $$
declare deleted integer; begin
 delete from public.motorist_handoff_positions where received_at<clock_timestamp()-interval '30 days';
 get diagnostics deleted = row_count; return deleted;
end $$;
revoke all on function public.motorist_handoff_positions_prune() from public,anon,authenticated;
grant execute on function public.motorist_handoff_positions_prune() to service_role;

notify pgrst, 'reload schema';
commit;
