import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
const run = promisify(execFile);
const base = new URL(process.env.RECORDING_TEST_DATABASE_URL ?? 'postgresql://recording_test@127.0.0.1:55432/postgres');
if (!['127.0.0.1','localhost','[::1]'].includes(base.hostname)) throw new Error('This destructive fixture may run only on an explicit local PostgreSQL instance.');
const enabled = Boolean(process.env.RECORDING_TEST_DATABASE_URL);
const database = `recording_test_${Date.now()}`;
const target = new URL(base); target.pathname = `/${database}`;
const args = ['-X','-v','ON_ERROR_STOP=1','-Atq'];
const sql = text => execFileSync('psql',[base.href,...args,'-c',text],{encoding:'utf8'}).trim();
const db = text => execFileSync('psql',[target.href,...args,'-c',text],{encoding:'utf8'}).trim();
const dbAsync = text => run('psql',[target.href,...args,'-c',text],{encoding:'utf8'});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),otherOrg=id(2),admin=id(3),operator=id(4),session=id(5),call=id(6),otherAdmin=id(7);
let recording, importJob, asrJob, revision, analysis, review;
before(()=>{
 if (!enabled) return;
 sql("DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
 sql(`CREATE DATABASE ${database}`);
 const original=readFileSync(new URL('../supabase/migrations/20260520192000_foundation_schema.sql',import.meta.url),'utf8');
 const tables=original.slice(original.indexOf('create table public.motorist_call_recordings'),original.indexOf('create table public.motorist_sms_messages'));
 db(`CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE motorist_organizations(id uuid primary key,slug text,active boolean default true);
 CREATE TABLE motorist_profiles(id uuid primary key,organization_id uuid references motorist_organizations(id),active boolean default true,role text,display_name text);
 CREATE TABLE motorist_call_sessions(id uuid primary key,organization_id uuid references motorist_organizations(id),metadata jsonb default '{}');
 CREATE TABLE motorist_call_legs(id uuid primary key,session_id uuid references motorist_call_sessions(id),organization_id uuid references motorist_organizations(id));
 CREATE TABLE motorist_calls(id uuid primary key,organization_id uuid references motorist_organizations(id),session_id uuid references motorist_call_sessions(id),started_at timestamptz default now(),ended_at timestamptz,duration_seconds integer,operator_id uuid);
 CREATE TABLE motorist_audit_log(id uuid primary key default gen_random_uuid(),organization_id uuid,actor_profile_id uuid,action text,entity_type text,entity_id uuid,source text,before_payload jsonb,after_payload jsonb);${tables}`);
 for(const file of ['20260925100000_call_recording_processing.sql','20260925101000_call_quality_services.sql']) db(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
 db(`INSERT INTO motorist_organizations(id) VALUES('${org}'),('${otherOrg}'); INSERT INTO motorist_profiles(id,organization_id,role) VALUES('${admin}','${org}','manager'),('${operator}','${org}','dispatcher'),('${otherAdmin}','${otherOrg}','manager');
 INSERT INTO motorist_call_sessions(id,organization_id) VALUES('${session}','${org}'); INSERT INTO motorist_calls(id,organization_id,session_id,ended_at) VALUES('${call}','${org}','${session}',now());
 INSERT INTO motorist_call_recording_policies(organization_id,recording_enabled,transcription_enabled,analysis_enabled,quality_enabled,approved_at,approved_by) VALUES('${org}',true,true,true,true,now(),'${admin}');`);
});
after(()=>{ if (enabled) sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); });
test('actual PostgreSQL recording transactions',{ skip: !enabled && 'Set RECORDING_TEST_DATABASE_URL to an isolated localhost PostgreSQL fixture.' },async t=>{
 await t.test('raw sources, jobs, reviews and RPCs are service-only; access grants reject wrong organization',()=>{
  for(const table of ['motorist_call_recordings','motorist_call_transcripts','motorist_call_processing_jobs','motorist_call_analyses','motorist_call_quality_reviews']) assert.equal(db(`SELECT has_table_privilege('authenticated','${table}','SELECT')`),'f');
  assert.equal(db(`SELECT has_function_privilege('authenticated','motorist_recording_claim_job(uuid,integer)','EXECUTE')`),'f');
  assert.throws(()=>db(`INSERT INTO motorist_call_recording_access VALUES('${org}','${otherAdmin}',true,true)`),/Invalid access scope/);
 });
 await t.test('admission is global, atomic and idempotent per logical call',async()=>{
  const result=await Promise.all([dbAsync(`SELECT motorist_recording_admit_session('${org}','${session}','${call}',10)`),dbAsync(`SELECT motorist_recording_admit_session('${org}','${session}','${call}',10)`)]);
  assert.equal(result.filter(x=>x.stdout.trim()==='t').length,2);assert.equal(db('SELECT count(*) FROM motorist_call_recording_admissions'),'1');
  assert.equal(db(`SELECT motorist_recording_admit_session('${otherOrg}','${session}','${call}',10)`),'f');
 });
 await t.test('saved-event replay deduplicates import, lease is exclusive and stale token cannot checkpoint',async()=>{
  recording=db(`SELECT motorist_recording_enqueue_saved('${org}','${call}','${session}','provider-test','{"durationSeconds":20}')`);
  assert.equal(db(`SELECT motorist_recording_enqueue_saved('${org}','${call}','${session}','provider-test','{}')`),recording);
  assert.equal(db('SELECT count(*) FROM motorist_call_processing_jobs'),'1');
  const claims=await Promise.all([dbAsync(`SELECT coalesce(json_agg(j),'[]') FROM motorist_recording_claim_job('${org}',30) j`),dbAsync(`SELECT coalesce(json_agg(j),'[]') FROM motorist_recording_claim_job('${org}',30) j`)]);
  const rows=claims.flatMap(x=>JSON.parse(x.stdout));assert.equal(rows.length,1);importJob=rows[0];
  assert.equal(db(`SELECT motorist_recording_checkpoint_job('${importJob.id}','${id(999)}',${importJob.lease_epoch},'{}','{}',false)`),'f');
  assert.equal(db(`SELECT motorist_recording_reserve_budget('${importJob.id}','${importJob.lease_token}',${importJob.lease_epoch},2)`),'t');
  assert.equal(db(`SELECT motorist_recording_reserve_budget('${importJob.id}','${importJob.lease_token}',${importJob.lease_epoch},11)`),'f');
 });
 await t.test('private import publication is fenced and canonical; ASR callback before acknowledgement completes exactly once',()=>{
  const path=`${org}/${call}/${recording}/r1.wav`;
  assert.throws(()=>db(`SELECT motorist_recording_complete_import('${importJob.id}','${importJob.lease_token}',${importJob.lease_epoch},'outside.wav',100,'${'a'.repeat(64)}','audio/wav')`),/Invalid storage path/);
  assert.equal(db(`SELECT motorist_recording_complete_import('${importJob.id}','${importJob.lease_token}',${importJob.lease_epoch},'${path}',100,'${'a'.repeat(64)}','audio/wav')`),'t');
  asrJob=JSON.parse(db(`SELECT row_to_json(j) FROM motorist_recording_claim_job('${org}',30) j`));assert.equal(asrJob.kind,'asr');
  assert.equal(db(`SELECT motorist_recording_checkpoint_job('${asrJob.id}','${asrJob.lease_token}',${asrJob.lease_epoch},'{"submit_started_at":"2026-09-06"}','{}',true)`),'t');
  assert.equal(db(`SELECT motorist_recording_accept_scribe('${asrJob.correlation_token}','request-test','synthetic transcript','[]','sk','transcription-test')`),'t');
  revision=Number(db(`SELECT recording_source_revision FROM motorist_calls WHERE id='${call}'`));
  assert.equal(db(`SELECT id FROM motorist_call_transcripts`),asrJob.correlation_token);
  assert.equal(db(`SELECT motorist_recording_finish_job('${asrJob.id}','${asrJob.lease_token}',${asrJob.lease_epoch},'waiting','{}','{}',null,now())`),'f');
  assert.equal(db(`SELECT motorist_recording_accept_scribe('${asrJob.correlation_token}','request-test','different duplicate','[]','sk','transcription-test')`),'t');
  assert.equal(Number(db(`SELECT recording_source_revision FROM motorist_calls WHERE id='${call}'`)),revision);
  assert.equal(db(`SELECT transcript_text FROM motorist_call_transcripts`),'synthetic transcript');
  assert.equal(db(`SELECT count(*) FROM motorist_call_processing_jobs WHERE checkpoint->>'scope'='scribe_provider_only'`),'1');
  assert.equal(db(`SELECT motorist_recording_bind_scribe_ack('${asrJob.correlation_token}','request-test','transcription-test')`),'t');
  assert.equal(db(`SELECT provider_ids->>'scribe_transcript_id' FROM motorist_call_processing_jobs WHERE checkpoint->>'scope'='scribe_provider_only'`),'transcription-test');
 });
 await t.test('competing reviewers cannot overwrite each other, and a new draft preserves effective approval',async()=>{
  analysis=id(20);db(`INSERT INTO motorist_call_analyses(id,organization_id,call_id,input_revision,input_hash,rubric_version,model,status) VALUES('${analysis}','${org}','${call}',${revision},'hash','v1','test','draft'); UPDATE motorist_call_analyses SET result='{"operators":[{"operatorId":"${operator}","score":85,"coverage":0.9}],"topic":"Synthetic topic"}' WHERE id='${analysis}'`);
  const approve=`SELECT motorist_call_quality_approve('${org}','${call}','${analysis}','${operator}','v1',${revision},null,'[]',90,0.9,'${admin}','reviewed')`;
  const attempts=await Promise.allSettled([dbAsync(approve),dbAsync(approve)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.filter(x=>x.status==='rejected').length,1);
  review=db('SELECT review_id FROM motorist_call_effective_reviews');assert.equal(db('SELECT count(*) FROM motorist_call_quality_reviews'),'1');
  db(`INSERT INTO motorist_call_analyses(organization_id,call_id,input_revision,input_hash,rubric_version,model,status) VALUES('${org}','${call}',${revision},'newhash','v1','test','draft')`);
  assert.equal(db('SELECT review_id FROM motorist_call_effective_reviews'),review);
 });
 await t.test('dashboard preserves prior approved operator omitted from the newest draft, counts filtered calls and suppresses small cohorts',()=>{
  const dashboard=(language='null',status='null')=>JSON.parse(db(`SELECT motorist_call_quality_dashboard('${org}',now()-interval '1 day',now()+interval '1 day',null,${language},${status},1,25,'v1')`));
  const result=dashboard();assert.equal(result.total,1);assert.equal(result.totals.calls,1);assert.equal(result.totals.approved,1);assert.equal(result.rows[0].operatorId,operator);assert.equal(result.rows[0].score,90);assert.equal(result.operators[0].approvedCalls,1);assert.equal(result.operators[0].averageScore,null);assert.equal(result.operators[0].smallSample,true);
  const otherLanguage=dashboard("'cs'");assert.equal(otherLanguage.total,0);assert.equal(otherLanguage.totals.calls,0);assert.equal(otherLanguage.totals.approved,0);assert.deepEqual(otherLanguage.operators,[]);
  const drafts=dashboard('null',"'draft'");assert.equal(drafts.total,0);assert.equal(drafts.totals.calls,0);
  db(`UPDATE motorist_call_quality_reviews SET note='Private synthetic note'; INSERT INTO motorist_call_review_requests(organization_id,call_id,operator_profile_id,requester_profile_id,review_id,note) VALUES('${org}','${call}','${operator}','${operator}','${review}','Private synthetic appeal')`);
 });
 await t.test('source correction retains immutable history, invalidates approvals atomically and leaves audio revision matching',()=>{
  revision=Number(db(`SELECT motorist_call_transcript_correct('${org}','${asrJob.correlation_token}',${revision},'corrected synthetic','[]','${admin}','Correction')`));
  assert.equal(db('SELECT count(*) FROM motorist_call_effective_reviews'),'0');assert.equal(db('SELECT status FROM motorist_call_quality_reviews'),'stale');
  assert.equal(db('SELECT transcript_text FROM motorist_call_transcript_revisions'),'synthetic transcript');assert.equal(db('SELECT audio_source_revision FROM motorist_call_transcripts'),'1');
  assert.throws(()=>db(`SELECT motorist_call_transcript_correct('${org}','${asrJob.correlation_token}',${revision-1},'stale','[]','${admin}','Conflict')`),/Source revision conflict/);
 });
 await t.test('publication races source correction under the same call lock and never publishes current content from stale input',async()=>{
  db("UPDATE motorist_call_processing_jobs SET state='complete' WHERE kind='delete'");
  const j=JSON.parse(db(`SELECT row_to_json(j) FROM motorist_recording_claim_job('${org}',30) j`));assert.equal(j.kind,'analysis');
  const results=await Promise.allSettled([
   dbAsync(`SELECT motorist_recording_publish_analysis('${j.id}','${j.lease_token}',${j.lease_epoch},'race-hash','test','v1','{"operators":[]}','{}')`),
   dbAsync(`SELECT motorist_call_transcript_correct('${org}','${asrJob.correlation_token}',${revision},'second correction','[]','${admin}','Correction race')`),
  ]);
  assert.equal(results.filter(x=>x.status==='rejected').length,0);
  revision=Number(db(`SELECT recording_source_revision FROM motorist_calls WHERE id='${call}'`));
  assert.equal(db(`SELECT count(*) FROM motorist_call_analyses WHERE input_hash='race-hash' AND status IN('complete','draft')`),'0');
 });
 await t.test('expired paid leases become submission_unknown and cannot be blindly claimed again',()=>{
  db(`UPDATE motorist_call_processing_jobs SET state='complete' WHERE kind='delete'; UPDATE motorist_call_processing_jobs SET state='processing',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second',paid_submit_started=true WHERE kind='analysis' AND state='queued'`);
  assert.equal(db(`SELECT count(*) FROM motorist_recording_claim_job('${org}',30)`),'0');assert.equal(db(`SELECT count(*) FROM motorist_call_processing_jobs WHERE state='submission_unknown'`),'1');
 });
 await t.test('lost checkpoint acknowledgements resume only known valid uploaded or batch-pending provider objects',()=>{
  const unknown=db("SELECT id FROM motorist_call_processing_jobs WHERE state='submission_unknown'");
  for(const [stage,ids,expected] of [
   ['uploaded',{},0], ['uploaded',{openai_input_file_id:'https://evil.test/file'},0],
   ['batch_pending',{openai_input_file_id:'file-valid'},0], ['batch_pending',{openai_input_file_id:'file-valid',openai_batch_id:'bad'},0],
   ['uploaded',{openai_input_file_id:'file-valid'},1], ['batch_pending',{openai_input_file_id:'file-valid',openai_batch_id:'batch_valid'},1],
  ]) {
   db(`UPDATE motorist_call_processing_jobs SET state='submission_unknown',lease_token=null,lease_expires_at=null,paid_submit_started=false,checkpoint='${JSON.stringify({analysis_stage:stage})}',provider_ids='${JSON.stringify(ids)}' WHERE id='${unknown}'`);
   assert.equal(Number(db(`SELECT count(*) FROM motorist_recording_claim_job('${org}',30)`)),expected,stage+JSON.stringify(ids));
  }
  db(`UPDATE motorist_call_processing_jobs SET state='submission_unknown',lease_token=null,lease_expires_at=null,paid_submit_started=false,checkpoint='{}' WHERE id='${unknown}'`);
 });
 await t.test('tombstone precedes provider deletion, blocks late callbacks and clears content/history',()=>{
  assert.equal(db(`SELECT motorist_recording_delete_call('${org}','${call}',${revision},'${admin}','Requested erasure')`),'t');
  assert.equal(db(`SELECT count(*) FROM motorist_call_transcripts WHERE transcript_text IS NOT NULL OR speaker_segments<>'[]' OR deleted_at IS NULL`),'0');assert.equal(db('SELECT count(*) FROM motorist_call_transcript_revisions'),'0');assert.equal(db('SELECT note FROM motorist_call_quality_reviews'),'');assert.equal(db('SELECT note FROM motorist_call_review_requests'),'');
  assert.equal(db(`SELECT count(*) FROM motorist_call_processing_jobs WHERE kind='delete' AND checkpoint->>'scope'='recording'`),'1');
  db(`SELECT motorist_recording_accept_scribe('${asrJob.correlation_token}','request-test','must not resurrect','[]','sk','transcription-test')`);
  assert.equal(db('SELECT count(*) FROM motorist_call_transcripts WHERE transcript_text IS NOT NULL'),'0');
 });
 await t.test('live objection blocks checkpoints and callbacks before the restriction RPC, and late saved segments stay restricted',()=>{
  const s=id(50),c=id(51),j=id(52),token=id(53),lease=id(54);
  db(`INSERT INTO motorist_call_sessions(id,organization_id) VALUES('${s}','${org}');INSERT INTO motorist_calls(id,organization_id,session_id,ended_at) VALUES('${c}','${org}','${s}',now())`);
  const r=db(`SELECT motorist_recording_enqueue_saved('${org}','${c}','${s}','objection-before','{}')`);
  db(`UPDATE motorist_call_recordings SET status='available' WHERE id='${r}'; INSERT INTO motorist_call_processing_jobs(id,organization_id,call_id,recording_id,kind,dedupe_key,state,paid_submit_started,lease_token,lease_epoch,lease_expires_at,correlation_token) VALUES('${j}','${org}','${c}','${r}','asr','asr-objection','processing',true,'${lease}',1,now()+interval '30 seconds','${token}'); UPDATE motorist_call_sessions SET metadata='{"recording":{"suppressionReason":"objection"}}' WHERE id='${s}'`);
  assert.equal(db(`SELECT motorist_recording_checkpoint_job('${j}','${lease}',1,'{}','{}',true)`),'f');
  assert.equal(db(`SELECT motorist_recording_accept_scribe('${token}','request-objection','must not publish','[]','sk','transcript-objection')`),'f');
  assert.equal(db(`SELECT count(*) FROM motorist_call_transcripts WHERE call_id='${c}'`),'0');
  assert.equal(db(`SELECT motorist_recording_restrict_session('${org}','${s}')`),'t');
  const late=db(`SELECT motorist_recording_enqueue_saved('${org}','${c}','${s}','objection-late','{}')`);
  assert.equal(db(`SELECT restricted_at IS NOT NULL FROM motorist_call_recordings WHERE id='${late}'`),'t');
  assert.equal(db(`SELECT count(*) FROM motorist_call_processing_jobs WHERE recording_id='${late}' AND kind='import'`),'0');
 });

});
