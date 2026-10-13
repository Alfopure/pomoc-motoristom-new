import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareTowingImage, validateTowingFile } from "./images";

afterEach(() => vi.unstubAllGlobals());
describe("towing image intake", () => {
  it("rejects unsupported HEIC and oversized or empty bytes explicitly", () => {
    expect(() => validateTowingFile({ type: "image/heic", size: 200 })).toThrow("HEIC");
    expect(() => validateTowingFile({ type: "image/jpeg", size: 11 * 1024 * 1024 })).toThrow("10 MB");
    expect(() => validateTowingFile({ type: "image/png", size: 0 })).toThrow("prázdny");
  });
  it("retains valid originals if browser cannot decode or cannot create canvas", async () => {
    const original = new File([new Uint8Array(30)], "work.jpg", { type: "image/jpeg" });
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode")));
    vi.stubGlobal("document", {});
    expect(await prepareTowingImage(original)).toBe(original);
  });
  it("bounds large camera photos and releases decoded memory", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 6000, height: 4000, close }));
    const drawImage = vi.fn(); const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: "", fillRect: vi.fn(), drawImage }), toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array(2000)], { type: "image/jpeg" })) };
    vi.stubGlobal("document", { createElement: () => canvas });
    const result = await prepareTowingImage(new File([new Uint8Array(3 * 1024 * 1024)], "camera.png", { type: "image/png" }));
    expect(canvas.width).toBe(2048); expect(canvas.height).toBe(1365);
    expect(result.size).toBeLessThan(2 * 1024 * 1024); expect(result.type).toBe("image/jpeg");
    expect(drawImage).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
});
