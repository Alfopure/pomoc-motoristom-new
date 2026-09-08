import { afterEach, expect, it, vi } from 'vitest';
import { createTelephonyHarness, LINES, NUMBERS, PROFILES } from '@/test/telephony-harness';
import type { FakeRow } from '@/test/fake-supabase';
import { runSessionEvent } from './session-runner';
import { runPendingEffectRecovery } from './cron-jobs';
import { readContactHistory, contactOperationIntent } from './contact-proof';
import { readPendingEffects } from './state/continuation';
import type { SessionRow, TelephonyEvent } from './state/types';

afterEach(()=>vi.unstubAllEnvs());
it('CB-08/11: delayed terminal bridge proof survives a failed fulfillment and one cron cycle with creation disabled',async()=>{
  const h=createTelephonyHarness();
  const start=new Date(h.now().getTime()-60_000).toISOString(), contact=new Date(h.now().getTime()-30_000).toISOString(), end=new Date(h.now().getTime()-10_000).toISOString();
  const [session]=h.db.insert('motorist_call_sessions',{organization_id:h.deps.organizationId,direction:'inbound',state:'ended',caller_number:NUMBERS.customer,called_number:NUMBERS.allianz,line_id:LINES.allianz,started_at:start,ended_at:end,answered_at:contact,answered_by_profile_id:PROFILES.o1,metadata:{effects_v1:{generation:1}}});
  const legs=h.db.insert('motorist_call_legs',[
    {organization_id:h.deps.organizationId,session_id:session.id,role:'customer',telnyx_call_control_id:'customer-cc',created_at:start,answered_at:contact,ended_at:end,state:'ended'},
    {organization_id:h.deps.organizationId,session_id:session.id,role:'operator',profile_id:PROFILES.o1,telnyx_call_control_id:'operator-cc',created_at:start,answered_at:contact,ended_at:end,state:'ended'},
  ]);
  h.db.update('motorist_call_sessions',{metadata:{effects_v1:{generation:1},callback_contact:{version:1,proofs:[],operations:[{id:'original-bridge',sourceControlId:'customer-cc',scope:{organizationId:h.deps.organizationId,caseId:null,lineId:LINES.allianz,customerNumber:NUMBERS.customer,startedAt:start,callbackRequestId:null},topology:'bridge',startedAt:start,endedAt:end,customerLegId:legs[0].id,operatorLegId:legs[1].id,operatorProfileId:PROFILES.o1,customerControlId:'customer-cc',operatorControlId:'operator-cc',conferenceId:null,conferenceName:null,observations:{}}]}}},r=>r.id===session.id);
  const [request]=h.db.insert('motorist_callback_requests',{organization_id:h.deps.organizationId,caller_number:NUMBERS.customer,status:'open',created_at:new Date(Date.parse(start)-60_000).toISOString()});
  // SQL atomicity is separately tested by callback-contract.py. This fake only
  // provides the exact RPC boundary so real runner/checkpoint/cron code executes.
  h.db.registerRpc('motorist_stage_transition_v1',args=>{
    const row=h.db.find('motorist_call_sessions',r=>r.id===session.id)!;
    if(row.version!==args.p_expected_version) return {applied:false};
    const main=args.p_main as {sessionPatch:FakeRow;entry:FakeRow};
    const entries=(row.pending_effects as {entries?:FakeRow[]}|undefined)?.entries??[];
    h.db.update('motorist_call_sessions',{...main.sessionPatch,version:Number(row.version)+1,pending_effects:{version:1,entries:[...entries,main.entry]},effects_next_attempt_at:h.now().toISOString()},r=>r.id===session.id);
    return {applied:true,session:h.db.find('motorist_call_sessions',r=>r.id===session.id)};
  });
  h.db.registerRpc('motorist_reconcile_callback_contact_v1',()=>{
    const row=h.db.find('motorist_callback_requests',r=>r.id===request.id)!;
    if(row.status==='done') return [];
    h.db.update('motorist_callback_requests',{status:'done'},r=>r.id===request.id);
    h.db.insert('motorist_audit_log',{organization_id:h.deps.organizationId,entity_id:request.id,action:'telephony.callback.contact_done'});
    return [request.id];
  });
  const event=(id:string,cc:string):TelephonyEvent=>({clientState:{sid:String(session.id),role:cc==='customer-cc'?'customer':'operator',intent:contactOperationIntent('original-bridge')},kind:'telnyx',type:'call.bridged',id,callControlId:cc,occurredAt:contact,payload:{},conferenceId:null} as TelephonyEvent);
  await runSessionEvent(h.deps,String(session.id),event('operator-proof','operator-cc'));
  h.db.failNext('motorist_reconcile_callback_contact_v1','rpc','injected request/audit transaction failure');
  await expect(runSessionEvent(h.deps,String(session.id),event('customer-proof','customer-cc'))).rejects.toThrow('reconciliation failed');
  const pending=h.session(String(session.id)) as unknown as SessionRow;
  expect(pending.state).toBe('ended');expect(readContactHistory(pending).proofs).toHaveLength(1);expect(readPendingEffects(pending).entries).toHaveLength(1);
  expect(h.db.find('motorist_callback_requests',r=>r.id===request.id)?.status).toBe('open');
  vi.stubEnv('TELEPHONY_STABILITY_V1_ENABLED','false');
  h.advance(5*60_000);
  expect(await runPendingEffectRecovery(h.deps)).toMatchObject({status:'ok',detail:{checked:1}});
  expect(h.db.find('motorist_callback_requests',r=>r.id===request.id)?.status).toBe('done');
  const completed=h.session(String(session.id)) as unknown as SessionRow;
  expect(completed.state).toBe('ended');expect(readContactHistory(completed).proofs).toHaveLength(1);expect(readPendingEffects(completed).entries).toEqual([]);
  expect(h.rows('motorist_audit_log').filter(r=>r.entity_id===request.id)).toHaveLength(1);
  expect(h.telnyx.calls.filter(call=>['dial','bridge','conferenceCreate','conferenceJoin','recordingStart'].includes(call.method))).toEqual([]);
  expect(await runPendingEffectRecovery(h.deps)).toMatchObject({status:'ok',detail:{checked:0}});
});
