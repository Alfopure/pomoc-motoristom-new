-- Pristavovač: one app with modules for both roles, and the position also in the
-- background (owner, 2026-10-22). Applies after 20261022100000_mobile_delivery_handoffs.sql;
-- on TEST nzpnqdstvkfncflgqlny only after the owner's explicit approval, production
-- needs its own.
begin;

do $$ begin
  if to_regprocedure('app_private.motorist_member_handoff_view(uuid,uuid)') is null then
    raise exception 'Run 20261022100000_mobile_delivery_handoffs.sql first' using errcode = '55000';
  end if;
end $$;

-- 1. One app with modules: someone who dispatches may also deliver and sees both
-- modules, so a dispatch profile no longer rules a pristavovač out.
create or replace function app_private.motorist_delivery_member_ready(m public.motorist_towing_memberships) returns boolean language sql stable security definer set search_path='' as $$
 select m.active and 'deliver'=any(m.capabilities) and m.auth_user_id is not null
  and exists(select 1 from public.motorist_organizations o where o.id=m.organization_id and o.active)
  and (m.office_profile_id is null or exists(select 1 from public.motorist_profiles p where p.id=m.office_profile_id and p.user_id=m.auth_user_id
   and p.organization_id=m.organization_id and p.active and p.access_status<>'disabled'))
$$;
revoke all on function app_private.motorist_delivery_member_ready(public.motorist_towing_memberships) from public,anon,authenticated,service_role;

-- 2. The phone of someone with both roles carries both owners.
alter table public.motorist_mobile_push_devices drop constraint motorist_mobile_push_devices_owner_check;
alter table public.motorist_mobile_push_devices add constraint motorist_mobile_push_devices_owner_check check (num_nonnulls(profile_id, member_id) >= 1);

-- 3. Position in the background: a secret for one delivery and one pristavovač
-- lets the phone send positions without the sign-in session. Only its hash is
-- kept; it ends with the delivery (also when the dispatcher extends it, it lasts),
-- a new secret or the pristavovač's logout, and in any case after 8 days.
create table public.motorist_handoff_trackers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
  handoff_id uuid not null references public.motorist_case_handoffs(id) on delete cascade,
  member_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (organization_id, member_id) references public.motorist_towing_memberships(organization_id, id) on delete cascade
);
create index motorist_handoff_trackers_live_idx on public.motorist_handoff_trackers (handoff_id, member_id) where revoked_at is null;
alter table public.motorist_handoff_trackers enable row level security;
revoke all on public.motorist_handoff_trackers from public, anon, authenticated, service_role;

