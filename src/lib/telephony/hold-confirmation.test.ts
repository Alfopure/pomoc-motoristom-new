import { describe, expect, it } from "vitest";

import { phoneBarStateLabel } from "@/components/dispatch/phone-bar-model";

import { buildPhoneBarModel, type ActiveCallPayload, type ActiveCallsPayload } from "./active-calls-model";
import { applyHoldConfirmation, holdConfirmation, HOLD_CONFIRMATION_TTL_MS } from "./hold-confirmation";

const ME = "profile-me";
const AT = Date.parse("2026-11-02T10:00:00.000Z");

function call(overrides: Partial<ActiveCallPayload> = {}): ActiveCallPayload {
  return {
    sessionId: "sess-1", callId: "call-1", state: "talking", direction: "inbound", callerNumber: "+421900111222", calledNumber: "+421232408700",
    lineId: "line-1", lineLabel: "Allianz Assistance", partnerName: "Allianz", caseId: null, match: null,
    startedAt: "2026-11-02T09:59:00.000Z", answeredAt: "2026-11-02T09:59:10.000Z", answeredByProfileId: ME, holdStartedAt: null,
    parkedAt: null, parkedByProfileId: null, waitingSince: null, waitingReason: null, waitingMaxMinutes: null, currentStep: 1,
    ringMode: "all", offeredProfileIds: [], legs: [], mine: true, ...overrides,
  };
}

function snapshot(row: ActiveCallPayload): ActiveCallsPayload {
  return {
    checkedAt: "2026-11-02T10:00:00.000Z", configured: true, organizationId: "org-1", actorProfileId: ME, calls: [row], waiting: [],
    presence: { actorProfileId: ME, canManageAssignments: false, checkedAt: "2026-11-02T10:00:00.000Z", devices: [], presence: [] },
    ownPresence: null,
  };
}

const label = (payload: ActiveCallsPayload) => phoneBarStateLabel(buildPhoneBarModel(payload).active!).label;

describe("hold confirmation (call-speed S7a.1, hold_fast_web)", () => {
  it("exists only for a server-confirmed hold or unhold", () => {
    expect(holdConfirmation("hold", "sess-1", { confirmedState: "held", ignored: null }, AT)).toEqual({ sessionId: "sess-1", action: "hold", state: "held", at: AT });
    expect(holdConfirmation("unhold", "sess-1", { confirmedState: "talking" }, AT)).toMatchObject({ state: "talking" });
    // Switch off: the server sends no confirmation, so nothing changes locally.
    expect(holdConfirmation("hold", "sess-1", { ignored: null }, AT)).toBeNull();
    expect(holdConfirmation("hold", "sess-1", { confirmedState: "talking" }, AT)).toBeNull();
    expect(holdConfirmation("hold", "sess-1", { confirmedState: "held", ignored: "duplicate" }, AT)).toBeNull();
    expect(holdConfirmation("park", "sess-1", { confirmedState: "held" }, AT)).toBeNull();
  });

  it("shows Podržaný before a refresh can answer, over a snapshot taken before the change", () => {
    const confirmation = holdConfirmation("hold", "sess-1", { confirmedState: "held" }, AT);
    const pending = snapshot(call({ state: "held", controlPending: { action: "hold", startedAt: "2026-11-02T09:59:59.500Z", failed: false } }));
    expect(label(pending)).toBe("Podržiavam…");
    const applied = applyHoldConfirmation(pending, confirmation, AT);
    expect(applied.keep).toBe(true);
    expect(label(applied.snapshot)).toBe("Podržaný");
    expect(applied.snapshot.calls[0]).toMatchObject({ state: "held", controlPending: null, holdStartedAt: "2026-11-02T10:00:00.000Z" });
    // A pass that started before the hold was staged at all.
    expect(label(applyHoldConfirmation(snapshot(call()), confirmation, AT + 1_000).snapshot)).toBe("Podržaný");
  });

  it("shows Prebieha after a confirmed unhold", () => {
    const confirmation = holdConfirmation("unhold", "sess-1", { confirmedState: "talking" }, AT);
    const stale = snapshot(call({ state: "held", holdStartedAt: "2026-11-02T09:59:30.000Z" }));
    expect(label(applyHoldConfirmation(stale, confirmation, AT).snapshot)).toBe("Prebieha");
    expect(applyHoldConfirmation(stale, confirmation, AT).snapshot.calls[0].holdStartedAt).toBeNull();
  });

  it("is spent once a snapshot shows the confirmed state, anything else, or after its TTL", () => {
    const confirmation = holdConfirmation("hold", "sess-1", { confirmedState: "held" }, AT);
    const converged = snapshot(call({ state: "held", holdStartedAt: "2026-11-02T10:00:00.200Z" }));
    expect(applyHoldConfirmation(converged, confirmation, AT + 500)).toEqual({ snapshot: converged, keep: false });
    const ended = snapshot(call({ state: "wrap_up" }));
    expect(applyHoldConfirmation(ended, confirmation, AT + 500)).toEqual({ snapshot: ended, keep: false });
    const gone = { ...snapshot(call()), calls: [] };
    expect(applyHoldConfirmation(gone, confirmation, AT + 500)).toEqual({ snapshot: gone, keep: false });
    const stale = snapshot(call());
    expect(applyHoldConfirmation(stale, confirmation, AT + HOLD_CONFIRMATION_TTL_MS + 1)).toEqual({ snapshot: stale, keep: false });
    expect(applyHoldConfirmation(stale, null, AT)).toEqual({ snapshot: stale, keep: false });
  });
});
