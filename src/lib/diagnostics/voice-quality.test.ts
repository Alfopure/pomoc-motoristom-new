import { describe, expect, it } from "vitest";
import { parseDiagnosticEvent } from "./types";
import { VOICE_QUALITY_WARNINGS } from "./voice-quality";

const id = "00000000-0000-4000-8000-000000000001";
const base = { id, pageId: id, sequence: 1, occurredAt: "2026-10-06T10:00:00.000Z", monotonicMs: 1,
  type: "phone_lifecycle", module: "telephony", outcome: "unknown", buildId: "test-build", sampled: false, sampleRate: 1, callSessionId: id };

describe("closed voice-quality diagnostic envelope", () => {
  it("accepts only the known SDK code/reason pairs as observations of an identified call", () => {
    for (const warning of VOICE_QUALITY_WARNINGS) {
      const event = { ...base, sdkWarningCode: warning.code, reason: warning.reason };
      expect(parseDiagnosticEvent(event)).toEqual(event);
      for (const patch of [{ sdkWarningCode: 99999 }, { sdkWarningCode: "31001" }, { sdkWarningCode: 31001.1 },
        { reason: "sdk_warning" }, { outcome: "failed" }, { type: "ui_error" }, { module: "app" }, { callSessionId: undefined },
        { stats: { remoteAddress: "192.0.2.1" } }, { message: "private" }, { sdp: "private" }, { sdkCallId: "private" }]) {
        expect(parseDiagnosticEvent({ ...event, ...patch })).toBeNull();
      }
      expect(parseDiagnosticEvent({ ...base, reason: warning.reason })).toBeNull();
    }
  });
});
