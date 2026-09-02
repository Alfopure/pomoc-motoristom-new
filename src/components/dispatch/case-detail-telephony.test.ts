import { describe, expect, it } from "vitest";
import { buildCaseCustomerCallBody } from "./case-detail-telephony";

describe("case customer telephony request", () => {
  it("preserves the complete workplace lease fence", () => {
    expect(buildCaseCustomerCallBody({
      caseId: "case-1",
      toNumber: "+421910123456",
      workplaceFence: {
        assignmentGeneration: "generation-20",
        browserInstanceId: "browser-1",
        leaderEpoch: 3,
        leaseId: "lease-20",
        leaseVersion: 7,
      },
    })).toEqual({
      mode: "extension_callback",
      toNumber: "+421910123456",
      caseId: "case-1",
      assignmentGeneration: "generation-20",
      browserInstanceId: "browser-1",
      leaderEpoch: 3,
      leaseId: "lease-20",
      leaseVersion: 7,
    });
  });
});
