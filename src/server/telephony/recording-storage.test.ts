import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newRecordingHash, updateRecordingHash, finishRecordingHash } from './recording-storage-sha256';
import { publicRecordingAddress, validateRecordingSourceUrl } from './recording-storage';
describe('resumable recording integrity',()=>{
 it.each([0,1,55,56,63,64,65,127,128,129,4097,6*1024*1024+17])('matches native SHA-256 after serialized restart (%i bytes)',size=>{
  const input=randomBytes(size);let state=newRecordingHash();const split=Math.floor(size/3);
  state=updateRecordingHash(state,input.subarray(0,split));state=JSON.parse(JSON.stringify(state));state=updateRecordingHash(state,input.subarray(split));
  expect(finishRecordingHash(state)).toBe(createHash('sha256').update(input).digest('hex'));
 });
 it.each(['127.0.0.1','10.1.2.3','192.168.1.1','172.31.1.1','169.254.169.254','100.100.1.1','0.0.0.0','224.0.0.1','198.18.0.1','192.0.2.1','203.0.113.1','::1','fc00::1','::ffff:127.0.0.1','2002:7f00:1::','2001:db8::1'])('rejects non-public DNS address %s',address=>expect(publicRecordingAddress(address)).toBe(false));
 it.each(['8.8.8.8','1.1.1.1','2606:4700::1111','2001:4860:4860::8888'])('allows public DNS address %s',address=>expect(publicRecordingAddress(address)).toBe(true));
 it.each(['http://recordings.telnyx.com/a','https://recordings.telnyx.com.evil.test/a','https://user:pass@recordings.telnyx.com/a','https://recordings.telnyx.com:444/a','https://127.0.0.1/a','https://recordings.telnyx.com/a#secret'])('rejects unsafe source URL %s',url=>expect(()=>validateRecordingSourceUrl(url,['recordings.telnyx.com'])).toThrow());
 it('accepts an exact allowlisted HTTPS host',()=>expect(validateRecordingSourceUrl('https://recordings.telnyx.com/a?signed=yes',['recordings.telnyx.com']).hostname).toBe('recordings.telnyx.com'));
});

