import { describe, expect, it, vi } from "vitest";
import { CaseDraft } from "./draft";
import { memoryPort } from "../work/draft-test-port";
import { MobileApiError } from "../lib/api";
import type { MobileCaseCreated } from "../../../src/lib/mobile-api";

const result: MobileCaseCreated = { ok: true, apiVersion: 1, environment: "test", profileId: "00000000-0000-4000-8000-000000000001", checkedAt: "2026-10-15T20:00:00Z", caseId: "00000000-0000-4000-8000-000000000002", caseNumber: "2026-42", warnings: [] };
function setup(saved: unknown = null) {
  const local = memoryPort(saved), api = { create: vi.fn().mockResolvedValue(result) }, draft = new CaseDraft(api, local.port);
  return { ...local, api, draft };
}
describe("deliberate call phone transfer", () => {
  it("changes only the confirmed phone and performs no server write", () => {
    const f = setup(); f.draft.edit({ contactName: "Pôvodný kontakt", contactPhone: "0905111222", note: "Dôležitá poznámka", licensePlate: "BA123AB", manualPickupAddress: "Pôvodná adresa", priority: "urgent", jobTypes: ["tow"] });
    const before = f.draft.snapshot().input;
    expect(f.draft.applyCallPhone("+421 905 123 456", "0905111222")).toBe(true);
    expect(f.draft.snapshot().input).toEqual({ ...before, contactPhone: "+421905123456" });
    expect(f.api.create).not.toHaveBeenCalled();
    expect(f.record.payload).toMatchObject({ input: { contactPhone: "+421905123456", note: "Dôležitá poznámka" } });
  });
  it("does not replace a phone changed since the offer was rendered", () => {
    const f = setup(); f.draft.edit({ contactPhone: "0905111222" }); f.draft.edit({ contactPhone: "0905333444" });
    expect(f.draft.applyCallPhone("+421905123456", "0905111222")).toBe(false);
    expect(f.draft.snapshot().input.contactPhone).toBe("0905333444");
  });
  it.each([null, "1001", "anonymous", "sip:0905123456@example.test"])("does not inject an unusable customer identity %s", value => {
    const f = setup(); expect(f.draft.applyCallPhone(value as string, "")).toBe(false); expect(f.draft.snapshot().input.contactPhone).toBeUndefined();
  });
  it("waits for local durability and refuses an account whose port closed", () => {
    const f = setup(); f.record.settled = false;
    expect(f.draft.canApplyCallPhone()).toBe(false); expect(f.draft.applyCallPhone("0905123456", "")).toBe(false);
    f.record.settled = true; f.record.live = false;
    expect(f.draft.canApplyCallPhone()).toBe(false); expect(f.draft.applyCallPhone("0905123456", "")).toBe(false);
  });
  it("does not alter a submitted command while saving or after an uncertain result", async () => {
    const f = setup(); let reject!: (reason: unknown) => void;
    f.draft.edit({ contactPhone: "0905111222", note: "Ponechať" });
    f.api.create.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const pending = f.draft.submit(); await Promise.resolve(); await Promise.resolve();
    expect(f.draft.applyCallPhone("0905123456", "0905111222")).toBe(false);
    reject(new MobileApiError("Neistý výsledok", 0)); await pending;
    const before = f.draft.exportDraft();
    expect(f.draft.snapshot().status).toBe("uncertain");
    expect(f.draft.applyCallPhone("0905123456", "0905111222")).toBe(false);
    expect(f.draft.exportDraft()).toEqual(before); expect(f.api.create).toHaveBeenCalledTimes(1);
  });
  it("requires a saved confirmation to settle before explicitly starting another draft", async () => {
    const f = setup(); f.draft.edit({ contactPhone: "0905111222" }); await f.draft.submit();
    expect(f.draft.applyCallPhone("0905123456", "0905111222")).toBe(false);
    f.record.settled = false; f.draft.newDraft();
    expect(f.draft.snapshot().status).toBe("saved"); expect(f.draft.applyCallPhone("0905123456", "0905111222")).toBe(false);
    f.record.settled = true; f.draft.newDraft();
    expect(f.draft.snapshot().status).toBe("editing"); expect(f.draft.applyCallPhone("0905123456", "")).toBe(true);
    expect(f.api.create).toHaveBeenCalledTimes(1);
  });
  it("refuses a disposed or rejected draft without scheduling storage", () => {
    const f = setup(); f.draft.dispose(); vi.mocked(f.port.changed).mockClear();
    expect(f.draft.applyCallPhone("0905123456", "")).toBe(false); expect(f.port.changed).not.toHaveBeenCalled();
    const rejected = setup({ version: 999 }); vi.mocked(rejected.port.changed).mockClear();
    expect(rejected.draft.applyCallPhone("0905123456", "")).toBe(false); expect(rejected.port.changed).not.toHaveBeenCalled();
  });
});
