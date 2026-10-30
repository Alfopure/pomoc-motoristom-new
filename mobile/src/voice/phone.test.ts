import { afterEach, describe, expect, it, vi } from "vitest";
import { DispatchPhone, sameDialTarget, type NativePhone, type VoiceEvent } from "./phone";
import { createVoiceApi, type VoiceApi, type VoiceHoldCommand, type VoiceHoldResult, type VoiceStatus } from "./api";
import { MobileApiError } from "../lib/api";

const lease = "00000000-0000-4000-8000-000000000001", sid = "00000000-0000-4000-8000-000000000002", id = "00000000-0000-4000-8000-000000000003";
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const phones: DispatchPhone[] = [];
afterEach(() => { for (const phone of phones) phone.dispose(); phones.length = 0; vi.useRealTimers(); });
function fixture(report?: (error: Error) => void) {
  let event: (value: VoiceEvent) => void = () => {};
  const native: NativePhone = {
    subscribe: callback => { event = callback; return () => { event = () => {}; }; },
    snapshot: vi.fn().mockResolvedValue({ ready: true, audioActive: false, pending: [], pushRegistered: true }), clearPushRejection: vi.fn().mockResolvedValue(undefined),
    requestMicrophone: vi.fn().mockResolvedValue(true), connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    authorize: vi.fn().mockResolvedValue(undefined), reject: vi.fn().mockResolvedValue(undefined), expectOutgoing: vi.fn().mockResolvedValue(undefined),
    answer: vi.fn().mockResolvedValue(undefined), confirmConnected: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined), mute: vi.fn().mockResolvedValue(undefined),
    speaker: vi.fn().mockResolvedValue(undefined), dtmf: vi.fn().mockResolvedValue(undefined),
    requestHold: vi.fn().mockResolvedValue(undefined), claimHold: vi.fn().mockResolvedValue(true), syncMedia: vi.fn().mockResolvedValue(undefined), resolveHold: vi.fn().mockResolvedValue(undefined),
  };
  const api: VoiceApi = {
    token: vi.fn().mockResolvedValue({ token: "memory-only-provider-jwt", deviceSessionId: lease, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    heartbeat: vi.fn().mockResolvedValue(undefined), authorize: vi.fn().mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "inbound", role: "callee", displayName: null, number: "+421900000001" }),
    start: vi.fn().mockResolvedValue({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "+421900000002" }),
    startInternal: vi.fn().mockResolvedValue({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "Jana", targetProfileId: lease }),
    startCallback: vi.fn().mockResolvedValue({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "+421900000003", callbackRequestId: lease, linked: true }),
    cancelAttempt: vi.fn().mockResolvedValue({ resolved: true, sessionId: sid, terminationPending: false }),
    end: vi.fn().mockResolvedValue({ terminationPending: false, media: { version: 1, state: "unavailable", canHold: false, callControlId: null } }), status: vi.fn().mockResolvedValue({ sessionId: sid, state: "ringing", connected: false, ended: false, terminationPending: false, media: { version: 1, state: "unavailable", canHold: false, callControlId: null } }),
    hold: vi.fn(), holdStatus: vi.fn(), transferTargets: vi.fn(), transfer: vi.fn(), stopRecording: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined), presence: vi.fn().mockResolvedValue(undefined),
  };
  const store = { load: vi.fn().mockResolvedValue(lease), save: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined) };
  const uuid = vi.fn(() => id);
  const phone = new DispatchPhone(api, native, uuid, store, report); phones.push(phone);
  return { phone, api, native, store, uuid, emit: (value: VoiceEvent) => event(value) };
}
async function connected() { const f = fixture(); await f.phone.initialise(); await f.phone.connect(); return f; }

const activeMedia = { version: 8, state: "active" as const, canHold: true, callControlId: "exact-leg" };
const holdAction = { type: "heldRequested", callId: id, sessionId: sid, callControlId: "exact-leg", actionId: lease, held: true,
  expectedVersion: 8, phase: "unclaimed" as const, actionLive: true };
const holdCommand: VoiceHoldCommand = { callControlId: "exact-leg", requestId: lease, held: true, expectedVersion: 8 };
function holdResult(change: Partial<VoiceHoldResult> = {}): VoiceHoldResult {
  return { sessionId: sid, state: "held", connected: true, ended: false, terminationPending: false,
    media: { ...activeMedia, version: 9, state: "held" }, operation: { requestId: lease, held: true, outcome: "accepted" }, ...change };
}
async function activePhone() {
  const f = await connected();
  vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false, media: activeMedia });
  f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
  f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
  return f;
}

