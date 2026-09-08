import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultAnnouncementConfig} from '@/lib/telephony/announcements';
import {createTelephonyHarness,LINES,NUMBERS,PROFILES,type TelephonyHarness} from '@/test/telephony-harness';
import {createCallbackObligation} from './callback-reconciliation';
import {runPendingEffectRecovery} from './cron-jobs';
import {runSessionEvent} from './session-runner';
import type {CallbackPlan,SessionRow} from './state/types';
import {readMeta,toJson} from './state/types';

beforeEach(()=>{
  vi.stubEnv('TELEPHONY_STABILITY_V1_ENABLED','true');
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Live network forbidden in callback IVR QA');}));
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
const lastGather=(h:TelephonyHarness)=>h.telnyx.calls.filter(c=>['gatherUsingAudio','gatherUsingSpeak','gather'].includes(c.method)).at(-1)!;
const complete=(h:TelephonyHarness,cc:string,state:unknown,digits='')=>h.legEvent(cc,'call.gather.ended',{digits,status:digits?'valid':'timeout',client_state:state});
const confirmations=(h:TelephonyHarness)=>h.telnyx.of('playbackStart').filter(c=>String(c.params.audioUrl).includes('callback-confirmed')||String(c.params.audioUrl).includes('custom-confirmation'));

/** RPC workflow boundary only; the exact migration is tested in local PostgreSQL. */
function registerCallbackRpc(h:TelephonyHarness) {
  h.db.registerRpc('motorist_create_callback_obligation_v1',async args=>{
    const session=h.session(String(args.p_session_id));
    const plan=args.p_plan as CallbackPlan;
    const existing=h.rows('motorist_callback_requests').find(row=>row.session_id===session.id);
    if(existing){
      const updated=await h.admin.from('motorist_callback_requests').update({metadata:toJson({...existing.metadata as object,...(plan.request?{request:plan.request}:{})})}).eq('id',String(existing.id)).select('*').single();
      if(updated.error)throw new Error(updated.error.message);return updated.data;
    }
    const inserted=await h.admin.from('motorist_callback_requests').insert({organization_id:String(args.p_organization_id),session_id:String(session.id),caller_number:plan.callerNumber,source:plan.source,status:'open',created_at:String(args.p_now),metadata:toJson({callback_obligation_version:1,...(plan.request?{request:plan.request}:{})})}).select('*').single();
    if(inserted.error)throw new Error(inserted.error.message);return inserted.data;
  });
}

describe('flag-on callback integration with upstream IVR recovery',()=>{
  it('retains DTMF evidence after request write failure; cron persists it before custom confirmation audio, without a duplicate',async()=>{
    const h=createTelephonyHarness();registerCallbackRpc(h);
    h.db.update('motorist_ivr_options',{prompt_media_url:'https://audio.test/custom-confirmation.mp3'},row=>row.action==='callback');
    const call=await h.inbound({to:NUMBERS.neutral});
    const gather=lastGather(h).params.clientState,at=h.now().toISOString();
    h.db.failNext('motorist_callback_requests','insert','injected callback write failure');
    await complete(h,call.callControlId,gather,'2');
    expect(h.rows('motorist_callback_requests')).toHaveLength(0);
    expect(confirmations(h)).toHaveLength(0);expect(h.telnyx.of('hangup')).toHaveLength(0);
    expect(h.session(call.sessionId).metadata).toMatchObject({callback:{confirmed:true,digit:'2',context:'ivr',requested_at:at},gather:null});
    expect(h.session(call.sessionId).pending_effects).toBeTruthy();
    h.advance(5*60_000);
    expect(await runPendingEffectRecovery(h.deps)).toMatchObject({status:'ok',detail:{checked:1}});
    expect(h.rows('motorist_callback_requests')).toHaveLength(1);
    expect(h.rows('motorist_callback_requests')[0]).toMatchObject({created_at:at,metadata:{request:{digit:'2',context:'ivr',requested_at:at}}});
    expect(confirmations(h)).toHaveLength(1);
    expect(confirmations(h)[0].params.audioUrl).toBe('https://audio.test/custom-confirmation.mp3');
    expect(h.telnyx.of('speak')).toHaveLength(0);
    expect(Date.parse(readMeta({metadata:toJson(h.session(call.sessionId).metadata)}).callback!.deadline_at!)).toBeGreaterThan(h.now().getTime());
    await complete(h,call.callControlId,gather,'2');
    expect(h.rows('motorist_callback_requests')).toHaveLength(1);expect(confirmations(h)).toHaveLength(1);
  });
  it('a lost completion cursor replays the same confirmation without extending its committed watchdog',async()=>{
    const h=createTelephonyHarness();registerCallbackRpc(h);
    const call=await h.inbound({to:NUMBERS.neutral});
    const update=h.db.update.bind(h.db);let injected=false;
    const spy=vi.spyOn(h.db,'update').mockImplementation((table,values,filter)=>{
      const rows=update(table,values,filter);
      const meta=values.metadata as {callback?:{confirmed?:boolean};ivr_dispatch?:unknown}|undefined;
      if(!injected&&table==='motorist_call_sessions'&&meta?.callback?.confirmed&&meta.ivr_dispatch){
        injected=true;h.db.failNext('motorist_call_sessions','update','lost command completion cursor');
      }
      return rows;
    });
    await complete(h,call.callControlId,lastGather(h).params.clientState,'2');
    spy.mockRestore();
    expect(injected).toBe(true);expect(h.session(call.sessionId).pending_effects).toBeTruthy();
    const deadline=readMeta({metadata:toJson(h.session(call.sessionId).metadata)}).callback!.deadline_at;
    const originalCommand=confirmations(h)[0].params.commandId;
    h.advance(30_000);
    expect(await runPendingEffectRecovery(h.deps)).toMatchObject({status:'ok',detail:{checked:1}});
    expect(confirmations(h).at(-1)!.params.commandId).toBe(originalCommand);
    expect(readMeta({metadata:toJson(h.session(call.sessionId).metadata)}).callback!.deadline_at).toBe(deadline);
    expect(h.telnyx.of('speak')).toHaveLength(0);expect(h.telnyx.of('hangup')).toHaveLength(0);
    expect(h.rows('motorist_callback_requests')).toHaveLength(1);
    h.advance(5*60_000);
    await runSessionEvent(h.deps,call.sessionId,{kind:'app',id:h.nextEventId(),type:'sweep',actorProfileId:null,occurredAt:h.now().toISOString()});
    expect(h.telnyx.of('speak')).toHaveLength(1);
  });
  it('a null/no-op RPC result cannot authorize confirmation; a later retry persists the exact choice',async()=>{
    const h=createTelephonyHarness();h.db.registerRpc('motorist_create_callback_obligation_v1',()=>null);
    const call=await h.inbound({to:NUMBERS.neutral});
    await complete(h,call.callControlId,lastGather(h).params.clientState,'2');
    expect(h.rows('motorist_callback_requests')).toHaveLength(0);expect(confirmations(h)).toHaveLength(0);expect(h.telnyx.of('hangup')).toHaveLength(0);
    registerCallbackRpc(h);h.advance(5*60_000);
    expect(await runPendingEffectRecovery(h.deps)).toMatchObject({status:'ok'});
    expect(h.rows('motorist_callback_requests')).toHaveLength(1);expect(confirmations(h)).toHaveLength(1);
  });
  it.each(['anonymous','sip:anonymous@invalid','+123','<script>123</script>'])('upstream IVR keeps caller %s in assistance without promising an impossible callback',async callerNumber=>{
    const h=createTelephonyHarness();registerCallbackRpc(h);
    const call=await h.inbound({to:NUMBERS.neutral});
    h.db.update('motorist_call_sessions',{caller_number:callerNumber},row=>row.id===call.sessionId);
    await complete(h,call.callControlId,lastGather(h).params.clientState,'2');
    expect(h.rows('motorist_callback_requests')).toHaveLength(0);expect(confirmations(h)).toHaveLength(0);expect(h.telnyx.of('hangup')).toHaveLength(0);
    expect(h.session(call.sessionId).state).toBe('ringing');
  });
  it('retains custom queue music cadence, rejects stale gather choice and accepts the current explicit callback',async()=>{
    const h=createTelephonyHarness({fallbackKind:'waiting_room'});registerCallbackRpc(h);
    const config=defaultAnnouncementConfig();config.prompts.sk={queueWaiting:{text:'Pre spätné volanie stlačte jednotku.',audioUrl:'https://audio.test/custom-queue.mp3',voiceId:config.voiceId}};
    h.db.update('motorist_telephony_lines',{metadata:{announcements:config}},row=>row.id===LINES.allianz);
    for(const id of Object.values(PROFILES))h.setPresence(id,{status:'offline'});
    const call=await h.inbound({to:NUMBERS.allianz});
    const backup=h.legByNumber(call.sessionId,NUMBERS.external)!;
    await h.legEvent(String(backup.telnyx_call_control_id),'call.hangup',{hangup_cause:'no_answer'});
    const prompt=lastGather(h);expect(prompt.params.timeoutMillis).toBe(1000);
    await complete(h,call.callControlId,prompt.params.clientState);
    const music=lastGather(h);expect(music.method).toBe('gather');expect(music.params.initialTimeoutMillis).toBe(60000);
    await complete(h,call.callControlId,prompt.params.clientState,'1');expect(h.rows('motorist_callback_requests')).toHaveLength(0);
    await complete(h,call.callControlId,music.params.clientState,'1');
    expect(h.rows('motorist_callback_requests')).toHaveLength(1);expect(h.session(call.sessionId).state).toBe('callback_offered');
    expect(h.rows('motorist_callback_requests')[0].metadata).toMatchObject({request:{digit:'1',context:'waiting_room'}});
  });
});

it('normalizes the v1 obligation number and rejects explicit invalid input or missing returned choice evidence',async()=>{
  const h=createTelephonyHarness();
  const session={id:'session',organization_id:h.deps.organizationId,caller_number:'anonymous',started_at:h.now().toISOString()} as SessionRow;
  const request={kind:'requested',requested_at:h.now().toISOString(),digit:'2',context:'ivr',event_id:'event'} as const;
  await expect(createCallbackObligation({admin:h.admin,now:h.now},session,{source:'ivr',callerNumber:'anonymous',createTask:false,request})).rejects.toThrow('callback number unavailable');
  await expect(createCallbackObligation({admin:h.admin,now:h.now},session,{source:'missed',callerNumber:'anonymous',createTask:false})).resolves.toBeUndefined();
  h.db.registerRpc('motorist_create_callback_obligation_v1',args=>{
    expect(args.p_plan).toMatchObject({callerNumber:'+421905123456'});
    return {id:'request',organization_id:h.deps.organizationId,session_id:'session',caller_number:'+421905123456',metadata:{}};
  });
  await expect(createCallbackObligation({admin:h.admin,now:h.now},session,{source:'ivr',callerNumber:'0905 123 456',createTask:false,request})).rejects.toThrow('callback choice was not persisted');
});
