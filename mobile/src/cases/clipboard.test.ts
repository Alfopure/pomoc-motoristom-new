import { describe, expect, it, vi } from "vitest";
import { writeClipboard } from "./clipboard";
import { deferred } from "../work/draft-test-port";
describe("scoped explicit clipboard writes", () => {
  it.each(["new case same value", "account unmount", "hidden screen", "changed value"])("does not write after deferred import and %s", async () => {
    let active = true; const loaded = deferred<{ setStringAsync: (value: string) => Promise<boolean> }>(), write = vi.fn(async () => true);
    const copying = writeClipboard("Private", () => active, { platform: "ios", native: () => loaded.promise, web: vi.fn() });
    active = false; loaded.resolve({ setStringAsync: write }); expect(await copying).toBe(false); expect(write).not.toHaveBeenCalled();
  });
  it("does not acknowledge an already-started write after value/scope changes", async () => {
    let active = true; const written = deferred<boolean>(), write = vi.fn(() => written.promise);
    const copying = writeClipboard("Private", () => active, { platform: "ios", native: async () => ({ setStringAsync: write }), web: vi.fn() });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce()); active = false; written.resolve(true); expect(await copying).toBe(false);
  });
  it("web calls the browser within the gesture before yielding; false native reply is failure", async () => {
    const web = vi.fn(async () => {}), native = vi.fn(); const copying = writeClipboard("Text", () => true, { platform: "web", native, web });
    expect(web).toHaveBeenCalledExactlyOnceWith("Text"); expect(native).not.toHaveBeenCalled(); expect(await copying).toBe(true);
    await expect(writeClipboard("Text", () => true, { platform: "ios", native: async () => ({ setStringAsync: async () => false }), web })).rejects.toThrow("Clipboard rejected");
  });
});
