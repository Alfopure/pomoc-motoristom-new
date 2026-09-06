-- Separate Telnyx copy. Apply only after explicit migration approval.
begin;

create or replace function public.motorist_recording_policy_save(p_organization_id uuid,p_expected_revision integer,p_actor_id uuid,p_approved boolean,p_policy jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare current_policy motorist_call_recording_policies; next_revision integer;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('manager','admin')) then raise exception 'Policy access denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('recording_policy:'||p_organization_id,0));
 select * into current_policy from motorist_call_recording_policies where organization_id=p_organization_id for update;
 if coalesce(current_policy.revision,0)<>p_expected_revision then raise exception 'Policy revision conflict' using errcode='40001'; end if;
 if coalesce((p_policy->>'recordingEnabled')::boolean,false) and not p_approved then raise exception 'Policy approval required'; end if;
 if (p_policy->>'qualityEnabled')::boolean and not (p_policy->>'analysisEnabled')::boolean
 or (p_policy->>'analysisEnabled')::boolean and not (p_policy->>'transcriptionEnabled')::boolean
 or (p_policy->>'transcriptionEnabled')::boolean and not (p_policy->>'recordingEnabled')::boolean then raise exception 'Inconsistent recording policy'; end if;
 if (p_policy->>'recordingEnabled')::boolean and (coalesce(p_policy->>'controllerName','')='' or coalesce(p_policy->>'contactEmail','')='' or coalesce(p_policy->>'privacyNoticeUrl','')='' or coalesce(p_policy->>'serviceLegalBasis','')='') then raise exception 'Recording information incomplete'; end if;
 if (p_policy->>'qualityEnabled')::boolean and coalesce(p_policy->>'qualityLegalBasis','')='' then raise exception 'Quality purpose incomplete'; end if;
 next_revision:=p_expected_revision+1;
 insert into motorist_call_recording_policies(organization_id,revision,recording_enabled,transcription_enabled,analysis_enabled,quality_enabled,inbound_enabled,outbound_enabled,audio_retention_days,transcript_retention_days,review_retention_days,max_recordings_per_hour,max_recording_bytes,max_segment_seconds,controller_name,contact_email,privacy_notice_url,service_legal_basis,quality_legal_basis,approved_at,approved_by)
 values(p_organization_id,next_revision,(p_policy->>'recordingEnabled')::boolean,(p_policy->>'transcriptionEnabled')::boolean,(p_policy->>'analysisEnabled')::boolean,(p_policy->>'qualityEnabled')::boolean,(p_policy->>'inboundEnabled')::boolean,(p_policy->>'outboundEnabled')::boolean,(p_policy->>'audioRetentionDays')::integer,(p_policy->>'transcriptRetentionDays')::integer,(p_policy->>'reviewRetentionDays')::integer,(p_policy->>'maxRecordingsPerHour')::integer,(p_policy->>'maxRecordingBytes')::bigint,(p_policy->>'maxSegmentSeconds')::integer,p_policy->>'controllerName',p_policy->>'contactEmail',p_policy->>'privacyNoticeUrl',p_policy->>'serviceLegalBasis',p_policy->>'qualityLegalBasis',case when p_approved then now() end,case when p_approved then p_actor_id end)
 on conflict(organization_id) do update set revision=excluded.revision,recording_enabled=excluded.recording_enabled,transcription_enabled=excluded.transcription_enabled,analysis_enabled=excluded.analysis_enabled,quality_enabled=excluded.quality_enabled,inbound_enabled=excluded.inbound_enabled,outbound_enabled=excluded.outbound_enabled,audio_retention_days=excluded.audio_retention_days,transcript_retention_days=excluded.transcript_retention_days,review_retention_days=excluded.review_retention_days,max_recordings_per_hour=excluded.max_recordings_per_hour,max_recording_bytes=excluded.max_recording_bytes,max_segment_seconds=excluded.max_segment_seconds,controller_name=excluded.controller_name,contact_email=excluded.contact_email,privacy_notice_url=excluded.privacy_notice_url,service_legal_basis=excluded.service_legal_basis,quality_legal_basis=excluded.quality_legal_basis,approved_at=excluded.approved_at,approved_by=excluded.approved_by,updated_at=now();
 insert into motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,before_payload,after_payload)
 values(p_organization_id,p_actor_id,'recording_policy.saved','recording_policy',p_organization_id,'app',jsonb_build_object('revision',p_expected_revision),jsonb_build_object('revision',next_revision,'approved',p_approved));
 return next_revision;
