import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { afterEach, describe, expect, it, vi } from "vitest";

import { colleagueBadge } from "@/lib/telephony/colleague-availability";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { blindTransfer, CallActionError, createRateLimiter, listTransferTargets, type CallActionDeps, type CallActor } from "./call-actions";

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const MOBILE = "+421905123456";

afterEach(() => { vi.unstubAllEnvs(); });

const deps = (h: TelephonyHarness): CallActionDeps => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });

function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness();
}

/** o2 takes their calls on their own phone and has no browser phone at all. */
function onPersonalMobile(h: TelephonyHarness, number: string | null = MOBILE) {
  h.db.insert("motorist_operator_telephony_settings", [{
    organization_id: ORG, profile_id: PROFILES.o2, delivery_mode: "personal_mobile", default_mobile_number: number,
    pause_routing_mode: "none", wrap_up_seconds: 30,
  }]);
  h.db.delete("motorist_operator_devices", (row) => row.profile_id === PROFILES.o2);
}

const dialsTo = (h: TelephonyHarness, number: string) => h.telnyx.of("dial").filter((dial) => dial.params.to === number).length;

async function fail(promise: Promise<unknown>): Promise<CallActionError> {
  try { await promise; } catch (error) {
    if (error instanceof CallActionError) return error;
    throw error;
  }
  throw new Error("expected a CallActionError");
}

/** Inbound call answered by o1 (losers hung up) → talking. */
async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    }
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  return call;
}

describe("transferring to a colleague who works from their phone", () => {
  it("dials their own number instead of demanding a browser phone", async () => {
    const h = harness();
    onPersonalMobile(h);
    const call = await talking(h);

    await completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 }));

    // Before this, the same transfer was refused with "Kolega nemá pripojený
    // telefón" — for a colleague whose calls were already routed to that
    // number by the ring plan.
    // Their own number is an owned PSTN leg, dialled rather than handed over,
    // so that the colleague is reserved the way any other offer reserves them.
    expect(h.telnyx.of("dial").at(-1)?.params.to).toBe(MOBILE);
    expect(dialsTo(h, MOBILE)).toBe(2); // the ring plan's, and this transfer's
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("still refuses a colleague who is on another call", async () => {
    const h = harness();
    onPersonalMobile(h);
    const call = await talking(h);
    h.setPresence(PROFILES.o2, { status: "on_call" });

    const error = await fail(completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 })));

    // The mobile changes where the call goes, not whether they can take it.
    expect(error).toMatchObject({ status: 409, code: "target_unavailable" });
    expect(h.telnyx.of("transfer")).toHaveLength(0);
  });

  it("says so when the mobile delivery has no usable number", async () => {
    const h = harness();
    onPersonalMobile(h, null);
    const call = await talking(h);

    const error = await fail(completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 })));

    expect(error.code).toBe("target_unavailable");
    expect(error.message).toContain("mobilné doručovanie");
  });

  it("names the number when the allowlist refuses it", async () => {
    const h = harness();
    onPersonalMobile(h, "+49 151 12345678");
    const call = await talking(h);

    const error = await fail(completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 })));

    expect(error.status).toBe(403);
    expect(error.message).toContain("+4915112345678");
  });

  it("shows them as available in the picker, reachable by mobile", async () => {
    const h = harness();
    onPersonalMobile(h);

    const targets = await listTransferTargets(deps(h), o1);
    const colleague = targets.find((target) => target.profileId === PROFILES.o2)!;

    expect(colleague).toMatchObject({ available: true, deviceLive: false, reachVia: "mobile" });
    // A green "Dostupný" would be a lie about a browser phone that does not
    // exist; "Nepripojený" would be true and useless.
    expect(colleagueBadge(colleague, h.now())).toBe("Mobil");
  });

  it("leaves an ordinary colleague with a closed laptop unreachable", async () => {
    const h = harness();
    h.db.delete("motorist_operator_devices", (row) => row.profile_id === PROFILES.o2);

    const colleague = (await listTransferTargets(deps(h), o1)).find((target) => target.profileId === PROFILES.o2)!;

    expect(colleague).toMatchObject({ available: false, reachVia: "web" });
    expect(colleagueBadge(colleague, h.now())).toContain("Nepripojený");
  });
});
