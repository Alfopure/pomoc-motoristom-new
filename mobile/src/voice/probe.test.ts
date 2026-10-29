import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileTransport } from "../lib/api";

const m = vi.hoisted(() => ({ platform: { OS: "ios" }, phone: vi.fn<() => object | null>(), store: new Map<string, string>() }));
vi.mock("react-native", () => ({ Platform: m.platform }));
vi.mock("./native", () => ({ nativePhone: m.phone }));
vi.mock("../lib/app-version", () => ({ appVersion: () => ({ version: "1.0.0", build: "3", preview: false }) }));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  setItem: (key: string, value: string) => { m.store.set(key, value); }, getItem: (key: string) => m.store.get(key) ?? null,
  deleteItemAsync: async (key: string) => { m.store.delete(key); } }));
const { flushKeptWithProbeFailure, probeNativeVoiceBindings, takeNativeVoiceProbeFailure } = await import("./probe");
const { createErrorReporter } = await import("../lib/error-reporting");
const config = { environment: "production" as const, apiOrigin: "https://dispecing.linkapomoci.sk", supabaseUrl: "https://ifpaeegaesdmljfkdvcn.supabase.co", publishableKey: "fixture" };
const signedIn = (transport: MobileTransport) => { const reporter = createErrorReporter(config, async () => "token", transport); reporter.setUser("operator"); return reporter; };
const sentMessages = (transport: ReturnType<typeof vi.fn<MobileTransport>>) => transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).message);
afterEach(() => { m.platform.OS = "ios"; m.phone.mockReset(); m.store.clear(); takeNativeVoiceProbeFailure(); });

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
  it("production: keeps running without calling and hands the failure over once", () => {
    m.phone.mockReturnValue(null);
    expect(probeNativeVoiceBindings(false)).toBe(false);
    expect(takeNativeVoiceProbeFailure()?.message).toBe("Native CallKit phone is unavailable");
    expect(takeNativeVoiceProbeFailure()).toBeNull();
  });
  it("production: an offline sign-in keeps the failure on the device until a later sign-in sends it", async () => {
    m.phone.mockReturnValue(null); probeNativeVoiceBindings(false);
    const offline = vi.fn<MobileTransport>().mockRejectedValue(new TypeError("offline"));
    await flushKeptWithProbeFailure(signedIn(offline));
    expect(offline).toHaveBeenCalledTimes(1); expect(m.store.size).toBe(1);
    const online = vi.fn<MobileTransport>().mockResolvedValue(new Response(null, { status: 200 }));
    await flushKeptWithProbeFailure(signedIn(online));
    expect(sentMessages(online)).toEqual(["Error: Native CallKit phone is unavailable"]); expect(m.store.size).toBe(0);
  });
  it("sends an earlier kept crash before keeping the probe failure", async () => {
    const online = vi.fn<MobileTransport>().mockResolvedValue(new Response(null, { status: 200 }));
    const reporter = signedIn(online); reporter.keep(new Error("earlier crash"));
    m.phone.mockReturnValue(null); probeNativeVoiceBindings(false);
    await flushKeptWithProbeFailure(reporter);
    expect(sentMessages(online)).toEqual(["Error: earlier crash", "Error: Native CallKit phone is unavailable"]); expect(m.store.size).toBe(0);
  });
});
