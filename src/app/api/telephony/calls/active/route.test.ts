import { describe, expect, it } from "vitest";

import type { ViptelActiveCall } from "@/lib/integrations/viptel/client";
import { buildViptelLineCatalog } from "@/server/telephony/viptel-line-catalog";
import {
  isListenerWaitingCall,
  mapActiveCall,
  mapProvisionalQueueCall,
  providerCallPresentationStatus,
  storedCallIsProviderWaiting,
} from "./route";

const checkedAt = "2026-08-04T12:00:00.000Z";
const catalog = buildViptelLineCatalog([
  { id: "line-allianz", phone_number: "0412289241", external_id: null, label: "old Allianz label" },
  { id: "line-autoklub", phone_number: "0412289242", external_id: null, label: "old Autoklub label" },
]);

describe("active VIPTel call DTO", () => {
  it("maps an exact configured provider DID to insurer identity and explicit numbers", () => {
    const call = activeCall({
      calledNumber: "20",
      raw: {
        received_number: "00421412289242",
        destination_number: "20",
      },
    });

    expect(mapActiveCall(call, 0, checkedAt, undefined, catalog)).toMatchObject({
      receivedNumber: "00421412289242",
      destinationNumber: "20",
      lineId: "line-autoklub",
      lineLabel: "Autoklub Slovakia Assistance s.r.o.",
    });
  });

  it("keeps the stored line identity but trusts the provider's current destination", () => {
    const call = activeCall({
      calledNumber: "21",
      raw: {
        received_number: "0412289242",
        destination_number: "21",
      },
    });
    const stored = {
      id: "stored-call",
      line_id: "line-allianz",
      received_number: "0412289241",
      destination_number: "20",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(call, 0, checkedAt, stored, catalog)).toMatchObject({
      id: "stored-call",
      receivedNumber: "0412289241",
      destinationNumber: "21",
      lineId: "line-allianz",
      lineLabel: "Allianz Assistance",
    });
  });

  it("does not attach a queue-level provider row to a stale stored agent extension", () => {
    const stored = {
      id: "stored-queue-parent",
      operator_id: "operator-20",
      destination_number: "20",
      destination_extension: "20",
      received_extension: "20",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(activeCall({
      calledNumber: "601",
      destinationNumber: "601",
      queueNumber: "601",
    }), 0, checkedAt, stored, catalog)).toMatchObject({
      id: "stored-queue-parent",
      destinationNumber: "601",
      destinationExtension: undefined,
      operatorId: "operator-20",
    });
  });

  it("fails closed when the stored line id and stored received DID conflict", () => {
    const stored = {
      id: "stored-conflict",
      line_id: "line-allianz",
      received_number: "0412289242",
      destination_number: "20",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(activeCall({ raw: { received_number: "0412289242" } }), 0, checkedAt, stored, catalog)).toMatchObject({
      receivedNumber: "0412289242",
      lineId: undefined,
      lineLabel: "Neznáma linka",
    });
  });

  it("labels a queue-only or unconfigured DID call explicitly as unknown", () => {
    expect(mapActiveCall(activeCall({
      calledNumber: "601",
      queueNumber: "601",
      raw: { queue: "601" },
    }), 0, checkedAt, undefined, catalog)).toMatchObject({
      lineId: undefined,
      lineLabel: "Neznáma linka",
    });

    expect(mapActiveCall(activeCall({
      raw: { received_number: "0412289243" },
    }), 1, checkedAt, undefined, catalog)).toMatchObject({
      receivedNumber: "0412289243",
      lineId: undefined,
      lineLabel: "Neznáma linka",
    });
  });

  it("uses an exact provider DID when the stored received value is only a queue scalar", () => {
    const stored = {
      id: "stored-queue-leg",
      line_id: null,
      received_number: "601",
      destination_number: "20",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(activeCall({
      raw: { received_number: "0412289241", destination_number: "20" },
    }), 0, checkedAt, stored, catalog)).toMatchObject({
      receivedNumber: "0412289241",
      lineId: "line-allianz",
      lineLabel: "Allianz Assistance",
    });
  });

  it("ignores legacy stored insurer identity for an active outbound call", () => {
    const stored = {
      id: "stored-outbound",
      direction: "outbound",
      line_id: "line-allianz",
      received_number: "0412289241",
      destination_number: "0905123456",
    } as Parameters<typeof mapActiveCall>[3];

    const result = mapActiveCall(activeCall({
      direction: "outbound",
      status: "outbound",
      calledNumber: "0905123456",
      raw: { received_number: "0412289241" },
    }), 0, checkedAt, stored, catalog);

    expect(result).toMatchObject({
      calledNumber: "0905123456",
      destinationNumber: "0905123456",
      lineId: undefined,
      lineLabel: "Neznáma linka",
    });
    expect(result.receivedNumber).toBeUndefined();
  });

  it("uses the provider's current destination extension after a redirect", () => {
    const stored = {
      id: "stored-redirected",
      received_extension: "20",
      destination_extension: "20",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(activeCall({
      receivedExtension: "20",
      destinationExtension: "21",
    }), 0, checkedAt, stored, catalog)).toMatchObject({
      receivedExtension: "20",
      destinationExtension: "21",
    });
  });

  it("keeps the persisted caller identity when a later provider leg omits it", () => {
    const stored = {
      id: "stored-simultaneous-call",
      caller_number: "+421905111222",
      caller_name: "Klient na linke",
      called_number: "0412289240",
      started_at: "2026-08-04T11:59:30.000Z",
      answered_at: "2026-08-04T12:00:01.000Z",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(activeCall({
      callerNumber: undefined,
      callerName: undefined,
      calledNumber: undefined,
      startedAt: undefined,
      answeredAt: undefined,
    }), 0, checkedAt, stored, catalog)).toMatchObject({
      callerNumber: "+421905111222",
      callerName: "Klient na linke",
      calledNumber: "0412289240",
      startedAt: "2026-08-04T11:59:30.000Z",
      answeredAt: "2026-08-04T12:00:01.000Z",
    });
  });

  it("does not replace an inbound customer with the later internal agent identity", () => {
    const stored = {
      id: "stored-queued-call",
      direction: "inbound",
      caller_number: "+421905111222",
      caller_name: "Klient na linke",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(activeCall({
      direction: "inbound",
      callerNumber: "20",
      callerName: "Dispečer",
      destinationExtension: "20",
    }), 0, checkedAt, stored, catalog)).toMatchObject({
      callerNumber: "+421905111222",
      callerName: "Klient na linke",
      destinationExtension: "20",
    });
  });

  it("keeps the stored call and caller while the same queue parent advances to the next station", () => {
    const stored = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "abandoned_queue",
      direction: "inbound",
      viptel_unique_id: "agent-leg-20",
      from_queue_unique_id: "queue-parent",
      caller_number: "+421905111222",
      caller_name: "Klient na linke",
      destination_extension: "20",
    } as Parameters<typeof mapActiveCall>[3];

    expect(mapActiveCall(activeCall({
      status: "ringing_agent",
      viptelUniqueId: "agent-leg-21",
      fromQueueUniqueId: "queue-parent",
      callerNumber: undefined,
      callerName: undefined,
      destinationExtension: "21",
    }), 0, checkedAt, stored, catalog)).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "ringing_agent",
      viptelUniqueId: "agent-leg-21",
      fromQueueUniqueId: "queue-parent",
      callerNumber: "+421905111222",
      callerName: "Klient na linke",
      destinationExtension: "21",
    });
  });
});

