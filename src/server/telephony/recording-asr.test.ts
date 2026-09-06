import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseScribeSpans, verifiedMultiChannel, processRecordingAsrJob } from './recording-asr';
import type { RecordingJobContext, RecordingRow } from './recording-jobs';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
const at='2026-09-06T10:00:00.000Z';
const source={id:'recording',started_at:at,ended_at:'2026-09-06T10:00:20.000Z',duration_seconds:20,participant_manifest:{version:1,timingVerified:true,audioDurationSeconds:20,audioFormat:{channels:2},channelMappingVerified:true,identitySource:'authenticated_leg_binding',coverage:'verified',intervals:[{profileId:null,role:'customer',channel:0,verified:true,audibleToCustomer:true,startedAt:at,endedAt:'2026-09-06T10:00:20.000Z'},{profileId:'operator-1',role:'operator',channel:1,verified:true,audibleToCustomer:true,startedAt:at,endedAt:'2026-09-06T10:00:10.000Z'}]}} as unknown as RecordingRow;
const result={words:[{type:'word',text:'Dobrý',start:1,end:1.3,channel_index:1,speaker_id:'speaker_0'},{type:'word',text:'deň.',start:1.4,end:1.8,channel_index:1,speaker_id:'speaker_0'},{type:'word',text:'Ďakujem.',start:11,end:12,channel_index:1,speaker_id:'speaker_0'}]};
describe('ASR identity evidence',()=>{
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
