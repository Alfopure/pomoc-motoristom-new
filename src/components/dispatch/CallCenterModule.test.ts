import { describe, expect, it } from "vitest";
import type { CallCenterCall } from "@/data/dispatch-types";
import { customerNumberForCall, historyDisplayStartedAt, presentCallForBrowser } from "./CallCenterModule";

describe("history call destination", () => {
  it("calls the customer side of inbound and outbound history rows", () => {
    expect(customerNumberForCall({
      direction: "inbound",
      callerNumber: "+421900111222",
      calledNumber: "20",
    })).toBe("+421900111222");
    expect(customerNumberForCall({
      direction: "outbound",
      callerNumber: "20",
      calledNumber: "+421900333444",
    })).toBe("+421900333444");
  });
});

describe("history call time", () => {
  const now = Date.parse("2026-08-10T10:00:00.000Z");

  it("uses the database receipt time when a legacy CDR timestamp is still in the future", () => {
    expect(historyDisplayStartedAt({
      createdAt: "2026-08-10T09:18:58.243Z",
      startedAt: "2026-08-10T11:18:57.000Z",
    }, now)).toBe("2026-08-10T09:18:58.243Z");
  });

  it("keeps an ordinary historical start time", () => {
    expect(historyDisplayStartedAt({
      createdAt: "2026-08-10T09:18:58.243Z",
      startedAt: "2026-08-10T09:18:57.000Z",
    }, now)).toBe("2026-08-10T09:18:57.000Z");
  });

  it("continues correcting an older two-hour CDR wall-clock shift", () => {
    expect(historyDisplayStartedAt({
      createdAt: "2026-08-10T09:18:58.243Z",
      startedAt: "2026-08-10T11:18:57.000Z",
    }, Date.parse("2026-08-10T14:00:00.000Z"))).toBe("2026-08-10T09:18:58.243Z");
  });
});

describe("browser call presentation", () => {
  const reflectedProviderLeg = {
    id: "call-1",
    viptelUniqueId: "provider-call-1",
    status: "incoming",
    direction: "inbound",
    callerNumber: "20",
    callerName: "Šéf",
    calledNumber: "+421904626370",
    lineLabel: "VIPTel live",
    startedAt: "2026-08-08T10:00:00.000Z",
    waitSeconds: 2,
    recordingStatus: "not_requested",
    transcriptStatus: "not_requested",
    history: [],
  } satisfies CallCenterCall;

  it("shows a reflected PBX leg as the outbound browser call the employee actually made", () => {
    const presented = presentCallForBrowser(reflectedProviderLeg, {
      activeCallTarget: "+421904626370",
      callDirection: "outbound",
      hasActiveCall: true,
    });

    expect(presented).toMatchObject({
      direction: "outbound",
      status: "outbound",
      calledNumber: "+421904626370",
      destinationNumber: "+421904626370",
      callerName: undefined,
    });
  });

  it("does not rewrite provider data without an active outbound browser call", () => {
    expect(presentCallForBrowser(reflectedProviderLeg, {
      activeCallTarget: null,
      callDirection: "inbound",
      hasActiveCall: true,
    })).toBe(reflectedProviderLeg);
  });
});
