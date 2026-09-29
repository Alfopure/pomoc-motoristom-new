-- Optional diagnostics store. Disabled until an operator sets an evidenced physical budget.
create table public.motorist_diagnostic_guard (
 id boolean primary key default true check(id), budget_bytes bigint not null default 0 check(budget_bytes between 0 and 134217728),
 physical_bytes bigint not null default 0, checked_at timestamptz, blocked boolean not null default true
);
insert into public.motorist_diagnostic_guard(id) values(true);
create table public.motorist_diagnostic_counters (
 organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
 environment text not null check(environment in ('production','test','development')),
 key text not null check(length(key)<=64), minute timestamptz not null default date_trunc('minute',now()), batches integer not null default 0,
 day date not null default current_date, daily_events integer not null default 0, daily_normal integer not null default 0,
 event_count integer not null default 0, incident_count integer not null default 0, counter_count integer not null default 1,
 dropped bigint not null default 0, cleanup_backlog boolean not null default false,
 cursor_at timestamptz, cursor_id uuid, updated_at timestamptz not null default now(),
 primary key(organization_id,environment,key)
);
create table public.motorist_diagnostic_events (
 id uuid not null, organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
 environment text not null check(environment in ('production','test','development')),
 profile_id uuid references public.motorist_profiles(id) on delete set null,
 source text not null check(source in ('browser','server','cron')), received_at timestamptz not null default now(),
 server_build text not null check(server_build ~ '^[a-zA-Z0-9_-]{1,64}$'),
 call_session_id uuid, case_id uuid, device_session_id uuid,
 event jsonb not null check(jsonb_typeof(event)='object' and octet_length(event::text)<=1400),
 primary key(organization_id,environment,id)
);
create index motorist_diagnostic_events_time on public.motorist_diagnostic_events(organization_id,environment,received_at desc,id desc);
create index motorist_diagnostic_events_call on public.motorist_diagnostic_events(organization_id,environment,call_session_id,received_at desc,id desc) where call_session_id is not null;
create index motorist_diagnostic_events_device on public.motorist_diagnostic_events(organization_id,environment,profile_id,device_session_id) where device_session_id is not null;
create index motorist_diagnostic_events_retention on public.motorist_diagnostic_events(received_at);
create table public.motorist_diagnostic_incidents (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id) on delete cascade,
 environment text not null check(environment in ('production','test','development')), dedupe_key text not null check(length(dedupe_key)<=220),
 first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 module text not null, operation text, kind text not null check(kind in ('ui_error','user_report','operation','call_interruption')),
 status text not null default 'new' check(status in ('new','acknowledged','resolved')),
 count integer not null default 1, build_id text, profile_id uuid, call_session_id uuid, case_id uuid, leg_id uuid,
 classified_at timestamptz, classification text not null default 'observation' check(classification in ('observation','candidate','interruption_observed','expected_end','unknown')),
 evidence_ids uuid[] not null default '{}' check(cardinality(evidence_ids)<=20),
 unique(organization_id,environment,dedupe_key)
);
create index motorist_diagnostic_incidents_time on public.motorist_diagnostic_incidents(organization_id,environment,last_seen_at desc,id desc);
create index motorist_diagnostic_incidents_retention on public.motorist_diagnostic_incidents(last_seen_at);
-- No browser has direct table privileges; manager access is checked by server before service RPC.
alter table public.motorist_diagnostic_guard enable row level security;
alter table public.motorist_diagnostic_counters enable row level security;
alter table public.motorist_diagnostic_events enable row level security;
alter table public.motorist_diagnostic_incidents enable row level security;
revoke all on public.motorist_diagnostic_guard,public.motorist_diagnostic_counters,public.motorist_diagnostic_events,public.motorist_diagnostic_incidents from public,anon,authenticated;
grant select on public.motorist_diagnostic_guard,public.motorist_diagnostic_counters,public.motorist_diagnostic_events,public.motorist_diagnostic_incidents to service_role;

