import { describe, expect, it } from "vitest";

import {
  hangupProviderUniqueId,
  providerRedirectIsSafe,
  redirectDestination,
  selectAvailableTransferTargets,
  storedCallCanAuthorizeIncomingQueueDecline,
} from "./call-commands";

describe("hangup provider identity", () => {
  it("hangs up the logical queue parent instead of advancing only the current agent leg", () => {
    expect(hangupProviderUniqueId({
      direction: "inbound",
      from_queue_unique_id: "queue-parent.1",
    }, "agent-leg.2")).toBe("queue-parent.1");
  });

  it("keeps the current provider leg for direct and outbound calls", () => {
    expect(hangupProviderUniqueId({
      direction: "outbound",
      from_queue_unique_id: "historical-parent.1",
    }, "outbound-leg.2")).toBe("outbound-leg.2");
  });

  it("uses the live queue parent while event ingestion is still catching up", () => {
    expect(hangupProviderUniqueId({
      direction: "inbound",
      from_queue_unique_id: null,
    }, "agent-leg.2", "queue-parent.1")).toBe("queue-parent.1");
  });
});

describe("queued incoming decline authorization", () => {
  const now = Date.parse("2026-08-09T12:00:00.000Z");
  const base = {
    answered_at: null,
    direction: "inbound" as const,
    ended_at: null,
    from_queue_unique_id: "queue-parent.1",
    status: "ringing_agent" as const,
    updated_at: "2026-08-09T11:59:30.000Z",
  };

  it("keeps an explicitly ringing queue offer controllable during a provider handoff", () => {
    expect(storedCallCanAuthorizeIncomingQueueDecline(base, now)).toBe(true);
  });

  it("accepts only the short VIPTel answered-before-SIP race", () => {
    expect(storedCallCanAuthorizeIncomingQueueDecline({
      ...base,
      answered_at: "2026-08-09T11:59:40.000Z",
      status: "answered",
    }, now)).toBe(true);
    expect(storedCallCanAuthorizeIncomingQueueDecline({
      ...base,
      answered_at: "2026-08-09T11:55:00.000Z",
      status: "answered",
    }, now)).toBe(false);
  });

  it("allows only a short terminal queue-handoff gap before a fresh provider recheck", () => {
    expect(storedCallCanAuthorizeIncomingQueueDecline({
      ...base,
      status: "abandoned_queue",
      updated_at: "2026-08-09T11:59:55.000Z",
    }, now)).toBe(true);
    expect(storedCallCanAuthorizeIncomingQueueDecline({
      ...base,
      status: "abandoned_queue",
      updated_at: "2026-08-09T11:59:40.000Z",
    }, now)).toBe(false);
    expect(storedCallCanAuthorizeIncomingQueueDecline({
      ...base,
      ended_at: "2026-08-09T11:59:57.000Z",
      status: "abandoned_queue",
      updated_at: "2026-08-09T11:59:57.000Z",
    }, now)).toBe(false);
  });

  it("never authorizes a direct, outbound or terminal call through the queue-decline exception", () => {
    expect(storedCallCanAuthorizeIncomingQueueDecline({ ...base, from_queue_unique_id: null }, now)).toBe(false);
    expect(storedCallCanAuthorizeIncomingQueueDecline({ ...base, direction: "outbound" }, now)).toBe(false);
    expect(storedCallCanAuthorizeIncomingQueueDecline({ ...base, status: "ended" }, now)).toBe(false);
  });
});

describe("provider redirect direction", () => {
  it("allows replacing the receiving operator on an inbound call", () => {
    expect(providerRedirectIsSafe("inbound")).toBe(true);
  });

  it.each(["outbound", "internal"] as const)(
    "does not replace the client side of a %s call",
    (direction) => expect(providerRedirectIsSafe(direction)).toBe(false),
  );
});

const providerExtension = (extension: string, isRegistered = true) => ({
  extension,
  isRegistered,
  allowedChanges: [],
  raw: {},
});
const queueMember = (extension: string, options: { paused?: boolean; inUse?: boolean } = {}) => ({
  extension,
  paused: options.paused ?? false,
  inUse: options.inUse ?? false,
  dynamic: true,
  callsTaken: 0,
});

