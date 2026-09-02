import { describe, expect, it, vi } from "vitest";

import { telephonyTransferTransport, terminateQueuedIncomingCall } from "./call-control";

describe("directional telephony control", () => {
  it("uses provider redirect to move the receiving operator of an inbound call", () => {
    expect(telephonyTransferTransport("inbound", true, "operator")).toBe("provider_redirect");
    expect(telephonyTransferTransport("inbound", false)).toBe("provider_redirect");
  });

  it("uses the established browser dialog for an inbound transfer to an external phone", () => {
    expect(telephonyTransferTransport("inbound", true, "phone")).toBe("browser_sip_refer");
    expect(telephonyTransferTransport("inbound", false, "phone")).toBe("provider_redirect");
  });

  it("uses SIP REFER on the browser dialog to keep the client on an outbound transfer", () => {
    expect(telephonyTransferTransport("outbound", true)).toBe("browser_sip_refer");
    expect(telephonyTransferTransport("internal", true)).toBe("browser_sip_refer");
  });

  it("fails closed when an outbound provider-only call has no transferable dialog", () => {
    expect(telephonyTransferTransport("outbound", false)).toBeNull();
  });

  it("closes the local queue leg only after provider termination succeeds", async () => {
    const order: string[] = [];
    await terminateQueuedIncomingCall(
      async () => { order.push("provider"); },
      async () => { order.push("local"); },
    );
    expect(order).toEqual(["provider", "local"]);
  });

  it("never advances the queue locally when provider termination fails", async () => {
    const closeLocalSipLeg = vi.fn(async () => undefined);
    await expect(terminateQueuedIncomingCall(
      async () => { throw new Error("provider did not confirm"); },
      closeLocalSipLeg,
    )).rejects.toThrow("provider did not confirm");
    expect(closeLocalSipLeg).not.toHaveBeenCalled();
  });
});
