import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { completeTransfer, holdCall, hangupCall, startConsult, unholdCall } from "../call-actions";
import { runPendingEffectRecovery } from "../cron-jobs";
import { readContactHistory, type ContactProof } from "../contact-proof";
import { readPendingEffects } from "./continuation";
import { type SessionRow } from "./types";

beforeEach(() => {
  for (const key of ["TELEPHONY_STABILITY_V1_ENABLED", "TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No live provider/network in conference contact integration QA"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const session = (h: TelephonyHarness, id: string) => h.session(id) as unknown as SessionRow;
const pending = (h: TelephonyHarness, id: string) => readPendingEffects(session(h, id)).entries;
const proofs = (h: TelephonyHarness, id: string) => readContactHistory(session(h, id)).proofs;
const audioMethods = new Set(["dial", "bridge", "createConference", "conference:join", "recordingStart", "playbackStart", "speak"]);

async function ringing() {
  const h = createTelephonyHarness();
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound(); await completeCallAnnouncements(h, call.sessionId);
  const row = session(h, call.sessionId);
  const [callback] = h.db.insert("motorist_callback_requests", { organization_id: ORG, caller_number: row.caller_number, status: "open", line_id: row.line_id, case_id: row.case_id, created_at: new Date(Date.parse(row.started_at) - 60_000).toISOString() });
  // Explicit workflow RPC boundary; real rollback/locking/matching contracts are
  // independently exercised by tests/telephony/callback-contract.py.
  let fulfillmentUnavailable = false;
  h.db.registerRpc("motorist_reconcile_callback_contact_v1", args => {
    if (fulfillmentUnavailable) throw new Error("atomic fulfillment unavailable");
    const proof = args.p_proof as ContactProof;
    expect(proof.conferenceSnapshot?.source).toBe("telnyx_conference_participants_v1");
    expect(proofs(h, call.sessionId)).toContainEqual(proof);
    const stored = h.db.find("motorist_callback_requests", item => item.id === callback.id)!;
    if (stored.status === "done") return [];
    h.db.update("motorist_callback_requests", { status: "done", resolved_at: proof.occurredAt }, item => item.id === callback.id);
    h.db.insert("motorist_audit_log", { organization_id: ORG, entity_id: callback.id, action: "telephony.callback.contact_done" });
    return [callback.id];
  });
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  return { h, ...call, operator, callbackId: callback.id,
    setFulfillmentUnavailable: (value: boolean) => { fulfillmentUnavailable = value; },
    callbackStatus: () => h.db.find("motorist_callback_requests", item => item.id === callback.id)!.status };
}

/** The connection itself first reads customer membership. Fault only later
 * verification after the operator has physically joined, never the audio setup. */
function afterJoinRead(h: TelephonyHarness, fault: (value: unknown) => unknown | Promise<unknown>) {
  const request = h.telnyx.client.request.bind(h.telnyx.client);
  return vi.spyOn(h.telnyx.client, "request").mockImplementation(async (method, path, options) => {
    const response = await request(method, path, options);
    return (path.endsWith("/participants") && options?.query?.["page[size]"] === 250 ? await fault(response) : response) as never;
  });
}
async function endWebhooks(h: TelephonyHarness, id: string) {
  for (const leg of h.legs(id)) if (!leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", {hangup_cause:"normal_clearing"});
}
async function cron(h: TelephonyHarness) {
  h.advance(5 * 60_000);
  expect(await runPendingEffectRecovery(h.deps)).toMatchObject({ status: "ok", detail: { checked: 1 } });
}

describe("conference callback maintenance recovery", () => {
  it("R09: a monitor topology update during provider verification retries CAS without replacing the customer/operator proof", async () => {
    const call = await ringing(), { h } = call;
    let changed = false;
    afterJoinRead(h, async response => {
      if (!changed) {
        changed = true;
        const current = session(h, call.sessionId);
        h.db.update("motorist_call_sessions", { version: current.version + 1, metadata: { ...current.metadata as object, monitorInviteActors: [PROFILES.o1] } }, row => row.id === call.sessionId);
      }
      const body = response as { data: Record<string, unknown>[] };
      return { ...body, data: [...body.data, { ...body.data[0], id: "monitor-participant", call_control_id: "monitor-control", call_leg_id: "monitor-leg", muted: true }] };
    });
    await h.legEvent(call.operator, "call.answered");
    if (call.callbackStatus() !== "done") await cron(h);
    expect(changed).toBe(true);
    expect(call.callbackStatus()).toBe("done");
    expect(proofs(h, call.sessionId)).toHaveLength(1);
    expect(proofs(h, call.sessionId)[0].conferenceSnapshot?.participants.map(row => row.callControlId)).toEqual([call.callControlId, call.operator]);
    expect(h.rows("motorist_audit_log").filter(row => row.entity_id === call.callbackId)).toHaveLength(1);
  });

  it("fulfills immediately from the physical conference after create/join, without another provider webhook", async () => {
    const call = await ringing(), { h } = call;
    await h.legEvent(call.operator, "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, call.operator)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(call.callbackStatus()).toBe("done");
    expect(proofs(h, call.sessionId)).toHaveLength(1);
    expect(proofs(h, call.sessionId)[0].conferenceSnapshot?.participants).toHaveLength(2);
    expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.rows("motorist_audit_log").filter(row => row.entity_id === call.callbackId)).toHaveLength(1);
  });

  it("keeps a failed post-audio read pending and one five-minute cron recovers with creation disabled", async () => {
    const call = await ringing(), { h } = call;
    const read = afterJoinRead(h, () => { throw new Error("participant read unavailable"); });
    await h.legEvent(call.operator, "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, call.operator)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(call.callbackStatus()).toBe("open"); expect(proofs(h, call.sessionId)).toEqual([]);
    expect(pending(h, call.sessionId).some(entry => entry.transition.contactChecks?.length)).toBe(true);
    const audio = h.telnyx.calls.filter(call => audioMethods.has(call.method)).length;
    read.mockRestore(); vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    await cron(h);
    expect(call.callbackStatus()).toBe("done");expect(proofs(h, call.sessionId)).toHaveLength(1);expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.telnyx.calls.filter(call => audioMethods.has(call.method))).toHaveLength(audio);
  });

  it.each(["hold", "hangup"] as const)("a repeatedly failing verification does not block %s", async control => {
    const call = await ringing(), { h } = call;
    afterJoinRead(h, () => { throw new Error("participant read remains unavailable"); });
    await h.legEvent(call.operator, "call.answered");
    expect(call.callbackStatus()).toBe("open");
    if (control === "hold") {
      await holdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
      expect(h.session(call.sessionId).state).toBe("held");
      expect(h.telnyx.of("conference:hold").length).toBeGreaterThan(0);
    } else {
      await hangupCall(h.deps, actor, call.sessionId);
      await endWebhooks(h, call.sessionId);
      expect(h.session(call.sessionId).ended_at).toBeTruthy();
      expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    }
    expect(call.callbackStatus()).toBe("open");expect(proofs(h, call.sessionId)).toEqual([]);
  });

  it("verifies newly restored contact after an initial read failure, hold and unhold", async () => {
    const call = await ringing(), { h } = call;
    const read = afterJoinRead(h, () => { throw new Error("initial verification unavailable"); });
    await h.legEvent(call.operator, "call.answered");
    await holdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    expect(call.callbackStatus()).toBe("open");expect(h.session(call.sessionId).state).toBe("held");
    read.mockRestore();
    await unholdCall(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(call.callbackStatus()).toBe("done");expect(proofs(h, call.sessionId)).toHaveLength(1);
  });

  it("verifies the new serving operator when attended transfer restores customer audio", async () => {
    const call = await ringing(), { h } = call;
    const read = afterJoinRead(h, () => { throw new Error("initial verification unavailable"); });
    await h.legEvent(call.operator, "call.answered");
    await startConsult(h.deps, actor, call.sessionId, {profileId:PROFILES.o2}); await completeCallAnnouncements(h, call.sessionId);
    const consult = h.legs(call.sessionId).find(leg=>leg.role==="consult")!;
    h.telnyx.physical.answered(String(consult.telnyx_call_control_id));
    await h.legEvent(String(consult.telnyx_call_control_id), "call.answered");
    expect(call.callbackStatus()).toBe("open");
    read.mockRestore();
    await completeTransfer(h.deps, actor, call.sessionId); await completeCallAnnouncements(h, call.sessionId);
    expect(h.session(call.sessionId).answered_by_profile_id).toBe(PROFILES.o2);
    expect(call.callbackStatus()).toBe("done");
    expect(proofs(h, call.sessionId)).toMatchObject([{operatorProfileId:PROFILES.o2,operatorLegId:consult.id,topology:"conference"}]);
  });

  it.each(["before-proof-stage", "before-fulfillment"] as const)("retains captured proof through %s failure and hangup; disabled-gate cron performs bookkeeping only", async boundary => {
    const call = await ringing(), { h } = call;
    let injected = false, stageUnavailable = boundary === "before-proof-stage";
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    if (boundary === "before-proof-stage") h.db.registerRpc("motorist_stage_transition_v1", (args, db) => {
      const main = args.p_main as {entry:{id:string}};
      if (stageUnavailable && main.entry.id.startsWith("contact-proof:")) { injected = true; throw new Error("proof staging unavailable"); }
      return stage(args, db);
    });
    else { injected = true; call.setFulfillmentUnavailable(true); }
    await h.legEvent(call.operator, "call.answered");
    expect(injected).toBe(true);expect(call.callbackStatus()).toBe("open");
    expect(pending(h, call.sessionId).some(entry => entry.transition.contactProofs?.length || entry.transition.contactChecks?.length)).toBe(true);
    // Once audio ends there may be no live membership left to query. Only an
    // already captured durable snapshot can complete the callback obligation.
    h.telnyx.setConferenceParticipants(String(h.session(call.sessionId).conference_id), []);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const hangupError = await hangupCall(h.deps, actor, call.sessionId).then(() => null, error => error);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended, String(hangupError)).toBe(true);
    await endWebhooks(h, call.sessionId);
    expect(pending(h,call.sessionId).length).toBeGreaterThan(0);
    const afterHangup = h.telnyx.calls.length;stageUnavailable = false;call.setFulfillmentUnavailable(false);
    if (call.callbackStatus() === "open") await cron(h);
    else { h.advance(5 * 60_000); expect(await runPendingEffectRecovery(h.deps)).toMatchObject({status:"ok"}); }
    expect(call.callbackStatus()).toBe("done");expect(proofs(h, call.sessionId)).toHaveLength(1);expect(pending(h, call.sessionId)).toEqual([]);
    expect(h.session(call.sessionId).ended_at).toBeTruthy();
    expect(h.legs(call.sessionId).every(leg=>Boolean(leg.ended_at))).toBe(true);
    expect(h.telnyx.calls.slice(afterHangup).filter(call => audioMethods.has(call.method))).toEqual([]);
    expect(h.rows("motorist_audit_log").filter(row => row.entity_id === call.callbackId)).toHaveLength(1);
  });

  it("both delivered joins cannot fulfill when the physical snapshot lacks the customer after an undelivered leave", async () => {
    const call = await ringing(), { h } = call;
    let removed = false;
    afterJoinRead(h, async response => {
      if (!removed) {
        removed = true;
        // Provider topology changes before delivery of the leave webhook.
        await h.telnyx.client.conferenceAction(String(h.session(call.sessionId).conference_id), "leave", {call_control_id:call.callControlId,commandId:"physical-undelivered-leave"});
      }
      return { ...(response as object), data: (response as {data:Record<string,unknown>[]}).data.filter(row => row.call_control_id === call.operator) };
    });
    await h.legEvent(call.operator, "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, call.operator)).toBe(false);
    const conference_id = h.session(call.sessionId).conference_id;
    await h.legEvent(call.operator, "conference.participant.joined", { conference_id });
    await h.legEvent(call.callControlId, "conference.participant.joined", { conference_id });
    expect(call.callbackStatus()).toBe("open");expect(proofs(h, call.sessionId)).toEqual([]);
    await cron(h);expect(call.callbackStatus()).toBe("open");expect(proofs(h, call.sessionId)).toEqual([]);
  });
});
