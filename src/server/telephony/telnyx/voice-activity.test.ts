import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, CONNECTION_ID } from "@/test/telephony-harness";
import { processTelnyxEvent } from "./event-processor";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("passive speaker observations", () => {
  it("logs a burst from the exact allowed connection without DB work, provider operations or sweeps", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: true });
    const retained = vi.fn();
    for (let i = 0; i < 15; i++) {
      const event = h.envelope("conference.floor.changed", { connection_id: CONNECTION_ID, conference_id: "conf-observed", call_control_id: "cc-observed", from: "+421900111222" }, `speaker-${i}`);
      expect(await processTelnyxEvent({ ...h.deps, deferMaintenance: retained }, event)).toMatchObject({ status: 200, outcome: "ignored", claim: null, sessionId: null });
    }
    expect(h.db.log).toEqual([]);
    expect(h.telnyx.calls).toEqual([]);
    expect(retained).not.toHaveBeenCalled();
    expect(h.logs.filter(row => row.scope === "voice-activity")).toHaveLength(15);
    expect(JSON.stringify(h.logs)).not.toContain("+421900111222");
  });

  it("rejects foreign connections and does not promote a connectionless event into a verified observation", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const foreign = h.envelope("conference.floor.changed", { connection_id: "foreign" });
    expect(await h.process(foreign)).toMatchObject({ outcome: "unverified_connection" });
    const missing = h.envelope("conference.floor.changed", { connection_id: null });
    await h.process(missing);
    expect(h.logs.filter(row => row.scope === "voice-activity")).toEqual([]);
  });

  it("still completes older durable floor observations during ledger replay", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const event = h.envelope("conference.floor.changed", { connection_id: CONNECTION_ID }, "older-speaker");
    await processTelnyxEvent({ ...h.deps, ledgerReplay: "cron" }, event);
    expect(h.db.log.length).toBeGreaterThan(0);
    expect(h.logs.filter(row => row.scope === "voice-activity")).toEqual([]);
  });

  it("does not ask the provider to retry when optional runtime logging fails", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    expect(await processTelnyxEvent({ ...h.deps, logger: () => { throw new Error("logger unavailable"); } },
      h.envelope("conference.floor.changed", { connection_id: CONNECTION_ID }))).toMatchObject({ status: 200, outcome: "ignored" });
    expect(h.db.log).toEqual([]);
  });
});
