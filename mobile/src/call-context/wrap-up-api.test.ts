import { describe, expect, it, vi } from "vitest";
import type { MobileTransport } from "../lib/api";
import { createCallWrapUpApi } from "./wrap-up-api";

const profile = "00000000-0000-4000-8000-000000000001", organization = "00000000-0000-4000-8000-000000000002";
const callId = "00000000-0000-4000-8000-0000000000ca", caseA = "00000000-0000-4000-8000-0000000000aa", caseB = "00000000-0000-4000-8000-0000000000bb";
const mutationId = "00000000-0000-4000-8000-0000000000ee";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: profile, organizationId: organization, checkedAt: "2026-10-18T09:00:00Z" };
function wrapUp(change: Record<string, unknown> = {}) {
  return { ...scope, callId, number: "+421905111222", linkedCaseId: caseA, linkedCase: { id: caseA, caseNumber: "PM-1", statusLabel: "Prebieha" },
    outcome: { value: "callback", label: "Zavolať naspäť", note: "Po\n11:00", callbackMinutes: 30, at: "2026-10-18T09:05:00Z" }, callbackScheduling: "case_task",
    suggestions: [{ caseId: caseB, caseNumber: "PM-2", statusLabel: "Nový", open: true, contactName: "Ján", reason: "contact" }], matchesAvailable: true, ...change };
}
function setup(body: unknown = wrapUp(), status = 200, current = () => true) {
  const transport = vi.fn<MobileTransport>().mockImplementation(async () => Response.json(body, { status }));
  const token = vi.fn(async () => "fixture-token");
  return { transport, token, api: createCallWrapUpApi(config, profile, organization, token, current, transport) };
}

describe("after-call read transport", () => {
  it("reads one call with organization fencing", async () => {
    const f = setup();
    expect((await f.api.read(callId.toUpperCase())).outcome?.label).toBe("Zavolať naspäť");
    expect(f.transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/calls/" + callId + "/wrap-up", expect.objectContaining({ method: "GET", credentials: "omit", redirect: "error",
      headers: { Authorization: "Bearer fixture-token", Accept: "application/json", "X-PM-App-Environment": "test", "X-PM-Expected-Organization": organization } }));
  });
  it.each([
    { organizationId: caseA }, { callId: caseA }, { linkedCaseId: caseA.toUpperCase() }, { linkedCase: { id: caseB, caseNumber: "PM-1", statusLabel: "x" } },
    { callbackScheduling: "case_task", linkedCaseId: null, linkedCase: null }, { callbackScheduling: "later" },
    { outcome: { value: "reached", label: "Zavolať naspäť", note: null, callbackMinutes: null, at: null } },
    { outcome: { value: "reached", label: "Dovolané", note: null, callbackMinutes: 30, at: null } },
    { suggestions: [{ caseId: caseA, caseNumber: "PM-1", statusLabel: "x", open: true, contactName: null, reason: "contact" }] },
    { suggestions: [{ caseId: caseB, caseNumber: "PM-2", statusLabel: "x", open: true, contactName: null, reason: "guess" }] },
    { matchesAvailable: false }, { number: "sip:private@sip.telnyx.com" }, { raw: "private" },
  ])("rejects contradictory or expanded projections %#", async change => {
    await expect(setup(wrapUp(change)).api.read(callId)).rejects.toMatchObject({ status: 502 });
  });
  it("accepts an unlinked call without outcome or suggestions", async () => {
    const result = await setup(wrapUp({ linkedCaseId: null, linkedCase: null, outcome: null, callbackScheduling: "unavailable", suggestions: [], matchesAvailable: false })).api.read(callId);
    expect(result.linkedCaseId).toBeNull();
  });
  it("hides data after the account fence changes", async () => {
    let live = true; const f = setup(wrapUp(), 200, () => live);
    f.transport.mockImplementation(async () => { live = false; return Response.json(wrapUp()); });
    await expect(f.api.read(callId)).rejects.toMatchObject({ status: 401 });
  });
});

describe("after-call write transport", () => {
  it("sends a trimmed outcome with its mutation identity and verifies the receipt", async () => {
    const f = setup({ ...scope, callId, mutationId, replayed: false });
    await f.api.saveOutcome(callId, { mutationId: mutationId.toUpperCase(), outcome: "reached", note: "  Dovo\u0007lané  ", callbackMinutes: null });
    expect(f.transport.mock.calls[0][0]).toBe(config.apiOrigin + "/api/mobile/v1/calls/" + callId + "/outcome");
    expect(JSON.parse(String(f.transport.mock.calls[0][1].body))).toEqual({ mutationId, outcome: "reached", note: "Dovolané", callbackMinutes: null });
    await expect(setup({ ...scope, callId, mutationId: caseA, replayed: false }).api.saveOutcome(callId, { mutationId, outcome: "reached", note: null, callbackMinutes: null })).rejects.toMatchObject({ status: 502 });
  });
  it.each([
    { mutationId: "x", outcome: "reached", note: null, callbackMinutes: null }, { mutationId, outcome: "maybe", note: null, callbackMinutes: null },
    { mutationId, outcome: "callback", note: null, callbackMinutes: null }, { mutationId, outcome: "reached", note: null, callbackMinutes: 30 },
    { mutationId, outcome: "reached", note: "x".repeat(501), callbackMinutes: null },
  ])("refuses an incomplete outcome locally %#", async input => {
    const f = setup();
    await expect(f.api.saveOutcome(callId, input as never)).rejects.toMatchObject({ status: 400 }); expect(f.token).not.toHaveBeenCalled();
  });
  it("links conditionally on the link the dispatcher saw", async () => {
    const f = setup({ ...scope, callId, caseId: caseB, changed: true });
    expect((await f.api.linkCase(callId, { caseId: caseB.toUpperCase(), expectedCaseId: caseA })).changed).toBe(true);
    expect(JSON.parse(String(f.transport.mock.calls[0][1].body))).toEqual({ caseId: caseB, expectedCaseId: caseA });
    await expect(setup({ ...scope, callId, caseId: caseA, changed: true }).api.linkCase(callId, { caseId: caseB, expectedCaseId: null })).rejects.toMatchObject({ status: 502 });
  });
  it("passes refusals with their code and reports a lost answer as unknown", async () => {
    await expect(setup({ ok: false, error: "Hovor medzitým priradil kolega." }, 409).api.linkCase(callId, { caseId: caseB, expectedCaseId: null }))
      .rejects.toMatchObject({ status: 409, message: "Hovor medzitým priradil kolega." });
    const f = setup(); f.transport.mockRejectedValue(new TypeError("offline"));
    await expect(f.api.saveOutcome(callId, { mutationId, outcome: "reached", note: null, callbackMinutes: null })).rejects.toMatchObject({ status: 0, message: expect.stringContaining("obnovením") });
  });
});