describe("mobile hold authority and recovery", () => {
  it("requests one CallKit action instead of directly mutating the provider", async () => {
    const f = await activePhone(); await f.phone.hold(); await f.phone.hold();
    expect(f.native.requestHold).toHaveBeenCalledExactlyOnceWith(id, true);
    expect(f.api.hold).not.toHaveBeenCalled(); expect(f.phone.state.holdPhase).toBe("requesting");
  });
  it("claims an exact native action before dispatch and confirms actual held media", async () => {
    const f = await activePhone(); vi.mocked(f.api.hold).mockResolvedValue(holdResult());
    f.emit(holdAction); await tick();
    expect(f.native.claimHold).toHaveBeenCalledExactlyOnceWith(id, lease);
    expect(f.api.hold).toHaveBeenCalledExactlyOnceWith(lease, sid, holdCommand);
    expect(f.native.resolveHold).toHaveBeenCalledWith(id, sid, "exact-leg", lease, "confirmed", "held", 9, true);
    expect(f.phone.state.call).toMatchObject({ connected: true, media: { state: "held" } });
    expect(f.phone.state.holdPhase).toBe("idle");
  });
  it("says so on the call screen when CallKit refuses a hold before the server is asked", async () => {
    const f = await activePhone(); await f.phone.hold();
    f.emit({ type: "heldCancelled", callId: id, actionId: lease }); await tick();
    expect(f.phone.state).toMatchObject({ holdPhase: "idle", error: "Podržanie sa nepodarilo." });
    expect(f.api.hold).not.toHaveBeenCalled();
  });
  it("does not report a hold this phone did not request, nor one refused as the call ends", async () => {
    const f = await activePhone();
    f.emit({ type: "heldCancelled", callId: id, actionId: lease }); await tick();
    expect(f.phone.state).toMatchObject({ holdPhase: "idle", error: null });
    await f.phone.hold();
    f.emit({ type: "heldCancelled", callId: id, actionId: lease }); f.emit({ type: "ended", callId: id, sessionId: sid }); await tick();
    expect(f.phone.state).toMatchObject({ call: null, error: null });
  });
  it("never dispatches an expired unclaimed action", async () => {
    const f = await activePhone(); vi.mocked(f.native.claimHold).mockResolvedValue(false);
    f.emit(holdAction); await tick();
    expect(f.api.hold).not.toHaveBeenCalled(); expect(f.phone.state.holdPhase).toBe("idle");
  });
  it.each([{ callControlId: "browser-leg" }, { sessionId: lease }, { callId: sid }, { expectedVersion: -1 }, { held: "true" }])("does not dispatch a mismatched or malformed native action %#", async change => {
    const f = await activePhone(); f.emit({ ...holdAction, ...change } as VoiceEvent); await tick();
    expect(f.api.hold).not.toHaveBeenCalled(); expect(f.native.claimHold).not.toHaveBeenCalled();
    expect(f.native.end).not.toHaveBeenCalled();
  });
  it("retains the original identity after a lost response and resolves without another provider command", async () => {
    const f = await activePhone(); vi.mocked(f.api.hold).mockRejectedValue(new MobileApiError("lost response", 0));
    vi.mocked(f.api.holdStatus).mockResolvedValue(holdResult());
    f.emit(holdAction); await tick();
    expect(f.phone.state.holdPhase).toBe("uncertain");
    await f.phone.hold(); expect(f.native.requestHold).not.toHaveBeenCalled();
    await f.phone.refreshHold();
    expect(f.api.holdStatus).toHaveBeenCalledExactlyOnceWith(lease, sid, holdCommand);
    expect(f.api.hold).toHaveBeenCalledTimes(1); expect(f.phone.state.holdPhase).toBe("idle");
    expect(f.native.resolveHold).toHaveBeenLastCalledWith(id, sid, "exact-leg", lease, "confirmed", "held", 9, true);
  });
  it("does not interpret not_found as proof that an in-flight original cannot run", async () => {
    const f = await activePhone(); vi.mocked(f.api.hold).mockRejectedValue(new MobileApiError("lost response", 0));
    vi.mocked(f.api.holdStatus).mockResolvedValue(holdResult({ state: "talking", media: activeMedia,
      operation: { requestId: lease, held: true, outcome: "not_found" } }));
    f.emit(holdAction); await tick(); await f.phone.refreshHold(); await f.phone.hold();
    expect(f.phone.state.holdPhase).toBe("uncertain"); expect(f.native.requestHold).not.toHaveBeenCalled();
    expect(f.native.resolveHold).toHaveBeenLastCalledWith(id, sid, "exact-leg", lease, "uncertain", "active", 8, true);
  });
  it("replays a claimed native snapshot through the read-only resolver after JS recreation", async () => {
    const f = fixture(); vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, wasEnabled: true, pending: [],
      calls: [{ type: "callState", callId: id, sessionId: sid, callControlId: "exact-leg", state: "ACTIVE", muted: true }],
      pendingHolds: [{ ...holdAction, phase: "uncertain", actionLive: false }] });
    vi.mocked(f.api.holdStatus).mockResolvedValue(holdResult()); await f.phone.initialise(); await tick();
    expect(f.api.hold).not.toHaveBeenCalled(); expect(f.api.holdStatus).toHaveBeenCalledWith(lease, sid, holdCommand);
    expect(f.phone.state.muted).toBe(true);
  });
  it("ignores a late successful hold response after the native call has ended", async () => {
    const f = await activePhone(); let resolve!: (value: VoiceHoldResult) => void;
    vi.mocked(f.api.hold).mockReturnValue(new Promise(done => { resolve = done; }));
    f.emit(holdAction); await tick(); f.emit({ type: "ended", callId: id, sessionId: sid }); await tick();
    resolve(holdResult()); await tick();
    expect(f.phone.state.call).toBeNull(); expect(f.native.resolveHold).not.toHaveBeenCalled();
  });
  it("leaves hangup available while the hold outcome is unknown", async () => {
    const f = await activePhone(); vi.mocked(f.api.hold).mockRejectedValue(new MobileApiError("lost response", 0));
    f.emit(holdAction); await tick(); await f.phone.end();
    expect(f.api.end).toHaveBeenCalledWith(lease, sid); expect(f.native.end).toHaveBeenCalledTimes(1);
  });
  it("only sends keypad tones during a confirmed active conversation", async () => {
    const f = await activePhone(); await f.phone.dtmf("1"); expect(f.native.dtmf).toHaveBeenCalledExactlyOnceWith("1");
    vi.mocked(f.api.hold).mockResolvedValue(holdResult()); f.emit(holdAction); await tick();
    await f.phone.dtmf("2"); expect(f.native.dtmf).toHaveBeenCalledTimes(1);
  });
  it("claims a restored live unclaimed action only after authenticated connection status", async () => {
    const f = fixture(); vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, wasEnabled: true, pending: [],
      calls: [{ type: "callState", callId: id, sessionId: sid, callControlId: "exact-leg", state: "ACTIVE" }], pendingHolds: [{ ...holdAction }] });
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false, media: activeMedia });
    vi.mocked(f.api.hold).mockResolvedValue(holdResult()); await f.phone.initialise();
    expect(f.native.claimHold).toHaveBeenCalledExactlyOnceWith(id, lease);
    expect(f.api.hold).toHaveBeenCalledExactlyOnceWith(lease, sid, holdCommand);
  });
  it("does not confirm a replacement outgoing call from a status paused at the native bridge", async () => {
    const f = await activePhone(); let release!: () => void;
    vi.mocked(f.native.syncMedia).mockReturnValueOnce(new Promise(done => { release = done; }));
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    f.emit({ type: "outgoing", callId: lease, sessionId: lease, callControlId: "new-leg" }); await tick(); release(); await tick();
    expect(f.native.confirmConnected).not.toHaveBeenCalled();
    expect(f.phone.state.call).toMatchObject({ id: lease, sessionId: lease, connected: false });
  });
  it("does not reject a replacement endpoint from an old terminal response for the same session", async () => {
    const f = await activePhone(); let release!: (value: Awaited<ReturnType<VoiceApi["status"]>>) => void;
    vi.mocked(f.api.status).mockReturnValueOnce(new Promise(done => { release = done; }));
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    f.emit({ type: "outgoing", callId: lease, sessionId: sid, callControlId: "new-leg" }); await tick();
    release({ sessionId: sid, state: "ended", connected: false, ended: true, terminationPending: false,
      media: { version: 9, state: "unavailable", canHold: false, callControlId: null } }); await tick();
    expect(f.native.reject).not.toHaveBeenCalled(); expect(f.phone.state.call).toMatchObject({ id: lease, callControlId: "new-leg" });
  });
  it("allows equal-version pending media to settle and ignores its late pending observation", async () => {
    const f = await activePhone();
    const pending = { sessionId: sid, state: "held", connected: true, ended: false, terminationPending: false,
      media: { ...activeMedia, version: 9, state: "pending" as const, canHold: false } };
    vi.mocked(f.api.status).mockResolvedValue(pending); f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.phone.state.call?.media?.state).toBe("pending");
    vi.mocked(f.api.status).mockResolvedValue(holdResult()); f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.phone.state.call?.media?.state).toBe("held");
    vi.mocked(f.api.status).mockResolvedValue(pending); f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.phone.state.call?.media?.state).toBe("held");
  });
  it("does not clear claimed uncertainty from an old general status response", async () => {
    const f = await activePhone(); let releaseStatus!: (value: Awaited<ReturnType<VoiceApi["status"]>>) => void;
    let releaseHold!: (value: VoiceHoldResult) => void;
    vi.mocked(f.api.status).mockReturnValueOnce(new Promise(done => { releaseStatus = done; }));
    vi.mocked(f.api.hold).mockReturnValueOnce(new Promise(done => { releaseHold = done; }));
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    f.emit(holdAction); await tick(); vi.mocked(f.native.syncMedia).mockClear();
    releaseStatus({ sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false, media: activeMedia }); await tick();
    expect(f.native.syncMedia).not.toHaveBeenCalled(); expect(f.phone.state.holdPhase).toBe("pending");
    releaseHold(holdResult()); await tick(); expect(f.phone.state.call?.media?.state).toBe("held");
  });
  it("keeps previously held media uncertain when confirmation becomes unavailable", async () => {
    const f = await activePhone(); vi.mocked(f.api.hold).mockResolvedValue(holdResult()); f.emit(holdAction); await tick();
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "held", connected: true, ended: false, terminationPending: false,
      media: { version: 10, state: "unavailable", canHold: false, callControlId: null } });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.phone.state.holdPhase).toBe("uncertain"); await f.phone.dtmf("2"); expect(f.native.dtmf).not.toHaveBeenCalled();
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick(); expect(f.phone.state.holdPhase).toBe("uncertain");
  });
  it("does not label an accepted historical action with unavailable current media as active", async () => {
    const f = await activePhone(); vi.mocked(f.api.hold).mockResolvedValue(holdResult({ media: { version: 10, state: "unavailable", canHold: false, callControlId: null } }));
    f.emit(holdAction); await tick(); expect(f.phone.state.holdPhase).toBe("uncertain");
    expect(f.native.resolveHold).toHaveBeenCalledWith(id, sid, "exact-leg", lease, "confirmed", "unavailable", 10, false);
    await f.phone.dtmf("2"); expect(f.native.dtmf).not.toHaveBeenCalled();
  });
  it("waits for the exact CallKit mirror acknowledgment before another hold or keypad action", async () => {
    const f = await activePhone();
    const sync = { type: "holdSyncPending", callId: id, sessionId: sid, callControlId: "exact-leg", actionId: lease, expectedVersion: 8, held: false };
    f.emit(sync); await tick(); await f.phone.hold(); await f.phone.dtmf("2");
    expect(f.phone.state.nativeSyncPending).toBe(true); expect(f.native.requestHold).not.toHaveBeenCalled(); expect(f.native.dtmf).not.toHaveBeenCalled();
    f.emit({ ...sync, type: "holdSynced", actionId: sid }); await tick(); expect(f.phone.state.nativeSyncPending).toBe(true);
    f.emit({ ...sync, type: "holdSynced" }); await tick(); expect(f.phone.state.nativeSyncPending).toBe(false);
    await f.phone.hold(); expect(f.native.requestHold).toHaveBeenCalledExactlyOnceWith(id, true);
  });
  it("does not clear a newer mirror from an old completion", async () => {
    const f = await activePhone();
    const sync = { type: "holdSyncPending", callId: id, sessionId: sid, callControlId: "exact-leg", actionId: lease, expectedVersion: 8, held: false };
    f.emit(sync); f.emit({ ...sync, actionId: sid, expectedVersion: 9 }); await tick();
    f.emit({ ...sync, type: "holdSynced" }); await tick(); expect(f.phone.state.nativeSyncPending).toBe(true);
    f.emit({ ...sync, actionId: sid, expectedVersion: 9, type: "holdSynced" }); await tick(); expect(f.phone.state.nativeSyncPending).toBe(false);
  });
  it("recovers a lost mirror completion from the exact settled native snapshot", async () => {
    const f = await activePhone();
    f.emit({ type: "holdSyncPending", callId: id, sessionId: sid, callControlId: "exact-leg", actionId: lease, expectedVersion: 8, held: false }); await tick();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, pending: [], pendingHolds: [], pendingSyncs: [],
      calls: [{ type: "restored", callId: id, sessionId: sid, callControlId: "exact-leg", state: "ACTIVE", systemHeld: false, privacyHold: false, media: activeMedia }] });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.phone.state.nativeSyncPending).toBe(false); await f.phone.hold(); expect(f.native.requestHold).toHaveBeenCalledExactlyOnceWith(id, true);
  });
  it("does not infer mirror completion from absence alone or a remaining privacy barrier", async () => {
    const f = await activePhone();
    f.emit({ type: "holdSyncPending", callId: id, sessionId: sid, callControlId: "exact-leg", actionId: lease, expectedVersion: 8, held: false }); await tick();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, pending: [], pendingHolds: [], pendingSyncs: [],
      calls: [{ type: "restored", callId: id, sessionId: sid, callControlId: "exact-leg", state: "ACTIVE", systemHeld: false, privacyHold: true, media: activeMedia }] });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick(); expect(f.phone.state.nativeSyncPending).toBe(true);
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, pending: [], pendingHolds: [], pendingSyncs: [], calls: [] });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick(); expect(f.phone.state.nativeSyncPending).toBe(true);
  });
  it("recovers a lost pending mirror event from native status before another toggle", async () => {
    const f = await activePhone();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, pending: [], pendingHolds: [],
      pendingSyncs: [{ callId: id, sessionId: sid, callControlId: "exact-leg", actionId: lease, expectedVersion: 8, held: false }] });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.phone.state.nativeSyncPending).toBe(true); await f.phone.hold(); expect(f.native.requestHold).not.toHaveBeenCalled();
  });
  it("recovers a lost live system hold event only through its still-live native claim", async () => {
    const f = await activePhone(); vi.mocked(f.api.hold).mockResolvedValue(holdResult());
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, pending: [], pendingSyncs: [], pendingHolds: [{ ...holdAction }] });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.native.claimHold).toHaveBeenCalledExactlyOnceWith(id, lease); expect(f.api.hold).toHaveBeenCalledExactlyOnceWith(lease, sid, holdCommand);
  });
  it("does not clear a fresh mirror from a snapshot read that began before its native event", async () => {
    const f = await activePhone(); let release!: (snapshot: Awaited<ReturnType<NativePhone["snapshot"]>>) => void;
    vi.mocked(f.native.snapshot).mockReturnValueOnce(new Promise(done => { release = done; }));
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    f.emit({ type: "holdSyncPending", callId: id, sessionId: sid, callControlId: "exact-leg", actionId: lease, expectedVersion: 8, held: false }); await tick();
    release({ ready: true, audioActive: true, pending: [], pendingHolds: [], pendingSyncs: [],
      calls: [{ type: "restored", callId: id, sessionId: sid, callControlId: "exact-leg", state: "ACTIVE", systemHeld: false, privacyHold: false, media: activeMedia }] }); await tick();
    expect(f.phone.state.nativeSyncPending).toBe(true);
  });
  it("keeps an accepted timed-out resume pending when its new mirror event was lost", async () => {
    const f = await activePhone(); const resumed = holdResult({ state: "talking", media: { ...activeMedia, version: 10 }, operation: { requestId: lease, held: false, outcome: "accepted" } });
    vi.mocked(f.api.holdStatus).mockResolvedValue(resumed);
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, pending: [], pendingHolds: [],
      pendingSyncs: [{ callId: id, sessionId: sid, callControlId: "exact-leg", actionId: sid, expectedVersion: 10, held: false }] });
    f.emit({ ...holdAction, held: false, phase: "uncertain", actionLive: false }); await tick();
    expect(f.phone.state.nativeSyncPending).toBe(true); await f.phone.hold(); await f.phone.dtmf("2");
    expect(f.native.requestHold).not.toHaveBeenCalled(); expect(f.native.dtmf).not.toHaveBeenCalled();
  });
});

