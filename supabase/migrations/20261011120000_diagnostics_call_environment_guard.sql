-- Scoped diagnostic classification only. No business rows, grants or schedules change.
-- Apply only to the exact Supabase project explicitly approved for this SQL.
-- RPC signatures and 250-new + 250-recheck / retention budgets are preserved.
begin;
set local lock_timeout = '250ms';
set local statement_timeout = '5s';

create or replace function public.motorist_diagnostic_classify_leg(p_org uuid,p_environment text,p_leg uuid,t timestamptz)
returns text language plpgsql stable set search_path=public,pg_temp as $$
declare r record;v_classification text;begin
 select l.ended_at,l.profile_id,s.id call_session_id,s.customer_leg_id,s.direction,s.termination_requested_at,s.parked_at,s.hold_started_at,s.telnyx_session_id,s.metadata into r
 from motorist_call_legs l join motorist_call_sessions s on s.id=l.session_id and s.organization_id=p_org where l.id=p_leg and l.organization_id=p_org;
 if not found then return 'unknown';end if;
 -- TEST telephony rows use development; diagnostics rows use test. Never infer
 -- ownership from a copied session ID or from missing historical metadata.
 if p_environment not in ('production','test','development') or
    r.metadata->>'environment' is distinct from (case when p_environment='production' then 'production' else 'development' end) then return 'unknown';end if;
   v_classification:='unknown';
   if r.termination_requested_at between r.ended_at-interval '2 minutes' and r.ended_at+interval '1 second'
    or (r.direction<>'internal' and motorist_diagnostic_timestamp(r.metadata#>>'{hangup,at}') between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second')
    or (r.metadata#>>'{transfer,by}'=r.profile_id::text and motorist_diagnostic_timestamp(r.metadata#>>'{transfer,completed_at}') between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second')
    or (r.metadata#>>'{park,by}'=r.profile_id::text and motorist_diagnostic_timestamp(r.metadata#>>'{park,at}') between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second')
    or (r.metadata#>>'{transfer,by}'=r.profile_id::text and r.metadata#>>'{transfer,kind}'='blind' and motorist_diagnostic_timestamp(r.metadata#>>'{transfer,at}') between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second')
    or exists(select 1 from motorist_call_legs sibling where sibling.organization_id=p_org and sibling.session_id=r.call_session_id and sibling.id<>p_leg and sibling.profile_id=r.profile_id and sibling.role in ('operator','external') and sibling.bridged_at<=r.ended_at and (sibling.ended_at is null or sibling.ended_at>r.ended_at+interval '10 seconds'))
    or exists(select 1 from motorist_call_events e where e.organization_id=p_org and e.provider='telnyx' and e.provider_session_id=r.telnyx_session_id and e.normalized_payload->>'session_id'=r.call_session_id::text and e.payload->>'actor'=r.profile_id::text and e.handled_status='processed' and e.event_type in ('app.park','app.blind_transfer','app.complete_transfer','app.leave_conference') and e.provider_timestamp between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second' and e.normalized_payload->>'error' is null and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(e.normalized_payload->'commands')='array' then e.normalized_payload->'commands' else '[]'::jsonb end) command where command->>'ok'='true' and coalesce(command->>'skipped','false')<>'true' and (case when e.event_type='app.park' then command->>'kind'='hangup' when e.event_type='app.blind_transfer' then command->>'kind' in ('transfer','dial') else command->>'kind'='conference_leave' end)))
    or r.hold_started_at between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second'
    or r.parked_at between r.ended_at-interval '30 seconds' and r.ended_at+interval '1 second' or exists(select 1 from motorist_diagnostic_events e where e.organization_id=p_org and e.environment=p_environment and e.call_session_id=r.call_session_id and e.profile_id=r.profile_id and e.received_at between r.ended_at-interval '1 day' and t and e.event->>'reason' in ('hangup_intent','hangup_requested') and motorist_diagnostic_timestamp(e.event->>'occurredAt') between r.ended_at-interval '30 seconds' and r.ended_at+interval '2 seconds') then v_classification:='expected_end';
   elsif exists(select 1 from motorist_call_legs l where l.organization_id=p_org and l.session_id=r.call_session_id and l.id=r.customer_leg_id and l.ended_at<=r.ended_at+interval '1 second') then v_classification:='expected_end';
   elsif r.ended_at>t-interval '10 seconds' then v_classification:='candidate';
   elsif exists(select 1 from motorist_call_legs l where l.organization_id=p_org and l.session_id=r.call_session_id and l.id=r.customer_leg_id and l.answered_at is not null and (l.ended_at is null or l.ended_at>r.ended_at+interval '10 seconds')) then v_classification:='interruption_observed';end if;
 return v_classification;
end $$;
revoke all on function public.motorist_diagnostic_classify_leg(uuid,text,uuid,timestamptz) from public,anon,authenticated;
create or replace function public.motorist_diagnostics_maintain(p_org uuid,p_environment text,p_budget bigint,p_classify boolean default false)
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
  for r in select l.id,l.session_id,l.ended_at,l.updated_at from motorist_call_legs l join motorist_call_sessions s on s.id=l.session_id and s.organization_id=p_org where l.organization_id=p_org and s.metadata->>'environment'=case when p_environment='production' then 'production' else 'development' end and l.role='operator' and l.bridged_at is not null and l.ended_at is not null and l.ended_at>=t-interval '7 days' and (c.cursor_at is null or (l.updated_at,l.id)>(c.cursor_at,c.cursor_id)) order by l.updated_at,l.id limit 250 loop
   c.cursor_at:=r.updated_at;c.cursor_id:=r.id;k:='call:'||r.session_id::text||':'||r.id::text||':server';
   v_classification:=motorist_diagnostic_classify_leg(p_org,p_environment,r.id,t);
   if v_classification='expected_end' then processed:=processed+1;continue;end if;
   if not g.blocked and c.incident_count<1536 and c.event_count*4096::bigint+c.incident_count*8192::bigint+c.counter_count*1024::bigint+8192<=134217728 then
    insert into motorist_diagnostic_incidents(organization_id,environment,dedupe_key,module,kind,call_session_id,leg_id,first_seen_at,last_seen_at,classification) values(p_org,p_environment,k,'telephony','call_interruption',r.session_id,r.id,r.ended_at,r.ended_at,v_classification) on conflict(organization_id,environment,dedupe_key) do nothing returning id into iid;
    if iid is not null then c.incident_count:=c.incident_count+1;end if;
   else c.dropped:=c.dropped+1;end if;
   processed:=processed+1;
  end loop;
  for r in select i.id,i.call_session_id,i.leg_id,l.ended_at,l.profile_id,s.state,s.customer_leg_id,s.direction,s.termination_requested_at,s.parked_at,s.metadata from motorist_diagnostic_incidents i join motorist_call_legs l on l.id=i.leg_id and l.session_id=i.call_session_id and l.organization_id=p_org join motorist_call_sessions s on s.id=i.call_session_id and s.organization_id=p_org where i.organization_id=p_org and i.environment=p_environment and i.kind='call_interruption' and i.first_seen_at>=t-interval '24 hours' order by i.classified_at nulls first,i.id limit 250 loop
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

commit;
