import { describe, expect, it, vi } from "vitest";
import { placeBrowserSipInvite } from "@/lib/telephony/webphone-invite";

describe("browser SIP INVITE", () => {
  it("returns normally without changing call state after a successful INVITE", async () => {
    const onRejected = vi.fn();

    await expect(placeBrowserSipInvite(() => Promise.resolve(), onRejected)).resolves.toBeUndefined();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("resets the optimistic outgoing state and returns a safe retryable error when INVITE fails", async () => {
    const onRejected = vi.fn();

    await expect(placeBrowserSipInvite(
      () => Promise.reject(new Error("wss://secret-provider.invalid/internal")),
      onRejected,
    )).rejects.toThrow("Hovor sa v telefónnej ústredni nepodarilo začať. Skús ho znova.");
    expect(onRejected).toHaveBeenCalledOnce();
  });
});