describe("native phone lifecycle", () => {
  it("buffers the originating internal invite until the exact HTTP result and uses a generic colleague handle", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["startInternal"]>>) => void;
    vi.mocked(f.api.startInternal).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "internal", role: "caller", displayName: "Jana", number: "+421900000000" });
    const work = f.phone.dialColleague(lease, "Jana");
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled();
    resolve({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "Jana", targetProfileId: lease }); await work;
    expect(f.api.startInternal).toHaveBeenCalledWith(lease, id, lease); expect(f.api.start).not.toHaveBeenCalled();
    expect(f.native.expectOutgoing).toHaveBeenCalledWith("exact-leg", sid, "Jana", true);
    expect(f.phone.state.call).toMatchObject({ outgoing: true, displayName: "Jana", sessionId: sid });
  });
  it("rejects a caller's internal leg without this phone's exact outgoing intent", async () => {
    const f = await connected();
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "internal", role: "caller", displayName: "Jana", number: null });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.native.reject).toHaveBeenCalledWith(id); expect(f.native.authorize).not.toHaveBeenCalled(); expect(f.phone.state.call).toBeNull();
  });
  it("keeps a genuine internal recipient incoming and displays the caller's name", async () => {
    const f = await connected();
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "internal", role: "callee", displayName: "Peter", number: "+421900000000" });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.phone.state.call).toMatchObject({ outgoing: false, state: "RINGING", displayName: "Peter" });
    expect(f.native.expectOutgoing).not.toHaveBeenCalled(); expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg");
  });
  it("retries the original colleague and UUID without switching kind or target", async () => {
    const f = await connected(); vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("network", 0));
    await f.phone.dialColleague(lease, "Jana");
    expect(f.phone.state.retryTarget).toEqual({ kind: "internal", profileId: lease, name: "Jana" });
    await f.phone.dial("+421900000002"); await f.phone.dialColleague(sid, "Peter");
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.startInternal).toHaveBeenCalledTimes(1);
    await f.phone.retryDial();
    expect(f.api.startInternal).toHaveBeenNthCalledWith(2, lease, id, lease); expect(f.uuid).toHaveBeenCalledTimes(1);
    expect(f.phone.state.retryTarget).toBeNull();
  });
  it("preserves the exact internal target after a malformed successful reply and ordinary reconnect", async () => {
    const f = await connected();
    const envelope = { ok: true, apiVersion: 1, environment: "test", profileId: "operator", sessionId: sid, operatorLegCallControlId: "exact-leg", to: "Jana" };
    const transport = vi.fn().mockResolvedValueOnce(Response.json({ ...envelope, targetProfileId: sid }))
      .mockResolvedValueOnce(Response.json({ ...envelope, targetProfileId: lease }));
    f.api.startInternal = vi.fn(createVoiceApi({ environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" }, "operator", async () => "token", transport).startInternal);
    await f.phone.dialColleague(lease, "Jana");
    expect(f.phone.state.registration).toBe("error"); expect(f.phone.state.retryTarget).toEqual({ kind: "internal", profileId: lease, name: "Jana" });
    expect(f.native.expectOutgoing).not.toHaveBeenCalled();
    await f.phone.connect(); await f.phone.retryDial();
    expect(transport.mock.calls.map(call => JSON.parse(String(call[1].body)))).toEqual([
      { deviceSessionId: lease, requestId: id, targetProfileId: lease }, { deviceSessionId: lease, requestId: id, targetProfileId: lease },
    ]);
    expect(f.uuid).toHaveBeenCalledTimes(1); expect(f.native.expectOutgoing).toHaveBeenCalledWith("exact-leg", sid, "Jana", true);
  });
  it("buffers an originating internal push before HTTP establishes its exact intent", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["startInternal"]>>) => void;
    vi.mocked(f.api.startInternal).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "internal", role: "caller", displayName: "Jana", number: null });
    const work = f.phone.dialColleague(lease, "Jana"); f.emit({ type: "push", callId: id, providerLegId: id }); await tick();
    expect(f.api.authorize).not.toHaveBeenCalled(); expect(f.native.reject).not.toHaveBeenCalled();
    resolve({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "Jana", targetProfileId: lease }); await work;
    expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg"); expect(f.phone.state.call?.outgoing).toBe(true);
  });
  it.each([
    { internal: false, direction: "internal", role: "caller" },
    { internal: true, direction: "internal", role: "callee" },
    { internal: true, direction: "outbound", role: "caller" },
  ] as const)("rejects an exact-ID invite with contradictory call kind or role %#", async ({ internal, direction, role }) => {
    const f = await connected();
    if (internal) await f.phone.dialColleague(lease, "Jana"); else await f.phone.dial("+421900000002");
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction, role, displayName: "Jana", number: null });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.native.reject).toHaveBeenCalledWith(id); expect(f.native.authorize).not.toHaveBeenCalled(); expect(f.phone.state.call).toBeNull();
  });
  it("cleans up a late internal start after account disposal without starting CallKit", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["startInternal"]>>) => void;
    vi.mocked(f.api.startInternal).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const work = f.phone.dialColleague(lease, "Jana"); f.phone.dispose();
    resolve({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "Jana", targetProfileId: lease }); await work;
    expect(f.api.end).toHaveBeenCalledWith(lease, sid); expect(f.native.expectOutgoing).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409])("keeps an uncertain original command after a later %s denial", async status => {
    const f = await connected();
    vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("unknown provider outcome", 0))
      .mockRejectedValueOnce(new MobileApiError("target or authority changed", status));
    await f.phone.dialColleague(lease, "Jana"); await f.phone.retryDial();
    expect(f.phone.state.retryTarget).toEqual({ kind: "internal", profileId: lease, name: "Jana" });
    await f.phone.dial("+421900000002"); expect(f.api.start).not.toHaveBeenCalled(); expect(f.uuid).toHaveBeenCalledTimes(1);
  });
  it("does not retain an initial definitive target denial as an uncertain call", async () => {
    const f = await connected(); vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("target missing", 404));
    await f.phone.dialColleague(lease, "Jana"); expect(f.phone.state.retryTarget).toBeNull();
    await f.phone.dial("+421900000002"); expect(f.api.start).toHaveBeenCalledTimes(1);
  });
  it("explicitly cancels the exact uncertain original without another dial UUID", async () => {
    const f = await connected(); vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("network", 0));
    await f.phone.dialColleague(lease, "Jana"); await f.phone.cancelAttempt();
    expect(f.api.cancelAttempt).toHaveBeenCalledWith(lease, id, { kind: "internal", profileId: lease, name: "Jana" });
    expect(f.phone.state.retryTarget).toBeNull(); expect(f.phone.state.cancelingAttempt).toBe(false);
    expect(f.api.startInternal).toHaveBeenCalledTimes(1); expect(f.uuid).toHaveBeenCalledTimes(1);
  });
  it("keeps the original when cancellation cannot yet find the in-flight request", async () => {
    const f = await connected(); vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("network", 0));
    vi.mocked(f.api.cancelAttempt).mockResolvedValueOnce({ resolved: false, sessionId: null, terminationPending: false });
    await f.phone.dialColleague(lease, "Jana"); await f.phone.cancelAttempt();
    expect(f.phone.state.retryTarget).toMatchObject({ kind: "internal", profileId: lease });
    await f.phone.dial("+421900000002"); expect(f.api.start).not.toHaveBeenCalled();
  });
  it("blocks new calls while the acknowledged original cancellation remains pending", async () => {
    const f = await connected(); vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("network", 0));
    vi.mocked(f.api.cancelAttempt).mockResolvedValueOnce({ resolved: true, sessionId: sid, terminationPending: true });
    await f.phone.dialColleague(lease, "Jana"); await f.phone.cancelAttempt();
    expect(f.phone.state.retryTarget).toBeNull(); expect(f.phone.state.termination).toBe(sid);
    await f.phone.dial("+421900000002"); expect(f.api.start).not.toHaveBeenCalled();
  });
  it("serializes explicit cancellation against retry, a new target and a second cancellation", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["cancelAttempt"]>>) => void;
    vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("network", 0));
    vi.mocked(f.api.cancelAttempt).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.phone.dialColleague(lease, "Jana"); const work = f.phone.cancelAttempt();
    await f.phone.retryDial(); await f.phone.dialColleague(sid, "Peter"); await f.phone.cancelAttempt();
    expect(f.phone.state.cancelingAttempt).toBe(true); expect(f.api.cancelAttempt).toHaveBeenCalledTimes(1);
    expect(f.api.startInternal).toHaveBeenCalledTimes(1); expect(f.uuid).toHaveBeenCalledTimes(1);
    resolve({ resolved: true, sessionId: sid, terminationPending: false }); await work;
  });
  it.each([0, 502])("keeps original identity when cancellation has an uncertain %s result", async status => {
    const f = await connected(); vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("network", 0));
    vi.mocked(f.api.cancelAttempt).mockRejectedValueOnce(new MobileApiError("cancellation outcome unknown", status));
    await f.phone.dialColleague(lease, "Jana"); await f.phone.cancelAttempt();
    expect(f.phone.state.retryTarget).toMatchObject({ kind: "internal", profileId: lease }); expect(f.phone.state.cancelingAttempt).toBe(false);
    await f.phone.dial("+421900000002"); expect(f.api.start).not.toHaveBeenCalled();
  });
  it("does not apply a cancellation response after account disposal", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["cancelAttempt"]>>) => void;
    vi.mocked(f.api.startInternal).mockRejectedValueOnce(new MobileApiError("network", 0));
    vi.mocked(f.api.cancelAttempt).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await f.phone.dialColleague(lease, "Jana"); const work = f.phone.cancelAttempt(); f.phone.dispose(); const before = f.phone.state;
    resolve({ resolved: true, sessionId: sid, terminationPending: false }); await work;
    expect(f.phone.state).toBe(before);
  });
  it("creates only one internal command under simultaneous explicit dial actions", async () => {
    const f = await connected();
    await Promise.all([f.phone.dialColleague(lease, "Jana"), f.phone.dialColleague(sid, "Peter")]);
    expect(f.api.startInternal).toHaveBeenCalledTimes(1); expect(f.uuid).toHaveBeenCalledTimes(1);
  });
  it("retains a possibly committed command if heartbeat authentication fails during its first HTTP request", async () => {
    const f = await connected(); let reject!: (error: Error) => void;
    vi.mocked(f.api.startInternal).mockReturnValueOnce(new Promise((_done, fail) => { reject = fail; }))
      .mockRejectedValueOnce(new MobileApiError("target removed", 404));
    const work = f.phone.dialColleague(lease, "Jana");
    vi.mocked(f.api.heartbeat).mockRejectedValueOnce(new MobileApiError("auth revoked", 401));
    f.emit({ type: "registration", state: "registered" }); await tick();
    reject(new MobileApiError("outcome unknown", 0)); await work;
    expect(f.phone.state.retryTarget).toMatchObject({ kind: "internal", profileId: lease });
    await f.phone.connect(); await f.phone.retryDial();
    expect(f.phone.state.retryTarget).toMatchObject({ kind: "internal", profileId: lease });
    expect(f.uuid).toHaveBeenCalledTimes(1);
  });
  it("cannot terminate a recovered same-command call when its old HTTP response arrives late", async () => {
    const f = await connected(); let resolve!: (value: Awaited<ReturnType<VoiceApi["startInternal"]>>) => void;
    vi.mocked(f.api.startInternal).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const old = f.phone.dialColleague(lease, "Jana");
    vi.mocked(f.api.heartbeat).mockRejectedValueOnce(new MobileApiError("auth expired", 401));
    f.emit({ type: "registration", state: "registered" }); await tick(); await f.phone.connect(); await f.phone.retryDial();
    f.emit({ type: "outgoing", callId: id, sessionId: sid, number: "Jana" });
    resolve({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "Jana", targetProfileId: lease }); await old;
    expect(f.api.end).not.toHaveBeenCalled(); expect(f.phone.state.call?.sessionId).toBe(sid);
  });
  it("never originates an internal call with revoked microphone or while another call owns the phone", async () => {
    const f = await connected();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: false, pending: [], microphonePermission: "denied" }); await f.phone.refreshDiagnostics();
    await f.phone.dialColleague(lease, "Jana"); expect(f.api.startInternal).not.toHaveBeenCalled();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: false, pending: [], microphonePermission: "granted" }); await f.phone.refreshDiagnostics();
    f.emit({ type: "outgoing", callId: id, sessionId: sid }); await f.phone.dialColleague(lease, "Jana");
    expect(f.api.startInternal).not.toHaveBeenCalled();
  });
  it("withdraws receiving availability after microphone permission is revoked", async () => {
    const f = await connected();
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: false, pending: [], pushRegistered: true, microphonePermission: "denied" });
    await f.phone.refreshDiagnostics();
    expect(f.api.heartbeat).toHaveBeenLastCalledWith(lease, "unregistered", false);
    await f.phone.dial("+421900000002"); expect(f.api.start).not.toHaveBeenCalled();
  });
  it("does not take over another device while this phone has a call", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.api.token).mockClear(); await f.phone.connect(true);
    expect(f.api.token).not.toHaveBeenCalled(); expect(f.phone.state.call?.id).toBe(id);
  });
  it("offers an explicit retry of the original uncertain outbound request", async () => {
    const f = await connected(); vi.mocked(f.api.start).mockRejectedValueOnce(new MobileApiError("timeout", 0));
    await f.phone.dial("+421900000002"); expect(f.phone.state.retryTarget).toEqual({ kind: "external", number: "+421900000002" });
    await f.phone.retryDial();
    expect(f.api.start).toHaveBeenNthCalledWith(1, lease, id, "+421900000002", undefined, undefined);
    expect(f.api.start).toHaveBeenNthCalledWith(2, lease, id, "+421900000002", undefined, undefined);
    expect(f.phone.state.retryTarget).toBeNull();
  });
  it("preserves the original uncertain command across an untrusted start response and safe reconnect", async () => {
    const f = await connected();
    const envelope = { ok: true, apiVersion: 1, environment: "test", profileId: "operator", sessionId: sid, to: "+421900000002" };
    const transport = vi.fn().mockResolvedValueOnce(Response.json(envelope))
      .mockResolvedValueOnce(Response.json({ ...envelope, operatorLegCallControlId: "exact-leg" }));
    f.api.start = vi.fn(createVoiceApi({ environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" }, "operator", async () => "user-token", transport).start);
    await f.phone.dial("+421900000002");
    expect(f.phone.state.retryTarget).toEqual({ kind: "external", number: "+421900000002" }); expect(f.phone.state.registration).toBe("error");
    expect(f.native.disconnect).toHaveBeenCalled();
    await f.phone.connect(); await f.phone.retryDial();
    expect(f.uuid).toHaveBeenCalledTimes(1);
    expect(f.api.start).toHaveBeenNthCalledWith(2, lease, id, "+421900000002", undefined, undefined);
    expect(transport.mock.calls.map(call => JSON.parse(String(call[1].body)).requestId)).toEqual([id, id]);
  });
  it("does not discard an uncertain outgoing command when another device owns reconnect", async () => {
    const f = await connected(); vi.mocked(f.api.start).mockRejectedValueOnce(new MobileApiError("Malformed reply", 502));
    await f.phone.dial("+421900000002"); vi.mocked(f.api.token).mockRejectedValueOnce(new MobileApiError("Owned on other phone", 409));
    await f.phone.connect(); expect(f.phone.state.takeoverRequired).toBe(true); expect(f.phone.state.retryTarget).toEqual({ kind: "external", number: "+421900000002" });
    await f.phone.connect(true); expect(f.api.token).toHaveBeenCalledTimes(2);
  });
  it("refreshes microphone diagnostics without prompting, registering or interrupting a call", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: true, audioActive: true, pending: [], pushRegistered: true, microphonePermission: "denied" });
    vi.mocked(f.native.requestMicrophone).mockClear(); vi.mocked(f.api.token).mockClear(); vi.mocked(f.native.disconnect).mockClear();
    await f.phone.refreshDiagnostics();
    expect(f.phone.state.microphonePermission).toBe("denied"); expect(f.phone.state.call?.id).toBe(id);
    expect(f.native.requestMicrophone).not.toHaveBeenCalled(); expect(f.api.token).not.toHaveBeenCalled(); expect(f.native.disconnect).not.toHaveBeenCalled();
  });
  it("never marks a failed heartbeat as confirmed and recovers on a later success", async () => {
    const f = await connected(); expect(f.phone.state.lastHeartbeatAt).not.toBeNull();
    vi.mocked(f.api.heartbeat).mockRejectedValueOnce(new MobileApiError("network unavailable", 0));
    f.emit({ type: "registration", state: "registered" }); await tick();
    expect(f.phone.state.heartbeatError).toBe("network unavailable");
    expect(f.phone.state.registration).toBe("registered"); expect(f.native.disconnect).not.toHaveBeenCalled();
    f.emit({ type: "registration", state: "registered" }); await tick();
    expect(f.phone.state.heartbeatError).toBeNull(); expect(f.phone.state.error).toBeNull();
  });
  it("treats an old native snapshot without microphone information as unknown", async () => {
    const f = await connected(); await f.phone.refreshDiagnostics();
    expect(f.phone.state.microphonePermission).toBe("unknown");
  });
  it("does not apply diagnostics that arrive after account disposal", async () => {
    const f = await connected(); let release!: (snapshot: Awaited<ReturnType<NativePhone["snapshot"]>>) => void;
    vi.mocked(f.native.snapshot).mockReturnValueOnce(new Promise(done => { release = done; }));
    const work = f.phone.refreshDiagnostics(); const before = f.phone.state;
    f.phone.dispose(); release({ ready: true, audioActive: false, pending: [], microphonePermission: "granted", pushRegistered: true }); await work;
    expect(f.phone.state).toBe(before);
  });
  it("does not terminate the current call on an unrelated old outgoing timeout", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    f.emit({ type: "outgoingFailed", sessionId: lease }); await tick();
    expect(f.api.end).not.toHaveBeenCalled(); expect(f.phone.state.call?.sessionId).toBe(sid);
  });
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
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "outbound", role: "caller", displayName: null, number: "+421900000002" });
    const dial = f.phone.dial("+421900000002");
    f.emit({ type: "incoming", callId: id, providerLegId: id });
    f.emit({ type: "incoming", callId: "another-call", providerLegId: lease }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled();
    resolve({ sessionId: sid, operatorLegCallControlId: "exact-leg", to: "+421900000002" }); await dial;
    expect(f.native.expectOutgoing).toHaveBeenCalledWith("exact-leg", sid, "+421900000002", false);
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
    resolve({ sessionId: sid, callControlId: "exact-leg", direction: "inbound", role: "callee", displayName: null, number: null }); await tick();
    expect(f.native.authorize).not.toHaveBeenCalled(); expect(f.phone.state.call).toBeNull();
  });
  it("requires backend bridge confirmation before displaying a connected call", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick(); expect(f.phone.state.call?.connected).toBe(false);
    expect(f.native.confirmConnected).not.toHaveBeenCalled();
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false, media: { version: 1, state: "unavailable", canHold: false, callControlId: null } });
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
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "outbound", role: "caller", displayName: null, number: "+421900000002" });
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    expect(f.native.authorize).toHaveBeenCalledWith(id, sid, "exact-leg");
    expect(f.phone.state.call?.outgoing).toBe(true);
  });
  it.each([
    { sessionId: sid, callControlId: "other-control" },
    { sessionId: lease, callControlId: "exact-leg" },
  ])("rejects a resolved offer outside the exact outgoing session/control pair: %j", async mismatch => {
    const f = await connected(); await f.phone.dial("+421900000002");
    vi.mocked(f.api.authorize).mockResolvedValue({ ...mismatch, direction: "outbound", role: "caller", displayName: null, number: null });
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
    resolve({ sessionId: sid, callControlId: "exact-leg", direction: "outbound", role: "caller", displayName: null, number: null }); await tick();
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
    resolve({ sessionId: sid, callControlId: "exact-leg", direction: "inbound", role: "callee", displayName: null, number: null }); await tick();
    expect(f.native.disconnect).toHaveBeenCalled(); expect(f.native.authorize).not.toHaveBeenCalled();
    expect(f.phone.state.registration).toBe("error");
    expect(f.phone.state.error).toBe("Telefonovanie v aplikácii ešte nie je aktivované.");
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
  it("recovers the first connection after a temporary token outage without dialing or taking over", async () => {
    const f = fixture(); await f.phone.initialise(); vi.useFakeTimers();
    vi.mocked(f.api.token).mockRejectedValueOnce(new MobileApiError("offline", 0));
    await f.phone.connect();
    expect(f.phone.state.registration).toBe("error");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.api.token).toHaveBeenCalledTimes(2);
    expect(f.api.token).toHaveBeenLastCalledWith(lease, false);
    expect(f.phone.state.registration).toBe("registered");
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.startInternal).not.toHaveBeenCalled();
  });
  it("bounds first-connection retries and gives a fresh chance on returning to the app", async () => {
    const f = fixture(); await f.phone.initialise(); vi.useFakeTimers();
    vi.mocked(f.api.token).mockRejectedValue(new MobileApiError("server unavailable", 503));
    await f.phone.connect(); await vi.advanceTimersByTimeAsync(120_000);
    expect(f.api.token).toHaveBeenCalledTimes(4);
    f.phone.setForeground(false); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.token).toHaveBeenCalledTimes(4);
    f.phone.setForeground(true); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.api.token).toHaveBeenCalledTimes(5);
  });
  it.each([401, 403, 409, 502])("never automatically retries a refused or untrusted first connection (%s)", async status => {
    const f = fixture(); await f.phone.initialise(); vi.useFakeTimers();
    vi.mocked(f.api.token).mockRejectedValue(new MobileApiError("refused", status));
    await f.phone.connect(); await vi.advanceTimersByTimeAsync(30_000);
    f.phone.setForeground(false); f.phone.setForeground(true); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.token).toHaveBeenCalledTimes(1);
    expect(f.native.connect).not.toHaveBeenCalled();
  });
  it("does not retry a refused refresh on return when a previous token is still in memory", async () => {
    const f = await connected(); vi.useFakeTimers();
    vi.mocked(f.api.token).mockRejectedValue(new MobileApiError("other phone", 409));
    await f.phone.connect();
    f.phone.setForeground(false); f.phone.setForeground(true); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.token).toHaveBeenCalledTimes(2);
    expect(f.phone.state.takeoverRequired).toBe(true);
  });
  it("does not re-enable a manually disconnected phone after a failed first connection", async () => {
    const f = fixture(); await f.phone.initialise(); vi.useFakeTimers();
    vi.mocked(f.api.token).mockRejectedValue(new MobileApiError("offline", 0));
    await f.phone.connect(); await f.phone.disconnect();
    f.phone.setForeground(false); f.phone.setForeground(true); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.token).toHaveBeenCalledTimes(1);
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
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "talking", connected: false, ended: true, terminationPending: false, media: { version: 1, state: "unavailable", canHold: false, callControlId: null } });
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.native.reject).toHaveBeenCalledWith(id); expect(f.api.end).not.toHaveBeenCalled();
    expect(f.phone.state.call).toBeNull(); expect(f.phone.state.registration).toBe("registered");
  });

  it("keeps owned cleanup pending after the native leg ends until the other legs finish", async () => {
    const f = await connected(); f.emit({ type: "outgoing", callId: id, sessionId: sid });
    vi.mocked(f.api.end).mockResolvedValue({ terminationPending: true });
    await f.phone.end(); f.emit({ type: "ended", callId: id, sessionId: sid, outgoing: true }); await tick();
    vi.useFakeTimers(); f.phone.setForeground(true);
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "ending", connected: false, ended: true, terminationPending: true, media: { version: 1, state: "unavailable", canHold: false, callControlId: null } });
    await vi.advanceTimersByTimeAsync(2_000); expect(f.phone.state.termination).toBe(sid);
    vi.mocked(f.api.status).mockResolvedValue({ sessionId: sid, state: "completed", connected: false, ended: true, terminationPending: false, media: { version: 1, state: "unavailable", canHold: false, callControlId: null } });
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

