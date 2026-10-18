import { describe, expect, it, vi } from "vitest";
import type { MobileTransport } from "../lib/api";
import { createCallbacksApi } from "./api";

const profile = "00000000-0000-4000-8000-000000000001", organization = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-0000000000aa", colleague = "00000000-0000-4000-8000-0000000000bb", caseId = "00000000-0000-4000-8000-0000000000cc";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: profile, organizationId: organization, checkedAt: "2026-10-18T09:00:00Z" };
function item(change: Record<string, unknown> = {}) {
  return { id: requestId, number: "+421905111222", name: "Ján Novák", status: "open", origin: "missed", originDetail: null, sourceLabel: "Zmeškaný hovor",
    lineLabel: "Allianz", partnerName: null, caseId, claimant: null, claimedAt: null, deadlineAt: "2026-10-18T09:30:00.000Z", createdAt: "2026-10-18T09:00:00Z",
    resolvedAt: null, notes: null, lastCalledAt: null, actions: { claim: true, takeover: false, call: true, resolve: true, blockedReason: null }, ...change };
}
function page(change: Record<string, unknown> = {}) {
  return { ...scope, counts: { open: 1, requested: 0, missed: 1, manual: 0, unknown: 0 }, open: [item()], resolved: [], nextCursor: null, resetPage: false, ...change };
}
function setup(body: unknown = page(), current = () => true, status = 200) {
  const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body, { status }));
  const token = vi.fn(async () => "fixture-token");
  return { transport, token, api: createCallbacksApi(config, profile, organization, token, current, transport) };
}

describe("callback queue transport", () => {
  it("reads with account fencing and no cookies", async () => {
    const f = setup();
    expect((await f.api.list(null)).open[0].number).toBe("+421905111222");
    expect(f.transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/callbacks", expect.objectContaining({ method: "GET", credentials: "omit", redirect: "error",
      headers: { Authorization: "Bearer fixture-token", Accept: "application/json", "X-PM-App-Environment": "test", "X-PM-Expected-Organization": organization } }));
  });
  it("passes an opaque cursor and refuses a malformed one locally", async () => {
    const f = setup(page({ resolved: [] }));
    await f.api.list("eyJ2IjoyfQ");
    expect(f.transport.mock.calls[0][0]).toBe(config.apiOrigin + "/api/mobile/v1/callbacks?cursor=eyJ2IjoyfQ");
    await expect(f.api.list("bad cursor")).rejects.toMatchObject({ status: 400 }); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    { environment: "production" }, { profileId: colleague }, { organizationId: colleague }, { checkedAt: "yesterday" },
    { counts: { open: 2, requested: 0, missed: 1, manual: 0, unknown: 0 } }, { counts: { open: 1, requested: 0, missed: 1, manual: 0 } },
    { open: [item({ raw: "private" })] }, { open: [item({ id: requestId.toUpperCase() })] }, { open: [item({ status: "done" })] },
    { open: [item({ number: "sip:private@sip.telnyx.com" })] }, { open: [item({ actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: null } })] },
    { open: [item({ claimant: { id: colleague, name: "Peter", mine: true } })] }, { open: [item({ claimant: { id: profile, name: "Ja", mine: true } })] },
    { open: [item({ number: null })] }, { open: [item({ actions: { claim: true, takeover: true, call: true, resolve: true, blockedReason: null } })] },
    { open: [item(), item()] }, { resolved: [item()] }, { nextCursor: "bad cursor" }, { resetPage: "no" }, { open: new Array(101).fill(item()) },
  ])("rejects contradictory or expanded projections %#", async change => {
    await expect(setup(page(change)).api.list(null)).rejects.toMatchObject({ status: 502 });
  });
  it("accepts a colleague's claim, a senior takeover and recent resolutions", async () => {
    const claimed = item({ status: "scheduled", claimant: { id: colleague, name: "Peter", mine: false }, claimedAt: "2026-10-18T09:05:00Z",
      actions: { claim: true, takeover: true, call: true, resolve: true, blockedReason: null } });
    const done = item({ id: colleague, status: "done", deadlineAt: null, resolvedAt: "2026-10-18T09:20:00Z", notes: "Dovolané\nOdťah objednaný",
      actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: "Požiadavka je už uzavretá." } });
    const result = await setup(page({ open: [claimed], resolved: [done] })).api.list(null);
    expect(result.open[0].actions.takeover).toBe(true); expect(result.resolved[0].notes).toContain("\n");
  });
  it("does not render data after the account fence changes", async () => {
    let live = true; const f = setup(page(), () => live);
    f.transport.mockImplementation(async () => { live = false; return Response.json(page()); });
    await expect(f.api.list(null)).rejects.toMatchObject({ status: 401 });
  });
  it("reports server refusals with their code and connection loss as unknown", async () => {
    await expect(setup({ ok: false, error: "Požiadavku má prevzatú Peter.", code: "already_claimed" }, () => true, 409).api.claim(requestId))
      .rejects.toMatchObject({ status: 409, code: "already_claimed", message: "Požiadavku má prevzatú Peter." });
    const f = setup(); f.transport.mockRejectedValue(new TypeError("offline"));
    await expect(f.api.resolve(requestId, { status: "done", notes: null })).rejects.toMatchObject({ status: 0, message: expect.stringContaining("obnovením") });
  });
});

