import { beforeEach, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
beforeEach(() => { vi.resetModules(); });
it.each(["document", "image", "manipulator", "files"])("keeps old-native %s module failure inside the explicit chooser boundary", async (module) => {
  const mockModule = (name: string) => {
    if (module === name) throw new Error("native module unavailable");
    return {};
  };
  vi.doMock("expo-document-picker", () => mockModule("document"));
  vi.doMock("expo-image-picker", () => mockModule("image"));
  vi.doMock("expo-image-manipulator", () => mockModule("manipulator"));
  vi.doMock("expo-file-system", () => mockModule("files"));
  const pickers = await import("./pickers");
  // Merely loading work screens must remain safe on older native binaries.
  expect(pickers.preparePhotoPicker).toBeTypeOf("function");
  const prepare = module === "document" ? pickers.prepareDocumentPicker : pickers.preparePhotoPicker;
  await expect(prepare()).rejects.toThrow("aktuálnu aplikáciu Expo Go alebo novú natívnu zostavu");
});
