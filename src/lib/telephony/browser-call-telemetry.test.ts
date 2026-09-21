import { describe, expect, it } from "vitest";
import { BrowserCallTelemetry, BROWSER_CALL_BATCH_LIMIT, prepareBrowserCallHeartbeat, readBrowserCallObservations } from "./browser-call-telemetry";

const ID = "11111111-1111-4111-8111-111111111111";
const observation = { id: ID, pageId: ID, callControlId: "v3:opaque-control", phase: "sdk_invite", atMs: 12.4 };

describe("browser call observations", () => {
  it("preserves the original heartbeat if optional telemetry initialization fails", () => {
    const body = JSON.stringify({ deviceSessionId: "current", registrationState: "registered" });
    const prepared = prepareBrowserCallHeartbeat(body, () => { throw new Error("crypto unavailable"); });
    expect(prepared.body).toBe(body);
    expect(() => prepared.acknowledge()).not.toThrow();
  });
  it("allowlists finite data, bounds batches, strips arbitrary private text and deduplicates IDs", () => {
    expect(readBrowserCallObservations([{ ...observation, token: "secret", phone: "+421900111111", outcome: "arbitrary" }, observation]))
      .toEqual([{ ...observation, atMs: 12 }]);
    for (const invalid of [{ atMs: Infinity }, { atMs: -1 }, { phase: "arbitrary" }, { callControlId: "\nprivate text" }, { id: "wrong" }, { pageId: "wrong" }]) {
      expect(readBrowserCallObservations([{ ...observation, ...invalid }])).toEqual([]);
    }
    const entries = Array.from({ length: 100 }, (_, index) => ({ ...observation, id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` }));
    expect(readBrowserCallObservations(entries)).toHaveLength(BROWSER_CALL_BATCH_LIMIT);
  });

  it("retains the first UI commit across polls until the exact actor leg becomes known", () => {
    let now = 100;
    const queue = new BrowserCallTelemetry(() => now);
    queue.observeVisible([{ sessionId: "session" }]);
    now = 600;
    queue.record("control", "sdk_invite");
    now = 900;
    queue.observeVisible([{ sessionId: "session", browserIncomingCallControlIds: ["control"] }]);
    now = 1100;
    queue.observeVisible([{ sessionId: "session", browserIncomingCallControlIds: ["control"] }]);
    expect(queue.batch().map(({ phase, atMs }) => ({ phase, atMs }))).toEqual([
      { phase: "sdk_invite", atMs: 600 }, { phase: "ui_first_seen", atMs: 100 },
    ]);
    expect(new Set(queue.batch().map(row => row.pageId)).size).toBe(1);
  });

  it("keeps an unacknowledged batch stable and does not discard events arriving during a heartbeat", () => {
    const queue = new BrowserCallTelemetry(() => 100);
    queue.record("control", "sdk_invite");
    const pending = queue.batch();
    queue.record("control", "sdk_invite");
    expect(queue.batch()).toEqual(pending);
    queue.record("control", "ringtone_start", { outcome: "failed", durationMs: 3 });
    queue.record("control", "ringtone_start", { outcome: "ok", durationMs: 5 });
    queue.acknowledge(pending);
    expect(queue.batch().map(row => row.outcome)).toEqual(["failed", "ok"]);
  });

  it("bounds offline memory and each transport batch", () => {
    const queue = new BrowserCallTelemetry(() => 100);
    for (let index = 0; index < 1000; index++) queue.record(`control-${index}`, "sdk_invite");
    const all = [];
    while (queue.batch().length) {
      const batch = queue.batch();
      expect(batch.length).toBeLessThanOrEqual(BROWSER_CALL_BATCH_LIMIT);
      all.push(...batch);
      queue.acknowledge(batch);
    }
    expect(all).toHaveLength(64);
  });
});
