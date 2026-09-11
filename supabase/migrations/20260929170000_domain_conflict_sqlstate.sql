-- Deterministic domain conflicts must not use PostgreSQL's retryable serialization code.
-- Audited 2026-09-11 against this copy; all ten bodies match their latest repo migrations.
-- Exact definitions retain signatures, defaults, SECURITY DEFINER, search_path and locks.
-- CREATE OR REPLACE preserves owners and ACLs. No tables, data or true serialization
-- failures change. Refuse missing/drifted definitions before replacing any function.
-- Deploy compatible application error mapping to all active writers first.
begin;

do $preflight$
declare
  expected record;
  current_definition text;
begin
  for expected in select * from (values
    ('public.motorist_approve_callback_target(uuid,uuid,uuid,uuid)', '62a7e2698011302bc3f520b3c602d4f8'),
    ('public.motorist_call_quality_approve(uuid,uuid,uuid,uuid,text,integer,uuid,jsonb,numeric,numeric,uuid,text)', 'a912ca8b13b6c308c9cd5e2ac8f6693c'),
    ('public.motorist_call_transcript_correct(uuid,uuid,integer,text,jsonb,uuid,text)', '79bd093ad6d249dc6d92cfc4745af331'),
    ('public.motorist_contact_callback_policy(uuid,uuid,uuid,text,boolean,uuid,bigint,boolean)', 'ce2922960d10121113244a8d201cdf5c'),
    ('public.motorist_notebook(uuid,uuid,text,uuid,integer,text,text,uuid[])', '122bb491d945c1bb9ca1b20745ea0000'),
    ('public.motorist_recording_delete_call(uuid,uuid,integer,uuid,text)', 'd6f4a3e66791cc9154d688b5e7883135'),
    ('public.motorist_recording_policy_save(uuid,integer,uuid,boolean,jsonb)', 'b5e33e192f7283bbfd53d83abe181e94'),
    ('public.motorist_recording_retry_call(uuid,uuid,integer,uuid)', '3f75b53d70de579f3000fa77bc01233c'),
    ('public.motorist_save_case_atomic(uuid,uuid,uuid,timestamp with time zone,jsonb,jsonb,jsonb)', '49bcf57609ae10f0fb0ad1bcb4af82ea'),
    ('public.motorist_task_workspace(uuid,uuid,text,uuid,jsonb)', 'bae325431f41e33b4d788f9ef3e98d8c')
  ) as functions(signature, definition_md5)
  loop
    select pg_get_functiondef(to_regprocedure(expected.signature)) into current_definition;
    -- Normalizing the new literal permits an already-patched, otherwise exact definition.
    if current_definition is null or md5(replace(current_definition, '''PT409''', '''40001''')) <> expected.definition_md5 then
      raise exception 'Domain conflict migration refused: definition drift for %', expected.signature;
    end if;
  end loop;
end;
$preflight$;

CREATE OR REPLACE FUNCTION public.motorist_approve_callback_target(p_organization_id uuid, p_actor_id uuid, p_request_id uuid, p_verification_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.motorist_callback_requests%rowtype; target jsonb; v_authorization jsonb;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('dispatcher','senior_dispatcher','manager','admin')) then raise exception 'unauthorized actor' using errcode='42501'; end if;
 select * into r from motorist_callback_requests where organization_id=p_organization_id and id=p_request_id for update;
 if not found then raise exception 'request not found' using errcode='P0002'; end if;
 if r.status not in ('open','scheduled') or r.claimed_by is distinct from p_actor_id then raise exception 'request not owned' using errcode='42501'; end if;
 target:=public.motorist_resolve_callback_target(p_organization_id,r.caller_number);
 if target->>'status'<>'verified_alternative' or target->>'verificationId' is distinct from p_verification_id::text then raise exception 'verification changed' using errcode='PT409'; end if;
 v_authorization:=jsonb_build_object('version',1,'requestId',r.id,'verificationId',p_verification_id,'originalNumber',public.motorist_directory_number(r.caller_number),'targetNumber',target->>'dialNumber','actorProfileId',p_actor_id,'approvedAt',now());
 update motorist_callback_requests set metadata=coalesce(metadata,'{}')||jsonb_build_object('callback_target_authorization',v_authorization),updated_at=now() where id=r.id;
 return target;
end $function$;

