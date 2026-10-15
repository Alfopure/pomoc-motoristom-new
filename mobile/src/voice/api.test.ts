import { describe, expect, it, vi } from "vitest";
import { createVoiceApi } from "./api";
import type { MobileTransport } from "../lib/api";
const id = "00000000-0000-4000-8000-000000000001";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: "operator" };
const token = { ...scope, token: "provider-token", deviceSessionId: id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const colleague = "00000000-0000-4000-8000-000000000002";
describe("native voice transport", () => {
  it("cancels only the original typed target without transmitting its display name", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, resolved: true, sessionId: id, terminationPending: true }, { status: 202 }));
    const api = createVoiceApi(config, "operator", async () => "token", transport);
    expect(await api.cancelAttempt(id, id, { kind: "internal", profileId: colleague, name: "Jana" })).toEqual({ resolved: true, sessionId: id, terminationPending: true });
    expect(JSON.parse(String(transport.mock.calls[0][1].body))).toEqual({ deviceSessionId: id, requestId: id, kind: "internal", targetProfileId: colleague });
  });
  it.each([
    { resolved: false, sessionId: id, terminationPending: false }, { resolved: false, sessionId: null, terminationPending: true },
    { resolved: true, sessionId: null, terminationPending: false }, { resolved: "true", sessionId: id, terminationPending: false },
  ])("rejects an ambiguous or contradictory cancellation acknowledgment %#", async result => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, ...result }));
    await expect(createVoiceApi(config, "operator", async () => "token", transport).cancelAttempt(id, id, { kind: "external", number: "+421900000001" })).rejects.toMatchObject({ status: 502 });
  });
  it("starts an internal call through the lease-bound mobile endpoint, with no client SIP or name", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, sessionId: id, operatorLegCallControlId: "leg", targetProfileId: colleague, to: "Jana Nová" }));
    const result = await createVoiceApi(config, "operator", async () => "user-token", transport).startInternal(id, id, colleague);
    expect(result.to).toBe("Jana Nová");
    expect(transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/voice/calls/internal", expect.objectContaining({
      method: "POST", credentials: "omit", body: JSON.stringify({ deviceSessionId: id, requestId: id, targetProfileId: colleague }),
      headers: expect.objectContaining({ Authorization: "Bearer user-token", "X-PM-App-Environment": "test" }),
    }));
  });
  it.each([{ targetProfileId: id }, { to: "" }, { to: "Jana\nInjected" }, { to: "x".repeat(121) }, { operatorLegCallControlId: "" }])("rejects an internal result with wrong identity or label %#", async change => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, sessionId: id, operatorLegCallControlId: "leg", targetProfileId: colleague, to: "Jana", ...change }));
    await expect(createVoiceApi(config, "operator", async () => "token", transport).startInternal(id, id, colleague)).rejects.toMatchObject({ status: 502 });
  });
  it.each([
    { direction: "internal", role: undefined }, { direction: "internal", role: "operator" },
    { direction: "internal", role: ["caller"] }, { direction: "internal", role: ["callee"] },
    { direction: ["outbound"], role: "callee", displayName: null },
    { direction: ["internal"], role: "caller", displayName: null },
    { direction: "outbound", role: "callee" }, { direction: "inbound", role: "caller" },
    { direction: "internal", role: "caller", displayName: "" }, { direction: "internal", role: "callee", displayName: null },
    { direction: "internal", role: "callee", number: "+421900000000" }, { direction: "outbound", role: "caller", displayName: "Unrelated name" },
  ])("rejects an offer with absent or contradictory caller role %#", async change => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, sessionId: id, callControlId: "leg", number: null, displayName: "Jana", ...change }));
    await expect(createVoiceApi(config, "operator", async () => "token", transport).authorize(id, { providerLegId: id })).rejects.toMatchObject({ status: 502 });
  });
  it.each(["caller", "callee"])("accepts the server-derived internal %s and peer name", async role => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, sessionId: id, callControlId: "leg", direction: "internal", role, displayName: "Jana", number: null }));
    expect(await createVoiceApi(config, "operator", async () => "token", transport).authorize(id, { providerLegId: id })).toMatchObject({ role, displayName: "Jana" });
  });
  it.each([undefined, "unregistered", "invalid"])("rejects a heartbeat that does not acknowledge the reported registration: %s", registrationState => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, registrationState }));
    return expect(createVoiceApi(config, "operator", async () => "token", transport).heartbeat(id, "registered", true)).rejects.toMatchObject({ status: 502 });
  });
  it("accepts the exact acknowledged heartbeat including microphone withdrawal", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, registrationState: "unregistered" }));
    await createVoiceApi(config, "operator", async () => "token", transport).heartbeat(id, "unregistered", false);
    expect(JSON.parse(String(transport.mock.calls[0][1].body))).toEqual({ deviceSessionId: id, registrationState: "unregistered", nativeVoipRegistered: false });
  });
  it("uses the user JWT and mobile lease on POST, without cookies", async () => {
    const fetch = vi.fn<MobileTransport>().mockResolvedValue(Response.json(token));
    await createVoiceApi(config, "operator", async () => "user-token", fetch).token(id);
    expect(fetch).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/voice/token", expect.objectContaining({ method: "POST", credentials: "omit", headers: expect.objectContaining({ Authorization: "Bearer user-token", "X-PM-App-Environment": "test" }), body: JSON.stringify({ deviceSessionId: id, takeover: false }) }));
  });
  it.each([{ ...token, environment: "production" }, { ...token, profileId: "someone-else" }, { ...token, expiresAt: "invalid" }, { ...token, deviceSessionId: "invalid" }, null])("rejects unsafe token contracts %#", async body => {
    const fetch = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body));
    await expect(createVoiceApi(config, "operator", async () => "user-token", fetch).token()).rejects.toMatchObject({ status: 502 });
  });
  it("preserves 202 pending termination and the stale-lease error code", async () => {
    const fetch = vi.fn<MobileTransport>().mockResolvedValueOnce(Response.json({ ...scope, sessionId: id, terminationPending: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "stale", code: "native_lease_stale" }, { status: 409 }));
    const api = createVoiceApi(config, "operator", async () => "user-token", fetch);
    expect(await api.end(id, id)).toEqual({ terminationPending: true });
    await expect(api.authorize(id, { providerLegId: id })).rejects.toMatchObject({ status: 409, code: "native_lease_stale" });
  });
});