create function public.motorist_diagnostics_ingest(p_org uuid,p_profile uuid,p_environment text,p_source text,p_build text,p_events jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp set statement_timeout='1000ms' set lock_timeout='100ms' as $$
declare c motorist_diagnostic_counters%rowtype; q motorist_diagnostic_counters%rowtype; g motorist_diagnostic_guard%rowtype;
 e jsonb; eid uuid; cid uuid; caid uuid; did uuid; accepted jsonb:='[]'; rejected jsonb:='[]'; critical boolean; stored boolean; ikey text; ikind text; existing uuid; role_name text;
 t timestamptz:=clock_timestamp();
begin
 if p_environment not in ('production','test','development') or p_source not in ('browser','server','cron') or p_build !~ '^[a-zA-Z0-9_-]{1,64}$' then raise exception 'invalid diagnostics envelope'; end if;
 if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>16 or octet_length(p_events::text)>18000 then raise exception 'invalid diagnostics batch'; end if;
 select role into role_name from motorist_profiles where id=p_profile and organization_id=p_org and active;
 if role_name is null then raise exception 'invalid diagnostics actor'; end if;
 select * into g from motorist_diagnostic_guard where id;
 if g.blocked or g.budget_bytes=0 or g.checked_at is null or g.checked_at<t-interval '10 minutes' then return jsonb_build_object('unavailable',true,'acceptedIds','[]'::jsonb); end if;
 insert into motorist_diagnostic_counters(organization_id,environment,key) values(p_org,p_environment,'org') on conflict do nothing;
 select * into c from motorist_diagnostic_counters where organization_id=p_org and environment=p_environment and key='org' for update;
 if c.minute<>date_trunc('minute',t) then c.minute:=date_trunc('minute',t);c.batches:=0;end if;
 if c.day<>t::date then c.day:=t::date;c.daily_events:=0;c.daily_normal:=0;end if;
 if c.batches>=300 then update motorist_diagnostic_counters set dropped=dropped+jsonb_array_length(p_events) where organization_id=p_org and environment=p_environment and key='org'; return jsonb_build_object('rateLimited',true,'acceptedIds','[]'::jsonb);end if;
 select * into q from motorist_diagnostic_counters where organization_id=p_org and environment=p_environment and key=p_profile::text;
 if not found then
  if c.counter_count>=4096 or c.event_count*4096::bigint+c.incident_count*8192::bigint+(c.counter_count+1)*1024::bigint>134217728 then
   update motorist_diagnostic_counters set dropped=dropped+jsonb_array_length(p_events) where organization_id=p_org and environment=p_environment and key='org';
   return jsonb_build_object('degraded',true,'acceptedIds','[]'::jsonb,'rejectedIds',(select jsonb_agg(v->>'id') from jsonb_array_elements(p_events)v));
  end if;
  insert into motorist_diagnostic_counters(organization_id,environment,key) values(p_org,p_environment,p_profile::text) returning * into q;
  c.counter_count:=c.counter_count+1;
 end if;
 if q.minute<>date_trunc('minute',t) then q.minute:=date_trunc('minute',t);q.batches:=0;end if;
 if q.batches>=20 then update motorist_diagnostic_counters set dropped=dropped+jsonb_array_length(p_events) where organization_id=p_org and environment=p_environment and key='org'; return jsonb_build_object('rateLimited',true,'acceptedIds','[]'::jsonb); end if;
 c.batches:=c.batches+1;q.batches:=q.batches+1;
 for e in select value from jsonb_array_elements(p_events) loop
  if octet_length(e::text)>1400 or jsonb_typeof(e)<>'object' then raise exception 'invalid diagnostics event'; end if;
  eid:=(e->>'id')::uuid;
  -- Only acknowledge a duplicate belonging to this exact actor/source.
  if exists(select 1 from motorist_diagnostic_events where organization_id=p_org and environment=p_environment and id=eid and profile_id=p_profile and source=p_source) then accepted:=accepted||to_jsonb(eid::text);continue;end if;
  if exists(select 1 from motorist_diagnostic_events where organization_id=p_org and environment=p_environment and id=eid) then rejected:=rejected||to_jsonb(eid::text);continue;end if;
  cid:=nullif(e->>'callSessionId','')::uuid; caid:=nullif(e->>'caseId','')::uuid; did:=nullif(e->>'deviceSessionId','')::uuid;
  if caid is not null and not exists(select 1 from motorist_cases where id=caid and organization_id=p_org) then rejected:=rejected||to_jsonb(eid::text);continue;end if;
  if cid is not null and not exists(select 1 from motorist_call_sessions s where s.id=cid and s.organization_id=p_org and (role_name in ('manager','admin') or s.answered_by_profile_id=p_profile or exists(select 1 from motorist_call_legs l where l.organization_id=p_org and l.session_id=cid and l.profile_id=p_profile))) then rejected:=rejected||to_jsonb(eid::text);continue;end if;
  if did is not null and p_source='browser' and not exists(select 1 from motorist_operator_devices d where d.organization_id=p_org and d.profile_id=p_profile and d.device_session_id=did and d.environment=case when p_environment='production' then 'production' else 'development' end) and not exists(select 1 from motorist_diagnostic_events d where d.organization_id=p_org and d.environment=p_environment and d.profile_id=p_profile and d.device_session_id=did) then
   -- Unknown historical ownership is missing evidence, never an unverified link.
   e:=e-'deviceSessionId';did:=null;
  end if;
  critical:=e->>'type' in ('ui_error','unhandled_rejection','chunk_error','user_report') or e->>'outcome' in ('failed','timeout','unknown','committed_refresh_failed');
  stored:=c.daily_events<20000 and (critical or c.daily_normal<15000) and c.event_count<28672 and c.event_count*4096::bigint+c.incident_count*8192::bigint+c.counter_count*1024::bigint+4096<=134217728;
  if stored then
   insert into motorist_diagnostic_events(id,organization_id,environment,profile_id,source,server_build,call_session_id,case_id,device_session_id,event) values(eid,p_org,p_environment,p_profile,p_source,p_build,cid,caid,did,e);
   if e->>'type'='coverage' then c.dropped:=c.dropped+least(greatest(coalesce((e->>'count')::integer,1),1),10000);end if;
   accepted:=accepted||to_jsonb(eid::text);c.event_count:=c.event_count+1;c.daily_events:=c.daily_events+1;if not critical then c.daily_normal:=c.daily_normal+1;end if;
  else rejected:=rejected||to_jsonb(eid::text);c.dropped:=c.dropped+1; end if;
  ikind:=case when e->>'type'='user_report' then 'user_report' when e->>'type' in ('ui_error','unhandled_rejection','chunk_error') then 'ui_error' when e->>'type'='operation' and e->>'outcome' in ('failed','timeout','unknown','committed_refresh_failed') then 'operation' else null end;
  if ikind is not null then
   ikey:=case when ikind='user_report' then 'report:'||eid::text else concat_ws(':',ikind,p_profile::text,e->>'module',e->>'operation',e->>'errorClass',e->>'buildId',to_char(t,'YYYYMMDDHH24')) end;
   select id into existing from motorist_diagnostic_incidents where organization_id=p_org and environment=p_environment and dedupe_key=ikey;
   if existing is not null then
    update motorist_diagnostic_incidents set last_seen_at=t,count=least(count::bigint+least(greatest(coalesce((e->>'count')::integer,1),1),10000),2147483647)::integer,evidence_ids=case when stored and cardinality(evidence_ids)<20 then array_append(evidence_ids,eid) else evidence_ids end where id=existing;
   elsif c.incident_count<1536 and c.event_count*4096::bigint+c.incident_count*8192::bigint+c.counter_count*1024::bigint+8192<=134217728 then
    insert into motorist_diagnostic_incidents(organization_id,environment,dedupe_key,module,operation,kind,build_id,profile_id,call_session_id,case_id,evidence_ids,count) values(p_org,p_environment,ikey,e->>'module',e->>'operation',ikind,e->>'buildId',p_profile,cid,caid,case when stored then array[eid] else '{}'::uuid[] end,least(greatest(coalesce((e->>'count')::integer,1),1),10000));
    c.incident_count:=c.incident_count+1;
   end if;
  end if;
 end loop;
 update motorist_diagnostic_counters set minute=c.minute,batches=c.batches,day=c.day,daily_events=c.daily_events,daily_normal=c.daily_normal,event_count=c.event_count,incident_count=c.incident_count,counter_count=c.counter_count,dropped=c.dropped,updated_at=t where organization_id=p_org and environment=p_environment and key='org';
 update motorist_diagnostic_counters set minute=q.minute,batches=q.batches,updated_at=t where organization_id=p_org and environment=p_environment and key=p_profile::text;
 return jsonb_build_object('acceptedIds',accepted,'rejectedIds',rejected,'degraded',c.dropped>0);
end $$;
revoke all on function public.motorist_diagnostics_ingest(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.motorist_diagnostics_ingest(uuid,uuid,text,text,text,jsonb) to service_role;

create function public.motorist_diagnostic_incident_dto(i public.motorist_diagnostic_incidents) returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',i.id,'firstSeenAt',i.first_seen_at,'lastSeenAt',i.last_seen_at,'module',i.module,'operation',i.operation,'kind',i.kind,'status',i.status,'count',i.count,'buildId',i.build_id,'profileId',i.profile_id,'callSessionId',i.call_session_id,'caseId',i.case_id,'classification',i.classification,'cause','unknown','evidenceIds',i.evidence_ids)
$$;
revoke all on function public.motorist_diagnostic_incident_dto(public.motorist_diagnostic_incidents) from public,anon,authenticated;
create function public.motorist_diagnostics_read(p_org uuid,p_profile uuid,p_environment text,p_mode text,p_id uuid default null,p_since timestamptz default now()-interval '24 hours',p_until timestamptz default now(),p_cursor_at timestamptz default null,p_cursor_id uuid default null,p_limit integer default 100,p_status text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp set statement_timeout='1000ms' set lock_timeout='100ms' as $$
declare result jsonb; items jsonb; ev jsonb; legs jsonb; ops jsonb; builds jsonb; calls jsonb; storage jsonb; inc motorist_diagnostic_incidents%rowtype; n integer:=least(greatest(p_limit,1),100); next_cursor text; t timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from motorist_profiles where id=p_profile and organization_id=p_org and active and role in ('manager','admin')) then raise exception 'diagnostics forbidden' using errcode='42501';end if;
 if p_until<p_since or p_until-p_since>interval '7 days' then raise exception 'invalid diagnostics range';end if;
 if p_mode='detail' or p_mode='status' then
  select * into inc from motorist_diagnostic_incidents where id=p_id and organization_id=p_org and environment=p_environment;
  if not found then return null;end if;
  if p_mode='status' then
   if p_status not in ('new','acknowledged','resolved') or p_status is null then raise exception 'invalid status';end if;
   update motorist_diagnostic_incidents set status=p_status where id=p_id returning * into inc;
  end if;
  select coalesce(jsonb_agg(e.event||jsonb_build_object('receivedAt',e.received_at,'profileId',e.profile_id,'source',e.source,'serverBuild',e.server_build) order by e.received_at),'[]') into ev from motorist_diagnostic_events e where e.organization_id=p_org and e.environment=p_environment and e.id=any(inc.evidence_ids);
  return jsonb_build_object('incident',motorist_diagnostic_incident_dto(inc),'events',ev,'checkedAt',t);
 elsif p_mode='timeline' then
  if not exists(select 1 from motorist_call_sessions where organization_id=p_org and id=p_id) then return null;end if;
  select coalesce(jsonb_agg(x.dto order by x.received_at desc,x.id desc),'[]') into ev from (select e.id,e.received_at,e.event||jsonb_build_object('receivedAt',e.received_at,'profileId',e.profile_id,'source',e.source,'serverBuild',e.server_build) dto from motorist_diagnostic_events e where e.organization_id=p_org and e.environment=p_environment and e.call_session_id=p_id and e.received_at>=p_since and e.received_at<=p_until and (p_cursor_at is null or (e.received_at,e.id)<(p_cursor_at,p_cursor_id)) order by e.received_at desc,e.id desc limit n)x;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'role',l.role,'answeredAt',l.answered_at,'bridgedAt',l.bridged_at,'endedAt',l.ended_at)),'[]') into legs from (select id,role,answered_at,bridged_at,ended_at from motorist_call_legs where organization_id=p_org and session_id=p_id order by initiated_at limit 100)l;
  if jsonb_array_length(ev)=n then next_cursor:=(ev->(n-1)->>'receivedAt')||'|'||(ev->(n-1)->>'id');end if;
  return jsonb_build_object('callSessionId',p_id,'checkedAt',t,'events',ev,'legs',legs,'nextCursor',next_cursor,'cause','unknown');
 elsif p_mode<>'overview' then raise exception 'invalid diagnostics read';end if;
 select coalesce(jsonb_agg(motorist_diagnostic_incident_dto(i) order by i.last_seen_at desc,i.id desc),'[]') into items from (select * from motorist_diagnostic_incidents where organization_id=p_org and environment=p_environment and classification not in ('candidate','expected_end') and last_seen_at>=p_since and last_seen_at<=p_until and (p_cursor_at is null or (last_seen_at,id)<(p_cursor_at,p_cursor_id)) order by last_seen_at desc,id desc limit n)i;
 if jsonb_array_length(items)=n then next_cursor:=(items->(n-1)->>'lastSeenAt')||'|'||(items->(n-1)->>'id');end if;
 select coalesce(jsonb_agg(jsonb_build_object('operation',x.operation,'sampleRate',x.rate,'samples',x.n,'failedSamples',x.failed,'p50Ms',x.p50,'p95Ms',case when x.n>=100 then x.p95 else null end,'insufficientData',x.n<100)),'[]') into ops from (
  select event->>'operation' operation,(event->>'sampleRate')::numeric rate,count(*) n,count(*) filter(where event->>'outcome' in ('failed','timeout','unknown','committed_refresh_failed')) failed,percentile_cont(0.5) within group(order by (event->>'durationMs')::numeric) p50,percentile_cont(0.95) within group(order by (event->>'durationMs')::numeric) p95
  from motorist_diagnostic_events where organization_id=p_org and environment=p_environment and received_at between p_since and p_until and event->>'type'='operation' and event->>'sampled'='true' and event ? 'durationMs' group by event->>'operation',(event->>'sampleRate')::numeric)x;
 select coalesce(jsonb_agg(jsonb_build_object('buildId',x.build,'lastSeenAt',x.last_seen,'events',x.n)),'[]') into builds from (select event->>'buildId' build,max(received_at) last_seen,count(*) n from motorist_diagnostic_events where organization_id=p_org and environment=p_environment and received_at between p_since and p_until group by event->>'buildId' order by max(received_at) desc limit 100)x;
 select coalesce(jsonb_agg(jsonb_build_object('direction',x.direction,'total',x.n,'answered',x.answered,'unanswered',x.unanswered,'active',x.active,'averageWaitSeconds',x.wait,'averageAnsweredToEndSeconds',x.duration)),'[]') into calls from (
  select direction,count(*) n,count(*) filter(where answered_at is not null) answered,count(*) filter(where answered_at is null and ended_at is not null) unanswered,count(*) filter(where ended_at is null) active,avg(extract(epoch from answered_at-started_at)) filter(where answered_at>=started_at) wait,avg(extract(epoch from ended_at-answered_at)) filter(where ended_at>=answered_at) duration from motorist_call_sessions where organization_id=p_org and started_at between p_since and p_until group by direction)x;
 select jsonb_build_object('chargedBytes',coalesce(c.event_count,0)*4096::bigint+coalesce(c.incident_count,0)*8192::bigint+coalesce(c.counter_count,0)*1024::bigint,'eventCount',coalesce(c.event_count,0),'incidentCount',coalesce(c.incident_count,0),'dropped',coalesce(c.dropped,0),'physicalBytes',g.physical_bytes,'physicalBudgetBytes',g.budget_bytes,'physicalCheckedAt',g.checked_at,'blocked',g.blocked or g.checked_at is null or g.checked_at<t-interval '10 minutes','cleanupBacklog',coalesce(c.cleanup_backlog,false)) into storage from motorist_diagnostic_guard g left join motorist_diagnostic_counters c on c.organization_id=p_org and c.environment=p_environment and c.key='org' where g.id;
 return jsonb_build_object('checkedAt',t,'enabled',true,'environment',p_environment,'coverage',case when coalesce((storage->>'dropped')::bigint,0)>0 then 'limited' else 'unknown' end,'since',p_since,'until',p_until,'incidents',items,'nextCursor',next_cursor,'operations',ops,'builds',builds,'calls',calls,'storage',storage);
