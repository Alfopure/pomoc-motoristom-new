import { describe, expect, it } from "vitest";
import { EMPTY_ACTIVE_CALLS, type ActiveCallPayload, type ActiveCallsPayload } from "./active-calls-model";
import { hangupSnapshotConfirmsEnd, type HangupSnapshotScope } from "./hangup-confirmation";

const pending: HangupSnapshotScope = { sessionId: "ending", organizationId: "org", actorProfileId: "actor", afterSnapshotRequest: 4 };
const empty: ActiveCallsPayload = { ...EMPTY_ACTIVE_CALLS, configured: true, organizationId: "org", actorProfileId: "actor" };
const call = (state: ActiveCallPayload["state"], sessionId = "ending") => ({ sessionId, state }) as ActiveCallPayload;

describe("hangup snapshot confirmation", () => {
  it("does not reuse an absent snapshot requested before the click, even if it arrives later", () => {
    expect(hangupSnapshotConfirmsEnd(pending, empty, 3)).toBe(false);
    expect(hangupSnapshotConfirmsEnd(pending, empty, 4)).toBe(false);
    expect(hangupSnapshotConfirmsEnd(pending, empty, 5)).toBe(true);
  });

  it("checks both active calls and the waiting room before retiring the old session", () => {
    expect(hangupSnapshotConfirmsEnd(pending, { ...empty, waiting: [call("parked")] }, 5)).toBe(false);
    expect(hangupSnapshotConfirmsEnd(pending, { ...empty, calls: [call("talking")] }, 5)).toBe(false);
    expect(hangupSnapshotConfirmsEnd(pending, { ...empty, calls: [call("talking", "new-call")] }, 5)).toBe(true);
  });

  it("does not mistake wrap-up or an active duplicate for terminal evidence", () => {
    expect(hangupSnapshotConfirmsEnd(pending, { ...empty, calls: [call("wrap_up")] }, 5)).toBe(false);
    expect(hangupSnapshotConfirmsEnd(pending, { ...empty, calls: [call("ended")], waiting: [call("waiting")] }, 5)).toBe(false);
  });

  it.each(["ended", "missed", "failed"] as const)("accepts a fresh explicit %s session", (state) => {
    expect(hangupSnapshotConfirmsEnd(pending, { ...empty, calls: [call(state)] }, 5)).toBe(true);
  });

  it("requires the same configured organization and actor, including while account state changes", () => {
    for (const snapshot of [
      { ...empty, configured: false }, { ...empty, organizationId: "other" }, { ...empty, actorProfileId: "other" },
      { ...empty, waiting: undefined } as unknown as ActiveCallsPayload,
    ]) expect(hangupSnapshotConfirmsEnd(pending, snapshot, 5)).toBe(false);
    expect(hangupSnapshotConfirmsEnd({ ...pending, organizationId: "" }, empty, 5)).toBe(false);
  });
});
