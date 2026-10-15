import { afterEach, describe, expect, it, vi } from "vitest";
import { DispatchPhone, type NativePhone, type VoiceEvent } from "./phone";
import type { VoiceApi } from "./api";
import { MobileApiError } from "../lib/api";

const lease = "00000000-0000-4000-8000-000000000001", sid = "00000000-0000-4000-8000-000000000002", id = "00000000-0000-4000-8000-000000000003";
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const phones: DispatchPhone[] = [];
afterEach(() => { for (const phone of phones) phone.dispose(); phones.length = 0; vi.useRealTimers(); });
function fixture() {
  let event: (value: VoiceEvent) => void = () => {};
  const native: NativePhone = {
    subscribe: callback => { event = callback; return () => { event = () => {}; }; },
    snapshot: vi.fn().mockResolvedValue({ ready: true, audioActive: false, pending: [], pushRegistered: true }),
    requestMicrophone: vi.fn().mockResolvedValue(true), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    authorize: vi.fn().mockResolvedValue(undefined), reject: vi.fn().mockResolvedValue(undefined), expectOutgoing: vi.fn().mockResolvedValue(undefined),
    answer: vi.fn().mockResolvedValue(undefined), confirmConnected: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined), mute: vi.fn().mockResolvedValue(undefined),
    speaker: vi.fn().mockResolvedValue(undefined), dtmf: vi.fn().mockResolvedValue(undefined),
  };
  const api: VoiceApi = {
    token: vi.fn().mockResolvedValue({ token: "memory-only-provider-jwt", deviceSessionId: lease, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    heartbeat: vi.fn().mockResolvedValue(undefined), authorize: vi.fn().mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "inbound", number: "+421900000001" }),
    start: vi.fn().mockResolvedValue({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "+421900000002" }),
    end: vi.fn().mockResolvedValue({ terminationPending: false }), status: vi.fn().mockResolvedValue({ sessionId: sid, state: "ringing", connected: false, ended: false, terminationPending: false }),
    disconnect: vi.fn().mockResolvedValue(undefined), presence: vi.fn().mockResolvedValue(undefined),
  };
  const store = { load: vi.fn().mockResolvedValue(lease), save: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined) };
  const uuid = vi.fn(() => id);
  const phone = new DispatchPhone(api, native, uuid, store); phones.push(phone);
  return { phone, api, native, store, uuid, emit: (value: VoiceEvent) => event(value) };
}
async function connected() { const f = fixture(); await f.phone.initialise(); await f.phone.connect(); return f; }

