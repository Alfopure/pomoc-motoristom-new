import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmAuditedBrowserSipCall,
  requireConfirmedTelephonyCommand,
  runAuditedBrowserSipInvite,
  waitForTelephonyCommand,
} from "@/lib/telephony/commands";
import { createBrowserSipCallAttempt } from "@/lib/telephony/webphone-call-attempt";

describe("audited browser SIP INVITE", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not report a failure after the INVITE was sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runAuditedBrowserSipInvite("command-1", () => Promise.resolve())).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a certain pre-send failure before returning the retryable INVITE error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      command: { id: "22222222-2222-4222-8222-222222222222", status: "failed" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const inviteError = new Error("Hovor sa v telefónnej ústredni nepodarilo začať. Skús ho znova.");

    await expect(runAuditedBrowserSipInvite(
      "22222222-2222-4222-8222-222222222222",
      () => Promise.reject(inviteError),
    )).rejects.toBe(inviteError);
    expect(fetchMock).toHaveBeenCalledWith("/api/telephony/call/create", expect.objectContaining({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: "22222222-2222-4222-8222-222222222222" }),
      // The request is now bounded, so it also carries an abort signal.
      signal: expect.anything(),
    }));
  });

  it("blocks retry guidance when the accepted intent cannot be safely closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: "VIPTel už tento hovor potvrdil; stav sa nesmie prepísať.",
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(runAuditedBrowserSipInvite(
      "22222222-2222-4222-8222-222222222222",
      () => Promise.reject(new Error("invite rejected")),
    )).rejects.toThrow("Hovor neopakuj");
  });
});

describe("browser SIP confirmation recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns immediately when call.begin confirms the audited intent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      command: { id: "command-1", status: "confirmed_by_event" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const attempt = createBrowserSipCallAttempt();

    await expect(confirmAuditedBrowserSipCall("command-1", attempt.attempt, fastOptions()))
      .resolves.toMatchObject({ status: "confirmed_by_event" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reconciles a definitive SIP rejection and gives safe retry guidance", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          ok: true,
          command: { id: "command-1", status: "failed", deliveryUncertain: false },
        });
      }
      return jsonResponse({ command: { id: "command-1", status: "accepted" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const attempt = createBrowserSipCallAttempt();
    attempt.settle({ outcome: "rejected", statusCode: 486 });

    await expect(confirmAuditedBrowserSipCall("command-1", attempt.attempt, fastOptions()))
      .rejects.toThrow("Stav je obnovený");
    expect(fetchMock).toHaveBeenCalledWith("/api/telephony/call/create", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        browserReport: { outcome: "rejected", statusCode: 486 },
        commandId: "command-1",
        outcome: "reconcile",
      }),
    }));
  });

  it("accepts reconciliation when a delayed provider call row confirms the call", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          ok: true,
          command: { id: "command-1", status: "confirmed_by_event" },
        });
      }
      return jsonResponse({ command: { id: "command-1", status: "accepted" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const attempt = createBrowserSipCallAttempt();
    attempt.settle({ outcome: "ended_before_answer" });

    await expect(confirmAuditedBrowserSipCall("command-1", attempt.attempt, fastOptions()))
      .resolves.toMatchObject({ status: "confirmed_by_event" });
  });

  it("keeps watching the SIP result after a transient command-status read failure", async () => {
    let commandReads = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          ok: true,
          command: { id: "command-1", status: "failed", deliveryUncertain: false },
        });
      }
      commandReads += 1;
      if (commandReads === 1) throw new TypeError("temporary network failure");
      return jsonResponse({ command: { id: "command-1", status: "accepted" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const attempt = createBrowserSipCallAttempt();
    const confirmation = confirmAuditedBrowserSipCall("command-1", attempt.attempt, {
      confirmationTimeoutMs: 30,
      graceTimeoutMs: 8,
      pollMs: 1,
    });

    await vi.waitFor(() => expect(commandReads).toBeGreaterThanOrEqual(1));
    attempt.settle({ outcome: "rejected", statusCode: 486 });

    await expect(confirmation).rejects.toThrow("Stav je obnovený");
    expect(fetchMock).toHaveBeenCalledWith("/api/telephony/call/create", expect.objectContaining({
      method: "PATCH",
    }));
  });

  it("still reconciles when the first grace-period status read fails after a terminal SIP result", async () => {
    let commandReads = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          ok: true,
          command: { id: "command-1", status: "failed", deliveryUncertain: false },
        });
      }
      commandReads += 1;
      if (commandReads === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (commandReads === 2) throw new TypeError("temporary grace-period network failure");
      return jsonResponse({ command: { id: "command-1", status: "accepted" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const attempt = createBrowserSipCallAttempt();
    const confirmation = confirmAuditedBrowserSipCall("command-1", attempt.attempt, {
      confirmationTimeoutMs: 30,
      // Windows timer scheduling can exceed a 12 ms budget before the retry
      // following the deliberately injected transient failure even begins.
      graceTimeoutMs: 75,
      pollMs: 1,
    });

    await vi.waitFor(() => expect(commandReads).toBe(1));
    attempt.settle({ outcome: "ended_before_answer" });

    await expect(confirmation).rejects.toThrow("Stav je obnovený");
    expect(commandReads).toBeGreaterThanOrEqual(3);
    expect(fetchMock).toHaveBeenCalledWith("/api/telephony/call/create", expect.objectContaining({
      method: "PATCH",
    }));
  });

  it("fails closed on confirmation timeout without claiming the still-ringing INVITE was not sent", async () => {
    const fetchMock = vi.fn(async () => {
      return jsonResponse({ command: { id: "command-1", status: "accepted" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const attempt = createBrowserSipCallAttempt();

    await expect(confirmAuditedBrowserSipCall("command-1", attempt.attempt, fastOptions()))
      .rejects.toThrow("nový hovor zatiaľ nevytáčaj");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/telephony/call/create",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});

describe("telephony command polling deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives up on an endpoint that never responds instead of waiting forever", async () => {
    // The overall deadline used to be checked only between iterations, so a
    // single response that never arrived pinned every caller behind this
    // await: the module-wide busy lock, the availability spinner and the
    // waiting-call pickup all sit on it.
    const hung = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    }));
    vi.stubGlobal("fetch", hung);

    const receipt = await waitForTelephonyCommand("command-hung", { pollMs: 1, timeoutMs: 60 });

    expect(hung).toHaveBeenCalled();
    expect(receipt.timedOut).toBe(true);
    expect(receipt.status).toBe("queued");
  });

  it("reports an unconfirmed command rather than a failure after a timeout", async () => {
    const hung = (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    vi.stubGlobal("fetch", hung);

    const receipt = await waitForTelephonyCommand("command-hung", { pollMs: 1, timeoutMs: 60 });

    // A timeout must never be presented as "VIPTel rejected this", because the
    // provider may well have executed it.
    expect(() => requireConfirmedTelephonyCommand(receipt)).toThrow("zatiaľ nepotvrdil");
  });

  it("still honours a caller abort", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    }));

    const pending = waitForTelephonyCommand("command-abort", {
      pollMs: 1,
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort();

    await expect(pending).rejects.toThrow("zrušená");
  });
});

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function fastOptions() {
  return { confirmationTimeoutMs: 8, graceTimeoutMs: 8, pollMs: 1 };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
