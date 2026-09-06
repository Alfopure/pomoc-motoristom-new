-- Separate Telnyx copy only. Apply only after explicit approval of this migration.
-- Existing duplicate transcripts must be resolved explicitly; never delete them here.
begin;

do $$ begin
 if exists(select 1 from public.motorist_call_transcripts where recording_id is not null group by organization_id,recording_id having count(*)>1) then
  raise exception 'Recording migration preflight: duplicate transcripts require reviewed repair';
 end if;
 if exists(select 1 from public.motorist_call_recordings r join public.motorist_calls c on c.id=r.call_id where c.organization_id<>r.organization_id)
 or exists(select 1 from public.motorist_call_transcripts t join public.motorist_calls c on c.id=t.call_id where c.organization_id<>t.organization_id)
 or exists(select 1 from public.motorist_call_transcripts t join public.motorist_call_recordings r on r.id=t.recording_id where r.organization_id<>t.organization_id or r.call_id<>t.call_id) then
  raise exception 'Recording migration preflight: cross-organization source linkage';
 end if;
end $$;

alter table public.motorist_calls add column recording_source_revision integer not null default 1;
alter table public.motorist_call_recordings
 add column session_id uuid references public.motorist_call_sessions(id),
 add column source_revision integer not null default 1,
 add column started_at timestamptz,
 add column ended_at timestamptz,
 add column deleted_at timestamptz,
 add column restricted_at timestamptz,
 add column expires_at timestamptz,
 add column sha256 text,
 add column bytes bigint,
 add column participant_manifest jsonb not null default '{}'::jsonb;
alter table public.motorist_call_transcripts
 add column audio_source_revision integer not null default 1,
 add column source_revision integer not null default 1,
 add column deleted_at timestamptz,
 add column expires_at timestamptz;
-- Backfill the approved default; existing NULL expiry must not create unlimited retention.
update public.motorist_call_recordings set expires_at=coalesce(fetched_at,created_at)+interval '30 days' where expires_at is null;
update public.motorist_call_transcripts set expires_at=created_at+interval '30 days' where expires_at is null;
create unique index call_transcript_recording_revision on public.motorist_call_transcripts(organization_id,recording_id,source_revision) where recording_id is not null;