import { afterEach, vi } from 'vitest';
import { processRecordingImport, deleteRecordingStorage } from './recording-storage';
import type { RecordingJobContext } from './recording-jobs';
import type { Json } from '@/lib/supabase/database.types';
import { pcmWav } from '@/test/recording-wav-fixture';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function importContext() {
 vi.stubEnv('SUPABASE_URL','https://isolated.supabase.co');vi.stubEnv('SUPABASE_PUBLISHABLE_KEY','synthetic-public-key');vi.stubEnv('SUPABASE_SECRET_KEY','synthetic-service-key');vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://isolated.supabase.co');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-service-key');
 const ctx={organizationId:'org',job:{id:'job',call_id:'call',lease_token:'lease',lease_epoch:1,checkpoint:{},provider_ids:{}},recording:{id:'recording',source_revision:1,provider_recording_id:'provider',storage_path:null},policy:{max_recording_bytes:134217728},signal:AbortSignal.timeout(2000),deadline:Date.now()+2000,admin:{rpc:vi.fn().mockReturnValue({abortSignal:()=>Promise.resolve({data:true,error:null})})}} as unknown as RecordingJobContext;
 ctx.checkpoint=vi.fn(async(patch)=>{ctx.job.checkpoint={...(ctx.job.checkpoint as object),...(patch as object)};return true;});return ctx;
}
describe('resumable import protocol',()=>{
 it('checkpoints before PATCH and recovers a lost final acknowledgement by HEAD without redownloading or resubmitting',async()=>{
  const ctx=importContext();const bytes=pcmWav(4,1,8000,16);
  const download=vi.fn().mockResolvedValue({bytes,total:bytes.length,etag:'"stable"',mime:'audio/wav'}),refresh=vi.fn().mockResolvedValue('https://recordings.telnyx.com/a');
  const fetch=vi.fn().mockImplementation(async(_url:string,opts:RequestInit)=>{
   if(opts.method==='POST'){expect(ctx.job.checkpoint).toMatchObject({audio_integrity:{source:'riff_pcm_v1',totalBytes:48,audioDurationSeconds:0.00025}});return new Response('',{status:201,headers:{location:'https://isolated.supabase.co/storage/v1/upload/resumable/upload1'}});}
   if(opts.method==='PATCH'){expect(ctx.job.checkpoint).toMatchObject({pending_chunk:{end:48}});throw new Error('lost connection after provider accepted PATCH');}
   if(opts.method==='HEAD')return new Response(null,{status:200,headers:{'upload-offset':'48'}});
   throw new Error('unexpected');
  });vi.stubGlobal('fetch',fetch);
  await expect(processRecordingImport(ctx,{downloadChunk:download,refreshSource:refresh})).rejects.toThrow('storage_request_failed');
  expect(await processRecordingImport(ctx,{downloadChunk:download,refreshSource:refresh})).toEqual({state:'complete'});
  expect(download).toHaveBeenCalledTimes(1);expect(fetch.mock.calls.filter(c=>c[1].method==='PATCH')).toHaveLength(1);
  expect(ctx.admin.rpc).toHaveBeenCalledWith('motorist_recording_complete_import',expect.objectContaining({p_bytes:48,p_sha256:createHash('sha256').update(bytes).digest('hex')}));
 });
 it('rejects a malformed RIFF data size before creating or patching storage',async()=>{
  const ctx=importContext(),bytes=pcmWav(19200);bytes.writeUInt32LE(19204,40);const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(processRecordingImport(ctx,{refreshSource:vi.fn().mockResolvedValue('https://recordings.telnyx.com/a'),downloadChunk:vi.fn().mockResolvedValue({bytes,total:bytes.length,etag:'"stable"',mime:'audio/wav'})})).rejects.toThrow('wav_structure_invalid');expect(fetch).not.toHaveBeenCalled();
 });
 it('halts unknown upload creation and preserves explicit residual retention instead of creating another upload',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_create_started_at:'2026-09-06'};const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  expect(await processRecordingImport(ctx)).toMatchObject({state:'submission_unknown',checkpoint:{residual_retention:true}});expect(fetch).not.toHaveBeenCalled();
 });
 it('deletes canonical orphan paths even when import publication never stored storage_path',async()=>{
  const ctx=importContext();const fetch=vi.fn().mockResolvedValue(new Response('{}'));vi.stubGlobal('fetch',fetch);
  await deleteRecordingStorage(ctx);expect(JSON.parse(fetch.mock.calls[0][1].body).prefixes).toEqual(['org/call/recording/r1.wav','org/call/recording/r1.mp3']);
 });
 it('removes a completed canonical object before Supabase permits TUS cleanup, then checks the canonical paths again',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://isolated.supabase.co/storage/v1/upload/resumable/upload1',offset:48,total:48};ctx.recording!.storage_path='org/call/recording/r1.wav';
  let objectExists=true;const operations:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
   if(String(url).includes('/upload/resumable/')){operations.push('terminate');return new Response(objectExists?'The resource already exists':'The file for this url was not found',{status:objectExists?409:404});}
   operations.push('remove-object');objectExists=false;return new Response('[]');
  }));
  await expect(deleteRecordingStorage(ctx)).resolves.toBeUndefined();expect(objectExists).toBe(false);expect(operations).toEqual(['remove-object','terminate','remove-object']);
 });
 it('terminates an incomplete upload and removes a late PATCH result after termination acknowledgement',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://isolated.supabase.co/storage/v1/upload/resumable/upload1',offset:24,total:48};
  let objectExists=false,terminated=false;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
   if(String(url).includes('/upload/resumable/')){objectExists=true;terminated=true;return new Response(null,{status:204});}
   objectExists=false;return new Response('[]');
  }));
  await expect(deleteRecordingStorage(ctx)).resolves.toBeUndefined();expect(terminated).toBe(true);expect(objectExists).toBe(false);
 });
 it.each([401,403,409,500])('removes canonical data but preserves an unexpected TUS %i as retryable cleanup',async(status)=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://isolated.supabase.co/storage/v1/upload/resumable/upload1'};
  let objectExists=true,retry=false;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
   if(String(url).includes('/upload/resumable/'))return new Response(null,{status:retry?204:status});
   objectExists=false;return new Response('[]');
  }));
  await expect(deleteRecordingStorage(ctx)).rejects.toMatchObject({code:'upload_cleanup_failed',retryable:true});expect(objectExists).toBe(false);expect(ctx.job.checkpoint).toHaveProperty('upload_url');
  retry=true;await expect(deleteRecordingStorage(ctx)).resolves.toBeUndefined();
 });
 it('does not discard the TUS handle when canonical deletion fails',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://isolated.supabase.co/storage/v1/upload/resumable/upload1'};const fetch=vi.fn().mockResolvedValue(new Response(null,{status:500}));vi.stubGlobal('fetch',fetch);
  await expect(deleteRecordingStorage(ctx)).rejects.toMatchObject({code:'storage_delete_failed',retryable:true});expect(fetch).toHaveBeenCalledTimes(1);expect(String(fetch.mock.calls[0][0])).toContain('/object/motorist-call-recordings');
 });
 it('preserves uncertainty when TUS termination loses its network acknowledgement after canonical deletion',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://isolated.supabase.co/storage/v1/upload/resumable/upload1'};let objectRemoved=false;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(String(url).includes('/upload/resumable/'))throw new Error('ack lost');objectRemoved=true;return new Response('[]');}));
  await expect(deleteRecordingStorage(ctx)).rejects.toMatchObject({code:'storage_request_failed',retryable:true});expect(objectRemoved).toBe(true);expect(ctx.job.checkpoint).toHaveProperty('upload_url');
 });
 it('keeps cleanup retryable if the final canonical sweep fails after acknowledged TUS termination',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://isolated.supabase.co/storage/v1/upload/resumable/upload1'};let removed=0;
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(String(url).includes('/upload/resumable/'))return new Response(null,{status:204});removed++;return new Response(null,{status:removed===2?500:200});}));
  await expect(deleteRecordingStorage(ctx)).rejects.toMatchObject({code:'storage_delete_failed',retryable:true});expect(removed).toBe(2);expect(ctx.job.checkpoint).toHaveProperty('upload_url');
  await expect(deleteRecordingStorage(ctx)).resolves.toBeUndefined();expect(removed).toBe(4);
 });
 it('validates foreign TUS cleanup URLs before any destructive canonical request',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://evil.example/storage/v1/upload/resumable/id'};const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(deleteRecordingStorage(ctx)).rejects.toThrow('storage_upload_url_invalid');expect(fetch).not.toHaveBeenCalled();
 });
 it('refuses a checkpoint upload URL on another origin before sending service credentials',async()=>{
  const ctx=importContext();ctx.job.checkpoint={upload_url:'https://evil.example/storage/v1/upload/resumable/id'} as Json;const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(processRecordingImport(ctx)).rejects.toThrow('storage_upload_url_invalid');expect(fetch).not.toHaveBeenCalled();
 });
});
