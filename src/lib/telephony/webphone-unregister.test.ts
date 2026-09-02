import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertHotdeskWebphoneDisconnectConfirmed,
  waitForWebphoneUnregisterResponse,
} from "@/lib/telephony/webphone-unregister";

describe("waitForWebphoneUnregisterResponse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the transport alive until the registrar accepts the unregister", async () => {
    let onAccept: (() => void) | undefined;
    const unregister = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      onAccept = options?.requestDelegate?.onAccept;
    });

    const outcome = waitForWebphoneUnregisterResponse({ unregister }, 1_000);
    let completed = false;
    void outcome.then(() => { completed = true; });
    await Promise.resolve();

    expect(unregister).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledWith(expect.objectContaining({ all: true }));
    expect(completed).toBe(false);
    onAccept?.();
    await expect(outcome).resolves.toBe("accepted");
  });

  it("reports a final rejection without waiting for the timeout", async () => {
    const unregister = vi.fn(async (options?: { requestDelegate?: { onReject?: () => void } }) => {
      options?.requestDelegate?.onReject?.();
    });

    await expect(waitForWebphoneUnregisterResponse({ unregister }, 1_000)).resolves.toBe("rejected");
  });

  it("can remove only the current contact when a stale browser loses its lease", async () => {
    const unregister = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      options?.requestDelegate?.onAccept?.();
    });

    await expect(waitForWebphoneUnregisterResponse(
      { unregister },
      1_000,
      { allContacts: false },
    )).resolves.toBe("accepted");
    expect(unregister).toHaveBeenCalledWith(expect.objectContaining({ all: false }));
  });

  it("reports a send failure", async () => {
    const unregister = vi.fn(() => Promise.reject(new Error("transport closed")));

    await expect(waitForWebphoneUnregisterResponse({ unregister }, 1_000)).resolves.toBe("send_failed");
  });

  it("normalizes a synchronous SIP state failure", async () => {
    const unregister = vi.fn(() => {
      throw new Error("registerer terminated");
    });

    await expect(waitForWebphoneUnregisterResponse({ unregister }, 1_000)).resolves.toBe("send_failed");
  });

  it("bounds a registrar which never sends a final response", async () => {
    vi.useFakeTimers();
    const unregister = vi.fn(async () => undefined);
    const outcome = waitForWebphoneUnregisterResponse({ unregister }, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toBe("timed_out");
  });

  it("retries while the original REGISTER request is still pending", async () => {
    vi.useFakeTimers();
    let onAccept: (() => void) | undefined;
    const unregister = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("REGISTER request already in progress"), {
        name: "RequestPendingError",
      }))
      .mockImplementationOnce(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
        onAccept = options?.requestDelegate?.onAccept;
      });

    const outcome = waitForWebphoneUnregisterResponse({ unregister }, 1_000);
    await vi.advanceTimersByTimeAsync(100);

    expect(unregister).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenLastCalledWith(expect.objectContaining({ all: true }));
    onAccept?.();
    await expect(outcome).resolves.toBe("accepted");
  });

  it("keeps the shared deadline while repeated REGISTER requests are pending", async () => {
    vi.useFakeTimers();
    const pending = Object.assign(new Error("REGISTER request already in progress"), {
      name: "RequestPendingError",
    });
    const unregister = vi.fn(() => Promise.reject(pending));
    const outcome = waitForWebphoneUnregisterResponse({ unregister }, 250);

    await vi.advanceTimersByTimeAsync(250);

    await expect(outcome).resolves.toBe("timed_out");
    expect(unregister.mock.calls.length).toBeGreaterThan(1);
  });

  it("allows only accepted or already-disconnected hotdesk teardown to continue", () => {
    expect(() => assertHotdeskWebphoneDisconnectConfirmed("accepted")).not.toThrow();
    expect(() => assertHotdeskWebphoneDisconnectConfirmed("not_connected")).not.toThrow();
    expect(() => assertHotdeskWebphoneDisconnectConfirmed("timed_out")).toThrow("nepotvrdil odpojenie");
    expect(() => assertHotdeskWebphoneDisconnectConfirmed("rejected")).toThrow("odmietol odpojenie");
    expect(() => assertHotdeskWebphoneDisconnectConfirmed("send_failed")).toThrow("nepodarilo odoslať");
  });
});
