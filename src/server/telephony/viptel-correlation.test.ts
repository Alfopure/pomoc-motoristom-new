import { describe, expect, it } from "vitest";

import { correlateViptelCall, type ViptelCorrelationCatalog } from "./viptel-correlation";

const catalog: ViptelCorrelationCatalog = {
  extensions: [
    { id: "extension-10", extension: "10", profile_id: "profile-jakub" },
    { id: "extension-11", extension: "11", profile_id: "profile-other" },
  ],
  lines: [{ id: "line-main", external_id: "00421412289133", phone_number: "041 228 91 33" }],
  queues: [{ id: "queue-500", external_id: "500", line_id: "line-main" }],
};

describe("VIPTel call correlation", () => {
  it("maps an inbound queue CDR to its line, queue, extension and operator", () => {
    expect(correlateViptelCall({
      application: "queue",
      direction: "inbound",
      directionAuthoritative: true,
      status: "ended",
      callerNumber: "00421900111222",
      calledNumber: "0412289133",
      receivedNumber: "0412289133",
      destinationNumber: "10",
      raw: {},
    }, catalog)).toMatchObject({
      direction: "inbound",
      destinationExtension: "10",
      extensionId: "extension-10",
      operatorId: "profile-jakub",
      lineId: "line-main",
      queueId: "queue-500",
      queueNumber: "500",
    });
  });

  it("infers an outbound agent leg when the provider omits direction", () => {
    expect(correlateViptelCall({
      direction: "inbound",
      directionAuthoritative: false,
      status: "outbound",
      callerNumber: "10",
      destinationNumber: "00421900111222",
      raw: {},
    }, catalog)).toMatchObject({
      direction: "outbound",
      callerExtension: "10",
      extensionId: "extension-10",
      operatorId: "profile-jakub",
    });
  });

  it("never infers insurer identity from shared queue 601-603 scalar line ids", () => {
    const sharedCatalog: ViptelCorrelationCatalog = {
      ...catalog,
      queues: [
        { id: "queue-601", external_id: "601", line_id: "line-main" },
        { id: "queue-602", external_id: "602", line_id: "line-main" },
        { id: "queue-603", external_id: "603", line_id: "line-main" },
      ],
    };

    for (const queueNumber of ["601", "602", "603"]) {
      expect(correlateViptelCall({
        direction: "inbound",
        status: "ringing_agent",
        queueNumber,
        raw: {},
      }, sharedCatalog)).toMatchObject({
        queueId: `queue-${queueNumber}`,
        queueNumber,
        lineId: undefined,
      });
    }
  });

  it("keeps an exact DID identity while the call is in a shared queue", () => {
    const sharedCatalog: ViptelCorrelationCatalog = {
      ...catalog,
      queues: [{ id: "queue-601", external_id: "601", line_id: "wrong-line" }],
    };

    expect(correlateViptelCall({
      direction: "inbound",
      status: "ringing_agent",
      queueNumber: "601",
      receivedNumber: "+421 41 228 91 33",
      raw: {},
    }, sharedCatalog)).toMatchObject({
      queueId: "queue-601",
      lineId: "line-main",
    });
  });

  it("rejects suffix and ambiguous DID matches", () => {
    expect(correlateViptelCall({
      direction: "inbound",
      status: "incoming",
      receivedNumber: "2289133",
      raw: {},
    }, catalog).lineId).toBeUndefined();

    expect(correlateViptelCall({
      direction: "inbound",
      status: "incoming",
      receivedNumber: "0412289133",
      raw: {},
    }, {
      ...catalog,
      lines: [
        ...catalog.lines,
        { id: "line-duplicate", external_id: null, phone_number: "+421412289133" },
      ],
    }).lineId).toBeUndefined();
  });

  it("does not treat the final destination as the received public DID", () => {
    expect(correlateViptelCall({
      direction: "inbound",
      status: "answered",
      receivedNumber: "0412289999",
      destinationNumber: "0412289133",
      raw: {},
    }, catalog).lineId).toBeUndefined();
  });

  it("does not classify an outbound destination as an inbound line", () => {
    expect(correlateViptelCall({
      direction: "outbound",
      directionAuthoritative: true,
      status: "outbound",
      callerNumber: "10",
      calledNumber: "0412289133",
      destinationNumber: "0412289133",
      raw: {},
    }, catalog).lineId).toBeUndefined();
  });
});
