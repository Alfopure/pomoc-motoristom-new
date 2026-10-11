import { WorkStore } from "./store";
import type { WorkApi } from "./api";
import { describe, expect, it, vi } from "vitest";
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));
describe("retained case work ownership", () => {
  it("retains per-task composer fields and invalidates confirmed writes without navigation callbacks", async () => {
    const changed = vi.fn(), sendMessage = vi.fn().mockResolvedValue({ message: { id: "receipt" } });
    const store = new WorkStore({ sendMessage } as unknown as WorkApi, changed);
    const first = store.task("one"); first.body = "Draft survives leaving detail";
    expect(store.task("one").body).toBe(first.body); expect(store.task("two").body).toBe("");
    await first.message.submit({ body: first.body, clientMessageId: "id" }); expect(changed).toHaveBeenCalledTimes(1);
  });
  it("ignores late receipt invalidation after account disposal", async () => {
    let resolve!: (v: unknown) => void;
    const changed = vi.fn(), sendMessage = vi.fn(() => new Promise(done => { resolve = done; }));
    const store = new WorkStore({ sendMessage } as unknown as WorkApi, changed), draft = store.task("one");
    const saving = draft.message.submit({ body: "one", clientMessageId: "id" }); store.dispose(); resolve({ message: { id: "receipt" } });
    expect(await saving).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
  });
});
