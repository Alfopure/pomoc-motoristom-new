import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { runSessionEvent } from "./session-runner";
import { sweepOverdueRingSteps } from "./routing/ring-plan";
import { readMeta, type SessionRow } from "./state/types";

async function sweep(h: TelephonyHarness) {
  const result = await sweepOverdueRingSteps({ admin: h.admin, organizationId: ORG, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
  expect(result.errors).toEqual([]);
  return result;
}

const gather = (h: TelephonyHarness) => h.telnyx.of("gatherUsingAudio").at(-1)!.params.clientState;
const queueMeta = (h: TelephonyHarness, sessionId: string) => readMeta(h.session(sessionId) as SessionRow).queue;
const pstnDials = (h: TelephonyHarness) => h.telnyx.of("dial").filter((dial) => !String(dial.params.to).startsWith("sip:"));

/** Nobody logged in: the ring plan reaches its backup number, which does not answer. */
async function queued(h = createTelephonyHarness({ fallbackKind: "waiting_room" })) {
  for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
  await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
  expect(h.session(call.sessionId).state).toBe("waiting");
  return { h, call };
}

/** One waiting-room tick: the caller's prompt ends and the queue looks again. */
async function tick(h: TelephonyHarness, callControlId: string, ms: number) {
  h.advance(ms);
  await h.legEvent(callControlId, "call.gather.ended", { status: "timeout", client_state: gather(h) });
}

describe("a queue with nobody to ring", () => {
  it("rings the backup number again once, after two minutes of finding nobody", async () => {
    const { h, call } = await queued();
    expect(pstnDials(h)).toHaveLength(1);

    // A minute in, the queue is still within its patience.
    await tick(h, call.callControlId, 60_000);
    expect(pstnDials(h)).toHaveLength(1);
    expect(h.session(call.sessionId).state).toBe("waiting");

    await tick(h, call.callControlId, 60_000);
    expect(pstnDials(h)).toHaveLength(2);
    expect(pstnDials(h).at(-1)?.params.to).toBe(NUMBERS.external);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(queueMeta(h, call.sessionId)?.escalated_at).toBe(h.now().toISOString());
  });

  it("spends the escalation once, however long the caller waits", async () => {
    const { h, call } = await queued();
    await tick(h, call.callControlId, 120_000);
    expect(pstnDials(h)).toHaveLength(2);

    const escalation = h.legs(call.sessionId).find((leg) => leg.to_number === NUMBERS.external && !leg.ended_at)!;
    await h.legEvent(String(escalation.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");

    // Twenty more minutes of the same silence buys no further paid redials.
    for (let minute = 0; minute < 20; minute++) {
      await tick(h, call.callControlId, 60_000);
      await sweep(h);
    }
    expect(pstnDials(h)).toHaveLength(2);
    expect(h.session(call.sessionId).state).toBe("waiting");
  });

  it("does not escalate while it is still reaching an operator", async () => {
    const { h, call } = await queued();

    // An operator comes back after a minute and is offered the call; they let
    // it ring out, and are offered it again. The queue is working, so its
    // patience never runs out and the backup number is left alone.
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    for (let minute = 0; minute < 4; minute++) {
      await tick(h, call.callControlId, 60_000);
      const offered = h.openLegFor(call.sessionId, PROFILES.o1);
      if (offered) {
        await h.legEvent(String(offered.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
        h.setPresence(PROFILES.o1, { status: "available" });
      }
      await sweep(h);
    }

    expect(h.telnyx.of("dial").filter((dial) => String(dial.params.to).startsWith("sip:")).length).toBeGreaterThan(1);
    expect(pstnDials(h)).toHaveLength(1);
    expect(queueMeta(h, call.sessionId)?.escalated_at ?? null).toBeNull();
  });

  it("restarts its patience as soon as somebody is reachable again", async () => {
    const { h, call } = await queued();

    // Ninety seconds of nobody, then an operator appears: the clock that would
    // have escalated at two minutes is reset by the offer that went out.
    await tick(h, call.callControlId, 90_000);
    expect(queueMeta(h, call.sessionId)?.idle_since).toBeTruthy();

    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    await tick(h, call.callControlId, 10_000);
    expect(h.openLegFor(call.sessionId, PROFILES.o1)).toBeTruthy();
    expect(queueMeta(h, call.sessionId)?.idle_since ?? null).toBeNull();
    expect(pstnDials(h)).toHaveLength(1);
  });

  it("never rings the backup number when the organisation turned escalation off", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    h.db.update("motorist_telephony_settings", { queue_escalate_after_seconds: 0 }, () => true);
    const { call } = await queued(h);
    expect(pstnDials(h)).toHaveLength(1);

    // Ten minutes of nobody. Zero means never, not "immediately".
    for (let minute = 0; minute < 10; minute++) {
      await tick(h, call.callControlId, 60_000);
      await sweep(h);
    }

    expect(pstnDials(h)).toHaveLength(1);
    expect(queueMeta(h, call.sessionId)?.escalated_at ?? null).toBeNull();
    expect(h.session(call.sessionId).state).toBe("waiting");
  });

  it("waits as long as the organisation asked before trying the backup number", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    h.db.update("motorist_telephony_settings", { queue_escalate_after_seconds: 300 }, () => true);
    const { call } = await queued(h);

    // Two minutes is the built-in default and must no longer decide anything.
    await tick(h, call.callControlId, 120_000);
    expect(pstnDials(h)).toHaveLength(1);

    await tick(h, call.callControlId, 180_000);
    expect(pstnDials(h)).toHaveLength(2);
    expect(pstnDials(h).at(-1)?.params.to).toBe(NUMBERS.external);
  });
});
