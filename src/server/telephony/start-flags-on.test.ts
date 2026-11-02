import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("start switches", () => {
  it("are on for every suite below", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
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
