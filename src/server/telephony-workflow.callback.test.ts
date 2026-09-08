import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import {createFakeSupabase} from '@/test/fake-supabase';
let fake:ReturnType<typeof createFakeSupabase>;
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>fake.admin}));
vi.mock('@/lib/supabase/env',()=>({getSupabaseServiceEnv:()=>({url:'https://copy.test',publicKey:'public',serviceKey:'service'})}));
vi.mock('@/data/dispatch-repository',()=>({loadDispatchData:async()=>({marker:'refreshed'})}));
import {setCallOutcome} from './telephony-workflow';
const org='00000000-0000-4000-8000-000000000001',profile='00000000-0000-4000-8000-000000000101',call='00000000-0000-4000-8000-000000000901',action='00000000-0000-4000-8000-000000000201';
beforeEach(()=>{
  fake=createFakeSupabase();vi.stubEnv('TELEPHONY_STABILITY_V1_ENABLED','true');
  fake.db.seed('motorist_organizations',[{id:org,slug:'pomoc-motoristom',active:true}]);
  fake.db.seed('motorist_profiles',[{id:profile,organization_id:org,active:true}]);
  fake.db.seed('motorist_calls',[{id:call,organization_id:org,provider:'telnyx',direction:'inbound',caller_number:'+421900123456',case_id:null,raw_latest_payload:{smsMarker:'preserved'}}]);
});
afterEach(()=>vi.unstubAllEnvs());
it('CB-14: authenticated scheduling without case invokes existing request RPC, carries action id, and never creates task-only debt',async()=>{
  fake.db.registerRpc('motorist_schedule_callback_v1',args=>{expect(args).toMatchObject({p_organization_id:org,p_call_id:call,p_actor_id:profile,p_action_id:action});return {id:'request'};});
  await expect(setCallOutcome(call,{outcome:'callback',callbackMinutes:30,callbackActionId:action},{profileId:profile,organizationId:org})).resolves.toEqual({marker:'refreshed'});
  expect(fake.db.rows('motorist_case_tasks')).toEqual([]);
  expect(fake.db.find('motorist_calls',r=>r.id===call)?.raw_latest_payload).toMatchObject({smsMarker:'preserved',outcome:'callback'});
});
it('CB-14: missing action identity or unauthenticated actor cannot create new callback obligations',async()=>{
  await expect(setCallOutcome(call,{outcome:'callback'},{profileId:profile,organizationId:org})).rejects.toMatchObject({status:400});
  await expect(setCallOutcome(call,{outcome:'callback',callbackActionId:action})).rejects.toMatchObject({status:403});
  expect(fake.db.rows('motorist_call_events')).toEqual([]);
});
it('CB-14: scheduling transaction failure is surfaced before the historical outcome changes',async()=>{
  fake.db.failNext('motorist_schedule_callback_v1','rpc','injected write failure');
  await expect(setCallOutcome(call,{outcome:'callback',callbackActionId:action},{profileId:profile,organizationId:org})).rejects.toThrow('injected write failure');
  expect(fake.db.find('motorist_calls',r=>r.id===call)?.raw_latest_payload).toEqual({smsMarker:'preserved'});
});
