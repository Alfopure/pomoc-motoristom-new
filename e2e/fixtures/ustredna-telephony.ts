import { useEffect, useState } from "react";
import { buildPhoneBarModel, EMPTY_ACTIVE_CALLS, liveCallCenterCalls, type ActiveCallPayload } from "@/lib/telephony/active-calls-model";
import type { TelephonyConsole } from "@/components/dispatch/useTelephonyConsole";
export const TELEPHONY_STALE_MESSAGE = "Spojenie sa obnovuje.";
const actor = "00000000-0000-4000-8000-000000000002";
const noop = () => {};
const done = async () => {};
const yes = async () => true;
export function useTelephonyConsole(): TelephonyConsole {
  const [scenario, setScenario] = useState("idle");
  const [now] = useState(Date.now);
  useEffect(() => { const change = (event: Event) => setScenario((event as CustomEvent<string>).detail); window.addEventListener("fixture-calls", change); return () => window.removeEventListener("fixture-calls", change); }, []);
  const base: ActiveCallPayload = { sessionId:"",callId:null,state:"ringing",direction:"inbound",callerNumber:"+421900000001",calledNumber:"+421900000000",lineId:null,lineLabel:"Asistencia",partnerName:null,caseId:null,match:null,startedAt:new Date(now-35_000).toISOString(),answeredAt:null,answeredByProfileId:null,holdStartedAt:null,parkedAt:null,parkedByProfileId:null,waitingSince:null,waitingReason:null,waitingMaxMinutes:null,currentStep:0,ringMode:"all",offeredProfileIds:[actor],legs:[],mine:false };
  const own = scenario === "active" || scenario === "busy";
  const n = scenario === "busy" ? 5 : scenario === "ringing" ? 1 : 0;
  const calls = [...(own ? [{...base,sessionId:"own",state:"talking" as const,answeredAt:new Date(now-90_000).toISOString(),answeredByProfileId:actor,mine:true,offeredProfileIds:[],legs:[{id:"customer-leg",role:"customer" as const,profileId:null,state:"bridged",toNumber:null,fromNumber:"+421900000001",answeredAt:new Date(now-90000).toISOString(),bridgedAt:new Date(now-90000).toISOString(),intent:null,muted:false,supervisorMode:null}]}] : []),...Array.from({length:n},(_,i)=>({...base,sessionId:`offer-${i}`,callerNumber:`+42190000001${i}`}))];
  const waiting = scenario === "waiting" ? [{...base,sessionId:"waiting-1",state:"waiting" as const,offeredProfileIds:[],waitingSince:new Date(now-240_000).toISOString(),waitingMaxMinutes:10,queueIdleSince:new Date(now-180_000).toISOString(),queueEscalatedAt:new Date(now).toISOString()}] : [];
  const snapshot = {...EMPTY_ACTIVE_CALLS,configured:true,organizationId:"00000000-0000-4000-8000-000000000001",actorProfileId:actor,calls,waiting,presence:{actorProfileId:actor,canManageAssignments:true,checkedAt:new Date(now).toISOString(),devices:[{profileId:actor,registered:true}],presence:[{profileId:actor,status:own ? "on_call" as const : "available" as const,currentSessionId:own?"own":null}]},ownPresence:{status:own ? "on_call" as const : "available" as const,pauseReasonId:null,statusSince:new Date(now).toISOString()}};
  return { configured:true,stale:false,snapshot,phoneBar:buildPhoneBarModel(snapshot),phone:{status:"registered",registration:{status:"registered",tone:"ok",label:"Registrované",detail:"Testovací telefón"},call:null,sipUsername:null,deviceSessionId:null,message:null},presences:[],pauseReasons:[],presenceBusy:false,busyAction:null,outboundPending:false,readiness:{status:"ready",message:null},preparePhone:yes,resumeAudio:noop,notice:null,degradedSessionIds:new Set(),liveCalls:liveCallCenterCalls(snapshot, { now }),waitingCalls:[],dial:done,callBackRequest:done,callAction:done,partyAction:done,supervise:done,stopSupervise:done,acceptMonitorInvitation:done,changePresence:yes,refreshPauseReasons:noop,availabilityAction:noop,answer:noop,answerOffer:noop,rejectOffer:noop,takeoverPhone:noop,hangupBrowser:noop,toggleMute:noop,sendDtmf:noop,unlockAudio:noop,dismissNotice:noop,refresh:noop } as TelephonyConsole;
}
