import { describe, expect, it } from "vitest";

import { manualRunId, payloadHash, retryDelayMs, scheduledRunId, scheduledSlot, stableStringify } from "./schedule";

describe("production job scheduling", () => {
  it("maps every timestamp in an interval to the same UTC slot", () => {
    const schedule = { everyMs: 5 * 60_000, offsetMs: 4 * 60_000 };
    expect(scheduledSlot(Date.parse("2026-07-14T12:08:59.999Z"), schedule).toISOString()).toBe("2026-07-14T12:04:00.000Z");
    expect(scheduledSlot(Date.parse("2026-07-14T12:09:00.000Z"), schedule).toISOString()).toBe("2026-07-14T12:09:00.000Z");
  });

  it("creates stable but job-specific UUID run IDs", () => {
    const slot = new Date("2026-07-14T12:09:00.000Z");
    const first = scheduledRunId("fleet.commander.positions", slot);
    expect(scheduledRunId("fleet.commander.positions", slot)).toBe(first);
    expect(scheduledRunId("fleet.commander.catalog", slot)).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("ties manual runs to the idempotency key and job", () => {
    expect(manualRunId("notifications.materialize", "abc")).toBe(manualRunId("notifications.materialize", "abc"));
    expect(manualRunId("notifications.materialize", "abc")).not.toBe(manualRunId("notifications.materialize", "def"));
  });

  it("hashes object payloads independently of key order", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(payloadHash({ b: 2, a: 1 })).toBe(payloadHash({ a: 1, b: 2 }));
  });

  it("caps exponential retry delay", () => {
    expect(retryDelayMs(1)).toBe(15_000);
    expect(retryDelayMs(2)).toBe(30_000);
    expect(retryDelayMs(20)).toBe(15 * 60_000);
  });
});
