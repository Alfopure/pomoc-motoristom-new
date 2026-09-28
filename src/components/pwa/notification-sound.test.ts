import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notification sound readiness", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  function audio(state = "suspended") {
    let resume: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const oscillator = { type: "", frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const context = {
      state, currentTime: 0, destination: {},
      resume: vi.fn(() => new Promise<void>((resolve, fail) => { resume = () => { context.state = "running"; resolve(); }; reject = fail; })),
      createOscillator: vi.fn(() => oscillator),
      createGain: () => ({ gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() }),
    };
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      AudioContext: class { constructor() { return context; } },
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    });
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, run: () => boolean) => run() } });
    return { context, oscillator, storage, resume: () => resume(), reject: () => reject(new Error("audio unavailable")) };
  }

  it("waits for a slow resume before scheduling preview audio", async () => {
    const h = audio();
    const { previewNotificationSound } = await import("./notification-sound");
    const preview = previewNotificationSound();
    expect(h.context.resume).toHaveBeenCalledOnce();
    expect(h.context.createOscillator).not.toHaveBeenCalled();
    h.resume();
    await expect(preview).resolves.toBe(true);
    expect(h.context.createOscillator).toHaveBeenCalledTimes(2);
    expect(h.oscillator.start).toHaveBeenCalledTimes(2);
  });

  it("does not claim a preview started when resume fails", async () => {
    const h = audio();
    const { previewNotificationSound } = await import("./notification-sound");
    const preview = previewNotificationSound();
    h.reject();
    await expect(preview).resolves.toBe(false);
    expect(h.context.createOscillator).not.toHaveBeenCalled();
  });

  it("resumes an interrupted mobile context too", async () => {
    const h = audio("interrupted");
    const { previewNotificationSound } = await import("./notification-sound");
    const preview = previewNotificationSound();
    expect(h.context.resume).toHaveBeenCalledOnce();
    h.resume();
    await expect(preview).resolves.toBe(true);
  });

  it("plays one distinct waiting-room cue and remembers the session across tabs or refreshes", async () => {
    const h = audio("running");
    const sound = await import("./notification-sound");
    await sound.unlockNotificationSound();
    await expect(sound.playWaitingRoomChimeOnce("waiting-1")).resolves.toBe(true);
    await expect(sound.playWaitingRoomChimeOnce("waiting-1")).resolves.toBe(false);
    expect(h.context.createOscillator).toHaveBeenCalledTimes(2);

    vi.resetModules();
    const secondTab = await import("./notification-sound");
    await secondTab.unlockNotificationSound();
    await expect(secondTab.playWaitingRoomChimeOnce("waiting-1")).resolves.toBe(false);
    expect(h.context.createOscillator).toHaveBeenCalledTimes(2);
  });

  it("does not add a queue cue when native available-call push owns the sound", async () => {
    const h = audio("running");
    const sound = await import("./notification-sound");
    await sound.unlockNotificationSound();
    sound.setNativeAvailableCallPushActive(true);
    await expect(sound.playWaitingRoomChimeOnce("waiting-2")).resolves.toBe(false);
    expect(h.context.createOscillator).not.toHaveBeenCalled();
  });

  it("keeps the queue cue when an older subscription cannot deliver call push", async () => {
    const h = audio("running");
    const sound = await import("./notification-sound");
    await sound.unlockNotificationSound();
    const legacyPush = { configured: true, callNotificationsConfigured: false, subscribed: true, availableCallsEnabled: true };
    sound.setNativeAvailableCallPushActive(sound.hasNativeAvailableCallPush(legacyPush));
    await expect(sound.playWaitingRoomChimeOnce("waiting-legacy-push")).resolves.toBe(true);
    expect(sound.hasNativeAvailableCallPush({ ...legacyPush, callNotificationsConfigured: true })).toBe(true);
    expect(sound.hasNativeAvailableCallPush({ ...legacyPush, configured: false, callNotificationsConfigured: true })).toBe(false);
    expect(h.context.createOscillator).toHaveBeenCalledTimes(2);
  });

  it("respects the saved sound setting for the waiting room", async () => {
    const h = audio("running");
    h.storage.set("pm:notification-sound:v1", "off");
    const sound = await import("./notification-sound");
    await sound.unlockNotificationSound();
    await expect(sound.playWaitingRoomChimeOnce("waiting-3")).resolves.toBe(false);
    expect(h.context.createOscillator).not.toHaveBeenCalled();
  });
});
