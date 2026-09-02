import { describe, expect, it } from "vitest";
import type { Operator } from "@/domain/types";
import {
  deriveTelephonyOperatorPresences,
  type TelephonyPresenceSnapshot,
} from "@/lib/telephony/presence";

const operators: Operator[] = [
  { id: "op-1", name: "Alena", extension: "", status: "available" },
  { id: "op-2", name: "Boris", extension: "", status: "available" },
];

function snapshot(overrides: Partial<TelephonyPresenceSnapshot> = {}): TelephonyPresenceSnapshot {
  return {
    actorProfileId: "op-1",
    canManageAssignments: false,
    checkedAt: "2026-09-02T10:00:00.000Z",
    devices: [],
    presence: [],
    ...overrides,
  };
}

function stateOf(input: TelephonyPresenceSnapshot | null, profileId = "op-1") {
  const presence = deriveTelephonyOperatorPresences({ operators, snapshot: input }).find(
    (entry) => entry.profileId === profileId,
  );
  if (!presence) throw new Error(`missing presence for ${profileId}`);
  return presence;
}

describe("deriveTelephonyOperatorPresences", () => {
  it("returns one entry per operator in input order and marks operators without a presence row as unassigned", () => {
    const result = deriveTelephonyOperatorPresences({ operators, snapshot: snapshot() });

    expect(result.map((entry) => entry.profileId)).toEqual(["op-1", "op-2"]);
    expect(result.map((entry) => entry.state)).toEqual(["unassigned", "unassigned"]);
    expect(result[0]).toMatchObject({
      operatorName: "Alena",
      available: false,
      queueMember: false,
      registered: false,
      inUse: false,
      paused: false,
      checkedAt: "2026-09-02T10:00:00.000Z",
    });
  });

  it("treats a missing snapshot as unassigned without a checkedAt", () => {
    expect(stateOf(null)).toMatchObject({ state: "unassigned", checkedAt: undefined });
  });

  it("is available only with a registered device and an available presence row", () => {
    const entry = stateOf(
      snapshot({
        devices: [{ profileId: "op-1", registered: true, seenAt: "2026-09-02T09:59:50.000Z" }],
        presence: [{ profileId: "op-1", status: "available" }],
      }),
    );

    expect(entry).toMatchObject({ state: "available", available: true, registered: true, queueMember: true });
  });

  it.each([
    ["no device row", []],
    ["an unregistered device", [{ profileId: "op-1", registered: false }]],
  ])("reports unregistered when the operator is available but has %s", (_label, devices) => {
    const entry = stateOf(snapshot({ devices, presence: [{ profileId: "op-1", status: "available" }] }));

    expect(entry).toMatchObject({ state: "unregistered", available: false, registered: false });
  });

  it.each([
    ["ringing", "ringing"],
    ["on_call", "on_call"],
  ] as const)("keeps the live call state %s even when the device heartbeat lapsed", (status, expected) => {
    const entry = stateOf(
      snapshot({
        devices: [{ profileId: "op-1", registered: false }],
        presence: [{ profileId: "op-1", status, currentSessionId: "session-1" }],
      }),
    );

    expect(entry).toMatchObject({ state: expected, inUse: true, available: false });
  });

  it("marks an operator with a current session as in use", () => {
    const entry = stateOf(
      snapshot({
        devices: [{ profileId: "op-1", registered: true }],
        presence: [{ profileId: "op-1", status: "available", currentSessionId: "session-9" }],
      }),
    );

    expect(entry.inUse).toBe(true);
  });

  it.each(["paused", "after_call_work"] as const)("maps %s to the paused state", (status) => {
    const entry = stateOf(
      snapshot({
        devices: [{ profileId: "op-1", registered: true }],
        presence: [{ profileId: "op-1", status }],
      }),
    );

    expect(entry).toMatchObject({ state: "paused", paused: true, available: false });
  });

  it("gives an explicit offline presence precedence over device registration", () => {
    const entry = stateOf(
      snapshot({
        devices: [{ profileId: "op-1", registered: true }],
        presence: [{ profileId: "op-1", status: "offline" }],
      }),
    );

    expect(entry).toMatchObject({ state: "offline", queueMember: true, registered: true });
  });

  it("does not leak one operator's presence onto another", () => {
    const input = snapshot({
      devices: [{ profileId: "op-1", registered: true }],
      presence: [{ profileId: "op-1", status: "on_call", currentSessionId: "session-1" }],
    });

    expect(stateOf(input, "op-1").state).toBe("on_call");
    expect(stateOf(input, "op-2").state).toBe("unassigned");
  });

  it.each([
    ["degraded", "error"],
    ["unavailable", "error"],
    ["stale", "stale"],
    ["checking", "stale"],
  ] as const)("overrides every operator with %s health as %s and surfaces the health detail", (state, expected) => {
    const result = deriveTelephonyOperatorPresences({
      operators,
      snapshot: snapshot({
        devices: [{ profileId: "op-1", registered: true }],
        presence: [{ profileId: "op-1", status: "available" }],
      }),
      health: { state, detail: "Telefónia neodpovedá.", checkedAt: "2026-09-02T10:00:05.000Z" },
    });

    expect(result.map((entry) => entry.state)).toEqual([expected, expected]);
    expect(result[0].detail).toBe("Telefónia neodpovedá.");
    expect(result[0].available).toBe(false);
  });

  it("does not let live health hide the derived state and falls back to health timestamps for checkedAt", () => {
    const [entry] = deriveTelephonyOperatorPresences({
      operators: operators.slice(0, 1),
      snapshot: null,
      health: {
        state: "live",
        detail: "OK",
        checkedAt: "2026-09-02T10:00:05.000Z",
        lastSuccessAt: "2026-09-02T10:00:04.000Z",
      },
    });

    expect(entry).toMatchObject({ state: "unassigned", checkedAt: "2026-09-02T10:00:04.000Z" });
  });
});
