import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
const origin = "https://dispatch-copy.example";
const callSessionId = "4d821f21-cf1c-4a12-aa04-36f64c3eab96";

afterEach(() => vi.useRealTimers());

type AcknowledgementPort = { postMessage: (message: unknown) => void };
type TestClient = {
  url: string;
  focus: () => Promise<unknown>;
  postMessage: (message: unknown, ports?: AcknowledgementPort[]) => void;
  navigate?: (url: string) => Promise<unknown>;
};

class TestMessageChannel {
  port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() };
  port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() };
}

function workerFixture(windows: TestClient[] = []) {
  const handlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const showNotification = vi.fn<(title: string, options: Record<string, unknown>) => Promise<void>>(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const context = vm.createContext({
    URL,
    MessageChannel: TestMessageChannel,
    setTimeout,
    clearTimeout,
    self: {
      location: { origin },
      addEventListener: (name: string, callback: typeof handlers[string]) => { handlers[name] = callback; },
      registration: { showNotification },
      clients: { matchAll: vi.fn(async () => windows), openWindow },
    },
  });
  vm.runInContext(source, context);
  async function dispatch(name: string, event: Record<string, unknown>) {
    let completion: Promise<unknown> = Promise.resolve();
    handlers[name]!({ ...event, waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
    await completion;
  }
  return { dispatch, showNotification, openWindow };
}

describe("service worker push delivery", () => {
  it.each(["incoming_call", "available_call"])("shows %s with an exact safe call link", async (callKind) => {
    const fixture = workerFixture();
    await fixture.dispatch("push", { data: { json: () => ({ title: "Hovor", body: "Nový hovor.", url: `/?call=${callSessionId}`, callSessionId, callKind, expiresAt: "2099-01-01T00:00:00Z" }) } });
    expect(fixture.showNotification).toHaveBeenCalledWith("Hovor", expect.objectContaining({ body: "Nový hovor.", data: { url: `${origin}/?call=${callSessionId}` } }));
  });

  it("still visibly displays an expired call push with a cautious message for Safari", async () => {
    const fixture = workerFixture();
    await fixture.dispatch("push", { data: { json: () => ({ title: "Prichádzajúci hovor", body: "Prijmite hovor", url: `/?call=${callSessionId}`, callSessionId, callKind: "incoming_call", expiresAt: "2000-01-01T00:00:00Z" }) } });
    expect(fixture.showNotification).toHaveBeenCalledOnce();
    expect(fixture.showNotification).toHaveBeenCalledWith("Prichádzajúci hovor", expect.objectContaining({ body: expect.stringContaining("už nemusí byť dostupný"), data: { url: `${origin}/?call=${callSessionId}` } }));
  });

  it.each([`/?call=${callSessionId}&task=task-1`, "/?call=not-a-uuid", `/?call=${callSessionId}&call=${callSessionId}`])("rejects ambiguous or invalid call URL %s", async (url) => {
    const fixture = workerFixture();
    await fixture.dispatch("push", { data: { json: () => ({ url }) } });
    expect(fixture.showNotification).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ data: { url: `${origin}/` } }));
  });
  it("displays a persistent task notification with sound and a safe deep link", async () => {
    const fixture = workerFixture();
    await fixture.dispatch("push", { data: { json: () => ({ title: "Nová úloha", body: "Bola ti pridelená úloha.", url: "/?task=task-1", tag: "notification-1", soundEnabled: true }) } });
    expect(fixture.showNotification).toHaveBeenCalledWith("Nová úloha", expect.objectContaining({
      body: "Bola ti pridelená úloha.", tag: "notification-1", silent: false, vibrate: [150, 70, 150], data: { url: `${origin}/?task=task-1` },
    }));
  });

  it("does not include vibration when the current device disables sound", async () => {
    const fixture = workerFixture();
    await fixture.dispatch("push", { data: { json: () => ({ soundEnabled: false }) } });
    const options = fixture.showNotification.mock.calls[0]![1];
    expect(options).toMatchObject({ silent: true });
    expect(options).not.toHaveProperty("vibrate");
  });

  it("handles missing or malformed payloads with a generic visible notification", async () => {
    const fixture = workerFixture();
    await fixture.dispatch("push", { data: { json: () => { throw new Error("invalid JSON"); } } });
    expect(fixture.showNotification).toHaveBeenCalledWith("Pomoc Motoristom", expect.objectContaining({ data: { url: `${origin}/` } }));
  });

  it.each(["https://untrusted.example/?task=1", "javascript:alert(1)", "/api/push/test", "/l/customer-token", "/?next=https://untrusted.example", "/?task=%3Cscript%3E"])("rejects unsafe notification destination %s", async (url) => {
    const fixture = workerFixture();
    await fixture.dispatch("push", { data: { json: () => ({ url }) } });
    expect(fixture.showNotification).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ data: { url: `${origin}/` } }));
  });
});