create table public.motorist_call_recording_policies(
 organization_id uuid primary key references public.motorist_organizations(id) on delete cascade,
 revision integer not null default 1,
 recording_enabled boolean not null default false,
 transcription_enabled boolean not null default false,
 analysis_enabled boolean not null default false,
 quality_enabled boolean not null default false,
 inbound_enabled boolean not null default true,
 outbound_enabled boolean not null default true,
 audio_retention_days integer not null default 30 check(audio_retention_days between 1 and 365),
 transcript_retention_days integer not null default 30 check(transcript_retention_days between 1 and 365),
 review_retention_days integer not null default 90 check(review_retention_days between 1 and 365),
 max_recordings_per_hour integer not null default 10 check(max_recordings_per_hour between 1 and 1000),
 max_recording_bytes bigint not null default 134217728 check(max_recording_bytes between 1024 and 134217728),
 max_segment_seconds integer not null default 1800 check(max_segment_seconds between 1 and 1800),
 daily_budget_usd numeric(12,6) not null default 10 check(daily_budget_usd between 0 and 1000),
 controller_name text, contact_email text, privacy_notice_url text, service_legal_basis text, quality_legal_basis text,
 approved_at timestamptz, approved_by uuid references public.motorist_profiles(id),
 config jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(not (recording_enabled or transcription_enabled or analysis_enabled) or (approved_at is not null and approved_by is not null))
);
create table public.motorist_call_participant_intervals(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 call_id uuid not null references public.motorist_calls(id), session_id uuid not null references public.motorist_call_sessions(id),
 leg_id uuid references public.motorist_call_legs(id), profile_id uuid references public.motorist_profiles(id),
 role text not null, started_at timestamptz not null, ended_at timestamptz, audible_to_customer boolean not null default false,
 reason text not null, channel integer, verified boolean not null default false, topology_epoch integer not null default 0,
 source_event_id text not null, created_at timestamptz not null default now(), check(ended_at is null or ended_at>=started_at)
);
create unique index recording_participant_event on public.motorist_call_participant_intervals(organization_id,source_event_id,coalesce(leg_id,'00000000-0000-0000-0000-000000000000'::uuid),reason);
create table public.motorist_call_processing_jobs(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 call_id uuid not null references public.motorist_calls(id), recording_id uuid references public.motorist_call_recordings(id),
 kind text not null check(kind in ('import','asr','analysis','delete','reconcile')),
 input_revision integer not null default 1, dedupe_key text not null,
 state text not null default 'queued' check(state in ('queued','processing','waiting','submission_unknown','complete','failed','cancelled')),
 attempt integer not null default 0, lease_token uuid, lease_epoch bigint not null default 0, lease_expires_at timestamptz,
 next_attempt_at timestamptz not null default now(), paid_submit_started boolean not null default false,
 correlation_token uuid not null default gen_random_uuid(), provider_ids jsonb not null default '{}'::jsonb,
 checkpoint jsonb not null default '{}'::jsonb, result jsonb not null default '{}'::jsonb, error_code text,
 reserved_usd numeric(12,6) not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,dedupe_key), unique(correlation_token)
);
create index recording_jobs_due on public.motorist_call_processing_jobs(organization_id,next_attempt_at,created_at) where state in ('queued','waiting','processing');
create table public.motorist_call_processing_budget(
 organization_id uuid not null references public.motorist_organizations(id), budget_day date not null,
 reserved_usd numeric(12,6) not null default 0, primary key(organization_id,budget_day)
);
create table public.motorist_call_analyses(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 call_id uuid not null references public.motorist_calls(id), input_revision integer not null, input_hash text not null,
 rubric_version text not null, model text not null, status text not null check(status in ('draft','complete','failed','stale','deleted')),
 result jsonb not null default '{}'::jsonb, provider_usage jsonb not null default '{}'::jsonb,
 expires_at timestamptz, deleted_at timestamptz, created_at timestamptz not null default now(),
 unique(organization_id,call_id,input_hash,rubric_version,model)
);
create table public.motorist_call_quality_reviews(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 call_id uuid not null references public.motorist_calls(id), analysis_id uuid not null references public.motorist_call_analyses(id),
 operator_profile_id uuid not null references public.motorist_profiles(id), rubric_cohort_id text not null,
 source_revision integer not null, status text not null check(status in ('approved','rejected','stale')),
 criteria jsonb not null, score numeric check(score between 0 and 100), coverage numeric not null check(coverage between 0 and 1),
 reviewer_profile_id uuid not null references public.motorist_profiles(id), note text not null default '', created_at timestamptz not null default now()
);
create table public.motorist_call_effective_reviews(
 organization_id uuid not null references public.motorist_organizations(id), call_id uuid not null references public.motorist_calls(id),
 operator_profile_id uuid not null references public.motorist_profiles(id), rubric_cohort_id text not null,
 review_id uuid not null references public.motorist_call_quality_reviews(id), source_revision integer not null,
 primary key(organization_id,call_id,operator_profile_id,rubric_cohort_id)
);
create table public.motorist_call_review_requests(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 call_id uuid not null references public.motorist_calls(id), operator_profile_id uuid not null references public.motorist_profiles(id),
 requester_profile_id uuid not null references public.motorist_profiles(id), review_id uuid references public.motorist_call_quality_reviews(id),
 note text not null, status text not null default 'open' check(status in ('open','resolved')), created_at timestamptz not null default now()
);
create table public.motorist_call_transcript_revisions(
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.motorist_organizations(id),
 transcript_id uuid not null references public.motorist_call_transcripts(id), source_revision integer not null,
 transcript_text text, speaker_segments jsonb not null, edited_by uuid not null references public.motorist_profiles(id),
 reason text not null, created_at timestamptz not null default now()
);

-- Service-only mutations; app API applies role/org authorization for each request.
drop policy if exists call_recordings_restricted_access on public.motorist_call_recordings;
drop policy if exists call_transcripts_restricted_access on public.motorist_call_transcripts;
-- Raw rows contain private metadata; every read passes the authorized server API.
revoke all on public.motorist_call_recordings,public.motorist_call_transcripts from anon,authenticated;
grant all on public.motorist_call_recordings,public.motorist_call_transcripts to service_role;
create table public.motorist_call_recording_access(
 organization_id uuid not null references public.motorist_organizations(id), profile_id uuid not null references public.motorist_profiles(id),
 audio_read boolean not null default false, quality_review boolean not null default false,
 primary key(organization_id,profile_id)
);
create table public.motorist_call_recording_admissions(
 call_id uuid primary key references public.motorist_calls(id), organization_id uuid not null references public.motorist_organizations(id),
 session_id uuid not null references public.motorist_call_sessions(id), created_at timestamptz not null default now()
);
create or replace function public.motorist_recording_admit_session(p_organization_id uuid,p_session_id uuid,p_call_id uuid,p_max_per_hour integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('motorist_recording_admission',0));
 if not exists(select 1 from motorist_calls where id=p_call_id and organization_id=p_organization_id and session_id=p_session_id)
 or not exists(select 1 from motorist_call_sessions where id=p_session_id and organization_id=p_organization_id)
 or not exists(select 1 from motorist_call_recording_policies where organization_id=p_organization_id and approved_at is not null and recording_enabled) then return false; end if;
 if exists(select 1 from motorist_call_recording_admissions where call_id=p_call_id and organization_id=p_organization_id and session_id=p_session_id) then return true; end if;
 if exists(select 1 from motorist_call_recording_admissions where call_id=p_call_id) then return false; end if;
 if (select count(*) from motorist_call_recording_admissions where created_at>now()-interval '1 hour')>=greatest(0,least(10,p_max_per_hour,(select max_recordings_per_hour from motorist_call_recording_policies where organization_id=p_organization_id))) then return false; end if;
 insert into motorist_call_recording_admissions(call_id,organization_id,session_id) values(p_call_id,p_organization_id,p_session_id);
 return true;
