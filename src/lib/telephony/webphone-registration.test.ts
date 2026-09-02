import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeWebphoneDisconnect,
  replaceStaleWebphoneRegistrations,
  waitForWebphoneRegisterResponse,
  webphoneDisconnectOutcomeForMode,
} from "@/lib/telephony/webphone-registration";

describe("webphone registration replacement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a final registration response", async () => {
    let onAccept: (() => void) | undefined;
    const register = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      onAccept = options?.requestDelegate?.onAccept;
    });
    const outcome = waitForWebphoneRegisterResponse({ register }, 1_000);

    await Promise.resolve();
    onAccept?.();

    await expect(outcome).resolves.toBe("accepted");
  });

  it("registers once, clears all stale contacts, then registers the current browser", async () => {
    const events: string[] = [];
    const register = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      events.push("register");
      options?.requestDelegate?.onAccept?.();
    });
    const unregister = vi.fn(async (options?: {
      all?: boolean;
      requestDelegate?: { onAccept?: () => void };
    }) => {
      events.push(`unregister:${String(options?.all)}`);
      options?.requestDelegate?.onAccept?.();
    });

    await expect(replaceStaleWebphoneRegistrations({ register, unregister })).resolves.toEqual({
      stage: "replacement_registration",
      outcome: "accepted",
    });
    expect(events).toEqual(["register", "unregister:false", "unregister:true", "register"]);
  });

  it("does not register again when stale-contact cleanup is rejected", async () => {
    const register = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      options?.requestDelegate?.onAccept?.();
    });
    const unregister = vi.fn(async (options?: { requestDelegate?: { onReject?: () => void } }) => {
      options?.requestDelegate?.onReject?.();
    });

    await expect(replaceStaleWebphoneRegistrations({ register, unregister })).resolves.toEqual({
      stage: "stale_cleanup",
      outcome: "rejected",
    });
    expect(register).toHaveBeenCalledOnce();
  });

  it("does not clear contacts when the initial registration is rejected", async () => {
    const register = vi.fn(async (options?: { requestDelegate?: { onReject?: () => void } }) => {
      options?.requestDelegate?.onReject?.();
    });
    const unregister = vi.fn();

    await expect(replaceStaleWebphoneRegistrations({ register, unregister })).resolves.toEqual({
      stage: "initial_registration",
      outcome: "rejected",
    });
    expect(unregister).not.toHaveBeenCalled();
  });

  it("cancels during the initial REGISTER with ordered cleanup and no replacement REGISTER", async () => {
    let cancellation: "none" | "all" = "none";
    let acceptInitial: (() => void) | undefined;
    const acceptCleanup: Array<() => void> = [];
    const register = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      acceptInitial = options?.requestDelegate?.onAccept;
    });
    const unregister = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      if (options?.requestDelegate?.onAccept) acceptCleanup.push(options.requestDelegate.onAccept);
    });
    const result = replaceStaleWebphoneRegistrations(
      { register, unregister },
      { cancellationMode: () => cancellation },
    );

    cancellation = "all";
    acceptInitial?.();
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
    expect(unregister).toHaveBeenCalledWith(expect.objectContaining({ all: false }));
    expect(register).toHaveBeenCalledOnce();
    acceptCleanup.shift()?.();

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(2));
    expect(unregister).toHaveBeenLastCalledWith(expect.objectContaining({ all: true }));
    expect(register).toHaveBeenCalledOnce();
    acceptCleanup.shift()?.();

    await expect(result).resolves.toEqual({
      stage: "cancelled_cleanup",
      outcome: "accepted",
      cancelled: true,
      cleanedContacts: "all",
    });
    expect(register).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it("cancels during ordered stale cleanup without a replacement REGISTER", async () => {
    let cancellation: "none" | "current" = "none";
    const acceptCleanup: Array<() => void> = [];
    const register = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      options?.requestDelegate?.onAccept?.();
    });
    const unregister = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      if (options?.requestDelegate?.onAccept) acceptCleanup.push(options.requestDelegate.onAccept);
    });
    const result = replaceStaleWebphoneRegistrations(
      { register, unregister },
      { cancellationMode: () => cancellation },
    );

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
    cancellation = "current";
    acceptCleanup.shift()?.();

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(2));
    expect(unregister).toHaveBeenNthCalledWith(1, expect.objectContaining({ all: false }));
    expect(unregister).toHaveBeenNthCalledWith(2, expect.objectContaining({ all: true }));
    acceptCleanup.shift()?.();

    await expect(result).resolves.toEqual({
      stage: "cancelled_cleanup",
      outcome: "accepted",
      cancelled: true,
      cleanedContacts: "all",
    });
    expect(register).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it("cancels a final REGISTER before completion and removes only that replacement contact", async () => {
    let cancellation: "none" | "current" = "none";
    let acceptReplacement: (() => void) | undefined;
    let acceptCancelledCleanup: (() => void) | undefined;
    const register = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      if (register.mock.calls.length === 1) options?.requestDelegate?.onAccept?.();
      else acceptReplacement = options?.requestDelegate?.onAccept;
    });
    const unregister = vi.fn(async (options?: {
      all?: boolean;
      requestDelegate?: { onAccept?: () => void };
    }) => {
      if (unregister.mock.calls.length <= 2) options?.requestDelegate?.onAccept?.();
      else acceptCancelledCleanup = options?.requestDelegate?.onAccept;
    });
    const result = replaceStaleWebphoneRegistrations(
      { register, unregister },
      { cancellationMode: () => cancellation },
    );

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    cancellation = "current";
    acceptReplacement?.();
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(3));
    expect(unregister).toHaveBeenLastCalledWith(expect.objectContaining({ all: false }));
    acceptCancelledCleanup?.();

    await expect(result).resolves.toEqual({
      stage: "cancelled_cleanup",
      outcome: "accepted",
      cancelled: true,
      cleanedContacts: "current",
    });
    expect(register).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledTimes(3);
  });

  it("cleans up before returning when cancellation races an ambiguous initial REGISTER timeout", async () => {
    vi.useFakeTimers();
    let cancellation: "none" | "all" = "none";
    const register = vi.fn(async () => undefined);
    const unregister = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      options?.requestDelegate?.onAccept?.();
    });
    const result = replaceStaleWebphoneRegistrations(
      { register, unregister },
      { cancellationMode: () => cancellation },
    );

    cancellation = "all";
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(result).resolves.toEqual({
      stage: "cancelled_cleanup",
      outcome: "accepted",
      cancelled: true,
      cleanedContacts: "all",
    });
    expect(register).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenNthCalledWith(1, expect.objectContaining({ all: false }));
    expect(unregister).toHaveBeenNthCalledWith(2, expect.objectContaining({ all: true }));
  });

  it("cleans up before returning when cancellation races an ambiguous replacement REGISTER timeout", async () => {
    vi.useFakeTimers();
    let cancellation: "none" | "current" = "none";
    const register = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      if (register.mock.calls.length === 1) options?.requestDelegate?.onAccept?.();
    });
    const unregister = vi.fn(async (options?: { requestDelegate?: { onAccept?: () => void } }) => {
      options?.requestDelegate?.onAccept?.();
    });
    const result = replaceStaleWebphoneRegistrations(
      { register, unregister },
      { cancellationMode: () => cancellation },
    );

    await flushMicrotasks();
    expect(register).toHaveBeenCalledTimes(2);
    cancellation = "current";
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(result).resolves.toEqual({
      stage: "cancelled_cleanup",
      outcome: "accepted",
      cancelled: true,
      cleanedContacts: "current",
    });
    expect(register).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledTimes(3);
    expect(unregister).toHaveBeenLastCalledWith(expect.objectContaining({ all: false }));
  });

  it("removes the current contact before wildcard cleanup and keeps the transport open for both responses", async () => {
    const accepts: Array<() => void> = [];
    const unregister = vi.fn(async (options?: {
      requestDelegate?: { onAccept?: () => void };
    }) => {
      if (options?.requestDelegate?.onAccept) accepts.push(options.requestDelegate.onAccept);
    });
    const disconnect = vi.fn(async () => undefined);
    const teardown = completeWebphoneDisconnect(
      { register: vi.fn(), unregister, disconnect },
      { requestedMode: () => "all" },
    );

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
    expect(unregister).toHaveBeenNthCalledWith(1, expect.objectContaining({ all: false }));
    expect(disconnect).not.toHaveBeenCalled();
    accepts.shift()?.();

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(2));
    expect(unregister).toHaveBeenNthCalledWith(2, expect.objectContaining({ all: true }));
    expect(disconnect).not.toHaveBeenCalled();
    accepts.shift()?.();

    await expect(teardown).resolves.toEqual({
      cleanedContacts: "all",
      hadSipUser: true,
      outcome: "accepted",
    });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("does not send wildcard cleanup when current-contact removal fails", async () => {
    const unregister = vi.fn(async (options?: {
      requestDelegate?: { onReject?: () => void };
    }) => {
      options?.requestDelegate?.onReject?.();
    });
    const disconnect = vi.fn(async () => undefined);

    await expect(completeWebphoneDisconnect(
      { register: vi.fn(), unregister, disconnect },
      { requestedMode: () => "all" },
    )).resolves.toEqual({
      cleanedContacts: "none",
      hadSipUser: true,
      outcome: "rejected",
    });
    expect(unregister).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledWith(expect.objectContaining({ all: false }));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("reports partial cleanup when wildcard fails after current contact was removed", async () => {
    const unregister = vi.fn(async (options?: {
      all?: boolean;
      requestDelegate?: { onAccept?: () => void; onReject?: () => void };
    }) => {
      if (options?.all === false) options.requestDelegate?.onAccept?.();
      else options?.requestDelegate?.onReject?.();
    });
    const disconnect = vi.fn(async () => undefined);

    const completion = await completeWebphoneDisconnect(
      { register: vi.fn(), unregister, disconnect },
      { requestedMode: () => "all" },
    );
    expect(completion).toEqual({
      cleanedContacts: "current",
      hadSipUser: true,
      outcome: "rejected",
    });
    expect(webphoneDisconnectOutcomeForMode(completion, "all")).toBe("rejected");
    expect(unregister).toHaveBeenNthCalledWith(1, expect.objectContaining({ all: false }));
    expect(unregister).toHaveBeenNthCalledWith(2, expect.objectContaining({ all: true }));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("does not repeat a failed wildcard already completed by an in-flight registration lifecycle", async () => {
    const unregister = vi.fn();
    const disconnect = vi.fn(async () => undefined);

    await expect(completeWebphoneDisconnect(
      { register: vi.fn(), unregister, disconnect },
      {
        lifecycle: Promise.resolve({
          stage: "cancelled_cleanup",
          outcome: "rejected",
          cancelled: true,
          cleanedContacts: "current",
        }),
        requestedMode: () => "all",
      },
    )).resolves.toEqual({
      cleanedContacts: "current",
      hadSipUser: true,
      outcome: "rejected",
    });
    expect(unregister).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("upgrades an in-flight current-contact disconnect before closing the transport", async () => {
    let requestedMode: "current" | "all" = "current";
    const accepts: Array<() => void> = [];
    const unregister = vi.fn(async (options?: {
      requestDelegate?: { onAccept?: () => void };
    }) => {
      if (options?.requestDelegate?.onAccept) accepts.push(options.requestDelegate.onAccept);
    });
    const disconnect = vi.fn(async () => undefined);
    const teardown = completeWebphoneDisconnect(
      { register: vi.fn(), unregister, disconnect },
      { requestedMode: () => requestedMode },
    );

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
    expect(unregister).toHaveBeenNthCalledWith(1, expect.objectContaining({ all: false }));
    requestedMode = "all";
    expect(disconnect).not.toHaveBeenCalled();
    accepts.shift()?.();

    await vi.waitFor(() => expect(unregister).toHaveBeenCalledTimes(2));
    expect(unregister).toHaveBeenNthCalledWith(2, expect.objectContaining({ all: true }));
    expect(disconnect).not.toHaveBeenCalled();
    accepts.shift()?.();

    await expect(teardown).resolves.toEqual({
      cleanedContacts: "all",
      hadSipUser: true,
      outcome: "accepted",
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it("does not claim all contacts were cleared when the upgrade arrives during transport close", async () => {
    let requestedMode: "current" | "all" = "current";
    let finishDisconnect: (() => void) | undefined;
    const unregister = vi.fn(async (options?: {
      requestDelegate?: { onAccept?: () => void };
    }) => {
      options?.requestDelegate?.onAccept?.();
    });
    const disconnect = vi.fn(() => new Promise<void>((resolve) => {
      finishDisconnect = resolve;
    }));
    const teardown = completeWebphoneDisconnect(
      { register: vi.fn(), unregister, disconnect },
      { requestedMode: () => requestedMode },
    );

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(unregister).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledWith(expect.objectContaining({ all: false }));

    requestedMode = "all";
    finishDisconnect?.();

    const completion = await teardown;
    expect(completion).toEqual({
      cleanedContacts: "current",
      hadSipUser: true,
      outcome: "accepted",
    });
    expect(webphoneDisconnectOutcomeForMode(completion, "current")).toBe("accepted");
    expect(webphoneDisconnectOutcomeForMode(completion, "all")).toBe("send_failed");
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("accepts not_connected for all-contact cleanup only when no SIP user existed", () => {
    expect(webphoneDisconnectOutcomeForMode({
      cleanedContacts: "none",
      hadSipUser: false,
      outcome: "not_connected",
    }, "all")).toBe("not_connected");
    expect(webphoneDisconnectOutcomeForMode({
      cleanedContacts: "current",
      hadSipUser: true,
      outcome: "accepted",
    }, "all")).toBe("send_failed");
  });
});

async function flushMicrotasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}
