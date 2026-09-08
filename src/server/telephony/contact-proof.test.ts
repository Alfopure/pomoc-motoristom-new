import { describe, expect, it, vi } from "vitest";
import { createFakeTelnyx } from "@/test/fake-telnyx";
import { attachContactOperations, bindContactConference, collectContactOperation, collectContactProof, contactOperationIntent, readContactHistory, verifyConferenceContact, type ContactSnapshot } from "./contact-proof";
import { emptyTransition, toJson, type Command, type LegRow, type SessionRow, type TelephonyEvent } from "./state/types";

const start = '2026-09-07T10:00:00.000Z';
const at = '2026-09-07T10:00:05.000Z';
const end = '2026-09-07T10:00:10.000Z';
function snapshot(recording = false): ContactSnapshot {
  return {
    session: { id:'session', organization_id:'org', direction:'inbound', started_at:start, ended_at:null,
      case_id:null,line_id:null,caller_number:'+421900123456',called_number:'+421900654321',state:'talking', answered_by_profile_id:'profile', conference_id:null,
      metadata: recording ? { recording:{epoch:1,policy:{enabled:true}} } : {} } as SessionRow,
    legs: [
      {id:'customer',session_id:'session',role:'customer',telnyx_call_control_id:'customer-cc',telnyx_call_leg_id:'leg-customer-cc',created_at:start,answered_at:start,ended_at:null},
      {id:'operator',session_id:'session',role:'operator',profile_id:'profile',telnyx_call_control_id:'operator-cc',telnyx_call_leg_id:'leg-operator-cc',created_at:start,answered_at:start,ended_at:null},
      {id:'supervisor',session_id:'session',role:'supervisor',profile_id:'supervisor-profile',telnyx_call_control_id:'supervisor-cc',created_at:start,answered_at:start,ended_at:null},
      {id:'consult',session_id:'session',role:'consult',profile_id:'consult-profile',telnyx_call_control_id:'consult-cc',created_at:start,answered_at:start,ended_at:null},
    ] as LegRow[],
  };
}
function event(type:string, controlId='customer-cc', occurredAt=at, extra:Partial<TelephonyEvent>={}): TelephonyEvent {
  return {clientState:{sid:'session',role:controlId==='customer-cc'?'customer':'operator',intent:contactOperationIntent('bridge-command')},kind:'telnyx',id:`${type}:${controlId}:${occurredAt}`,type,callControlId:controlId,occurredAt,payload:{},conferenceId:null,...extra} as TelephonyEvent;
}
const bridge: Command={kind:'bridge',commandId:'bridge-command',leg:{callControlId:'customer-cc'},target:{callControlId:'operator-cc'}};
function operation(state:ContactSnapshot, commands:Command[]=[bridge]) {
  state.session.metadata=toJson({...state.session.metadata as object,callback_contact:collectContactOperation(state,commands,event('call.answered','operator-cc',start))});
}
function observe(state:ContactSnapshot,e:TelephonyEvent) {
  const history=collectContactProof(state,e);
  state.session.metadata=toJson({...state.session.metadata as object,callback_contact:history});
  return history;
}

