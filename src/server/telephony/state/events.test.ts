import { describe, expect, it } from "vitest";

import { encodeClientState } from "../telnyx/client-state";
import { buildTelnyxEnvelope, classifyEventType, parseTelnyxEnvelope } from "./events";

describe("parseTelnyxEnvelope", () => {
  it("normalises the Telnyx envelope and decodes client_state", () => {
    const clientState = encodeClientState({ sid: "00000000-0000-4000-8000-000000000001", role: "operator", operatorId: "op-1", step: 2, intent: "ring" });
    const envelope = buildTelnyxEnvelope({
      id: "evt-1",
      type: "call.hangup",
      occurredAt: "2026-09-03T08:00:00.000Z",
      payload: {
        call_control_id: "cc-1",
        call_leg_id: "leg-1",
        call_session_id: "tsess-1",
        connection_id: "app-1",
        client_state: clientState,
        from: "+421905123456",
        to: "+4210232408700",
        direction: "incoming",
        state: "hangup",
        hangup_cause: "timeout",
        hangup_source: "callee",
        sip_hangup_cause: "487",
        custom_headers: [{ name: "X-PM-Auto-Answer", value: "1" }, { name: "" }],
      },
    });
    expect(parseTelnyxEnvelope(envelope)).toMatchObject({
      kind: "telnyx",
      id: "evt-1",
      type: "call.hangup",
      occurredAt: "2026-09-03T08:00:00.000Z",
      callControlId: "cc-1",
      callLegId: "leg-1",
      callSessionId: "tsess-1",
      connectionId: "app-1",
      clientState: { sid: "00000000-0000-4000-8000-000000000001", role: "operator", operatorId: "op-1", step: 2, intent: "ring" },
      direction: "incoming",
      hangupCause: "timeout",
      hangupSource: "callee",
      sipHangupCause: "487",
      customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }],
    });
  });

  it("reads gather digits / dtmf digit and tolerates garbage client_state", () => {
    expect(parseTelnyxEnvelope(buildTelnyxEnvelope({ id: "e", type: "call.gather.ended", payload: { digits: "1", status: "valid", client_state: "!!!" } }))).toMatchObject({ digits: "1", status: "valid", clientState: null, rawClientState: "!!!" });
    expect(parseTelnyxEnvelope(buildTelnyxEnvelope({ id: "e", type: "call.dtmf.received", payload: { digit: "#" } }))).toMatchObject({ digits: "#" });
  });

  it("rejects malformed envelopes", () => {
    expect(parseTelnyxEnvelope(null)).toBeNull();
    expect(parseTelnyxEnvelope({})).toBeNull();
    expect(parseTelnyxEnvelope({ data: { event_type: "call.answered" } })).toBeNull();
    expect(parseTelnyxEnvelope({ data: { id: "x" } })).toBeNull();
    expect(parseTelnyxEnvelope("{}")).toBeNull();
  });
});

describe("classifyEventType", () => {
  it("separates control events from bookkeeping", () => {
    for (const type of ["call.initiated", "call.answered", "call.bridged", "call.hangup", "call.gather.ended", "call.playback.ended", "call.dtmf.received", "conference.participant.left"]) {
      expect(classifyEventType(type)).toBe("control");
    }
    for (const type of ["call.cost", "call.speak.started", "call.playback.started", "message.sent", "call.machine.detection.ended", "totally.unknown"]) {
      expect(classifyEventType(type)).toBe("bookkeeping");
    }
  });
});