end $$;
create or replace function public.motorist_recording_validate_access() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from motorist_profiles where id=new.profile_id and organization_id=new.organization_id) then raise exception 'Invalid access scope'; end if;
 return new;
end $$;
create trigger recording_access_scope before insert or update on public.motorist_call_recording_access for each row execute function public.motorist_recording_validate_access();

create or replace function public.motorist_recording_restrict_session(p_organization_id uuid,p_session_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c record;
begin
 if not exists(select 1 from motorist_call_sessions where id=p_session_id and organization_id=p_organization_id) then return false; end if;
 for c in select id from motorist_calls where session_id=p_session_id and organization_id=p_organization_id order by id for update loop
 update motorist_call_recordings set restricted_at=coalesce(restricted_at,now()) where call_id=c.id and organization_id=p_organization_id and restricted_at is null;
 end loop;
 return true;
end $$;

create or replace function public.motorist_recording_enqueue_saved(p_organization_id uuid,p_call_id uuid,p_session_id uuid,p_provider_recording_id text,p_metadata jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.motorist_call_recordings; policy public.motorist_call_recording_policies;
begin
 if not exists(select 1 from motorist_calls where id=p_call_id and organization_id=p_organization_id and session_id=p_session_id)
 or not exists(select 1 from motorist_call_sessions where id=p_session_id and organization_id=p_organization_id) then raise exception 'Invalid recording scope'; end if;
 perform 1 from motorist_calls where id=p_call_id for update;
 select * into policy from motorist_call_recording_policies where organization_id=p_organization_id;
 insert into motorist_call_recordings(organization_id,call_id,session_id,provider,provider_recording_id,provider_session_id,status,started_at,ended_at,duration_seconds,participant_manifest,expires_at,metadata)
 values(p_organization_id,p_call_id,p_session_id,'telnyx',p_provider_recording_id,p_metadata->>'providerSessionId','pending',(p_metadata->>'startedAt')::timestamptz,(p_metadata->>'endedAt')::timestamptz,(p_metadata->>'durationSeconds')::integer,coalesce(p_metadata->'participantManifest','{}'),now()+make_interval(days=>coalesce(policy.audio_retention_days,30)),jsonb_build_object('ingested',true,'recorder_id',p_metadata->>'recorderId'))
 on conflict(organization_id,provider,provider_recording_id) where provider_recording_id is not null do nothing;
 select * into r from motorist_call_recordings where organization_id=p_organization_id and provider='telnyx' and provider_recording_id=p_provider_recording_id for update;
 if r.call_id<>p_call_id or r.session_id<>p_session_id then raise exception 'Recording binding conflict'; end if;
 if exists(select 1 from motorist_call_sessions where id=p_session_id and metadata#>>'{recording,suppressionReason}'='objection') then
 update motorist_call_recordings set restricted_at=coalesce(restricted_at,now()) where id=r.id; return r.id; end if;
 if r.deleted_at is not null or r.restricted_at is not null or r.status='deleted' then return r.id; end if;
 insert into motorist_call_processing_jobs(organization_id,call_id,recording_id,kind,input_revision,dedupe_key,checkpoint)
 values(p_organization_id,p_call_id,r.id,'import',r.source_revision,'import:'||r.id||':'||r.source_revision,jsonb_build_object('source_url',p_metadata->>'sourceUrl')) on conflict do nothing;
 return r.id;
end $$;

create or replace function public.motorist_recording_claim_job(p_organization_id uuid,p_lease_seconds integer default 30)
returns setof public.motorist_call_processing_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.motorist_call_processing_jobs;
begin
 -- A lost paid-submit acknowledgement is not safely retryable.
 update motorist_call_processing_jobs set state='submission_unknown',lease_token=null,lease_expires_at=null,error_code='paid_submit_ack_unknown'
 where organization_id=p_organization_id and state='processing' and lease_expires_at<now() and paid_submit_started;
 -- Global one-active-job pilot limit, serialized across concurrent ticks.
 perform pg_advisory_xact_lock(hashtextextended('motorist_recording_processing',0));
 if exists(select 1 from motorist_call_processing_jobs where state='processing' and lease_expires_at>now()) then return; end if;
 select q.* into j from motorist_call_processing_jobs q
 where q.organization_id=p_organization_id and q.next_attempt_at<=now()
 and (q.state in ('queued','waiting') or(q.state='submission_unknown' and q.kind='analysis' and (q.checkpoint->>'analysis_stage' in ('uploading','creating_batch') or (q.checkpoint->>'analysis_stage'='uploaded' and coalesce(q.provider_ids->>'openai_input_file_id','') ~ '^file-[A-Za-z0-9_-]{1,150}$') or (q.checkpoint->>'analysis_stage'='batch_pending' and coalesce(q.provider_ids->>'openai_input_file_id','') ~ '^file-[A-Za-z0-9_-]{1,150}$' and coalesce(q.provider_ids->>'openai_batch_id','') ~ '^batch_[A-Za-z0-9_-]{1,150}$'))) or(q.state='processing' and q.lease_expires_at<now() and not q.paid_submit_started))
 and (q.kind<>'asr' or exists(select 1 from motorist_calls c where c.id=q.call_id and c.ended_at is not null))
 and (q.kind<>'analysis' or (exists(select 1 from motorist_calls c where c.id=q.call_id and c.ended_at is not null and c.recording_source_revision=q.input_revision) and not exists(select 1 from motorist_call_recordings r where r.call_id=q.call_id and (r.status<>'available' or not exists(select 1 from motorist_call_transcripts t where t.recording_id=r.id and t.audio_source_revision=r.source_revision and t.status='complete' and t.deleted_at is null)))))
 and (q.kind in ('delete','reconcile') or (not exists(select 1 from motorist_calls c join motorist_call_sessions s on s.id=c.session_id where c.id=q.call_id and s.metadata#>>'{recording,suppressionReason}'='objection') and exists(select 1 from motorist_call_recording_policies p where p.organization_id=q.organization_id and p.approved_at is not null
 and p.recording_enabled and case q.kind when 'import' then p.recording_enabled when 'asr' then p.transcription_enabled when 'analysis' then p.analysis_enabled else false end)
 and not exists(select 1 from motorist_call_recordings r where r.call_id=q.call_id and (r.deleted_at is not null or r.restricted_at is not null or r.expires_at<=now()))))
 order by case when q.kind='delete' then 0 else 1 end,q.next_attempt_at,q.created_at for update skip locked limit 1;
 if not found then return; end if;
 update motorist_call_processing_jobs set state='processing',lease_token=gen_random_uuid(),lease_epoch=lease_epoch+1,lease_expires_at=now()+make_interval(secs=>greatest(5,least(p_lease_seconds,60))),updated_at=now()
 where id=j.id returning * into j;
 return next j;
end $$;

create or replace function public.motorist_recording_checkpoint_job(p_job_id uuid,p_lease_token uuid,p_lease_epoch bigint,p_checkpoint jsonb,p_provider_ids jsonb,p_paid_submit boolean default false)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update motorist_call_processing_jobs j set checkpoint=j.checkpoint||p_checkpoint,provider_ids=j.provider_ids||p_provider_ids,paid_submit_started=p_paid_submit,updated_at=now()
 where j.id=p_job_id and j.lease_token=p_lease_token and j.lease_epoch=p_lease_epoch and j.state='processing' and j.lease_expires_at>now()
 and (j.kind in ('delete','reconcile') or (not exists(select 1 from motorist_calls c join motorist_call_sessions s on s.id=c.session_id where c.id=j.call_id and s.metadata#>>'{recording,suppressionReason}'='objection') and not exists(select 1 from motorist_call_recordings r where r.call_id=j.call_id and (r.deleted_at is not null or r.restricted_at is not null or r.expires_at<=now()))));
 return found;
end $$;

create or replace function public.motorist_recording_finish_job(p_job_id uuid,p_lease_token uuid,p_lease_epoch bigint,p_state text,p_checkpoint jsonb,p_provider_ids jsonb,p_error_code text,p_next_attempt_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare owner_call uuid; source_id uuid; job_kind text; changed boolean;
begin
 select call_id into owner_call from motorist_call_processing_jobs where id=p_job_id;
 if owner_call is null then return false; end if;
 perform 1 from motorist_calls where id=owner_call for update;
 if p_state not in ('queued','waiting','submission_unknown','complete','failed','cancelled') then raise exception 'Invalid completion state'; end if;
 update motorist_call_processing_jobs j set state=p_state,checkpoint=j.checkpoint||p_checkpoint,provider_ids=j.provider_ids||p_provider_ids,
 error_code=p_error_code,next_attempt_at=coalesce(p_next_attempt_at,now()+interval '5 minutes'),lease_token=null,lease_expires_at=null,paid_submit_started=false,
 attempt=attempt+case when p_error_code is null then 0 else 1 end,updated_at=now()
 where j.id=p_job_id and j.lease_token=p_lease_token and j.lease_epoch=p_lease_epoch and j.state='processing' and j.lease_expires_at>now()
 and (j.kind in ('delete','reconcile') or (not exists(select 1 from motorist_calls c join motorist_call_sessions s on s.id=c.session_id where c.id=j.call_id and s.metadata#>>'{recording,suppressionReason}'='objection') and not exists(select 1 from motorist_call_recordings r where r.call_id=j.call_id and (r.deleted_at is not null or r.restricted_at is not null or r.expires_at<=now())))) returning j.recording_id,j.kind into source_id,job_kind;
 changed:=found;
 if changed and p_state='failed' and job_kind='import' then update motorist_call_recordings set status='failed' where id=source_id and deleted_at is null and restricted_at is null; end if;
 return changed;
end $$;

create or replace function public.motorist_recording_reserve_budget(p_job_id uuid,p_lease_token uuid,p_lease_epoch bigint,p_amount numeric)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j motorist_call_processing_jobs; cap numeric; spent numeric;
begin
 if p_amount<0 or p_amount>100 then raise exception 'Invalid reservation'; end if;
 select * into j from motorist_call_processing_jobs where id=p_job_id and lease_token=p_lease_token and lease_epoch=p_lease_epoch and state='processing' and lease_expires_at>now() for update;
 if not found then return false; end if;
 if j.reserved_usd>=p_amount then return true; end if;
 select daily_budget_usd into cap from motorist_call_recording_policies where organization_id=j.organization_id and approved_at is not null;
 if cap is null then return false; end if;
 insert into motorist_call_processing_budget values(j.organization_id,current_date,0) on conflict do nothing;
 select reserved_usd into spent from motorist_call_processing_budget where organization_id=j.organization_id and budget_day=current_date for update;
 if spent+p_amount-j.reserved_usd>cap then return false; end if;
 update motorist_call_processing_budget set reserved_usd=reserved_usd+p_amount-j.reserved_usd where organization_id=j.organization_id and budget_day=current_date;
 update motorist_call_processing_jobs set reserved_usd=p_amount where id=j.id;
 return true;
end $$;

-- Any source revision change atomically excludes stale reviews from every trend.
create or replace function public.motorist_call_revision_invalidate() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.recording_source_revision<>old.recording_source_revision then
 update motorist_call_analyses set status='stale' where call_id=new.id and status in ('draft','complete');
 update motorist_call_quality_reviews set status='stale' where call_id=new.id and status='approved';
 delete from motorist_call_effective_reviews where call_id=new.id;
 update motorist_call_processing_jobs set state='cancelled',lease_token=null,lease_expires_at=null where call_id=new.id and kind='analysis' and input_revision<>new.recording_source_revision and state not in ('complete','failed','cancelled');
 end if; return new;
end $$;
create trigger recording_call_revision_invalidate after update of recording_source_revision on public.motorist_calls for each row execute function public.motorist_call_revision_invalidate();

create or replace function public.motorist_call_quality_approve(p_organization_id uuid,p_call_id uuid,p_analysis_id uuid,p_operator_profile_id uuid,p_rubric_cohort_id text,p_source_revision integer,p_expected_effective_review_id uuid,p_criteria jsonb,p_score numeric,p_coverage numeric,p_reviewer_profile_id uuid,p_note text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actual_revision integer; current_review uuid; result_id uuid;
begin
 select recording_source_revision into actual_revision from motorist_calls where id=p_call_id and organization_id=p_organization_id for update;
 if not exists(select 1 from motorist_profiles where id=p_operator_profile_id and organization_id=p_organization_id) or not exists(select 1 from motorist_profiles where id=p_reviewer_profile_id and organization_id=p_organization_id) then raise exception 'Invalid review scope'; end if;
 if actual_revision is distinct from p_source_revision then raise exception 'Source revision conflict' using errcode='40001'; end if;
 if not exists(select 1 from motorist_call_analyses where id=p_analysis_id and organization_id=p_organization_id and call_id=p_call_id and input_revision=p_source_revision and status in ('draft','complete') and deleted_at is null and (expires_at is null or expires_at>now()))
 or exists(select 1 from motorist_call_recordings where call_id=p_call_id and (deleted_at is not null or restricted_at is not null or expires_at<=now())) then raise exception 'Analysis unavailable'; end if;
 select review_id into current_review from motorist_call_effective_reviews where organization_id=p_organization_id and call_id=p_call_id and operator_profile_id=p_operator_profile_id and rubric_cohort_id=p_rubric_cohort_id;
 if current_review is distinct from p_expected_effective_review_id then raise exception 'Review conflict' using errcode='40001'; end if;
 insert into motorist_call_quality_reviews(organization_id,call_id,analysis_id,operator_profile_id,rubric_cohort_id,source_revision,status,criteria,score,coverage,reviewer_profile_id,note)
 values(p_organization_id,p_call_id,p_analysis_id,p_operator_profile_id,p_rubric_cohort_id,p_source_revision,'approved',p_criteria,p_score,p_coverage,p_reviewer_profile_id,p_note) returning id into result_id;
 insert into motorist_call_effective_reviews values(p_organization_id,p_call_id,p_operator_profile_id,p_rubric_cohort_id,result_id,p_source_revision)
 on conflict(organization_id,call_id,operator_profile_id,rubric_cohort_id) do update set review_id=excluded.review_id,source_revision=excluded.source_revision;
 return result_id;
end $$;

create or replace function public.motorist_call_transcript_correct(p_organization_id uuid,p_transcript_id uuid,p_expected_source_revision integer,p_transcript_text text,p_speaker_segments jsonb,p_edited_by uuid,p_reason text)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare t motorist_call_transcripts; revision integer;
begin
 select * into t from motorist_call_transcripts where id=p_transcript_id and organization_id=p_organization_id;
 if not found or t.deleted_at is not null or t.status='restricted' then raise exception 'Transcript unavailable'; end if;
 select recording_source_revision into revision from motorist_calls where id=t.call_id and organization_id=p_organization_id for update;
 if revision<>p_expected_source_revision then raise exception 'Source revision conflict' using errcode='40001'; end if;
 insert into motorist_call_transcript_revisions(organization_id,transcript_id,source_revision,transcript_text,speaker_segments,edited_by,reason)
 values(p_organization_id,t.id,t.source_revision,t.transcript_text,t.speaker_segments,p_edited_by,p_reason);
 update motorist_call_transcripts set transcript_text=p_transcript_text,speaker_segments=p_speaker_segments,summary=null,qa_score=null,extracted_fields='{}',source_revision=source_revision+1 where id=t.id;
 update motorist_calls set recording_source_revision=recording_source_revision+1 where id=t.call_id returning recording_source_revision into revision;
 insert into motorist_call_processing_jobs(organization_id,call_id,kind,input_revision,dedupe_key) values(p_organization_id,t.call_id,'analysis',revision,'analysis:'||t.call_id||':'||revision) on conflict do nothing;
 return revision;
end $$;

create or replace function public.motorist_recording_complete_import(p_job_id uuid,p_lease_token uuid,p_lease_epoch bigint,p_storage_path text,p_bytes bigint,p_sha256 text,p_mime_type text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j motorist_call_processing_jobs; r motorist_call_recordings;
begin
 select * into j from motorist_call_processing_jobs where id=p_job_id;
 if not found then return false; end if;
 perform 1 from motorist_calls where id=j.call_id for update;
 select * into j from motorist_call_processing_jobs where id=p_job_id and lease_token=p_lease_token and lease_epoch=p_lease_epoch and state='processing' and lease_expires_at>now() for update;
 if not found or j.kind<>'import' then return false; end if;
 select * into r from motorist_call_recordings where id=j.recording_id and organization_id=j.organization_id for update;
 if not found or r.deleted_at is not null or r.restricted_at is not null or r.expires_at<=now() or r.source_revision<>j.input_revision then return false; end if;
 if p_bytes<1 or p_bytes>(select max_recording_bytes from motorist_call_recording_policies where organization_id=j.organization_id) or p_sha256 !~ '^[0-9a-f]{64}$' or p_mime_type not in ('audio/wav','audio/mpeg') then raise exception 'Invalid imported audio'; end if;
 if p_storage_path<>j.organization_id||'/'||j.call_id||'/'||r.id||'/r'||r.source_revision||(case when p_mime_type='audio/wav' then '.wav' else '.mp3' end) then raise exception 'Invalid storage path'; end if;
 update motorist_call_recordings set status='available',storage_bucket='motorist-call-recordings',storage_path=p_storage_path,bytes=p_bytes,sha256=p_sha256,mime_type=p_mime_type,fetched_at=now() where id=r.id;
 update motorist_call_processing_jobs set state='complete',lease_token=null,lease_expires_at=null,checkpoint=checkpoint-'source_url',updated_at=now() where id=j.id;
 insert into motorist_call_processing_jobs(organization_id,call_id,recording_id,kind,input_revision,dedupe_key)
 values(j.organization_id,j.call_id,r.id,'asr',r.source_revision,'asr:'||r.id||':'||r.source_revision) on conflict do nothing;
 return true;
end $$;

-- The signed callback can win before the submitting request receives its IDs.
-- Bind the acknowledgement without reviving a completed/cancelled lease.
create or replace function public.motorist_recording_bind_scribe_ack(p_correlation_token uuid,p_request_id text,p_provider_transcript_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j motorist_call_processing_jobs; ids jsonb;
begin
 select * into j from motorist_call_processing_jobs where correlation_token=p_correlation_token and kind='asr' for update;
 if not found or not(j.paid_submit_started or j.provider_ids ? 'scribe_request_id' or j.checkpoint ? 'submit_started_at') then return false; end if;
 if j.provider_ids->>'scribe_request_id' is not null and j.provider_ids->>'scribe_request_id'<>p_request_id then raise exception 'Scribe request binding conflict'; end if;
 ids:=jsonb_strip_nulls(jsonb_build_object('scribe_request_id',p_request_id,'scribe_transcript_id',p_provider_transcript_id));
 update motorist_call_processing_jobs set provider_ids=provider_ids||ids where id=j.id;
 if j.state in ('complete','cancelled','failed') then
 insert into motorist_call_processing_jobs(organization_id,call_id,recording_id,kind,input_revision,dedupe_key,checkpoint,provider_ids)
 values(j.organization_id,j.call_id,j.recording_id,'delete',j.input_revision,'scribe-cleanup:'||j.id,jsonb_build_object('scope','scribe_provider_only'),ids)
 on conflict(organization_id,dedupe_key) do update set provider_ids=motorist_call_processing_jobs.provider_ids||excluded.provider_ids,next_attempt_at=now();
 end if;
 return true;
end $$;

create or replace function public.motorist_recording_accept_scribe(p_correlation_token uuid,p_request_id text,p_transcript_text text,p_segments jsonb,p_language text,p_provider_transcript_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j motorist_call_processing_jobs; r motorist_call_recordings; revision integer; transcript_id uuid;
begin
 select * into j from motorist_call_processing_jobs where correlation_token=p_correlation_token and kind='asr';
 if not found then return false; end if;
 perform 1 from motorist_calls where id=j.call_id for update;
 select * into j from motorist_call_processing_jobs where correlation_token=p_correlation_token and kind='asr' for update;
 if not found then return false; end if;
 if j.provider_ids->>'scribe_request_id' is not null and j.provider_ids->>'scribe_request_id'<>p_request_id then raise exception 'Scribe request binding conflict'; end if;
 if j.state not in ('processing','waiting','submission_unknown','cancelled','complete') or not(j.paid_submit_started or j.provider_ids ? 'scribe_request_id' or j.checkpoint ? 'submit_started_at') then return false; end if;
 update motorist_call_processing_jobs set provider_ids=provider_ids||jsonb_strip_nulls(jsonb_build_object('scribe_request_id',p_request_id,'scribe_transcript_id',p_provider_transcript_id)) where id=j.id;
 insert into motorist_call_processing_jobs(organization_id,call_id,recording_id,kind,input_revision,dedupe_key,checkpoint,provider_ids)
 values(j.organization_id,j.call_id,j.recording_id,'delete',j.input_revision,'scribe-cleanup:'||j.id,jsonb_build_object('scope','scribe_provider_only'),jsonb_strip_nulls(jsonb_build_object('scribe_request_id',p_request_id,'scribe_transcript_id',p_provider_transcript_id)))
 on conflict(organization_id,dedupe_key) do update set provider_ids=motorist_call_processing_jobs.provider_ids||excluded.provider_ids,next_attempt_at=now();
 if j.state='complete' then return true; end if;
 if j.state='cancelled' then return false; end if;
 select * into r from motorist_call_recordings where id=j.recording_id and organization_id=j.organization_id for update;
 if not found or exists(select 1 from motorist_call_sessions where id=r.session_id and metadata#>>'{recording,suppressionReason}'='objection') or r.source_revision<>j.input_revision or r.deleted_at is not null or r.restricted_at is not null or r.expires_at<=now()
 or not exists(select 1 from motorist_call_recording_policies where organization_id=j.organization_id and approved_at is not null and transcription_enabled) then return false; end if;
 perform 1 from motorist_calls where id=j.call_id and organization_id=j.organization_id for update;
 insert into motorist_call_transcripts(id,organization_id,call_id,recording_id,audio_source_revision,source_revision,status,language,transcript_text,speaker_segments,model,expires_at)
 values(j.correlation_token,j.organization_id,j.call_id,r.id,r.source_revision,1,'complete',coalesce(p_language,'und'),p_transcript_text,p_segments,'scribe_v2',now()+make_interval(days=>(select transcript_retention_days from motorist_call_recording_policies where organization_id=j.organization_id)))
 on conflict(organization_id,recording_id,source_revision) where recording_id is not null do nothing returning id into transcript_id;
 update motorist_call_processing_jobs set state='complete',lease_token=null,lease_expires_at=null,paid_submit_started=false,updated_at=now() where id=j.id;
 if transcript_id is not null then
 update motorist_calls set recording_source_revision=recording_source_revision+1 where id=j.call_id returning recording_source_revision into revision;
 insert into motorist_call_processing_jobs(organization_id,call_id,kind,input_revision,dedupe_key)
 values(j.organization_id,j.call_id,'analysis',revision,'analysis:'||j.call_id||':'||revision) on conflict do nothing;
 end if;
 return true;
end $$;

create or replace function public.motorist_recording_restrict_source() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.deleted_at is distinct from old.deleted_at or new.restricted_at is distinct from old.restricted_at or new.source_revision<>old.source_revision then
 update motorist_calls set recording_source_revision=recording_source_revision+1 where id=new.call_id;
 if new.deleted_at is not null or new.restricted_at is not null then
 update motorist_call_processing_jobs set state='cancelled',lease_token=null,lease_expires_at=null where call_id=new.call_id and kind not in ('delete','reconcile') and state not in ('complete','failed','cancelled');
 update motorist_call_transcripts set status='restricted',summary=null,qa_score=null,extracted_fields='{}' where call_id=new.call_id;
 end if;
 if new.deleted_at is not null then
 update motorist_call_transcripts set deleted_at=new.deleted_at,transcript_text=null,speaker_segments='[]',summary=null,qa_score=null,extracted_fields='{}' where call_id=new.call_id;
 update motorist_call_analyses set status='deleted',deleted_at=new.deleted_at,result='{}' where call_id=new.call_id;
 delete from motorist_call_transcript_revisions where transcript_id in(select id from motorist_call_transcripts where call_id=new.call_id);
 update motorist_call_quality_reviews set criteria='{}',score=null,status='stale',note='' where call_id=new.call_id;
 update motorist_call_review_requests set note='',status='resolved' where call_id=new.call_id;
 update motorist_call_processing_jobs set checkpoint=checkpoint-'source_url'-'hash_state'-'pending_chunk' where call_id=new.call_id;
 insert into motorist_call_processing_jobs(organization_id,call_id,recording_id,kind,input_revision,dedupe_key,checkpoint)
 values(new.organization_id,new.call_id,new.id,'delete',new.source_revision,'delete:'||new.id,jsonb_build_object('scope','recording')) on conflict do nothing;
 end if;
 end if; return new;
end $$;
create trigger recording_restrict_source after update of deleted_at,restricted_at,source_revision on public.motorist_call_recordings for each row execute function public.motorist_recording_restrict_source();

create or replace function public.motorist_recording_sweep(p_organization_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare affected integer; c record;
begin
 -- Lock calls before sources/jobs, matching publication and correction.
 for c in select distinct call_id from motorist_call_recordings where organization_id=p_organization_id and deleted_at is null and (expires_at<=now() or status='deleted') order by call_id limit 50 loop
 perform 1 from motorist_calls where id=c.call_id for update;
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

-- Private bucket has no authenticated mutation/read policy; access is server-authorized.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('motorist-call-recordings','motorist-call-recordings',false,134217728,array['audio/mpeg','audio/wav','audio/x-wav'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

do $$ declare t text; f record; begin
 foreach t in array array['motorist_call_recording_access','motorist_call_recording_admissions','motorist_call_recording_policies','motorist_call_participant_intervals','motorist_call_processing_jobs','motorist_call_processing_budget','motorist_call_analyses','motorist_call_quality_reviews','motorist_call_effective_reviews','motorist_call_review_requests','motorist_call_transcript_revisions'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and (proname like 'motorist_recording_%' or proname in ('motorist_call_quality_approve','motorist_call_transcript_correct','motorist_call_revision_invalidate')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
