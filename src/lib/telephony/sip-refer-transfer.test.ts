import { describe, expect, it, vi } from "vitest";

import {
  sendSipReferAndAwaitAcceptance,
  sipFragStatus,
  type SipReferNotification,
  type SipReferSession,
} from "./sip-refer-transfer";

describe("browser SIP REFER transfer", () => {
  it("waits for the PBX 2xx response instead of treating a socket send as success", async () => {
    let accept: ((response: { message: { statusCode?: number } }) => void) | undefined;
    let notify: ((notification: SipReferNotification) => void) | undefined;
    const session: SipReferSession = {
      refer: vi.fn(async (_target, options) => {
        accept = options.requestDelegate.onAccept;
        notify = options.onNotify;
      }),
    };
    const transfer = sendSipReferAndAwaitAcceptance(session, {}, { timeoutMs: 1_000 });
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    accept?.({ message: { statusCode: 202 } });
    notify!({
      accept: vi.fn(async () => undefined),
      request: { body: "SIP/2.0 100 Trying" },
    });
    notify!({
      accept: vi.fn(async () => undefined),
      request: { body: "SIP/2.0 200 OK" },
    });
    await expect(transfer).resolves.toEqual({ accepted: true, statusCode: 200 });
  });

  it("surfaces an explicit PBX rejection", async () => {
    const session: SipReferSession = {
      refer: vi.fn(async (_target, options) => {
        options.requestDelegate.onReject({ message: { statusCode: 403 } });
      }),
    };
    await expect(sendSipReferAndAwaitAcceptance(session, {})).rejects.toThrow("SIP 403");
  });

  it("surfaces a failed final refer notification", async () => {
    const session: SipReferSession = {
      refer: vi.fn(async (_target, options) => {
        options.requestDelegate.onAccept({ message: { statusCode: 202 } });
        options.onNotify({
          accept: vi.fn(async () => undefined),
          request: { body: "SIP/2.0 486 Busy Here" },
        });
      }),
    };
    await expect(sendSipReferAndAwaitAcceptance(session, {})).rejects.toThrow("SIP 486");
  });

  it("fails safely when no final response arrives", async () => {
    vi.useFakeTimers();
    try {
      const session: SipReferSession = { refer: vi.fn(async () => undefined) };
      const transfer = sendSipReferAndAwaitAcceptance(session, {}, { timeoutMs: 50 });
      const rejected = expect(transfer).rejects.toThrow("časovom limite");
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses only a valid SIP status fragment", () => {
    expect(sipFragStatus("SIP/2.0 200 OK")).toBe(200);
    expect(sipFragStatus("Event: refer\r\nSIP/2.0 486 Busy Here")).toBe(486);
    expect(sipFragStatus("200 OK")).toBeUndefined();
  });
});
