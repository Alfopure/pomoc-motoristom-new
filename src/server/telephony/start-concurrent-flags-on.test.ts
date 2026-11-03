import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { envLatencyFlags } from "./latency-flags";

/**
 * The start, recovery, hangup, pause, callback and fan-out contracts again
 * with the call-speed S6 switches on — concurrent far-end dial for every
 * origin and direction, and the colleague auto-bridge — on top of the S1/S2
 * execution switches TEST runs with. A frozen concurrent start changes when
 * the far end is dialled, never who is reserved, what a client is told or how
 * the call ends. Legacy-writer suites keep the start mode frozen at creation
 * but run sequentially, with no `meta.far_end` and no auto-bridge (S6 needs
 * writer contract 2); a few assertions describe the sequential shape on
 * purpose and pin `concurrent_dial` off themselves.
 *
 * Not imported: suites that spell out the sequential order step by step (the
 * colleague endpoint fan-out after the own answer, the TEST wire adapter's
 * single start POST, native starts whose provider double answers every POST
 * with one call id), and suites whose module mocks or default rate limiter
 * would leak into the others here. `state/concurrent-start.test.ts` covers
 * their concurrent counterparts.
 */
const ON = {
  internal_lean_path: true, bridged_observation_fast: true, start_fast_path: true, start_test_proof_prefetch: true,
  concurrent_dial: { outbound: { web: true, mobile: true }, internal: { web: true, mobile: true } }, internal_auto_bridge: true,
};
// Until spikes S6.0/1–4 pass only a TEST deployment freezes a concurrent start.
beforeEach(() => {
  vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON));
  vi.stubEnv("MOTORIST_APP_ENV", "test");
});

/** Which startup entries really dialled the far end next to the own leg. */
const seen = vi.hoisted(() => ({ concurrent: 0, sequential: 0 }));
vi.mock("./state/transitions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/transitions")>();
  return { ...actual, planInitialCall: (...args: Parameters<typeof actual.planInitialCall>) => {
    const result = actual.planInitialCall(...args);
    if (result.commands.length > 1) seen.concurrent += 1;
    else seen.sequential += 1;
    return result;
  } };
});

describe("concurrent start switches", () => {
  it("are on for every suite below", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

afterAll(() => {
  // The suites below really ran concurrent starts, not only the legacy ones.
  expect(seen.concurrent).toBeGreaterThan(50);
});

await import("./initial-call-operation.test");
await import("./colleague-call.test");
await import("./state/outbound-direct.test");
await import("./hangup-acceptance.test");
await import("./session-contention.test");
await import("./callbacks-v1.test");
await import("./state/dispatch-pause-boundaries.test");
await import("./mobile-calling.test");
await import("./call-setup-latency.test");
await import("./state/parallel-fanout.test");
await import("./start-fast-path.test");
await import("./state/outbound-intro.test");
await import("./internal-lean-path.test");
await import("./bridged-observation.test");
await import("./call-reconciliation.test");
await import("./conference-departure.test");
await import("./state/recording-connection.test");
await import("./state/ownership-transfer-recovery.test");
await import("./outbound-pickup-context.test");
await import("./call-actions.test");
