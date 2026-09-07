import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeScribeLanguage, normalizeScribeTranscription, parseScribeSpans, verifiedMultiChannel, processRecordingAsrJob, processScribeCleanupJob } from './recording-asr';
import type { RecordingJobContext, RecordingRow } from './recording-jobs';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
const at='2026-09-06T10:00:00.000Z';
const source={id:'recording',started_at:at,ended_at:'2026-09-06T10:00:20.000Z',duration_seconds:20,participant_manifest:{version:1,timingVerified:true,audioDurationSeconds:20,audioFormat:{channels:2},channelMappingVerified:true,identitySource:'authenticated_leg_binding',coverage:'verified',intervals:[{profileId:null,role:'customer',channel:0,verified:true,audibleToCustomer:true,startedAt:at,endedAt:'2026-09-06T10:00:20.000Z'},{profileId:'operator-1',role:'operator',channel:1,verified:true,audibleToCustomer:true,startedAt:at,endedAt:'2026-09-06T10:00:10.000Z'}]}} as unknown as RecordingRow;
const result={words:[{type:'word',text:'Dobrý',start:1,end:1.3,channel_index:1,speaker_id:'speaker_0'},{type:'word',text:'deň.',start:1.4,end:1.8,channel_index:1,speaker_id:'speaker_0'},{type:'word',text:'Ďakujem.',start:11,end:12,channel_index:1,speaker_id:'speaker_0'}]};
describe('ASR identity evidence',()=>{
 it('finishes cleanup only for a confirmed rejection without any acknowledged provider identity',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const ctx=(checkpoint:object,ids:object={})=>({job:{checkpoint,provider_ids:ids}} as unknown as RecordingJobContext);
  expect(await processScribeCleanupJob(ctx({submission_rejected:true}))).toMatchObject({state:'complete',checkpoint:{provider_object_created:false,residual_retention:false}});
  for(const input of [ctx({}),ctx({submission_rejected:true},{scribe_request_id:'acknowledged'})])expect(await processScribeCleanupJob(input)).toMatchObject({state:'waiting',errorCode:'scribe_retention_unconfirmed'});
  expect(fetch).not.toHaveBeenCalled();
 });
 it('reconstructs the webhook channel arrays chronologically and preserves our authenticated identity',()=>{
  const payload={transcription_id:'provider-transcript',transcripts:[
   {channel_index:0,language_code:'slk',words:[{type:'word',text:'Pomoc.',start:3,end:4,speaker_id:'speaker_0',role:'operator'}]},
   {channel_index:1,language_code:'slo',words:[{type:'word',text:'Dobrý',start:1,end:1.3,speaker_id:'speaker_0'},{type:'spacing',text:' ',start:1.3,end:1.3},{type:'word',text:'deň.',start:1.4,end:1.8,speaker_id:'speaker_0'}]},
  ]};
  const normalized=normalizeScribeTranscription(payload);
  expect(normalized).toMatchObject({text:'Dobrý deň. Pomoc.',language_code:'sk',transcription_id:'provider-transcript'});
  const spans=parseScribeSpans(payload,source,'t',at);
  expect(spans).toHaveLength(2);expect(spans[0]).toMatchObject({text:'Dobrý deň.',role:'operator',operatorId:'operator-1',speakerLabel:'channel_1'});
  expect(spans[1]).toMatchObject({text:'Pomoc.',role:'customer',operatorId:null,speakerLabel:'channel_0'});
  expect(parseScribeSpans(payload,{...source,participant_manifest:{}},'t',at)).toHaveLength(2);
 });
 it('does not pick an arbitrary language from a multilingual or silent pair',()=>{
  const word={type:'word',text:'Hello',start:0,end:1};
  expect(normalizeScribeTranscription({transcripts:[{channel_index:0,language_code:'slk',words:[word]},{channel_index:1,language_code:'eng',words:[word]}]}).language_code).toBe('mul');
  expect(normalizeScribeTranscription({transcripts:[{channel_index:0,words:[]},{channel_index:1,words:[]}]}).language_code).toBe('und');
 });
 it('rejects ambiguous, missing and contradictory channel data from separate output',()=>{
  const c={channel_index:0,language_code:'slk',words:[{type:'word',text:'Text',start:0,end:1}]};
  for(const payload of [{transcripts:[]},{transcripts:[c]},{transcripts:[c,c]},{transcripts:[c,{...c,channel_index:2}]},{words:[],transcripts:[c,{...c,channel_index:1}]},{transcripts:[c,{...c,channel_index:1,words:[{...c.words[0],channel_index:0}]}]}])expect(()=>normalizeScribeTranscription(payload)).toThrow();
  for(const invalid of [{start:-1},{end:Infinity},{start:2,end:1},{text:123}])expect(()=>normalizeScribeTranscription({transcripts:[{...c,words:[{...c.words[0],...invalid}]},{...c,channel_index:1}]})).toThrow('scribe_word_invalid');
 });
 it('maps provider language codes to dashboard filters without inventing an unsupported language',()=>{
  for(const [provider,filter] of [['slk','sk'],['slo','sk'],['ces','cs'],['cze','cs'],['eng','en'],['deu','de'],['ger','de'],['SK','sk'],['fra','fra']])expect(normalizeScribeLanguage(provider)).toBe(filter);
  for(const invalid of [null,undefined,'','unknown-language','sk<script>',123])expect(normalizeScribeLanguage(invalid)).toBe('und');
 });
 it('uses exact authenticated channel interval and global call offset, with no role outside that interval',()=>{
  const spans=parseScribeSpans(result,source,'transcript','2026-09-06T09:59:50.000Z');
  expect(spans).toHaveLength(2);expect(spans[0]).toMatchObject({text:'Dobrý deň.',startSeconds:11,endSeconds:11.8,operatorId:'operator-1',identityVerified:true,role:'operator'});
  expect(spans[1]).toMatchObject({role:'unknown',operatorId:null,identityVerified:false});
 });
 it('never treats first diarized speaker or claimed provider role as identity proof',()=>{
  const untrusted={...source,participant_manifest:{coverage:'unverified',intervals:[]}};
  expect(parseScribeSpans({...result,role:'operator'},untrusted,'t',at).every(s=>s.operatorId===null&&!s.identityVerified)).toBe(true);
 });
 it('does not attribute known channels when measured timing is unverified and bounds ASR words by actual audio duration',()=>{
  const unverified={...source,participant_manifest:{...(source.participant_manifest as object),timingVerified:false}};
  expect(parseScribeSpans(result,unverified,'t',at).every(s=>!s.identityVerified&&s.operatorId===null)).toBe(true);
  const truncated={...source,participant_manifest:{...(source.participant_manifest as object),timingVerified:false,audioDurationSeconds:0.04}};
  expect(()=>parseScribeSpans(result,truncated,'t',at)).toThrow('scribe_word_invalid');
 });
 it('refuses paid ASR when measured audio exceeds the cap even if provider duration is small',async()=>{
  for(const name of ['ELEVENLABS_API_KEY','ELEVENLABS_SCRIBE_WEBHOOK_ID','ELEVENLABS_SCRIBE_WEBHOOK_SECRET'])vi.stubEnv(name,'synthetic');vi.stubEnv('TRANSCRIPTS_ENABLED','true');
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const ctx={job:{provider_ids:{},checkpoint:{}},recording:{...source,status:'available',storage_path:'private.wav',duration_seconds:20,participant_manifest:{audioDurationSeconds:1900}},policy:{transcription_enabled:true,max_segment_seconds:1800}} as unknown as RecordingJobContext;
  await expect(processRecordingAsrJob(ctx)).rejects.toThrow('asr_source_invalid');expect(fetch).not.toHaveBeenCalled();
 });
 it('requires exact channel proof, and rejects invented timestamps beyond the audio',()=>{
  expect(verifiedMultiChannel({coverage:'verified',identitySource:'authenticated_leg_binding',intervals:[{role:'operator',channel:null,verified:true}]})).toBe(false);
  expect(()=>parseScribeSpans({words:[{type:'word',text:'x',start:200,end:201}]},source,'t',at)).toThrow('scribe_word_invalid');
 });
});
