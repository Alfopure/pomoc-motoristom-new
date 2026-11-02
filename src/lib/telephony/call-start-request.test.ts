import { describe, expect, it, vi } from "vitest";

import { prepareCallStartRequest, withEarlyAccept } from "./call-start-request";

describe("call start request identity", () => {
  it("reconciles a lost response with the exact request and rejects another target", () => {
    const createId = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    const first = prepareCallStartRequest(null, "/api/telephony/calls", { to: "+421900000001", caseId: "case-1" }, createId);
    expect(prepareCallStartRequest(first, first.path, { to: "+421900000001", caseId: "case-1" }, createId)).toBe(first);
    expect(JSON.parse(first.body).requestId).toBe(first.requestId);
    expect(createId).toHaveBeenCalledTimes(1);
    expect(() => prepareCallStartRequest(first, first.path, { to: "+421900000002", caseId: "case-1" }, createId)).toThrow(/predchádzajúceho/);
    expect(() => prepareCallStartRequest(first, "/api/telephony/calls/internal", { to: "+421900000001", caseId: "case-1" }, createId)).toThrow(/predchádzajúceho/);
    expect(createId).toHaveBeenCalledTimes(1);
  });
});

describe("early accept around a start request (call-speed S3)", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const phone = () => {
    const order: string[] = [];
    return { order, expectOperatorRequest: vi.fn(() => { order.push("arm"); }), releaseOperatorRequest: vi.fn(() => { order.push("release"); }) };
  };

  it("arms before the POST and releases after its response", async () => {
    const webphone = phone();
    await withEarlyAccept(requestId, () => true, async () => { webphone.order.push("post"); })(webphone);
    expect(webphone.order).toEqual(["arm", "post", "release"]);
    expect(webphone.expectOperatorRequest).toHaveBeenCalledWith({ requestId, timingOperationId: requestId });
    expect(webphone.releaseOperatorRequest).toHaveBeenCalledWith(requestId);
  });

  it("releases (and so hangs up an unconfirmed leg) when the start fails", async () => {
    const webphone = phone();
    const failure = new Error("Hovor sa nepodarilo vytočiť.");
    await expect(withEarlyAccept(requestId, () => true, async () => { webphone.order.push("post"); throw failure; })(webphone)).rejects.toBe(failure);
    expect(webphone.order).toEqual(["arm", "post", "release"]);
  });

  it("does nothing with the switch off or without a phone", async () => {
    const webphone = phone();
    const execute = vi.fn(async () => undefined);
    await withEarlyAccept(requestId, () => false, execute)(webphone);
    expect(execute).toHaveBeenCalledWith(webphone);
    expect(webphone.order).toEqual([]);
    await withEarlyAccept(requestId, () => true, execute)(null);
    expect(execute).toHaveBeenLastCalledWith(null);
  });
});
