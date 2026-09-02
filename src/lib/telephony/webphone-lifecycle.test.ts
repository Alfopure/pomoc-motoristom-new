import { describe, expect, it, vi } from "vitest";

import {
  applyWebphoneExtensionSelection,
  disconnectWebphoneForSeatTransition,
} from "@/lib/telephony/webphone-lifecycle";

describe("browser webphone extension lifecycle", () => {
  it.each(["incoming", "outgoing", "in_call"] as const)(
    "blocks a seat-transition teardown when a %s call started during server preparation",
    (callStatus) => {
      const disconnect = vi.fn(() => Promise.resolve("accepted" as const));

      expect(() => disconnectWebphoneForSeatTransition({
        callStatus,
        disconnect,
      })).toThrow("Počas prebiehajúceho hovoru sa pracovné miesto nedá zmeniť");
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it.each(["idle", "ended", "failed"] as const)(
    "starts the seat-transition teardown exactly once from terminal status %s",
    (callStatus) => {
      const result = Promise.resolve("accepted" as const);
      const disconnect = vi.fn(() => result);

      expect(disconnectWebphoneForSeatTransition({ callStatus, disconnect })).toBe(result);
      expect(disconnect).toHaveBeenCalledOnce();
    },
  );

  it("keeps the source phone connected while a durable seat change is preparing", () => {
    const disconnect = vi.fn();

    expect(applyWebphoneExtensionSelection({
      callStatus: "idle",
      currentExtension: "20",
      nextExtension: "",
      disconnect,
      suspended: true,
    })).toBe("suspended");
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each(["incoming", "outgoing", "in_call"] as const)(
    "never disconnects the SIP session while the call is %s",
    (callStatus) => {
      const disconnect = vi.fn();

      expect(applyWebphoneExtensionSelection({
        callStatus,
        currentExtension: "20",
        nextExtension: "21",
        disconnect,
      })).toBe("deferred");
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it("disconnects exactly once after the same deferred change reaches a terminal call state", () => {
    const disconnect = vi.fn();

    expect(applyWebphoneExtensionSelection({
      callStatus: "in_call",
      currentExtension: "20",
      nextExtension: "21",
      disconnect,
    })).toBe("deferred");
    expect(applyWebphoneExtensionSelection({
      callStatus: "ended",
      currentExtension: "20",
      nextExtension: "21",
      disconnect,
    })).toBe("disconnected");
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
