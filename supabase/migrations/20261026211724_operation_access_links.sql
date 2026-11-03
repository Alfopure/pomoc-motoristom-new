begin;
-- New web publications stay out of the strict legacy/mobile handoff contract.
create table public.motorist_operation_grants (
 id uuid primary key, organization_id uuid not null references public.motorist_organizations(id),
 operation_id uuid not null references public.motorist_operations(id),
 member_id uuid not null references public.motorist_towing_memberships(id), membership_version bigint not null, assignment_generation bigint not null,
 recipient_name text not null, snapshot jsonb not null, snapshot_hash text not null,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'), token_envelope jsonb not null, link_origin text not null,
 status text not null default 'active' check(status in ('active','revoked')), revision bigint not null default 1,
 created_by uuid not null, created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz,
 check(expires_at>created_at), unique(organization_id,id)
);
create unique index motorist_operation_grant_active on public.motorist_operation_grants(operation_id) where status='active';
create index motorist_operation_grant_member on public.motorist_operation_grants(member_id);
create table public.motorist_operation_grant_sessions (
 session_hash text primary key check(session_hash ~ '^[a-f0-9]{64}$'), grant_id uuid not null references public.motorist_operation_grants(id),
 expires_at timestamptz not null, created_at timestamptz not null default now()
);
create index motorist_operation_grant_sessions_grant on public.motorist_operation_grant_sessions(grant_id);
create table public.motorist_operation_grant_receipts (
 organization_id uuid not null, actor_key text not null, command_id uuid not null, grant_id uuid not null references public.motorist_operation_grants(id),
 payload jsonb not null, receipt jsonb not null, created_at timestamptz not null default now(), primary key(organization_id,actor_key,command_id)
);
-- Audit explicitly records a bearer grant rather than impersonating its issuer/member.
alter table public.motorist_operation_events alter column actor_user_id drop not null;
alter table public.motorist_operation_events add column actor_grant_id uuid references public.motorist_operation_grants(id);
alter table public.motorist_operation_events add constraint motorist_operation_event_actor check((actor_user_id is null) <> (actor_grant_id is null));
create index motorist_operation_events_grant on public.motorist_operation_events(actor_grant_id) where actor_grant_id is not null;

create function app_private.operation_grant_snapshot(op public.motorist_operations) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('kind',op.kind,'caseNumber',c.case_number,'vehicle',a.label,'from',e.pickup,'to',e.destination,
 'scheduledAt',e.scheduled_at,'recipientName',m.display_name,'customer',case when n.id is null then null else jsonb_build_object('name',n.name,'phone',n.phone) end)
 from public.motorist_logistics_executions e
 join public.motorist_towing_memberships m on m.id=e.assignee_id and m.organization_id=op.organization_id
 left join public.motorist_cases c on c.id=op.case_id and c.organization_id=op.organization_id
 left join public.motorist_contacts n on n.id=c.contact_id and n.organization_id=op.organization_id
 left join public.motorist_fleet_assets a on a.id=e.fleet_asset_id and a.organization_id=op.organization_id
 where e.operation_id=op.id and op.towing_order_id is null and op.kind in ('delivery','collection','transfer')
$$;
create function app_private.operation_grant_valid(g public.motorist_operation_grants) returns boolean language sql volatile set search_path='' as $$
 select g.status='active' and g.expires_at>clock_timestamp() and exists(
  select 1 from public.motorist_operations o join public.motorist_organizations org on org.id=o.organization_id and org.active
  join public.motorist_logistics_executions e on e.operation_id=o.id and e.organization_id=o.organization_id
  join public.motorist_towing_memberships m on m.id=e.assignee_id and m.organization_id=o.organization_id
  where o.id=g.operation_id and o.organization_id=g.organization_id and o.towing_order_id is null
   and e.assignee_id=g.member_id and e.assignment_generation=g.assignment_generation and m.membership_version=g.membership_version and m.active and 'deliver'=any(m.capabilities)
   and m.password_set_at is not null and app_private.motorist_delivery_member_ready(m)
   and exists(select 1 from auth.users u where u.id=m.auth_user_id and (nullif(to_jsonb(u)->>'banned_until','') is null or (to_jsonb(u)->>'banned_until')::timestamptz<=clock_timestamp()))
   and g.snapshot_hash=encode(sha256(convert_to(app_private.operation_grant_snapshot(o)::text,'UTF8')),'hex')
 )
