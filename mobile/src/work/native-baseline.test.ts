import { describe, expect, it, vi } from "vitest";
const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-image-picker", () => { loaded.count++; throw new Error("Missing native picker in older binary"); });
vi.mock("expo-file-system", () => { throw new Error("Missing native FileSystem"); });
vi.mock("expo-image-manipulator", () => { throw new Error("Missing native manipulator"); });
vi.mock("expo-document-picker", () => { throw new Error("Missing native document picker"); });
vi.mock("expo/fetch", () => { loaded.count++; throw new Error("Missing ExpoFetchModule"); });
describe("older native startup", () => {
  it("imports APIs and picker actions without loading missing native modules", async () => {
    const api = await import("./api"), pickers = await import("./pickers");
    expect(api.createWorkApi).toBeTypeOf("function"); expect(loaded.count).toBe(0);
    await expect(pickers.preparePhotoPicker()).rejects.toThrow("nie je dostupný");
    await expect(pickers.prepareDocumentPicker()).rejects.toThrow("nie je dostupný");
  });
});
