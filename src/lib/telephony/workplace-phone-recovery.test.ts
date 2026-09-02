import { describe, expect, it, vi } from "vitest";

import { disconnectOrCancelRecoveredPhoneTransition } from "@/lib/telephony/workplace-phone-recovery";

describe("recovered workplace phone transition", () => {
  it("continues after confirmed SIP cleanup without cancelling the operation", async () => {
    const disconnectPhone = vi.fn(async () => "accepted" as const);
    const cancelTransition = vi.fn(async () => undefined);

    await expect(disconnectOrCancelRecoveredPhoneTransition({
      cancelTransition,
      disconnectPhone,
      pending: { operationId: "operation-1", phase: "finalize" },
    })).resolves.toEqual({ kind: "disconnected", outcome: "accepted" });
    expect(cancelTransition).not.toHaveBeenCalled();
  });

  it("cancels the exact finalize operation before allowing its journal to be cleared", async () => {
    const disconnectPhone = vi.fn(async () => {
      throw new Error("VIPTel odmietol odpojenie telefónu.");
    });
    const cancelTransition = vi.fn(async () => undefined);

    const result = await disconnectOrCancelRecoveredPhoneTransition({
      cancelTransition,
      disconnectPhone,
      pending: { operationId: "operation-exact", phase: "finalize" },
    });

    expect(result.kind).toBe("transition_cancelled");
    expect(cancelTransition).toHaveBeenCalledExactlyOnceWith("operation-exact");
  });

  it("keeps continuity blocked when exact cancellation cannot be confirmed", async () => {
    const disconnectPhone = vi.fn(async () => {
      throw new Error("VIPTel neodpovedal včas.");
    });
    const cancelTransition = vi.fn(async () => {
      throw new Error("server neodpovedal");
    });

    const result = await disconnectOrCancelRecoveredPhoneTransition({
      cancelTransition,
      disconnectPhone,
      pending: { operationId: "operation-locked", phase: "finalize" },
    });

    expect(result).toMatchObject({ kind: "continuity_blocked" });
    if (result.kind !== "continuity_blocked") throw new Error("Expected blocked continuity result.");
    expect(result.message).toContain("presná zmena zostala uložená");
  });

  it("never clears a prepare journal when there is no exact operation to cancel", async () => {
    const cancelTransition = vi.fn(async () => undefined);

    const result = await disconnectOrCancelRecoveredPhoneTransition({
      cancelTransition,
      disconnectPhone: async () => {
        throw new Error("odpojenie zlyhalo");
      },
      pending: { phase: "prepare" },
    });

    expect(result).toMatchObject({ kind: "continuity_blocked" });
    expect(cancelTransition).not.toHaveBeenCalled();
  });
});
