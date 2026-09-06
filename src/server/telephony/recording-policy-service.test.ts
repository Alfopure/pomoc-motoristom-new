import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '@/test/fake-supabase';
import type { MotoristActor } from '@/server/api-auth';
import { DEFAULT_RECORDING_POLICY, parseRecordingPolicy, saveRecordingPolicy } from './recording-policy-service';
const actor:MotoristActor={organizationId:'org',profileId:'manager',userId:'user',role:'manager',displayName:'Synthetic Manager'};
afterEach(()=>vi.unstubAllEnvs());
describe('recording policy approval boundary',()=>{
 it('rejects impossible feature dependencies and preserves conservative cost limits',()=>{
  for(const patch of [{transcriptionEnabled:true},{analysisEnabled:true},{qualityEnabled:true},{maxRecordingsPerHour:11},{maxRecordingBytes:134217729},{maxSegmentSeconds:1801}])expect(()=>parseRecordingPolicy({...DEFAULT_RECORDING_POLICY,...patch})).toThrow();
 });
 it('cannot forge approval through the policy body and validates legal contact URLs before enabling',()=>{
  expect(parseRecordingPolicy({...DEFAULT_RECORDING_POLICY,approvedAt:'2026-09-06T10:00:00Z'}).approvedAt).toBeNull();
  for(const privacyNoticeUrl of ['http://example.test/privacy','https://user:pass@example.test/privacy','https://example.test/#privacy'])expect(()=>parseRecordingPolicy({...DEFAULT_RECORDING_POLICY,privacyNoticeUrl})).toThrow();
  expect(()=>parseRecordingPolicy({...DEFAULT_RECORDING_POLICY,recordingEnabled:true})).toThrow();
 });
 it('requires privileged role and passes expected revision to the atomic policy RPC',async()=>{
  const fake=createFakeSupabase();const handler=vi.fn().mockReturnValue(1);fake.db.registerRpc('motorist_recording_policy_save',handler);
  const body={policy:{...DEFAULT_RECORDING_POLICY,revision:7,approvedAt:'forged'},approvePolicy:false};
  await expect(saveRecordingPolicy(fake.admin,{...actor,role:'dispatcher'},body)).rejects.toMatchObject({status:403});expect(handler).not.toHaveBeenCalled();
  await saveRecordingPolicy(fake.admin,actor,body);expect(handler.mock.calls[0][0]).toMatchObject({p_organization_id:'org',p_actor_id:'manager',p_expected_revision:7,p_approved:false,p_policy:{approvedAt:null}});
 });
 it('maps concurrent policy changes to a conflict and never silently retries approval',async()=>{
  const fake=createFakeSupabase();fake.db.failNext('motorist_recording_policy_save','rpc',{code:'40001',message:'conflict',hint:null,details:null});
  await expect(saveRecordingPolicy(fake.admin,actor,{policy:{...DEFAULT_RECORDING_POLICY,revision:3},approvePolicy:true})).rejects.toMatchObject({status:409,code:'stale_recording_policy'});
  expect(fake.db.log.filter(x=>x.kind==='rpc')).toHaveLength(1);
 });
 it('cannot enable recording from a browser request while server capability proof is disabled',async()=>{
  vi.stubEnv('RECORDING_PROCESSING_ENABLED','false');const fake=createFakeSupabase();
  await expect(saveRecordingPolicy(fake.admin,actor,{policy:{...DEFAULT_RECORDING_POLICY,recordingEnabled:true,controllerName:'Synthetic Controller',contactEmail:'privacy@example.test',privacyNoticeUrl:'https://example.test/privacy',serviceLegalBasis:'Documented synthetic purpose'},approvePolicy:true})).rejects.toMatchObject({status:409,code:'recording_not_ready'});
  expect(fake.db.log.some(x=>x.kind==='rpc')).toBe(false);
 });
});
