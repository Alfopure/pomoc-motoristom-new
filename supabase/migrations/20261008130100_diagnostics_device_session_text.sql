-- The existing operator-device session identifier is text, while diagnostics stores
-- UUIDs. Cast the validated UUID parameter, preserving the source column index.
set local lock_timeout = '250ms';
set local statement_timeout = '5s';
create or replace function public.motorist_diagnostics_ingest(p_org uuid,p_profile uuid,p_environment text,p_source text,p_build text,p_events jsonb)
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
  if did is not null and p_source='browser' and not exists(select 1 from motorist_operator_devices d where d.organization_id=p_org and d.profile_id=p_profile and d.device_session_id=did::text and d.environment=case when p_environment='production' then 'production' else 'development' end) and not exists(select 1 from motorist_diagnostic_events d where d.organization_id=p_org and d.environment=p_environment and d.profile_id=p_profile and d.device_session_id=did) then
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

notify pgrst, 'reload schema';
