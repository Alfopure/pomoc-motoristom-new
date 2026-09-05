import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ executablePath: vi.fn(), launch: vi.fn() }));
vi.mock("@sparticuz/chromium", () => ({ default: { executablePath: mocks.executablePath, args: [] } }));
vi.mock("playwright-core", () => ({ chromium: { launch: mocks.launch } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetAllMocks(); vi.resetModules(); });
it("returns within its deadline if cold extraction never completes and never starts a late provider request", async () => {
  vi.useFakeTimers();
  mocks.executablePath.mockReturnValue(new Promise(() => {}));
  const { lookupSkp } = await import("./providers/skp-browser");
  const request = lookupSkp({ kind: "plate", value: "XX000XX", country: "SK", checkedForDate: "2026-09-05" }, Date.now() + 100);
  await vi.advanceTimersByTimeAsync(101);
  expect((await request).status).toBe("unavailable");
  expect(mocks.launch).not.toHaveBeenCalled();
});
it("does not prepare or reject an unused serverless executable when using a local Chrome override", async () => {
  vi.stubEnv("VEHICLE_LOOKUP_CHROME_PATH", "/test/chrome");
  mocks.launch.mockRejectedValue(new Error("test launch error"));
  const { lookupSkp } = await import("./providers/skp-browser");
  await lookupSkp({ kind: "plate", value: "XX000XX", country: "SK", checkedForDate: "2026-09-05" });
  expect(mocks.executablePath).not.toHaveBeenCalled();
});
