import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isQueueChannelRedirectLeg,
  mergeViptelCallLineIdentity,
  mergeViptelCallerIdentity,
  nextCallStatus,
  newerInboundQueueOffer,
  normalizeViptelEvent,
  preserveExistingInboundOrigin,
  terminalSnapshotIsForSupersededLeg,
  viptelEventFingerprint,
} from "./viptel-events";
import type { ViptelCorrelationCatalog } from "./viptel-correlation";
import {
  cdrSnapshot,
  terminalStatusForEndedCall,
  viptelRecordIsAtOrAfterHistoryFloor,
  viptelDateFrom,
} from "./viptel-reconcile";

describe("VIPTel provider history floor", () => {
  const record = (startedAt?: string) => ({
    cdrId: "cdr-1",
    startedAt,
    hasRecording: false,
    raw: {},
  });

  it("does not re-import provider rows from before an intentional history purge", () => {
    expect(viptelRecordIsAtOrAfterHistoryFloor(record("2026-08-31T08:59:59Z"), "2026-08-31T09:00:00Z")).toBe(false);
    expect(viptelRecordIsAtOrAfterHistoryFloor(record("2026-08-31T09:00:00Z"), "2026-08-31T09:00:00Z")).toBe(true);
  });

  it("keeps records when no valid provider timestamp or floor is available", () => {
    expect(viptelRecordIsAtOrAfterHistoryFloor(record(), "2026-08-31T09:00:00Z")).toBe(true);
    expect(viptelRecordIsAtOrAfterHistoryFloor(record("2026-08-31T08:59:59Z"), null)).toBe(true);
  });
});

describe("normalizeViptelEvent", () => {
  it("normalizes an inbound call lifecycle without logging/provider assumptions", () => {
    const begin = normalizeViptelEvent({
      event: "call.begin",
      data: {
        unique_id: "call-1",
        caller: "+421900000000",
        callee: "10",
        timestamp: "2026-07-16T08:00:00Z",
      },
    });
    expect(begin).toMatchObject({
      eventType: "call.begin",
      uniqueId: "call-1",
      direction: "inbound",
      status: "incoming",
      startedAt: "2026-07-16T08:00:00.000Z",
      handled: true,
    });

    const end = normalizeViptelEvent({
      event: "call.end",
      unique_id: "call-1",
      status: "noanswer",
    }, "2026-07-16T08:01:00.000Z");
    expect(end).toMatchObject({ status: "missed", endReason: "noanswer", endedAt: "2026-07-16T08:01:00.000Z" });
  });

  it("keeps unknown events appendable but marks them unhandled", () => {
    expect(normalizeViptelEvent({ event: "future.event", data: { unique_id: "x" } })).toMatchObject({
      eventType: "future.event",
      handled: false,
      uniqueId: "x",
    });
  });

  it("classifies malformed provider text as an unknown event instead of silently dropping it", () => {
    expect(normalizeViptelEvent("not-json")).toMatchObject({ eventType: "unknown", handled: false });
  });
});

describe("VIPTel event idempotency", () => {
  it("creates the same fingerprint for differently ordered JSON keys", () => {
    const first = { event: "call.pickup", data: { unique_id: "x", member: "10" } };
    const second = { data: { member: "10", unique_id: "x" }, event: "call.pickup" };
    const event = normalizeViptelEvent(first, "2026-07-16T08:00:00Z");
    expect(viptelEventFingerprint(event, first)).toBe(viptelEventFingerprint(event, second));
  });

  it("keeps calls with different provider ids distinct even in the same millisecond", () => {
    const firstPayload = {
      event: "queue.join",
      data: { unique_id: "simultaneous-a", caller: "+421900111111", queue: "601", timestamp: "2026-08-11T08:30:00.000Z" },
    };
    const secondPayload = {
      event: "queue.join",
      data: { unique_id: "simultaneous-b", caller: "+421900222222", queue: "601", timestamp: "2026-08-11T08:30:00.000Z" },
    };

    const first = normalizeViptelEvent(firstPayload, "2026-08-11T08:30:00.000Z");
    const second = normalizeViptelEvent(secondPayload, "2026-08-11T08:30:00.000Z");

    expect(first.providerTimestamp).toBe(second.providerTimestamp);
    expect(first.uniqueId).not.toBe(second.uniqueId);
    expect(viptelEventFingerprint(first, firstPayload)).not.toBe(viptelEventFingerprint(second, secondPayload));
  });

  it("does not regress a terminal or answered call", () => {
    expect(nextCallStatus("ended", "incoming")).toBe("ended");
    expect(nextCallStatus("answered", "ringing_agent")).toBe("answered");
    expect(nextCallStatus("answered", "ended")).toBe("ended");
    expect(nextCallStatus("missed", "ended", true)).toBe("ended");
    expect(nextCallStatus("missed", "answered")).toBe("missed");
    expect(nextCallStatus("missed", "answered", false, true)).toBe("answered");
  });

  it("does not create call identity from generic queue event ids", () => {
    expect(normalizeViptelEvent({ event: "queue.pause", data: { id: "agent-1", queue: "500" } }).providerCallId).toBeUndefined();
    expect(normalizeViptelEvent({
      event: "queue.left",
      queue: "500",
      unique_id: "call-1",
      holdtime: "12",
    })).toMatchObject({
      status: "abandoned_queue",
      queueNumber: "500",
      uniqueId: "call-1",
      waitSeconds: 12,
    });
  });
});

