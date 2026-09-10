import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, PROFILES, ORG, NUMBERS, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { addCallParty, blindTransfer, holdCall, hangupCall, inviteCallMonitor, revokeCallMonitorInvitation, superviseCall, stopSupervisingCall, createRateLimiter, type CallActor } from "./call-actions";
import { listMonitorInvitations } from "./monitor-invitations";
import { runSessionEvent, effectsDeps } from "./session-runner";
import { applyReduceResult } from "./state/effects";
import { emptyTransition, type AppEvent, type Command, type SessionMeta, type SessionRow } from "./state/types";
import { TelnyxCommandError } from "./telnyx/client";
import { readPendingEffects, stageEffects } from "./state/continuation";
import { fakeError } from "@/test/fake-supabase";

const owner: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Owner" };
const trainee: CallActor = { profileId: PROFILES.o2, role: "dispatcher", displayName: "Trainee" };
async function talking() {
  const h = createTelephonyHarness();
  Object.assign(h.deps, { rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = h.legFor(call.sessionId, owner.profileId)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== owner.profileId) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
  await h.admin.from("motorist_telephony_settings").update({ monitor_invites_enabled: true }).eq("organization_id", ORG);
  return { h, id: call.sessionId, customer: call.callControlId };
}
function entries(h: TelephonyHarness, id: string) { return Object.values((h.session(id).metadata as SessionMeta).monitorInvitations ?? {}); }
async function invite(h: TelephonyHarness, id: string) { await inviteCallMonitor(h.deps, owner, id, trainee.profileId); return entries(h, id).at(-1)!; }
function event(h: TelephonyHarness, changes: Partial<AppEvent>): AppEvent {
  return { kind: "app", id: h.nextEventId(), type: "supervise", actorProfileId: trainee.profileId, occurredAt: h.now().toISOString(), ...changes };
}
describe("invited receive-only monitoring", () => {
  beforeEach(() => vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("requires durable effects even if the separate audio gate is enabled", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const { h, id } = await talking();
    const before = h.telnyx.calls.length;
    await expect(invite(h, id)).rejects.toMatchObject({ status: 503 });
    expect((await listMonitorInvitations(h.deps, trainee)).enabled).toBe(false);
    expect(h.telnyx.calls).toHaveLength(before);
    expect((h.session(id).metadata as SessionMeta).effects_v1).toBeUndefined();
  });
  it("defaults off, rejects outsiders/inactive recipients, and scopes inbox to caller identity", async () => {
    const { h, id } = await talking();
    await h.admin.from("motorist_telephony_settings").update({ monitor_invites_enabled: false }).eq("organization_id", ORG);
    await expect(invite(h, id)).rejects.toMatchObject({ status: 503 });
    await h.admin.from("motorist_telephony_settings").update({ monitor_invites_enabled: true }).eq("organization_id", ORG);
    await expect(inviteCallMonitor(h.deps, trainee, id, PROFILES.o3)).rejects.toMatchObject({ status: 403 });
    await h.admin.from("motorist_profiles").update({ active: false }).eq("id", trainee.profileId);
    await expect(invite(h, id)).rejects.toMatchObject({ status: 403 });
    await h.admin.from("motorist_profiles").update({ active: true }).eq("id", trainee.profileId);
    const invitation = await invite(h, id);
    expect((await listMonitorInvitations(h.deps, trainee)).invitations[0]).toMatchObject({ id: invitation.id, mine: false, status: "pending" });
    expect((await listMonitorInvitations(h.deps, { ...trainee, profileId: PROFILES.o3 })).invitations).toEqual([]);
  });
  it("accepts only the selected recipient once and provider dial is monitor", async () => {
    const { h, id } = await talking(); const invitation = await invite(h, id);
    await expect(superviseCall(h.deps, { ...trainee, profileId: PROFILES.o3 }, id, "monitor", invitation.id)).rejects.toMatchObject({ status: 403 });
    await superviseCall(h.deps, trainee, id, "monitor", invitation.id);
    const dial = h.telnyx.of("dial").at(-1)!.params;
    expect(dial.supervisorRole).toBe("monitor"); expect(dial.superviseCallControlId).toBe(h.openLegFor(id, owner.profileId)!.telnyx_call_control_id);
    expect(entries(h, id)[0].acceptedAt).toBeTruthy();
    await expect(superviseCall(h.deps, trainee, id, "monitor", invitation.id)).rejects.toMatchObject({ status: 403 });
    await expect(superviseCall(h.deps, trainee, id, "whisper", invitation.id)).rejects.toMatchObject({ status: 403 });
    await expect(superviseCall(h.deps, trainee, id, "barge")).rejects.toMatchObject({ status: 403 });
    const leg = h.openLegFor(id, trainee.profileId)!;
    await h.legEvent(String(leg.telnyx_call_control_id), "call.answered");
    for (const action of [holdCall(h.deps, trainee, id), hangupCall(h.deps, trainee, id), blindTransfer(h.deps, trainee, id, { number: NUMBERS.external }), inviteCallMonitor(h.deps, trainee, id, PROFILES.o3), addCallParty(h.deps, trainee, id, { number: NUMBERS.external })]) {
      await expect(action).rejects.toMatchObject({ status: 403 });
    }
  });
  it("expires and revokes pending invitations without touching customer media", async () => {
    const { h, id } = await talking(); let invitation = await invite(h, id);
    h.advance(120_001); h.touchDevice(trainee.profileId);
    await expect(superviseCall(h.deps, trainee, id, "monitor", invitation.id)).rejects.toMatchObject({ status: 403 });
    invitation = await invite(h, id); const count = h.telnyx.calls.length;
    await revokeCallMonitorInvitation(h.deps, owner, id, invitation.id);
    expect(h.telnyx.calls).toHaveLength(count);
    await expect(superviseCall(h.deps, trainee, id, "monitor", invitation.id)).rejects.toMatchObject({ status: 403 });
  });
  it("revoke targets monitor only, including a late answer after revocation", async () => {
    const { h, id, customer } = await talking(); const invitation = await invite(h, id);
    await superviseCall(h.deps, trainee, id, "monitor", invitation.id);
    const leg = h.openLegFor(id, trainee.profileId)!;
    await revokeCallMonitorInvitation(h.deps, owner, id, invitation.id);
    await h.legEvent(String(leg.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(leg.telnyx_call_control_id);
    expect(h.telnyx.of("hangup").some(call => call.params.callControlId === customer)).toBe(false);
    expect(h.session(id).state).toBe("talking");
  });
  it("supports conference monitor join and independent stop even after gate disabled", async () => {
    const { h, id, customer } = await talking();
    await completeAnnouncedAction(h, addCallParty(h.deps, owner, id, { number: NUMBERS.external }));
    await h.legEvent(String(h.legByNumber(id, NUMBERS.external)!.telnyx_call_control_id), "call.answered");
    const invitation = await invite(h, id); await superviseCall(h.deps, trainee, id, "monitor", invitation.id);
    const leg = h.openLegFor(id, trainee.profileId)!; await h.legEvent(String(leg.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("conference:join").at(-1)?.params).toMatchObject({ call_control_id: leg.telnyx_call_control_id, supervisor_role: "monitor" });
    await h.admin.from("motorist_telephony_settings").update({ monitor_invites_enabled: false }).eq("organization_id", ORG);
    await stopSupervisingCall(h.deps, trainee, id);
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(leg.telnyx_call_control_id);
    expect(h.telnyx.of("hangup").some(call => call.params.callControlId === customer)).toBe(false);
  });
  it.each(["revoke", "stop"])("keeps %s visible and retries failed teardown after both gates are disabled", async action => {
    const { h, id, customer } = await talking(); const invitation = await invite(h, id);
    await superviseCall(h.deps, trainee, id, "monitor", invitation.id);
    const leg = h.openLegFor(id, trainee.profileId)!;
    const controlId = String(leg.telnyx_call_control_id);
    await h.legEvent(controlId, "call.answered");
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    await h.admin.from("motorist_telephony_settings").update({ monitor_invites_enabled: false }).eq("organization_id", ORG);
    h.telnyx.failAlways("hangup", new TelnyxCommandError({ status: 500, code: "temporary_failure", detail: "Retry monitor disconnect" }));
    await expect(action === "revoke" ? revokeCallMonitorInvitation(h.deps, owner, id, invitation.id) : stopSupervisingCall(h.deps, trainee, id)).rejects.toMatchObject({ status: 502 });
    expect(h.telnyx.physical.legs.get(controlId)?.ended).toBe(false);
    expect(readPendingEffects(h.session(id) as unknown as SessionRow).entries.some(entry => entry.commands.some(command => command.kind === "hangup" && command.reason === "invited_monitor_stopped"))).toBe(true);
    for (const actor of [owner, trainee]) expect((await listMonitorInvitations(h.deps, actor)).invitations).toEqual([expect.objectContaining({ id: invitation.id, status: "disconnecting" })]);
    expect(entries(h, id)[0].disconnectRequestedAt).toBeTruthy();
    expect((h.session(id).metadata as SessionMeta).supervise?.[trainee.profileId]?.invitationId).toBe(invitation.id);
    h.telnyx.clearFailures(); h.advance(31_000);
    await runSessionEvent(h.deps, id, event(h, { type: "sweep", actorProfileId: null }));
    expect(h.telnyx.physical.legs.get(controlId)?.ended).toBe(true);
    // Provider acceptance alone does not assert that the leg has ended.
    expect((await listMonitorInvitations(h.deps, owner)).invitations[0].status).toBe("disconnecting");
    await h.legEvent(controlId, "call.hangup");
    expect((await listMonitorInvitations(h.deps, owner)).invitations[0].status).toBe(action === "revoke" ? "revoked" : "ended");
    expect(h.telnyx.of("hangup").some(call => call.params.callControlId === customer)).toBe(false);
    expect(h.session(id).state).toBe("talking");
  });
  it.each(["revoke", "stop"])("can retry %s after the session and inviter's leg have ended", async action => {
    const { h, id, customer } = await talking(); const invitation = await invite(h, id);
    await superviseCall(h.deps, trainee, id, "monitor", invitation.id);
    const leg = h.openLegFor(id, trainee.profileId)!; const controlId = String(leg.telnyx_call_control_id);
    await h.legEvent(controlId, "call.answered");
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString(), state: "ended" }, row => row.session_id === id && row.role !== "supervisor");
    h.db.update("motorist_call_sessions", { state: "ended", ended_at: h.now().toISOString() }, row => row.id === id);
    for (const actor of [owner, trainee]) expect((await listMonitorInvitations(h.deps, actor)).invitations[0].status).toBe("disconnecting");
    expect((await listMonitorInvitations(h.deps, { ...trainee, profileId: PROFILES.o3 })).invitations).toEqual([]);
    await expect(revokeCallMonitorInvitation(h.deps, { ...owner, profileId: PROFILES.o3 }, id, invitation.id)).rejects.toMatchObject({ status: 403 });
    if (action === "revoke") await revokeCallMonitorInvitation(h.deps, owner, id, invitation.id);
    else await stopSupervisingCall(h.deps, trainee, id);
    expect(h.telnyx.physical.legs.get(controlId)?.ended).toBe(true);
    expect(h.telnyx.of("hangup").some(call => call.params.callControlId === customer)).toBe(false);
    await h.legEvent(controlId, "call.hangup");
    expect((await listMonitorInvitations(h.deps, owner)).invitations).toEqual([]);
  });
  it.each(["revoke", "stop"])("does not let older callback bookkeeping block %s", async action => {
    const { h, id, customer } = await talking(); const invitation = await invite(h, id);
    await superviseCall(h.deps, trainee, id, "monitor", invitation.id);
    const leg = h.openLegFor(id, trainee.profileId)!; const controlId = String(leg.telnyx_call_control_id);
    await h.legEvent(controlId, "call.answered");
    h.db.registerRpc("motorist_create_callback_obligation_v1", () => { throw fakeError("historical callback unavailable", "08006"); });
    const next = emptyTransition(); next.callbacks.push({ source: "missed", callerNumber: NUMBERS.customer, createTask: false });
    const session = h.session(id) as unknown as SessionRow;
    await stageEffects(effectsDeps(h.deps), { session, expectedVersion: session.version, event: event(h, { type: "sweep", id: "older-callback" }),
      result: { next, commands: [], compensations: [], guard: null, ignored: null } });
    await Promise.allSettled([action === "revoke" ? revokeCallMonitorInvitation(h.deps, owner, id, invitation.id) : stopSupervisingCall(h.deps, trainee, id)]);
    expect(h.telnyx.physical.legs.get(controlId)?.ended).toBe(true);
    expect(readPendingEffects(h.session(id) as unknown as SessionRow).entries.some(entry => entry.id === "older-callback")).toBe(true);
    expect(h.telnyx.of("hangup").some(call => call.params.callControlId === customer)).toBe(false);
  });
  it("an older revoked invitation cannot disconnect a later invitation for the same recipient", async () => {
    const { h, id } = await talking(); const old = await invite(h, id);
    await superviseCall(h.deps, trainee, id, "monitor", old.id);
    const oldLeg = h.openLegFor(id, trainee.profileId)!;
    await h.legEvent(String(oldLeg.telnyx_call_control_id), "call.answered");
    await stopSupervisingCall(h.deps, trainee, id);
    await h.legEvent(String(oldLeg.telnyx_call_control_id), "call.hangup");
    const fresh = await invite(h, id);
    await superviseCall(h.deps, trainee, id, "monitor", fresh.id);
    const count = h.telnyx.calls.length;
    await revokeCallMonitorInvitation(h.deps, owner, id, old.id);
    expect(h.telnyx.calls).toHaveLength(count);
    expect((h.session(id).metadata as SessionMeta).supervise?.[trainee.profileId]?.invitationId).toBe(fresh.id);
  });
  it("failed provider acceptance consumes the invitation without ending the customer call", async () => {
    const { h, id, customer } = await talking(); const invitation = await invite(h, id);
    h.telnyx.failNext("dial", "provider refused monitor");
    await expect(superviseCall(h.deps, trainee, id, "monitor", invitation.id)).rejects.toMatchObject({ status: 502 });
    expect(entries(h, id)[0].acceptedAt).toBeTruthy();
    await expect(superviseCall(h.deps, trainee, id, "monitor", invitation.id)).rejects.toMatchObject({ status: 403 });
    expect(h.telnyx.of("hangup").some(call => call.params.callControlId === customer)).toBe(false);
  });
  it("serializes two acceptance attempts and rejects accept after call end", async () => {
    const { h, id, customer } = await talking(); const invitation = await invite(h, id);
    const before = h.telnyx.of("dial").length;
    const results = await Promise.allSettled([superviseCall(h.deps, trainee, id, "monitor", invitation.id), superviseCall(h.deps, trainee, id, "monitor", invitation.id)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(before + 1);
    await h.legEvent(customer, "call.hangup");
    await expect(superviseCall(h.deps, trainee, id, "monitor", invitation.id)).rejects.toMatchObject({ status: 409 });
  });
  it("reducer rejects escalation and provider boundary rejects a bypassed mode/unmute command", async () => {
    const { h, id } = await talking(); const invitation = await invite(h, id);
    await superviseCall(h.deps, trainee, id, "monitor", invitation.id);
    const leg = h.openLegFor(id, trainee.profileId)!; await h.legEvent(String(leg.telnyx_call_control_id), "call.answered");
    await expect(runSessionEvent(h.deps, id, event(h, { supervisor: { profileId: trainee.profileId, sipUri: "", mode: "barge", label: "Trainee" } }))).rejects.toMatchObject({ status: 403 });
    for (const command of [
      { kind: "supervisor_role_switch", supervisorRole: "barge", leg: { callControlId: String(leg.telnyx_call_control_id) } },
      { kind: "conference_unmute", legs: [{ callControlId: String(leg.telnyx_call_control_id) }] },
      { kind: "conference_unhold", legs: [{ callControlId: String(leg.telnyx_call_control_id) }] },
    ]) {
      const session = h.session(id) as unknown as SessionRow; const before = h.telnyx.calls.length;
      const result = await applyReduceResult(effectsDeps(h.deps), { session, expectedVersion: session.version, event: event(h, {}), result: {
        next: emptyTransition(), commands: [{ ...command, commandId: h.nextEventId() } as Command], compensations: [], guard: null, ignored: null,
      } });
      expect(result.failed).toBe(true); expect(h.telnyx.calls).toHaveLength(before);
    }
  });
});
