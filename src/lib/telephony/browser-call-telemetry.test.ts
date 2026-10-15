import { describe, expect, it } from "vitest";
import { BrowserCallTelemetry, BROWSER_CALL_BATCH_LIMIT, prepareBrowserCallHeartbeat, readBrowserCallObservations } from "./browser-call-telemetry";

const ID = "11111111-1111-4111-8111-111111111111";
const observation = { id: ID, pageId: ID, callControlId: "v3:opaque-control", phase: "sdk_invite", atMs: 12.4 };

describe("browser call observations", () => {
  it("preserves the original heartbeat if optional telemetry initialization fails", () => {
    const body = JSON.stringify({ deviceSessionId: "current", registrationState: "registered" });
    const prepared = prepareBrowserCallHeartbeat(body, () => { throw new Error("crypto unavailable"); });
    expect(prepared.body).toBe(body);
    expect(prepared).not.toHaveProperty("acknowledge");
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
    expect(queue.droppedCount()).toBe(936);
  });
  it("retains distinct answer attempts on the same leg so human retry waiting cannot masquerade as latency", () => {
    let now=1000; const queue=new BrowserCallTelemetry(()=>now);
    queue.record("control","answer_requested",{answerMode:"manual"});
    now=61000; queue.record("control","answer_requested",{answerMode:"manual"});
    now=61500; queue.record("control","sdk_active"); queue.record("control","sdk_active");
    expect(queue.batch().map(row=>[row.phase,row.atMs])).toEqual([
      ["answer_requested",1000],["answer_requested",61000],["sdk_active",61500],
    ]);
    expect(queue.batch().every(row=>row.clientBuild)).toBe(true);
  });

  it("counts observations which expired before correlation instead of silently losing them", () => {
    let now = 0;
    const queue = new BrowserCallTelemetry(() => now);
    queue.record("old", "sdk_invite");
    now = 600_001;
    queue.record("current", "sdk_invite");
    expect(queue.batch().map(entry => entry.callControlId)).toEqual(["current"]);
    expect(queue.droppedCount()).toBe(1);
    queue.acknowledgeDropped(1);
    expect(queue.droppedCount()).toBe(0);
  });

  it("expires by enqueue time, preserving a first UI observation from a long waiting call", () => {
    let now = 0;
    const queue = new BrowserCallTelemetry(() => now);
    queue.observeVisible([{ sessionId: "waiting" }]);
    now = 900_000;
    queue.observeVisible([{ sessionId: "waiting", browserIncomingCallControlIds: ["new-leg"] }]);
    expect(queue.batch()[0]).toMatchObject({ phase: "ui_first_seen", atMs: 0 });
    expect(queue.droppedCount()).toBe(0);
  });
});
