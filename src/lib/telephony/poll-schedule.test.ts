import { describe, expect, it } from "vitest";

import {
  ACTIVE_CALL_POLL_MS,
  activeCallPollDelayMs,
  POLL_BACKOFF_MAX_MS,
  REALTIME_ACTIVE_CALL_POLL_MS,
  callbackPollDelayMs,
  supportPollDelayMs,
  takeoverPollDelayMs,
  telephonyPollActivity,
  wallboardPollDelayMs,
} from "./poll-schedule";

describe("poll cadence with Realtime connected", () => {
  it("relaxes to 3 s while engaged and 10 s while idle", () => {
    // Broadcast delivers the change; polling is only the safety net now.
    expect(activeCallPollDelayMs({ activity: "in_call", documentHidden: false, realtimeConnected: true })).toBe(3_000);
    expect(activeCallPollDelayMs({ activity: "ringing", documentHidden: false, realtimeConnected: true })).toBe(3_000);
    expect(activeCallPollDelayMs({ activity: "idle", documentHidden: false, realtimeConnected: true })).toBe(10_000);
  });

  it("never polls faster than the polling-only cadence", () => {
    for (const activity of ["in_call", "ringing", "idle"] as const) {
      for (const documentHidden of [false, true]) {
        expect(activeCallPollDelayMs({ activity, documentHidden, realtimeConnected: true }))
          .toBeGreaterThanOrEqual(activeCallPollDelayMs({ activity, documentHidden }));
      }
    }
  });

  it("returns to the fast cadence the moment the channel is not connected", () => {
    // CLOSED / CHANNEL_ERROR must be indistinguishable from "never connected":
    // a stale console during a live call is the failure we cannot ship.
    expect(activeCallPollDelayMs({ activity: "in_call", documentHidden: false, realtimeConnected: false })).toBe(750);
    expect(activeCallPollDelayMs({ activity: "idle", documentHidden: false, realtimeConnected: false })).toBe(2_000);
  });

  it("still keeps a hidden tab slower than a visible one", () => {
    expect(activeCallPollDelayMs({ activity: "idle", documentHidden: true, realtimeConnected: true }))
      .toBe(REALTIME_ACTIVE_CALL_POLL_MS.idleHidden);
    expect(REALTIME_ACTIVE_CALL_POLL_MS.idleHidden).toBeGreaterThan(REALTIME_ACTIVE_CALL_POLL_MS.idleVisible);
  });

  it("keeps backing off on failures while connected", () => {
    const healthy = activeCallPollDelayMs({ activity: "idle", documentHidden: false, realtimeConnected: true });
    const failing = activeCallPollDelayMs({
      activity: "idle",
      documentHidden: false,
      realtimeConnected: true,
      consecutiveFailures: 3,
      random: () => 0.5,
    });
    expect(failing).toBeGreaterThan(healthy);
    expect(failing).toBeLessThanOrEqual(POLL_BACKOFF_MAX_MS);
  });
});

describe("active call poll cadence", () => {
  it("keeps a live call in a visible tab at the original 750 ms", () => {
    // Responsiveness where a human is watching a call must not regress.
    for (const activity of ["in_call", "ringing"] as const) {
      expect(activeCallPollDelayMs({ activity, documentHidden: false })).toBe(750);
    }
  });

  it("slows a hidden tab hard, in every activity", () => {
    expect(activeCallPollDelayMs({ activity: "in_call", documentHidden: true }))
      .toBeGreaterThan(activeCallPollDelayMs({ activity: "in_call", documentHidden: false }));
    expect(activeCallPollDelayMs({ activity: "idle", documentHidden: true })).toBe(15_000);
  });

  it("does not poll idle faster than the server-side snapshot cache", () => {
    // /api/telephony/calls/active reuses one org-wide provider snapshot for
    // 3 s, so sub-second idle polling cannot return fresher data.
    expect(activeCallPollDelayMs({ activity: "idle", documentHidden: false })).toBe(2_000);
    expect(ACTIVE_CALL_POLL_MS.idleVisible).toBeGreaterThan(1_000);
  });

  it("treats a ringing call as engaged even before it is answered", () => {
    // That is exactly when the operator needs the fastest updates.
    expect(telephonyPollActivity({ hasBrowserCall: false, liveCallCount: 1 })).toBe("ringing");
    expect(telephonyPollActivity({ hasBrowserCall: true, liveCallCount: 0 })).toBe("in_call");
    expect(telephonyPollActivity({ hasBrowserCall: false, liveCallCount: 0 })).toBe("idle");
  });
});

