import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COVERAGE_EMIT_COOLDOWN_MS,
  COVERAGE_STABILITY_TICKS,
  createCoverageStabilityTracker,
  dispatchCoverageEnabled,
} from "./dispatch-coverage-reconciler";

beforeEach(() => {
  vi.stubEnv("VIPTEL_DISPATCH_COVERAGE_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("coverage feature flag", () => {
  it("ships dark: anything other than an explicit true is off", () => {
    for (const value of ["", "false", "1", "yes", "TRUE "]) {
      expect(dispatchCoverageEnabled({ VIPTEL_DISPATCH_COVERAGE_ENABLED: value } as unknown as NodeJS.ProcessEnv))
        .toBe(value.trim().toLowerCase() === "true");
    }
    expect(dispatchCoverageEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("change stability", () => {
  it("requires the same desired state twice before acting", () => {
    // A single odd snapshot during a queue handoff must not move membership.
    const tracker = createCoverageStabilityTracker();
    expect(tracker.observe("a")).toBe(1);
    expect(tracker.observe("a")).toBe(2);
    expect(COVERAGE_STABILITY_TICKS).toBe(2);
  });

  it("restarts counting when the desired state changes", () => {
    const tracker = createCoverageStabilityTracker();
    tracker.observe("a");
    tracker.observe("a");
    expect(tracker.observe("b")).toBe(1);
  });

  it("resets when a manager routing operation takes over", () => {
    const tracker = createCoverageStabilityTracker();
    tracker.observe("a");
    tracker.observe("a");
    tracker.reset();
    expect(tracker.observe("a")).toBe(1);
  });
});

describe("emit cooldown", () => {
  it("leaves a just-emitted step alone while it takes effect", () => {
    // A membership change is not visible immediately: the command must be
    // claimed, sent and confirmed, and the listener's snapshot is cached.
    // Without this the reconciler re-derived the same unmet state every two
    // seconds and re-emitted continuously, which in production produced a
    // duplicate-key error on every single tick.
    let clock = 1_000_000;
    const tracker = createCoverageStabilityTracker(() => clock);
    const key = "add:602:21";

    expect(tracker.recentlyEmitted(key)).toBe(false);
    tracker.markEmitted(key);
    expect(tracker.recentlyEmitted(key)).toBe(true);

    clock += COVERAGE_EMIT_COOLDOWN_MS - 1;
    expect(tracker.recentlyEmitted(key)).toBe(true);
    clock += 2;
    expect(tracker.recentlyEmitted(key)).toBe(false);
  });

  it("cools down each step independently", () => {
    const tracker = createCoverageStabilityTracker(() => 1_000_000);
    tracker.markEmitted("add:602:21");
    expect(tracker.recentlyEmitted("add:603:21")).toBe(false);
  });

  it("gives the cooldown room for the listener snapshot cache and a command round trip", () => {
    // Snapshot cache is 4s and the pump runs every 2s, so anything near those
    // would still re-emit before the change could possibly be observed.
    expect(COVERAGE_EMIT_COOLDOWN_MS).toBeGreaterThan(10_000);
  });
});

describe("reconciler wiring", () => {
  it("does nothing at all while the flag is off", async () => {
    vi.stubEnv("VIPTEL_DISPATCH_COVERAGE_ENABLED", "false");
    const { reconcileDispatchQueueCoverage } = await import("./dispatch-coverage-reconciler");
    const client = { from: () => { throw new Error("must not touch the database"); } };

    const result = await reconcileDispatchQueueCoverage({
      organizationId: "11111111-1111-4111-8111-111111111111",
      snapshot: { extensions: [], queueStatuses: [] },
      stability: createCoverageStabilityTracker(),
      client: client as never,
      env: { VIPTEL_DISPATCH_COVERAGE_ENABLED: "false" } as unknown as NodeJS.ProcessEnv,
    });

    expect(result.status).toBe("disabled");
  });
});
