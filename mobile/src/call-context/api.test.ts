import { afterEach, describe, expect, it, vi } from "vitest";
import { createCallContextApi } from "./api";
import type { MobileTransport } from "../lib/api";

const profile = "00000000-0000-4000-8000-000000000001", organization = "00000000-0000-4000-8000-000000000002";
const callId = "00000000-0000-4000-8000-0000000000ab", sessionId = "00000000-0000-4000-8000-000000000004";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const target = { kind: "call" as const, id: callId };
function payload() { return { ok: true, apiVersion: 1, environment: "test", profileId: profile, organizationId: organization, checkedAt: "2026-10-15T19:00:00Z", target,
  call: { id: callId, sessionId, direction: "inbound", status: "answered", number: "+421905123456", name: "Kontakt", lineLabel: "Linka", operatorName: "Operátor", startedAt: "2026-10-15T18:00:00Z", answeredAt: null, endedAt: null, durationSeconds: null },
  linkState: "linked", linkedCase: { id: sessionId, caseNumber: "2026-42", status: "open", statusLabel: "Otvorený", summary: "Porucha", contactName: "Kontakt", licensePlate: "BA123AB", ownerName: "Operátor" } }; }
function setup(body: unknown = payload(), current = () => true) {
  const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body));
  const token = vi.fn(async () => "fixture-token");
  return { transport, token, api: createCallContextApi(config, profile, organization, token, current, transport) };
}
afterEach(() => vi.useRealTimers());

describe("scoped call-context transport", () => {
  it("sends only the explicit read reference and account fencing headers", async () => {
    const f = setup(); expect((await f.api.read(target)).linkedCase?.caseNumber).toBe("2026-42");
    expect(f.transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/calls/" + callId + "/context?source=call", expect.objectContaining({ method: "GET", credentials: "omit", redirect: "error", headers: { Authorization: "Bearer fixture-token", Accept: "application/json", "X-PM-App-Environment": "test", "X-PM-Expected-Organization": organization } }));
  });
  it("keeps a session reference separate and accepts a call-log row not yet created", async () => {
    const body = payload(), selected = { kind: "session" as const, id: sessionId };
    const f = setup({ ...body, target: selected, call: { ...body.call, id: null } });
    expect((await f.api.read(selected)).call.id).toBeNull();
    expect(f.transport.mock.calls[0][0]).toContain("/" + sessionId + "/context?source=session");
  });
  it("canonicalizes a UUID before comparing the server echo", async () => {
    const f = setup(); await f.api.read({ ...target, id: callId.toUpperCase() });
    expect(f.transport.mock.calls[0][0]).toContain("/" + callId + "/");
  });
  it.each([
    { environment: "production" }, { profileId: sessionId }, { organizationId: sessionId }, { checkedAt: "2026-02-30T00:00:00Z" },
    { target: { ...target, kind: "session" } }, { target: { ...target, id: sessionId } },
    { call: { ...payload().call, id: sessionId } }, { call: { ...payload().call, raw: "private" } },
    { call: { ...payload().call, durationSeconds: -1 } }, { call: { ...payload().call, durationSeconds: 0.5 } },
    { call: { ...payload().call, direction: "internal" } }, { linkedCase: { ...payload().linkedCase, notes: "private" } },
    { linkedCase: null }, { linkState: "unlinked" }, { linkState: "unavailable" }, { rawProviderPayload: "private" },
  ])("rejects wrong identity, expanded data or contradictory projections %j", async change => {
    await expect(setup({ ...payload(), ...change }).api.read(target)).rejects.toMatchObject({ status: 502 });
  });
  it.each(["unlinked", "unavailable"])("preserves %s without inventing a case", async linkState => {
    expect(await setup({ ...payload(), linkedCase: null, linkState }).api.read(target)).toMatchObject({ linkState, linkedCase: null });
  });
  it("accepts an internal peer with no reusable customer phone", async () => {
    const body = payload(); expect((await setup({ ...body, call: { ...body.call, direction: "internal", number: null } }).api.read(target)).call.number).toBeNull();
  });
  it.each([null, "not-a-uuid", "../other"])("rejects malformed reference %s before token access", async id => {
    const f = setup(); await expect(f.api.read({ ...target, id: id as string })).rejects.toMatchObject({ status: 400 });
    expect(f.token).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
  });
  it("rejects the old account before and after asynchronous token access", async () => {
    let live = false; const f = setup(payload(), () => live);
    await expect(f.api.read(target)).rejects.toMatchObject({ status: 401 }); expect(f.token).not.toHaveBeenCalled();
    live = true; f.token.mockImplementation(async () => { live = false; return "old"; });
    await expect(f.api.read(target)).rejects.toMatchObject({ status: 401 }); expect(f.transport).not.toHaveBeenCalled();
  });
  it("fences a late body after organization change even if the transport ignores abort", async () => {
    let live = true, resolve!: (v: Response) => void; const f = setup(payload(), () => live);
    f.transport.mockReturnValue(new Promise(done => { resolve = done; }));
    const read = f.api.read(target); await Promise.resolve(); live = false; resolve(Response.json(payload()));
    await expect(read).rejects.toMatchObject({ status: 401 });
  });
  it("does not return a successful response after caller cancellation", async () => {
    let resolve!: (v: Response) => void; const f = setup(), abort = new AbortController();
    f.transport.mockReturnValue(new Promise(done => { resolve = done; }));
    const read = f.api.read(target, abort.signal); await Promise.resolve(); abort.abort(); resolve(Response.json(payload()));
    await expect(read).rejects.toMatchObject({ status: 0 });
  });
  it("rejects a body which arrives after the bounded read deadline", async () => {
    vi.useFakeTimers(); let resolve!: (v: Response) => void; const f = setup();
    f.transport.mockReturnValue(new Promise(done => { resolve = done; }));
    const read = f.api.read(target); await Promise.resolve(); await vi.advanceTimersByTimeAsync(12_000); resolve(Response.json(payload()));
    await expect(read).rejects.toMatchObject({ status: 0 });
  });
  it.each([401, 403, 404, 409, 503])("preserves definitive HTTP status %i without retrying", async status => {
    const f = setup(); f.transport.mockResolvedValue(Response.json({ ok: false, error: "Nedostupné", code: "fixture" }, { status }));
    await expect(f.api.read(target)).rejects.toMatchObject({ status, message: "Nedostupné", code: "fixture" }); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("rejects a declared or actual oversized payload", async () => {
    const f = setup(); f.transport.mockResolvedValue(new Response("x", { headers: { "content-length": "64001" } }));
    await expect(f.api.read(target)).rejects.toMatchObject({ status: 502 });
    f.transport.mockResolvedValue(new Response("x".repeat(64_001)));
    await expect(f.api.read(target)).rejects.toMatchObject({ status: 502 });
  });
});
