import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { blindTransfer, hangupCall, holdCall, unholdCall } from "../call-actions";
import { readPendingEffects } from "./continuation";
import { commandKey } from "./types";
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

    // Measured on this path: 64 / 40 / 36 / 47 / 39 before the 17 Sep work,
    // 45 / 35 / 33 / 41 / 32 after it, 63 / 44 / 36 / 50 / 42 once the double
    // started going through the provider journal like the real client, and
    // 61 / 44 / 36 / 51 / 42 with one checkpoint per overlapping run, and
    // 55 for an answer once the lease renew was throttled to one per five
    // seconds — which needed the double to model the fence first, since the
    // fence is what refuses a stale owner when the renew no longer does.
    //
    // The jump is not a regression. It is the cost that was always there and
    // never counted: `prepare_v2` before every voice command and `result_v2`
    // after it, two database round trips each. Everything measured before
    // 18 Sep understates production by roughly that much, including the
    // reductions this repair claimed.
    //
    // Bounds carry two requests of headroom because the throttled
    // incident-recovery read fires or not depending on wall-clock; they still
    // catch any regression of three or more. Guards, not targets — lower them
    // when a change lowers the count.
    expect(answer).toBeLessThanOrEqual(57);
    expect(hold).toBeLessThanOrEqual(46);
    expect(unhold).toBeLessThanOrEqual(38);
    expect(transfer).toBeLessThanOrEqual(52);
    expect(hangup).toBeLessThanOrEqual(44);
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

  it("retires a command the fence refuses after a termination instead of compensating the call", async () => {
    const h = harness();
    const call = await talking(h);
    // What `prepare_v2` raises once another invocation has committed a
    // termination: `app.hangup` commits it before it waits for the lease.
    const refused = Object.assign(new Error("motorist_provider_command_prepare_v2: telephony termination blocks new provider command"), { code: "PT409" });
    // Once a termination is committed, `prepare_v2` refuses every non-teardown
    // command of the entry, not just the first.
    h.telnyx.failAlways("createConference", refused);
    h.telnyx.failAlways("conferenceAction", refused);
    const incidents = h.rows("motorist_job_incidents").length;

    const result = await completeAnnouncedAction(h, holdCall(h.deps, actor, call.sessionId)).catch(() => null);

    // The call is already ending, so the command is retired rather than turned
    // into an incident or a compensation putting the caller back anywhere.
    expect(h.rows("motorist_job_incidents")).toHaveLength(incidents);
    // Nothing is left half-issued for a replay to pick up either.
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries
      .every(entry => entry.commands.every(command => entry.completedCommands.includes(commandKey(command))))).toBe(true);
    void result;
  });

  it("still treats the same refusal on a teardown command as a real failure", async () => {
    const h = harness();
    const call = await talking(h);
    const refused = Object.assign(new Error("motorist_provider_command_prepare_v2: telephony termination blocks new provider command"), { code: "PT409" });
    h.telnyx.failAlways("hangup", refused as never);

    const result = await hangupCall(h.deps, actor, call.sessionId).catch(() => "threw" as const);

    // `prepare_v2` never refuses teardown after a termination — it is what lets
    // the call end. If it ever does, that is a failure to report, not a skip.
    expect(result === "threw" || result.commands.some(command => command.kind === "hangup" && !command.ok)).toBe(true);
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
