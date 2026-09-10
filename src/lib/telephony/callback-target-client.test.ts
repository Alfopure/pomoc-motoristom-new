import { afterEach, describe, expect, it, vi } from "vitest";
import { requestCallbackTargetConfirmation } from "./callback-target-client";
const request = vi.hoisted(() => vi.fn());
vi.mock("./client-request", () => ({ telephonyJson: request, TELEPHONY_TIMEOUT_MS: { read: 1000 } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const original = { originalNumber: "+421905111111", dialNumber: "+421905111111", status: "original", verificationId: null };
const alternate = { ...original, dialNumber: "+421905222222", status: "verified_alternative", verificationId: "verified-1", sourceName: "Ústredňa", targetName: "Dispečing" };
describe("callback target confirmation", () => {
  it("keeps ordinary numbers without a confirmation", async () => {
    request.mockResolvedValue({ ok: true, body: { target: original } });
    expect(await requestCallbackTargetConfirmation(original.originalNumber)).toEqual({ dialNumber: original.originalNumber });
  });
  it.each([true, false])("requires an explicit decision for an alternate number: %s", async accepted => {
    const confirm = vi.fn(() => accepted); vi.stubGlobal("window", { confirm });
    request.mockResolvedValue({ ok: true, body: { target: alternate } });
    expect(await requestCallbackTargetConfirmation(original.originalNumber)).toEqual(accepted ? { dialNumber: alternate.dialNumber, verificationId: "verified-1" } : null);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Ústredňa"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Dispečing"));
  });
  it("blocks known unreachable numbers and failed lookups", async () => {
    request.mockResolvedValue({ ok: true, body: { target: { ...original, status: "blocked" } } });
    await expect(requestCallbackTargetConfirmation(original.originalNumber)).rejects.toThrow(/overte/);
    request.mockResolvedValue({ ok: false, body: { error: "Dočasná chyba" } });
    await expect(requestCallbackTargetConfirmation(original.originalNumber)).rejects.toThrow("Dočasná chyba");
  });
});