describe("callback actions transport", () => {
  const claimed = item({ status: "scheduled", claimant: { id: profile, name: "Ja", mine: true }, claimedAt: "2026-10-18T09:05:00Z",
    actions: { claim: false, takeover: false, call: true, resolve: true, blockedReason: null } });
  it("claims the exact request and verifies the receipt", async () => {
    const f = setup({ ...scope, request: claimed });
    expect((await f.api.claim(requestId.toUpperCase())).request.claimant?.mine).toBe(true);
    expect(f.transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/callbacks/" + requestId + "/claim", expect.objectContaining({ method: "POST" }));
    expect(f.transport.mock.calls[0][1].body).toBeUndefined();
  });
  it.each([{ request: item() }, { request: { ...claimed, id: colleague } }, { request: claimed, extra: true }])("rejects an unverifiable claim receipt %#", async change => {
    await expect(setup({ ...scope, ...change }).api.claim(requestId)).rejects.toMatchObject({ status: 502 });
  });
  it("sends a trimmed note without control characters and verifies the stored result", async () => {
    const resolved = item({ status: "done", deadlineAt: null, resolvedAt: "2026-10-18T09:10:00Z", notes: "Dovolané", actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: "Požiadavka je už uzavretá." } });
    const f = setup({ ...scope, request: resolved });
    await f.api.resolve(requestId, { status: "done", notes: "  Dovo\u0007lané " });
    expect(JSON.parse(String(f.transport.mock.calls[0][1].body))).toEqual({ status: "done", notes: "Dovolané" });
    expect(f.transport.mock.calls[0][1].headers).toMatchObject({ "Content-Type": "application/json" });
    await expect(setup({ ...scope, request: { ...resolved, notes: "Iné" } }).api.resolve(requestId, { status: "done", notes: "Dovolané" })).rejects.toMatchObject({ status: 502 });
    await expect(setup({ ...scope, request: resolved }).api.resolve(requestId, { status: "cancelled", notes: null })).rejects.toMatchObject({ status: 502 });
  });
  it("accepts an earlier note kept by a note-less resolution", async () => {
    const resolved = item({ status: "cancelled", deadlineAt: null, resolvedAt: "2026-10-18T09:10:00Z", notes: "Naplánované z webu",
      actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: "Požiadavka je už uzavretá." } });
    expect((await setup({ ...scope, request: resolved }).api.resolve(requestId, { status: "cancelled", notes: "  " })).request.notes).toBe("Naplánované z webu");
  });
  it("refuses local invalid input before any token or network access", async () => {
    const f = setup();
    await expect(f.api.claim("../other")).rejects.toMatchObject({ status: 404 });
    await expect(f.api.resolve(requestId, { status: "done", notes: "x".repeat(501) })).rejects.toMatchObject({ status: 400 });
    expect(f.token).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
});