describe("transfer target selection", () => {
  it("returns only another owned, registered, available and idle operator extension", () => {
    const targets = selectAvailableTransferTargets({
      actorProfileId: "profile-source",
      sourceExtensionId: "ext-12",
      extensions: [
        { id: "ext-12", extension: "12", profile_id: "profile-source" },
        { id: "ext-13", extension: "13", profile_id: "profile-ready" },
        { id: "ext-14", extension: "14", profile_id: "profile-paused" },
        { id: "ext-15", extension: "15", profile_id: "profile-unregistered" },
        { id: "ext-16", extension: "16", profile_id: "profile-busy" },
        { id: "ext-17", extension: "17", profile_id: null },
      ],
      profiles: [
        { id: "profile-source", display_name: "Jakub" },
        { id: "profile-ready", display_name: "Anna" },
        { id: "profile-paused", display_name: "Pauza" },
        { id: "profile-unregistered", display_name: "Bez registrácie" },
        { id: "profile-busy", display_name: "Obsadený" },
      ],
      providerExtensions: [
        providerExtension("12"),
        providerExtension("13"),
        providerExtension("14"),
        providerExtension("15", false),
        providerExtension("16"),
        providerExtension("17"),
      ],
      queueStatuses: [{
        queue: "500",
        waitingCalls: 0,
        members: [
          queueMember("12"),
          queueMember("13"),
          queueMember("14", { paused: true }),
          queueMember("15"),
          queueMember("16"),
          queueMember("17"),
        ],
      }],
      activeCalls: [{
        viptelUniqueId: "busy-1",
        direction: "outbound",
        status: "answered",
        callerNumber: "16",
        calledNumber: "00421900111222",
        raw: {},
      }],
    });

    expect(targets).toEqual([{
      profileId: "profile-ready",
      operatorName: "Anna",
      extensionId: "ext-13",
      extension: "13",
    }]);
  });

  it("keeps an operator available when at least one of several queue memberships is usable", () => {
    const targets = selectAvailableTransferTargets({
      actorProfileId: "profile-source",
      sourceExtensionId: "ext-12",
      extensions: [
        { id: "ext-12", extension: "12", profile_id: "profile-source" },
        { id: "ext-13", extension: "13", profile_id: "profile-ready" },
      ],
      profiles: [
        { id: "profile-source", display_name: "Jakub" },
        { id: "profile-ready", display_name: "Anna" },
      ],
      providerExtensions: [providerExtension("12"), providerExtension("13")],
      queueStatuses: [
        { queue: "500", waitingCalls: 0, members: [queueMember("13", { paused: true })] },
        { queue: "501", waitingCalls: 0, members: [queueMember("13")] },
      ],
      activeCalls: [],
    });

    expect(targets.map((target) => target.extension)).toEqual(["13"]);
  });

  it.each(["ended", "failed", "missed", "abandoned_queue"] as const)(
    "does not mark a transfer target busy from a terminal %s snapshot row",
    (status) => {
      const targets = selectAvailableTransferTargets({
        actorProfileId: "profile-source",
        sourceExtensionId: "ext-12",
        extensions: [
          { id: "ext-12", extension: "12", profile_id: "profile-source" },
          { id: "ext-13", extension: "13", profile_id: "profile-ready" },
        ],
        profiles: [
          { id: "profile-source", display_name: "Jakub" },
          { id: "profile-ready", display_name: "Anna" },
        ],
        providerExtensions: [providerExtension("12"), providerExtension("13")],
        queueStatuses: [{ queue: "601", waitingCalls: 0, members: [queueMember("13")] }],
        activeCalls: [{
          viptelUniqueId: `terminal-${status}`,
          direction: "outbound",
          status,
          callerExtension: "13",
          raw: {},
        }],
      });

      expect(targets.map((target) => target.extension)).toEqual(["13"]);
    },
  );
});

describe("redirect destination validation", () => {
  it("keeps operator targets on the availability-checked profile path", () => {
    expect(redirectDestination({
      destinationProfileId: "11111111-1111-4111-8111-111111111111",
    })).toEqual({
      kind: "operator",
      profileId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it.each([
    ["0900 111 222", "0900111222"],
    ["+421 900 111 222", "0900111222"],
    ["+420 777 111 222", "00420777111222"],
  ])("normalizes an external number %s for VIPTel", (input, expected) => {
    expect(redirectDestination({ destinationNumber: input })).toEqual({ kind: "phone", number: expected });
  });

  it("does not let a typed extension bypass station availability validation", () => {
    expect(() => redirectDestination({ destinationNumber: "21" })).toThrow(/Klapku/);
  });

  it("requires exactly one destination kind", () => {
    expect(() => redirectDestination({})).toThrow(/práve jedno/);
    expect(() => redirectDestination({
      destinationNumber: "0900111222",
      destinationProfileId: "11111111-1111-4111-8111-111111111111",
    })).toThrow(/práve jedno/);
  });
});
