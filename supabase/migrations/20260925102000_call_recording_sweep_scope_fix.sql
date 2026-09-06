-- Forward fix: the PL/pgSQL loop record must not shadow the UPDATE call-table alias.
begin;
create or replace function public.motorist_recording_sweep(p_organization_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare affected integer; locked_call record;
begin
 -- Lock calls before sources/jobs, matching publication and correction.
 for locked_call in select distinct call_id from motorist_call_recordings where organization_id=p_organization_id and deleted_at is null and (expires_at<=now() or status='deleted') order by call_id limit 50 loop
 perform 1 from motorist_calls where id=locked_call.call_id for update;
 end loop;
 -- Logical tombstones happen before physical/provider deletion; callbacks cannot resurrect them.
 update motorist_call_recordings set deleted_at=now(),restricted_at=coalesce(restricted_at,now())
 where id in(select id from motorist_call_recordings where organization_id=p_organization_id and deleted_at is null and (expires_at<=now() or status='deleted') order by expires_at limit 50);
 get diagnostics affected=row_count;
 update motorist_calls c set recording_source_revision=recording_source_revision+1 where c.organization_id=p_organization_id and exists(select 1 from motorist_call_transcripts t where t.call_id=c.id and t.deleted_at is null and t.expires_at<=now());
 delete from motorist_call_transcript_revisions where transcript_id in(select id from motorist_call_transcripts where organization_id=p_organization_id and expires_at<=now());
 update motorist_call_transcripts set deleted_at=now(),status='restricted',transcript_text=null,speaker_segments='[]',summary=null,extracted_fields='{}',qa_score=null where organization_id=p_organization_id and deleted_at is null and expires_at<=now();
 delete from motorist_call_effective_reviews e where e.organization_id=p_organization_id and exists(select 1 from motorist_call_quality_reviews r join motorist_call_analyses a on a.id=r.analysis_id where r.id=e.review_id and a.expires_at<=now());
 update motorist_call_quality_reviews r set status='stale',criteria='{}',score=null,note='' where r.organization_id=p_organization_id and exists(select 1 from motorist_call_analyses a where a.id=r.analysis_id and a.expires_at<=now());
 update motorist_call_review_requests q set note='',status='resolved' where q.organization_id=p_organization_id and exists(select 1 from motorist_call_analyses a where a.call_id=q.call_id and a.expires_at<=now());
 update motorist_call_analyses set deleted_at=now(),status='deleted',result='{}' where organization_id=p_organization_id and deleted_at is null and expires_at<=now();
 -- Cancelled/stale submissions retain provider IDs for cleanup, never disappear silently.
 insert into motorist_call_processing_jobs(organization_id,call_id,recording_id,kind,input_revision,dedupe_key,checkpoint,provider_ids)
 select organization_id,call_id,recording_id,'delete',input_revision,'provider-cleanup:'||id,checkpoint||jsonb_build_object('source_job_id',id,'scope',case when kind='analysis' then 'analysis_provider_only' else 'scribe_provider_only' end),provider_ids
 from motorist_call_processing_jobs where organization_id=p_organization_id and kind in('analysis','asr') and state in('cancelled','failed') and (provider_ids<>'{}' or checkpoint ? 'analysis_stage' or checkpoint ? 'submit_started_at') on conflict(organization_id,dedupe_key) do update set provider_ids=motorist_call_processing_jobs.provider_ids||excluded.provider_ids, checkpoint=motorist_call_processing_jobs.checkpoint||excluded.checkpoint, state=case when motorist_call_processing_jobs.provider_ids @> excluded.provider_ids then motorist_call_processing_jobs.state else 'queued' end, next_attempt_at=case when motorist_call_processing_jobs.provider_ids @> excluded.provider_ids then motorist_call_processing_jobs.next_attempt_at else now() end;
 return affected;
end $$;

commit;