describe("notification opening", () => {
  it("opens the exact call through the acknowledged app without navigation or calling", async () => {
    const client = {
      url: `${origin}/`, focus: vi.fn(async () => undefined),
      postMessage: vi.fn((_message: unknown, ports?: AcknowledgementPort[]) => ports?.[0].postMessage({ handled: true })),
      navigate: vi.fn(async () => ({})),
    };
    const fixture = workerFixture([client]);
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: `/?call=${callSessionId}` } } });
    expect(client.postMessage).toHaveBeenCalledWith({ type: "PM_OPEN_CALL_NOTIFICATION", url: `${origin}/?call=${callSessionId}` }, [expect.objectContaining({ postMessage: expect.any(Function) })]);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(fixture.openWindow).not.toHaveBeenCalled();
  });

  it("does not misroute a call or navigate over an old app that only understands task notifications", async () => {
    vi.useFakeTimers();
    const client = {
      url: `${origin}/`, focus: vi.fn(async () => undefined),
      postMessage: vi.fn((message: unknown, ports?: AcknowledgementPort[]) => {
        if ((message as { type: string }).type === "PM_OPEN_NOTIFICATION") ports?.[0].postMessage({ handled: true });
      }),
      navigate: vi.fn(async () => ({})),
    };
    const fixture = workerFixture([client]);
    const opening = fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: `/?call=${callSessionId}` } } });
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    expect(client.navigate).not.toHaveBeenCalled();
    expect(fixture.openWindow).toHaveBeenCalledWith(`${origin}/?call=${callSessionId}`);
  });
  it("an acknowledged app keeps its unsaved-work dialog without navigating after the deadline", async () => {
    vi.useFakeTimers();
    const client = {
      url: `${origin}/`,
      focus: vi.fn(async () => undefined),
      postMessage: vi.fn((_message: unknown, ports?: AcknowledgementPort[]) => ports?.[0].postMessage({ handled: true })),
      navigate: vi.fn(async () => ({})),
    };
    const fixture = workerFixture([client]);
    const close = vi.fn();
    await fixture.dispatch("notificationclick", { notification: { close, data: { url: `${origin}/?task=task-1` } } });
    expect(close).toHaveBeenCalledOnce();
    expect(client.focus).toHaveBeenCalledOnce();
    expect(client.postMessage).toHaveBeenCalledWith({ type: "PM_OPEN_NOTIFICATION", url: `${origin}/?task=task-1` }, [expect.objectContaining({ postMessage: expect.any(Function) })]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(fixture.openWindow).not.toHaveBeenCalled();
  });

  it("navigates a signed-out or unhydrated root window to the task URL after a bounded acknowledgement wait", async () => {
    vi.useFakeTimers();
    const client = { url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn(), navigate: vi.fn(async () => ({})) };
    const fixture = workerFixture([client]);
    const opening = fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-after-login" } } });
    await vi.advanceTimersByTimeAsync(999);
    expect(client.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await opening;
    expect(client.navigate).toHaveBeenCalledWith(`${origin}/?task=task-after-login`);
    expect(fixture.openWindow).not.toHaveBeenCalled();
  });

  it("falls back to a new window when an unacknowledged window can no longer navigate", async () => {
    vi.useFakeTimers();
    const client = {
      url: `${origin}/`,
      focus: vi.fn(async () => undefined),
      postMessage: vi.fn((_message: unknown, ports?: AcknowledgementPort[]) => ports?.[0].postMessage({ handled: false })),
      navigate: vi.fn(async () => { throw new Error("window closed"); }),
    };
    const fixture = workerFixture([client]);
    const opening = fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-2" } } });
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    expect(fixture.openWindow).toHaveBeenCalledWith(`${origin}/?task=task-2`);
  });

  it("does not reuse customer location pages or another origin", async () => {
    const fixture = workerFixture([
      { url: `${origin}/l/customer`, focus: vi.fn(), postMessage: vi.fn() },
      { url: "https://untrusted.example/", focus: vi.fn(), postMessage: vi.fn() },
    ]);
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-2" } } });
    expect(fixture.openWindow).toHaveBeenCalledWith(`${origin}/?task=task-2`);
  });

  it("opens a new app if the existing window closed before focus", async () => {
    const fixture = workerFixture([{ url: `${origin}/`, focus: async () => { throw new Error("closed"); }, postMessage: vi.fn() }]);
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "https://untrusted.example/" } } });
    expect(fixture.openWindow).toHaveBeenCalledWith(`${origin}/`);
  });
});
