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
    vi.stubGlobal("window", { AudioContext: class { constructor() { return context; } } });
    vi.stubGlobal("document", { visibilityState: "visible" });
    return { context, oscillator, resume: () => resume(), reject: () => reject(new Error("audio unavailable")) };
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
});
