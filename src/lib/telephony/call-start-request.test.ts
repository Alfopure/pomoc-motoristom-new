import { describe, expect, it, vi } from "vitest";

import { prepareCallStartRequest } from "./call-start-request";

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
