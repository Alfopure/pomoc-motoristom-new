import { describe, expect, it } from "vitest";
import { isHandoffDeliveryReceipt, isHandoffReceipt } from "./case-handoff";

const handoffId = "10000000-0000-4000-8000-000000000001";
const memberId = "20000000-0000-4000-8000-000000000001";
const commandId = "30000000-0000-4000-8000-000000000001";
const command = { action: "deliver", commandId, handoffId, recipientMemberId: memberId, expectedRevision: 2 };
const delivered = { commandId, handoffId, memberId, sent: true, currentRevision: 3 };

describe("handoff assignment receipts", () => {
  it("accepts confirmation and later replay of the exact assignment", () => {
    expect(isHandoffDeliveryReceipt(delivered, command)).toBe(true);
    expect(isHandoffDeliveryReceipt({ ...delivered, currentRevision: 5 }, command)).toBe(true);
  });
  it.each([
    { commandId: "another-command" }, { handoffId: "another-handoff" }, { memberId: "another-member" },
    { sent: false }, { currentRevision: 1 }, { currentRevision: 2.5 },
  ])("rejects mismatched or unconfirmed assignment %j", change => {
    expect(isHandoffDeliveryReceipt({ ...delivered, ...change }, command)).toBe(false);
  });
  it("requires an explicit app-assignment outcome after an issue targeted at a member", () => {
    const issue = { action: "issue", commandId, recipientMemberId: memberId };
    const receipt = { commandId, committedRevision: 1, handoff: { id: handoffId, status: "offered", revision: 1, publishedVersion: 1 } };
    expect(isHandoffReceipt(receipt, issue)).toBe(false);
    expect(isHandoffReceipt({ ...receipt, delivery: { status: "sent", memberId } }, issue)).toBe(true);
    expect(isHandoffReceipt({ ...receipt, delivery: { status: "failed", memberId } }, issue)).toBe(true);
    expect(isHandoffReceipt({ ...receipt, delivery: { status: "sent", memberId: "another-member" } }, issue)).toBe(false);
    expect(isHandoffReceipt(receipt, { action: "issue", commandId })).toBe(true);
  });
});
