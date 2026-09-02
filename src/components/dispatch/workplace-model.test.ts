import { describe, expect, it } from "vitest";
import type { CallCenterCall } from "@/data/dispatch-types";
import type { Operator } from "@/domain/types";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import type { TelephonyOperatorPresence, TelephonyPresenceSnapshot } from "@/lib/telephony/presence";
import { callIsCurrentAtTelephonyStation } from "@/lib/telephony/call-endpoints";
import {
  buildWorkplaceCallRoute,
  buildWorkplaceStations,
  buildWorkplaceWaitingRoom,
  getWorkplaceRoutingStatus,
} from "./workplace-model";

const liveHealth: TelephonyHealthSignal = {
  state: "live",
  detail: "Overené",
  checkedAt: "2026-08-05T12:00:00.000Z",
};
const operators: Operator[] = [
  { id: "op-20", name: "Michal Novák", extension: "20", status: "available" },
  { id: "op-21", name: "Mango Mango", extension: "21", status: "available" },
  { id: "op-22", name: "Lenka Horváthová", extension: "22", status: "available" },
];

describe("workplace model", () => {
  it("builds four stable stations and keeps the vacant fourth station outside the ringing plan", () => {
    const stations = buildWorkplaceStations(modelInput());

    expect(stations).toHaveLength(4);
    expect(stations.map((station) => station.extension)).toEqual(["20", "21", "22", "23"]);
    expect(stations.slice(0, 3).map((station) => [station.queuePriority, station.queue])).toEqual([
      [1, "601"],
      [2, "602"],
      [3, "603"],
    ]);
    expect(stations[3]).toMatchObject({ name: "Neobsadené", queuePriority: undefined, state: "free" });
    expect(getWorkplaceRoutingStatus(stations, liveHealth, snapshot(), fullPlan())).toMatchObject({ verified: true });
  });

  it("shows an exact inbound target as ringing without inventing a missed-call history", () => {
    const call = activeCall({
      direction: "inbound",
      status: "ringing_agent",
      receivedExtension: "20",
      destinationExtension: "21",
      callerName: "Allianz Assistance",
    });
    const stations = buildWorkplaceStations(modelInput([call]));
    const route = buildWorkplaceCallRoute(call, stations);

    expect(stations[1].state).toBe("ringing");
    expect(stations[0].state).toBe("ready");
    expect(route.steps.map((step) => step.state)).toEqual(["previous", "current", "planned"]);
    expect(route.currentStation?.extension).toBe("21");
  });

  it("does not show a queue parent with stale ownership on another workstation", () => {
    const queueParent = activeCall({
      direction: "inbound",
      status: "ringing_agent",
      calledNumber: "601",
      receivedExtension: "21",
      operatorId: "op-21",
    });
    const currentAgentLeg = activeCall({
      id: "call-agent-leg",
      direction: "inbound",
      status: "ringing_agent",
      calledNumber: "20",
      destinationExtension: "20",
    });

    const stations = buildWorkplaceStations(modelInput([queueParent, currentAgentLeg]));

    expect(stations[0].activeCalls.map((call) => call.id)).toEqual(["call-agent-leg"]);
    expect(stations[1].activeCalls).toEqual([]);
  });

  it("maps an outbound SIP source to the operator who is on the call", () => {
    const call = activeCall({
      direction: "outbound",
      status: "outbound",
      callerExtension: "20",
      callerNumber: "+421412289240",
      calledNumber: "+421905123456",
      destinationNumber: "+421905123456",
    });
    const stations = buildWorkplaceStations(modelInput([call]));
    const route = buildWorkplaceCallRoute(call, stations);

    expect(stations[0].state).toBe("on_call");
    expect(route.steps.map((step) => step.station.extension)).toEqual(["20"]);
  });

  it("maps simultaneous inbound calls to their own workstations without using array order", () => {
    const first = activeCall({
      id: "simultaneous-20",
      viptelUniqueId: "provider-20",
      destinationExtension: "20",
      startedAt: "2026-08-11T08:30:00.000Z",
    });
    const second = activeCall({
      id: "simultaneous-21",
      viptelUniqueId: "provider-21",
      destinationExtension: "21",
      startedAt: "2026-08-11T08:30:00.000Z",
    });

    const stations = buildWorkplaceStations(modelInput([second, first]));

    expect(stations[0].activeCalls.map((call) => call.id)).toEqual(["simultaneous-20"]);
    expect(stations[1].activeCalls.map((call) => call.id)).toEqual(["simultaneous-21"]);
    expect(buildWorkplaceWaitingRoom([second, first], stations).map((entry) => entry.call.id).sort()).toEqual([
      "simultaneous-20",
      "simultaneous-21",
    ]);
    expect(stations[0].state).toBe("ringing");
    expect(stations[1].state).toBe("ringing");
  });

  it("counts duplicate VIPTel legs of one queue call only once", () => {
    const firstLeg = activeCall({
      id: "same-call-first-leg",
      viptelUniqueId: "agent-leg-21-a",
      fromQueueUniqueId: "queue-parent-21",
      destinationExtension: "21",
    });
    const duplicateLeg = activeCall({
      id: "same-call-second-leg",
      viptelUniqueId: "agent-leg-21-b",
      fromQueueUniqueId: "queue-parent-21",
      destinationExtension: "21",
    });

    const stations = buildWorkplaceStations(modelInput([firstLeg, duplicateLeg]));

    expect(stations[1].activeCalls).toHaveLength(1);
    expect(buildWorkplaceWaitingRoom([firstLeg, duplicateLeg], stations)).toHaveLength(1);
  });

  it("keeps only waiting calls in the shared waiting room and shows an exact ringing station", () => {
    const unassigned = activeCall({
      id: "waiting-unassigned",
      status: "incoming",
      calledNumber: "601",
      destinationExtension: undefined,
      startedAt: "2026-08-11T08:29:58.000Z",
    });
    const ringing = activeCall({
      id: "waiting-at-21",
      status: "ringing_agent",
      destinationExtension: "21",
      startedAt: "2026-08-11T08:29:59.000Z",
    });
    const answered = activeCall({
      id: "already-answered",
      status: "answered",
      destinationExtension: "20",
    });
    const stations = buildWorkplaceStations(modelInput([ringing, answered, unassigned]));

    expect(buildWorkplaceWaitingRoom([ringing, answered, unassigned], stations).map((entry) => ({
      id: entry.call.id,
      station: entry.station?.extension,
    }))).toEqual([
      { id: "waiting-unassigned", station: undefined },
      { id: "waiting-at-21", station: "21" },
    ]);
  });

  it("keeps both confirmed endpoints of an internal transfer path", () => {
    const call = activeCall({
      direction: "internal",
      status: "answered",
      callerExtension: "20",
      destinationExtension: "21",
    });
    const stations = buildWorkplaceStations(modelInput([call]));
    const route = buildWorkplaceCallRoute(call, stations);

    expect(route.steps.map((step) => step.station.extension)).toEqual(["20", "21"]);
    expect(stations[0].state).toBe("on_call");
    expect(stations[1].state).toBe("on_call");
  });

  it("fails closed when presence is stale or the three queue slots are ambiguous", () => {
    const staleHealth: TelephonyHealthSignal = { state: "stale", detail: "Staré údaje" };
    const staleStations = buildWorkplaceStations({ ...modelInput(), health: staleHealth });
    expect(staleStations.every((station) => station.state === "unverified")).toBe(true);
    expect(getWorkplaceRoutingStatus(staleStations, staleHealth, snapshot(), fullPlan()).verified).toBe(false);

    const duplicateSnapshot = snapshot();
    duplicateSnapshot.queueStatuses[0].members.push(queueMember("21"));
    const ambiguousStations = buildWorkplaceStations({ ...modelInput(), snapshot: duplicateSnapshot });
    expect(getWorkplaceRoutingStatus(ambiguousStations, liveHealth, duplicateSnapshot, fullPlan())).toMatchObject({ verified: false });

    const extraMemberSnapshot = snapshot();
    extraMemberSnapshot.queueStatuses[2].members.push(queueMember("99"));
    const extraMemberStations = buildWorkplaceStations({ ...modelInput(), snapshot: extraMemberSnapshot });
    expect(getWorkplaceRoutingStatus(extraMemberStations, liveHealth, extraMemberSnapshot, fullPlan())).toMatchObject({ verified: false });
  });

  it("verifies a single active first operator without requiring empty priorities to be staffed", () => {
    const singleSnapshot = snapshot();
    singleSnapshot.queueStatuses[1].members = [];
    singleSnapshot.queueStatuses[2].members = [];
    const singleOperators = operators.slice(0, 1);
    const singlePresences = presences().slice(0, 1);
    const stations = buildWorkplaceStations({
      activeCalls: [],
      health: liveHealth,
      operators: singleOperators,
      operatorPresences: singlePresences,
      snapshot: singleSnapshot,
    });

    expect(getWorkplaceRoutingStatus(stations, liveHealth, singleSnapshot, [
      { queue: "601", extension: "20" },
      { queue: "602", extension: null },
      { queue: "603", extension: null },
    ])).toMatchObject({
      verified: true,
      detail: expect.stringContaining("prvého operátora"),
    });
  });

  it("excludes paused and unregistered future operators from the inbound route", () => {
    const futureSnapshot = snapshot();
    futureSnapshot.queueStatuses[1].members[0].paused = true;
    futureSnapshot.extensions[2].registered = false;
    const futurePresences = presences();
    futurePresences[1] = {
      ...futurePresences[1],
      state: "paused",
      available: false,
      availableQueues: [],
      paused: true,
      detail: "Prijímanie hovorov je pozastavené.",
    };
    futurePresences[2] = {
      ...futurePresences[2],
      state: "unregistered",
      available: false,
      availableQueues: [],
      registered: false,
      detail: "Interná linka nie je pripojená.",
    };
    const call = activeCall({
      direction: "inbound",
      status: "ringing_agent",
      receivedExtension: "20",
      destinationExtension: "20",
    });
    const stations = buildWorkplaceStations({
      activeCalls: [call],
      health: liveHealth,
      operators,
      operatorPresences: futurePresences,
      snapshot: futureSnapshot,
    });

    const route = buildWorkplaceCallRoute(call, stations);

    expect(stations[1].state).toBe("paused");
    expect(stations[2].state).toBe("disconnected");
    expect(route.steps.map((step) => step.station.extension)).toEqual(["20"]);
  });

  it("names the exact occupied and empty queues for a gap snapshot without inventing a first operator", () => {
    const gapSnapshot = snapshot();
    gapSnapshot.queueStatuses[0].members = [];
    const stations = buildWorkplaceStations({ ...modelInput(), snapshot: gapSnapshot });

    const status = getWorkplaceRoutingStatus(stations, liveHealth, gapSnapshot, [
      { queue: "601", extension: null },
      { queue: "602", extension: "21" },
      { queue: "603", extension: "22" },
    ]);

    expect(status).toEqual({
      verified: true,
      detail: "VIPTel potvrdil členstvo radov 602 a 603; rad 601 je bez operátora.",
    });
    expect(status.detail).not.toContain("prv");
  });

  it("never labels an unowned but registered or previously used SIP identity as free", () => {
    const unsafeSnapshot = snapshot();
    unsafeSnapshot.extensions[3] = {
      ...unsafeSnapshot.extensions[3],
      registered: true,
      assignmentRequirement: "rotation_required",
    };
    const stations = buildWorkplaceStations({ ...modelInput(), snapshot: unsafeSnapshot });

    expect(stations[3]).toMatchObject({ state: "unverified" });
    expect(stations[3].stateDetail).toContain("stále hlási ako registrovanú");
  });

  it("keeps a confirmed inbound target outside queues visible as the current destination", () => {
    const call = activeCall({ status: "ringing_agent", receivedExtension: "20", destinationExtension: "23" });
    const stations = buildWorkplaceStations(modelInput([call]));
    const route = buildWorkplaceCallRoute(call, stations);

    expect(route.currentStation?.extension).toBe("23");
    expect(route.mode).toBe("transfer");
    expect(route.steps.map((step) => step.station.extension)).toEqual(["20", "23"]);
    expect(route.steps.at(-1)).toMatchObject({ station: { extension: "23" }, state: "current" });
    expect(stations[3].state).toBe("ringing");
  });

  it("lets a directional endpoint override a stale operator id for call controls", () => {
    const call = activeCall({
      status: "ringing_agent",
      operatorId: "op-20",
      receivedExtension: "20",
      destinationExtension: "21",
    });
    const identities = [
      { extension: "20", profileId: "op-20" },
      { extension: "21", profileId: "op-21" },
    ];

    expect(callIsCurrentAtTelephonyStation(call, identities[0], identities)).toBe(false);
    expect(callIsCurrentAtTelephonyStation(call, identities[1], identities)).toBe(true);

    const endpointOnlyCall = { ...call, receivedExtension: undefined };
    const stations = buildWorkplaceStations(modelInput([endpointOnlyCall]));
    expect(stations[0].activeCalls).toHaveLength(0);
    expect(stations[1].activeCalls).toHaveLength(1);
  });
});