describe("Telnyx VoIP push without a provider leg", () => {
  const leg = "00000000-0000-4000-8000-0000000000aa";
  it("prepares native signaling and authorizes the INVITE by its own leg, never an empty one", async () => {
    const f = await connected(); vi.mocked(f.native.connect).mockClear();
    f.emit({ type: "push", callId: id, providerLegId: "" }); await tick();
    expect(f.native.connect).toHaveBeenCalled(); expect(f.api.authorize).not.toHaveBeenCalled();
    expect(f.native.reject).not.toHaveBeenCalled(); expect(f.phone.state.call).toBeNull();
    f.emit({ type: "incoming", callId: id, providerLegId: leg }); await tick();
    expect(f.api.authorize).toHaveBeenCalledExactlyOnceWith(lease, { providerLegId: leg });
    expect(f.native.authorize).toHaveBeenCalledExactlyOnceWith(id, sid, "exact-leg");
    expect(f.phone.state.call).toMatchObject({ id, sessionId: sid, state: "RINGING", outgoing: false });
  });
  it("replays an INVITE that arrived while its push was being prepared", async () => {
    const f = await connected(); let release!: () => void;
    vi.mocked(f.native.connect).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    f.emit({ type: "push", callId: id, providerLegId: "" }); await tick();
    f.emit({ type: "incoming", callId: id, providerLegId: leg }); await tick();
    expect(f.api.authorize).not.toHaveBeenCalled();
    release(); await tick(); await tick();
    expect(f.api.authorize).toHaveBeenCalledExactlyOnceWith(lease, { providerLegId: leg });
    expect(f.native.authorize).toHaveBeenCalledExactlyOnceWith(id, sid, "exact-leg");
    expect(f.native.reject).not.toHaveBeenCalled();
  });
  it("does not replay the INVITE of a push that ended while it was prepared", async () => {
    const f = await connected(); let release!: () => void;
    vi.mocked(f.native.connect).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    f.emit({ type: "push", callId: id, providerLegId: "" }); await tick();
    f.emit({ type: "incoming", callId: id, providerLegId: leg }); f.emit({ type: "ended", callId: id }); await tick();
    release(); await tick(); await tick();
    expect(f.api.authorize).not.toHaveBeenCalled(); expect(f.native.authorize).not.toHaveBeenCalled();
  });
  it("reports a refused push once, by reason and key names only, then lets native forget it", async () => {
    const report = vi.fn(); const f = fixture(report);
    const refused: VoiceEvent = { type: "pushRejected", id: lease, reason: "missing_voice_sdk_id", keys: ["call_id", "caller_number"], payloadKeys: ["aps", "metadata"], alertKnown: false };
    vi.mocked(f.native.snapshot).mockResolvedValue({ ready: false, audioActive: false, pending: [], pushRejection: refused });
    await f.phone.initialise(); f.emit(refused); await tick();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ name: "VoIPPushRejected", message: "missing_voice_sdk_id; metadata keys: call_id,caller_number; payload keys: aps,metadata; alert: unknown" });
    expect(f.native.clearPushRejection).toHaveBeenCalledExactlyOnceWith(lease);
    f.emit({ type: "pushRejected", id: sid, reason: "missing_call_id", keys: [], payloadKeys: ["aps"] }); await tick();
    expect(report).toHaveBeenCalledTimes(2); expect(report.mock.calls[1][0].message).toBe("missing_call_id; metadata keys: none; payload keys: aps; alert: none");
    expect(f.native.clearPushRejection).toHaveBeenLastCalledWith(sid);
  });
  it("authorizes a stored INVITE by its own leg when preparing its push fails", async () => {
    const f = await connected(); let fail!: (error: Error) => void;
    vi.mocked(f.native.connect).mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
    f.emit({ type: "push", callId: id, providerLegId: "" }); await tick();
    f.emit({ type: "incoming", callId: id, providerLegId: leg }); await tick();
    fail(new Error("native bridge")); await tick(); await tick();
    expect(f.api.authorize).toHaveBeenCalledExactlyOnceWith(lease, { providerLegId: leg });
    expect(f.native.authorize).toHaveBeenCalledExactlyOnceWith(id, sid, "exact-leg");
    expect(f.native.reject).not.toHaveBeenCalled(); expect(f.phone.state.error).toBeNull();
  });
  it("authorizes a stored INVITE by its own leg when the leg its push named is refused", async () => {
    const f = await connected(); let refuse!: (error: Error) => void;
    vi.mocked(f.api.authorize).mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    f.emit({ type: "push", callId: id, providerLegId: id }); await tick();
    f.emit({ type: "incoming", callId: id, providerLegId: leg }); await tick();
    refuse(new MobileApiError("expired offer", 409)); await tick(); await tick();
    expect(vi.mocked(f.api.authorize).mock.calls.map(call => call[1])).toEqual([{ providerLegId: id }, { providerLegId: leg }]);
    expect(f.native.authorize).toHaveBeenCalledExactlyOnceWith(id, sid, "exact-leg");
    expect(f.native.reject).not.toHaveBeenCalled();
  });
  it("still rejects a push whose preparation fails when no INVITE arrived", async () => {
    const f = await connected();
    vi.mocked(f.native.connect).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("native bridge"));
    f.emit({ type: "push", callId: id, providerLegId: "" }); await tick(); await tick();
    expect(f.native.reject).toHaveBeenCalledWith(id); expect(f.api.authorize).not.toHaveBeenCalled();
  });
});

