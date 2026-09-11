import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '@/test/fake-supabase';
import type { MotoristActor } from '@/server/api-auth';
import { getCallRecordingDetail, recordingPermissions, approveCallQuality, correctCallTranscript, deleteOrRetryRecording, validateReviewCriteria } from './recording-service';
import { loadRecordingSourceRows } from './recording-source';
import { QUALITY_CRITERIA } from '@/lib/telephony/recording-quality';
import { getRecordingAudio, recordingByteRange, AUDIO_RANGE_MAX } from './recording-audio';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),call=id(2),rec=id(3),transcript=id(4),operator=id(5),manager=id(6),session=id(7);
const actor=(role:MotoristActor['role'],organizationId=org):MotoristActor=>({organizationId,role,userId:id(10),profileId:role==='dispatcher'?operator:manager,displayName:'Synthetic Operator'});
function fixture() {
 const fake=createFakeSupabase();
 fake.db.seed('motorist_calls',[{id:call,organization_id:org,session_id:session,operator_id:operator,started_at:'2026-09-06T10:00:00Z',answered_at:'2026-09-06T10:00:00Z',ended_at:'2026-09-06T10:00:20Z',duration_seconds:20,recording_source_revision:1}]);
 fake.db.seed('motorist_call_sessions',[{id:session,organization_id:org,metadata:{},answered_by_profile_id:operator}]);
 fake.db.seed('motorist_call_recordings',[{id:rec,organization_id:org,call_id:call,session_id:session,source_revision:1,status:'available',started_at:'2026-09-06T10:00:00Z',ended_at:'2026-09-06T10:00:20Z',duration_seconds:20,restricted_at:null,deleted_at:null,expires_at:null,storage_bucket:'motorist-call-recordings',storage_path:`${org}/${call}/${rec}/r1.wav`,mime_type:'audio/wav',bytes:8,metadata:{source_url:'https://provider.example/private?token=secret'},participant_manifest:{timingVerified:true,channelMappingVerified:true,openingComplete:true,conversationComplete:true,closingComplete:true,gaps:[]}}]);
 fake.db.seed('motorist_call_transcripts',[{id:transcript,organization_id:org,call_id:call,recording_id:rec,audio_source_revision:1,source_revision:1,status:'complete',deleted_at:null,expires_at:null,language:'sk',transcript_text:'Private synthetic customer text',speaker_segments:[{id:'span-1',transcriptId:transcript,segmentId:rec,startSeconds:1,endSeconds:2,text:'Private synthetic customer text',speakerLabel:'speaker_0',role:'customer',operatorId:null,identityVerified:true}]}]);
 fake.db.seed('motorist_profiles',[{id:operator,organization_id:org,display_name:'Synthetic operator'},{id:manager,organization_id:org,display_name:'Synthetic manager'}]);
 fake.db.seed('motorist_call_recording_policies',[{organization_id:org,recording_enabled:true,transcription_enabled:true,analysis_enabled:true}]);
 const sign=vi.fn().mockResolvedValue({data:{signedUrl:'https://isolated.supabase.co/storage/v1/object/sign/private?token=secret'},error:null});
 Object.assign(fake.admin,{storage:{from:()=>({createSignedUrl:sign})}});
 vi.stubEnv('SUPABASE_URL','https://isolated.supabase.co');vi.stubEnv('SUPABASE_PUBLISHABLE_KEY','synthetic-public-key');
 return {...fake,sign};
}
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('recording service authorization',()=>{
 it.each(['PT409','40001'])('maps %s after the source read to a conflict without retrying recording deletion',async code=>{
  const f=fixture();
  f.db.failNext('motorist_recording_delete_call','rpc',{code,message:'Private database detail',details:null,hint:null});
  await expect(deleteOrRetryRecording(f.admin,actor('manager'),call,{sourceRevision:1,reason:'Synthetic deletion'},'delete'))
   .rejects.toMatchObject({status:409,code:'stale_recording_source',message:'Záznam medzitým zmenil kolega. Načítaj ho znova.'});
  expect(f.db.log.filter(entry=>entry.kind==='rpc')).toHaveLength(1);
  expect(f.db.find('motorist_call_recordings',row=>row.id===rec)?.deleted_at).toBeNull();
 });
 it('keeps late-recovered recording coverage partial even when the provider file claims complete timing',async()=>{
  const f=fixture();
  f.db.update('motorist_call_sessions',{metadata:{recording:{recorders:[],policy:{enabled:true},coverageUnconfirmed:{since:'2026-09-06T10:00:00Z',epoch:0,audioCommandId:'audio-command'}}}},r=>r.id===session);
  const result=await getCallRecordingDetail(f.admin,actor('manager'),call);
  expect(result.state).toBe('partial');
  expect(result.stateReason).toContain('Časť zvuku môže chýbať');
  expect(result.segments[0].canPlay).toBe(true);
 });
 it('cross-organization IDs return no source, including privileged managers',async()=>{
  const f=fixture();await expect(getCallRecordingDetail(f.admin,actor('manager',id(99)),call)).rejects.toMatchObject({status:404});
  expect(f.db.log.filter(x=>x.kind==='query'&&x.operation==='select'&&['motorist_calls','motorist_call_recordings','motorist_call_transcripts'].includes(x.table)).every(x=>x.filters?.some(s=>s==='eq(organization_id)'))).toBe(true);
 });
 it('requires explicit audio and review grants for senior dispatchers',async()=>{
  const f=fixture();expect(await recordingPermissions(f.admin,actor('senior_dispatcher'))).toEqual({full:false,review:false,manager:false});
  f.db.seed('motorist_call_recording_access',[{organization_id:org,profile_id:manager,audio_read:true,quality_review:false}]);
  expect(await recordingPermissions(f.admin,actor('senior_dispatcher'))).toEqual({full:true,review:false,manager:false});
 });
 it('operators cannot read audio/transcript or draft facts via their own call detail',async()=>{
  const f=fixture();const result=await getCallRecordingDetail(f.admin,actor('dispatcher'),call);
  expect(result.access).toBe('own_review');expect(result.segments).toEqual([]);expect(result.transcript.spans).toEqual([]);expect(result.analysis).toBeNull();
  expect(JSON.stringify(result)).not.toContain('Private synthetic');expect(JSON.stringify(result)).not.toContain('token=secret');
  await expect(getRecordingAudio(f.admin,actor('dispatcher'),call,rec,new Request('https://app.test/audio'))).rejects.toMatchObject({status:403});expect(f.sign).not.toHaveBeenCalled();
 });
 it('own approved review preserves its status while redacting call outcome, facts, coaching, timing and all citations',async()=>{
  const f=fixture(),analysisId=id(40),reviewId=id(41),rubric='motorist-quality-v1';
  const criteria=QUALITY_CRITERIA.map(c=>({id:c.id,verdict:'met',reason:'Reviewed behavior',absenceWindow:null,applicabilityReason:null,uncertaintyReason:null,evidence:[{id:'private-span',segmentId:rec,startSeconds:1,endSeconds:2,text:'Private synthetic citation',speakerLabel:'Customer',operatorId:null}]}));
  f.db.seed('motorist_call_analyses',[{id:analysisId,organization_id:org,call_id:call,input_revision:1,status:'complete',rubric_version:rubric,model:'synthetic-model',created_at:'2026-09-06T11:00:00Z',expires_at:null,deleted_at:null,result:{topic:'Private synthetic topic',summary:'Private synthetic summary',reason:'Private synthetic reason',outcome:'resolved',facts:[{label:'Private synthetic fact'}],actions:[{label:'Private synthetic action'}],nextSteps:[{label:'Private synthetic next step'}],warnings:['Private synthetic warning'],operators:[{operatorId:operator,operatorName:'Synthetic operator',rubricVersion:rubric,criteria,score:88,coverage:1,eligibilityReasons:['Private synthetic limitation'],coaching:['Private synthetic coaching']}]}}]);
  f.db.seed('motorist_call_quality_reviews',[{id:reviewId,organization_id:org,call_id:call,analysis_id:analysisId,operator_profile_id:operator,reviewer_profile_id:manager,status:'approved',source_revision:1,created_at:'2026-09-06T11:01:00Z',score:88,coverage:1,note:'Human review complete',criteria}]);
  f.db.seed('motorist_call_effective_reviews',[{organization_id:org,call_id:call,operator_profile_id:operator,rubric_cohort_id:rubric,source_revision:1,review_id:reviewId}]);
  const result=await getCallRecordingDetail(f.admin,actor('dispatcher'),call);
  expect(result).toMatchObject({access:'own_review',state:'ready',analysisState:'ready',segments:[],gaps:[],metrics:null,transcript:{status:'disabled',spans:[]},analysis:{outcome:'unknown',facts:[],actions:[],nextSteps:[],warnings:[],operators:[{operatorId:operator,criteria:[],coaching:[],eligibilityReasons:[],score:88,review:{status:'approved',note:'Human review complete'}}]}});
  expect(result.analysis?.operators[0].review?.criteria.every(c=>c.evidence.length===0)).toBe(true);
  expect(result.analysis?.operators[0].speechSeconds).toBeUndefined();expect(result.analysis?.operators[0].speechShare).toBeUndefined();expect(result.analysis?.operators[0].connectedSeconds).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('Private synthetic');expect(JSON.stringify(result)).not.toContain('token=secret');expect(f.sign).not.toHaveBeenCalled();
 });
 it('a single restricted segment hides every call transcript and derived result',async()=>{
  const f=fixture();f.db.update('motorist_call_recordings',{restricted_at:new Date().toISOString()},r=>r.id===rec);
  const result=await getCallRecordingDetail(f.admin,actor('manager'),call);expect(result.state).toBe('restricted');expect(result.transcript.spans).toEqual([]);expect(result.analysis).toBeNull();
  await expect(getRecordingAudio(f.admin,actor('manager'),call,rec,new Request('https://app.test/audio'))).rejects.toMatchObject({status:410});expect(f.sign).not.toHaveBeenCalled();
 });
 it('text correction cannot change identity, timestamps or omit source spans, and only sends exact immutable evidence to the CAS RPC',async()=>{
  const f=fixture();const detail=await getCallRecordingDetail(f.admin,actor('manager'),call);const original=detail.transcript.spans[0];
  const body={sourceRevision:1,transcriptId:transcript,text:'Corrected synthetic text',reason:'Synthetic correction',segments:[{...original,text:'Corrected synthetic text'}]};
  for(const patch of [{role:'operator',operatorId:manager,identityVerified:true},{startSeconds:0},{endSeconds:3},{id:'forged-span'}]) {
   await expect(correctCallTranscript(f.admin,actor('manager'),call,{...body,segments:[{...body.segments[0],...patch}]})).rejects.toMatchObject({status:400});
  }
  await expect(correctCallTranscript(f.admin,actor('manager'),call,{...body,segments:[]})).rejects.toMatchObject({status:409});
  await expect(correctCallTranscript(f.admin,actor('manager'),call,{...body,sourceRevision:0})).rejects.toMatchObject({status:409});
  expect(f.db.log.some(x=>x.kind==='rpc')).toBe(false);
  const rpc=vi.fn().mockReturnValue(2);f.db.registerRpc('motorist_call_transcript_correct',rpc);
  await correctCallTranscript(f.admin,actor('manager'),call,body);
  expect(rpc.mock.calls[0][0]).toMatchObject({p_organization_id:org,p_transcript_id:transcript,p_expected_source_revision:1,p_speaker_segments:body.segments});
 });
 it('review evidence cannot silently replace source text or point at a different timestamp or recording',async()=>{
  const f=fixture(),rows=(await loadRecordingSourceRows(f.admin,org,call))!;
  const criteria=QUALITY_CRITERIA.map(c=>({id:c.id,verdict:'unknown',reason:'Needs review',absenceWindow:null,applicabilityReason:null,uncertaintyReason:'Uncertain',evidence:[] as unknown[]}));
  const span=(await getCallRecordingDetail(f.admin,actor('manager'),call)).transcript.spans[0];
  for(const patch of [{text:'Altered evidence'},{startSeconds:0},{segmentId:id(99)},{operatorId:manager}]){
   criteria[0].evidence=[{...span,...patch}];expect(()=>validateReviewCriteria(criteria,rows,operator)).toThrow(expect.objectContaining({status:409,code:'stale_recording_evidence'}));
  }
 });
 it('an operator cannot approve, correct or erase by forging a mutation body',async()=>{
  const f=fixture();const body={role:'manager',sourceRevision:1,analysisId:id(40),operatorId:operator,expectedReviewId:null};
  await expect(approveCallQuality(f.admin,actor('dispatcher'),call,body)).rejects.toMatchObject({status:403});
  await expect(correctCallTranscript(f.admin,actor('dispatcher'),call,body)).rejects.toMatchObject({status:403});
  await expect(deleteOrRetryRecording(f.admin,actor('dispatcher'),call,body,'delete')).rejects.toMatchObject({status:403});
  expect(f.db.log.some(x=>x.kind==='rpc')).toBe(false);
 });
});
describe('private bounded audio proxy',()=>{
 it('caps every range and refuses malformed, multipart and out-of-bounds ranges',()=>{
  expect(recordingByteRange(null,20_000_000)).toEqual({start:0,end:AUDIO_RANGE_MAX-1});expect(recordingByteRange('bytes=-3',8)).toEqual({start:5,end:7});
  for(const range of ['bytes=9-10','bytes=4-2','bytes=0-1,4-5','bytes=-0','bytes=NaN-2','bytes=-'])expect(()=>recordingByteRange(range,8)).toThrow();
 });
 it('streams verified Range bytes without returning the signed URL or provider headers',async()=>{
  const f=fixture();const fetch=vi.fn().mockResolvedValue(new Response(new Uint8Array([1,2,3,4,5,6,7,8]),{status:206,headers:{'content-range':'bytes 0-7/8','content-length':'8','set-cookie':'provider-secret'}}));vi.stubGlobal('fetch',fetch);
  const response=await getRecordingAudio(f.admin,actor('manager'),call,rec,new Request('https://app.test/audio'));
  expect(response.status).toBe(206);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('set-cookie')).toBeNull();expect(response.headers.get('location')).toBeNull();expect((await response.arrayBuffer()).byteLength).toBe(8);expect(f.sign).toHaveBeenCalledWith(`${org}/${call}/${rec}/r1.wav`,60);
  expect(fetch.mock.calls[0][1]).toMatchObject({cache:'no-store',redirect:'error',headers:{Range:'bytes=0-7','Accept-Encoding':'identity'}});
 });
 it('rejects forged storage origin before fetch and blocks a tombstone that arrives after signing',async()=>{
  const f=fixture();f.sign.mockResolvedValue({data:{signedUrl:'https://evil.test/private?token=secret'},error:null});const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(getRecordingAudio(f.admin,actor('manager'),call,rec,new Request('https://app.test/audio'))).rejects.toMatchObject({status:503});expect(fetch).not.toHaveBeenCalled();
  f.sign.mockResolvedValue({data:{signedUrl:'https://isolated.supabase.co/storage/v1/object/sign/private?token=secret'},error:null});
  fetch.mockImplementation(async()=>{f.db.update('motorist_call_recordings',{deleted_at:new Date().toISOString()},r=>r.id===rec);return new Response(new Uint8Array(8),{status:206,headers:{'content-range':'bytes 0-7/8','content-length':'8'}});});
  await expect(getRecordingAudio(f.admin,actor('manager'),call,rec,new Request('https://app.test/audio'))).rejects.toMatchObject({status:410});
 });
 it('rejects an upstream full-file response and returns416 without signing invalid ranges',async()=>{
  const f=fixture();const fetch=vi.fn().mockResolvedValue(new Response(new Uint8Array(8),{status:200,headers:{'content-length':'8'}}));vi.stubGlobal('fetch',fetch);
  await expect(getRecordingAudio(f.admin,actor('manager'),call,rec,new Request('https://app.test/audio'))).rejects.toMatchObject({status:503});
  f.sign.mockClear();const invalid=await getRecordingAudio(f.admin,actor('manager'),call,rec,new Request('https://app.test/audio',{headers:{range:'bytes=100-200'}}));expect(invalid.status).toBe(416);expect(f.sign).not.toHaveBeenCalled();
 });
});
