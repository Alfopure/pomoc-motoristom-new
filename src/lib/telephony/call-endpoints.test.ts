import { describe, expect, it } from "vitest";

import type { CallCenterCall } from "@/data/dispatch-types";
import {
  callIsCurrentAtTelephonyStation,
  callIsRingingAtTelephonyStation,
  collapseLogicalTelephonyCalls,
  exactTelephonyEndpoint,
  mergeProviderCallsWithHistory,
  partitionLiveTelephonyCalls,
  resolveIncomingBrowserProviderCall,
  resolveOutboundBrowserProviderCall,
  resolveTelephonyCallStations,
  resolveUniqueCurrentTelephonyCall,
  sameTelephonyCallIdentity,
  telephonyCallReactKey,
} from "./call-endpoints";

const stations = [
  { extension: "20", profileId: "operator-20" },
  { extension: "21", profileId: "operator-21" },
];

describe("telephony call endpoint resolution", () => {
  it("keeps provisional queue-handoff calls active without relying on a UI label", () => {
    const first = call({
      id: "waiting-a",
      status: "incoming",
      lineLabel: "Linka pomoci motoristom",
      fromQueueUniqueId: "parent-a",
    });
    const second = call({
      id: "waiting-b",
      status: "ringing_agent",
      lineLabel: "Unknown line",
      fromQueueUniqueId: "parent-b",
    });
    const ended = call({ id: "ended", status: "missed" });

    expect(partitionLiveTelephonyCalls([first, second, ended])).toEqual({
      active: [first, second],
      completed: [ended],
    });
  });

  it("removes a stale actionable history row after an authoritative empty provider snapshot", () => {
    const phantom = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "answered",
      destinationExtension: "21",
    });

    expect(mergeProviderCallsWithHistory([phantom], null)).toEqual([phantom]);
    expect(mergeProviderCallsWithHistory([phantom], [])).toEqual([]);
  });

  it("keeps ended history but normalizes an impossible active status with endedAt", () => {
    const corrupted = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "answered",
      endedAt: "2026-08-11T13:41:19.852Z",
    });

    expect(mergeProviderCallsWithHistory([corrupted], [])).toEqual([
      expect.objectContaining({ id: corrupted.id, status: "missed" }),
    ]);
  });

  it("normalizes a SIP URI but never accepts substring or Unicode lookalike extensions", () => {
    expect(exactTelephonyEndpoint("  SIP:20@pbx.example.sk  ")).toBe("20");

    for (const callerExtension of ["120", "20x", "２０", "sip:@pbx.example.sk", "2".repeat(100_000)]) {
      const resolved = resolveTelephonyCallStations(call({
        direction: "outbound",
        status: "outbound",
        callerExtension,
        operatorId: undefined,
      }), stations);

      expect(resolved.source, `caller extension ${callerExtension.slice(0, 32)} must not match 20`).toBeUndefined();
      expect(resolved.current).toEqual([]);
    }
  });

  it("uses a confirmed directional endpoint instead of a stale foreign operator identity", () => {
    const inbound = call({
      direction: "inbound",
      status: "ringing_agent",
      destinationExtension: "21",
      receivedExtension: "20",
      operatorId: "operator-20",
    });

    expect(callIsCurrentAtTelephonyStation(inbound, stations[0], stations)).toBe(false);
    expect(callIsCurrentAtTelephonyStation(inbound, stations[1], stations)).toBe(true);
  });

  it("shows ringing controls only at the provider's current destination", () => {
    const inbound = call({
      direction: "inbound",
      status: "ringing_agent",
      calledNumber: "21",
      receivedExtension: "20",
      operatorId: "operator-20",
    });

    expect(callIsRingingAtTelephonyStation(inbound, stations[0], stations)).toBe(false);
    expect(callIsRingingAtTelephonyStation(inbound, stations[1], stations)).toBe(true);
  });

  it("does not give every operator controls for an unresolved queue-level call", () => {
    const queueCall = call({
      direction: "inbound",
      status: "incoming",
      calledNumber: "601",
      receivedExtension: "20",
      operatorId: "operator-20",
    });

    expect(stations.every((station) => !callIsRingingAtTelephonyStation(queueCall, station, stations))).toBe(true);
    expect(resolveTelephonyCallStations(queueCall, stations).current).toEqual([]);
  });

  it("does not use a historical owner when the provider explicitly points at a public DID", () => {
    const queueParent = call({
      direction: "inbound",
      status: "answered",
      calledNumber: "0412289240",
      destinationNumber: "0412289240",
      receivedExtension: "20",
      operatorId: "operator-20",
    });

    expect(resolveTelephonyCallStations(queueParent, stations).current).toEqual([]);
    expect(callIsCurrentAtTelephonyStation(queueParent, stations[0], stations)).toBe(false);
  });

  it("correlates an answered provider leg to the browser that is still ringing", () => {
    const answered = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "provider-safe-id",
      status: "answered",
      destinationNumber: "20",
    });

    expect(resolveIncomingBrowserProviderCall([answered], stations[0], stations)).toBe(answered);
  });

  it("uses one unambiguous provider leg when VIPTel omits the workstation endpoint", () => {
    const answered = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "provider-safe-id",
      status: "answered",
      calledNumber: "601",
    });

    expect(resolveIncomingBrowserProviderCall([answered], stations[0], stations)).toBe(answered);
  });

  it("never assigns another workstation's explicit provider leg to this browser", () => {
    const workstation21 = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "provider-safe-id",
      status: "answered",
      destinationNumber: "21",
    });

    expect(resolveIncomingBrowserProviderCall([workstation21], stations[0], stations)).toBeUndefined();
    expect(resolveIncomingBrowserProviderCall([workstation21], stations[1], stations)).toBe(workstation21);
  });

  it("fails closed for ambiguous or terminal provider rows", () => {
    const first = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "provider-safe-id-a",
      status: "answered",
      calledNumber: "601",
    });
    const second = call({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      viptelUniqueId: "provider-safe-id-b",
      status: "answered",
      calledNumber: "601",
    });
    const missed = call({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      viptelUniqueId: "provider-safe-id-c",
      status: "missed",
      calledNumber: "20",
    });

    expect(resolveIncomingBrowserProviderCall([first, second], stations[0], stations)).toBeUndefined();
    expect(resolveIncomingBrowserProviderCall([missed], stations[0], stations)).toBeUndefined();
    expect(resolveIncomingBrowserProviderCall([
      { ...first, id: "provider-row-without-a-persisted-uuid" },
    ], stations[0], stations)).toBeUndefined();
  });

  it("keeps two calls from the same second isolated by exact workstation and provider identity", () => {
    const workstation20 = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "simultaneous-call-20",
      destinationExtension: "20",
      startedAt: "2026-08-11T08:30:00.000Z",
    });
    const workstation21 = call({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      viptelUniqueId: "simultaneous-call-21",
      destinationExtension: "21",
      startedAt: "2026-08-11T08:30:00.000Z",
    });

    for (const ordered of [[workstation20, workstation21], [workstation21, workstation20]]) {
      expect(resolveIncomingBrowserProviderCall(ordered, stations[0], stations)).toBe(workstation20);
      expect(resolveIncomingBrowserProviderCall(ordered, stations[1], stations)).toBe(workstation21);
      expect(resolveUniqueCurrentTelephonyCall(ordered, stations[0], stations)).toBe(workstation20);
      expect(resolveUniqueCurrentTelephonyCall(ordered, stations[1], stations)).toBe(workstation21);
    }
  });

  it("never selects the first of two distinct calls assigned to one browser", () => {
    const first = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "provider-safe-id-a",
      destinationExtension: "20",
    });
    const second = call({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      viptelUniqueId: "provider-safe-id-b",
      destinationExtension: "20",
    });

    expect(resolveIncomingBrowserProviderCall([first, second], stations[0], stations)).toBeUndefined();
    expect(resolveUniqueCurrentTelephonyCall([first, second], stations[0], stations)).toBeUndefined();
  });

  it("resolves duplicate agent legs of one queue call without merging another caller", () => {
    const firstLeg = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "agent-leg-a",
      fromQueueUniqueId: "queue-parent-a",
      destinationExtension: "21",
    });
    const duplicateLeg = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "agent-leg-b",
      fromQueueUniqueId: "queue-parent-a",
      destinationExtension: "21",
    });
    const otherCaller = call({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      viptelUniqueId: "agent-leg-other",
      fromQueueUniqueId: "queue-parent-other",
      destinationExtension: "20",
      startedAt: firstLeg.startedAt,
    });

    const resolved = resolveIncomingBrowserProviderCall(
      [duplicateLeg, otherCaller, firstLeg],
      stations[1],
      stations,
    );
    expect([firstLeg, duplicateLeg]).toContain(resolved);
    expect(collapseLogicalTelephonyCalls([firstLeg, duplicateLeg, otherCaller])).toHaveLength(2);
  });

  it("correlates simultaneous outbound calls by source workstation and dialled target", () => {
    const workstation20 = call({
      direction: "outbound",
      status: "outbound",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "outbound-20",
      callerExtension: "20",
      calledNumber: "+421900111111",
      destinationNumber: "+421900111111",
    });
    const workstation21 = call({
      direction: "outbound",
      status: "outbound",
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      viptelUniqueId: "outbound-21",
      callerExtension: "21",
      calledNumber: "+421900222222",
      destinationNumber: "+421900222222",
    });

    expect(resolveOutboundBrowserProviderCall(
      [workstation21, workstation20],
      stations[0],
      stations,
      "+421 900 111 111",
    )).toBe(workstation20);
    expect(resolveOutboundBrowserProviderCall(
      [workstation20, workstation21],
      stations[1],
      stations,
      "+421 900 222 222",
    )).toBe(workstation21);
  });

  it("links a queue parent to its agent leg without merging unrelated simultaneous calls", () => {
    const queueParent = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "queue-parent-a",
    });
    const agentLeg = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "agent-leg-a",
      fromQueueUniqueId: "queue-parent-a",
      destinationExtension: "20",
    });
    const simultaneousOtherCall = call({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      viptelUniqueId: "queue-parent-b",
      destinationExtension: "21",
      startedAt: queueParent.startedAt,
    });

    expect(sameTelephonyCallIdentity(queueParent, agentLeg)).toBe(true);
    expect(sameTelephonyCallIdentity(agentLeg, simultaneousOtherCall)).toBe(false);
  });

  it("keeps a live queue parent visible over its terminal agent offer", () => {
    const queueParent = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "incoming",
      viptelUniqueId: "queue-parent-live",
    });
    const finishedOffer = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "missed",
      viptelUniqueId: "agent-leg-finished",
      fromQueueUniqueId: "queue-parent-live",
      destinationExtension: "21",
    });

    expect(collapseLogicalTelephonyCalls([finishedOffer, queueParent])).toEqual([queueParent]);
  });

  it("does not merge simultaneous provider calls that were correlated to the same stored row", () => {
    const first = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "simultaneous-provider-a",
    });
    const second = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "simultaneous-provider-b",
    });

    expect(sameTelephonyCallIdentity(first, second)).toBe(false);
  });

  it("gives two simultaneous callers sharing one stored id distinct react keys", () => {
    const first = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "simultaneous-provider-a",
    });
    const second = call({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      viptelUniqueId: "simultaneous-provider-b",
    });

    // These rows are deliberately not merged by sameTelephonyCallIdentity, so
    // keying them by call.id alone would produce a duplicate React key.
    expect(sameTelephonyCallIdentity(first, second)).toBe(false);
    expect(telephonyCallReactKey(first)).not.toBe(telephonyCallReactKey(second));
  });

  it("keeps a react key stable for the same row and separates queue parent from agent child", () => {
    const parent = call({ id: "shared", viptelUniqueId: "parent-1" });
    const child = call({ id: "shared", viptelUniqueId: "child-1", fromQueueUniqueId: "parent-1" });

    expect(telephonyCallReactKey(parent)).toBe(telephonyCallReactKey({ ...parent }));
    expect(telephonyCallReactKey(parent)).not.toBe(telephonyCallReactKey(child));
  });

  it("does not let a missing provider identity shift another value into its slot", () => {
    const onlyProviderCallId = call({ id: "x", providerCallId: "shared-token" });
    const onlyViptelId = call({ id: "x", viptelUniqueId: "shared-token" });

    expect(telephonyCallReactKey(onlyProviderCallId)).not.toBe(telephonyCallReactKey(onlyViptelId));
  });
});

function call(overrides: Partial<CallCenterCall>): CallCenterCall {
  return {
    id: "call-adversarial-endpoint",
    status: "incoming",
    direction: "inbound",
    callerNumber: "+421900111222",
    calledNumber: "+421412289240",
    lineLabel: "Allianz Assistance",
    startedAt: "2026-08-05T12:00:00.000Z",
    waitSeconds: 0,
    recordingStatus: "not_requested",
    transcriptStatus: "not_requested",
    history: [],
    ...overrides,
  };
}
