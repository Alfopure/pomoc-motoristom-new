import { describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, LINES, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { createRateLimiter, startOutboundCall } from "./call-actions";

describe("outbound setup latency", () => {
  it("uses the configured caller ID's line settings when the operator has no personal default", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_operator_telephony_settings", { default_from_line_id: null }, (row) => row.profile_id === PROFILES.o1);
    const call = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() },
      { profileId: PROFILES.o1, role: "dispatcher" }, { to: NUMBERS.customer });

    expect(call.from).toBe(NUMBERS.allianz);
    expect(h.session(call.sessionId)).toMatchObject({ line_id: LINES.allianz, metadata: expect.objectContaining({ line_label: expect.any(String) }) });
  });

  it("loads independent guards while settings are pending, without dialling before they pass", async () => {
    const h = createTelephonyHarness();
    const from = h.client.from.bind(h.client);
    let release!: () => void;
    const settingsReady = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(h.client, "from").mockImplementation((table) => {
      const query = from(table);
      if (table === "motorist_telephony_settings") {
        const then = query.then.bind(query);
        query.then = (fulfilled, rejected) => settingsReady.then(() => then(fulfilled, rejected));
      }
      return query;
    });
    const dialling = startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() },
      { profileId: PROFILES.o1, role: "dispatcher" }, { to: NUMBERS.customer });

    try {
      await vi.waitFor(() => {
        expect(h.db.log.some((entry) => entry.table === "motorist_resolve_callback_target")).toBe(true);
        expect(h.db.log.some((entry) => entry.table === "motorist_telephony_daily_usage")).toBe(true);
        expect(h.db.log.some((entry) => entry.table === "motorist_operator_devices")).toBe(true);
        expect(h.db.log.some((entry) => entry.table === "motorist_telephony_lines")).toBe(true);
      });
      expect(h.rows("motorist_call_sessions")).toHaveLength(0);
      expect(h.telnyx.of("dial")).toHaveLength(0);
      expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
      // The measurement must include preflight, which used to be excluded.
      h.advance(250);
      release();
      await dialling;
      expect(h.telnyx.of("dial")).toHaveLength(1);
      expect(h.db.log.filter((entry) => entry.table === "motorist_telephony_settings" && entry.operation === "select")).toHaveLength(1);
      expect(h.logs.find((entry) => entry.action === "start_outbound")).toMatchObject({ preflightMs: 250, ms: 250 });
    } finally {
      release();
      await dialling.catch(() => undefined);
      spy.mockRestore();
    }
  });

  it("does not reserve or dial if one parallel guard fails", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_settings", { daily_leg_soft_cap: 1 }, () => true);
    h.db.seed("motorist_telephony_daily_usage", [{ organization_id: h.deps.organizationId, day: "2026-09-03", legs: 1 }]);

    await expect(startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() },
      { profileId: PROFILES.o1, role: "dispatcher" }, { to: NUMBERS.customer }))
      .rejects.toMatchObject({ code: "daily_cap_reached" });

    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
  });
});
