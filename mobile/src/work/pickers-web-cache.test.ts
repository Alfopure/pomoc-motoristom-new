import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDocumentPicker, preparePhotoPicker } from "./pickers";
const state = vi.hoisted(() => ({ canceled: false, failure: "", uri: "blob:document", release: vi.fn(), bytes: new Uint8Array([255,216,255,224]), fetch: vi.fn(), revoke: vi.fn(), read: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("expo-file-system", () => ({ File: class { constructor() { throw new Error("Native File forbidden on web"); } } }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: async () => ({ canceled: state.canceled, assets: [{ uri: state.uri, name: "photo.jpg", file: {
  get size() { return state.failure === "size" ? 4 * 1024 * 1024 : 4; }, arrayBuffer: async () => { state.read(); if (state.failure === "read") throw new Error("read"); return state.bytes.buffer; },
} }] }) }));
vi.mock("expo-image-picker", () => ({ UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" }, launchImageLibraryAsync: async () => ({ canceled: state.canceled, assets: [{ uri: "blob:selected", fileName: "photo.png" }] }) }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, ImageManipulator: { manipulate: (source: unknown) => {
  const name = typeof source === "string" ? "original" : "context";
  const context = { resize: () => context, release: () => state.release(name), renderAsync: async () => {
    if (state.failure === "render") throw new Error("render");
    return { uri: `blob:${name}-image`, width: 1000, height: 1000, release: () => state.release(`${name}-image`), saveAsync: async () => ({ uri: "blob:saved", width: state.failure === "dimensions" ? 0 : 1000, height: 1000 }) };
  } }; return context;
} } }));
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(state, { canceled: false, failure: "", uri: "blob:document", bytes: new Uint8Array([255,216,255,224]) });
  state.fetch.mockImplementation(async () => { if (state.failure === "fetch") throw new Error("fetch"); return { arrayBuffer: async () => state.bytes.buffer }; });
  vi.stubGlobal("fetch", state.fetch);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(state.revoke);
});
describe("web object URL ownership", () => {
  it("releases generated document URL after actual File bytes are read", async () => {
    const file = await (await prepareDocumentPicker())();
    expect(file?.bytes).toEqual(state.bytes); expect(state.read).toHaveBeenCalledOnce(); expect(state.revoke).toHaveBeenCalledExactlyOnceWith("blob:document");
  });
  it.each(["read", "size", "validation"])("releases document URL on %s failure", async (failure) => {
    state.failure = failure; if (failure === "validation") state.bytes = new Uint8Array([0]);
    await expect((await prepareDocumentPicker())()).rejects.toThrow(); expect(state.revoke).toHaveBeenCalledWith("blob:document");
  });
  it.each(["data:image/png;base64,AQ==", "https://example.com/image", "file:///original"])("does not revoke non-object URI %s", async (uri) => {
    state.uri = uri; await (await prepareDocumentPicker())(); expect(state.revoke).not.toHaveBeenCalled();
  });
  it.each(["", "fetch", "dimensions"])("releases selected, rendered and saved object URLs after %s", async (failure) => {
    state.failure = failure; const promise = (await preparePhotoPicker())(false);
    if (failure) await expect(promise).rejects.toThrow(); else expect((await promise)?.bytes).toEqual(state.bytes);
    expect(state.revoke.mock.calls.flat()).toEqual(["blob:saved", "blob:context-image", "blob:original-image", "blob:selected"]);
    expect(state.release).toHaveBeenCalledTimes(4);
  });
  it("releases the selected object URL and acquired context after render failure", async () => {
    state.failure = "render"; await expect((await preparePhotoPicker())(false)).rejects.toThrow("render");
    expect(state.revoke.mock.calls.flat()).toEqual(["blob:selected"]); expect(state.release).toHaveBeenCalledExactlyOnceWith("original");
  });
  it("does not acquire or dispose assets on cancellation", async () => {
    state.canceled = true; expect(await (await preparePhotoPicker())(false)).toBeNull(); expect(await (await prepareDocumentPicker())()).toBeNull();
    expect(state.revoke).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
  });
  it("preserves captured bytes when URL revocation throws", async () => {
    state.revoke.mockImplementationOnce(() => { throw new Error("revoke"); });
    expect((await (await prepareDocumentPicker())())?.bytes).toEqual(state.bytes);
  });
});