describe("VIPTel immutable public DID identity", () => {
  const catalog: ViptelCorrelationCatalog = {
    extensions: [],
    queues: [{ id: "queue-601", external_id: "601", line_id: "line-autoklub" }],
    lines: [
      { id: "line-allianz", external_id: null, phone_number: "0412289241" },
      { id: "line-autoklub", external_id: null, phone_number: "0412289242" },
    ],
  };

  it("preserves the first configured DID and line across queue and conflicting later legs", () => {
    const first = mergeViptelCallLineIdentity({
      catalog,
      correlatedLineId: "line-allianz",
      direction: "inbound",
      existing: null,
      snapshot: {
        receivedNumber: "+421 41 228 92 41",
        calledNumber: "601",
        destinationNumber: "20",
      },
    });
    expect(first).toEqual({
      receivedNumber: "+421 41 228 92 41",
      lineId: "line-allianz",
    });

    expect(mergeViptelCallLineIdentity({
      catalog,
      correlatedLineId: undefined,
      direction: "inbound",
      existing: {
        received_number: first.receivedNumber ?? null,
        line_id: first.lineId ?? null,
      },
      snapshot: {
        receivedNumber: "0412289242",
        calledNumber: "602",
        destinationNumber: "21",
      },
    })).toEqual(first);
  });

  it("does not assign a canonical insurer until an active configured row exists", () => {
    expect(mergeViptelCallLineIdentity({
      catalog: { extensions: [], queues: [], lines: [] },
      direction: "inbound",
      existing: null,
      snapshot: { receivedNumber: "0412289241" },
    })).toEqual({
      receivedNumber: "0412289241",
      lineId: undefined,
    });
  });

  it("does not derive public identity from the final destination number", () => {
    expect(mergeViptelCallLineIdentity({
      catalog,
      correlatedLineId: undefined,
      direction: "inbound",
      existing: null,
      snapshot: {
        receivedNumber: "0412289999",
        destinationNumber: "0412289241",
      },
    })).toEqual({
      receivedNumber: "0412289999",
      lineId: undefined,
    });
  });

  it("does not classify an outbound destination as the inbound insurer line", () => {
    expect(mergeViptelCallLineIdentity({
      catalog,
      correlatedLineId: undefined,
      direction: "outbound",
      existing: null,
      snapshot: { calledNumber: "0412289241", destinationNumber: "0412289241" },
    })).toEqual({ receivedNumber: null, lineId: null });
  });

  it("explicitly clears legacy insurer identity from outbound and internal calls", () => {
    for (const direction of ["outbound", "internal"] as const) {
      expect(mergeViptelCallLineIdentity({
        catalog,
        correlatedLineId: "line-autoklub",
        direction,
        existing: {
          received_number: "0412289241",
          line_id: "line-allianz",
        },
        snapshot: { calledNumber: "0412289242", destinationNumber: "0412289242" },
      })).toEqual({ receivedNumber: null, lineId: null });
    }
  });

  it("preserves an insurer DID when a correlated inbound call receives an internal transfer leg", () => {
    const existing = {
      direction: "inbound" as const,
      received_number: "0412289241",
      line_id: "line-allianz",
    };
    const direction = preserveExistingInboundOrigin(existing, "internal", catalog);

    expect(direction).toBe("inbound");
    expect(mergeViptelCallLineIdentity({
      catalog,
      correlatedLineId: undefined,
      direction,
      existing,
      snapshot: { calledNumber: "23", destinationNumber: "23" },
    })).toEqual({ receivedNumber: "0412289241", lineId: "line-allianz" });
  });

  it("lets an authoritative outbound event correct an inbound guess without public DID evidence", () => {
    expect(preserveExistingInboundOrigin({
      direction: "inbound",
      received_number: null,
      line_id: null,
    }, "outbound", catalog)).toBe("outbound");
  });
});

