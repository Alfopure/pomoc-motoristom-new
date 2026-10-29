import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ platform: { OS: "ios" }, phone: vi.fn<() => object | null>() }));
vi.mock("react-native", () => ({ Platform: m.platform }));
vi.mock("./native", () => ({ nativePhone: m.phone }));
const { probeNativeVoiceBindings, takeNativeVoiceProbeFailure } = await import("./probe");
afterEach(() => { m.platform.OS = "ios"; m.phone.mockReset(); takeNativeVoiceProbeFailure(); });

describe("boot-time native voice proof", () => {
  it("passes when the native CallKit phone is available, in both modes", () => {
    m.phone.mockReturnValue({});
    expect(probeNativeVoiceBindings()).toBe(true);
    expect(probeNativeVoiceBindings(false)).toBe(true);
    expect(takeNativeVoiceProbeFailure()).toBeNull();
  });
  it("TEST: still fails at boot without the native phone or off iPhone", () => {
    m.phone.mockReturnValue(null);
    expect(() => probeNativeVoiceBindings()).toThrow("Native CallKit phone is unavailable");
    m.platform.OS = "android";
    expect(() => probeNativeVoiceBindings(true)).toThrow("This voice pilot requires an iPhone build");
    expect(takeNativeVoiceProbeFailure()).toBeNull();
  });
  it("production: keeps running without calling and hands the failure to the error report once", () => {
    m.phone.mockReturnValue(null);
    expect(probeNativeVoiceBindings(false)).toBe(false);
    expect(takeNativeVoiceProbeFailure()?.message).toBe("Native CallKit phone is unavailable");
    expect(takeNativeVoiceProbeFailure()).toBeNull();
  });
});
