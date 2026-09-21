import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserIncomingRingtone } from "./browser-ringtone";

afterEach(() => vi.unstubAllGlobals());

describe("BrowserIncomingRingtone", () => {
  it("reports unavailable/blocked audio without claiming a sound started", async () => {
    vi.stubGlobal("AudioContext", undefined);
    const ringtone = new BrowserIncomingRingtone();
    expect(await ringtone.unlock()).toBe(false);
    expect(await ringtone.start()).toBe(false);
  });

  it("does not start late audio when stop happens during AudioContext resume", async () => {
    let resume!: () => void;
    const source = { start: vi.fn(), connect: vi.fn() };
    const context = { state: "running", resume: vi.fn(() => new Promise<void>(resolve => { resume = resolve; })), createBufferSource: vi.fn(() => source) };
    vi.stubGlobal("AudioContext", class { constructor() { return context; } });
    const ringtone = new BrowserIncomingRingtone();
    expect(await ringtone.unlock()).toBe(true);
    context.state = "suspended";
    const pending = ringtone.start();
    ringtone.stop();
    context.state = "running";
    resume();
    expect(await pending).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
  });
});