describe("VIPTel stable inbound caller identity", () => {
  const catalog: ViptelCorrelationCatalog = {
    extensions: [
      { id: "extension-20", extension: "20", profile_id: "profile-20" },
      { id: "extension-21", extension: "21", profile_id: "profile-21" },
    ],
    queues: [],
    lines: [],
  };

  it("does not let a later workstation leg replace the external caller", () => {
    expect(mergeViptelCallerIdentity({
      catalog,
      direction: "inbound",
      existing: { caller_number: "+421900111222", caller_name: "Klient" },
      snapshot: { callerNumber: "20", callerName: "Dispečer" },
    })).toEqual({ callerNumber: "+421900111222", callerName: "Klient" });
  });

  it("does not let a delayed old-leg end close the current queue leg", () => {
    expect(terminalSnapshotIsForSupersededLeg(
      { from_queue_unique_id: "queue-parent", viptel_unique_id: "agent-leg-21" },
      { authoritativeTerminal: true, uniqueId: "agent-leg-20" },
    )).toBe(true);
    expect(terminalSnapshotIsForSupersededLeg(
      { from_queue_unique_id: "queue-parent", viptel_unique_id: "agent-leg-21" },
      { authoritativeTerminal: true, uniqueId: "agent-leg-21" },
    )).toBe(false);
  });

  it("always lets the caller's own channel end close the journey", () => {
    // Live trail 2026-09-02 08:42: a waiting call was picked up, so the queue
    // channel itself dialled the workstation and the conversation ran on the
    // channel while the row's identity stayed on the last dead agent leg. The
    // channel's call.end (end_reason "answer", after 28s of talk) was then
    // discarded as a superseded-leg event and the row stayed open forever --
    // which is what later blocked outbound calls from that workstation.
    expect(terminalSnapshotIsForSupersededLeg(
      { from_queue_unique_id: "1788338494.1379", viptel_unique_id: "1788338529.1384" },
      { authoritativeTerminal: true, uniqueId: "1788338494.1379" },
    )).toBe(false);
  });

  it("recognises the queue channel being redirected out of the rotation", () => {
    // Observed live on 2026-09-02: after the fallback timer redirected waiting
    // caller 1788336609.1361, VIPTel emitted call.begin on the channel's own
    // unique_id with caller "0412289133" (the CID presented to the redirect
    // target) and destination "090909090" (the fallback number). Merging that
    // leg rewrote the real caller's identity and resurfaced the row as a brand
    // new waiting caller on every dispatcher's screen.
    const existing = {
      from_queue_unique_id: "1788336609.1361",
      viptel_unique_id: "1788336673.1375",
    };
    expect(isQueueChannelRedirectLeg(existing, {
      status: "incoming",
      uniqueId: "1788336609.1361",
    })).toBe(true);
    // A rotation re-offer is a different leg created BY the queue: it has its
    // own unique_id and carries from_queue_unique_id.
    expect(isQueueChannelRedirectLeg(existing, {
      status: "incoming",
      uniqueId: "1788336700.1380",
      fromQueueUniqueId: "1788336609.1361",
    })).toBe(false);
    // The channel's own terminal and pickup events must keep flowing.
    expect(isQueueChannelRedirectLeg(existing, {
      status: "failed",
      uniqueId: "1788336609.1361",
    })).toBe(false);
    expect(isQueueChannelRedirectLeg(existing, {
      status: "answered",
      uniqueId: "1788336609.1361",
    })).toBe(false);
    // The caller's very first call.begin, before any agent leg took over the
    // row identity, is not a redirect.
    expect(isQueueChannelRedirectLeg(
      { from_queue_unique_id: "1788336609.1361", viptel_unique_id: "1788336609.1361" },
      { status: "incoming", uniqueId: "1788336609.1361" },
    )).toBe(false);
  });

  it("reopens only a newer offer from the same inbound queue lifecycle", () => {
    const existing = {
      direction: "inbound" as const,
      ended_at: "2026-08-11T13:43:58.000Z",
      from_queue_unique_id: "queue-parent",
      status: "abandoned_queue" as const,
      viptel_unique_id: "agent-leg-20",
    };
    const nextStation = {
      direction: "inbound" as const,
      fromQueueUniqueId: "queue-parent",
      startedAt: "2026-08-11T13:44:01.000Z",
      status: "incoming" as const,
      uniqueId: "agent-leg-21",
    };

    expect(newerInboundQueueOffer(existing, nextStation)).toBe(true);
    expect(nextCallStatus(existing.status, nextStation.status, false, true)).toBe("incoming");
    expect(newerInboundQueueOffer(existing, {
      ...nextStation,
      fromQueueUniqueId: "another-call",
    })).toBe(false);
    expect(newerInboundQueueOffer(existing, {
      ...nextStation,
      startedAt: "2026-08-11T13:43:57.000Z",
    })).toBe(false);
    expect(nextCallStatus("ended", "incoming", false, true)).toBe("ended");
  });

  it("allows a later external identity to correct an early internal placeholder", () => {
    expect(mergeViptelCallerIdentity({
      catalog,
      direction: "inbound",
      existing: { caller_number: "20", caller_name: null },
      snapshot: { callerNumber: "+421900333444", callerName: "Volajúci" },
    })).toEqual({ callerNumber: "+421900333444", callerName: "Volajúci" });
  });
});

