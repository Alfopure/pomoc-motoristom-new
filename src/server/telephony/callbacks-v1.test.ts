import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelephonyHarness, LINES, NUMBERS, PROFILES } from '@/test/telephony-harness';
import { callBackRequest, loadCallbackQueue, resolveCallbackRequest } from './callbacks';
import { createRateLimiter, type CallActor } from './call-actions';
import { reconcileCallbackContact } from './callback-reconciliation';
import type { ContactProof } from './contact-proof';

const actor:CallActor={profileId:PROFILES.o1,role:'dispatcher'};
afterEach(()=>vi.unstubAllEnvs());
function setup() {
  vi.stubEnv('TELEPHONY_STABILITY_V1_ENABLED','true');
  const h=createTelephonyHarness();
  const [r]=h.db.insert('motorist_callback_requests',{organization_id:h.deps.organizationId,caller_number:NUMBERS.customer,source:'missed',status:'open',line_id:LINES.allianz,created_at:'2026-09-07T09:00:00Z'});
  const deps={...h.deps,rateLimiter:createRateLimiter({now:()=>h.now().getTime()})};
  return {h,id:String(r.id),deps};
}

describe('callback v1 service boundaries',()=>{
  it('CB-07: exact link and session identity exist before the first provider dial',async()=>{
    const {h,id,deps}=setup();
    h.db.registerRpc('motorist_link_callback_outbound_v1',args=>{
      expect(h.telnyx.of('dial')).toHaveLength(0);
      const session=h.db.find('motorist_call_sessions',row=>row.id===args.p_session_id);
      expect(session?.metadata).toMatchObject({callbackRequestId:id});
      h.db.update('motorist_callback_requests',{metadata:{newer_metadata:'preserved',callback_call:{session_id:args.p_session_id,by:args.p_actor_id,at:h.now().toISOString()}}},row=>row.id===id);
      return true;
    });
    const result=await callBackRequest(deps,actor,id);
    expect(result.linked).toBe(true);
    expect(h.telnyx.of('dial')).toHaveLength(1);
    expect(h.db.find('motorist_callback_requests',row=>row.id===id)?.metadata).toMatchObject({newer_metadata:'preserved'});
  });
  it.each([false,'failure'])('CB-07/09: no dial when pre-dial linking rejects/fails (%s)',async(result)=>{
    const {h,id,deps}=setup();
    h.db.registerRpc('motorist_link_callback_outbound_v1',()=>{if(result==='failure') throw new Error('injected write error'); return result;});
    await expect(callBackRequest(deps,actor,id)).rejects.toBeTruthy();
    expect(h.telnyx.of('dial')).toHaveLength(0);
  });
  it('CB-11: manual done uses atomic RPC; failure cannot fall through to broad task close',async()=>{
    const {h,id,deps}=setup();
    h.db.failNext('motorist_resolve_callback_v1','rpc','injected transaction failure');
    await expect(resolveCallbackRequest(deps,actor,id,{status:'done'})).rejects.toBeTruthy();
    expect(h.db.find('motorist_callback_requests',row=>row.id===id)?.status).toBe('open');
    expect(h.db.log.filter(entry=>entry.table==='motorist_case_tasks'&&entry.operation==='update')).toEqual([]);
  });
  it('CB-11/MG-03: historical reconciliation remains callable with creation gate off and propagates failure',async()=>{
    const {h,deps}=setup();
    vi.stubEnv('TELEPHONY_STABILITY_V1_ENABLED','false');
    const session={id:'session',organization_id:deps.organizationId,state:'ended'} as Parameters<typeof reconcileCallbackContact>[1];
    const proof={sessionId:'session'} as ContactProof;
    h.db.failNext('motorist_reconcile_callback_contact_v1','rpc','injected audit failure');
    await expect(reconcileCallbackContact(deps,session,proof)).rejects.toThrow('reconciliation failed');
    h.db.registerRpc('motorist_reconcile_callback_contact_v1',()=>['request']);
    await expect(reconcileCallbackContact(deps,session,proof)).resolves.toEqual(['request']);
    expect(h.telnyx.calls).toEqual([]);
  });
  it('CB-12: queue stays unified while scheduling follows server rollout',async()=>{
    const {deps}=setup();
    expect((await loadCallbackQueue(deps,actor)).unifiedRequests).toBe(true);
    vi.stubEnv('TELEPHONY_STABILITY_V1_ENABLED','false');
    expect(await loadCallbackQueue(deps,actor)).toMatchObject({unifiedRequests:true,schedulingEnabled:false});
  });
});
