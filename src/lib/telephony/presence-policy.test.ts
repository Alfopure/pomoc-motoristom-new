import { describe, expect, it } from "vitest";
import { effectivePresenceStatus, readPauseReturn } from "./presence-policy";

const now = new Date("2026-09-07T10:00:00Z");
const context = { v: 1, sessionId: "session", profileId: "actor", pauseReasonId: "reason", pausedSince: "2026-09-07T09:00:00Z", ownerToken: "token" };

describe("durable pause return policy", () => {
  it.each([null, undefined, "2026-09-07T09:59:00Z", "invalid"])("keeps expired/zero wrap-up unavailable before sweep (%s)", wrap_up_until => {
    expect(effectivePresenceStatus({ status: "after_call_work", wrap_up_until, pause_return: context }, now)).toBe("paused");
    expect(effectivePresenceStatus({ status: "after_call_work", wrap_up_until }, now)).toBe("available");
  });
  it("keeps active wrap-up work and rejects unknown context versions", () => {
    expect(effectivePresenceStatus({ status: "after_call_work", wrap_up_until: "2026-09-07T11:00:00Z", pause_return: context }, now)).toBe("after_call_work");
    expect(readPauseReturn({ ...context, v: 2 })).toBeNull();
    expect(readPauseReturn({ v: 1 })).toBeNull();
  });
});
