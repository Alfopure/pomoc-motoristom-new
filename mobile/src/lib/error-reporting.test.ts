import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileTransport } from "./api";

const m = vi.hoisted(() => ({ store: new Map<string, string>(), deleted: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0" } }));
vi.mock("./app-version", () => ({ appVersion: () => ({ version: "1.0.0", build: "3", preview: false }) }));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  setItem: (key: string, value: string) => { m.store.set(key, value); }, getItem: (key: string) => m.store.get(key) ?? null,
  deleteItemAsync: async (key: string) => { m.deleted(key); m.store.delete(key); } }));
const { createErrorReporter, installGlobalErrorReporting } = await import("./error-reporting");
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { m.store.clear(); m.deleted.mockReset(); });

describe("app error reports", () => {
  it("sends a masked report for the signed-in operator only", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(new Response(null, { status: 200 }));
    createErrorReporter(config, async () => "token", transport).report("render", new TypeError("x pre +421 905 123 456 a BA123AB"), "in Shell");
    await flush();
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/diagnostics/errors");
    expect(JSON.parse(String(init?.body))).toMatchObject({ kind: "render", message: "TypeError: x pre [číslo] a [EČV]", component: "in Shell", version: "1.0.0", build: "3", platform: "ios", osVersion: "26.0", preview: false });
    const anonymous = vi.fn<MobileTransport>();
    createErrorReporter(config, async () => null, anonymous).report("error", new Error("x")); await flush();
    expect(anonymous).not.toHaveBeenCalled();
  });
  it("limits a burst and survives a failing network", async () => {
    const transport = vi.fn<MobileTransport>().mockRejectedValue(new TypeError("offline"));
    const reporter = createErrorReporter(config, async () => "token", transport);
    for (let index = 0; index < 9; index++) reporter.report("error", new Error("again"));
    await flush();
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it("keeps a fatal error on the device and sends it after the next sign-in", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(new Response(null, { status: 200 }));
    let token: string | null = null;
    const reporter = createErrorReporter(config, async () => token, transport);
    reporter.keep(new Error("pád pri jan@example.sk"));
    expect(JSON.parse(m.store.get("pm-kept-error-v1")!)).toMatchObject({ kind: "fatal", message: "Error: pád pri [e-mail]" });
    await reporter.flushKept();
    expect(transport).not.toHaveBeenCalled(); expect(m.store.has("pm-kept-error-v1")).toBe(true);
    token = "token"; await reporter.flushKept();
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({ kind: "fatal" });
    expect(m.store.has("pm-kept-error-v1")).toBe(false);
  });
  it("keeps fatal errors, reports others and always hands them to React Native", () => {
    const previous = vi.fn(), handlers: ((error: unknown, fatal?: boolean) => void)[] = [previous];
    (globalThis as unknown as { ErrorUtils: unknown }).ErrorUtils = { getGlobalHandler: () => handlers.at(-1), setGlobalHandler: (handler: (error: unknown, fatal?: boolean) => void) => handlers.push(handler) };
    const reporter = { report: vi.fn(), keep: vi.fn(() => { throw new Error("storage"); }), flushKept: vi.fn() };
    const uninstall = installGlobalErrorReporting(reporter);
    const error = new Error("boom");
    handlers.at(-1)!(error, true);
    expect(reporter.keep).toHaveBeenCalledWith(error); expect(previous).toHaveBeenCalledWith(error, true);
    handlers.at(-1)!(error, false);
    expect(reporter.report).toHaveBeenCalledWith("error", error); expect(previous).toHaveBeenCalledTimes(2);
    uninstall(); expect(handlers.at(-1)).toBe(previous);
  });
});
