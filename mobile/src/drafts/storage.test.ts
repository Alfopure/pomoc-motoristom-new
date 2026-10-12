import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../lib/session-storage";
import { draftStorageKey, type DraftScope } from "./vault";
import { draftStorage } from "./storage";
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "mock-generation" }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));

const scope: DraftScope = { environment: "test", projectUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", userId: "00000000-0000-4000-8000-000000000001", profileId: "00000000-0000-4000-8000-000000000002", organizationId: "00000000-0000-4000-8000-000000000003" };
describe("native draft storage capabilities", () => {
  it.each(["ios", "android"])("uses chunk authority for supported %s storage", async platform => {
    const secure = memoryStorage(), result = draftStorage(scope, { platform, checkedAndroidCommit: true, secure, uuid: () => "generation" }), key = draftStorageKey(scope);
    expect(result.durable).toBe(true); await result.storage.setItem(key, "private".repeat(200));
    expect(JSON.parse((await secure.getItem(key))!).count).toBeGreaterThan(1);
    expect(await result.storage.getItem(key)).toBe("private".repeat(200));
  });
  it("unsupported Android refuses to downgrade an existing durable authority", async () => {
    const secure = memoryStorage(), key = draftStorageKey(scope); await secure.setItem(key, '{"generation":"old","count":1}');
    const result = draftStorage(scope, { platform: "android", checkedAndroidCommit: false, secure, uuid: () => "new" });
    expect(result.durable).toBe(false); await expect(result.storage.getItem(key)).rejects.toThrow(); await expect(result.storage.setItem(key, "overwrite")).rejects.toThrow();
    expect(await secure.getItem(key)).toContain("old");
    await result.storage.removeItem(key); expect(await result.storage.getItem(key)).toBeNull();
  });
  it("old Android Go keeps new text only in memory and makes no encrypted write", async () => {
    const secure = { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) };
    const result = draftStorage(scope, { platform: "android", checkedAndroidCommit: false, secure, uuid: () => "new" }), key = draftStorageKey({ ...scope, userId: "00000000-0000-4000-8000-000000000099" });
    expect(result.durable).toBe(false); await result.storage.setItem(key, "volatile"); expect(await result.storage.getItem(key)).toBe("volatile"); expect(secure.setItem).not.toHaveBeenCalled();
  });
  it("browser drafts never access native or plaintext disk persistence", async () => {
    const secure = { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) };
    const result = draftStorage(scope, { platform: "web", checkedAndroidCommit: false, secure, uuid: () => "new" });
    await result.storage.setItem("browser-only", "text"); expect(await result.storage.getItem("browser-only")).toBe("text"); expect(result.durable).toBe(false); expect(secure.getItem).not.toHaveBeenCalled(); expect(secure.setItem).not.toHaveBeenCalled();
  });
});
