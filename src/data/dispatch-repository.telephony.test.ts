import { describe, expect, it } from "vitest";

import { mapCallCenterCall } from "./dispatch-repository";

describe("historical call line identity", () => {
  it("carries stored number fields and resolves an exact configured insurer DID", () => {
    const result = mapCallCenterCall(args({
      line_id: null,
      called_number: "0412289243",
      received_number: "+421 41 228 92 43",
      destination_number: "20",
    }));

    expect(result).toMatchObject({
      receivedNumber: "+421 41 228 92 43",
      destinationNumber: "20",
      lineId: "line-axa",
      lineLabel: "AXA Assistance CZ s.r.o.",
    });
  });

  it("fails closed instead of combining a stored line id with a conflicting received DID", () => {
    const result = mapCallCenterCall(args({
      line_id: "line-allianz",
      called_number: "0412289243",
      received_number: "0412289243",
    }));

    expect(result).toMatchObject({
      receivedNumber: "0412289243",
      lineId: undefined,
      lineLabel: "Neznáma linka",
    });
  });

  it("uses the exact called DID when a stored queue scalar is not a public line", () => {
    const result = mapCallCenterCall(args({
      line_id: null,
      called_number: "0412289241",
      received_number: "601",
      destination_number: "20",
    }));

    expect(result).toMatchObject({
      receivedNumber: "0412289241",
      destinationNumber: "20",
      lineId: "line-allianz",
      lineLabel: "Allianz Assistance",
    });
  });

  it("never reuses a generic or stale label for an unknown DID", () => {
    const result = mapCallCenterCall(args({
      line_id: null,
      called_number: "601",
      received_number: "0412289999",
    }));

    expect(result).toMatchObject({
      receivedNumber: "0412289999",
      lineId: undefined,
      lineLabel: "Neznáma linka",
    });
  });

  it("ignores legacy insurer fields on an outbound call", () => {
    const result = mapCallCenterCall(args({
      direction: "outbound",
      line_id: "line-allianz",
      received_number: "0412289241",
      called_number: "0905123456",
      destination_number: "0905123456",
    }));

    expect(result).toMatchObject({
      calledNumber: "0905123456",
      destinationNumber: "0905123456",
      lineId: undefined,
      lineLabel: "Neznáma linka",
    });
    expect(result.receivedNumber).toBeUndefined();
  });

  it("never presents a row with ended_at as an active controllable call", () => {
    const result = mapCallCenterCall(args({
      status: "answered",
      answered_at: null,
      duration_seconds: null,
      ended_at: "2026-08-11T13:41:19.852Z",
      end_reason: "cancel",
    }));

    expect(result.status).toBe("missed");
  });
});

function args(callOverrides: Record<string, unknown>): Parameters<typeof mapCallCenterCall>[0] {
  const call = {
    id: "call-1",
    provider_call_id: "provider-1",
    viptel_unique_id: "unique-1",
    status: "ended",
    direction: "inbound",
    caller_number: "+421900111222",
    caller_name: null,
    called_number: null,
    received_number: null,
    destination_number: null,
    caller_extension: null,
    received_extension: null,
    destination_extension: null,
    extension_id: null,
    operator_id: null,
    line_id: null,
    queue_id: null,
    queue_number: null,
    case_id: null,
    started_at: "2026-08-04T10:00:00.000Z",
    created_at: "2026-08-04T10:00:00.000Z",
    answered_at: null,
    ended_at: "2026-08-04T10:01:00.000Z",
    wait_seconds: 3,
    duration_seconds: 57,
    complete_duration_seconds: 60,
    recording_status: "not_requested",
    transcript_status: "not_requested",
    summary: null,
    raw_latest_payload: {},
    ...callOverrides,
  } as Parameters<typeof mapCallCenterCall>[0]["call"];

  const linesById = new Map([
    ["line-allianz", {
      id: "line-allianz",
      provider: "viptel",
      phone_number: "0412289241",
      external_id: null,
      label: "stale Allianz label",
    }],
    ["line-axa", {
      id: "line-axa",
      provider: "viptel",
      phone_number: "0412289243",
      external_id: null,
      label: "stale AXA label",
    }],
  ]) as Parameters<typeof mapCallCenterCall>[0]["linesById"];

  return {
    call,
    callEvents: [],
    caseNumberById: new Map(),
    linesById,
    profilesById: new Map(),
    queuesById: new Map(),
  };
}
