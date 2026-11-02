import { beforeEach, describe, expect, it, vi } from "vitest";

import { envLatencyFlags } from "@/server/telephony/latency-flags";

/**
 * The whole native-hold contract (`voice-hold.test.ts`) again with the phone's
 * single read wave (`hold_mobile_dedupe`, call-speed S7a.2) and the lean hold
 * context (`hold_lean_context`, S7a.4) on: the switches change how many reads
 * a hold costs, never what the phone is told. Its own file, because that
 * suite's root-level setup would also apply to any other imported suite.
 */
const ON = { hold_lean_context: true, hold_mobile_dedupe: true };
beforeEach(() => { vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON)); });

describe("hold switches", () => {
  it("are on for the native-hold contract", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

await import("./voice-hold.test");
