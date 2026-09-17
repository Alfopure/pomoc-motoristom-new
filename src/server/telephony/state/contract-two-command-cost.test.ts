import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { blindTransfer, hangupCall, holdCall, unholdCall } from "../call-actions";
import type { SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

/** Contract 2 — generation leases and the fenced provider journal — is what production runs. */
function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  return createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
}

async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(winner, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId)).toMatchObject({ state: "talking", writer_contract: 2 });
  return call;
}

const reads = (h: TelephonyHarness, from: number) =>
  h.db.log.slice(from).filter(row => row.table === "motorist_call_sessions" && row.operation === "select").length;

describe("contract 2 request cost", () => {
  it("stays inside the measured budget for every call action", async () => {
    const answerHarness = harness();
    const first = await answerHarness.inbound({ to: NUMBERS.allianz });
    const winner = String(answerHarness.legFor(first.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const answerFrom = answerHarness.db.log.length;
    await answerHarness.legEvent(winner, "call.answered");
    const answer = answerHarness.db.log.length - answerFrom;

    const h = harness();
    const call = await talking(h);
    const measure = async (run: () => Promise<unknown>) => {
      const from = h.db.log.length;
      await run();
      return h.db.log.length - from;
    };
    const hold = await measure(() => completeAnnouncedAction(h, holdCall(h.deps, actor, call.sessionId)));
    const unhold = await measure(() => completeAnnouncedAction(h, unholdCall(h.deps, actor, call.sessionId)));
    const transfer = await measure(() => completeAnnouncedAction(h, blindTransfer(h.deps, actor, call.sessionId, { number: NUMBERS.external })));
    const hangup = await measure(() => hangupCall(h.deps, actor, call.sessionId));

    // Measured on this path: 64 / 40 / 36 / 47 / 39 before the 17 Sep
    // deduplications, 53 / 38 / 34 / 43 / 32 after. Bounds carry one request of
    // headroom because the throttled incident-recovery read fires or not
    // depending on wall-clock, so they still catch any regression of two or
    // more. They are guards, not targets — lower them when a change lowers the
    // count.
    expect(answer).toBeLessThanOrEqual(55);
    expect(hold).toBeLessThanOrEqual(39);
    expect(unhold).toBeLessThanOrEqual(35);
    expect(transfer).toBeLessThanOrEqual(44);
    expect(hangup).toBeLessThanOrEqual(33);
  });

  it("records why a command failed, not just that it did", async () => {
    const h = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    // A best-effort stop: the call still connects, so the audit is written and
    // the failure is exactly the kind that used to leave no trace.
    h.telnyx.failNext("playbackStop", "Telnyx refused the playback stop");

    await h.legEvent(winner, "call.answered");

    expect(h.session(call.sessionId).state).toBe("talking");
    const audited = h.rows("motorist_call_events")
      .flatMap(row => ((row.normalized_payload as { commands?: { kind: string; ok: boolean; error?: string }[] } | null)?.commands) ?? [])
      .filter(command => !command.ok);
    expect(audited.map(command => command.kind)).toContain("playback_stop");
    expect(audited[0].error).toContain("Telnyx refused the playback stop");
    expect(audited.every(command => (command.error ?? "").length <= 300)).toBe(true);
  });

  it("validates later commands against the fenced row it already holds", async () => {
    const h = harness();
    const call = await talking(h);
    const from = h.db.log.length;

    await hangupCall(h.deps, actor, call.sessionId);

    expect(h.telnyx.of("hangup").length).toBeGreaterThanOrEqual(2);
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    // One read per provider command is what this removed; a couple of reads for
    // the action itself remain.
    expect(reads(h, from)).toBeLessThanOrEqual(5);
  });

  it("keeps the fresh read while a call is being recorded", async () => {
    const h = harness();
    const call = await talking(h);
    const session = h.session(call.sessionId) as SessionRow;
    const meta = session.metadata as Record<string, unknown>;
    const recording = meta.recording as { policy: Record<string, unknown> };
    h.db.update("motorist_call_sessions",
      { metadata: { ...meta, recording: { ...recording, policy: { ...recording.policy, enabled: true } } } },
      row => row.id === call.sessionId);
    const from = h.db.log.length;

    await hangupCall(h.deps, actor, call.sessionId);

    // Recording keeps its own live view of recorders and pending audio.
    expect(reads(h, from)).toBeGreaterThan(5);
  });

});
