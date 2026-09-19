import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { addCallParty, blindTransfer, createRateLimiter, startConsult, type CallActionDeps, type CallActor } from "./call-actions";

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const deps = (h: TelephonyHarness): CallActionDeps => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });

async function talking(h: TelephonyHarness, caller: string) {
  const call = await h.inbound({ to: NUMBERS.allianz, from: caller });
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    }
  }
  return call;
}

const CALLER = "+421910988882";

describe("who an operator's phone says is calling", () => {
  it("names the caller when their phone rings, not the line", async () => {
    const h = createTelephonyHarness();

    await h.inbound({ to: NUMBERS.allianz, from: CALLER });

    // Every leg to an operator is dialled from the DID line — the only
    // verified origination number — so without a display name the phone shows
    // "Allianz Assistance" and the operator reads it as Allianz calling them.
    const sip = h.telnyx.of("dial").filter((dial) => String(dial.params.to).startsWith("sip:"));
    expect(sip.length).toBeGreaterThan(0);
    for (const dial of sip) expect(dial.params.fromDisplayName).toBe(CALLER);
  });

  it("names the caller to a colleague being transferred the call", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h, CALLER);

    await completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 }));

    const handed = h.telnyx.of("transfer")[0] ?? h.telnyx.of("dial").at(-1)!;
    expect(handed.params.fromDisplayName).toBe(CALLER);
  });

  it("names the caller on a consultation", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h, CALLER);

    await completeAnnouncedAction(h, startConsult(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 }));

    expect(h.telnyx.of("dial").at(-1)?.params.fromDisplayName).toBe(CALLER);
  });

  it("names the caller on an added participant", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h, CALLER);

    await completeAnnouncedAction(h, addCallParty(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 }));

    expect(h.telnyx.of("dial").at(-1)?.params.fromDisplayName).toBe(CALLER);
  });

  it("presents nothing when there is no caller to present", async () => {
    const h = createTelephonyHarness();

    // A colleague-to-colleague call has no customer, and the caller's own name
    // is already what the receiving phone should show.
    await h.inbound({ to: NUMBERS.allianz, from: "" });

    const sip = h.telnyx.of("dial").filter((dial) => String(dial.params.to).startsWith("sip:"));
    expect(sip.length).toBeGreaterThan(0);
    for (const dial of sip) expect(dial.params.fromDisplayName ?? null).not.toBe("");
  });
});