end $$;

create or replace function public.motorist_recording_publish_analysis(p_job_id uuid,p_lease_token uuid,p_lease_epoch bigint,p_input_hash text,p_model text,p_rubric_version text,p_result jsonb,p_usage jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare j motorist_call_processing_jobs; result_id uuid; retain_until timestamptz; current_revision integer;
begin
 select * into j from motorist_call_processing_jobs where id=p_job_id;
 if not found then return null; end if;
 -- Same lock order as revision invalidation: call first, then its job.
 select recording_source_revision into current_revision from motorist_calls where id=j.call_id and organization_id=j.organization_id and ended_at is not null for update;
 select * into j from motorist_call_processing_jobs where id=p_job_id and kind='analysis' and state='processing' and lease_token=p_lease_token and lease_epoch=p_lease_epoch and lease_expires_at>now() for update;
 if not found or current_revision is distinct from j.input_revision then return null; end if;
 if exists(select 1 from motorist_calls c join motorist_call_sessions s on s.id=c.session_id where c.id=j.call_id and s.metadata#>>'{recording,suppressionReason}'='objection')
 or not exists(select 1 from motorist_call_recording_policies where organization_id=j.organization_id and approved_at is not null and analysis_enabled)
 or exists(select 1 from motorist_call_recordings where call_id=j.call_id and (deleted_at is not null or restricted_at is not null or expires_at<=now() or status<>'available'))
 or not exists(select 1 from motorist_call_transcripts where call_id=j.call_id and status='complete' and deleted_at is null)
 or exists(select 1 from motorist_call_transcripts where call_id=j.call_id and (status<>'complete' or deleted_at is not null or expires_at<=now())) then return null; end if;
 if jsonb_typeof(p_result)<>'object' or jsonb_typeof(p_result->'operators')<>'array' then raise exception 'Invalid analysis'; end if;
 if not exists(select 1 from motorist_call_recording_policies where organization_id=j.organization_id and quality_enabled)
 and jsonb_array_length(p_result->'operators')>0 then return null; end if;
 select least(min(expires_at),now()+interval '30 days') into retain_until from motorist_call_transcripts where call_id=j.call_id;
 insert into motorist_call_analyses(organization_id,call_id,input_revision,input_hash,rubric_version,model,status,result,provider_usage,expires_at)
 values(j.organization_id,j.call_id,j.input_revision,p_input_hash,p_rubric_version,p_model,'draft',p_result,p_usage,retain_until)
 on conflict(organization_id,call_id,input_hash,rubric_version,model) do nothing returning id into result_id;
 if result_id is null then select id into result_id from motorist_call_analyses where organization_id=j.organization_id and call_id=j.call_id and input_hash=p_input_hash and rubric_version=p_rubric_version and model=p_model and deleted_at is null; end if;
 if result_id is null then return null; end if;
 insert into motorist_call_processing_jobs(organization_id,call_id,kind,input_revision,dedupe_key,provider_ids,checkpoint)
 values(j.organization_id,j.call_id,'delete',j.input_revision,'cleanup:analysis:'||result_id,j.provider_ids,j.checkpoint||jsonb_build_object('scope','analysis_provider_only','analysis_id',result_id,'source_job_id',j.id)) on conflict do nothing;
 update motorist_call_processing_jobs set result=jsonb_build_object('analysis_id',result_id),updated_at=now() where id=j.id;
 return result_id;
end $$;

create or replace function public.motorist_recording_delete_call(p_organization_id uuid,p_call_id uuid,p_source_revision integer,p_actor_id uuid,p_reason text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c motorist_calls;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('manager','admin')) then raise exception 'Recording access denied' using errcode='42501'; end if;
 select * into c from motorist_calls where id=p_call_id and organization_id=p_organization_id for update;
 if not found or c.recording_source_revision<>p_source_revision then raise exception 'Source revision conflict' using errcode='40001'; end if;
 if c.ended_at is null then raise exception 'Call is still active' using errcode='40001'; end if;
 update motorist_call_recordings set deleted_at=now(),status='deleted',updated_at=now() where call_id=c.id and deleted_at is null;
 insert into motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
 values(p_organization_id,p_actor_id,'recording.delete_requested','call',c.id,'app',jsonb_build_object('reason_code','operator_requested_deletion','source_revision',p_source_revision));
 return true;
end $$;

create or replace function public.motorist_recording_retry_call(p_organization_id uuid,p_call_id uuid,p_source_revision integer,p_actor_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare c motorist_calls; amount integer; retried integer; j motorist_call_processing_jobs;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('manager','admin')) then raise exception 'Recording access denied' using errcode='42501'; end if;
 select * into c from motorist_calls where id=p_call_id and organization_id=p_organization_id for update;
 if not found or c.recording_source_revision<>p_source_revision then raise exception 'Source revision conflict' using errcode='40001'; end if;
 if exists(select 1 from motorist_call_recordings where call_id=c.id and (deleted_at is not null or restricted_at is not null or expires_at<=now())) then raise exception 'Recording unavailable'; end if;
 if exists(select 1 from motorist_call_processing_jobs where call_id=c.id and (state='submission_unknown' or paid_submit_started and state in('queued','processing','waiting'))) then raise exception 'Provider outcome must be reconciled first' using errcode='40001'; end if;
 update motorist_call_processing_jobs set state='queued',next_attempt_at=now(),attempt=0,lease_token=null,lease_expires_at=null,error_code=null,updated_at=now()
 where call_id=c.id and organization_id=p_organization_id and state='failed' and kind='import' and not(checkpoint ? 'upload_create_started_at' and checkpoint->>'upload_create_started_at' is not null);
 get diagnostics amount=row_count;
 for j in select * from motorist_call_processing_jobs where call_id=c.id and organization_id=p_organization_id and state='failed' and kind in('asr','analysis') for update loop
 -- A new correlation protects the retry from late callbacks to the failed attempt.
 insert into motorist_call_processing_jobs(organization_id,call_id,recording_id,kind,input_revision,dedupe_key,checkpoint)
 values(j.organization_id,j.call_id,j.recording_id,j.kind,case when j.kind='analysis' then c.recording_source_revision else j.input_revision end,'retry:'||j.id,jsonb_build_object('retry_of',j.id)) on conflict do nothing;
 get diagnostics retried=row_count; amount:=amount+retried;
 end loop;
 insert into motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
 values(p_organization_id,p_actor_id,'recording.retry_requested','call',c.id,'app',jsonb_build_object('jobs',amount,'source_revision',p_source_revision));
 return amount;
end $$;

create or replace function public.motorist_call_quality_dashboard(p_organization_id uuid,p_from timestamptz,p_to timestamptz,p_operator_id uuid,p_language text,p_status text,p_page integer,p_page_size integer,p_rubric_version text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 with calls as (
 select c.* from motorist_calls c where c.organization_id=p_organization_id and c.started_at>=p_from and c.started_at<p_to and c.ended_at is not null
 and not exists(select 1 from motorist_call_recordings r where r.call_id=c.id and (r.deleted_at is not null or r.restricted_at is not null or r.expires_at<=now()))
 and not exists(select 1 from motorist_call_transcripts t where t.call_id=c.id and (t.status='restricted' or t.deleted_at is not null or t.expires_at<=now()))
 ), latest as (
 select distinct on(a.call_id) a.* from motorist_call_analyses a join calls c on c.id=a.call_id
 where a.organization_id=p_organization_id and a.rubric_version=p_rubric_version and a.deleted_at is null and (a.expires_at is null or a.expires_at>now()) order by a.call_id,a.created_at desc,a.id desc
 ), evaluations as (
 select a.*,op.value as evaluation from latest a cross join lateral jsonb_array_elements(a.result->'operators') op(value)
 union all
 select a.*,op.value as evaluation from motorist_call_effective_reviews e
 join motorist_call_quality_reviews r on r.id=e.review_id and r.status='approved'
 join motorist_call_analyses a on a.id=r.analysis_id join calls c on c.id=a.call_id
 cross join lateral jsonb_array_elements(a.result->'operators') op(value)
 where e.organization_id=p_organization_id and e.rubric_cohort_id=p_rubric_version and e.source_revision=c.recording_source_revision
 and a.deleted_at is null and (a.expires_at is null or a.expires_at>now()) and op.value->>'operatorId'=e.operator_profile_id::text
 and not exists(select 1 from latest l cross join lateral jsonb_array_elements(l.result->'operators') current_op(value)
 where l.call_id=c.id and current_op.value->>'operatorId'=e.operator_profile_id::text)
 ), candidates as (
 select c.id as call_id,c.started_at,a.result->>'topic' as topic,a.evaluation as evaluation,p.id as operator_id,p.display_name as operator_name,
 (select language from motorist_call_transcripts where call_id=c.id and status='complete' order by updated_at desc limit 1) as language,
 case when a.status='stale' or a.input_revision<>c.recording_source_revision then 'stale' when r.id is not null then 'approved' when a.evaluation->>'score' is null then 'unscorable' else 'draft' end as status,
 case when a.status='stale' or a.input_revision<>c.recording_source_revision then null when r.id is not null then r.score else (a.evaluation->>'score')::numeric end as score,
 coalesce(r.coverage,(a.evaluation->>'coverage')::numeric,0) as coverage
 from evaluations a join calls c on c.id=a.call_id
 join motorist_profiles p on p.id::text=a.evaluation->>'operatorId' and p.organization_id=p_organization_id
 left join motorist_call_effective_reviews e on e.organization_id=p_organization_id and e.call_id=c.id and e.operator_profile_id=p.id and e.rubric_cohort_id=p_rubric_version and e.source_revision=c.recording_source_revision
 left join motorist_call_quality_reviews r on r.id=e.review_id and r.status='approved' and r.source_revision=c.recording_source_revision
 where (p_operator_id is null or p.id=p_operator_id)
 ), filtered as (select * from candidates where (p_language is null or language=p_language) and (p_status is null or status=p_status)),
 pages as (select * from filtered order by started_at desc,call_id,operator_id limit greatest(1,least(p_page_size,100)) offset greatest(0,p_page-1)*greatest(1,least(p_page_size,100))),
 approved as (select * from filtered where status='approved' and score is not null),
 operator_totals as (select operator_id,operator_name,count(distinct call_id) as n,avg(score) as score from approved group by operator_id,operator_name),
 daily_calls as (select date_trunc('day',started_at at time zone 'Europe/Bratislava') as period,call_id,avg(score) as score from approved group by 1,call_id),
 daily as (select period,count(*) as n,avg(score) as score from daily_calls group by period)
 select jsonb_build_object('rubricVersion',p_rubric_version,'page',greatest(1,p_page),'pageSize',greatest(1,least(p_page_size,100)),
 'total',(select count(*) from filtered),
 'totals',jsonb_build_object('calls',(select count(distinct call_id) from filtered),'approved',(select count(distinct call_id) from filtered where status='approved'),'drafts',(select count(distinct call_id) from filtered where status='draft'),'unscorable',(select count(distinct call_id) from filtered where status in ('unscorable','stale')),'failed',(select count(distinct a.call_id) from latest a join calls c on c.id=a.call_id where a.status='failed' and p_status is null and (p_operator_id is null or c.operator_id=p_operator_id) and (p_language is null or exists(select 1 from motorist_call_transcripts t where t.call_id=c.id and t.language=p_language)))),
 'operators',coalesce((select jsonb_agg(jsonb_build_object('operatorId',operator_id,'operatorName',operator_name,'approvedCalls',n,'averageScore',case when n>=10 then round(score,1) end,'smallSample',n<10) order by operator_name) from operator_totals),'[]'::jsonb),
 'trend',coalesce((select jsonb_agg(jsonb_build_object('period',period::date,'approvedCalls',n,'averageScore',case when n>=10 then round(score,1) end) order by period) from daily),'[]'::jsonb),
 'rows',coalesce((select jsonb_agg(jsonb_build_object('callId',call_id,'startedAt',started_at,'operatorId',operator_id,'operatorName',operator_name,'topic',coalesce(topic,''),'language',language,'status',status,'score',score,'coverage',coverage) order by started_at desc,call_id,operator_id) from pages),'[]'::jsonb));
$$;

do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in ('motorist_recording_policy_save','motorist_recording_publish_analysis','motorist_call_quality_dashboard','motorist_recording_delete_call','motorist_recording_retry_call') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