describe('callback provider contact proof',()=>{
  it.each([false,true])('CB-05/06: both exact bridge legs required, recording=%s', recording=>{
    const state=snapshot(recording); operation(state);
    for(const kind of ['call.answered','conference.participant.joined']) expect(observe(state,event(kind)).proofs).toEqual([]);
    expect(observe(state,event('call.bridged','supervisor-cc')).proofs).toEqual([]);
    expect(observe(state,event('call.bridged','consult-cc')).proofs).toEqual([]);
    expect(observe(state,event('call.bridged')).proofs).toEqual([]);
    expect(observe(state,event('call.bridged','operator-cc')).proofs).toMatchObject([{customerLegId:'customer',operatorLegId:'operator',topology:'bridge'}]);
    expect(observe(state,event('call.bridged','operator-cc')).proofs).toHaveLength(1);
  });
  it('CB-06: owned PSTN winner and recording conference bridge keep the correct topology',()=>{
    const state=snapshot(true); state.legs[1].role='external';
    operation(state,[{...bridge,recordingConferenceName:'recording-conference'}]);
    const history=bindContactConference(readContactHistory(state.session),'bridge-command','conference-a');
    expect(history.operations[0]).toMatchObject({topology:'conference',operatorProfileId:'profile',conferenceId:'conference-a'});
    state.session.metadata=toJson({callback_contact:history});
    observe(state,event('call.bridged')); expect(observe(state,event('call.bridged','operator-cc')).proofs).toEqual([]);
    observe(state,event('conference.participant.joined','customer-cc',at,{conferenceId:'conference-a'}));
    expect(observe(state,event('conference.participant.joined','operator-cc',at,{conferenceId:'conference-a'})).proofs).toEqual([]);
  });
  it('CB-05: unrelated A-supervisor and B-consult bridges cannot masquerade as the expected A-B operation',()=>{
    const state=snapshot(); operation(state);
    expect(observe(state,event('call.bridged','customer-cc',at,{clientState:null})).proofs).toEqual([]);
    expect(observe(state,event('call.bridged','operator-cc',at,{clientState:null})).proofs).toEqual([]);
    const changed=collectContactOperation(state,[{...bridge,commandId:'private-bridge',target:{callControlId:'supervisor-cc'}}],event('app','customer-cc',at));
    state.session.metadata=toJson({callback_contact:changed});
    observe(state,event('call.bridged','customer-cc',end,{clientState:{sid:'session',role:'customer',intent:contactOperationIntent('private-bridge')}}));
    expect(observe(state,event('call.bridged','operator-cc',end,{clientState:{sid:'session',role:'operator',intent:contactOperationIntent('consult-bridge')}})).proofs).toEqual([]);
  });
  it('CB-05: never treats an uncorrelated bridge or private consult operation as customer contact',()=>{
    const state=snapshot();
    observe(state,event('call.bridged')); expect(observe(state,event('call.bridged','operator-cc')).proofs).toEqual([]);
    operation(state,[{...bridge,target:{callControlId:'consult-cc'}}]);
    expect(readContactHistory(state.session).operations).toEqual([]);
  });
  it.each([false,true])('CB-06: conference events identify candidates without proving simultaneous audible membership, recording=%s',recording=>{
    const state=snapshot(recording);
    operation(state,[{kind:'conference_create',commandId:'create',leg:{callControlId:'customer-cc'},name:'expected'}]);
    state.session.metadata=toJson({...state.session.metadata as object,callback_contact:bindContactConference(readContactHistory(state.session),'create','conference-a')});
    observe(state,event('conference.participant.joined','customer-cc',at,{conferenceId:'conference-a'}));
    expect(observe(state,event('conference.participant.joined','operator-cc',at,{conferenceId:'conference-b'})).proofs).toEqual([]);
    expect(observe(state,event('conference.participant.joined','operator-cc',end,{conferenceId:'conference-a',payload:{muted:true}})).proofs).toEqual([]);
    expect(observe(state,event('conference.participant.joined','operator-cc','2026-09-07T10:00:11Z',{conferenceId:'conference-a'})).proofs).toEqual([]);
  });
  it('CB-06: customer IVR conference membership alone is insufficient but survives later operator selection',()=>{
    const state=snapshot(); state.session.answered_by_profile_id=null;
    observe(state,event('conference.participant.joined','customer-cc',start,{conferenceId:'conference-a'}));
    expect(readContactHistory(state.session).proofs).toEqual([]);
    state.session.answered_by_profile_id='profile'; state.session.conference_id='conference-a';
    operation(state,[{kind:'conference_join',commandId:'join-operator',leg:{callControlId:'operator-cc'}}]);
    expect(observe(state,event('conference.participant.joined','operator-cc',at,{conferenceId:'conference-a'})).proofs).toEqual([]);
  });
  it.each(['normal','reverse','pre-operation'] as const)('CB-08: distinct conference joins cannot infer contact in %s delivery',order=>{
    const state=snapshot();state.session.conference_id='conference-a';
    operation(state,[{kind:'conference_join',commandId:'join-operator',leg:{callControlId:'operator-cc'}}]);
    if(order==='pre-operation'){
      const history=readContactHistory(state.session);history.operations[0].startedAt=at;
      state.session.metadata=toJson({callback_contact:history});
    }
    const customer=event('conference.participant.joined','customer-cc',order==='pre-operation'?start:at,{conferenceId:'conference-a'});
    const operator=event('conference.participant.joined','operator-cc',end,{conferenceId:'conference-a'});
    observe(state,order==='normal'?customer:operator);
    const history=observe(state,order==='normal'?operator:customer);
    expect(history.operations[0].conferenceId).toBe('conference-a');
    expect(history.proofs).toEqual([]);expect(observe(state,customer).proofs).toEqual([]);
  });
  it.each(['webhook','provider-result'] as const)('CB-08: delayed %s conference binding preserves identity without inferring contact',binding=>{
    const state=snapshot();operation(state,[{kind:'conference_create',commandId:'create',leg:{callControlId:'customer-cc'},name:'expected'}]);
    observe(state,event('conference.participant.joined','operator-cc',end,{conferenceId:'conference-a'}));
    expect(observe(state,event('conference.participant.joined','customer-cc',at,{conferenceId:'conference-a'})).proofs).toEqual([]);
    const history=binding==='webhook'
      ? observe(state,event('conference.created','customer-cc',start,{conferenceId:'conference-a',callControlId:null,payload:{name:'expected'}}))
      : bindContactConference(readContactHistory(state.session),'create','conference-a');
    expect(history.operations[0].conferenceId).toBe('conference-a');
    expect(history.proofs).toEqual([]);
  });
  it.each(['left','muted','held','operation-ended','leg-ended','conference-ended'] as const)('CB-08: delayed early join cannot cross known %s boundary',boundary=>{
    const state=snapshot();state.session.conference_id='conference-a';
    operation(state,[{kind:'conference_join',commandId:'join-operator',leg:{callControlId:'operator-cc'}}]);
    const middle='2026-09-07T10:00:07.000Z';
    if(boundary==='operation-ended'){
      state.session.metadata=toJson({callback_contact:collectContactOperation(state,[{kind:'conference_hold',commandId:'hold',legs:[{callControlId:'customer-cc'}],media:{key:'moh'}}],event('app','customer-cc',middle))});
    }else if(boundary==='leg-ended')state.legs[0].ended_at=middle;
    else observe(state,event(boundary==='conference-ended'?'conference.ended':boundary==='left'?'conference.participant.left':'conference.participant.joined','customer-cc',middle,{conferenceId:'conference-a',payload:boundary==='muted'?{muted:true}:boundary==='held'?{on_hold:true}:{}}));
    observe(state,event('conference.participant.joined','operator-cc',end,{conferenceId:'conference-a'}));
    expect(observe(state,event('conference.participant.joined','customer-cc',at,{conferenceId:'conference-a'})).proofs).toEqual([]);
  });
  it('CB-03/08: later case/line edits cannot replace the frozen contact scope',()=>{
    const state=snapshot(); operation(state);
    state.session.case_id='new-case'; state.session.line_id='new-line';
    observe(state,event('call.bridged','operator-cc'));
    expect(observe(state,event('call.bridged')).proofs[0].scope).toMatchObject({caseId:null,lineId:null,customerNumber:'+421900123456',startedAt:start});
  });
  it('CB-08: delayed proof uses original topology and leg lifetime after terminal/transfer, and rejects later events',()=>{
    const state=snapshot(); operation(state);
    state.session.state='ended'; state.session.ended_at=end; state.session.answered_by_profile_id='new-winner';
    state.legs.forEach(leg=>leg.ended_at=end);
    expect(observe(state,event('call.bridged','operator-cc')).proofs).toEqual([]);
    expect(observe(state,event('call.bridged')).proofs).toHaveLength(1);
    const invalid=snapshot(); operation(invalid); invalid.legs.forEach(leg=>leg.ended_at=start);
    observe(invalid,event('call.bridged')); expect(observe(invalid,event('call.bridged','operator-cc')).proofs).toEqual([]);
  });
  it('CB-08: a later transfer/hold closes the operation without dropping its historical evidence',()=>{
    const state=snapshot(); operation(state);
    state.session.metadata=toJson({callback_contact:collectContactOperation(state,[{kind:'conference_hold',commandId:'hold',legs:[{callControlId:'customer-cc'}],media:{key:'moh'}}],event('app','customer-cc',end))});
    observe(state,event('call.bridged','operator-cc','2026-09-07T10:00:11Z'));
    expect(observe(state,event('call.bridged','customer-cc','2026-09-07T10:00:11Z')).proofs).toEqual([]);
    observe(state,event('call.bridged','operator-cc',at)); expect(observe(state,event('call.bridged','customer-cc',at)).proofs).toHaveLength(1);
  });
  it.each(['conference_unhold','conference_unmute'] as const)('CB-06: %s captures the restored serving pair, excludes unrelated members and replays once',kind=>{
    const state=snapshot();state.session.conference_id='conference-a';
    operation(state,[{kind:'conference_join',commandId:'join',leg:{callControlId:'operator-cc'}}]);
    const hold:Command={kind:'conference_hold',commandId:'hold',legs:[{callControlId:'customer-cc'}],media:{key:'moh'}};
    state.session.metadata=toJson({callback_contact:collectContactOperation(state,[hold],event('app','customer-cc',at))});
    const unrelated:Command={kind,commandId:'unrelated',legs:[{callControlId:'supervisor-cc'}]};
    expect(collectContactOperation(state,[unrelated],event('app','customer-cc',end)).operations).toHaveLength(1);
    const resume:Command={kind,commandId:'resume',legs:[{callControlId:'customer-cc'}]};
    const history=collectContactOperation(state,[resume],event('app','customer-cc',end));
    expect(history.operations).toMatchObject([{id:'join',endedAt:at},{id:'resume',startedAt:end,endedAt:null,sourceControlId:'customer-cc',operatorLegId:'operator',conferenceId:'conference-a'}]);
    expect(history.proofs).toEqual([]);state.session.metadata=toJson({callback_contact:history});
    expect(collectContactOperation(state,[resume],event('app','customer-cc',end)).operations).toHaveLength(2);
  });
  it('compensation preparation retains newer historical proof and captures the exact rejoin operation',()=>{
    const state=snapshot();operation(state);
    observe(state,event('call.bridged','customer-cc',at));observe(state,event('call.bridged','operator-cc',at));
    const next=emptyTransition();next.session.metadata=toJson({callback_contact:{version:1,operations:[],proofs:[]},transfer:null});
    const compensation={next,commands:[{...bridge,commandId:'compensation-rejoin'}],compensations:[],guard:null,ignored:null};
    attachContactOperations(state,compensation,event('app','customer-cc',end),true);
    const history=readContactHistory({metadata:next.session.metadata!});
    expect(history.proofs).toHaveLength(1);expect(next.contactProofs).toHaveLength(1);
    expect(history.operations).toMatchObject([{id:'bridge-command',endedAt:end},{id:'compensation-rejoin',sourceControlId:'customer-cc',customerLegId:'customer',operatorLegId:'operator'}]);
  });
});

