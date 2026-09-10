import { describe, expect, it, vi } from "vitest";
import { createNotificationNavigationReceiver } from "./notification-navigation";

const origin = "https://dispatch-copy.example";
const task = { type: "PM_OPEN_NOTIFICATION", url: "/?task=task-1", requestId: "receipt-1" };

function fixture() {
  let session: string | null = "organization:user-a";
  const order: string[] = [];
  const open = vi.fn(() => { order.push("draft-guard"); });
  const acknowledge = vi.fn(() => { order.push("worker-ack"); });
  const port = { postMessage: vi.fn(() => { order.push("port-ack"); }) };
  const receive = createNotificationNavigationReceiver({ origin, sessionKey: session, currentSessionKey: () => session, open, acknowledge });
  return { receive, port, open, acknowledge, order, setSession: (next: string | null) => { session = next; } };
}

describe("notification navigation receipt", () => {
  it("ACKs a delayed delivery before the unsaved-work guard and deduplicates explicit retries", () => {
    const f = fixture();
    expect(f.receive(task, f.port)).toBe(true);
    expect(f.order).toEqual(["port-ack", "worker-ack", "draft-guard"]);
    // The draft dialog may remain open indefinitely; retry/late ACK cannot
    // replace its pending action or run a second navigation.
    expect(f.receive(task, f.port)).toBe(true);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.acknowledge).toHaveBeenCalledTimes(2);
  });

  it.each([null, "organization:user-b"])("rejects a suspended receipt after session changes to %s", (session) => {
    const f = fixture();
    f.setSession(session);
    expect(f.receive(task, f.port)).toBe(false);
    expect(f.port.postMessage).not.toHaveBeenCalled();
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("still enters the draft guard when a timed-out message port is closed", () => {
    const f = fixture();
    expect(f.receive(task, { postMessage: () => { throw new Error("closed"); } })).toBe(true);
    expect(f.acknowledge).toHaveBeenCalledWith("receipt-1");
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("accepts an old worker's receipt without a request ID", () => {
    const f = fixture();
    expect(f.receive({ type: task.type, url: task.url }, f.port)).toBe(true);
    expect(f.open).toHaveBeenCalledWith(task.url);
    expect(f.acknowledge).not.toHaveBeenCalled();
  });

  it.each([
    { ...task, url: "https://untrusted.example/?task=1" },
    { ...task, url: "/?task=one&call=4d821f21-cf1c-4a12-aa04-36f64c3eab96" },
    { ...task, url: "/?call=4d821f21-cf1c-4a12-aa04-36f64c3eab96" },
    { ...task, type: "PM_OPEN_CALL_NOTIFICATION" },
  ])("rejects invalid or misclassified target $url", (message) => {
    const f = fixture();
    expect(f.receive(message, f.port)).toBe(false);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.port.postMessage).not.toHaveBeenCalled();
  });
});