describe("VIPTel reconciliation", () => {
  it("repairs impossible active rows from their terminal evidence", () => {
    expect(terminalStatusForEndedCall({
      answered_at: null,
      direction: "inbound",
      duration_seconds: null,
      end_reason: "cancel",
    })).toBe("missed");
    expect(terminalStatusForEndedCall({
      answered_at: "2026-08-11T13:40:00.000Z",
      direction: "inbound",
      duration_seconds: 20,
      end_reason: "answered",
    })).toBe("ended");
    expect(terminalStatusForEndedCall({
      answered_at: null,
      direction: "outbound",
      duration_seconds: 0,
      end_reason: "cancel",
    })).toBe("failed");
  });

  it("maps answered and missed CDR records to terminal snapshots", () => {
    expect(cdrSnapshot({
      cdrId: "1",
      direction: "inbound",
      disposition: "ANSWERED",
      hasRecording: false,
      raw: {},
    }).status).toBe("ended");
    expect(cdrSnapshot({
      cdrId: "2",
      direction: "inbound",
      disposition: "NO ANSWER",
      hasRecording: false,
      raw: {},
    }).status).toBe("missed");
    expect(cdrSnapshot({
      application: "queue",
      cdrId: "3",
      direction: "inbound",
      disposition: "missed",
      hasRecording: false,
      raw: {},
    }).status).toBe("abandoned_queue");
  });

  it("keeps the public received number separate from the final destination", () => {
    expect(cdrSnapshot({
      application: "queue",
      cdrId: "4",
      direction: "inbound",
      disposition: "answered",
      callerNumber: "00421900111222",
      receivedNumber: "0412289133",
      calledNumber: "0412289133",
      destinationNumber: "10",
      durationSeconds: 30,
      completeDurationSeconds: 35,
      ringSeconds: 5,
      startedAt: "2026-07-16T08:00:00.000Z",
      hasRecording: false,
      raw: {},
    })).toMatchObject({
      calledNumber: "0412289133",
      receivedNumber: "0412289133",
      destinationNumber: "10",
      answeredAt: "2026-07-16T08:00:05.000Z",
      endedAt: "2026-07-16T08:00:35.000Z",
      ringSeconds: 5,
    });
  });

  it("uses a bounded UTC lookback", () => {
    expect(viptelDateFrom(6, new Date("2026-07-16T10:15:20Z"))).toBe("2026-07-16 04:15:20");
  });
});

describe("documented VIPTel login hash", () => {
  it("matches SHA1(SHA1(username:password):nonce)", async () => {
    const { loginHash } = await import("@/worker/viptel-listener");
    const first = createHash("sha1").update("user:pass").digest("hex");
    const expected = createHash("sha1").update(`${first}:nonce`).digest("hex");
    expect(loginHash("user", "pass", "nonce")).toBe(expected);
  });
});