describe('authoritative conference contact snapshot',()=>{
  function candidate(){
    const state=snapshot();state.session.conference_id='conference-a';
    operation(state,[{kind:'conference_join',commandId:'join-operator',leg:{callControlId:'operator-cc'}}]);
    observe(state,event('conference.participant.joined','operator-cc',end,{conferenceId:'conference-a'}));
    observe(state,event('conference.participant.joined','customer-cc',at,{conferenceId:'conference-a'}));
    const fake=createFakeTelnyx();
    const rows=['customer-cc','operator-cc'].map(id=>({record_type:'participant',id:`participant-${id}`,call_control_id:id,call_leg_id:`leg-${id}`,
      conference:{id:'conference-a'},status:'joined',muted:false,on_hold:false,whisper_call_control_ids:[]}));
    fake.setConferenceParticipants('conference-a',rows);
    const verify=()=>verifyConferenceContact({telnyx:fake.client,now:()=>new Date(end)},state,'join-operator');
    return {state,fake,rows,verify};
  }
  it('requires one current response containing both exact audible members; an undelivered intermediate leave cannot fulfill',async()=>{
    const {state,fake,rows,verify}=candidate();
    expect(readContactHistory(state.session).proofs).toEqual([]);
    // Physical A left between its t1 join and B's t3 join. The leave webhook
    // has not arrived; the provider snapshot truthfully contains only B.
    fake.setConferenceParticipants('conference-a',[rows[1]]);
    const result=await verify();expect(result).toMatchObject({proof:null,retry:true,reason:'pair_not_observed'});
    expect(result.history.proofs).toEqual([]);
    observe(state,event('conference.participant.left','customer-cc','2026-09-07T10:00:07Z',{conferenceId:'conference-a'}));
    expect((await verify()).proof).toBeNull();
  });
  it('captures one exact provider pair with strict positive state and retains that proof after late leave/hangup',async()=>{
    const {state,fake,verify}=candidate();
    const result=await verify();expect(result).toMatchObject({retry:false,reason:'verified',proof:{occurredAt:end,topology:'conference',
      conferenceSnapshot:{source:'telnyx_conference_participants_v1',conferenceId:'conference-a',participants:[{callControlId:'customer-cc',callLegId:'leg-customer-cc',status:'joined',muted:false,onHold:false},{callControlId:'operator-cc',callLegId:'leg-operator-cc',status:'joined',muted:false,onHold:false}]}}});
    expect(fake.of('request')).toMatchObject([{params:{method:'GET',path:'/conferences/conference-a/participants',query:{region:'Europe','page[number]':1,'page[size]':250}}}]);
    state.session.metadata=toJson({callback_contact:result.history});
    state.session.ended_at=end;state.session.state='ended';state.legs.forEach(leg=>leg.ended_at=end);
    observe(state,event('conference.participant.left','customer-cc',end,{conferenceId:'conference-a'}));
    const replay=await verify();expect(replay).toMatchObject({retry:false,reason:'already_verified',proof:result.proof});
    expect(fake.of('request')).toHaveLength(1);
  });
  it('query failure stays retryable without creating proof or issuing any audio command',async()=>{
    const {fake,verify}=candidate();fake.failNext('request','injected read failure');
    expect(await verify()).toMatchObject({proof:null,retry:true,reason:'provider_query_failed',history:{proofs:[]}});
    expect(fake.calls.map(call=>call.method)).toEqual(['request']);
    expect(await verify()).toMatchObject({retry:false,reason:'verified'});
  });
  it.each(['status','muted','on_hold','whisper_call_control_ids','call_leg_id','conference'] as const)('missing %s is never positive evidence',async field=>{
    const {fake,rows,verify}=candidate();const malformed:Record<string,unknown>={...rows[0]};delete malformed[field];
    fake.setConferenceParticipants('conference-a',[malformed,rows[1]]);
    expect(await verify()).toMatchObject({proof:null,retry:true});
  });
  it.each([{status:'joining'},{status:'left'},{muted:true},{on_hold:true},{whisper_call_control_ids:['operator-cc']},{call_leg_id:'different-leg'},{conference:{id:'different-conference'}}])('rejects inaudible or mismatched provider state %j',async changed=>{
    const {fake,rows,verify}=candidate();fake.setConferenceParticipants('conference-a',[{...rows[0],...changed},rows[1]]);
    expect(await verify()).toMatchObject({proof:null,retry:true});
  });
  it('does not merge different response pages or accept duplicate identities',async()=>{
    const {fake,rows,verify}=candidate();
    const request=vi.spyOn(fake.client,'request').mockResolvedValueOnce({data:[rows[0]],meta:{page_number:1,total_pages:2}})
      .mockResolvedValueOnce({data:[rows[1]],meta:{page_number:2,total_pages:2}});
    expect((await verify()).proof).toBeNull();expect((await verify()).proof).toBeNull();expect(request).toHaveBeenCalledTimes(2);request.mockRestore();
    fake.setConferenceParticipants('conference-a',[...rows,rows[0]]);expect((await verify()).proof).toBeNull();
  });
  it('does not query an ended or replaced pair and never backdates current membership into old topology',async()=>{
    const {state,fake,verify}=candidate();state.legs[0].ended_at=at;
    expect(await verify()).toMatchObject({proof:null,retry:false});expect(fake.of('request')).toEqual([]);
  });
});
