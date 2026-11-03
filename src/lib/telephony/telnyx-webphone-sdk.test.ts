import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelnyxRTC } from "./telnyx-rtc";
import { TelnyxWebphone } from "./telnyx-webphone";

// Keep the real SDK event dispatcher and reconnect policy. Only browser media,
// HTTP and the physical socket are replaced; no provider is contacted.
type Socket = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onerror?: (event: Event) => void;
  onclose?: (event: { code: number; reason: string; wasClean: boolean }) => void;
};

let phone: TelnyxWebphone;
let client: TelnyxRTC;
let socket: Socket;

beforeEach(async () => {
  vi.useFakeTimers();
  const storage = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    visibilityState: "visible",
    body: { appendChild: vi.fn() },
    createElement: () => Object.assign(new EventTarget(), {
      style: {}, setAttribute: vi.fn(), pause: vi.fn(), remove: vi.fn(),
    }),
  }));
  vi.stubGlobal("navigator", { userAgent: "SDK lifecycle regression fixture" });
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("localStorage", storage);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  client = new TelnyxRTC({ login_token: "fixture", keepConnectionAliveOnSocketClose: true, maxReconnectAttempts: 5 });
  socket = { readyState: 1, send: vi.fn(), close: vi.fn(() => { socket.readyState = 3; }) };
  Object.assign(client.connection, { _wsClient: socket, socketGeneration: 1 });
  (client.connection as unknown as { _registerSocketEvents(socket: Socket): void })._registerSocketEvents(socket);
  phone = new TelnyxWebphone({
    silent: true,
    createClient: () => client,
    requestJson: async url => ({ ok: true, status: 200, body: url.includes("/token") ? {
      token: "fixture", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      deviceSessionId: "device-fixture", sipUsername: "fixture",
    } : { ok: true } }) as never,
  });
  phone.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(phone.getSnapshot().status).toBe("connecting");
});

afterEach(async () => {
  phone?.stop();
  await client?.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("real Telnyx SDK event dispatch during phone shutdown", () => {
  it.each(["error", "close"])("finishes a socket %s event after nested reconnect exhaustion retires the client", async kind => {
    // Socket listeners run in reverse registration order: the SDK handles this
    // event first, emits fatal 45003, and synchronously retires our controller.
    Object.assign(client, { _reconnectAttempts: 5 });
    const disconnect = vi.spyOn(client, "disconnect");
    expect(() => {
      if (kind === "error") socket.onerror?.(new Event("error"));
      else socket.onclose?.({ code: 1006, reason: "", wasClean: false });
    }).not.toThrow();
    expect(phone.getSnapshot()).toMatchObject({ status: "failed", call: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(client.hasAutoReconnect()).toBe(false);
  });
});
