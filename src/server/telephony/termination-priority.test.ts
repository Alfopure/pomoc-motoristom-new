import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { registerCriticalWriteRpcs, registerProviderJournalRpcs } from "@/test/fake-stability";
import { hangupCall } from "./call-actions";
import { sessionOwnership, type Ownership } from "./ownership";
import { loadRoutingContext, runSessionEvent } from "./session-runner";
import { parseTelnyxEnvelope } from "./state/events";
import { readMeta, type SessionRow } from "./state/types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** Contract 2, operator o1 talking to the customer — what production runs. */
async function talkingContract2() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(winner, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId)).toMatchObject({ state: "talking", writer_contract: 2 });
  return { h, call, operatorControlId: winner };
}

const terminationPasses = (h: TelephonyHarness) => h.db.log.filter(entry => entry.table === "motorist_provider_termination_legs_v2").length;

function owned(h: TelephonyHarness, sessionId: string): Ownership {
  h.db.registerRpc("motorist_session_lease_renew_v2", () => true);
  // Under contract 2 every provider command is fenced, teardown included — and
  // the fence is what makes the hangup below the only command still allowed
  // once termination is committed.
  registerProviderJournalRpcs(h.db);
  registerCriticalWriteRpcs(h.db);
  h.db.registerRpc("motorist_provider_observe_dial_v2", () => false);
  const row = h.db.storage("motorist_call_sessions").find(row => row.id === sessionId)!;
  row.writer_contract = 2;
  row.termination_requested_at = h.now().toISOString();
  // The fence compares the owner against this row, so an owner that does not
  // hold it is not an owner at all.
  row.lease_token = "termination-owner";
  row.lease_generation = 1;
  row.lease_until = new Date(h.now().getTime() + 30_000).toISOString();
  return { admin: h.admin, organizationId: h.deps.organizationId, sessionId,
    token: "termination-owner", generation: 1, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 };
}

