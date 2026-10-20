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

describe("callback and confirmed-target voice transport", () => {
  const callback = "00000000-0000-4000-8000-0000000000cb", verification = "00000000-0000-4000-8000-0000000000ef";
  it("starts a queued callback by request identity only", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, sessionId: id, operatorLegCallControlId: "leg", to: "+421905111222", callbackRequestId: callback, linked: true }));
    const result = await createVoiceApi(config, "operator", async () => "token", transport).startCallback(id, id, callback.toUpperCase(), verification);
    expect(result).toMatchObject({ sessionId: id, to: "+421905111222", linked: true });
    expect(transport.mock.calls[0][0]).toBe(config.apiOrigin + "/api/mobile/v1/voice/calls/callback");
    expect(JSON.parse(String(transport.mock.calls[0][1].body))).toEqual({ deviceSessionId: id, requestId: id, callbackRequestId: callback.toUpperCase(), verificationId: verification });
  });
  it.each([{ callbackRequestId: colleague }, { linked: "yes" }, { to: "" }, { operatorLegCallControlId: "" }, { sessionId: "x" }])("rejects a callback result for another request %#", async change => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, sessionId: id, operatorLegCallControlId: "leg", to: "+421905111222", callbackRequestId: callback, linked: false, ...change }));
    await expect(createVoiceApi(config, "operator", async () => "token", transport).startCallback(id, id, callback)).rejects.toMatchObject({ status: 502 });
  });
  it("adds a confirmed alternative only when present, and cancels with the same identity", async () => {
    const transport = vi.fn<MobileTransport>().mockImplementation(async () => Response.json({ ...scope, sessionId: id, operatorLegCallControlId: "leg", to: "+421905444555" }));
    const api = createVoiceApi(config, "operator", async () => "token", transport);
    await api.start(id, id, "+421232408700", verification); await api.start(id, id, "+421905111222"); await api.start(id, id, "+421905111222", undefined, callback);
    expect(transport.mock.calls.map(call => JSON.parse(String(call[1].body)))).toEqual([
      { deviceSessionId: id, requestId: id, to: "+421232408700", verificationId: verification }, { deviceSessionId: id, requestId: id, to: "+421905111222" },
      { deviceSessionId: id, requestId: id, to: "+421905111222", caseId: callback }]);
    transport.mockImplementation(async () => Response.json({ ...scope, resolved: false, sessionId: null, terminationPending: false }, { status: 202 }));
    await api.cancelAttempt(id, id, { kind: "external", number: "+421232408700", verificationId: verification });
    await api.cancelAttempt(id, id, { kind: "callback", callbackRequestId: callback, number: "+421905111222" });
    await api.cancelAttempt(id, id, { kind: "external", number: "+421905111222", caseId: callback });
    expect(transport.mock.calls.slice(3).map(call => JSON.parse(String(call[1].body)))).toEqual([
      { deviceSessionId: id, requestId: id, kind: "external", to: "+421232408700", verificationId: verification },
      { deviceSessionId: id, requestId: id, kind: "callback", callbackRequestId: callback },
      { deviceSessionId: id, requestId: id, kind: "external", to: "+421905111222", caseId: callback }]);
  });
  it("refuses malformed identities before transport", async () => {
    const transport = vi.fn<MobileTransport>(); const api = createVoiceApi(config, "operator", async () => "token", transport);
    await expect(api.start(id, id, "+421905111222", "v1")).rejects.toMatchObject({ status: 502 });
    await expect(api.start(id, id, "+421905111222", undefined, "case-7")).rejects.toMatchObject({ status: 502 });
    await expect(api.startCallback(id, id, "../x")).rejects.toMatchObject({ status: 502 });
    expect(transport).not.toHaveBeenCalled();
  });
});
describe("transfer and recording transport", () => {
  const media = { version: 1, state: "active", canHold: true, callControlId: "leg" };
  const live = { ...scope, sessionId: id, state: "talking", connected: true, ended: false, terminationPending: false, media };
  it("lists colleagues with the web's badge and refuses raw or malformed entries", async () => {
    const target = { profileId: colleague.toUpperCase(), displayName: "Jana", available: true, label: "Dostupný" };
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, targets: [target] }));
    const api = createVoiceApi(config, "operator", async () => "token", transport);
    expect(await api.transferTargets(id, id)).toEqual([{ ...target, profileId: colleague }]);
    expect(JSON.parse(String(transport.mock.calls[0][1].body))).toEqual({ deviceSessionId: id });
    for (const bad of [{ ...target, label: "" }, { ...target, label: "x".repeat(61) }, { ...target, available: "yes" }, { ...target, profileId: "sip:jana" }, { ...target, displayName: "Jana\u0007" }]) {
      transport.mockResolvedValueOnce(Response.json({ ...scope, targets: [bad] }));
      await expect(api.transferTargets(id, id)).rejects.toMatchObject({ status: 502 });
    }
  });
  it("transfers only to a colleague and checks the answer belongs to the call", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, sessionId: id.toUpperCase(), state: "ringing" }));
    const api = createVoiceApi(config, "operator", async () => "token", transport);
    await api.transfer(id, id, colleague.toUpperCase());
    expect(JSON.parse(String(transport.mock.calls[0][1].body))).toEqual({ deviceSessionId: id, profileId: colleague });
    await expect(api.transfer(id, id, "+421900000001")).rejects.toMatchObject({ status: 502 });
    transport.mockResolvedValueOnce(Response.json({ ...scope, sessionId: colleague, state: "ringing" }));
    await expect(api.transfer(id, id, colleague)).rejects.toMatchObject({ status: 502 });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("reports the recorder after a stop and sends retry only when asked", async () => {
    const transport = vi.fn<MobileTransport>().mockImplementation(async () => Response.json({ ...scope, sessionId: id, recording: { state: "stopping", suppressed: true } }));
    const api = createVoiceApi(config, "operator", async () => "token", transport);
    expect(await api.stopRecording(id, id, false)).toEqual({ state: "stopping", suppressed: true });
    await api.stopRecording(id, id, true);
    expect(transport.mock.calls.map(call => JSON.parse(String(call[1].body)))).toEqual([{ deviceSessionId: id }, { deviceSessionId: id, retry: true }]);
    for (const recording of [undefined, { state: "paused", suppressed: false }, { state: "stopped" }]) {
      transport.mockResolvedValueOnce(Response.json({ ...scope, sessionId: id, recording }));
      await expect(api.stopRecording(id, id, false)).rejects.toMatchObject({ status: 502 });
    }
  });
  it("accepts a status without a recorder and refuses one for a call that is not connected", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(live));
    const api = createVoiceApi(config, "operator", async () => "token", transport);
    expect((await api.status(id, id)).recording).toBeUndefined();
    transport.mockResolvedValueOnce(Response.json({ ...live, recording: { state: "recording", suppressed: false } }));
    expect((await api.status(id, id)).recording).toEqual({ state: "recording", suppressed: false });
    transport.mockResolvedValueOnce(Response.json({ ...live, connected: false, state: "ringing", media: { version: 1, state: "unavailable", canHold: false, callControlId: null }, recording: { state: "recording", suppressed: false } }));
    await expect(api.status(id, id)).rejects.toMatchObject({ status: 502 });
    transport.mockResolvedValueOnce(Response.json({ ...live, recording: { state: "on", suppressed: false } }));
    await expect(api.status(id, id)).rejects.toMatchObject({ status: 502 });
  });
});