$$;
create function app_private.operation_grant_dto(g public.motorist_operation_grants) returns jsonb language sql volatile set search_path='' as $$
 select jsonb_build_object('id',g.id,'operationId',g.operation_id,'recipientName',g.recipient_name,'expiresAt',g.expires_at,'createdAt',g.created_at,
 'status',case when g.status='revoked' then 'revoked' when g.expires_at<=clock_timestamp() then 'expired'
 when exists(select 1 from public.motorist_logistics_executions e where e.operation_id=g.operation_id and (e.assignee_id is distinct from g.member_id or e.assignment_generation<>g.assignment_generation)) then 'assignment_changed'
 when not app_private.operation_grant_valid(g) then 'outdated' else 'active' end)
$$;
create function app_private.operation_grant_public_dto(g public.motorist_operation_grants) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('grantId',g.id,'operationId',g.operation_id,'status',e.status,'revision',e.revision,'expiresAt',g.expires_at,
 'snapshot',case when e.status in ('completed','cancelled') then null else g.snapshot end)
 from public.motorist_logistics_executions e where e.operation_id=g.operation_id
$$;

-- Both publication writers serialize on the same lock. A legacy card and a new
-- web card can coexist on a case, never on the same durable operation.
create function app_private.operation_grant_legacy_guard() returns trigger language plpgsql set search_path='' as $$begin
 if new.operation_id is not null and new.status in ('offered','accepted','en_route','arrived') and new.expires_at>clock_timestamp() then
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text,13102026));
  if exists(select 1 from public.motorist_operation_grants g where g.operation_id=new.operation_id and app_private.operation_grant_valid(g)) then
   raise exception 'Operation already published' using errcode='PT409';
  end if;
 end if; return new;
end $$;
create trigger motorist_operation_grant_legacy_guard before insert or update of status,operation_id,expires_at on public.motorist_case_handoffs for each row execute function app_private.operation_grant_legacy_guard();