describe("priority call termination", () => {
  it("does not load fresh routing or recording configuration before an explicit hangup", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ answer: false });
    const session = h.session(call.sessionId) as SessionRow;
    h.db.log.length = 0;
    const context = await loadRoutingContext(h.deps, session, {
      kind: "app", type: "hangup", id: "hangup", actorProfileId: null, occurredAt: h.now().toISOString(),
    });
    expect(h.db.log).toEqual([]);
    expect(context.recordingPolicy).toEqual(readMeta(session).recording?.policy);
    expect(context.mediaAvailable).toBe(false);
  });

  it("resumes a committed stop on the next sweep and hangs up the non-journalled inbound customer", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const owner = owned(h, call.sessionId);
    h.db.failNext("motorist_telephony_settings", "select", "routing unavailable");
    const result = await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, {
      kind: "app", type: "sweep", id: "next-owner", actorProfileId: null, occurredAt: h.now().toISOString(),
    }));
    expect(result).toMatchObject({ outcome: "applied", apply: { failed: false } });
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(readMeta(h.session(call.sessionId) as SessionRow).hangup?.scope).toBe("session");
  });

  it("still records the exact original hangup fact after resuming the durable stop", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const owner = owned(h, call.sessionId);
    const event = parseTelnyxEnvelope(h.envelope("call.hangup", {
      call_control_id: call.callControlId, hangup_cause: "normal_clearing",
    }, "provider-hangup"))!;
    await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, event));
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
    expect(h.rows("motorist_call_events").some(row => row.event_fingerprint === event.id)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ended");
  });

  // M19/M20: every later webhook of an ended call used to pay the two
  // termination RPCs on top of the nested run's own post-apply pass.
  it("runs the compensation pass once per host when nothing is due", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const owner = owned(h, call.sessionId);
    const requestedAt = h.session(call.sessionId).termination_requested_at;
    const event = parseTelnyxEnvelope(h.envelope("call.hangup", {
      call_control_id: call.callControlId, hangup_cause: "normal_clearing",
    }, "provider-hangup"))!;

    await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, event));

    // The nested `termination:*` run's post-apply pass is the host's one pass.
    expect(terminationPasses(h)).toBe(1);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
    expect(h.rows("motorist_call_events").some(row => row.event_fingerprint === event.id)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);

    // A webhook after the checkpoint pays no termination RPC at all.
    const duplicate = parseTelnyxEnvelope(h.envelope("call.hangup", {
      call_control_id: call.callControlId, hangup_cause: "normal_clearing",
    }, "provider-hangup-again"))!;
    await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, duplicate));
    expect(terminationPasses(h)).toBe(1);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
  });

  it.each([
    { label: "due", offsetMs: -1_000, passes: 1 },
    { label: "re-armed for later", offsetMs: 30_000, passes: 0 },
  ])("runs the host pass only when the obligation is $label", async ({ offsetMs, passes }) => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const owner = owned(h, call.sessionId);
    const row = h.db.storage("motorist_call_sessions").find(entry => entry.id === call.sessionId)!;
    // The stop intent has already been applied, so no nested run fires; what
    // is left is the database's word on whether a compensation pass is owed.
    row.metadata = { ...readMeta(row as SessionRow), hangup: { by: null, at: h.now().toISOString(), scope: "session" } };
    row.termination_next_attempt_at = new Date(h.now().getTime() + offsetMs).toISOString();
    const requestedAt = row.termination_requested_at;
    const event = parseTelnyxEnvelope(h.envelope("call.hangup", {
      call_control_id: call.callControlId, hangup_cause: "normal_clearing",
    }, "provider-hangup"))!;

    await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, event));

    expect(terminationPasses(h)).toBe(passes);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
  });

  it("nested termination run uses the read-free context and still hangs up every open leg", async () => {
    const { h, call, operatorControlId } = await talkingContract2();
    const owner = owned(h, call.sessionId);
    const row = h.session(call.sessionId);
    // A configuration read inside the nested run would throw and fail the run.
    h.db.failNext("motorist_telephony_settings", "select", "settings unavailable");
    h.db.failNext("motorist_telephony_lines", "select", "lines unavailable");
    h.db.failNext("motorist_operator_devices", "select", "devices unavailable");

    const result = await sessionOwnership.run(owner, () => runSessionEvent(h.deps, call.sessionId, {
      kind: "app", type: "sweep", id: "next-owner", actorProfileId: null, occurredAt: h.now().toISOString(),
    }));

    expect(result).toMatchObject({ outcome: "applied", apply: { failed: false } });
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(h.telnyx.physical.legs.get(operatorControlId)?.ended).toBe(true);
    const hungUp = h.telnyx.of("hangup").map(entry => entry.params.callControlId);
    expect(hungUp).toEqual(expect.arrayContaining([call.callControlId, operatorControlId]));
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
    expect(h.rows("motorist_call_events").some(entry => entry.event_fingerprint === `termination:${call.sessionId}:${row.termination_requested_at}`)).toBe(true);
  });

  // M21: the audit used to restate the customer hangup from the journal-cache
  // replay, 1.7-3.3 s after the urgent dispatch had actually sent it.
  it("audit stamps the customer hangup at its urgent dispatch, not at the journal replay", async () => {
    const { h, call } = await talkingContract2();
    const dispatched = new Map<string, string>();
    let answeredBy = h.now().getTime();
    const original = h.telnyx.client.hangup.bind(h.telnyx.client);
    h.telnyx.client.hangup = async (params) => {
      if (!dispatched.has(params.commandId)) dispatched.set(params.commandId, h.now().toISOString());
      await original(params);
      // Anything stamped after the send is at least this much later.
      h.advance(2_000);
      answeredBy = h.now().getTime();
    };
    const auditedBefore = h.rows("motorist_call_events").length;

    await hangupCall(h.deps, { profileId: PROFILES.o1, role: "dispatcher" }, call.sessionId);

    type Audited = { kind: string; command_id: string | null; started_at?: string; effect_ms?: number; db_count_at_dispatch?: number };
    const hangups = h.rows("motorist_call_events").slice(auditedBefore)
      .filter(entry => entry.handled_status === "processed")
      .flatMap(entry => ((entry.normalized_payload as { commands?: Audited[] } | null)?.commands ?? []))
      .filter(command => command.kind === "hangup");
    expect(hangups.length).toBeGreaterThanOrEqual(2);
    for (const command of hangups) {
      expect(dispatched.has(String(command.command_id))).toBe(true);
      expect(command.started_at).toBe(dispatched.get(String(command.command_id)));
      // The effect window closes with the provider's answer, never with the
      // replay: it is only ever read next to `started_at`.
      expect(Date.parse(String(command.started_at)) + Number(command.effect_ms)).toBeLessThanOrEqual(answeredBy);
      // No request scope in the harness: `requestStepCount` is null before and after.
      expect(command.db_count_at_dispatch).toBeUndefined();
    }
  });
});