function modelInput(activeCalls: CallCenterCall[] = []) {
  return {
    activeCalls,
    health: liveHealth,
    operators,
    operatorPresences: presences(),
    snapshot: snapshot(),
  };
}

function snapshot(): TelephonyPresenceSnapshot {
  return {
    actorProfileId: "op-20",
    canManageAssignments: false,
    checkedAt: "2026-08-05T12:00:00.000Z",
    extensions: [
      extension("20", "op-20"),
      extension("21", "op-21"),
      extension("22", "op-22"),
      extension("23"),
    ],
    queues: [
      { id: "601", name: "Prvý rad" },
      { id: "602", name: "Druhý rad" },
      { id: "603", name: "Tretí rad" },
    ],
    queueStatuses: [
      { queue: "601", waitingCalls: 0, members: [queueMember("20")] },
      { queue: "602", waitingCalls: 0, members: [queueMember("21")] },
      { queue: "603", waitingCalls: 0, members: [queueMember("22")] },
    ],
  };
}

function fullPlan() {
  return [
    { queue: "601" as const, extension: "20" },
    { queue: "602" as const, extension: "21" },
    { queue: "603" as const, extension: "22" },
  ];
}

function extension(extensionNumber: string, profileId?: string) {
  return {
    id: `ext-${extensionNumber}`,
    profileId,
    extension: extensionNumber,
    active: true,
    assignmentEligible: true,
    assignmentRequirement: profileId ? "rotation_required" as const : "initial_provisioning" as const,
    registered: Boolean(profileId),
    allowedChanges: [],
  };
}

function queueMember(extensionNumber: string) {
  return { extension: extensionNumber, paused: false, inUse: false, dynamic: true, callsTaken: 0 };
}

function presences(): TelephonyOperatorPresence[] {
  return operators.map((operator) => ({
    profileId: operator.id,
    operatorName: operator.name,
    extensions: [operator.extension],
    primaryExtension: operator.extension,
    state: "available",
    available: true,
    queueMember: true,
    queueNumbers: [String(601 + Number(operator.extension) - 20)],
    availableQueues: [String(601 + Number(operator.extension) - 20)],
    paused: false,
    inUse: false,
    registered: true,
    detail: "Pripravený",
  }));
}

function activeCall(overrides: Partial<CallCenterCall>): CallCenterCall {
  return {
    id: "call-1",
    status: "incoming",
    direction: "inbound",
    callerNumber: "+421900111222",
    calledNumber: "+421412289240",
    lineLabel: "Allianz Assistance",
    startedAt: "2026-08-05T11:59:45.000Z",
    waitSeconds: 15,
    recordingStatus: "not_requested",
    transcriptStatus: "not_requested",
    history: [],
    ...overrides,
  };
}