CREATE OR REPLACE FUNCTION public.motorist_call_quality_approve(p_organization_id uuid, p_call_id uuid, p_analysis_id uuid, p_operator_profile_id uuid, p_rubric_cohort_id text, p_source_revision integer, p_expected_effective_review_id uuid, p_criteria jsonb, p_score numeric, p_coverage numeric, p_reviewer_profile_id uuid, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare actual_revision integer; current_review uuid; result_id uuid;
begin
 select recording_source_revision into actual_revision from motorist_calls where id=p_call_id and organization_id=p_organization_id for update;
 if not exists(select 1 from motorist_profiles where id=p_operator_profile_id and organization_id=p_organization_id) or not exists(select 1 from motorist_profiles where id=p_reviewer_profile_id and organization_id=p_organization_id) then raise exception 'Invalid review scope'; end if;
 if actual_revision is distinct from p_source_revision then raise exception 'Source revision conflict' using errcode='PT409'; end if;
 if not exists(select 1 from motorist_call_analyses where id=p_analysis_id and organization_id=p_organization_id and call_id=p_call_id and input_revision=p_source_revision and status in ('draft','complete') and deleted_at is null and (expires_at is null or expires_at>now()))
 or exists(select 1 from motorist_call_recordings where call_id=p_call_id and (deleted_at is not null or restricted_at is not null or expires_at<=now())) then raise exception 'Analysis unavailable'; end if;
 select review_id into current_review from motorist_call_effective_reviews where organization_id=p_organization_id and call_id=p_call_id and operator_profile_id=p_operator_profile_id and rubric_cohort_id=p_rubric_cohort_id;
 if current_review is distinct from p_expected_effective_review_id then raise exception 'Review conflict' using errcode='PT409'; end if;
 insert into motorist_call_quality_reviews(organization_id,call_id,analysis_id,operator_profile_id,rubric_cohort_id,source_revision,status,criteria,score,coverage,reviewer_profile_id,note)
 values(p_organization_id,p_call_id,p_analysis_id,p_operator_profile_id,p_rubric_cohort_id,p_source_revision,'approved',p_criteria,p_score,p_coverage,p_reviewer_profile_id,p_note) returning id into result_id;
 insert into motorist_call_effective_reviews values(p_organization_id,p_call_id,p_operator_profile_id,p_rubric_cohort_id,result_id,p_source_revision)
 on conflict(organization_id,call_id,operator_profile_id,rubric_cohort_id) do update set review_id=excluded.review_id,source_revision=excluded.source_revision;
 return result_id;
end $function$;

CREATE OR REPLACE FUNCTION public.motorist_call_transcript_correct(p_organization_id uuid, p_transcript_id uuid, p_expected_source_revision integer, p_transcript_text text, p_speaker_segments jsonb, p_edited_by uuid, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare t motorist_call_transcripts; revision integer;
begin
 select * into t from motorist_call_transcripts where id=p_transcript_id and organization_id=p_organization_id;
 if not found or t.deleted_at is not null or t.status='restricted' then raise exception 'Transcript unavailable'; end if;
 select recording_source_revision into revision from motorist_calls where id=t.call_id and organization_id=p_organization_id for update;
 if revision<>p_expected_source_revision then raise exception 'Source revision conflict' using errcode='PT409'; end if;
 insert into motorist_call_transcript_revisions(organization_id,transcript_id,source_revision,transcript_text,speaker_segments,edited_by,reason)
 values(p_organization_id,t.id,t.source_revision,t.transcript_text,t.speaker_segments,p_edited_by,p_reason);
 update motorist_call_transcripts set transcript_text=p_transcript_text,speaker_segments=p_speaker_segments,summary=null,qa_score=null,extracted_fields='{}',source_revision=source_revision+1 where id=t.id;
 update motorist_calls set recording_source_revision=recording_source_revision+1 where id=t.call_id returning recording_source_revision into revision;
 insert into motorist_call_processing_jobs(organization_id,call_id,kind,input_revision,dedupe_key) values(p_organization_id,t.call_id,'analysis',revision,'analysis:'||t.call_id||':'||revision) on conflict do nothing;
 return revision;
end $function$;

CREATE OR REPLACE FUNCTION public.motorist_contact_callback_policy(p_organization_id uuid, p_actor_id uuid, p_contact_id uuid, p_action text, p_non_callback boolean DEFAULT false, p_target_contact_id uuid DEFAULT NULL::uuid, p_expected_revision bigint DEFAULT 0, p_verified boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare actor_role text; c public.motorist_contacts%rowtype; t public.motorist_contacts%rowtype; p public.motorist_contact_callback_policies%rowtype; v public.motorist_callback_target_verifications%rowtype;
begin
 select role into actor_role from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active;
 if actor_role is null or actor_role not in ('dispatcher','senior_dispatcher','manager','admin') or p_action='save' and actor_role not in ('manager','admin') then raise exception 'unauthorized actor' using errcode='42501'; end if;
 select * into c from motorist_contacts where id=p_contact_id and organization_id=p_organization_id for update;
 if not found then raise exception 'contact not found' using errcode='P0002'; end if;
 select * into p from motorist_contact_callback_policies where source_contact_id=c.id and organization_id=p_organization_id;
 if p_action='save' then
  if p_non_callback is null then raise exception 'invalid noncallback policy' using errcode='22023'; end if;
  if coalesce(p.revision,0) is distinct from p_expected_revision then raise exception 'stale policy' using errcode='PT409'; end if;
  if p_target_contact_id is not null then
   select * into t from motorist_contacts where id=p_target_contact_id and organization_id=p_organization_id for share;
   if not found or t.id=c.id or p_non_callback is not true or p_verified is not true or public.motorist_directory_number(c.phone) is null or public.motorist_directory_number(t.phone) is null
    or public.motorist_directory_number(t.phone)=public.motorist_directory_number(c.phone)
    or exists(select 1 from motorist_contact_callback_policies cp join motorist_contacts co on co.id=cp.source_contact_id where cp.organization_id=p_organization_id and cp.non_callback and (public.motorist_directory_number(co.phone)=public.motorist_directory_number(t.phone) or exists(select 1 from motorist_noncallback_source_numbers sn where sn.source_contact_id=co.id and sn.organization_id=p_organization_id and sn.number=public.motorist_directory_number(t.phone)))) then raise exception 'invalid verified target' using errcode='22023'; end if;
   insert into motorist_callback_target_verifications(organization_id,source_contact_id,target_contact_id,source_number,target_number,verified_by)
    values(p_organization_id,c.id,t.id,public.motorist_directory_number(c.phone),public.motorist_directory_number(t.phone),p_actor_id) returning * into v;
  end if;
  if p_non_callback and public.motorist_directory_number(c.phone) is not null then
   insert into motorist_noncallback_source_numbers values(p_organization_id,c.id,public.motorist_directory_number(c.phone)) on conflict do nothing;
  end if;
  insert into motorist_contact_callback_policies(source_contact_id,organization_id,non_callback,verification_id,revision)
   values(c.id,p_organization_id,p_non_callback,v.id,coalesce(p.revision,0)+1)
   on conflict(source_contact_id) do update set non_callback=excluded.non_callback,verification_id=excluded.verification_id,revision=excluded.revision,updated_at=now() returning * into p;
 elsif p_action<>'get' then raise exception 'invalid action' using errcode='22023'; end if;
 select * into v from motorist_callback_target_verifications where id=p.verification_id;
 return jsonb_build_object('sourceContactId',c.id,'nonCallback',coalesce(p.non_callback,false),'targetContactId',v.target_contact_id,'verificationId',v.id,'revision',coalesce(p.revision,0),'verifiedAt',v.verified_at);
end $function$;

CREATE OR REPLACE FUNCTION public.motorist_notebook(p_organization_id uuid, p_actor_profile_id uuid, p_action text, p_note_id uuid DEFAULT NULL::uuid, p_expected_revision integer DEFAULT NULL::integer, p_title text DEFAULT ''::text, p_body text DEFAULT ''::text, p_recipients uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_note public.motorist_notes;
  v_result jsonb;
  v_recipient uuid;
  v_previous_recipients uuid[];
begin
  if auth.uid() is null or not exists (
    select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id = p.organization_id and o.active
    where p.id = p_actor_profile_id and p.organization_id = p_organization_id and p.user_id = auth.uid() and p.active
  ) then raise exception 'Notebook access denied' using errcode = '42501'; end if;

  if p_action = 'colleagues' then
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'displayName', p.display_name) order by p.display_name), '[]'::jsonb) into v_result
      from public.motorist_profiles p where p.organization_id = p_organization_id and p.active and p.user_id is not null and p.id <> p_actor_profile_id;
    return v_result;
  elsif p_action = 'list' then
    select coalesce(jsonb_agg(app_private.motorist_note_dto(n, p_actor_profile_id) order by n.updated_at desc, n.id), '[]'::jsonb) into v_result
      from public.motorist_notes n where n.organization_id = p_organization_id and app_private.motorist_note_access(n.id);
    return v_result;
  elsif p_action not in ('create', 'get', 'save', 'delete') then
    raise exception 'Invalid notebook operation' using errcode = '22023';
  end if;

  if p_action <> 'create' then
    -- Serialize owner writes and share revocations against the same note row.
    select * into v_note from public.motorist_notes n where n.id = p_note_id and n.organization_id = p_organization_id for update;
    if not found or not app_private.motorist_note_access(p_note_id, p_action <> 'get') then
      raise exception 'Note unavailable' using errcode = 'P0002';
    end if;
    if p_action = 'get' then return app_private.motorist_note_dto(v_note, p_actor_profile_id); end if;
    if p_expected_revision is null or p_expected_revision <> v_note.revision then
      raise exception 'Note revision conflict' using errcode = 'PT409';
    end if;
    select coalesce(array_agg(recipient_profile_id), '{}'::uuid[]) into v_previous_recipients from public.motorist_note_shares where note_id = v_note.id;
  end if;

  if p_action = 'delete' then
    delete from public.motorist_notes where id = v_note.id;
    v_result := jsonb_build_object('deleted', true);
  else
    if p_title is null or p_body is null or char_length(p_title) > 200 or char_length(p_body) > 50000 or p_recipients is null or cardinality(p_recipients) > 100
      or cardinality(p_recipients) <> (select count(distinct r) from unnest(p_recipients) r)
      or exists (select 1 from unnest(p_recipients) r where r is null or r = p_actor_profile_id or not exists (
        select 1 from public.motorist_profiles p where p.id = r and p.organization_id = p_organization_id and p.active and p.user_id is not null
      )) then raise exception 'Invalid note or recipients' using errcode = '22023'; end if;
    if p_action = 'create' then
      insert into public.motorist_notes(organization_id, owner_profile_id, title, body)
        values(p_organization_id, p_actor_profile_id, p_title, p_body) returning * into v_note;
    else
      update public.motorist_notes set title = p_title, body = p_body, revision = revision + 1, updated_at = clock_timestamp()
        where id = v_note.id returning * into v_note;
    end if;
    delete from public.motorist_note_shares where note_id = v_note.id and not (recipient_profile_id = any(p_recipients));
    insert into public.motorist_note_shares(note_id, organization_id, recipient_profile_id)
      select v_note.id, p_organization_id, r from unnest(p_recipients) r on conflict do nothing;
    v_result := app_private.motorist_note_dto(v_note, p_actor_profile_id);
  end if;
  -- Content-free invalidations only, including removed recipients. Polling/focus
  -- rechecks remain authoritative when Broadcast is unavailable or ACL is stale.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    for v_recipient in select distinct r from unnest(coalesce(v_previous_recipients, '{}'::uuid[]) || coalesce(p_recipients, '{}'::uuid[]) || array[p_actor_profile_id]) r loop
      perform realtime.send('{}'::jsonb, 'invalidate', 'notebook:' || p_organization_id::text || ':' || v_recipient::text, true);
    end loop;
  end if;
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.motorist_recording_delete_call(p_organization_id uuid, p_call_id uuid, p_source_revision integer, p_actor_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c motorist_calls;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('manager','admin')) then raise exception 'Recording access denied' using errcode='42501'; end if;
 select * into c from motorist_calls where id=p_call_id and organization_id=p_organization_id for update;
 if not found or c.recording_source_revision<>p_source_revision then raise exception 'Source revision conflict' using errcode='PT409'; end if;
 if c.ended_at is null then raise exception 'Call is still active' using errcode='PT409'; end if;
 update motorist_call_recordings set deleted_at=now(),status='deleted',updated_at=now() where call_id=c.id and deleted_at is null;
 insert into motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
 values(p_organization_id,p_actor_id,'recording.delete_requested','call',c.id,'app',jsonb_build_object('reason_code','operator_requested_deletion','source_revision',p_source_revision));
 return true;
end $function$;

CREATE OR REPLACE FUNCTION public.motorist_recording_policy_save(p_organization_id uuid, p_expected_revision integer, p_actor_id uuid, p_approved boolean, p_policy jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare current_policy motorist_call_recording_policies; next_revision integer;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('manager','admin')) then raise exception 'Policy access denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('recording_policy:'||p_organization_id,0));
 select * into current_policy from motorist_call_recording_policies where organization_id=p_organization_id for update;
 if coalesce(current_policy.revision,0)<>p_expected_revision then raise exception 'Policy revision conflict' using errcode='PT409'; end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.motorist_recording_retry_call(p_organization_id uuid, p_call_id uuid, p_source_revision integer, p_actor_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c motorist_calls; amount integer; retried integer; j motorist_call_processing_jobs;
begin
 if not exists(select 1 from motorist_profiles where id=p_actor_id and organization_id=p_organization_id and active and role in ('manager','admin')) then raise exception 'Recording access denied' using errcode='42501'; end if;
 select * into c from motorist_calls where id=p_call_id and organization_id=p_organization_id for update;
 if not found or c.recording_source_revision<>p_source_revision then raise exception 'Source revision conflict' using errcode='PT409'; end if;
 if exists(select 1 from motorist_call_recordings where call_id=c.id and (deleted_at is not null or restricted_at is not null or expires_at<=now())) then raise exception 'Recording unavailable'; end if;
 if exists(select 1 from motorist_call_processing_jobs where call_id=c.id and (state='submission_unknown' or paid_submit_started and state in('queued','processing','waiting'))) then raise exception 'Provider outcome must be reconciled first' using errcode='PT409'; end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.motorist_save_case_atomic(p_organization_id uuid, p_actor_id uuid, p_case_id uuid, p_expected_updated_at timestamp with time zone, p_case_patch jsonb, p_related jsonb, p_field_labels jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  current_case public.motorist_cases;
  saved_case public.motorist_cases;
  relation jsonb;
  previous jsonb;
  patch jsonb;
  relation_table text;
  relation_id uuid;
  allowed text[];
  columns_sql text;
  changed text[] := '{}';
  field text;
  event_type text;
  event_title text;
  event_body text;
  relation_field text;
  case_columns text[] := array['status','priority','source_type','case_type','summary','main_note','contact_id','vehicle_id','pickup_location_id','destination_location_id','customer_details','vehicle_details','incident_details','location_details','replacement_vehicle_details','payment_details','closure_details','attachments_metadata'];
begin
  if not exists (select 1 from public.motorist_profiles profile join public.motorist_organizations organization on organization.id = profile.organization_id where profile.id = p_actor_id and profile.organization_id = p_organization_id and profile.active and organization.active and profile.role in ('dispatcher','senior_dispatcher','manager','admin')) then
    raise exception 'Case editor membership required' using errcode = '42501';
  end if;
  select * into current_case from public.motorist_cases where id = p_case_id and organization_id = p_organization_id for update;
  if not found then raise exception 'Case not found' using errcode = 'P0002'; end if;
  if p_expected_updated_at is null or current_case.updated_at is distinct from p_expected_updated_at then
    raise exception 'Case revision conflict' using errcode = 'PT409';
  end if;
  if jsonb_typeof(p_case_patch) <> 'object' or jsonb_typeof(p_related) <> 'array' then raise exception 'Invalid case write plan'; end if;
  if exists (select 1 from jsonb_object_keys(p_case_patch) as keys(key) where not key = any(case_columns)) then raise exception 'Invalid case field'; end if;

  for relation in select * from jsonb_array_elements(p_related) loop
    relation_table := relation->>'table'; relation_id := (relation->>'id')::uuid; patch := relation->'patch';
    case relation_table
      when 'motorist_contacts' then
        allowed := array['name','phone','email','role','notes']; relation_field := 'contact_id';
      when 'motorist_vehicles' then
        allowed := array['license_plate','vin','make','model','category','transmission','production_year','color','drive_type','weight_kg','is_driveable','notes']; relation_field := 'vehicle_id';
      when 'motorist_locations' then
        allowed := array['label','address','lat','lng','place_id','provider','confidence','metadata'];
        relation_field := case when p_case_patch->>'pickup_location_id' = relation_id::text then 'pickup_location_id' else 'destination_location_id' end;
      else raise exception 'Invalid related table';
    end case;
    if jsonb_typeof(patch) <> 'object' or exists(select 1 from jsonb_object_keys(patch) as keys(key) where not key = any(allowed)) then raise exception 'Invalid related field'; end if;
    if p_case_patch->>relation_field is distinct from relation_id::text then raise exception 'Related row must belong to this case'; end if;
    if not coalesce((relation->>'insert')::boolean, false) then
      if to_jsonb(current_case)->>relation_field is distinct from relation_id::text then raise exception 'Cannot change an unrelated row'; end if;
      execute format('select to_jsonb(row) from public.%I row where id=$1 and organization_id=$2 for update', relation_table)
        into previous using relation_id, p_organization_id;
      if previous is null then raise exception 'Related row not found' using errcode='P0002'; end if;
      if relation ? 'expectedUpdatedAt' and (previous->>'updated_at')::timestamptz is distinct from (relation->>'expectedUpdatedAt')::timestamptz then
        raise exception 'Related row revision conflict' using errcode='PT409';
      end if;
      if patch <@ previous then continue; end if;
      select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(patch) as keys(key);
      execute format('update public.%I set (%s) = (select %s from jsonb_populate_record(null::public.%I,$1)) where id=$2 and organization_id=$3', relation_table, columns_sql, columns_sql, relation_table)
        using patch, relation_id, p_organization_id;
    else
      patch := patch || jsonb_build_object('id', relation_id, 'organization_id', p_organization_id);
      select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(patch) as keys(key);
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)', relation_table, columns_sql, columns_sql, relation_table) using patch;
    end if;
    if not relation_field = any(changed) then changed := array_append(changed, relation_field); end if;
  end loop;

  for field in select key from jsonb_object_keys(p_case_patch) as keys(key) loop
    if p_case_patch->field is distinct from to_jsonb(current_case)->field and not field = any(changed) then changed := array_append(changed, field); end if;
  end loop;
  if 'status' = any(changed) then
    -- Closure is derived inside this transaction; reopening cannot retain a closed report timestamp.
    if p_case_patch->>'status' in ('completed_assisted','completed_no_assistance','rejected','cancelled','futile_trip') then
      p_case_patch := p_case_patch || jsonb_build_object('closed_at', clock_timestamp(), 'closure_details',
        coalesce(p_case_patch->'closure_details', current_case.closure_details) || jsonb_build_object('closedAt', clock_timestamp()));
    else
      p_case_patch := p_case_patch || jsonb_build_object('closed_at', null, 'closure_details',
        coalesce(p_case_patch->'closure_details', current_case.closure_details) - 'closedAt');
    end if;
  end if;
  if cardinality(changed) = 0 then return to_jsonb(current_case); end if;
  select string_agg(format('%I', key), ',') into columns_sql from jsonb_object_keys(p_case_patch) as keys(key);
  execute format('update public.motorist_cases set (%s) = (select %s from jsonb_populate_record(null::public.motorist_cases,$1)) where id=$2 and organization_id=$3 returning *', columns_sql, columns_sql)
    into saved_case using p_case_patch, p_case_id, p_organization_id;

  foreach field in array changed loop
    if field = 'status' then
      event_type := 'status_changed'; event_title := 'Stav prípadu zmenený'; event_body := 'Nový stav: ' || coalesce(p_field_labels->'statusLabels'->>saved_case.status, saved_case.status) || '.';
    elsif field = 'priority' then
      event_type := 'priority_changed'; event_title := 'Priorita prípadu zmenená'; event_body := 'Nová priorita: ' || coalesce(p_field_labels->'priorityLabels'->>saved_case.priority, saved_case.priority) || '.';
    else continue;
    end if;
    insert into public.motorist_case_events(organization_id,case_id,actor_profile_id,event_type,title,body)
      values(p_organization_id,p_case_id,p_actor_id,event_type,event_title,event_body);
  end loop;
  select string_agg(coalesce(p_field_labels->>key,key), ', ') into event_body from unnest(changed) as fields(key) where key not in ('status','priority');
  if event_body is not null then
    insert into public.motorist_case_events(organization_id,case_id,actor_profile_id,event_type,title,body)
      values(p_organization_id,p_case_id,p_actor_id,'case_updated','Karta zásahu upravená','Zmenené: ' || event_body || '.');
  end if;
  insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
    values(p_organization_id,p_actor_id,'case.update','motorist_cases',p_case_id,'dispatch_console',jsonb_build_object('case_number',saved_case.case_number,'source','extended_case_card','changed_fields',to_jsonb(changed)));
  return to_jsonb(saved_case);
end;
$function$;

CREATE OR REPLACE FUNCTION public.motorist_task_workspace(p_organization_id uuid, p_actor_profile_id uuid, p_action text, p_task_id uuid DEFAULT NULL::uuid, p_input jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_task public.motorist_case_tasks; v_message public.motorist_task_messages;
 v_cases uuid[]; v_case uuid; v_expected integer; v_message_id uuid; v_body text;
 v_result jsonb; v_next jsonb; v_count integer; v_before_at timestamptz; v_before_id uuid;
 v_previous_context text; v_previous_channels text;
begin
 if auth.uid() is null or not exists(select 1 from public.motorist_profiles p join public.motorist_organizations o on o.id=p.organization_id and o.active
   where p.id=p_actor_profile_id and p.organization_id=p_organization_id and p.user_id=auth.uid() and p.active) then raise exception 'Task access denied' using errcode='42501'; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' then raise exception 'Invalid task input' using errcode='22023'; end if;
 if p_action not in ('list','get','create','update','link','unlink','delete','messages','send_message') then raise exception 'Invalid task operation' using errcode='22023'; end if;
 -- Reads support compatible rollout; 0..N writes and chat stay off until the
 -- deployment inventory proves every allowed writer uses compatible workflows.
 if p_action not in ('list','get') and not exists(select 1 from public.motorist_task_workspace_settings s where s.organization_id=p_organization_id and s.enabled and s.writer_inventory_verified_at is not null and coalesce(length(trim(s.writer_inventory_note)),0)>0) then
   raise exception 'Task workspace activation required' using errcode='55000';
 end if;
 if p_action='list' then
   select coalesce(jsonb_agg(app_private.motorist_task_dto(t) order by t.created_at desc,t.id),'[]'::jsonb) into v_result from public.motorist_case_tasks t where t.organization_id=p_organization_id;
   return v_result;
 end if;
 if p_action='delete' then
   -- Callback resolution locks its source request before the task. Full task
   -- deletion takes the same order so cancellation cannot deadlock fulfillment.
   perform 1 from public.motorist_callback_requests r join public.motorist_task_origins o on o.source_type='callback' and o.source_id=r.id and o.organization_id=r.organization_id
     where o.organization_id=p_organization_id and o.task_id=p_task_id order by r.id for update of r;
 end if;
 if p_action<>'create' then
   select * into v_task from public.motorist_case_tasks where id=p_task_id and organization_id=p_organization_id for update;
   if not found then raise exception 'Task unavailable' using errcode='P0002'; end if;
   if p_action='get' then return app_private.motorist_task_dto(v_task); end if;
 end if;
 if p_action='messages' then
   if p_input ? 'beforeCreatedAt' or p_input ? 'beforeId' then
     v_before_at:=(p_input->>'beforeCreatedAt')::timestamptz; v_before_id:=(p_input->>'beforeId')::uuid;
     if v_before_at is null or v_before_id is null then raise exception 'Invalid message cursor' using errcode='22023'; end if;
   end if;
   select count(*) into v_count from (select 1 from public.motorist_task_messages m where m.task_id=v_task.id and m.organization_id=p_organization_id and (v_before_at is null or (m.created_at,m.id)<(v_before_at,v_before_id)) order by m.created_at desc,m.id desc limit 51) page;
   select coalesce(jsonb_agg(app_private.motorist_task_message_dto(page) order by page.created_at,page.id),'[]'::jsonb) into v_result from (select m.* from public.motorist_task_messages m where m.task_id=v_task.id and m.organization_id=p_organization_id and (v_before_at is null or (m.created_at,m.id)<(v_before_at,v_before_id)) order by m.created_at desc,m.id desc limit 50) page;
   if v_count>50 then v_next:=jsonb_build_object('createdAt',v_result->0->>'createdAt','id',v_result->0->>'id'); end if;
   return jsonb_build_object('messages',v_result,'nextCursor',v_next);
 elsif p_action='send_message' then
   v_body:=trim(p_input->>'body'); v_message_id:=(p_input->>'clientMessageId')::uuid;
   if jsonb_typeof(p_input->'body') is distinct from 'string' or v_body is null or length(v_body) not between 1 and 10000 or v_message_id is null then raise exception 'Invalid message' using errcode='22023'; end if;
   select * into v_message from public.motorist_task_messages where task_id=v_task.id and author_profile_id=p_actor_profile_id and client_message_id=v_message_id;
   if found then
     if v_message.body<>v_body then raise exception 'Message ID reused with different text' using errcode='PT409'; end if;
     return app_private.motorist_task_message_dto(v_message);
   end if;
   insert into public.motorist_task_messages(organization_id,task_id,author_profile_id,body,client_message_id) values(p_organization_id,v_task.id,p_actor_profile_id,v_body,v_message_id) returning * into v_message;
   if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then perform realtime.send('{}'::jsonb,'invalidate','tasks:'||p_organization_id::text,true); end if;
   return app_private.motorist_task_message_dto(v_message);
 end if;
 if p_action<>'create' then
   v_expected:=(p_input->>'expectedRevision')::integer;
   if v_expected is null or v_expected<>v_task.revision then raise exception 'Task revision conflict' using errcode='PT409'; end if;
 end if;
 -- All mutable fields are validated before the first write, including channels
 -- consumed by the notification migration's transactional lifecycle trigger.
 if p_action in ('create','update') then
   if p_action='create' or p_input ? 'title' then
     if jsonb_typeof(p_input->'title') is distinct from 'string' or length(trim(p_input->>'title')) not between 1 and 500 then raise exception 'Invalid task title' using errcode='22023'; end if;
   end if;
   if p_input ? 'priority' and coalesce(p_input->>'priority','') not in ('urgent','high','normal','low') then raise exception 'Invalid priority' using errcode='22023'; end if;
   if p_input ? 'kind' and coalesce(p_input->>'kind','') not in ('callback','sms','dispatch','documents','billing','handover','other') then raise exception 'Invalid kind' using errcode='22023'; end if;
   if p_input ? 'status' and coalesce(p_input->>'status','') not in ('open','done','overdue') then raise exception 'Invalid status' using errcode='22023'; end if;
   if p_input ? 'assignedTo' and p_input->>'assignedTo' is not null and not exists(select 1 from public.motorist_profiles p where p.id=(p_input->>'assignedTo')::uuid and p.organization_id=p_organization_id and p.active) then raise exception 'Invalid assignee' using errcode='22023'; end if;
   if p_action='create' or p_input ? 'caseIds' then
     if p_input ? 'caseIds' and jsonb_typeof(p_input->'caseIds')<>'array' then raise exception 'Invalid links' using errcode='22023'; end if;
     select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_cases from jsonb_array_elements_text(coalesce(p_input->'caseIds','[]'::jsonb));
     if cardinality(v_cases)>100 or cardinality(v_cases)<>(select count(distinct c) from unnest(v_cases) c) or exists(select 1 from unnest(v_cases) c where not exists(select 1 from public.motorist_cases where id=c and organization_id=p_organization_id)) then raise exception 'Invalid task links' using errcode='22023'; end if;
     if p_action='update' and v_task.origin_locked and v_task.case_id is not null and not v_task.case_id=any(v_cases) then raise exception 'System origin cannot be unlinked' using errcode='22023'; end if;
   end if;
 end if;
 if p_action in ('link','unlink') then
   v_case:=(p_input->>'caseId')::uuid;
   if v_case is null or not exists(select 1 from public.motorist_cases where id=v_case and organization_id=p_organization_id) then raise exception 'Invalid task case' using errcode='22023'; end if;
   if p_action='unlink' and v_task.origin_locked and v_task.case_id=v_case then raise exception 'System origin cannot be unlinked' using errcode='22023'; end if;
   if p_action='link' and (select count(*) from public.motorist_task_case_links where task_id=v_task.id)>=100 and not exists(select 1 from public.motorist_task_case_links where task_id=v_task.id and case_id=v_case) then raise exception 'Too many task links' using errcode='22023'; end if;
 end if;
 if p_input ? 'note' and (jsonb_typeof(p_input->'note') is distinct from 'string' or length(p_input->>'note')>10000) then raise exception 'Invalid task change note' using errcode='22023'; end if;
 if p_input ? 'reminderChannels' then
   if jsonb_typeof(p_input->'reminderChannels')<>'array' or jsonb_array_length(p_input->'reminderChannels') not between 1 and 2 or exists(select 1 from jsonb_array_elements_text(p_input->'reminderChannels') channel where channel is null or channel not in ('in_app','email')) then raise exception 'Invalid reminder channels' using errcode='22023'; end if;
 end if;
 v_previous_context:=current_setting('app.task_workspace_write',true); v_previous_channels:=current_setting('app.task_reminder_channels',true);
 perform set_config('app.task_workspace_write','v1',true);
 if p_input ? 'reminderChannels' then perform set_config('app.task_reminder_channels',(p_input->'reminderChannels')::text,true); end if;
 if p_action='create' then
   insert into public.motorist_case_tasks(organization_id,case_id,title,assigned_to,due_at,reminder_at,status,priority,kind,created_by,completed_by,completed_at)
     values(p_organization_id,v_cases[1],trim(p_input->>'title'),(p_input->>'assignedTo')::uuid,(p_input->>'dueAt')::timestamptz,(p_input->>'reminderAt')::timestamptz,coalesce(p_input->>'status','open'),coalesce(p_input->>'priority','normal'),coalesce(p_input->>'kind','other'),p_actor_profile_id,
       case when p_input->>'status'='done' then p_actor_profile_id else null end,case when p_input->>'status'='done' then clock_timestamp() else null end) returning * into v_task;
   insert into public.motorist_task_case_links(organization_id,task_id,case_id) select p_organization_id,v_task.id,c from unnest(v_cases) c on conflict do nothing;
 elsif p_action='update' then
   update public.motorist_case_tasks set
     title=case when p_input ? 'title' then trim(p_input->>'title') else title end,
     assigned_to=case when p_input ? 'assignedTo' then (p_input->>'assignedTo')::uuid else assigned_to end,
     due_at=case when p_input ? 'dueAt' then (p_input->>'dueAt')::timestamptz else due_at end,
     reminder_at=case when p_input ? 'reminderAt' then (p_input->>'reminderAt')::timestamptz else reminder_at end,
     status=coalesce(p_input->>'status',status),priority=coalesce(p_input->>'priority',priority),kind=coalesce(p_input->>'kind',kind),
     completed_at=case when p_input ? 'status' and p_input->>'status'='done' then coalesce(completed_at,clock_timestamp()) when p_input ? 'status' then null else completed_at end,
     completed_by=case when p_input ? 'status' and p_input->>'status'='done' then coalesce(completed_by,p_actor_profile_id) when p_input ? 'status' then null else completed_by end,
     case_id=case when v_cases is not null and case_id is not null and not case_id=any(v_cases) then null else case_id end
     where id=v_task.id;
   if v_cases is not null then
     delete from public.motorist_task_case_links where task_id=v_task.id and not case_id=any(v_cases);
     insert into public.motorist_task_case_links(organization_id,task_id,case_id) select p_organization_id,v_task.id,c from unnest(v_cases) c on conflict do nothing;
   end if;
 elsif p_action='link' then
   insert into public.motorist_task_case_links(organization_id,task_id,case_id) values(p_organization_id,v_task.id,v_case) on conflict do nothing;
   update public.motorist_case_tasks set updated_at=clock_timestamp() where id=v_task.id;
 elsif p_action='unlink' then
   if v_task.case_id=v_case then update public.motorist_case_tasks set case_id=null where id=v_task.id; end if;
   delete from public.motorist_task_case_links where task_id=v_task.id and case_id=v_case;
 elsif p_action='delete' then
   delete from public.motorist_case_tasks where id=v_task.id;
 end if;
 if p_action<>'delete' then select * into v_task from public.motorist_case_tasks where id=v_task.id; end if;
 insert into public.motorist_audit_log(organization_id,actor_profile_id,action,entity_type,entity_id,source,after_payload)
   values(p_organization_id,p_actor_profile_id,'task.'||p_action,'motorist_case_tasks',v_task.id,'dispatch_console',jsonb_build_object('revision',v_task.revision,'note',nullif(trim(p_input->>'note'),'')));
 if p_action='delete' then v_result:=jsonb_build_object('deleted',true);
 else select * into v_task from public.motorist_case_tasks where id=v_task.id; v_result:=app_private.motorist_task_dto(v_task); end if;
 perform set_config('app.task_workspace_write',coalesce(v_previous_context,''),true);
 perform set_config('app.task_reminder_channels',coalesce(v_previous_channels,''),true);
 if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then perform realtime.send('{}'::jsonb,'invalidate','tasks:'||p_organization_id::text,true); end if;
 return v_result;
end $function$;

commit;
