import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as appStatus } from "@/app/api/mobile/v1/app-status/route";
import { logAppError, readAppErrorReport, readAppStatus, scrubDiagnostic } from "./app-status";

vi.mock("./auth", () => ({ mobileEnvironment: () => "test", requireMobileActor: vi.fn() }));
afterEach(() => vi.unstubAllEnvs());
const report = { kind: "fatal", message: "TypeError: x is undefined", stack: "at App\nat Shell", component: null, version: "1.0.0", build: "12", platform: "ios", osVersion: "26.0", preview: false };

describe("mobile release gate", () => {
  it("names a minimum only when it is a plain version", () => {
    expect(readAppStatus({})).toEqual({ ok: true, apiVersion: 1, environment: "test", minimumVersion: null, updateUrl: null });
    expect(readAppStatus({ MOBILE_MINIMUM_APP_VERSION: " 1.2.0 ", MOBILE_UPDATE_URL: "https://apps.apple.com/app/id1" })).toMatchObject({ minimumVersion: "1.2.0", updateUrl: "https://apps.apple.com/app/id1" });
    for (const minimum of ["1.0.0-beta", "latest", "1..0", "99999.0"]) expect(readAppStatus({ MOBILE_MINIMUM_APP_VERSION: minimum }).minimumVersion).toBeNull();
    for (const url of ["http://example.com", "javascript:alert(1)", "not a url"]) expect(readAppStatus({ MOBILE_UPDATE_URL: url }).updateUrl).toBeNull();
  });
  it("answers without a sign-in and is never cached", async () => {
    vi.stubEnv("MOBILE_MINIMUM_APP_VERSION", "1.0.1");
    const response = await appStatus();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, minimumVersion: "1.0.1" });
  });
});

describe("mobile error reports", () => {
  it("masks phone numbers and e-mail addresses", () => {
    expect(scrubDiagnostic("Volajúci +421 905 123 456 / jan.novak@example.sk")).toBe("Volajúci [číslo] / [e-mail]");
    expect(scrubDiagnostic("case 00000000-0000-4000-8000-000000000001 failed")).toContain("00000000-0000-4000-8000-000000000001");
  });
  it("accepts a bounded report and trims long stacks", () => {
    const parsed = readAppErrorReport({ ...report, message: "Chyba pri 0905123456", stack: Array.from({ length: 40 }, (_, i) => "at frame" + i).join("\n") });
    expect(parsed.message).toBe("Chyba pri [číslo]");
    expect(parsed.stack?.split("\n")).toHaveLength(25);
  });
  it.each([null, [], { ...report, extra: 1 }, { ...report, kind: "warn" }, { ...report, message: "x".repeat(1001) }, { ...report, version: "1.0.0-beta" },
    { ...report, platform: "web" }, { ...report, preview: "no" }, { ...report, build: "12 34" }, { ...report, stack: 7 }])("refuses a malformed report %#", value => {
    expect(() => readAppErrorReport(value)).toThrow();
  });
  it("logs one structured line for the signed-in operator", () => {
    const log = vi.fn();
    logAppError({ userId: "u", profileId: "p", organizationId: "o", displayName: "D", role: "dispatcher" }, readAppErrorReport(report), log);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: "mobile.app_error", environment: "test", organizationId: "o", profileId: "p", kind: "fatal", version: "1.0.0" });
  });
});
