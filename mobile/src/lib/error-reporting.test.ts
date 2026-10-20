import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileTransport } from "./api";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0" } }));
vi.mock("./app-version", () => ({ appVersion: () => ({ version: "1.0.0", build: "3", preview: false }) }));
const { createErrorReporter, installGlobalErrorReporting } = await import("./error-reporting");
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { vi.useRealTimers(); });

describe("app error reports", () => {
  it("sends a bounded report for the signed-in operator only", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(new Response(null, { status: 200 }));
    createErrorReporter(config, async () => "token", transport)("render", new TypeError("x is undefined"), "in Shell");
    await flush();
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/diagnostics/errors");
    expect(JSON.parse(String(init?.body))).toMatchObject({ kind: "render", message: "TypeError: x is undefined", component: "in Shell", version: "1.0.0", build: "3", platform: "ios", osVersion: "26.0", preview: false });
    const anonymous = vi.fn<MobileTransport>();
    createErrorReporter(config, async () => null, anonymous)("error", new Error("x")); await flush();
    expect(anonymous).not.toHaveBeenCalled();
  });
  it("limits a burst and survives a failing network", async () => {
    const transport = vi.fn<MobileTransport>().mockRejectedValue(new TypeError("offline"));
    const report = createErrorReporter(config, async () => "token", transport);
    for (let index = 0; index < 9; index++) report("error", new Error("again"));
    await flush();
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it("reports uncaught errors and still hands them to React Native", () => {
    const previous = vi.fn(), handlers: ((error: unknown, fatal?: boolean) => void)[] = [previous];
    (globalThis as unknown as { ErrorUtils: unknown }).ErrorUtils = { getGlobalHandler: () => handlers.at(-1), setGlobalHandler: (handler: (error: unknown, fatal?: boolean) => void) => handlers.push(handler) };
    const report = vi.fn();
    const uninstall = installGlobalErrorReporting(report);
    const error = new Error("boom");
    handlers.at(-1)!(error, true);
    expect(report).toHaveBeenCalledWith("fatal", error); expect(previous).toHaveBeenCalledWith(error, true);
    uninstall(); expect(handlers.at(-1)).toBe(previous);
  });
});
