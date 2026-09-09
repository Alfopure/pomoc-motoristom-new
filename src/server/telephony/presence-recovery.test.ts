import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { reserveOperatorPickup, transitionPresence } from "./routing/reservation";
import { setPresence, sweepExpiredWrapUp } from "./presence-service";
import { sweepEndedSessionPresence } from "./presence-recovery";

const REASON = "00000000-0000-4000-8000-000000002501";
const own = { organizationId: ORG, profileId: PROFILES.o1 };
afterEach(() => vi.unstubAllEnvs());

async function setup(paused = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
  const h = createTelephonyHarness();
  if (paused) await setPresence(h.deps, { ...own, status: "paused", pauseReasonId: REASON });
  const sessionId = String(h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "waiting" })[0].id);
  const reservation = await reserveOperatorPickup(h.admin, { ...own, sessionId });
  await transitionPresence(h.admin, { ...own, sessionId, action: "answer", expectedToken: reservation.offerToken });
  h.db.update("motorist_call_sessions", { state: "ended", ended_at: h.now().toISOString() }, row => row.id === sessionId);
  h.db.insert("motorist_call_legs", { organization_id: ORG, session_id: sessionId, profile_id: PROFILES.o1,
    telnyx_call_control_id: "historical-owner", role: "operator", state: "ended", ended_at: h.now().toISOString() });
  return { h, sessionId, reservation };
}

describe("ended-session presence recovery", () => {
  it("releases an old owner exactly once and records audited history", async () => {
    const { h } = await setup();
    h.advance(300_000);
    expect(await sweepEndedSessionPresence(h.deps)).toMatchObject({ scanned: 1, released: 1, skipped: 0, errors: [] });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null, offer_token: null });
    const history = h.rows("motorist_operator_statuses");
    expect(history.at(-1)).toMatchObject({ status: "available", source: "cron", reason: expect.stringContaining("ended session presence recovery:") });
    expect(await sweepEndedSessionPresence(h.deps)).toMatchObject({ scanned: 0, released: 0 });
    expect(h.rows("motorist_operator_statuses")).toEqual(history);
    expect(h.telnyx.calls).toHaveLength(0);
  });

  it("preserves only the remaining wrap-up time and restores its saved pause", async () => {
    const { h, sessionId } = await setup(true);
    const end = h.now().getTime();
    h.advance(10_000);
    expect(await sweepEndedSessionPresence(h.deps)).toMatchObject({ released: 1 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "after_call_work", current_session_id: null,
      wrap_up_until: new Date(end + 30_000).toISOString(), pause_return: { sessionId, pauseReasonId: REASON } });
    h.advance(21_000);
    expect(await sweepExpiredWrapUp(h.deps)).toMatchObject({ applied: 1 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "paused", pause_reason_id: REASON, pause_return: null, offer_token: null });
    expect(h.rows("motorist_operator_statuses").filter(row => row.profile_id === PROFILES.o1).map(row => row.status)).not.toContain("available");
  });

  it("restores an overdue pause directly without restarting wrap-up", async () => {
    const { h } = await setup(true);
    h.advance(300_000);
    expect(await sweepEndedSessionPresence(h.deps)).toMatchObject({ released: 1 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "paused", pause_reason_id: REASON, wrap_up_until: null, current_session_id: null });
  });

  it.each(["active", "open_leg", "missing_end", "foreign_session"])("refuses an unproven terminal call: %s", async scenario => {
    const { h, sessionId } = await setup();
    if (scenario === "active") h.db.update("motorist_call_sessions", { state: "talking" }, row => row.id === sessionId);
    if (scenario === "open_leg") h.db.update("motorist_call_legs", { state: "answered", ended_at: null }, row => row.session_id === sessionId);
    if (scenario === "missing_end") h.db.update("motorist_call_sessions", { ended_at: null }, row => row.id === sessionId);
    if (scenario === "foreign_session") h.db.update("motorist_call_sessions", { organization_id: "00000000-0000-4000-8000-000000999999" }, row => row.id === sessionId);
    const before = h.presence(PROFILES.o1);
    expect(await sweepEndedSessionPresence(h.deps)).toMatchObject({ released: 0, skipped: 1, errors: [] });
    expect(h.presence(PROFILES.o1)).toEqual(before);
  });

  it.each(["paused", "offline", "new_owner", "revision_aba"])("does not overwrite a concurrent %s change", async scenario => {
    const { h } = await setup();
    h.advance(300_000);
    const original = h.db.rpcHandlers.get("motorist_presence_transition_v1")!;
    h.db.registerRpc("motorist_presence_transition_v1", (args, db) => {
      if (args.p_action === "release") {
        if (scenario === "paused" || scenario === "offline") db.update("motorist_operator_presence", { status: scenario, current_session_id: null, offer_token: null }, row => row.profile_id === PROFILES.o1);
        else if (scenario === "new_owner") db.update("motorist_operator_presence", { offer_token: "new-reservation-token" }, row => row.profile_id === PROFILES.o1);
        else {
          db.update("motorist_operator_presence", { status: "ringing" }, row => row.profile_id === PROFILES.o1);
          db.update("motorist_operator_presence", { status: "on_call" }, row => row.profile_id === PROFILES.o1);
        }
      }
      return original(args, db);
    });
    expect(await sweepEndedSessionPresence(h.deps)).toMatchObject({ released: 0, skipped: 1, errors: [] });
    expect(h.presence(PROFILES.o1).status).toBe(scenario === "paused" || scenario === "offline" ? scenario : "on_call");
    if (scenario === "new_owner") expect(h.presence(PROFILES.o1).offer_token).toBe("new-reservation-token");
  });

  it("surfaces database failures without changing presence", async () => {
    const { h } = await setup();
    h.db.failNext("motorist_call_legs", "select", "unavailable");
    expect(await sweepEndedSessionPresence(h.deps)).toMatchObject({ released: 0, errors: [{ profileId: PROFILES.o1, error: expect.stringContaining("unavailable") }] });
    expect(h.presence(PROFILES.o1).status).toBe("on_call");
  });
});
