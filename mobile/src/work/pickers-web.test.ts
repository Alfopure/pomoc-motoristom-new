import { describe, expect, it, vi } from "vitest";
import { preparePhotoPicker } from "./pickers";
const native = vi.hoisted(() => ({ saves: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("expo-image-picker", () => ({ UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" }, launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ uri: "blob:original", fileName: "foto.png" }] }) }));
vi.mock("expo-file-system", () => ({ File: class { constructor() { throw new Error("Web must not construct native File"); } } }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, ImageManipulator: { manipulate: () => {
  const context = { resize: () => context, release: vi.fn(), renderAsync: async () => ({ width: 1000, height: 1000, release: vi.fn(), saveAsync: async (options: unknown) => { native.saves(options); return { uri: "blob:prepared", width: 1000, height: 1000 }; } }) }; return context;
} } }));
describe("web photo compression", () => {
  it("tries the bounded second encoding when the first actual JPEG exceeds 3MiB", async () => {
    const huge = new Uint8Array(3 * 1024 * 1024 + 1); huge.set([255,216,255]);
    const fetchMock = vi.fn().mockResolvedValueOnce({ arrayBuffer: async () => huge.buffer }).mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([255,216,255,224]).buffer });
    vi.stubGlobal("fetch", fetchMock);
    try { const file = await (await preparePhotoPicker())(false); expect(file?.bytes.length).toBe(4); expect(native.saves).toHaveBeenNthCalledWith(2, { format: "jpeg", compress: 0.6 }); }
    finally { vi.unstubAllGlobals(); }
  });
});
