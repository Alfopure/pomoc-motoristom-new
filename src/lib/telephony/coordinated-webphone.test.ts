import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatedWebphone } from "./coordinated-webphone";
import type { TelnyxWebphone, TelnyxWebphoneOptions, WebphoneSnapshot } from "./telnyx-webphone";

const registered = (): WebphoneSnapshot => ({ status: "registered", registration: { status: "registered", label: "Registrované", detail: "", tone: "ok" }, deviceSessionId: "secret-session", sipUsername: "secret-sip", call: null, message: null });
const ringing = (id: string): WebphoneSnapshot["call"] => ({ id, state: "ringing", direction: "inbound", number: "+421905123456", callerName: null, telnyxCallControlId: id, sessionId: "session", muted: false, ringing: true, active: false });
const phones: ReturnType<typeof fakePhone>[] = [];
const controllers: CoordinatedWebphone[] = [];
function fakePhone(options: TelnyxWebphoneOptions) {
  let state = registered();
  const listeners = new Set<(state: WebphoneSnapshot) => void>();
  const phone = {
    options, getSnapshot: () => state,
    subscribe: (fn: (state: WebphoneSnapshot) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (next: WebphoneSnapshot) => { state = next; for (const fn of listeners) fn(next); },
    start: vi.fn(() => { options.onSession?.("new-session"); phone.emit(registered()); }), stop: vi.fn(),
    answer: vi.fn(), hangup: vi.fn(), toggleMute: vi.fn(), sendDtmf: vi.fn(), expectOperatorLeg: vi.fn(), dismissCallError: vi.fn(), takeover: vi.fn(), unlockAudio: vi.fn(), resumeAudio: vi.fn(), confirmRegistration: vi.fn(async () => undefined),
  };
  return phone;
}
function create(mobile = false, scope = "org:actor") {
  const controller = new CoordinatedWebphone({ scope, mobile, createPhone: (options) => { const phone = fakePhone(options); phones.push(phone); return phone as unknown as TelnyxWebphone; } });
  controllers.push(controller); controller.start(); return controller;
}
const channels = new Set<Channel>();
class Channel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) { channels.add(this); }
  postMessage(data: unknown) { for (const other of channels) if (other !== this && other.name === this.name) queueMicrotask(() => { if (channels.has(other)) other.onmessage?.({ data: structuredClone(data) }); }); }
  close() { channels.delete(this); }
}

beforeEach(() => {
  phones.length = 0; controllers.length = 0; channels.clear();
  vi.stubGlobal("window", new EventTarget());
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", { locks: { request: (name: string, options: { signal: AbortSignal }, run: () => Promise<void>) => {
    const task = (tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (options.signal.aborted) throw new Error("aborted");
      await run();
    });
    tails.set(name, task); return task;
  } } });
  vi.stubGlobal("BroadcastChannel", Channel);
});
afterEach(() => { for (const controller of controllers) controller.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe("shared browser phone and on-demand mobile", () => {
  it("uses one SDK across tabs, shares calls, and routes follower controls without sharing credentials", async () => {
    const first = create(); const second = create(); await flush();
    expect(phones).toHaveLength(1);
    phones[0].emit({ ...registered(), call: ringing("call-a") }); await flush();
    expect(second.getSnapshot()).toMatchObject({ sharedTab: true, call: { id: "call-a" }, deviceSessionId: null, sipUsername: null });
    second.answer(); await flush(); expect(phones[0].answer).toHaveBeenCalledOnce();
    expect(first.getSnapshot().sharedTab).toBe(false);
  });

  it("rejects a queued action for a previous call", async () => {
    create(); const follower = create(); await flush();
    phones[0].emit({ ...registered(), call: ringing("call-a") }); await flush();
    void follower.hangup();
    phones[0].emit({ ...registered(), call: ringing("call-b") }); await flush();
    expect(phones[0].hangup).not.toHaveBeenCalled();
    expect(follower.getSnapshot().callError).toContain("Stav hovoru sa zmenil");
  });

  it("hands off only after lock release and supplies the old session proof to fence late requests", async () => {
    const first = create(); const follower = create(); await flush();
    first.dispose(); await flush();
    expect(phones).toHaveLength(2);
    expect(phones[0].stop).toHaveBeenCalledOnce();
    expect(phones[1].options).toMatchObject({ handoff: true, resumeSessionId: "new-session" });
    expect(follower.getSnapshot().sharedTab).toBe(false);
  });

  it("isolates different accounts and does not transmit gestures as audio permission", async () => {
    create(); const follower = create(); create(false, "org:another-actor"); await flush();
    expect(phones).toHaveLength(2);
    await follower.resumeAudio();
    expect(phones[0].resumeAudio).not.toHaveBeenCalled();
    expect(follower.getSnapshot().callError).toContain("karte, ktorá pripojila telefón");
  });

  it("opening the mobile app creates no SIP client; explicit pickup waits for server registration", async () => {
    const mobile = create(true); await flush();
    expect(phones).toHaveLength(0);
    expect(mobile.getSnapshot()).toMatchObject({ onDemand: true, status: "idle" });
    await mobile.prepareForCall();
    expect(phones).toHaveLength(1);
    expect(phones[0].options.deviceKind).toBe("mobile");
    expect(phones[0].confirmRegistration).toHaveBeenCalledOnce();
  });

  it("keeps mobile media while a call is active and returns to standby only after it ends", async () => {
    vi.useFakeTimers();
    const mobile = create(true); await mobile.prepareForCall();
    phones[0].emit({ ...registered(), call: { ...ringing("call-a")!, active: true, ringing: false } });
    mobile.finishRequest(); await vi.advanceTimersByTimeAsync(20_000);
    expect(phones[0].stop).not.toHaveBeenCalled();
    phones[0].emit(registered()); await vi.advanceTimersByTimeAsync(5_000);
    expect(phones[0].stop).toHaveBeenCalledOnce();
    expect(mobile.getSnapshot().status).toBe("idle");
  });

  it("an API request in flight does not retire the mobile phone before its correlated invite", async () => {
    vi.useFakeTimers();
    const mobile = create(true); await mobile.prepareForCall();
    await vi.advanceTimersByTimeAsync(15_000); expect(phones[0].stop).not.toHaveBeenCalled();
    phones[0].emit({ ...registered(), pendingOperatorLegs: 1 }); mobile.finishRequest();
    await vi.advanceTimersByTimeAsync(15_000); expect(phones[0].stop).not.toHaveBeenCalled();
  });
});
