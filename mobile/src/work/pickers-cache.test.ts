import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDocumentPicker, preparePhotoPicker } from "./pickers";
import { AttachmentDraft, MAX_BYTES } from "./attachments";
const state = vi.hoisted(() => ({
  os: "ios", cache: "file:///app/cache/", source: "", output: "", canceled: false,
  bytes: new Uint8Array([255, 216, 255, 224]), size: 4, width: 1000,
  failure: "", cleanupFails: false, releaseFails: false,
  deleted: vi.fn(), read: vi.fn(), released: vi.fn(), constructed: vi.fn(),
}));
const id = "12345678-1234-4234-8234-123456789abc";
const documentUri = `file:///app/cache/DocumentPicker/${id}.pdf`;
const photoUri = `file:///app/cache/ImagePicker/${id}.heic`;
const outputUri = `file:///app/cache/ImageManipulator/${id}.jpg`;
vi.mock("react-native", () => ({ Platform: { get OS() { return state.os; } } }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: async () => ({ canceled: state.canceled, assets: [{ uri: state.source, name: "photo.jpg" }] }) }));
vi.mock("expo-image-picker", () => ({ UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: async () => ({ canceled: state.canceled, assets: [{ uri: state.source, fileName: "photo.heic" }] }) }));
vi.mock("expo-file-system", () => ({ Paths: { get cache() { return { uri: state.cache }; } }, File: class {
  constructor(private uri: string) { state.constructed(uri); if (state.failure === "constructor" && state.constructed.mock.calls.length === 1) throw new Error("constructor"); }
  get size() { if (state.failure === "size") throw new Error("size"); return state.size; }
  async bytes() { state.read(this.uri); if (state.failure === "read") throw new Error("read"); return state.bytes; }
  delete() { state.deleted(this.uri); if (state.cleanupFails) throw new Error("delete"); }
} }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, ImageManipulator: { manipulate: (source: unknown) => {
  const name = typeof source === "string" ? "original" : "context";
  if (state.failure === `${name}-constructor`) throw new Error(state.failure);
  const release = (key: string) => { state.released(key); if (state.releaseFails) throw new Error("release"); };
  const context = {
    resize: () => { if (state.failure === "resize") throw new Error("resize"); return context; },
    release: () => release(name),
    renderAsync: async () => {
      if (state.failure === `${name}-render`) throw new Error(state.failure);
      return { width: 1000, height: 1000, release: () => release(`${name}-image`), saveAsync: async () => {
        if (state.failure === "save") throw new Error("save");
        return { uri: state.output, width: state.width, height: 1000 };
      } };
    },
  }; return context;
} } }));
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(state, { os: "ios", cache: "file:///app/cache/", source: documentUri, output: outputUri, canceled: false,
    bytes: new Uint8Array([255, 216, 255, 224]), size: 4, width: 1000, failure: "", cleanupFails: false, releaseFails: false });
});
describe("native picker cache ownership", () => {
  it.each(["ios", "android"])("deletes the %s document copy after capturing bytes", async (os) => {
    state.os = os;
    const file = await (await prepareDocumentPicker())();
    expect(file?.bytes).toEqual(state.bytes); expect(state.deleted).toHaveBeenCalledExactlyOnceWith(documentUri);
  });
  it.each(["constructor", "size", "read", "invalid", "oversize"])("cleans the document on %s failure", async (failure) => {
    state.failure = failure;
    if (failure === "invalid") state.bytes = new Uint8Array([0]);
    if (failure === "oversize") state.size = MAX_BYTES + 1;
    await expect((await prepareDocumentPicker())()).rejects.toThrow();
    expect(state.deleted).toHaveBeenCalledExactlyOnceWith(documentUri);
  });
  it.each([
    "file:///gallery/photo.jpg", "content://provider/photo", "ph://photo", "https://host/photo", "file://host/app/cache/DocumentPicker/photo.jpg",
    `file:///app/cache-other/DocumentPicker/${id}.jpg`, `file:///app/cache/DocumentPicker/../${id}.jpg`,
    `file:///app/cache/DocumentPicker/%2e%2e/${id}.jpg`, `file:///app/cache/DocumentPicker/%2f${id}.jpg`,
    `file:///app/cache/DocumentPicker/%252e%252e/${id}.jpg`, `file:///app/cache/DocumentPicker/${id}.jpg?x=1`,
    "file:///app/cache/DocumentPicker/", `file:///app/cache/${id}.jpg`, `file:///app/cache/ImagePicker/${id}.jpg`,
  ])("never deletes an unowned document URI %s", async (uri) => {
    state.source = uri; await (await prepareDocumentPicker())(); expect(state.deleted).not.toHaveBeenCalled();
  });
  it("cleans the installed UUID-dot filename for a document with no extension", async () => {
    state.source = `file:///app/cache/DocumentPicker/${id}.`;
    await (await prepareDocumentPicker())(); expect(state.deleted).toHaveBeenCalledWith(state.source);
  });
  it("keeps prepared document bytes when deletion fails and replays without reading the URI", async () => {
    state.cleanupFails = true;
    const file = await (await prepareDocumentPicker())();
    const upload = vi.fn().mockRejectedValue(new Error("offline"));
    const draft = new AttachmentDraft({ upload }, "case", () => id);
    draft.select(file!); await draft.save("revision"); await draft.reconcile();
    expect(state.read).toHaveBeenCalledTimes(1); expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]).toEqual(upload.mock.calls[0]);
  });
  it("does no file work on cancellation", async () => {
    state.canceled = true;
    expect(await (await prepareDocumentPicker())()).toBeNull();
    expect(await (await preparePhotoPicker())(false)).toBeNull();
    expect(state.constructed).not.toHaveBeenCalled(); expect(state.deleted).not.toHaveBeenCalled();
  });
});
describe("photo native resource lifetimes", () => {
  beforeEach(() => { state.source = photoUri; });
  it.each(["ios", "android"])("cleans %s picked source and rendered output on success", async (os) => {
    state.os = os; const file = await (await preparePhotoPicker())(false);
    expect(file?.bytes).toEqual(state.bytes);
    expect(state.deleted.mock.calls.flat()).toEqual([outputUri, photoUri]);
    expect(state.released.mock.calls.flat()).toEqual(["context-image", "context", "original-image", "original"]);
  });
  it("supports installed iOS cache-root UUID output when legacy cache ends with slash", async () => {
    state.source = `file:///app/cache/${id}.HEIC`;
    await (await preparePhotoPicker())(false); expect(state.deleted).toHaveBeenCalledWith(state.source);
  });
  it.each(["file:///gallery/original.jpg", "content://provider/photo", `file:///app/cache/${id}.HEIC`, "file:///app/cache/not-generated.jpg"])("does not delete unowned Android source %s", async (uri) => {
    state.os = "android"; state.source = uri;
    await (await preparePhotoPicker())(false); expect(state.deleted.mock.calls.flat()).toEqual([outputUri]);
  });
  it.each([0, -1, Infinity, NaN, 3000])("cleans output with invalid saved dimension %s", async (width) => {
    state.width = width;
    await expect((await preparePhotoPicker())(false)).rejects.toThrow("Rozmery");
    expect(state.deleted.mock.calls.flat()).toEqual([outputUri, photoUri]);
  });
  it.each(["original-constructor", "original-render", "context-constructor", "resize", "context-render", "save", "constructor", "size", "read"])("cleans and releases acquired resources after %s failure", async (failure) => {
    state.failure = failure;
    await expect((await preparePhotoPicker())(false)).rejects.toThrow(failure);
    expect(state.deleted).toHaveBeenCalledWith(photoUri);
    if (failure !== "original-constructor") expect(state.released).toHaveBeenCalledWith("original");
    if (!["original-constructor", "original-render", "context-constructor"].includes(failure)) expect(state.released).toHaveBeenCalledWith("context");
    if (["constructor", "size", "read"].includes(failure)) expect(state.deleted).toHaveBeenCalledWith(outputUri);
  });
  it.each(["declared", "actual"])("cleans every oversized %s compression attempt and its source", async (kind) => {
    if (kind === "declared") state.size = MAX_BYTES + 1;
    else { state.bytes = new Uint8Array(MAX_BYTES + 1); state.bytes.set([255, 216, 255]); }
    await expect((await preparePhotoPicker())(false)).rejects.toThrow("príliš veľká");
    expect(state.deleted.mock.calls.flat()).toEqual([outputUri, outputUri, outputUri, photoUri]);
    expect(state.read).toHaveBeenCalledTimes(kind === "declared" ? 0 : 3);
    expect(state.released).toHaveBeenCalledTimes(8);
  });
  it("preserves the original read error when all cleanup fails", async () => {
    state.failure = "read"; state.cleanupFails = true; state.releaseFails = true;
    await expect((await preparePhotoPicker())(false)).rejects.toThrow("read");
    expect(state.deleted.mock.calls.flat()).toEqual([outputUri, photoUri]);
    expect(state.released).toHaveBeenCalledTimes(4);
  });
  it("accepts a percent-encoded sandbox directory without accepting traversal", async () => {
    state.cache = "file:///app/space%20cache/";
    state.source = `file:///app/space%20cache/ImagePicker/${id}.heic`;
    await (await preparePhotoPicker())(false);
    expect(state.deleted.mock.calls.flat()).toEqual([state.source]);
  });
  it("never deletes an unexpected external manipulator output", async () => {
    state.output = "file:///gallery/other.jpg";
    await (await preparePhotoPicker())(false); expect(state.deleted.mock.calls.flat()).toEqual([photoUri]);
  });
  it("continues all cleanup when release and delete throw without losing prepared bytes", async () => {
    state.cleanupFails = true; state.releaseFails = true;
    const file = await (await preparePhotoPicker())(false); expect(file?.bytes).toEqual(state.bytes);
    expect(state.deleted.mock.calls.flat()).toEqual([outputUri, photoUri]); expect(state.released).toHaveBeenCalledTimes(4);
  });
});