create function public.motorist_operation_grant(p_user_id uuid,p_organization_id uuid,p_operation_id uuid,p_action text,p_input jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor jsonb; op public.motorist_operations; ex public.motorist_logistics_executions; g public.motorist_operation_grants;
 snapshot jsonb; snapshot_hash text; cid uuid; v_actor_key text; fingerprint jsonb; old public.motorist_operation_grant_receipts; result jsonb; hours integer;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 if not coalesce((actor->>'canDispatch')::boolean,false) then raise exception 'Office publication permission required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,13102026));
 select * into op from public.motorist_operations where id=p_operation_id and organization_id=p_organization_id for update;
 if not found or op.towing_order_id is not null then raise exception 'Logistics operation unavailable' using errcode='P0002'; end if;
 select * into ex from public.motorist_logistics_executions where operation_id=op.id for update;
 snapshot:=app_private.operation_grant_snapshot(op); snapshot_hash:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 if p_action='context' then return jsonb_build_object('preview',snapshot,'previewVersion',snapshot_hash,'operationRevision',ex.revision,
  'grants',coalesce((select jsonb_agg(app_private.operation_grant_dto(t) order by t.created_at desc) from (select * from public.motorist_operation_grants where operation_id=op.id order by created_at desc limit 50) t),'[]'::jsonb)); end if;
 if p_action not in ('issue','revoke','recover') or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Invalid command' using errcode='22023'; end if;
 cid:=(p_input->>'commandId')::uuid; if cid is null then raise exception 'Command required' using errcode='22023'; end if;
 v_actor_key:='user:'||p_user_id::text;
 fingerprint:=jsonb_build_object('operationId',op.id,'action',p_action,'input',p_input-'tokenHash'-'tokenEnvelope'-'issuedId'-'linkOrigin');
 select * into old from public.motorist_operation_grant_receipts r where r.organization_id=p_organization_id and r.actor_key=v_actor_key and r.command_id=cid;
 if found then
  if old.payload<>fingerprint then raise exception 'Command conflict' using errcode='PT409'; end if;
  return old.receipt;
 end if;
 if p_action='issue' then
  if ex.revision is distinct from (p_input->>'expectedRevision')::bigint or p_input->>'previewVersion' is distinct from snapshot_hash then raise exception 'Preview changed' using errcode='PT409'; end if;
  if ex.status not in ('assigned','accepted','en_route','arrived','collected') or snapshot is null or not exists(
   select 1 from public.motorist_towing_memberships m where m.id=ex.assignee_id and m.organization_id=p_organization_id and m.active and 'deliver'=any(m.capabilities) and m.password_set_at is not null and app_private.motorist_delivery_member_ready(m)
   and exists(select 1 from auth.users u where u.id=m.auth_user_id and (nullif(to_jsonb(u)->>'banned_until','') is null or (to_jsonb(u)->>'banned_until')::timestamptz<=clock_timestamp()))
  ) then raise exception 'Ready assigned member required' using errcode='22023'; end if;
  -- Membership revocation cannot commit between authorization and publication.
  perform 1 from auth.users u join public.motorist_towing_memberships m on m.auth_user_id=u.id where m.id=ex.assignee_id for share of u;
  perform 1 from public.motorist_towing_memberships m where m.id=ex.assignee_id for share;
  if not exists(select 1 from public.motorist_towing_memberships m where m.id=ex.assignee_id and m.active and 'deliver'=any(m.capabilities) and m.password_set_at is not null and app_private.motorist_delivery_member_ready(m)
   and exists(select 1 from auth.users u where u.id=m.auth_user_id and (nullif(to_jsonb(u)->>'banned_until','') is null or (to_jsonb(u)->>'banned_until')::timestamptz<=clock_timestamp()))) then raise exception 'Assignment revoked' using errcode='42501'; end if;
  if exists(select 1 from public.motorist_case_handoffs h where h.organization_id=p_organization_id and h.operation_id=op.id and h.status in ('offered','accepted','en_route','arrived') and h.expires_at>clock_timestamp()) then raise exception 'Legacy publication active' using errcode='PT409'; end if;
  update public.motorist_operation_grants prior set status='revoked',revoked_at=clock_timestamp(),revision=revision+1
   where prior.operation_id=op.id and prior.status='active' and not app_private.operation_grant_valid(prior);
  if exists(select 1 from public.motorist_operation_grants where operation_id=op.id and status='active') then raise exception 'Operation already published' using errcode='PT409'; end if;
  hours:=(p_input->>'hours')::integer;
  if hours is null or hours not between 1 and 72 or p_input->>'tokenHash' is null or p_input->>'tokenHash' !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(p_input->'tokenEnvelope') is distinct from 'object' or nullif(p_input->>'linkOrigin','') is null then raise exception 'Invalid publication' using errcode='22023'; end if;
  insert into public.motorist_operation_grants(id,organization_id,operation_id,member_id,membership_version,assignment_generation,recipient_name,snapshot,snapshot_hash,token_hash,token_envelope,link_origin,created_by,expires_at)
   values((p_input->>'issuedId')::uuid,p_organization_id,op.id,ex.assignee_id,(select m.membership_version from public.motorist_towing_memberships m where m.id=ex.assignee_id),ex.assignment_generation,snapshot->>'recipientName',snapshot,snapshot_hash,p_input->>'tokenHash',p_input->'tokenEnvelope',p_input->>'linkOrigin',p_user_id,clock_timestamp()+make_interval(hours=>hours)) returning * into g;
 else
  select * into g from public.motorist_operation_grants where id=(p_input->>'grantId')::uuid and organization_id=p_organization_id and operation_id=op.id for update;
  if not found then raise exception 'Publication unavailable' using errcode='P0002'; end if;
  if p_action='revoke' then
   if nullif(btrim(p_input->>'reason'),'') is null or length(p_input->>'reason')>1000 then raise exception 'Reason required' using errcode='22023'; end if;
   update public.motorist_operation_grants set status='revoked',revoked_at=clock_timestamp(),revision=revision+1 where id=g.id returning * into g;
   delete from public.motorist_operation_grant_sessions where grant_id=g.id;
  elsif not app_private.operation_grant_valid(g) or ex.status in ('completed','cancelled') then raise exception 'Publication unavailable' using errcode='P0002'; end if;
 end if;
 result:=jsonb_build_object('commandId',cid,'committedRevision',g.revision,'grant',app_private.operation_grant_dto(g));
 insert into public.motorist_operation_grant_receipts(organization_id,actor_key,command_id,grant_id,payload,receipt) values(p_organization_id,v_actor_key,cid,g.id,fingerprint,result);
 insert into public.motorist_operation_events(operation_id,actor_user_id,command_id,action,revision,payload) values(op.id,p_user_id,cid,'grant_'||p_action,ex.revision,jsonb_build_object('grantId',g.id,'recipientMemberId',g.member_id,'reason',p_input->>'reason'));
 return result;
end $$;

-- Material is server-only and reauthorizes on every recovery, including retries.
create function public.motorist_operation_grant_secret(p_user_id uuid,p_organization_id uuid,p_operation_id uuid,p_grant_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; g public.motorist_operation_grants;
begin
 actor:=app_private.operations_actor(p_user_id,p_organization_id);
 if not coalesce((actor->>'canDispatch')::boolean,false) then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into g from public.motorist_operation_grants where id=p_grant_id and operation_id=p_operation_id and organization_id=p_organization_id;
 if not found or not app_private.operation_grant_valid(g) or exists(select 1 from public.motorist_logistics_executions e where e.operation_id=g.operation_id and e.status in ('completed','cancelled')) then raise exception 'Publication unavailable' using errcode='P0002'; end if;
 return jsonb_build_object('tokenHash',g.token_hash,'tokenEnvelope',g.token_envelope,'origin',g.link_origin);
end $$;

create function public.motorist_public_operation_grant(p_action text,p_token_hash text,p_input jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.motorist_operation_grants; op public.motorist_operations; ex public.motorist_logistics_executions;
 old public.motorist_operation_grant_receipts; cid uuid; v_actor_key text; result jsonb; next_status text; at_time timestamptz; end_time timestamptz; resource text;
begin
 if p_action not in ('session','read','command') or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Unavailable' using errcode='P0002'; end if;
 if p_action='session' then select * into g from public.motorist_operation_grants where token_hash=p_token_hash;
 else select candidate.* into g from public.motorist_operation_grants candidate join public.motorist_operation_grant_sessions s on s.grant_id=candidate.id where s.session_hash=p_token_hash and s.expires_at>clock_timestamp(); end if;
 if not found then raise exception 'Unavailable' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended(g.organization_id::text,13102026));
 select * into g from public.motorist_operation_grants where id=g.id for update;
 select * into op from public.motorist_operations where id=g.operation_id and organization_id=g.organization_id for update;
 select * into ex from public.motorist_logistics_executions where operation_id=op.id for update;
 perform 1 from auth.users u join public.motorist_towing_memberships m on m.auth_user_id=u.id where m.id=ex.assignee_id for share of u;
 perform 1 from public.motorist_towing_memberships m where m.id=ex.assignee_id for share;
 if not app_private.operation_grant_valid(g) then raise exception 'Unavailable' using errcode='P0002'; end if;
 if p_action='session' then
  if p_input->>'sessionHash' is null or p_input->>'sessionHash' !~ '^[a-f0-9]{64}$' then raise exception 'Invalid session' using errcode='22023'; end if;
  delete from public.motorist_operation_grant_sessions where grant_id=g.id and expires_at<=clock_timestamp();
  if (select count(*) from public.motorist_operation_grant_sessions where grant_id=g.id)>=30 then raise exception 'Session limit' using errcode='54000'; end if;
  insert into public.motorist_operation_grant_sessions(session_hash,grant_id,expires_at) values(p_input->>'sessionHash',g.id,least(g.expires_at,clock_timestamp()+interval '12 hours'));
  return jsonb_build_object('publication',app_private.operation_grant_public_dto(g),'sessionExpiresAt',least(g.expires_at,clock_timestamp()+interval '12 hours'));
 end if;
 if g.id is distinct from (p_input->>'grantId')::uuid then raise exception 'Unavailable' using errcode='P0002'; end if;
 if p_action='read' then return jsonb_build_object('publication',app_private.operation_grant_public_dto(g)); end if;
 cid:=(p_input->>'commandId')::uuid; v_actor_key:='grant:'||g.id::text;
 if cid is null or p_input->>'action' not in ('accept','start','arrive','collect','complete') then raise exception 'Invalid command' using errcode='22023'; end if;
 select * into old from public.motorist_operation_grant_receipts r where r.organization_id=g.organization_id and r.actor_key=v_actor_key and r.command_id=cid;
 if found then
  if old.payload<>p_input then raise exception 'Command conflict' using errcode='PT409'; end if;
  -- The committed receipt is stable; current presentation still redacts a
  -- completed operation instead of reviving its former contact snapshot.
  return old.receipt || jsonb_build_object('publication',app_private.operation_grant_public_dto(g));
 end if;
 if ex.revision is distinct from (p_input->>'expectedRevision')::bigint then raise exception 'Revision conflict' using errcode='PT409'; end if;
 if p_input->>'action'='accept' and ex.status='assigned' then next_status:='accepted';
 elsif p_input->>'action'='start' and ex.status in ('assigned','accepted') then
  -- Same resource locks and physical capacity gate as the authenticated owner.
  for resource in select value from unnest(array['driver:'||ex.assignee_id::text,'asset:'||coalesce(ex.fleet_asset_id::text,'none')]) value order by value loop
   perform pg_advisory_xact_lock(hashtextextended(g.organization_id::text||resource,0));
  end loop;
  at_time:=clock_timestamp(); end_time:=ex.planned_end_at;
  if end_time is not null and end_time<=at_time then raise exception 'Interval elapsed' using errcode='22023'; end if;
  if exists(select 1 from public.motorist_logistics_executions other where other.organization_id=g.organization_id and other.operation_id<>op.id and other.status not in ('completed','cancelled') and (other.confirmed_at is not null or other.started_at is not null)
   and (other.assignee_id=ex.assignee_id or (ex.fleet_asset_id is not null and other.fleet_asset_id=ex.fleet_asset_id))
   and tstzrange(coalesce(other.started_at,other.scheduled_at),case when other.started_at is not null and other.planned_end_at<=now() then null else other.planned_end_at end,'[)') && tstzrange(at_time,end_time,'[)')) then raise exception 'Capacity conflict' using errcode='PT409'; end if;
  if exists(select 1 from public.motorist_towing_orders t where t.organization_id=g.organization_id and t.driver_id=ex.assignee_id and t.work_status='in_progress') then raise exception 'Driver physically busy' using errcode='PT409'; end if;
  if op.kind='delivery' and ex.fleet_asset_id is not null and not app_private.operations_asset_free(g.organization_id,ex.fleet_asset_id) then raise exception 'Fresh free source required' using errcode='PT409'; end if;
  next_status:='en_route';
 elsif p_input->>'action'='arrive' and ex.status='en_route' then next_status:='arrived';
 elsif p_input->>'action'='collect' and op.kind='collection' and ex.status='arrived' then next_status:='collected';
 elsif p_input->>'action'='complete' and ((op.kind='collection' and ex.status='collected') or (op.kind<>'collection' and ex.status='arrived')) then next_status:='completed';
 else raise exception 'State conflict' using errcode='PT409'; end if;
 update public.motorist_logistics_executions set status=next_status,revision=revision+1,updated_at=clock_timestamp(),
  confirmed_at=case when next_status='en_route' then coalesce(confirmed_at,clock_timestamp()) else confirmed_at end,
  started_at=case when next_status='en_route' then coalesce(started_at,clock_timestamp()) else started_at end,
  finished_at=case when next_status='completed' then clock_timestamp() else finished_at end where operation_id=op.id returning * into ex;
 if next_status='completed' and op.kind='collection' then update public.motorist_vehicle_use_cycles set status='returned',revision=revision+1 where id=op.cycle_id and organization_id=g.organization_id and status='open'; end if;
 insert into public.motorist_operation_events(operation_id,actor_grant_id,command_id,action,revision,payload) values(op.id,g.id,cid,p_input->>'action',ex.revision,jsonb_build_object('recipientMemberId',g.member_id));
 result:=jsonb_build_object('commandId',cid,'committedRevision',ex.revision,'publication',app_private.operation_grant_public_dto(g));
 insert into public.motorist_operation_grant_receipts(organization_id,actor_key,command_id,grant_id,payload,receipt) values(g.organization_id,v_actor_key,cid,g.id,p_input,result);
 return result;
end $$;

do $security$ declare item text; begin
 foreach item in array array['motorist_operation_grants','motorist_operation_grant_sessions','motorist_operation_grant_receipts'] loop
  execute format('alter table public.%I enable row level security',item);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',item);
 end loop;
end $security$;
revoke all on function app_private.operation_grant_snapshot(public.motorist_operations),app_private.operation_grant_valid(public.motorist_operation_grants),app_private.operation_grant_dto(public.motorist_operation_grants),app_private.operation_grant_public_dto(public.motorist_operation_grants),app_private.operation_grant_legacy_guard() from public,anon,authenticated,service_role;
revoke all on function public.motorist_operation_grant(uuid,uuid,uuid,text,jsonb),public.motorist_operation_grant_secret(uuid,uuid,uuid,uuid),public.motorist_public_operation_grant(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_operation_grant(uuid,uuid,uuid,text,jsonb),public.motorist_operation_grant_secret(uuid,uuid,uuid,uuid),public.motorist_public_operation_grant(text,text,jsonb) to service_role;
commit;
