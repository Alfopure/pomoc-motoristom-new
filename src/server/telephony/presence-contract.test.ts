import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { effectivePresenceStatus } from "@/lib/telephony/presence-policy";
import { endWrapUp, setPresence } from "./presence-service";
import { authorizeOperatorDispatch, releaseOperator, releaseOperatorPresence, reserveOperatorPickup, transitionPresence } from "./routing/reservation";

const SESSION = "00000000-0000-4000-8000-000000009901";
const OTHER = "00000000-0000-4000-8000-000000009902";
const REASON = "00000000-0000-4000-8000-000000002501";

function setup() {
  const h = createTelephonyHarness();
  for (const id of [SESSION, OTHER]) h.db.insert("motorist_call_sessions", { id, organization_id: ORG, state: "waiting" });
  return h;
}
const own = { organizationId: ORG, profileId: PROFILES.o1 };
afterEach(() => vi.unstubAllEnvs());

describe("v1 presence workflow (fake DB; real concurrency separately tested in PostgreSQL)", () => {
  it("blocks selected automatic dispatch after pause and preserves pause after a stale release", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = setup();
    const offered = await authorizeOperatorDispatch(h.admin, { ...own, sessionId: SESSION });
    expect(offered.applied).toBe(true);
    const paused = await setPresence(h.deps, { ...own, status: "paused", pauseReasonId: REASON });
    expect(paused.status).toBe("paused");
    expect(h.db.find("motorist_call_sessions", r => r.id === SESSION)?.presence_cancellations).toHaveProperty(offered.offerToken!);
    expect((await authorizeOperatorDispatch(h.admin, { ...own, sessionId: OTHER })).applied).toBe(false);
    expect((await transitionPresence(h.admin, { ...own, sessionId: SESSION, action: "answer", expectedToken: offered.offerToken })).applied).toBe(false);
    expect((await releaseOperatorPresence(h.admin, { ...own, sessionId: SESSION, status: "available", expectedToken: offered.offerToken, expectedRevision: offered.revision })).applied).toBe(false);
    expect(h.db.find("motorist_operator_presence", r => r.profile_id === own.profileId)).toMatchObject({ status: "paused", pause_reason_id: REASON, presence_revision: paused.presence_revision });
  });

  it("keeps saved pause and due cancellation when immediate targeted recovery fails", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = setup();
    await authorizeOperatorDispatch(h.admin, { ...own, sessionId: SESSION });
    const recover = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    expect(await setPresence({ ...h.deps, onOfferCancelled: recover }, { ...own, status: "paused", pauseReasonId: REASON })).toMatchObject({ status: "paused", pause_reason_id: REASON });
    expect(recover).toHaveBeenCalledWith(SESSION);
    expect(h.db.find("motorist_call_sessions", r => r.id === SESSION)?.cancellations_next_attempt_at).toBe(h.now().toISOString());
  });

  it("preserves answered ownership when the manual pause loses", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = setup();
    const offered = await authorizeOperatorDispatch(h.admin, { ...own, sessionId: SESSION });
    expect((await transitionPresence(h.admin, { ...own, sessionId: SESSION, action: "answer", expectedToken: offered.offerToken })).applied).toBe(true);
    await expect(setPresence(h.deps, { ...own, status: "paused" })).rejects.toMatchObject({ status: 409 });
  });

  it("reserves exactly one paused pickup and honors its return after admission is disabled", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = setup();
    await setPresence(h.deps, { ...own, status: "paused", pauseReasonId: REASON });
    const pickup = await reserveOperatorPickup(h.admin, { ...own, sessionId: SESSION });
    expect(pickup.applied).toBe(true);
    expect((await reserveOperatorPickup(h.admin, { ...own, sessionId: SESSION })).reused).toBe(true);
    expect((await reserveOperatorPickup(h.admin, { ...own, sessionId: OTHER })).applied).toBe(false);
    expect((await reserveOperatorPickup(h.admin, { ...own, profileId: PROFILES.o2, sessionId: SESSION })).applied).toBe(false);
    expect((await authorizeOperatorDispatch(h.admin, { ...own, sessionId: OTHER })).applied).toBe(false);
    await transitionPresence(h.admin, { ...own, sessionId: SESSION, action: "answer", expectedToken: pickup.offerToken });
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const until = new Date(h.now().getTime() + 30_000).toISOString();
    expect(await releaseOperator(h.admin, { ...own, sessionId: SESSION, status: "after_call_work", wrapUpUntil: until, expectedToken: pickup.offerToken! })).toBe(true);
    h.advance(31_000);
    const pending = h.db.find("motorist_operator_presence", r => r.profile_id === own.profileId)!;
    expect(effectivePresenceStatus({ status: "after_call_work", wrap_up_until: until, pause_return: pending.pause_return }, h.now())).toBe("paused");
    expect((await authorizeOperatorDispatch(h.admin, { ...own, sessionId: OTHER })).applied).toBe(false);
    expect(await endWrapUp(h.deps, own)).toMatchObject({ status: "paused", pause_reason_id: REASON, current_session_id: null, pause_return: null });
    const history = h.rows("motorist_operator_statuses").filter(r => r.profile_id === own.profileId);
    expect(history.map(r => r.status)).toEqual(["paused", "ringing", "on_call", "after_call_work", "paused"]);
  });

  it.each(["available", "after_call_work"] as const)("returns failure / zero wrap-up directly to pause for %s release", async (status) => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = setup();
    await setPresence(h.deps, { ...own, status: "paused", pauseReasonId: REASON });
    const pickup = await reserveOperatorPickup(h.admin, { ...own, sessionId: SESSION });
    const result = await releaseOperatorPresence(h.admin, { ...own, sessionId: SESSION, status, expectedToken: pickup.offerToken });
    expect(result.presence).toMatchObject({ status: "paused", pause_reason_id: REASON, offer_token: null, pause_return: null });
  });
});
