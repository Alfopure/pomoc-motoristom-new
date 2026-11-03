import { preparePhotoPicker } from "./pickers";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ bytes: new Uint8Array([255, 216, 255, 224]), size: 4, width: 4032, height: 3024, canceled: false, permission: true, cleanupFails: false, deleted: vi.fn(),
  resize: vi.fn(), save: vi.fn(), read: vi.fn(), launch: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-image-picker", () => ({ UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" }, requestCameraPermissionsAsync: async () => ({ granted: mock.permission }),
  launchCameraAsync: (...args: unknown[]) => { mock.launch(...args); return { canceled: mock.canceled, assets: [{ uri: "file://original.heic", fileName: "Žlté auto.HEIC" }] }; },
  launchImageLibraryAsync: (...args: unknown[]) => { mock.launch(...args); return { canceled: mock.canceled, assets: [{ uri: "file://original.heic", fileName: "Žlté auto.HEIC" }] }; } }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, ImageManipulator: { manipulate: () => {
  let width = mock.width, height = mock.height;
  const context = { resize: (size: { width: number; height: number }) => { mock.resize(size); width = size.width; height = size.height; return context; }, release: vi.fn(),
    renderAsync: async () => ({ width, height, release: vi.fn(), saveAsync: async (options: unknown) => { mock.save(options); return { uri: "file:///cache/ImageManipulator/12345678-1234-4234-8234-123456789abc.jpg", width, height }; } }) }; return context;
} } }));
vi.mock("expo-file-system", () => ({ Paths: { cache: { uri: "file:///cache/" } }, File: class { constructor(private uri: string) {} size = mock.size; bytes = async () => { mock.read(); return mock.bytes; }; delete() { mock.deleted(this.uri); if (mock.cleanupFails) throw new Error("cache unavailable"); } } }));
beforeEach(() => { mock.bytes = new Uint8Array([255, 216, 255, 224]); mock.size = 4; mock.canceled = false; mock.permission = true; mock.cleanupFails = false; vi.clearAllMocks(); });
describe("photo preparation", () => {
  it("requests compatible image, renders aspect-preserving JPEG then reads actual prepared bytes", async () => {
    const pick = await preparePhotoPicker(), result = await pick(false);
    expect(mock.launch).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ["images"], preferredAssetRepresentationMode: "compatible", base64: false }));
    expect(mock.resize).toHaveBeenCalledWith({ width: 2048, height: 1536 }); expect(mock.save).toHaveBeenCalledWith({ format: "jpeg", compress: 0.8 });
    expect(result).toMatchObject({ fileName: "Žlté auto.jpg", mimeType: "image/jpeg", bytes: mock.bytes });
  });
  it("preserves prepared bytes when cleanup of only the generated cache file fails", async () => {
    mock.cleanupFails = true;
    const file = await (await preparePhotoPicker())(false);
    expect(file?.bytes).toEqual(mock.bytes); expect(mock.deleted).toHaveBeenCalledExactlyOnceWith("file:///cache/ImageManipulator/12345678-1234-4234-8234-123456789abc.jpg");
  });
  it("rejects a renamed HEIC output instead of accepting its jpg suffix", async () => {
    mock.bytes = new TextEncoder().encode("HEIC"); await expect((await preparePhotoPicker())(false)).rejects.toThrow("JPEG");
  });
  it("bounds local compression attempts before any oversized byte read", async () => {
    mock.size = 3 * 1024 * 1024 + 1; await expect((await preparePhotoPicker())(false)).rejects.toThrow("príliš veľká");
    expect(mock.save).toHaveBeenCalledTimes(3); expect(mock.read).not.toHaveBeenCalled(); expect(mock.resize).toHaveBeenLastCalledWith({ width: 1536, height: 1152 });
  });
  it("separates user cancellation and denied camera permission", async () => {
    mock.canceled = true; expect(await (await preparePhotoPicker())(false)).toBeNull(); expect(mock.save).not.toHaveBeenCalled();
    mock.permission = false; await expect((await preparePhotoPicker())(true)).rejects.toThrow("Povoľte fotoaparát");
  });
});
