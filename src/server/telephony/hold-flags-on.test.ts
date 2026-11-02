import { beforeEach, describe, expect, it, vi } from "vitest";

import { envLatencyFlags } from "./latency-flags";

/**
 * The hold, conference, recording and journey contracts again, with the hold
 * switches that change only how a hold is executed turned on: the lean routing
 * context (`hold_lean_context`, call-speed S7a.4), the phone's single read
 * wave (`hold_mobile_dedupe`, S7a.2) and the TEST self-created conference
 * proof (`test_conference_self_proof`, S7a.3). They may change how many reads
 * happen, never what a caller hears or what a client is told.
 * `hold_join_with_hold` changes the provider commands and has its own tests.
 */
const ON = { hold_lean_context: true, hold_mobile_dedupe: true, test_conference_self_proof: true };
beforeEach(() => { vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON)); });

describe("hold switches", () => {
  it("are on for every suite below", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

// Suites without root-level setup only: another suite's `beforeEach` would
// apply to every test in this file. `voice-hold` and the journey integration
// have their own flags-on files for that reason.
await import("@/test/native-hold-wire.test");
await import("./conference-actions.test");
await import("./conference-departure.test");
await import("./state/recording-concurrency.test");
await import("./state/recording-connection.test");
await import("./state/recording-critical-path.test");
await import("./call-journey.test");
