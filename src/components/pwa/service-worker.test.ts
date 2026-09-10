import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
const origin = "https://dispatch-copy.example";
const callSessionId = "4d821f21-cf1c-4a12-aa04-36f64c3eab96";

afterEach(() => vi.useRealTimers());

type AcknowledgementPort = { postMessage: (message: unknown) => void };
type TestClient = {
  id?: string;
  url: string;
  focus: () => Promise<unknown>;
  postMessage: (message: unknown, ports?: AcknowledgementPort[]) => void;
  navigate?: (url: string) => Promise<unknown>;
};

class TestMessageChannel {
  port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() };
  port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() };
}

type StoredNotification = { data: Record<string, unknown>; close: () => void; tag?: string };
function workerFixture(windows: TestClient[] = [], notifications: StoredNotification[] = []) {
  const handlers: Record<string, (event: Record<string, unknown>) => void> = {};
  const showNotification = vi.fn<(title: string, options: Record<string, unknown>) => Promise<void>>(async (_title, options) => {
    const notification: StoredNotification = { data: options.data as Record<string, unknown>, tag: options.tag as string, close: vi.fn(() => { const index = notifications.indexOf(notification); if (index >= 0) notifications.splice(index, 1); }) };
    notifications.push(notification);
  });
  const openWindow = vi.fn(async () => undefined);
  const context = vm.createContext({
    URL,
    crypto: webcrypto,
    MessageChannel: TestMessageChannel,
    setTimeout,
    clearTimeout,
    self: {
      location: { origin },
      addEventListener: (name: string, callback: typeof handlers[string]) => { handlers[name] = callback; },
      registration: { showNotification, getNotifications: async () => [...notifications] },
      clients: { matchAll: vi.fn(async () => windows), openWindow },
    },
  });
  vm.runInContext(source, context);
  async function dispatch(name: string, event: Record<string, unknown>) {
    let completion: Promise<unknown> = Promise.resolve();
    handlers[name]!({ ...event, waitUntil: (promise: Promise<unknown>) => { completion = promise; } });
    await completion;
  }
  return { dispatch, showNotification, openWindow, notifications };
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
  it("prefers an installed mobile client when Android shares its subscription with a browser tab", async () => {
    const client = (id: string, mobileApp: boolean) => ({ id, url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn((message: unknown, ports?: AcknowledgementPort[]) => ports?.[0].postMessage((message as { type: string }).type === "PM_CLIENT_CONTEXT" ? { mobileApp } : { handled: true })) });
    const web = client("web", false), mobile = client("mobile", true);
    const fixture = workerFixture([web, mobile]);
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: `/?call=${callSessionId}`, mobileApp: true } } });
    expect(mobile.focus).toHaveBeenCalledOnce();
    expect(web.focus).not.toHaveBeenCalled();
    expect(fixture.openWindow).not.toHaveBeenCalled();
  });
  it("opens the exact call through the acknowledged app without navigation or calling", async () => {
    const client = {
      url: `${origin}/`, focus: vi.fn(async () => undefined),
      postMessage: vi.fn((_message: unknown, ports?: AcknowledgementPort[]) => ports?.[0].postMessage({ handled: true })),
      navigate: vi.fn(async () => ({})),
    };
    const fixture = workerFixture([client]);
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: `/?call=${callSessionId}` } } });
    expect(client.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "PM_OPEN_CALL_NOTIFICATION", url: `${origin}/?call=${callSessionId}`, requestId: expect.any(String) }), [expect.objectContaining({ postMessage: expect.any(Function) })]);
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
    expect(fixture.openWindow).not.toHaveBeenCalled();
    expect(fixture.showNotification).toHaveBeenCalledWith("Pomoc Motoristom", expect.objectContaining({ data: expect.objectContaining({ url: `${origin}/?call=${callSessionId}` }) }));
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
    expect(client.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "PM_OPEN_NOTIFICATION", url: `${origin}/?task=task-1`, requestId: expect.any(String) }), [expect.objectContaining({ postMessage: expect.any(Function) })]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(fixture.openWindow).not.toHaveBeenCalled();
  });

  it.each(["task-after-login", "task-with-unsaved-draft"])("defers %s when its existing window is suspended beyond the ACK deadline", async (taskId) => {
    vi.useFakeTimers();
    const client = { id: "existing", url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn(), navigate: vi.fn(async () => ({})) };
    const fixture = workerFixture([client]);
    const opening = fixture.dispatch("notificationclick", { notification: { tag: "original-tag", close: vi.fn(), data: { url: `/?task=${taskId}` } } });
    await vi.advanceTimersByTimeAsync(999);
    expect(fixture.showNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await opening;
    expect(client.navigate).not.toHaveBeenCalled();
    expect(fixture.openWindow).not.toHaveBeenCalled();
    expect(fixture.showNotification).toHaveBeenCalledWith("Pomoc Motoristom", expect.objectContaining({ tag: "original-tag", silent: true, data: { url: `${origin}/?task=${taskId}`, clientId: "existing", requestId: expect.any(String) } }));
  });

  it("closes a deferred retry on late and duplicate ACKs, including after worker restart", async () => {
    vi.useFakeTimers();
    const client = { id: "draft-client", url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn(), navigate: vi.fn() };
    const fixture = workerFixture([client]);
    const opening = fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-1" } } });
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    const pending = fixture.notifications[0]!;
    const restarted = workerFixture([client], fixture.notifications);
    await restarted.dispatch("message", { source: { id: "another-client" }, data: { type: "PM_NOTIFICATION_ACK", requestId: pending.data.requestId } });
    expect(pending.close).not.toHaveBeenCalled();
    await restarted.dispatch("message", { source: client, data: { type: "PM_NOTIFICATION_ACK", requestId: pending.data.requestId } });
    await restarted.dispatch("message", { source: client, data: { type: "PM_NOTIFICATION_ACK", requestId: pending.data.requestId } });
    expect(pending.close).toHaveBeenCalledOnce();
    expect(client.navigate).not.toHaveBeenCalled();
    expect(restarted.openWindow).not.toHaveBeenCalled();
  });

  it("does not leave a retry behind when the late ACK races notification creation", async () => {
    vi.useFakeTimers();
    const client = { id: "draft-client", url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn<(message: unknown, ports?: AcknowledgementPort[]) => void>() };
    const fixture = workerFixture([client]);
    const show = fixture.showNotification.getMockImplementation()!;
    let completeShow!: () => void;
    const showing = new Promise<void>((resolve) => { completeShow = resolve; });
    fixture.showNotification.mockImplementation(async (title, options) => { await showing; await show(title, options); });
    const opening = fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-1" } } });
    await vi.advanceTimersByTimeAsync(1_000);
    const { requestId } = client.postMessage.mock.calls[0]![0] as { requestId: string };
    const acknowledging = fixture.dispatch("message", { source: client, data: { type: "PM_NOTIFICATION_ACK", requestId } });
    completeShow();
    await Promise.all([opening, acknowledging]);
    expect(fixture.notifications).toHaveLength(0);
    expect(fixture.openWindow).not.toHaveBeenCalled();
  });

  it("retries the same request only on an explicit tap after worker restart", async () => {
    vi.useFakeTimers();
    const client = { id: "draft-client", url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn<(message: unknown, ports?: AcknowledgementPort[]) => void>(), navigate: vi.fn() };
    const first = workerFixture([client]);
    const opening = first.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-1" } } });
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    const pending = first.notifications[0]!;
    const restarted = workerFixture([client], first.notifications);
    client.postMessage.mockImplementation((_message, ports) => ports?.[0].postMessage({ handled: true }));
    await restarted.dispatch("notificationclick", { notification: pending });
    expect(client.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: pending.data.requestId, url: `${origin}/?task=task-1` }), [expect.objectContaining({ postMessage: expect.any(Function) })]);
    expect(restarted.showNotification).not.toHaveBeenCalled();
    expect(client.navigate).not.toHaveBeenCalled();
  });

  it("retains a visible retry when an old client cannot receive the message", async () => {
    const client = { id: "old", url: `${origin}/`, focus: vi.fn(async () => undefined),
      postMessage: vi.fn(() => { throw new Error("client cannot receive"); }), navigate: vi.fn() };
    const fixture = workerFixture([client]);
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-2" } } });
    expect(fixture.notifications).toHaveLength(1);
    expect(client.navigate).not.toHaveBeenCalled();
    expect(fixture.openWindow).not.toHaveBeenCalled();
  });

  it("keeps a retry with its original live client when another tab becomes first", async () => {
    vi.useFakeTimers();
    const original = { id: "suspended", url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn<(message: unknown, ports?: AcknowledgementPort[]) => void>() };
    const first = workerFixture([original]);
    const opening = first.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-1" } } });
    await vi.advanceTimersByTimeAsync(1_000);
    await opening;
    const pending = first.notifications[0]!;
    const other = { id: "foreground", url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    const restarted = workerFixture([other, original], first.notifications);
    original.postMessage.mockImplementation((_message, ports) => ports?.[0].postMessage({ handled: true }));
    await restarted.dispatch("notificationclick", { notification: pending });
    expect(original.postMessage).toHaveBeenCalledTimes(2);
    expect(original.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: pending.data.requestId });
    expect(other.focus).not.toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(restarted.openWindow).not.toHaveBeenCalled();
  });

  it.each(["focus-fails", "login"])("does not reassign a live retry when its original client %s", async (mode) => {
    const original = { id: "original", url: `${origin}/${mode === "login" ? "login" : ""}`, focus: vi.fn(async () => { throw new Error("suspended"); }), postMessage: vi.fn() };
    const other = { id: "other", url: `${origin}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    const fixture = workerFixture([other, original]);
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-1", clientId: "original", requestId: "retry-original" } } });
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(fixture.openWindow).not.toHaveBeenCalled();
    expect(fixture.notifications[0]?.data).toMatchObject({ clientId: "original", requestId: "retry-original" });
  });

  it("can cold-start a retry after its original document has closed", async () => {
    const fixture = workerFixture();
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-1", clientId: "closed", requestId: "retry-closed" } } });
    expect(fixture.openWindow).toHaveBeenCalledWith(`${origin}/?task=task-1`);
  });

  it("cold-starts an exact task URL so login can preserve the target", async () => {
    const fixture = workerFixture();
    await fixture.dispatch("notificationclick", { notification: { close: vi.fn(), data: { url: "/?task=task-after-login&next=https://untrusted.example" } } });
    expect(fixture.openWindow).toHaveBeenCalledWith(`${origin}/?task=task-after-login`);
    expect(fixture.showNotification).not.toHaveBeenCalled();
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

describe("private API cache boundary", () => {
  it.each(["/api/notifications", "/api/notes", "/api/tasks/task-1/messages", "/api/cases/case-1/pdf"])("never intercepts private content at %s", async (path) => {
    const fixture = workerFixture();
    const respondWith = vi.fn();
    await fixture.dispatch("fetch", { request: new Request(`${origin}${path}`), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });
});