end $$;
revoke all on function public.motorist_diagnostics_read(uuid,uuid,text,text,uuid,timestamptz,timestamptz,timestamptz,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.motorist_diagnostics_read(uuid,uuid,text,text,uuid,timestamptz,timestamptz,timestamptz,uuid,integer,text) to service_role;

-- Server facts, never provider cause labels, determine the observation. Cause remains unknown.
create index if not exists motorist_call_legs_diagnostic_candidates on public.motorist_call_legs(organization_id,updated_at,id) where role='operator' and bridged_at is not null and ended_at is not null;
-- Invalid historical timestamps are absent evidence, never a failed maintenance run.
create function public.motorist_diagnostic_timestamp(value text) returns timestamptz language plpgsql stable set search_path=public,pg_temp as $$
begin return value::timestamptz;exception when others then return null;end $$;
revoke all on function public.motorist_diagnostic_timestamp(text) from public,anon,authenticated;
-- Only a still-unexplained operator departure allocates a diagnostic incident.
-- Browser hangup intent must belong to that operator, never a supervisor/other participant.
create function public.motorist_diagnostic_classify_leg(p_org uuid,p_environment text,p_leg uuid,t timestamptz)
returns text language plpgsql stable set search_path=public,pg_temp as $$
declare r record;v_classification text;begin
 select l.ended_at,l.profile_id,s.id call_session_id,s.customer_leg_id,s.direction,s.termination_requested_at,s.parked_at,s.metadata into r
 from motorist_call_legs l join motorist_call_sessions s on s.id=l.session_id and s.organization_id=p_org where l.id=p_leg and l.organization_id=p_org;
 if not found then return 'unknown';end if;
   v_classification:='unknown';
   if r.termination_requested_at between r.ended_at-interval '2 minutes' and r.ended_at+interval '1 second'
    or (r.direction<>'internal' and motorist_diagnostic_timestamp(r.metadata#>>'{hangup,at}') between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second')
    or (r.metadata#>>'{transfer,by}'=r.profile_id::text and motorist_diagnostic_timestamp(r.metadata#>>'{transfer,completed_at}') between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second')
    or r.parked_at between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second' or exists(select 1 from motorist_diagnostic_events e where e.organization_id=p_org and e.environment=p_environment and e.call_session_id=r.call_session_id and e.profile_id=r.profile_id and e.received_at between r.ended_at-interval '1 day' and t and e.event->>'reason' in ('hangup_intent','hangup_requested') and motorist_diagnostic_timestamp(e.event->>'occurredAt') between r.ended_at-interval '30 seconds' and r.ended_at+interval '2 seconds') then v_classification:='expected_end';
   elsif exists(select 1 from motorist_call_legs l where l.organization_id=p_org and l.session_id=r.call_session_id and l.id=r.customer_leg_id and l.ended_at<=r.ended_at+interval '1 second') then v_classification:='expected_end';
   elsif r.ended_at>t-interval '10 seconds' then v_classification:='candidate';
   elsif exists(select 1 from motorist_call_legs l where l.organization_id=p_org and l.session_id=r.call_session_id and l.id=r.customer_leg_id and l.answered_at is not null and (l.ended_at is null or l.ended_at>r.ended_at+interval '10 seconds')) then v_classification:='interruption_observed';end if;
 return v_classification;
end $$;
revoke all on function public.motorist_diagnostic_classify_leg(uuid,text,uuid,timestamptz) from public,anon,authenticated;
create function public.motorist_diagnostics_maintain(p_org uuid,p_environment text,p_budget bigint,p_classify boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp set statement_timeout='1800ms' set lock_timeout='100ms' as $$
declare c motorist_diagnostic_counters%rowtype; g motorist_diagnostic_guard%rowtype; removed integer; removed_i integer; removed_c integer; processed integer:=0; r record; k text; v_classification text; iid uuid; t timestamptz:=clock_timestamp(); begin
 if p_environment not in ('production','test','development') or p_budget<0 or p_budget>134217728 then raise exception 'invalid diagnostics budget';end if;
 select * into g from motorist_diagnostic_guard where id for update;
 if g.checked_at is null or g.checked_at<=t-interval '5 minutes' or p_budget<>g.budget_bytes then
  select sum(pg_total_relation_size(x::regclass)) into g.physical_bytes from unnest(array['public.motorist_diagnostic_events','public.motorist_diagnostic_incidents','public.motorist_diagnostic_counters','public.motorist_diagnostic_guard','public.motorist_call_legs_diagnostic_candidates']) x;
  g.budget_bytes:=p_budget;g.blocked:=p_budget=0 or g.physical_bytes>=p_budget;g.checked_at:=t;
  update motorist_diagnostic_guard set budget_bytes=g.budget_bytes,physical_bytes=g.physical_bytes,checked_at=t,blocked=g.blocked where id;
 end if;
 -- One preallocated per-org counter is the only new row allowed for initial admission.
 if not exists(select 1 from motorist_diagnostic_counters where organization_id=p_org and environment=p_environment and key='org') then
  if g.blocked then return jsonb_build_object('blocked',true);end if;
  insert into motorist_diagnostic_counters(organization_id,environment,key) values(p_org,p_environment,'org');
 end if;
 select * into c from motorist_diagnostic_counters where organization_id=p_org and environment=p_environment and key='org' for update;
 with ids as (select id from motorist_diagnostic_events where organization_id=p_org and environment=p_environment and received_at<t-interval '14 days' order by received_at limit 800), deleted as(delete from motorist_diagnostic_events e using ids where e.organization_id=p_org and e.environment=p_environment and e.id=ids.id returning e.id) select count(*) into removed from deleted;
 with ids as (select id from motorist_diagnostic_incidents where organization_id=p_org and environment=p_environment and (last_seen_at<t-interval '90 days' or (classification='expected_end' and first_seen_at<t-interval '24 hours')) order by last_seen_at limit 100), deleted as(delete from motorist_diagnostic_incidents e using ids where e.id=ids.id returning e.id) select count(*) into removed_i from deleted;
 with ids as (select key from motorist_diagnostic_counters where organization_id=p_org and environment=p_environment and key<>'org' and updated_at<t-interval '1 day' limit 100), deleted as(delete from motorist_diagnostic_counters e using ids where e.organization_id=p_org and e.environment=p_environment and e.key=ids.key returning e.key) select count(*) into removed_c from deleted;
 c.event_count:=greatest(0,c.event_count-removed);c.incident_count:=greatest(0,c.incident_count-removed_i);c.counter_count:=greatest(1,c.counter_count-removed_c);
 c.cleanup_backlog:=exists(select 1 from motorist_diagnostic_events where organization_id=p_org and environment=p_environment and received_at<t-interval '14 days') or exists(select 1 from motorist_diagnostic_incidents where organization_id=p_org and environment=p_environment and (last_seen_at<t-interval '90 days' or (classification='expected_end' and first_seen_at<t-interval '24 hours'))) or exists(select 1 from motorist_diagnostic_counters where organization_id=p_org and environment=p_environment and key<>'org' and updated_at<t-interval '1 day');
 if p_classify then
  -- 250 new candidates plus 250 existing candidates for late evidence, no sleeping.
  for r in select l.id,l.session_id,l.ended_at,l.updated_at from motorist_call_legs l where l.organization_id=p_org and l.role='operator' and l.bridged_at is not null and l.ended_at is not null and l.ended_at>=t-interval '7 days' and (c.cursor_at is null or (l.updated_at,l.id)>(c.cursor_at,c.cursor_id)) order by l.updated_at,l.id limit 250 loop
   c.cursor_at:=r.updated_at;c.cursor_id:=r.id;k:='call:'||r.session_id::text||':'||r.id::text||':server';
   v_classification:=motorist_diagnostic_classify_leg(p_org,p_environment,r.id,t);
   if v_classification='expected_end' then processed:=processed+1;continue;end if;
   if not g.blocked and c.incident_count<1536 and c.event_count*4096::bigint+c.incident_count*8192::bigint+c.counter_count*1024::bigint+8192<=134217728 then
    insert into motorist_diagnostic_incidents(organization_id,environment,dedupe_key,module,kind,call_session_id,leg_id,first_seen_at,last_seen_at,classification) values(p_org,p_environment,k,'telephony','call_interruption',r.session_id,r.id,r.ended_at,r.ended_at,v_classification) on conflict(organization_id,environment,dedupe_key) do nothing returning id into iid;
    if iid is not null then c.incident_count:=c.incident_count+1;end if;
   else c.dropped:=c.dropped+1;end if;
   processed:=processed+1;
  end loop;
  for r in select i.id,i.call_session_id,i.leg_id,l.ended_at,l.profile_id,s.state,s.customer_leg_id,s.direction,s.termination_requested_at,s.parked_at,s.metadata from motorist_diagnostic_incidents i join motorist_call_legs l on l.id=i.leg_id and l.organization_id=p_org join motorist_call_sessions s on s.id=i.call_session_id and s.organization_id=p_org where i.organization_id=p_org and i.environment=p_environment and i.kind='call_interruption' and i.first_seen_at>=t-interval '24 hours' order by i.classified_at nulls first,i.id limit 250 loop
   v_classification:=motorist_diagnostic_classify_leg(p_org,p_environment,r.leg_id,t);
   -- A separate check timestamp rotates the queue without inventing a new occurrence.
   update motorist_diagnostic_incidents i set status=case when v_classification='expected_end' then 'resolved' when i.classification='expected_end' and i.status='resolved' then 'new' else i.status end,classification=v_classification,classified_at=t,evidence_ids=array(select e.id from motorist_diagnostic_events e where e.organization_id=p_org and e.environment=p_environment and e.call_session_id=r.call_session_id and e.received_at between r.ended_at-interval '1 day' and t order by e.received_at desc limit 20) where i.id=r.id;
   processed:=processed+1;
  end loop;
 end if;
 update motorist_diagnostic_counters set event_count=c.event_count,incident_count=c.incident_count,counter_count=c.counter_count,dropped=c.dropped,cleanup_backlog=c.cleanup_backlog,cursor_at=c.cursor_at,cursor_id=c.cursor_id,updated_at=t where organization_id=p_org and environment=p_environment and key='org';
 return jsonb_build_object('blocked',g.blocked,'physicalBytes',g.physical_bytes,'deletedEvents',removed,'deletedIncidents',removed_i,'deletedCounters',removed_c,'candidates',processed,'cleanupBacklog',c.cleanup_backlog);
end $$;
revoke all on function public.motorist_diagnostics_maintain(uuid,text,bigint,boolean) from public,anon,authenticated;
grant execute on function public.motorist_diagnostics_maintain(uuid,text,bigint,boolean) to service_role;

notify pgrst, 'reload schema';
