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
    answer: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined), mute: vi.fn().mockResolvedValue(undefined),
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
    f.emit({ type: "incoming", callId: id, callControlId: "exact-leg" });
    f.emit({ type: "incoming", callId: "another-call", callControlId: "foreign-leg" }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled();
    resolve({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "+421900000002" }); await dial;
    expect(f.native.expectOutgoing).toHaveBeenCalledWith("exact-leg", sid, "+421900000002");
    expect(f.native.authorize).toHaveBeenCalledWith(id, sid); expect(f.native.reject).toHaveBeenCalledWith("another-call");
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
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick(); expect(f.phone.state.call?.connected).toBe(true);
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
});
