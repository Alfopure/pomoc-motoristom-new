import { describe, expect, it, vi } from "vitest";
import type * as ExpoLocation from "expo-location";
import { prepareDeviceLocation } from "./device-location-adapter";

type Module = Pick<typeof ExpoLocation, "Accuracy" | "requestForegroundPermissionsAsync" | "hasServicesEnabledAsync" | "watchPositionAsync">;
function nativeModule() {
  return {
    Accuracy: { High: 4 } as Module["Accuracy"],
    requestForegroundPermissionsAsync: vi.fn(async () => ({ granted: true, status: "granted", canAskAgain: true, expires: "never" })),
    hasServicesEnabledAsync: vi.fn(async () => true),
    watchPositionAsync: vi.fn(async () => ({ remove: vi.fn() })),
  };
}
describe("optional foreground location adapter", () => {
  it.each([["ios", false], ["android", false], ["web", true]])("never imports unavailable module on %s, available=%s", async (platform, available) => {
    const load = vi.fn(); await expect(prepareDeviceLocation(platform as string, available as boolean, load)).rejects.toThrow(); expect(load).not.toHaveBeenCalled();
  });
  it("uses only foreground permission and a bounded foreground watch without a settings prompt", async () => {
    const module = nativeModule(), load = vi.fn(async () => module as unknown as Module);
    const adapter = await prepareDeviceLocation("ios", true, load);
    expect(module.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(await adapter.permission()).toEqual({ granted: true, canAskAgain: true }); expect(await adapter.services()).toBe(true);
    const receive = vi.fn(), failed = vi.fn(); await adapter.watch(receive, failed);
    expect(module.watchPositionAsync).toHaveBeenCalledWith({ accuracy: 4, timeInterval: 1000, distanceInterval: 0, mayShowUserSettingsDialog: false }, receive, failed);
  });
  it("does not treat inconsistent native permission fields as granted", async () => {
    const module = nativeModule(); module.requestForegroundPermissionsAsync.mockResolvedValue({ granted: true, status: "denied", canAskAgain: false, expires: "never" });
    const adapter = await prepareDeviceLocation("android", true, async () => module as unknown as Module);
    expect(await adapter.permission()).toEqual({ granted: false, canAskAgain: false });
  });
});