describe("native phone lifecycle", () => {
  it("restores only the lease; provider JWT goes to native memory, never storage", async () => {
    const f = await connected(); expect(f.api.token).toHaveBeenCalledWith(lease, false);
    expect(f.store.save).toHaveBeenCalledWith(lease); expect(f.store.save).not.toHaveBeenCalledWith("memory-only-provider-jwt");
    expect(f.native.connect).toHaveBeenCalledWith("memory-only-provider-jwt");
  });
  it("never registers or dials without a native module (Expo Go/Android)", async () => {
    const f = fixture(); const phone = new DispatchPhone(f.api, null, f.uuid); phones.push(phone);
    await phone.initialise(); await phone.connect(); await phone.dial("+421900000002");
    expect(phone.state.supported).toBe(false); expect(f.api.token).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled();
  });
  it("buffers SIP before HTTP and auto-answers only the exact returned operator leg", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["start"]>>) => void;
    vi.mocked(f.api.start).mockReturnValue(new Promise(done => { resolve = done; }));
    const dial = f.phone.dial("+421900000002");
    f.emit({ type: "incoming", callId: id, providerLegId: id });
    f.emit({ type: "incoming", callId: "another-call", providerLegId: lease }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled();
    resolve({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "+421900000002" }); await dial;
    expect(f.native.expectOutgoing).toHaveBeenCalledWith("exact-leg", sid, "+421900000002");
    expect(f.api.authorize).toHaveBeenCalledWith(lease, { providerLegId: id });
    expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg"); expect(f.native.reject).toHaveBeenCalledWith("another-call");
    expect(f.phone.state.call?.outgoing).toBe(true);
  });
  it("reuses the request UUID after an ambiguous outbound network failure", async () => {
    const f = await connected(); vi.mocked(f.api.start).mockRejectedValueOnce(new MobileApiError("network", 0));
    await f.phone.dial("+421900000002"); await f.phone.dial("+421900000002");
    expect(f.uuid).toHaveBeenCalledTimes(1); expect(vi.mocked(f.api.start).mock.calls.map(call => call[1])).toEqual([id, id]);
  });
  it("rejects an expired offer without disconnecting the phone", async () => {
    const f = await connected(); vi.mocked(f.api.authorize).mockRejectedValue(new MobileApiError("expired offer", 409));
    f.emit({ type: "push", callId: id, providerLegId: id }); await tick();
    expect(f.native.reject).toHaveBeenCalledWith(id); expect(f.native.disconnect).not.toHaveBeenCalled(); expect(f.phone.state.registration).toBe("registered");
  });
  it("does not resurrect an offer when authorization arrives after cancellation", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["authorize"]>>) => void;
    vi.mocked(f.api.authorize).mockReturnValue(new Promise(done => { resolve = done; }));
    f.emit({ type: "push", callId: id, providerLegId: id }); await tick(); f.emit({ type: "ended", callId: id });
    resolve({ sessionId: sid, callControlId: "exact-leg", direction: "inbound", number: null }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled(); expect(f.phone.state.call).toBeNull();
  });
  it("requires backend bridge confirmation before displaying a connected call", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick(); expect(f.phone.state.call?.connected).toBe(false);
    expect(f.native.confirmConnected).not.toHaveBeenCalled();
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick(); expect(f.phone.state.call?.connected).toBe(true);
    expect(f.native.confirmConnected).toHaveBeenCalledWith(id);
  });
  it("retains pending termination after local CallKit has ended", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.api.end).mockResolvedValue({ terminationPending: true }); await f.phone.end(); f.emit({ type: "ended", callId: id }); await tick();
    expect(f.phone.state.termination).toBe(sid); expect(f.phone.state.call).toBeNull();
  });
  it("stops JS heartbeat in the background", async () => {
    const f = await connected(); vi.useFakeTimers(); f.phone.setForeground(false); vi.mocked(f.api.heartbeat).mockClear();
    await vi.advanceTimersByTimeAsync(180_000); expect(f.api.heartbeat).not.toHaveBeenCalled();
  });
  it("revokes native access when the lease has been superseded", async () => {
    const f = await connected(); vi.mocked(f.api.authorize).mockRejectedValue(new MobileApiError("stale", 409, "native_lease_stale"));
    f.emit({ type: "push", callId: id, providerLegId: id }); await tick();
    expect(f.native.disconnect).toHaveBeenCalled(); expect(f.phone.state.registration).toBe("error");
  });
  it("cleans a late token after disposal without connecting the previous account", async () => {
    const f = fixture(); await f.phone.initialise(); let resolve!: (value: Awaited<ReturnType<VoiceApi["token"]>>) => void;
    vi.mocked(f.api.token).mockReturnValue(new Promise(done => { resolve = done; }));
    const connecting = f.phone.connect(); await tick(); f.phone.dispose();
    resolve({ token: "old-user-token", deviceSessionId: lease, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }); await connecting;
    expect(f.native.connect).not.toHaveBeenCalled(); expect(f.api.disconnect).toHaveBeenCalledWith(lease);
  });
  it("retains the lease when provider revocation fails so logout can retry", async () => {
    const f = await connected(); vi.mocked(f.api.disconnect).mockRejectedValueOnce(new MobileApiError("provider unavailable", 503));
    await expect(f.phone.disconnect()).rejects.toMatchObject({ status: 503 }); expect(f.store.clear).not.toHaveBeenCalled();
    await f.phone.disconnect(); expect(f.api.disconnect).toHaveBeenCalledTimes(2); expect(f.store.clear).toHaveBeenCalled();
  });
  it("authorizes a foreground SDK INVITE by leg UUID before a control ID exists", async () => {
    const f = await connected(); f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.api.authorize).toHaveBeenCalledWith(lease, { providerLegId: id });
    expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg");
    expect(f.phone.state.call).toMatchObject({ id, sessionId: sid, outgoing: false, state: "RINGING" });
  });
  it("matches an outbound INVITE after HTTP through the authenticated leg resolution", async () => {
    const f = await connected(); await f.phone.dial("+421900000002");
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "outbound", number: "+421900000002" });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg");
    expect(f.phone.state.call?.outgoing).toBe(true);
  });
  it.each([
    { sessionId: sid, callControlId: "other-control" },
    { sessionId: lease, callControlId: "exact-leg" },
  ])("rejects a resolved offer outside the exact outgoing session/control pair: %j", async mismatch => {
    const f = await connected(); await f.phone.dial("+421900000002");
    vi.mocked(f.api.authorize).mockResolvedValue({ ...mismatch, direction: "outbound", number: null });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled(); expect(f.native.reject).toHaveBeenCalledWith(id);
    expect(f.phone.state.call).toBeNull();
  });
  it("does not auto-answer an outbound offer after its local intent timed out", async () => {
    const f = await connected(); await f.phone.dial("+421900000002");
    let resolve!: (value: Awaited<ReturnType<VoiceApi["authorize"]>>) => void;
    vi.mocked(f.api.authorize).mockReturnValue(new Promise(done => { resolve = done; }));
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    f.emit({ type: "outgoingFailed", sessionId: sid }); await tick();
    resolve({ sessionId: sid, callControlId: "exact-leg", direction: "outbound", number: null }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled(); expect(f.native.reject).toHaveBeenCalledWith(id);
  });
  it("refreshes a suspended phone's JWT and prepares native before authorizing a push", async () => {
    const f = await connected(); f.phone.setForeground(false);
    vi.mocked(f.api.token).mockResolvedValue({ token: "fresh-wake-token", deviceSessionId: lease, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    f.emit({ type: "push", callId: id, providerLegId: id }); await tick();
    expect(f.api.token).toHaveBeenCalledTimes(2); expect(f.native.connect).toHaveBeenLastCalledWith("fresh-wake-token");
    expect(vi.mocked(f.native.connect).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(f.native.authorize).mock.invocationCallOrder[0]);
    expect(f.phone.state.call?.id).toBe(id);
  });
  it("restores a cold push from native snapshot without persisting provider credentials", async () => {
    const f = fixture(); vi.mocked(f.native.snapshot).mockResolvedValue({ ready: false, audioActive: false, wasEnabled: true,
      pending: [{ type: "push", callId: id, providerLegId: id }] });
    await f.phone.initialise(); await tick();
    expect(f.api.token).toHaveBeenCalledTimes(1); expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg");
    expect(f.store.save).toHaveBeenCalledWith(lease); expect(f.phone.state.call?.id).toBe(id);
  });
  it("retries only a not-yet-persisted provider leg and stops retrying after cancellation", async () => {
    const f = await connected(); vi.useFakeTimers();
    vi.mocked(f.api.authorize).mockRejectedValueOnce(new MobileApiError("pending", 409, "native_offer_pending"));
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await vi.advanceTimersByTimeAsync(400);
    expect(f.api.authorize).toHaveBeenCalledTimes(2); expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg");
    f.emit({ type: "ended", callId: id });
    vi.mocked(f.api.authorize).mockClear().mockRejectedValue(new MobileApiError("pending", 409, "native_offer_pending"));
    f.emit({ type: "incoming", callId: lease, providerLegId: lease }); await vi.advanceTimersByTimeAsync(0);
    f.emit({ type: "ended", callId: lease }); await vi.advanceTimersByTimeAsync(2_000);
    expect(f.api.authorize).toHaveBeenCalledTimes(1);
  });
  it("bounds retries when an INVITE never gets a persisted provider leg", async () => {
    const f = await connected(); vi.useFakeTimers();
    vi.mocked(f.api.authorize).mockRejectedValue(new MobileApiError("pending", 409, "native_offer_pending"));
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await vi.advanceTimersByTimeAsync(2_000);
    expect(f.api.authorize).toHaveBeenCalledTimes(5); expect(f.native.authorize).not.toHaveBeenCalled();
    expect(f.native.reject).toHaveBeenCalledWith(id);
  });
  it("preserves ACTIVE emitted while the native authorization promise is resolving", async () => {
    const f = await connected(); vi.mocked(f.native.authorize).mockImplementation(async () => {
      f.emit({ type: "callState", callId: id, state: "ACTIVE" });
    });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.phone.state.call?.state).toBe("ACTIVE"); expect(f.api.status).toHaveBeenCalledWith(lease, sid);
  });
  it("reserves one authorized call before the async native bridge resolves", async () => {
    const f = await connected(); let resolve!: () => void;
    vi.mocked(f.native.authorize).mockReturnValue(new Promise(done => { resolve = done; }));
    f.emit({ type: "incoming", callId: id, providerLegId: id });
    f.emit({ type: "incoming", callId: lease, providerLegId: lease }); await tick();
    expect(f.native.authorize).toHaveBeenCalledTimes(1); expect(f.native.reject).toHaveBeenCalledWith(lease);
    resolve(); await tick(); expect(f.phone.state.call?.id).toBe(id);
  });
  it("ignores a late token response after the current lease is revoked", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["token"]>>) => void;
    vi.mocked(f.api.token).mockReturnValue(new Promise(done => { resolve = done; }));
    const connecting = f.phone.connect(); await tick();
    vi.mocked(f.api.heartbeat).mockRejectedValue(new MobileApiError("stale", 409, "native_lease_stale"));
    f.emit({ type: "registration", state: "registered" }); await tick();
    resolve({ token: "revoked-token", deviceSessionId: lease, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }); await connecting;
    expect(f.native.connect).toHaveBeenCalledTimes(1); expect(f.api.disconnect).toHaveBeenCalledWith(lease);
    expect(f.phone.state.registration).toBe("error");
  });
  it("disconnects on explicit native feature disable and prevents late offer authorization", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["authorize"]>>) => void;
    vi.mocked(f.api.authorize).mockReturnValue(new Promise(done => { resolve = done; }));
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    vi.mocked(f.api.heartbeat).mockRejectedValue(new MobileApiError("disabled", 503, "native_voice_disabled"));
    f.phone.setForeground(true); await tick();
    resolve({ sessionId: sid, callControlId: "exact-leg", direction: "inbound", number: null }); await tick();
    expect(f.native.disconnect).toHaveBeenCalled(); expect(f.native.authorize).not.toHaveBeenCalled();
    expect(f.phone.state.registration).toBe("error");
  });
  it("allows dialing after reconnecting from a fatal outbound authorization error", async () => {
    const f = await connected(); vi.mocked(f.api.start).mockRejectedValueOnce(new MobileApiError("expired auth", 401));
    await f.phone.dial("+421900000002"); expect(f.phone.state.dialing).toBe(false);
    await f.phone.connect(); await f.phone.dial("+421900000002"); expect(f.api.start).toHaveBeenCalledTimes(2);
  });
  it("reconnects a disconnected foreground socket without waiting for a heartbeat that cannot run", async () => {
    const f = await connected(); f.emit({ type: "registration", state: "unregistered" });
    f.phone.setForeground(false); f.phone.setForeground(true); await tick();
    expect(f.native.connect).toHaveBeenCalledTimes(2);
  });
  it("prepares a push arriving after native connect but before its held snapshot resolves", async () => {
    const f = await connected();
    let release!: (value: Awaited<ReturnType<NativePhone["snapshot"]>>) => void;
    vi.mocked(f.native.snapshot).mockReturnValueOnce(new Promise(done => { release = done; }));
    let prepared = false;
    vi.mocked(f.native.connect).mockImplementation(async () => { if (vi.mocked(f.native.connect).mock.calls.length >= 3) prepared = true; });
    vi.mocked(f.native.authorize).mockImplementation(async () => { expect(prepared).toBe(true); });
    const connecting = f.phone.connect(); await tick();
    f.emit({ type: "push", callId: id, providerLegId: id }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled();
    release({ ready: true, audioActive: false, pending: [] }); await connecting; await tick();
    expect(prepared).toBe(true); expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg");
  });
  it("bounds automatic foreground idle recovery without requiring an app-state transition", async () => {
    const f = await connected(); vi.useFakeTimers();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: false, audioActive: false, pending: [] });
    vi.mocked(f.native.connect).mockRejectedValue(new Error("socket unavailable"));
    f.emit({ type: "registration", state: "unregistered" });
    await vi.advanceTimersByTimeAsync(999); expect(f.native.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.native.connect).toHaveBeenCalledTimes(4);
    expect(f.api.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000); expect(f.native.connect).toHaveBeenCalledTimes(4);
  });
  it.each(["background", "call", "disconnect", "dispose"])("cancels idle reconnect when %s takes ownership", async reason => {
    const f = await connected(); vi.useFakeTimers();
    f.emit({ type: "registration", state: "unregistered" });
    if (reason === "background") f.phone.setForeground(false);
    if (reason === "call") f.emit({ type: "outgoing", callId: id, sessionId: sid });
    if (reason === "disconnect") await f.phone.disconnect();
    if (reason === "dispose") f.phone.dispose();
    await vi.advanceTimersByTimeAsync(10_000); expect(f.native.connect).toHaveBeenCalledTimes(1);
    expect(f.api.start).not.toHaveBeenCalled();
  });
  it("waits for native registration and cancels recovery when ready arrives", async () => {
    const f = await connected(); vi.useFakeTimers();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: false, audioActive: false, pending: [] });
    await f.phone.connect(); await vi.advanceTimersByTimeAsync(9_000);
    expect(f.native.connect).toHaveBeenCalledTimes(2);
    f.emit({ type: "registration", state: "registered" }); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.native.connect).toHaveBeenCalledTimes(2);
  });
  it("does not replace native signaling while offer authorization is pending", async () => {
    const f = await connected(); vi.useFakeTimers();
    vi.mocked(f.api.authorize).mockReturnValue(new Promise(() => {}));
    f.emit({ type: "registration", state: "unregistered" });
    f.emit({ type: "incoming", callId: id, providerLegId: id });
    await vi.advanceTimersByTimeAsync(10_000); expect(f.native.connect).toHaveBeenCalledTimes(1);
  });
  it("does not prepare a push twice when the shared connection already prepared its exact ID", async () => {
    const f = await connected();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: false, preparedPushCallId: id.toUpperCase(), pending: [] });
    f.emit({ type: "push", callId: id, providerLegId: id }); await tick();
    expect(f.native.connect).toHaveBeenCalledTimes(2); expect(f.native.authorize).toHaveBeenCalledTimes(1);
  });
  it("stops automatic recovery when token refresh revokes the lease", async () => {
    const f = await connected(); vi.useFakeTimers();
    vi.mocked(f.api.token).mockRejectedValue(new MobileApiError("stale", 409, "native_lease_stale"));
    f.emit({ type: "registration", state: "unregistered" }); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.token).toHaveBeenCalledTimes(2); expect(f.native.disconnect).toHaveBeenCalledTimes(1);
    expect(f.native.connect).toHaveBeenCalledTimes(1);
  });
  it.each(["background", "incoming call"])("fences an automatic recovery token that resolves after %s", async reason => {
    const f = await connected(); vi.useFakeTimers();
    let release!: (token: Awaited<ReturnType<VoiceApi["token"]>>) => void;
    vi.mocked(f.api.token).mockReturnValueOnce(new Promise(done => { release = done; }));
    f.emit({ type: "registration", state: "unregistered" }); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.api.token).toHaveBeenCalledTimes(2);
    if (reason === "background") f.phone.setForeground(false);
    else { f.emit({ type: "incoming", callId: id, providerLegId: id }); await vi.advanceTimersByTimeAsync(0); }
    release({ token: "refreshed-memory-token", deviceSessionId: lease, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.native.connect).toHaveBeenCalledTimes(1); expect(f.native.disconnect).not.toHaveBeenCalled();
    if (reason === "incoming call") expect(f.phone.state.call?.id).toBe(id);
  });
  it("defers APNs token re-registration until the current call finishes", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    f.emit({ type: "pushTokenChanged" }); await tick(); expect(f.native.connect).toHaveBeenCalledTimes(1);
    f.emit({ type: "ended", callId: id, sessionId: sid, outgoing: true }); await tick();
    expect(f.native.connect).toHaveBeenCalledTimes(2);
  });

  it("retries server cleanup with the saved lease after a provider failure drops the JWT", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.api.end).mockRejectedValueOnce(new MobileApiError("provider failed", 502));
    await f.phone.end(); expect(f.phone.state.termination).toBe(sid); expect(f.phone.state.registration).toBe("error");
    await f.phone.end(); expect(f.api.end).toHaveBeenCalledTimes(2);
    expect(f.api.end).toHaveBeenLastCalledWith(lease, sid); expect(f.phone.state.termination).toBeNull();
  });
  it("retains cleanup of an owned call when creation is disabled during the call", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.api.heartbeat).mockRejectedValue(new MobileApiError("disabled", 503, "native_voice_disabled"));
    f.phone.setForeground(true); await tick();
    expect(f.phone.state.call).toBeNull(); expect(f.phone.state.termination).toBe(sid);
    await f.phone.end(); expect(f.api.end).toHaveBeenCalledWith(lease, sid);
  });

  it("ends only the local endpoint when the server says its offer or ownership has ended", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.native.reject).mockImplementation(async () => { f.emit({ type: "ended", callId: id, sessionId: sid, outgoing: true }); });
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "talking", connected: false, ended: true, terminationPending: false });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.native.reject).toHaveBeenCalledWith(id); expect(f.api.end).not.toHaveBeenCalled();
    expect(f.phone.state.call).toBeNull(); expect(f.phone.state.registration).toBe("registered");
  });

  it("keeps owned cleanup pending after the native leg ends until the other legs finish", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.api.end).mockResolvedValue({ terminationPending: true });
    await f.phone.end(); f.emit({ type: "ended", callId: id, sessionId: sid, outgoing: true }); await tick();
    vi.useFakeTimers(); f.phone.setForeground(true);
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "ending", connected: false, ended: true, terminationPending: true });
    await vi.advanceTimersByTimeAsync(2_000); expect(f.phone.state.termination).toBe(sid);
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "completed", connected: false, ended: true, terminationPending: false });
    await vi.advanceTimersByTimeAsync(2_000); expect(f.phone.state.termination).toBeNull();
  });
  it("does not restore a call cancelled while native authorization was resolving", async () => {
    const f = await connected(); vi.mocked(f.native.authorize).mockImplementation(async () => {
      f.emit({ type: "ended", callId: id, sessionId: sid });
    });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.phone.state.call).toBeNull(); expect(f.api.end).not.toHaveBeenCalled();
  });

});
