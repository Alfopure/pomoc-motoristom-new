import type { RoutingDocument } from "../../src/server/telephony/config-service";
import { DEFAULT_OPERATOR_SETTINGS } from "../../src/lib/telephony/operator-settings";
export const ids={ organization:"00000000-0000-4000-8000-000000000001", line:"00000000-0000-4000-8000-000000000201", plan:"00000000-0000-4000-8000-000000000301", group:"00000000-0000-4000-8000-000000000401", jana:"00000000-0000-4000-8000-000000000101", peter:"00000000-0000-4000-8000-000000000102" };
export const routingFixture:RoutingDocument={
 organizationId:ids.organization,routingVersion:5,snapshotId:"fixture-v5",settingsConfigured:true,
 capabilities:{ownedMobileRouting:true,defaultInboundCallMode:"ring_first",atomicIncomingLineModes:true},
 lines:[{id:ids.line,phoneNumber:"+421 232 408 700",label:"Hlavná linka",partnerName:null,telnyxNumberId:null,ringPlanId:ids.plan,ivrMenuId:null,businessHoursId:null,environment:"development",active:true}],
 groups:[{id:ids.group,name:"Dispečeri",description:"Hlavný tím pomoci",active:true,members:[{id:"00000000-0000-4000-8000-000000000411",memberKind:"operator",profileId:ids.jana,externalNumber:null,position:0,ringSecs:null,lastOfferedAt:null,lastAnsweredAt:null},{id:"00000000-0000-4000-8000-000000000412",memberKind:"operator",profileId:ids.peter,externalNumber:null,position:1,ringSecs:30,lastOfferedAt:null,lastAnsweredAt:null}]}],
 plans:[{id:ids.plan,name:"Bežné prichádzajúce hovory",fallbackKind:"waiting_room",fallbackNumber:null,active:true,steps:[{id:"00000000-0000-4000-8000-000000000311",stepIndex:0,ringGroupId:ids.group,timeoutSecs:20,strategy:"all"}]}],
 businessHours:[],pauseReasons:[],pauseReasonsInUse:[],ivrMenus:[],operators:[{profileId:ids.jana,displayName:"Jana Nováková",role:"dispatcher",active:true,settings:null,device:null},{profileId:ids.peter,displayName:"Peter Kováč",role:"dispatcher",active:true,settings:null,device:null}],limits:{destinationAllowlist:["SK","CZ"],maxRingFanout:8,maxConcurrentLegs:9},settings:{inboundCallMode:"ring_first",liveCallsEnabled:true,smsLiveSends:false,dailyLegSoftCap:500,parkMaxMinutes:10,destinationAllowlist:["SK","CZ"],maxRingFanout:8,maxConcurrentLegs:9,queueEscalateAfterSeconds:120}
};

export const extraIds = {
 inactiveLine: "00000000-0000-4000-8000-000000000200",
 secondLine: "00000000-0000-4000-8000-000000000202",
 secondPlan: "00000000-0000-4000-8000-000000000302",
 unusedPlan: "00000000-0000-4000-8000-000000000303",
 secondGroup: "00000000-0000-4000-8000-000000000402",
};

/** Deliberately includes an inactive first row and independent, hidden drafts. */
export const multiLineRoutingFixture: RoutingDocument = {
 ...routingFixture,
 lines: [
  { ...routingFixture.lines[0], id: extraIds.inactiveLine, label: "Vyradená linka", phoneNumber: "+421 232 408 699", active: false, ringPlanId: extraIds.secondPlan },
  routingFixture.lines[0],
  { ...routingFixture.lines[0], id: extraIds.secondLine, label: "Asistenčná linka", phoneNumber: "+421 232 408 701", ringPlanId: extraIds.secondPlan },
 ],
 groups: [
  routingFixture.groups[0],
  {
   id: extraIds.secondGroup, name: "Asistenčná záloha", description: "Samostatný tím druhej linky", active: true,
   members: [{
    id: "00000000-0000-4000-8000-000000000421", memberKind: "external_number", profileId: null,
    externalNumber: "+421900000002", ownerProfileId: null, position: 0, ringSecs: 35,
    lastOfferedAt: "2026-09-01T10:00:00Z", lastAnsweredAt: "2026-09-01T10:00:05Z",
   }],
  },
 ],
 plans: [
  routingFixture.plans[0],
  {
   id: extraIds.secondPlan, name: "Asistenčné hovory", fallbackKind: "external_number", fallbackNumber: "+421900000003", active: true,
   steps: [{ id: "00000000-0000-4000-8000-000000000321", stepIndex: 0, ringGroupId: extraIds.secondGroup, timeoutSecs: 45, strategy: "ordered" }],
  },
  {
   id: extraIds.unusedPlan, name: "Sezónna záloha", fallbackKind: "waiting_room", fallbackNumber: null, active: false,
   steps: [{ id: "00000000-0000-4000-8000-000000000331", stepIndex: 0, ringGroupId: extraIds.secondGroup, timeoutSecs: 50, strategy: "all" }],
  },
 ],
};

/** Model data only: one operator has a web endpoint and an explicitly owned mobile. */
export const dualDeviceRoutingFixture: RoutingDocument = {
 ...multiLineRoutingFixture,
 lines: multiLineRoutingFixture.lines.map(line => line.id === ids.line
  ? { ...line, label: "TEST linka", phoneNumber: "+421 232 408 700" }
  : line),
 operators: multiLineRoutingFixture.operators.map(operator => operator.profileId === ids.jana
  ? { ...operator, displayName: "Martin Novák", settings: { ...DEFAULT_OPERATOR_SETTINGS, deliveryMode: "web", defaultMobileNumber: "+421900000001" } }
  : operator),
 groups: multiLineRoutingFixture.groups.map(group => group.id === ids.group ? {
  ...group, name: "Martin – web a mobil", description: null,
  members: [
   group.members[0],
   { ...group.members[1], memberKind: "external_number", profileId: null, externalNumber: "+421900000001", ownerProfileId: ids.jana },
  ],
 } : group),
 plans: multiLineRoutingFixture.plans.map(plan => plan.id === ids.plan
  ? { ...plan, name: "Martin – web a mobil", fallbackKind: "hangup_message" }
  : plan),
};
