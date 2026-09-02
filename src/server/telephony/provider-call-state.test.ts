import { describe, expect, it } from "vitest";

import type { ViptelActiveCall } from "@/lib/integrations/viptel/client";
import {
  currentViptelProviderCallLegs,
  exactLiveProviderCallForExtension,
  isLiveProviderCall,
  providerCallIsCurrentAtExtension,
  providerCallUsesExtension,
} from "./provider-call-state";

describe("VIPTel live provider call classification", () => {
  it.each(["incoming", "ringing_agent", "answered", "outbound"] as const)(
    "treats %s as live",
    (status) => expect(isLiveProviderCall(call(status))).toBe(true),
  );

  it.each(["ended", "failed", "missed", "abandoned_queue"] as const)(
    "treats terminal %s as non-live even when it names the extension",
    (status) => {
      const row = call(status, { callerExtension: "20" });
      expect(isLiveProviderCall(row)).toBe(false);
      expect(providerCallUsesExtension(row, "20")).toBe(false);
    },
  );

  it("returns exactly one live source leg with the expected unique id", () => {
    const live = call("answered", { callerExtension: "20", viptelUniqueId: "live-1" });
    expect(exactLiveProviderCallForExtension(
      [call("ended", { callerExtension: "20", viptelUniqueId: "old" }), live],
      "20",
      new Set(["live-1"]),
    )).toEqual({ ok: true, call: live });
  });

  it("links a fresh queue agent leg through its known queue parent", () => {
    const offered = call("ringing_agent", {
      direction: "inbound",
      destinationExtension: "20",
      fromQueueUniqueId: "queue-parent-1",
      viptelUniqueId: "agent-leg-not-ingested-yet",
    });

    expect(exactLiveProviderCallForExtension(
      [offered],
      "20",
      new Set(["queue-parent-1"]),
    )).toEqual({ ok: true, call: offered });
  });

  it("treats two provider rows with the same queue parent as one exact live call", () => {
    const first = call("ringing_agent", {
      direction: "inbound",
      destinationExtension: "21",
      fromQueueUniqueId: "queue-parent-shared",
      viptelUniqueId: "agent-leg-21-a",
    });
    const second = call("ringing_agent", {
      direction: "inbound",
      destinationExtension: "21",
      fromQueueUniqueId: "queue-parent-shared",
      viptelUniqueId: "agent-leg-21-b",
    });

    const result = exactLiveProviderCallForExtension(
      [first, second],
      "21",
      new Set(["queue-parent-shared"]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect([first, second]).toContain(result.call);
  });

  it("does not leave control on a previous inbound route endpoint after redirect", () => {
    const redirected = call("ringing_agent", {
      direction: "inbound",
      receivedExtension: "20",
      destinationExtension: "21",
      viptelUniqueId: "redirected-1",
    });

    expect(providerCallUsesExtension(redirected, "20")).toBe(true);
    expect(providerCallIsCurrentAtExtension(redirected, "20")).toBe(false);
    expect(providerCallIsCurrentAtExtension(redirected, "21")).toBe(true);
    expect(exactLiveProviderCallForExtension([redirected], "20", new Set(["redirected-1"])))
      .toEqual({ ok: false, reason: "no_live_source_leg" });
  });

  it("does not assign a queue parent with an explicit public destination to a historical agent", () => {
    const queueParent = call("answered", {
      direction: "inbound",
      calledNumber: "0412289240",
      destinationNumber: "0412289240",
      receivedExtension: "20",
      viptelUniqueId: "queue-parent-public-did",
    });

    expect(providerCallIsCurrentAtExtension(queueParent, "20")).toBe(false);
    expect(exactLiveProviderCallForExtension(
      [queueParent],
      "20",
      new Set(["queue-parent-public-did"]),
    )).toEqual({ ok: false, reason: "no_live_source_leg" });
  });

  it("recognizes a browser-originated provider row whose direction was omitted", () => {
    const reflectedBrowserCall = call("answered", {
      direction: "inbound",
      callerNumber: "20",
      calledNumber: "+421904626370",
      viptelUniqueId: "browser-1",
    });

    expect(providerCallIsCurrentAtExtension(reflectedBrowserCall, "20")).toBe(true);
  });

  it("does not count terminal-only snapshot rows as a live source leg", () => {
    expect(exactLiveProviderCallForExtension(
      [
        call("ended", { callerExtension: "20", viptelUniqueId: "old-1" }),
        call("failed", { destinationExtension: "20", viptelUniqueId: "old-2" }),
        call("missed", { receivedExtension: "20", viptelUniqueId: "old-3" }),
        call("abandoned_queue", { calledNumber: "20", viptelUniqueId: "old-4" }),
      ],
      "20",
      new Set(["old-1", "old-2", "old-3", "old-4"]),
    )).toEqual({ ok: false, reason: "no_live_source_leg" });
  });

  it("rejects more than one live source leg, including call-waiting", () => {
    expect(exactLiveProviderCallForExtension(
      [
        call("answered", { callerExtension: "20", viptelUniqueId: "live-1" }),
        call("ringing_agent", { direction: "inbound", destinationExtension: "20", viptelUniqueId: "waiting-2" }),
      ],
      "20",
      new Set(["live-1"]),
    )).toEqual({ ok: false, reason: "multiple_live_source_legs" });
  });

  it("rejects a sole live source leg whose unique id is not owned by the app call", () => {
    expect(exactLiveProviderCallForExtension(
      [call("answered", { callerExtension: "20", viptelUniqueId: "other-call" })],
      "20",
      new Set(["expected-call"]),
    )).toEqual({ ok: false, reason: "unique_id_mismatch" });
  });

  it("keeps the current agent leg instead of double-counting its queue parent", () => {
    const parent = call("incoming", {
      viptelUniqueId: "queue-parent-a",
      startedAt: "2026-08-11T08:30:00.000Z",
    });
    const agent = call("ringing_agent", {
      direction: "inbound",
      destinationExtension: "20",
      fromQueueUniqueId: "queue-parent-a",
      viptelUniqueId: "agent-leg-a",
      startedAt: "2026-08-11T08:30:00.000Z",
    });

    expect(currentViptelProviderCallLegs([parent, agent])).toEqual([agent]);
  });

  it("preserves two unrelated calls that started in the same millisecond", () => {
    const first = call("ringing_agent", {
      direction: "inbound",
      destinationExtension: "20",
      viptelUniqueId: "simultaneous-a",
      startedAt: "2026-08-11T08:30:00.000Z",
    });
    const second = call("ringing_agent", {
      direction: "inbound",
      destinationExtension: "21",
      viptelUniqueId: "simultaneous-b",
      startedAt: "2026-08-11T08:30:00.000Z",
    });

    expect(currentViptelProviderCallLegs([first, second])).toEqual([first, second]);
  });
});

function call(
  status: ViptelActiveCall["status"],
  overrides: Partial<ViptelActiveCall> = {},
): ViptelActiveCall {
  return {
    direction: "outbound",
    status,
    raw: {},
    ...overrides,
  };
}