describe("callback and confirmed-target dialing", () => {
  const callbackId = "00000000-0000-4000-8000-0000000000cb", verification = "00000000-0000-4000-8000-0000000000ef";
  it("compares the complete immutable target", () => {
    expect(sameDialTarget({ kind: "external", number: "+1" }, { kind: "external", number: "+1" })).toBe(true);
    expect(sameDialTarget({ kind: "external", number: "+1" }, { kind: "external", number: "+1", verificationId: verification })).toBe(false);
    expect(sameDialTarget({ kind: "callback", callbackRequestId: callbackId, number: "+1" }, { kind: "callback", callbackRequestId: callbackId, number: "+2" })).toBe(true);
    expect(sameDialTarget({ kind: "callback", callbackRequestId: callbackId, number: "+1" }, { kind: "external", number: "+1" })).toBe(false);
    expect(sameDialTarget({ kind: "internal", profileId: lease, name: "Jana" }, { kind: "internal", profileId: lease, name: "Iné" })).toBe(true);
  });
  it("rings a queued caller back through the callback command and expects the dialed number", async () => {
    const f = await connected();
    await f.phone.dialCallback(callbackId.toUpperCase(), "+421900000003", verification);
    expect(f.api.startCallback).toHaveBeenCalledExactlyOnceWith(lease, id, callbackId, verification);
    expect(f.api.start).not.toHaveBeenCalled();
    expect(f.native.expectOutgoing).toHaveBeenCalledWith("exact-leg", sid, "+421900000003", false);
  });
  it("retries and cancels only the original uncertain callback", async () => {
    const f = await connected(); vi.mocked(f.api.startCallback).mockRejectedValueOnce(new MobileApiError("network", 0));
    await f.phone.dialCallback(callbackId, "+421900000003");
    expect(f.phone.state.retryTarget).toEqual({ kind: "callback", callbackRequestId: callbackId, number: "+421900000003" });
    await f.phone.dial("+421900000003"); await f.phone.dialCallback(lease, "+421900000003");
    expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.startCallback).toHaveBeenCalledTimes(1);
    expect(f.phone.state.error).toBe("Najprv zopakujte pôvodný pokus o volanie.");
    await f.phone.cancelAttempt();
    expect(f.api.cancelAttempt).toHaveBeenCalledWith(lease, id, { kind: "callback", callbackRequestId: callbackId, number: "+421900000003" });
    expect(f.phone.state.retryTarget).toBeNull(); expect(f.uuid).toHaveBeenCalledTimes(1);
  });
  it("keeps a confirmed alternative in the dial and in its retry", async () => {
    const f = await connected(); vi.mocked(f.api.start).mockRejectedValueOnce(new MobileApiError("timeout", 0));
    await f.phone.dial("+421232408700", verification);
    expect(f.phone.state.retryTarget).toEqual({ kind: "external", number: "+421232408700", verificationId: verification });
    await f.phone.dial("+421232408700"); expect(f.api.start).toHaveBeenCalledTimes(1);
    await f.phone.retryDial();
    expect(f.api.start).toHaveBeenNthCalledWith(2, lease, id, "+421232408700", verification, undefined);
  });
  it("files a call from a case and keeps that case in its retry and cancel", async () => {
    const caseId = "00000000-0000-4000-8000-0000000000AB";
    const f = await connected(); vi.mocked(f.api.start).mockRejectedValueOnce(new MobileApiError("timeout", 0));
    await f.phone.dial("+421232408700", undefined, caseId);
    expect(f.api.start).toHaveBeenNthCalledWith(1, lease, id, "+421232408700", undefined, caseId.toLowerCase());
    expect(f.phone.state.retryTarget).toEqual({ kind: "external", number: "+421232408700", caseId: caseId.toLowerCase() });
    // The same number without the case is a different attempt.
    await f.phone.dial("+421232408700"); expect(f.api.start).toHaveBeenCalledTimes(1);
    expect(f.phone.state.error).toBe("Najprv zopakujte pôvodný pokus o volanie.");
    await f.phone.cancelAttempt();
    expect(f.api.cancelAttempt).toHaveBeenCalledWith(lease, id, { kind: "external", number: "+421232408700", caseId: caseId.toLowerCase() });
  });
  it("reports whether a callback command was actually sent", async () => {
    const f = await connected();
    expect(await f.phone.dialCallback(callbackId, "+421900000003")).toBe(true);
    expect(await f.phone.dialCallback(callbackId, "+421900000003")).toBe(false);
    expect(f.api.startCallback).toHaveBeenCalledTimes(1);
    const idle = fixture();
    expect(await idle.phone.dialCallback(callbackId, "+421900000003")).toBe(false); expect(idle.api.startCallback).not.toHaveBeenCalled();
  });
  it("drops a server-refused callback without a retry", async () => {
    const f = await connected(); vi.mocked(f.api.startCallback).mockRejectedValueOnce(new MobileApiError("Požiadavku má prevzatú Peter.", 409, "already_claimed"));
    await f.phone.dialCallback(callbackId, "+421900000003");
    expect(f.phone.state.retryTarget).toBeNull(); expect(f.phone.state.error).toContain("Peter");
  });
});
describe("call errors on the phone's own call", () => {
  const talking = { sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false, media: activeMedia };
  it("clears a failed status read on the next good one, but keeps other errors", async () => {
    const f = await activePhone();
    vi.mocked(f.api.status).mockRejectedValueOnce(new MobileApiError("Nepodarilo sa spojiť s ústredňou. Skontrolujte pripojenie.", 0));
    await f.phone.refreshHold();
    expect(f.phone.state.error).toBe("Nepodarilo sa spojiť s ústredňou. Skontrolujte pripojenie.");
    vi.mocked(f.api.status).mockResolvedValue(talking);
    await f.phone.refreshHold();
    expect(f.phone.state.error).toBeNull();
    vi.mocked(f.native.requestHold).mockRejectedValueOnce(new Error("native"));
    await f.phone.hold();
    expect(f.phone.state.error).toBe("Podržanie hovoru sa nepodarilo pripraviť. Skúste znova.");
    await f.phone.refreshHold();
    expect(f.phone.state.error).toBe("Podržanie hovoru sa nepodarilo pripraviť. Skúste znova.");
  });
  it("starts a new incoming call without an earlier call's error", async () => {
    const f = await connected();
    vi.mocked(f.api.start).mockRejectedValueOnce(new MobileApiError("Číslo nie je povolené.", 403));
    await f.phone.dial("+421900000002");
    expect(f.phone.state.error).toBe("Číslo nie je povolené."); expect(f.phone.state.retryTarget).toBeNull();
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick(); await tick();
    expect(f.phone.state.call?.id).toBe(id);
    expect(f.phone.state.error).toBeNull();
  });
});
describe("transfer and recording of the own call", () => {
  const colleague = "00000000-0000-4000-8000-000000000004";
  const talking = { sessionId: sid, state: "talking", connected: true, ended: false, terminationPending: false, media: activeMedia };
  it("shows the recorder from the status read and keeps a stop's answer over an older read", async () => {
    const f = await activePhone();
    vi.mocked(f.api.status).mockResolvedValue({ ...talking, recording: { state: "recording", suppressed: false } });
    await f.phone.refreshHold();
    expect(f.phone.state.call?.recording).toEqual({ state: "recording", suppressed: false });
    let release!: (value: VoiceStatus) => void;
    vi.mocked(f.api.status).mockReturnValueOnce(new Promise(done => { release = done; }));
    const read = f.phone.refreshHold();
    vi.mocked(f.api.stopRecording).mockResolvedValue({ state: "stopping", suppressed: true });
    expect(await f.phone.stopRecording(false, sid)).toEqual({ state: "stopping", suppressed: true });
    expect(f.api.stopRecording).toHaveBeenCalledWith(lease, sid, false);
    release({ ...talking, recording: { state: "recording", suppressed: false } }); await read;
    expect(f.phone.state.call?.recording).toEqual({ state: "stopping", suppressed: true });
    vi.mocked(f.api.status).mockResolvedValue({ ...talking, recording: { state: "stopped", suppressed: true } });
    await f.phone.refreshHold();
    expect(f.phone.state.call?.recording).toEqual({ state: "stopped", suppressed: true });
    await f.phone.stopRecording(true, sid); expect(f.api.stopRecording).toHaveBeenLastCalledWith(lease, sid, true);
  });
  it("transfers the connected call and reads its end at once", async () => {
    const f = await activePhone();
    vi.mocked(f.api.transfer).mockResolvedValue({ state: "ringing" });
    vi.mocked(f.api.status).mockResolvedValue({ ...talking, state: "ringing", connected: false, ended: true, media: { version: 9, state: "unavailable", canHold: false, callControlId: null } });
    expect(await f.phone.transfer(colleague, sid)).toEqual({ state: "ringing" });
    expect(f.api.transfer).toHaveBeenCalledWith(lease, sid, colleague);
    for (let i = 0; i < 5 && f.phone.state.call; i++) await tick();
    expect(f.phone.state.call).toBeNull(); expect(f.native.reject).toHaveBeenCalledWith(id);
  });
  it("refuses transfer, colleagues and stop without a connected call, and transfer during a hold change", async () => {
    const idle = await connected();
    await expect(idle.phone.transfer(colleague, sid)).rejects.toMatchObject({ status: 409 });
    await expect(idle.phone.transferTargets()).rejects.toMatchObject({ status: 409 });
    await expect(idle.phone.stopRecording(false, sid)).rejects.toMatchObject({ status: 409 });
    const f = await activePhone(); await f.phone.hold();
    expect(f.phone.state.holdPhase).toBe("requesting");
    await expect(f.phone.transfer(colleague, sid)).rejects.toMatchObject({ status: 409 });
    expect(idle.api.transfer).not.toHaveBeenCalled(); expect(f.api.transfer).not.toHaveBeenCalled(); expect(idle.api.stopRecording).not.toHaveBeenCalled();
  });
  it("acts only on the call the dispatcher confirmed", async () => {
    const f = await activePhone();
    await expect(f.phone.transfer(colleague, lease)).rejects.toMatchObject({ status: 409, message: "Hovor sa medzitým zmenil. Skúste to znova." });
    await expect(f.phone.stopRecording(false, lease)).rejects.toMatchObject({ status: 409 });
    expect(f.api.transfer).not.toHaveBeenCalled(); expect(f.api.stopRecording).not.toHaveBeenCalled();
  });
  it("keeps the phone connected when the server closes a transferred leg", async () => {
    const f = await activePhone();
    vi.mocked(f.api.transfer).mockResolvedValue({ state: "ringing" });
    // The provider's hang-up of this leg usually reaches the phone before any status read.
    vi.mocked(f.api.status).mockReturnValue(new Promise(() => {}));
    await f.phone.transfer(colleague, sid);
    f.emit({ type: "ended", callId: id, sessionId: sid }); await tick(); await tick();
    expect(f.api.end).not.toHaveBeenCalled();
    expect(f.phone.state.call).toBeNull();
    expect(f.phone.state.registration).toBe("registered"); expect(f.phone.state.error).toBeNull();
  });
  it("treats a refused end of a transferred call as done, not as a lost phone", async () => {
    const f = await activePhone();
    vi.mocked(f.api.transfer).mockRejectedValue(new MobileApiError("Prepojenie hovoru sa nepodarilo potvrdiť.", 0));
    // The outcome stays unknown while no status read has answered yet.
    vi.mocked(f.api.status).mockReturnValue(new Promise(() => {}));
    await expect(f.phone.transfer(colleague, sid)).rejects.toMatchObject({ status: 0 });
    vi.mocked(f.api.end).mockRejectedValue(new MobileApiError("Hovor nepatrí vášmu telefónu.", 403));
    await f.phone.end();
    expect(f.api.end).toHaveBeenCalledWith(lease, sid);
    expect(f.phone.state.registration).toBe("registered"); expect(f.phone.state.termination).toBeNull();
  });
  it("releases the guard when the call stays here after the transfer answer", async () => {
    const f = await activePhone();
    vi.mocked(f.api.transfer).mockResolvedValue({ state: "talking" });
    vi.mocked(f.api.status).mockResolvedValue(talking);
    await f.phone.transfer(colleague, sid);
    for (let i = 0; i < 5 && f.phone.state.transferPending; i++) await tick();
    expect(f.phone.state.transferPending).toBeNull();
    expect(f.phone.state.error).toBe("Prepojenie sa nepodarilo. Hovor ostáva u vás.");
    // A hang-up from the lock screen is a real hang-up again.
    f.emit({ type: "ended", callId: id, sessionId: sid }); await tick(); await tick();
    expect(f.api.end).toHaveBeenCalledWith(lease, sid);
  });
  it("keeps the guard while the transfer is announced and against reads from before its answer", async () => {
    const f = await activePhone();
    let release!: (value: VoiceStatus) => void;
    vi.mocked(f.api.status).mockReturnValueOnce(new Promise(done => { release = done; }));
    const before = f.phone.refreshHold();
    vi.mocked(f.api.transfer).mockResolvedValue({ state: "talking" });
    vi.mocked(f.api.status).mockResolvedValue({ ...talking, media: { ...activeMedia, version: 9, state: "pending" } });
    await f.phone.transfer(colleague, sid);
    release(talking); await before;
    expect(f.phone.state.transferPending).toBe(sid);
    await f.phone.refreshHold();
    expect(f.phone.state.transferPending).toBe(sid);
    f.emit({ type: "ended", callId: id, sessionId: sid }); await tick(); await tick();
    expect(f.api.end).not.toHaveBeenCalled();
  });
  it("learns a colleague call from the server after a restart", async () => {
    const f = await activePhone();
    vi.mocked(f.api.status).mockResolvedValue({ ...talking, internal: true });
    await f.phone.refreshHold();
    expect(f.phone.state.call?.internal).toBe(true);
  });
  it("ends only the call a confirmation was about", async () => {
    const f = await activePhone();
    await f.phone.endConfirmed(lease);
    expect(f.api.end).not.toHaveBeenCalled(); expect(f.native.end).not.toHaveBeenCalled();
    await f.phone.endConfirmed(sid);
    expect(f.api.end).toHaveBeenCalledWith(lease, sid);
  });
  it("forgets a refused transfer, so a later end still hangs up and a lost ownership still disconnects", async () => {
    const f = await activePhone();
    vi.mocked(f.api.transfer).mockRejectedValue(new MobileApiError("Kolega nie je dostupný.", 409));
    await expect(f.phone.transfer(colleague, sid)).rejects.toMatchObject({ status: 409 });
    vi.mocked(f.api.end).mockRejectedValue(new MobileApiError("Hovor nepatrí vášmu telefónu.", 403));
    await f.phone.end();
    expect(f.phone.state.registration).toBe("error");
  });
  it("never transfers a call between colleagues", async () => {
    const f = await connected();
    vi.mocked(f.api.authorize).mockResolvedValue({ sessionId: sid, callControlId: "exact-leg", direction: "internal", role: "callee", displayName: "Peter", number: null });
    vi.mocked(f.api.status).mockResolvedValue(talking);
    f.emit({ type: "incoming", callId: id, providerLegId: id }); await tick();
    f.emit({ type: "callState", callId: id, state: "ACTIVE" }); await tick();
    expect(f.phone.state.call).toMatchObject({ internal: true });
    await expect(f.phone.transfer(colleague, sid)).rejects.toMatchObject({ status: 409 });
    expect(f.api.transfer).not.toHaveBeenCalled();
  });
});
