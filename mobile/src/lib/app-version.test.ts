import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ environment: "standalone", version: "1.2.0" as string | null, build: "7" as string | null }));
vi.mock("expo-constants", () => ({ default: { get executionEnvironment() { return m.environment; }, expoConfig: { version: "0.9.0" } }, ExecutionEnvironment: { StoreClient: "storeClient" } }));
vi.mock("expo-application", () => ({ get nativeApplicationVersion() { return m.version; }, get nativeBuildVersion() { return m.build; } }));
const { appVersion, olderThan, versionLabel } = await import("./app-version");

describe("app version", () => {
  it("reads the binary, or the project in Expo Go", () => {
    expect(appVersion()).toEqual({ version: "1.2.0", build: "7", preview: false });
    m.environment = "storeClient";
    expect(appVersion()).toEqual({ version: "0.9.0", build: null, preview: true });
    m.environment = "standalone"; m.version = null; m.build = null;
    expect(appVersion()).toEqual({ version: "0.9.0", build: null, preview: false });
  });
  it("labels the version for Účet", () => {
    expect(versionLabel({ version: "1.0.0", build: "12", preview: false })).toBe("1.0.0 (12)");
    expect(versionLabel({ version: "0.1.0", build: null, preview: true })).toBe("0.1.0 · náhľad v Expo Go");
  });
  it("compares dotted versions and never blocks on a malformed one", () => {
    expect(olderThan("1.0.0", "1.0.1")).toBe(true);
    expect(olderThan("1.10.0", "1.9.9")).toBe(false);
    expect(olderThan("1.2", "1.2.0")).toBe(false);
    expect(olderThan("2.0.0", "10.0.0")).toBe(true);
    for (const [current, minimum] of [["1.0.0-beta", "2.0.0"], ["1.0.0", "latest"], ["", "1.0.0"]]) expect(olderThan(current, minimum)).toBe(false);
  });
});