-- 4. Positions from the open app and from the background follow the same rules:
-- only the pristavovač who took a step in the app, only while the delivery is
-- open, not before that step, not older than half a day (a phone long without
-- signal sends what it kept), not from the future, one per 10 seconds.
create function app_private.motorist_handoff_record_positions(p_handoff_id uuid,p_member_id uuid,p_positions jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare h public.motorist_case_handoffs; v_since timestamptz; last_at timestamptz; item jsonb; stored integer:=0;
 v_lat double precision; v_lng double precision; v_accuracy real; v_recorded timestamptz;
begin
 if jsonb_typeof(p_positions) is distinct from 'array' or jsonb_array_length(p_positions) not between 1 and 100 then raise exception 'Invalid positions' using errcode='22023'; end if;
 select * into h from public.motorist_case_handoffs where id=p_handoff_id for update;
 if h.id is null or h.recipient_member_id is distinct from p_member_id or h.expires_at<=clock_timestamp() or h.status not in ('accepted','en_route','arrived') then
  return jsonb_build_object('stored',0,'active',false);
 end if;
 select min(e.created_at) into v_since from public.motorist_handoff_events e where e.handoff_id=h.id and e.actor_member_id=p_member_id and e.action in ('accept','en_route','arrived');
 if v_since is null then return jsonb_build_object('stored',0,'active',false); end if;
 select max(recorded_at) into last_at from public.motorist_handoff_positions where handoff_id=h.id;
 for item in select value from jsonb_array_elements(p_positions) order by (value->>'recordedAt')::timestamptz loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invalid position' using errcode='22023'; end if;
  v_lat:=(item->>'lat')::double precision; v_lng:=(item->>'lng')::double precision;
  v_accuracy:=nullif(item->>'accuracy','')::real; v_recorded:=(item->>'recordedAt')::timestamptz;
  if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 or v_recorded is null
   or (v_accuracy is not null and (v_accuracy<0 or v_accuracy>100000)) then raise exception 'Invalid position' using errcode='22023'; end if;
  continue when v_recorded<greatest(clock_timestamp()-interval '12 hours',v_since-interval '1 minute') or v_recorded>clock_timestamp()+interval '2 minutes'
   or (last_at is not null and v_recorded<last_at+interval '10 seconds');
  insert into public.motorist_handoff_positions(organization_id,handoff_id,member_id,lat,lng,accuracy_m,recorded_at)
   values(h.organization_id,h.id,p_member_id,v_lat,v_lng,v_accuracy,v_recorded);
  stored:=stored+1; last_at:=v_recorded;
 end loop;
 return jsonb_build_object('stored',stored,'active',true);
end $$;
revoke all on function app_private.motorist_handoff_record_positions(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- 5. The pristavovač's own work, now with the background secret.
create or replace function public.motorist_member_handoff(p_user_id uuid,p_organization_id uuid,p_membership_version bigint,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.motorist_towing_memberships; h public.motorist_case_handoffs; receipt public.motorist_handoff_receipts;
 cid uuid; action text; v_actor_key text; fingerprint jsonb; comment text; next_status text; v_hash text; result jsonb; v_expires timestamptz;
begin
 m:=app_private.towing_authorize(p_user_id,p_organization_id,p_membership_version);
 if not 'deliver'=any(m.capabilities) then raise exception 'Delivery access denied' using errcode='42501'; end if;
 if jsonb_typeof(p_input)<>'object' then raise exception 'Invalid input' using errcode='22023'; end if;
 if p_action='list' then
  return jsonb_build_object('handoffs',coalesce((select jsonb_agg(app_private.motorist_member_handoff_view(t.id,m.id) order by t.live desc,t.created_at desc)
   from (select x.id,x.created_at,x.status in ('offered','accepted','en_route','arrived') and x.expires_at>clock_timestamp() as live
    from public.motorist_case_handoffs x where x.organization_id=m.organization_id and x.recipient_member_id=m.id
     and (case when x.status in ('offered','accepted','en_route','arrived','expired') then x.expires_at else x.updated_at end)>clock_timestamp()-interval '24 hours'
    order by live desc,x.created_at desc limit 100) t),'[]'::jsonb));
 end if;
 select * into h from public.motorist_case_handoffs where id=(p_input->>'handoffId')::uuid and organization_id=m.organization_id and recipient_member_id=m.id for update;
 if h.id is null or not exists(select 1 from public.motorist_cases where id=h.case_id and organization_id=h.organization_id)
  or (case when h.status in ('offered','accepted','en_route','arrived','expired') then h.expires_at else h.updated_at end)<=clock_timestamp()-interval '24 hours' then
  raise exception 'Grant unavailable' using errcode='P0002';
 end if;
 if p_action='read' then
  -- Opening the delivery tells the dispatcher it was seen, as opening the link does.
  if h.opened_at is null and h.status='offered' and h.expires_at>clock_timestamp() then update public.motorist_case_handoffs set opened_at=clock_timestamp() where id=h.id; end if;
  return jsonb_build_object('handoff',app_private.motorist_member_handoff_view(h.id,m.id));
 end if;
 -- The phone stops sending in the background (delivery finished, logout).
 if p_action='untrack' then
  update public.motorist_handoff_trackers set revoked_at=clock_timestamp() where handoff_id=h.id and member_id=m.id and revoked_at is null;
  return jsonb_build_object('revoked',true);
 end if;
 if h.expires_at<=clock_timestamp() or h.status in ('cancelled','expired') then raise exception 'Grant unavailable' using errcode='P0002'; end if;
 if p_action='position' then
  -- One reading from the open app, by the same rules as the background.
  result:=app_private.motorist_handoff_record_positions(h.id,m.id,jsonb_build_array(p_input-'handoffId'));
  return jsonb_build_object('stored',(result->>'stored')::integer>0,'active',(result->>'active')::boolean);
 end if;
 -- A secret for this delivery, so the phone can send positions in the background
 -- without the sign-in session; a new one replaces the previous.
 if p_action='tracker' then
  v_hash:=p_input->>'tokenHash';
  if v_hash is null or v_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid tracker' using errcode='22023'; end if;
  if h.status not in ('accepted','en_route','arrived') or not exists(select 1 from public.motorist_handoff_events e
   where e.handoff_id=h.id and e.actor_member_id=m.id and e.action in ('accept','en_route','arrived')) then raise exception 'Not tracking' using errcode='PT409'; end if;
  update public.motorist_handoff_trackers set revoked_at=clock_timestamp() where handoff_id=h.id and member_id=m.id and revoked_at is null;
  insert into public.motorist_handoff_trackers(organization_id,handoff_id,member_id,token_hash,expires_at)
   values(h.organization_id,h.id,m.id,v_hash,clock_timestamp()+interval '8 days') returning expires_at into v_expires;
  return jsonb_build_object('expiresAt',v_expires);
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

-- 6. What the phone sends in the background, identified only by the secret's hash.
-- An unknown, ended or revoked secret, or a pristavovač who lost access, gets
-- `active` false, so the phone stops. The delivery row is locked before the
-- secret, in the same order as issuing and revoking.
create function public.motorist_handoff_track(p_token_hash text,p_positions jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.motorist_handoff_trackers; m public.motorist_towing_memberships; result jsonb;
begin
 if p_token_hash is null or p_token_hash!~'^[a-f0-9]{64}$' then return jsonb_build_object('stored',0,'active',false); end if;
 select * into t from public.motorist_handoff_trackers where token_hash=p_token_hash;
 if not found then return jsonb_build_object('stored',0,'active',false); end if;
 perform 1 from public.motorist_case_handoffs where id=t.handoff_id for update;
 select * into t from public.motorist_handoff_trackers where id=t.id for update;
 if t.revoked_at is not null or t.expires_at<=clock_timestamp() then return jsonb_build_object('stored',0,'active',false); end if;
 select * into m from public.motorist_towing_memberships where id=t.member_id and organization_id=t.organization_id;
 if not found or not app_private.motorist_delivery_member_ready(m) then
  update public.motorist_handoff_trackers set revoked_at=clock_timestamp() where id=t.id;
  return jsonb_build_object('stored',0,'active',false);
 end if;
 result:=app_private.motorist_handoff_record_positions(t.handoff_id,t.member_id,p_positions);
 if not (result->>'active')::boolean then update public.motorist_handoff_trackers set revoked_at=clock_timestamp() where id=t.id; end if;
 return result;
end $$;
revoke all on function public.motorist_handoff_track(text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_handoff_track(text,jsonb) to service_role;

-- 7. Positions and spent secrets are kept 30 days.
create or replace function public.motorist_handoff_positions_prune() returns integer language plpgsql security definer set search_path='' as $$
declare deleted integer; begin
 delete from public.motorist_handoff_positions where received_at<clock_timestamp()-interval '30 days';
 get diagnostics deleted = row_count;
 delete from public.motorist_handoff_trackers where coalesce(revoked_at,expires_at)<clock_timestamp()-interval '30 days';
 return deleted;
end $$;
revoke all on function public.motorist_handoff_positions_prune() from public,anon,authenticated;
grant execute on function public.motorist_handoff_positions_prune() to service_role;

notify pgrst, 'reload schema';
commit;