describe("listener waiting-call fallback", () => {
  const baseRow = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    provider_call_id: "provider-parent",
    viptel_unique_id: "queue-parent",
    from_queue_unique_id: null,
    status: "ringing_agent",
    direction: "inbound",
    caller_number: "+421905111222",
    caller_name: null,
    called_number: "601",
    received_number: "0412289241",
    destination_number: "21",
    caller_extension: null,
    received_extension: null,
    destination_extension: "21",
    extension_id: "extension-21",
    operator_id: "operator-21",
    line_id: "line-allianz",
    queue_number: "601",
    case_id: null,
    created_at: "2026-08-04T11:59:40.000Z",
    started_at: "2026-08-04T11:59:40.000Z",
    answered_at: null,
    ended_at: null,
    updated_at: "2026-08-04T11:59:59.000Z",
    wait_seconds: 19,
    recording_status: "not_requested",
    transcript_status: "not_requested",
  } as Parameters<typeof isListenerWaitingCall>[0];

  it("never revives a truly closed queue row as a controllable incoming call", () => {
    expect(isListenerWaitingCall({ ...baseRow, status: "missed" }, checkedAt)).toBe(false);
    expect(isListenerWaitingCall({ ...baseRow, ended_at: checkedAt }, checkedAt)).toBe(false);
    expect(isListenerWaitingCall({ ...baseRow, status: "abandoned_queue", ended_at: checkedAt }, checkedAt)).toBe(false);
  });

  it("recognises a stored row whose channel the provider lists as waiting", () => {
    // The second simultaneous caller has no agent leg while the only agent
    // rings with the first, so the active-call list cannot represent them --
    // only the queue status knows they exist. Matching that waiting set by
    // the caller's own channel id is what keeps them steadily visible instead
    // of blinking once per rotation step, at different moments per browser.
    const waiting = new Set(["queue-channel-b"]);
    expect(storedCallIsProviderWaiting(
      { from_queue_unique_id: "queue-channel-b", viptel_unique_id: "agent-leg-old" },
      waiting,
    )).toBe(true);
    expect(storedCallIsProviderWaiting(
      { from_queue_unique_id: null, viptel_unique_id: "queue-channel-b" },
      waiting,
    )).toBe(true);
    expect(storedCallIsProviderWaiting(
      { from_queue_unique_id: "queue-channel-a", viptel_unique_id: "agent-leg-a" },
      waiting,
    )).toBe(false);
    expect(storedCallIsProviderWaiting(
      { from_queue_unique_id: "queue-channel-b", viptel_unique_id: null },
      new Set(),
    )).toBe(false);
  });

  it("keeps a caller visible between rotation steps instead of blinking", () => {
    // Live PBX trace, 2026-09-02: a waiting caller moves 601 -> 602 -> 603 as
    // queue.left followed ~2 seconds later by queue.join with the same channel
    // id, and the stored row passes through abandoned_queue in the gap.
    // Treating that state as terminal made every caller vanish from the
    // waiting room once per rotation step even though the call existed the
    // whole time. A caller who genuinely hangs up gets call.end within
    // seconds, which sets ended_at and is excluded above regardless of age.
    const hop = { ...baseRow, status: "abandoned_queue" as const, updated_at: "2026-08-04T11:59:57.000Z" };
    expect(isListenerWaitingCall(hop, checkedAt)).toBe(true);
    expect(isListenerWaitingCall({ ...hop, updated_at: "2026-08-04T11:59:50.000Z" }, checkedAt)).toBe(true);
    // Past the hop grace the journey is over and the row must fade out.
    expect(isListenerWaitingCall({ ...hop, updated_at: "2026-08-04T11:59:47.000Z" }, checkedAt)).toBe(false);
    expect(isListenerWaitingCall({ ...hop, updated_at: "2026-08-04T11:59:00.000Z" }, checkedAt)).toBe(false);
  });

  it("expires an unrefreshed listener row instead of leaving a ghost", () => {
    expect(isListenerWaitingCall({ ...baseRow, updated_at: "2026-08-04T11:59:00.000Z" }, checkedAt)).toBe(false);
    expect(isListenerWaitingCall(baseRow, checkedAt)).toBe(true);
  });

  it("keeps a listener call queue-level until VIPTel verifies its workstation", () => {
    expect(mapProvisionalQueueCall(baseRow, catalog)).toMatchObject({
      id: baseRow.id,
      status: "incoming",
      callerNumber: "+421905111222",
      queueLabel: "601",
      destinationNumber: undefined,
      destinationExtension: undefined,
      extensionId: undefined,
      operatorId: undefined,
      startedAt: baseRow.created_at,
    });
  });

  it("keeps the original logical waiting clock when the provider starts a new agent leg", () => {
    expect(mapActiveCall(activeCall({
      startedAt: "2026-08-04T12:00:00.000Z",
      fromQueueUniqueId: "queue-parent",
    }), 0, checkedAt, {
      ...baseRow,
      created_at: "2026-08-04T11:59:00.000Z",
      started_at: "2026-08-04T11:59:30.000Z",
      from_queue_unique_id: "queue-parent",
    }, catalog).startedAt).toBe("2026-08-04T11:59:00.000Z");
  });

  it("presents a provider-answered queue parent as waiting until an agent answered", () => {
    expect(providerCallPresentationStatus(activeCall({
      status: "answered",
      viptelUniqueId: "queue-parent",
      fromQueueUniqueId: undefined,
    }), { ...baseRow, from_queue_unique_id: "queue-parent" })).toBe("incoming");
    expect(providerCallPresentationStatus(activeCall({
      status: "answered",
      viptelUniqueId: "agent-leg",
      fromQueueUniqueId: "queue-parent",
    }), baseRow)).toBe("answered");
    expect(providerCallPresentationStatus(activeCall({
      status: "answered",
      viptelUniqueId: "queue-parent",
    }), { ...baseRow, answered_at: checkedAt, from_queue_unique_id: "queue-parent" })).toBe("incoming");
  });

  it("lets an authoritative listener end hide a stale provider queue parent", () => {
    expect(providerCallPresentationStatus(activeCall({
      status: "answered",
      viptelUniqueId: "queue-parent",
    }), {
      ...baseRow,
      status: "missed",
      ended_at: checkedAt,
      from_queue_unique_id: "queue-parent",
    })).toBe("missed");
  });
});

function activeCall(overrides: Partial<ViptelActiveCall>): ViptelActiveCall {
  return {
    providerCallId: "provider-call",
    direction: "inbound",
    status: "ringing_agent",
    callerNumber: "+421900111222",
    raw: {},
    ...overrides,
  };
}
