import { describe, expect, it, vi } from "vitest";
import { AttachmentDraft, multipart, photoSize, validateFile, MAX_BYTES } from "./attachments";
import { MobileApiError } from "../lib/api";
const jpeg = new Uint8Array([255, 216, 255, 224, 12]);
describe("attachment byte boundary", () => {
  it("validates actual magic and length rather than filename or URI", () => {
    expect(validateFile(jpeg, "image/jpeg")).toBe("image/jpeg");
    expect(() => validateFile(jpeg, "image/png")).toThrow();
    expect(() => validateFile(new Uint8Array(MAX_BYTES + 1), "image/jpeg")).toThrow();
    expect(() => validateFile(new TextEncoder().encode("HEIC"), "image/jpeg")).toThrow();
  });
  it("encodes UTF8 filename only in JSON with exactly two multipart parts", async () => {
    const command = { mutationId: "uuid", expectedUpdatedAt: "revision", fileName: "Žlté auto.jpg", category: "photo" as const, note: "Čelná strana" };
    const data = multipart(command, jpeg, "image/jpeg", "fixed-boundary");
    const form = await new Response(data.bytes as BodyInit, { headers: { "Content-Type": data.contentType } }).formData() as unknown as { keys(): IterableIterator<string>; get(name: string): File | string };
    expect([...form.keys()]).toEqual(["command", "file"]); expect(JSON.parse(form.get("command") as string)).toEqual(command);
    const file = form.get("file") as File; expect(file.name).toBe("attachment.bin"); expect(file.type).toBe("image/jpeg"); expect(new Uint8Array(await file.arrayBuffer())).toEqual(jpeg);
  });
  it("freezes selected bytes and exact command across ambiguous uploads", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new MobileApiError("timeout", 0)).mockRejectedValueOnce(new MobileApiError("auth", 401)).mockResolvedValue({ mutationId: "id" });
    const input = jpeg.slice(), draft = new AttachmentDraft({ upload }, "case", () => "id");
    draft.select({ bytes: input, mimeType: "image/jpeg", fileName: "auto.jpg", category: "photo" }); input[0] = 0;
    draft.editNote("note"); await draft.save("revision"); draft.editNote("changed"); await draft.reconcile();
    expect(draft.snapshot().status).toBe("uncertain"); await draft.reconcile();
    expect(upload).toHaveBeenCalledTimes(3); expect(upload.mock.calls[1][1]).toEqual(upload.mock.calls[0][1]);
    expect(upload.mock.calls[2][2].bytes).toEqual(upload.mock.calls[0][2].bytes);
    const form = await new Response(upload.mock.calls[0][2].bytes, { headers: { "Content-Type": upload.mock.calls[0][2].contentType } }).formData() as unknown as { keys(): IterableIterator<string>; get(name: string): File | string };
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(jpeg);
  });
  it("preserves aspect ratio and does not upscale", () => {
    expect(photoSize(4032, 3024)).toEqual({ width: 2048, height: 1536 }); expect(photoSize(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(photoSize(300, 200)).toEqual({ width: 300, height: 200 }); expect(() => photoSize(0, 0)).toThrow();
  });
});
