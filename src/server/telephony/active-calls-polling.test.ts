import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { ACTIVE_CALLS_CACHE_TTL_MS, loadActiveCalls, loadActiveCallsCached, resetActiveCallsCache } from "./active-calls";

const who = (profileId: string) => ({ profileId, canManageAssignments: false });

beforeEach(() => resetActiveCallsCache());
afterEach(() => { resetActiveCallsCache(); vi.restoreAllMocks(); });

function view(h: TelephonyHarness) {
  return { admin: h.admin, organizationId: ORG, environment: h.deps.environment, configured: true, now: h.now };
}

const requests = (h: TelephonyHarness, from: number) => h.db.log.length - from;

describe("what a console poll costs", () => {
  it("serves every console in the same second from one database pass", async () => {
    const h = createTelephonyHarness();
    await h.inbound({ to: NUMBERS.allianz });

    const from = h.db.log.length;
    const first = await loadActiveCallsCached(view(h), who(PROFILES.o1));
    const one = requests(h, from);

    // Seven more consoles, same second, same organisation.
    const after = h.db.log.length;
    for (const profile of [PROFILES.o2, PROFILES.o3, PROFILES.o1, PROFILES.o2, PROFILES.o3, PROFILES.o1, PROFILES.o2]) {
      await loadActiveCallsCached(view(h), who(profile));
    }

    expect(one).toBeGreaterThan(1);
    expect(requests(h, after)).toBe(0);
    expect(first.calls.length).toBeGreaterThan(0);
  });

  it("still tells each console which call is theirs", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
    // The losers keep a leg of their own until they hang up, and a leg is one
    // of the things that makes a call yours.
    for (const leg of h.legs(call.sessionId)) {
      if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
        await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
      }
    }

    const mine = await loadActiveCallsCached(view(h), who(PROFILES.o1));
    const theirs = await loadActiveCallsCached(view(h), who(PROFILES.o2));

    // The rows are shared; the view is not. Getting this wrong would show one
    // operator another's call as their own.
    expect(mine.calls.find((row) => row.sessionId === call.sessionId)?.mine).toBe(true);
    expect(theirs.calls.find((row) => row.sessionId === call.sessionId)?.mine).toBe(false);
    expect(mine.actorProfileId).toBe(PROFILES.o1);
    expect(theirs.actorProfileId).toBe(PROFILES.o2);
  });

  it("reads again once the second is over", async () => {
    const h = createTelephonyHarness();
    await h.inbound({ to: NUMBERS.allianz });
    await loadActiveCallsCached(view(h), who(PROFILES.o1));

    h.advance(ACTIVE_CALLS_CACHE_TTL_MS);
    const from = h.db.log.length;
    await loadActiveCallsCached(view(h), who(PROFILES.o1));

    expect(requests(h, from)).toBeGreaterThan(1);
  });

  it("does not cache a failed pass", async () => {
    const h = createTelephonyHarness();
    h.db.failNext("motorist_call_sessions", "select", "sessions unavailable");

    await expect(loadActiveCallsCached(view(h), who(PROFILES.o1))).rejects.toThrow();

    // The next reader has to be allowed to try, not served the rejection for a
    // second.
    await expect(loadActiveCallsCached(view(h), who(PROFILES.o1))).resolves.toBeDefined();
  });

  it("asks for the stale-owner repair only when there is one", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = h.legFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");

    // Held by a call that is in the snapshot: nothing to repair.
    expect((await loadActiveCalls(view(h), who(PROFILES.o1))).ownPresenceStale).toBe(false);

    // Held by a call that is not: the trace of a call that ended without
    // releasing its owner, which the poll used to go looking for every time.
    const ended = String(h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "ended", ended_at: h.now().toISOString() })[0].id);
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: ended, offer_token: null });

    expect((await loadActiveCalls(view(h), who(PROFILES.o1))).ownPresenceStale).toBe(true);
  });
});