describe("poll backoff", () => {
  it("backs off a failing endpoint instead of hammering it", () => {
    const healthy = activeCallPollDelayMs({ activity: "idle", documentHidden: false });
    const failing = activeCallPollDelayMs({
      activity: "idle",
      documentHidden: false,
      consecutiveFailures: 4,
      random: () => 0.5,
    });
    expect(failing).toBeGreaterThan(healthy);
  });

  it("never backs off past the ceiling, nor below the healthy cadence", () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
      const delay = activeCallPollDelayMs({
        activity: "in_call",
        documentHidden: false,
        consecutiveFailures: 50,
        random,
      });
      expect(delay).toBeGreaterThanOrEqual(ACTIVE_CALL_POLL_MS.engagedVisible);
      expect(delay).toBeLessThanOrEqual(POLL_BACKOFF_MAX_MS);
    }
  });

  it("returns the plain cadence once a request succeeds again", () => {
    expect(activeCallPollDelayMs({ activity: "idle", documentHidden: false, consecutiveFailures: 0 }))
      .toBe(ACTIVE_CALL_POLL_MS.idleVisible);
  });
});

describe("support and takeover cadence", () => {
  it("keeps support reads at their original visible rate", () => {
    expect(supportPollDelayMs({ documentHidden: false })).toBe(10_000);
    expect(supportPollDelayMs({ documentHidden: true })).toBe(30_000);
  });

  it("polls the wallboard no faster than the snapshot it reads is cached", () => {
    // The server serves one snapshot per organisation for 5 s; a faster poll
    // would return the identical bytes to every wall display in the building.
    expect(wallboardPollDelayMs({ documentHidden: false })).toBe(5_000);
    expect(wallboardPollDelayMs({ documentHidden: true })).toBe(60_000);
    // A failing endpoint backs off instead of being hammered by a screen
    // nobody is standing in front of.
    expect(wallboardPollDelayMs({ documentHidden: false, consecutiveFailures: 3, random: () => 0.5 })).toBeGreaterThan(5_000);
  });

  it("keeps the callback queue gentle and gates it on visibility", () => {
    // A promise to ring somebody back is a tens-of-minutes affair and each poll
    // is four Supabase queries; a console left open overnight must not run at
    // the visible rate.
    expect(callbackPollDelayMs({ documentHidden: false })).toBe(30_000);
    expect(callbackPollDelayMs({ documentHidden: true })).toBe(120_000);
    // Its base already sits at the backoff ceiling, so a failing endpoint is
    // never polled faster than 30 s and never slower than the hidden cadence.
    expect(callbackPollDelayMs({ documentHidden: false, consecutiveFailures: 3, random: () => 0.5 })).toBe(30_000);
    expect(callbackPollDelayMs({ documentHidden: true, consecutiveFailures: 3, random: () => 0.5 })).toBeLessThanOrEqual(120_000);
  });

  it("stays fast only while a handover decision is actually open", () => {
    // The decision window is 30 s, so an open request must stay responsive.
    expect(takeoverPollDelayMs({ hasOpenRequest: true, documentHidden: false })).toBe(4_000);
    // With nothing in flight this is just a "has anything appeared?" check; it
    // used to run at a flat 4 s and was the second-noisiest poll in the console.
    expect(takeoverPollDelayMs({ hasOpenRequest: false, documentHidden: false })).toBe(20_000);
    expect(takeoverPollDelayMs({ hasOpenRequest: false, documentHidden: true })).toBe(60_000);
  });
});

describe("steady-state request rate", () => {
  it("cuts an idle visible console's telephony reads by more than half", () => {
    const before = 1 / 1.0 + 1 / 10 + 1 / 10 + 1 / 10 + 1 / 4; // the previous flat cadences
    const after =
      1_000 / activeCallPollDelayMs({ activity: "idle", documentHidden: false }) / 1_000 +
      1 / (supportPollDelayMs({ documentHidden: false }) / 1_000) * 3 +
      1 / (takeoverPollDelayMs({ hasOpenRequest: false, documentHidden: false }) / 1_000);

    expect(after).toBeLessThan(before / 2);
  });

  it("makes a hidden console nearly silent", () => {
    const hidden =
      1 / (activeCallPollDelayMs({ activity: "idle", documentHidden: true }) / 1_000) +
      1 / (supportPollDelayMs({ documentHidden: true }) / 1_000) * 3 +
      1 / (takeoverPollDelayMs({ hasOpenRequest: false, documentHidden: true }) / 1_000);

    expect(hidden).toBeLessThan(0.3);
  });
});
