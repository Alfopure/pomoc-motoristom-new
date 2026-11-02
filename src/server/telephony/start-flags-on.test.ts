import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { envLatencyFlags } from "./latency-flags";

/**
 * The start, recovery, hangup, pause and callback contracts again with the
 * start switches that change only how a start executes turned on: the guard
 * wave and lean first dial (`start_fast_path`, call-speed S2.1/S2.2) and the
 * TEST destination proof prefetch (`start_test_proof_prefetch`). They may
 * change how many reads happen and in which order, never what is dialled, who
 * is reserved or what a client is told. `start_early_response` acts in the
 * routes only (the hook a route passes); `start-fast-path.test.ts` and
 * `early-start.test.ts` cover it.
 */
const ON = { start_fast_path: true, start_test_proof_prefetch: true };
beforeEach(() => { vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON)); });

/**
 * What the start path really resolved. Every new start reserves its operator
 * through `reserveOperatorOwnership(..., { lockedCheck: start_fast_path })`,
 * so each call records whether that start ran on the fast path, and which
 * test it belonged to.
 */
const seen = vi.hoisted(() => ({ starts: [] as Array<{ test: string; fast: boolean }> }));
vi.mock("./routing/reservation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./routing/reservation")>();
  const { expect: current } = await import("vitest");
  return { ...actual, reserveOperatorOwnership: (...args: Parameters<typeof actual.reserveOperatorOwnership>) => {
    if (args[2]) seen.starts.push({ test: current.getState().currentTestName ?? "", fast: Boolean(args[2].lockedCheck) });
    return actual.reserveOperatorOwnership(...args);
  } };
});

/** Suites that pin their own flags on purpose; their starts run without the fast path. */
const PINNED = [
  // S3 (`own-leg-request-header.test.ts`): the header on and off against an explicit flag set.
  "own-leg request header",
  "sends no request header for a start without a request id (legacy writer)",
];

describe("start switches", () => {
  it("are on for every suite below", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

afterAll(() => {
  const slow = seen.starts.filter(start => !start.fast);
  const fast = seen.starts.filter(start => start.fast);
  // The suites below really took the fast path, start by start...
  expect(fast.length).toBeGreaterThan(100);
  // ...except the explicitly pinned ones.
  expect(slow.filter(start => !PINNED.some(name => start.test.startsWith(name)))).toEqual([]);
});

// Their only root-level setup is an `afterEach` that restores the environment
// this file's `beforeEach` sets again for the next test.
await import("./initial-call-operation.test");
await import("./colleague-call.test");
await import("./state/outbound-direct.test");
await import("./hangup-acceptance.test");
await import("./session-contention.test");
await import("./callbacks-v1.test");
await import("./state/dispatch-pause-boundaries.test");
await import("./own-leg-request-header.test");
await import("./mobile-calling.test");
await import("./call-setup-latency.test");
