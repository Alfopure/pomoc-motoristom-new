import { describe, expect, it } from "vitest";

import type { Operator } from "@/domain/types";
import type { TelephonyHealthSignal } from "./health";
import { deriveTelephonyOperatorPresences, type TelephonyPresenceSnapshot } from "./presence";

const operators: Operator[] = [
  { id: "operator-1", name: "Anna", extension: "12", status: "offline" },
  { id: "operator-2", name: "Boris", extension: "13", status: "offline" },
];
const liveHealth: TelephonyHealthSignal = { state: "live", detail: "live", checkedAt: "2026-07-25T10:00:00.000Z" };

describe("derived telephony operator presence", () => {
  it("marks an operator available only when owned, active, queued, unpaused, unused and registered", () => {
    const snapshot = makeSnapshot({
      extensions: [
        extension("extension-1", "operator-1", "12", true),
        extension("extension-2", "operator-2", "13", false),
      ],
      members: [
        { extension: "12", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
        { extension: "13", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
      ],
    });

    const result = deriveTelephonyOperatorPresences({ operators, snapshot, activeCalls: [], health: liveHealth });

    expect(result[0]).toMatchObject({ state: "available", available: true, queueMember: true, registered: true });
    expect(result[1]).toMatchObject({ state: "unregistered", available: false, queueMember: true, registered: false });
  });

  it("gives active calls precedence over availability", () => {
    const snapshot = makeSnapshot({
      extensions: [extension("extension-1", "operator-1", "12", true)],
      members: [{ extension: "12", paused: false, inUse: false, dynamic: true, callsTaken: 0 }],
    });
    const activeCalls = [
      {
        id: "call-1",
        status: "answered" as const,
        direction: "outbound" as const,
        callerNumber: "12",
        calledNumber: "0900000000",
        lineLabel: "VIPTel",
        startedAt: "2026-07-25T10:00:00.000Z",
        waitSeconds: 0,
        recordingStatus: "not_requested" as const,
        transcriptStatus: "not_requested" as const,
        history: [],
      },
    ];

    const [presence] = deriveTelephonyOperatorPresences({ operators: operators.slice(0, 1), snapshot, activeCalls, health: liveHealth });

    expect(presence).toMatchObject({ state: "on_call", available: false, inUse: true });
  });

  it("marks the destination extension as ringing when the caller number belongs to the client", () => {
    const snapshot = makeSnapshot({
      extensions: [extension("extension-1", "operator-1", "12", true)],
      members: [{ extension: "12", paused: false, inUse: false, dynamic: true, callsTaken: 0 }],
    });
    const activeCalls = [
      {
        id: "call-destination-extension",
        status: "ringing_agent" as const,
        direction: "inbound" as const,
        callerNumber: "+421900123456",
        calledNumber: "0412289241",
        destinationExtension: "12",
        lineLabel: "Allianz Assistance",
        startedAt: "2026-07-25T10:00:00.000Z",
        waitSeconds: 8,
        recordingStatus: "not_requested" as const,
        transcriptStatus: "not_requested" as const,
        history: [],
      },
    ];

    const [presence] = deriveTelephonyOperatorPresences({
      operators: operators.slice(0, 1),
      snapshot,
      activeCalls,
      health: liveHealth,
    });

    expect(presence).toMatchObject({ state: "ringing", available: false, inUse: true });
  });

  it("marks the caller extension as busy during an outbound call", () => {
    const snapshot = makeSnapshot({
      extensions: [extension("extension-1", "operator-1", "12", true)],
      members: [{ extension: "12", paused: false, inUse: false, dynamic: true, callsTaken: 0 }],
    });
    const activeCalls = [
      {
        id: "call-caller-extension",
        status: "outbound" as const,
        direction: "outbound" as const,
        callerNumber: "0412289240",
        callerExtension: "12",
        calledNumber: "+421900654321",
        lineLabel: "VIPTel",
        startedAt: "2026-07-25T10:00:00.000Z",
        waitSeconds: 0,
        recordingStatus: "not_requested" as const,
        transcriptStatus: "not_requested" as const,
        history: [],
      },
    ];

    const [presence] = deriveTelephonyOperatorPresences({
      operators: operators.slice(0, 1),
      snapshot,
      activeCalls,
      health: liveHealth,
    });

    expect(presence).toMatchObject({ state: "on_call", available: false, inUse: true });
  });

  it("uses the directional destination instead of a stale received extension and operator id", () => {
    const snapshot = makeSnapshot({
      extensions: [
        extension("extension-1", "operator-1", "12", true),
        extension("extension-2", "operator-2", "13", true),
      ],
      members: [
        { extension: "12", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
        { extension: "13", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
      ],
    });
    const activeCalls = [
      {
        id: "call-conflicting-endpoints",
        status: "ringing_agent" as const,
        direction: "inbound" as const,
        callerNumber: "+421900123456",
        calledNumber: "0412289241",
        receivedExtension: "12",
        destinationExtension: "13",
        operatorId: "operator-1",
        lineLabel: "Allianz Assistance",
        startedAt: "2026-07-25T10:00:00.000Z",
        waitSeconds: 8,
        recordingStatus: "not_requested" as const,
        transcriptStatus: "not_requested" as const,
        history: [],
      },
    ];

    const result = deriveTelephonyOperatorPresences({ operators, snapshot, activeCalls, health: liveHealth });

    expect(result[0]).toMatchObject({ state: "available", inUse: false });
    expect(result[1]).toMatchObject({ state: "ringing", inUse: true });
  });

  it("marks all derived states as errors when the provider snapshot is not trustworthy", () => {
    const snapshot = makeSnapshot({
      extensions: [extension("extension-1", "operator-1", "12", true)],
      members: [{ extension: "12", paused: false, inUse: false, dynamic: true, callsTaken: 0 }],
    });
    const health: TelephonyHealthSignal = { state: "degraded", detail: "VIPTel timeout", lastSuccessAt: snapshot.checkedAt };

    const [presence] = deriveTelephonyOperatorPresences({ operators: operators.slice(0, 1), snapshot, activeCalls: [], health });

    expect(presence).toMatchObject({ state: "error", available: false, detail: "VIPTel timeout" });
  });
});

function extension(id: string, profileId: string, number: string, registered: boolean) {
  return {
    id,
    profileId,
    extension: number,
    active: true,
    registered,
    allowedChanges: [],
  };
}

function makeSnapshot(input: {
  extensions: TelephonyPresenceSnapshot["extensions"];
  members: TelephonyPresenceSnapshot["queueStatuses"][number]["members"];
}): TelephonyPresenceSnapshot {
  return {
    actorProfileId: "operator-1",
    canManageAssignments: false,
    checkedAt: "2026-07-25T10:00:00.000Z",
    extensions: input.extensions,
    queues: [{ id: "500", name: "Dispatch" }],
    queueStatuses: [{ queue: "500", waitingCalls: 0, members: input.members }],
  };
}
