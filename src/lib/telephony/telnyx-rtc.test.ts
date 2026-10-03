import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelnyxRTC } from "./telnyx-rtc";

// Exercise the real 2.27.10 Connection, VertoHandler and keepalive timer.
// The socket only records messages; no credentials or provider are contacted.
type Socket = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
type SessionInternals = {
  _triggerKeepAliveTimeoutCheck(): void;
  _onSocketMessage(message: unknown): void;
};

let client: TelnyxRTC;
let socket: Socket;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("navigator", { userAgent: "SDK regression fixture" });
  const storage = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("localStorage", storage);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  client = new TelnyxRTC({ login_token: "fixture", keepConnectionAliveOnSocketClose: true });
  socket = { readyState: 1, send: vi.fn(), close: vi.fn(() => { socket.readyState = 3; }) };
  Object.assign(client.connection, { _wsClient: socket, socketGeneration: 1 });
});

afterEach(async () => {
  await client.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function internals() { return client as unknown as SessionInternals; }
function request(method: string) {
  return { request: { jsonrpc: "2.0", id: crypto.randomUUID(), method, params: {} } } as Parameters<TelnyxRTC["execute"]>[0];
}

describe("Telnyx SDK keepalive rejection handling", () => {
  it.each(["server-ping", "keepalive-timer"])("consumes stale %s requests during socket replacement", async (source) => {
    if (source === "server-ping") {
      internals()._onSocketMessage({ jsonrpc: "2.0", id: "server-ping", method: "telnyx_rtc.ping", params: {} });
    } else {
      internals()._triggerKeepAliveTimeoutCheck();
      await vi.advanceTimersByTimeAsync(35_000);
    }
    expect(socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.send.mock.calls[0][0]).method).toBe("telnyx_rtc.ping");
    // connect() increments this generation before cancelling old requests.
    client.connection.socketGeneration++;
    client.connection.close();
    await vi.advanceTimersByTimeAsync(0);
    // Vitest fails this test on an unhandled rejection from the real SDK.
  });

  it("still triggers SDK signaling recovery for an unanswered keepalive", async () => {
    const recover = vi.spyOn(client, "socketDisconnect");
    const warning = vi.fn();
    client.on("telnyx.warning", warning);
    internals()._onSocketMessage({ jsonrpc: "2.0", id: "server-ping", method: "telnyx_rtc.ping", params: {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ warning: expect.objectContaining({ code: 36003 }) }));
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("preserves a keepalive rejection for callers that await its result", async () => {
    const pending = client.execute(request("telnyx_rtc.ping"));
    const rejected = expect(pending).rejects.toMatchObject({ name: "StaleRequestError", staleGeneration: 1, currentGeneration: 2 });
    client.connection.socketGeneration++;
    client.connection.close();
    await rejected;
  });

  it("preserves non-keepalive request failures", async () => {
    const pending = client.execute(request("telnyx_rtc.modify"));
    const rejected = expect(pending).rejects.toMatchObject({ name: "StaleRequestError" });
    client.connection.close();
    await rejected;
  });
});
