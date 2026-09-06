import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture=vi.hoisted(()=>({from:vi.fn(),analyze:vi.fn(),scribe:vi.fn()}));
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>({from:fixture.from})}));
vi.mock('@/lib/integrations/ai/call-analysis',()=>({analyzeCallTranscript:fixture.analyze}));
vi.mock('@/lib/integrations/asr/scribe-client',()=>({transcribeWithScribe:fixture.scribe}));
import { processTranscripts } from './transcripts-process';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('retired synchronous transcript pipeline',()=>{
 it('cannot bypass master switch via old integration feature flags or API key',async()=>{
  vi.stubEnv('TRANSCRIPTS_ENABLED','true');vi.stubEnv('AI_TRANSCRIPT_ENABLED','true');vi.stubEnv('RECORDING_PROCESSING_ENABLED','false');
  expect(await processTranscripts()).toMatchObject({status:'disabled',processed:0,aiProcessed:0});
  expect(fixture.from).not.toHaveBeenCalled();expect(fixture.analyze).not.toHaveBeenCalled();expect(fixture.scribe).not.toHaveBeenCalled();
 });
 it('an enabled compatibility route enqueues an idempotent ASR job, never paid work',async()=>{
  vi.stubEnv('TRANSCRIPTS_ENABLED','true');vi.stubEnv('RECORDING_PROCESSING_ENABLED','true');const upsert=vi.fn().mockResolvedValue({error:null});
  fixture.from.mockImplementation((table:string)=>{
   const result=table==='motorist_organizations'?{id:'org'}:table==='motorist_call_recording_policies'?{approved_at:'now',recording_enabled:true,transcription_enabled:true}:[{id:'r',call_id:'c',source_revision:1}];
   const q={select:()=>q,eq:()=>q,is:()=>q,order:()=>q,limit:()=>q,maybeSingle:()=>Promise.resolve({data:result,error:null}),upsert,then:(resolve:(x:unknown)=>unknown)=>Promise.resolve({data:result,error:null}).then(resolve)};return q;
  });
  expect(await processTranscripts()).toMatchObject({status:'ok',processed:1,aiProcessed:0});
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({kind:'asr',dedupe_key:'asr:r:1'}),{onConflict:'organization_id,dedupe_key',ignoreDuplicates:true});
  expect(fixture.analyze).not.toHaveBeenCalled();expect(fixture.scribe).not.toHaveBeenCalled();
 });
});
