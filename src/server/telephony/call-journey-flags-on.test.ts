import { beforeEach, describe, expect, it, vi } from "vitest";

import { envLatencyFlags } from "./latency-flags";

/**
 * The call-journey integration (`call-journey.integration.test.ts`) again with
 * the execution-only hold switches on (call-speed S7a.2–S7a.4). Its own file,
 * because that suite's root-level setup would apply to any other imported suite.
 */
const ON = { hold_lean_context: true, hold_mobile_dedupe: true, test_conference_self_proof: true };
beforeEach(() => { vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON)); });

describe("hold switches", () => {
  it("are on for the journey integration", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

await import("./call-journey.integration.test");
