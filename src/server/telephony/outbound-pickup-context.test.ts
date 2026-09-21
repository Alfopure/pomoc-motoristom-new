import { afterEach, describe, expect, it, vi } from "vitest";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { createRateLimiter, holdCall, parkCall, pickupWaitingCall, startOutboundCall } from "./call-actions";
import { loadRoutingContext, loadSessionSnapshot } from "./session-runner";
import { parseTelnyxEnvelope } from "./state/events";
import { reduce } from "./state/transitions";
import { readMeta, toJson, type SessionMeta, type SessionRow } from "./state/types";
import { encodeClientState } from "./telnyx/client-state";
import { TelnyxCommandError } from "./telnyx/client";

afterEach(() => vi.unstubAllEnvs());
const caller = { profileId: PROFILES.o1, role: "dispatcher" as const };
const picker = { profileId: PROFILES.o2, role: "dispatcher" as const };

async function outboundPickup() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  for (const name of ["TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(name, "false");
  const h = createTelephonyHarness({ writerContract: 2 });
  const deps = { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
  const call = await startOutboundCall(deps, caller, { to: NUMBERS.customer, requestId: "00000000-0000-4000-8000-000000000991" });
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  const customer = h.legs(call.sessionId).find(leg => leg.role === "customer")!;
  await h.legEvent(String(customer.telnyx_call_control_id), "call.answered");
  expect(h.session(call.sessionId).state).toBe("talking");
  await completeAnnouncedAction(h, holdCall(deps, caller, call.sessionId));
  expect(h.session(call.sessionId).state).toBe("held");
  await completeAnnouncedAction(h, parkCall(deps, caller, call.sessionId));
  expect(h.session(call.sessionId)).toMatchObject({ state: "parked", conference_id: null });
  await h.legEvent(call.operatorLegCallControlId, "call.hangup");
  const pickup = await pickupWaitingCall(deps, picker, call.sessionId);
  const control = pickup.operatorLegCallControlId!;
  const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
  expect(snapshot.session).toMatchObject({ writer_contract: 2, direction: "outbound", state: "parked" });
  expect(readMeta(snapshot.session).ring?.plan).toBeUndefined();
  const envelope = h.envelope("call.answered", {
    call_control_id: control,
    client_state: encodeClientState(h.clientStateOf(control)),
  });
  const event = parseTelnyxEnvelope(envelope)!;
  return { h, deps, call, customer, control, snapshot, event, envelope };
}

describe("exact outbound pickup context", () => {
  it.each(["unknown control", "conflicting sid", "event intent", "saved intent"])("characterizes the unchanged full reducer for %s", async kind => {
    const { h, snapshot, event, control } = await outboundPickup();
    if (kind === "unknown control") event.callControlId = "early-pickup";
    if (kind === "conflicting sid") event.clientState!.sid = "other-session";
    if (kind === "event intent") event.clientState!.intent = "consult";
    if (kind === "saved intent") snapshot.legs.find(leg => leg.telnyx_call_control_id === control)!.client_state = toJson({ ...event.clientState, intent: "ring" });
    const selected = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
    const full = await loadRoutingContext(h.deps, snapshot.session);
    expect(selected.lean).toBeUndefined();
    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, selected);
    expect(result).toEqual(reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, full));
    // Baseline: persisted intent wins; an unprojected same-session pickup is
    // recoverable. Conflicting event hints do not rewrite a saved leg's intent.
    expect(result.commands.some(command => command.kind === "bridge")).toBe(kind !== "saved intent");
  });

  it("recovers an answer that overtakes the saved leg projection", async () => {
    const { h, call, control, envelope } = await outboundPickup();
    h.db.delete("motorist_call_legs", row => row.telnyx_call_control_id === control);
    const result = await h.process(envelope);
    expect(result.outcome).toBe("processed");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: picker.profileId });
    expect(h.telnyx.of("bridge").at(-1)?.params.targetCallControlId).toBe(control);
  });

  it("does not correlate an unknown leg using only the shared provider session", async () => {
    const { h, call } = await outboundPickup();
    const before = h.telnyx.calls.length;
    const result = await h.process(h.envelope("call.answered", {
      call_control_id: "uncorrelated", call_session_id: h.session(call.sessionId).telnyx_session_id,
    }));
    expect(result.outcome).toBe("awaiting_correlation");
    expect(h.telnyx.calls).toHaveLength(before);
    expect(h.session(call.sessionId).state).toBe("parked");
  });

  it("uses one settings read for the real outbound → answered → held → parked → pickup fixture", async () => {
    const { h, snapshot, event } = await outboundPickup();
    expect(snapshot.session.customer_leg_id).toBeNull();
    expect(snapshot.legs.filter(leg => leg.role === "customer")).toHaveLength(1);
    const before = h.db.log.length;
    const lean = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
    const reads = h.db.log.length - before;
    const fullStart = h.db.log.length;
    const full = await loadRoutingContext(h.deps, snapshot.session);
    expect(lean.lean).toBe(true);
    expect(reads).toBe(1);
    expect(h.db.log.length - fullStart).toBeGreaterThan(reads);
    expect(lean.mediaAvailable).toBe(true);
    expect(lean.announcements).toEqual(full.announcements);
    expect(lean.settings).toEqual(full.settings);
    expect(reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, lean))
      .toEqual(reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, full));
  });

  it.each(["parked", "waiting"] as const)("matches all commands, guards, compensation and transitions for first bridged in %s", async state => {
    const { h, snapshot, event } = await outboundPickup();
    snapshot.session.state = state;
    event.type = "call.bridged";
    const lean = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
    const full = await loadRoutingContext(h.deps, snapshot.session);
    expect(lean.lean).toBe(true);
    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, lean);
    expect(result).toEqual(reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, full));
    expect(result.next.session.state).toBe("talking");
    expect(result.guard).toMatchObject({ profileId: picker.profileId, offerToken: event.clientState!.offerToken });
    expect(result.commands.some(command => command.kind === "bridge")).toBe(false);
  });

  it.each([
    ["recording enabled", (m: SessionMeta) => { m.recording!.policy.enabled = true; }],
    ["missing frozen policy", (m: SessionMeta) => { delete m.recording; }],
    ["recorder", (m: SessionMeta) => { m.recording!.recorders = [{ id: "recorder" } as never]; }],
    ["recording barrier", (m: SessionMeta) => { m.recording!.barrier = { epoch: 0, action: null, deadlineAt: "2026-09-03T09:00:00Z" }; }],
    ["pending audio", (m: SessionMeta) => { m.recording!.pendingAudio = { epoch: 0, readyAt: "2026-09-03T09:00:00Z", sourceEventId: "pending", commands: [] }; }],
    ["announcement", (m: SessionMeta) => { m.announcement_sequence = { id: "notice" } as never; }],
    ["missing frozen announcements", (m: SessionMeta) => { delete m.announcements; }],
    ["privacy greeting", (m: SessionMeta) => { m.greeting = { started_at: "2026-09-03T08:00:00Z", recording_notice: "recordingNotice" }; }],
    ["customer gone", (m: SessionMeta) => { m.gather = { spec: { purpose: "moh_tick" }, call_gone: true } as never; }],
    ["failed gather", (m: SessionMeta) => { m.gather = { spec: { purpose: "moh_tick" }, failed: true } as never; }],
    ["privacy gather", (m: SessionMeta) => { m.gather = { spec: { purpose: "ivr" } } as never; }],
    ["queue", (m: SessionMeta) => { m.queue = { next_offer_at: "2026-09-03T09:00:00Z" }; }],
    ["consult", (m: SessionMeta) => { m.consult = { by: picker.profileId } as never; }],
    ["transfer", (m: SessionMeta) => { m.transfer = { kind: "blind" } as never; }],
    ["conference", (m: SessionMeta) => { m.conference = { by: caller.profileId, promoted_at: "2026-09-03T08:00:00Z" }; }],
    ["terminal intent", (m: SessionMeta) => { m.hangup = { by: caller.profileId, at: "2026-09-03T08:00:00Z", scope: "session" }; }],
    ["missing pickup", (m: SessionMeta) => { m.pickup = null; }],
    ["different picker", (m: SessionMeta) => { m.pickup!.by = PROFILES.o5; }],
    ["other ring mode", (m: SessionMeta) => { m.ring!.mode = "transfer"; }],
  ] as const)("retains full configuration for %s", async (_name, change) => {
    const { h, snapshot, event } = await outboundPickup();
    const meta = readMeta(snapshot.session);
    change(meta);
    snapshot.session.metadata = toJson(meta);
    const before = h.db.log.length;
    expect((await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs)).lean).toBeUndefined();
    expect(h.db.log.slice(before).some(entry => entry.table === "motorist_telephony_lines")).toBe(true);
  });

  it.each([
    ["old contract", { writer_contract: 1 }],
    ["inbound", { direction: "inbound" }],
    ["held", { state: "held" }],
    ["ended timestamp", { ended_at: "2026-09-03T08:00:00Z" }],
    ["termination", { termination_requested_at: "2026-09-03T08:00:00Z" }],
    ["conference id", { conference_id: "conference" }],
    ["wrong customer id", { customer_leg_id: "other-customer" }],
    ["pending effects", { pending_effects: { version: 1, entries: [{ id: "pending" }] } }],
  ] as const)("does not select lean with %s", async (_name, patch) => {
    const { h, snapshot, event } = await outboundPickup();
    Object.assign(snapshot.session, patch);
    expect((await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs)).lean).toBeUndefined();
  });

  it.each(["event role", "event profile", "event token", "missing event token", "saved sid", "saved role", "saved profile", "saved token", "leg profile", "leg session", "leg organization", "ended pickup", "failed pickup", "ended customer", "ambiguous customer"])("keeps %s off the fast path", async kind => {
    const { h, snapshot, event, control } = await outboundPickup();
    const leg = snapshot.legs.find(row => row.telnyx_call_control_id === control)!;
    const saved = { ...event.clientState! };
    if (kind === "event role") event.clientState!.role = "consult";
    if (kind === "event profile") event.clientState!.operatorId = PROFILES.o5;
    if (kind === "event token") event.clientState!.offerToken = "stale";
    if (kind === "missing event token") delete event.clientState!.offerToken;
    if (kind === "saved sid") saved.sid = "other-session";
    if (kind === "saved role") saved.role = "consult";
    if (kind === "saved profile") saved.operatorId = PROFILES.o5;
    if (kind === "saved token") saved.offerToken = "stale";
    leg.client_state = toJson(saved);
    if (kind === "leg profile") leg.profile_id = PROFILES.o5;
    if (kind === "leg session") leg.session_id = "other-session";
    if (kind === "leg organization") leg.organization_id = "other-org";
    if (kind === "ended pickup") leg.ended_at = h.now().toISOString();
    if (kind === "failed pickup") leg.state = "failed";
    const customer = snapshot.legs.find(row => row.role === "customer")!;
    if (kind === "ended customer") customer.ended_at = h.now().toISOString();
    if (kind === "ambiguous customer") snapshot.legs.push({ ...customer, id: "other-customer", telnyx_call_control_id: "other-control" });
    expect((await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs)).lean).toBeUndefined();
  });

  it("keeps media availability truthful, settings current and follow-up sweeps full", async () => {
    const { h, call, snapshot, event } = await outboundPickup();
    h.db.update("motorist_telephony_settings", { park_max_minutes: 7 }, () => true);
    const deps = { ...h.deps, config: { ...h.deps.config, mediaBaseUrl: null } };
    const lean = await loadRoutingContext(deps, snapshot.session, event, snapshot.legs);
    const full = await loadRoutingContext(deps, snapshot.session);
    expect(lean).toMatchObject({ lean: true, mediaAvailable: false, settings: { parkMaxMinutes: 7 } });
    expect(reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, lean))
      .toEqual(reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, full));
    const sweep = await loadRoutingContext(h.deps, snapshot.session, {
      kind: "app", type: "sweep", id: "follow", actorProfileId: null, occurredAt: h.now().toISOString(),
    }, snapshot.legs);
    expect(sweep.lean).toBeUndefined();
    expect(sweep.line?.id).toBe(h.session(call.sessionId).line_id);
  });

  it("retains bridge-first audio cleanup and the pickup ownership guard", async () => {
    const { h, call, snapshot, event, envelope } = await outboundPickup();
    const context = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context);
    expect(result.commands.map(command => command.kind)).toEqual(["bridge", "playback_stop", "gather_stop"]);
    expect(result.guard).toMatchObject({ profileId: picker.profileId, offerToken: event.clientState!.offerToken });
    expect(result.guard!.onRejected.commands.map(command => command.kind)).toEqual(["hangup"]);
    const before = h.telnyx.calls.length;
    expect((await h.process(envelope)).outcome).toBe("processed");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: picker.profileId, pending_effects: null, lease_token: null });
    expect(h.presence(picker.profileId)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(h.telnyx.calls.slice(before).map(command => command.method)).toEqual(["bridge", "playbackStop", "gatherStop"]);
  });

  it("keeps a rejected bridge in a timed waiting room with its music", async () => {
    const { h, call, control, customer, envelope } = await outboundPickup();
    h.db.update("motorist_telephony_settings", { park_max_minutes: 7 }, () => true);
    h.telnyx.failNext("bridge", new TelnyxCommandError({ code: "bridge_rejected", status: 422, detail: "Bridge refused" }));
    const before = h.telnyx.calls.length;
    expect((await h.process(envelope)).outcome).toBe("failed");
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", answered_by_profile_id: null, ended_at: null, pending_effects: null });
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting).toMatchObject({ reason: "bridge_failed", max_minutes: 7 });
    const commands = h.telnyx.calls.slice(before);
    expect(commands.some(command => command.method === "playbackStop")).toBe(false);
    expect(commands.some(command => command.method === "gather")).toBe(true);
    expect(commands.filter(command => command.method === "hangup").map(command => command.params.callControlId)).toEqual([control]);
    expect(h.legs(call.sessionId).find(leg => leg.id === customer.id)?.ended_at).toBeNull();
  });

  it("preserves unknown bridge evidence and durable recovery without destructive compensation", async () => {
    const { h, call, envelope } = await outboundPickup();
    h.telnyx.loseNextResponse("bridge");
    const before = h.telnyx.calls.length;
    expect((await h.process(envelope)).outcome).toBe("failed");
    expect(h.session(call.sessionId).pending_effects).toBeTruthy();
    // The fake mirrors journal admission: no response leaves the admitted
    // command with no outcome, rather than manufacturing a provider refusal.
    expect(h.rows("motorist_provider_commands").find(row => String(row.path).endsWith("/actions/bridge")))
      .toMatchObject({ outcome: null, http_status: null, result: null });
    expect(h.telnyx.calls.slice(before).some(command => ["hangup", "playbackStop", "gatherStop"].includes(command.method))).toBe(false);
  });

  it("keeps atomic reservation authoritative when a second operator attempts pickup", async () => {
    const { h, deps, call, envelope } = await outboundPickup();
    const dials = h.telnyx.of("dial").length;
    await expect(pickupWaitingCall(deps, { profileId: PROFILES.o5, role: "admin" }, call.sessionId)).rejects.toMatchObject({ status: 409 });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect((await h.process(envelope)).outcome).toBe("processed");
    expect(h.session(call.sessionId).answered_by_profile_id).toBe(picker.profileId);
  });

  it("keeps the winner guard when ownership changes after pickup", async () => {
    const { h, call, control, envelope } = await outboundPickup();
    h.setPresence(picker.profileId, { status: "on_call", current_session_id: "other-session", offer_token: "other-token" });
    const before = h.telnyx.calls.length;
    expect((await h.process(envelope)).outcome).toBe("processed");
    expect(h.session(call.sessionId)).toMatchObject({ state: "parked", answered_by_profile_id: null });
    expect(h.telnyx.calls.slice(before)).toEqual([expect.objectContaining({ method: "hangup", params: expect.objectContaining({ callControlId: control }) })]);
  });

  it("does not bridge a customer who hangs up after pickup but before the answer", async () => {
    const { h, call, customer, envelope } = await outboundPickup();
    await h.legEvent(String(customer.telnyx_call_control_id), "call.hangup");
    const before = h.telnyx.calls.length;
    await h.process(envelope);
    expect(h.telnyx.calls.slice(before).some(command => command.method === "bridge")).toBe(false);
    expect(h.session(call.sessionId).ended_at).toBeTruthy();
  });
});
