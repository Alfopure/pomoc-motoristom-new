import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { encodeClientState } from "./client-state";
import { drainCustomerTerminal, processTelnyxEvent, replayDeferredSessionEvents } from "./event-processor";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { TelnyxCommandError } from "./client";
import type { SessionRow } from "../state/types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function mirrorFixture() {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.allianz });
  if (!h.deps.config.configured) throw new Error("configured fixture required");
  const operator = h.legFor(call.sessionId, PROFILES.o1)!;
  // The harness intentionally journals its method-level (camelCase) doubles.
  // This extra accepted row reproduces the real HTTP /calls journal schema.
  h.db.insert("motorist_provider_commands", {
    session_id: call.sessionId, command_id: "mirror-proof-dial", method: "POST", path: "/calls", outcome: "accepted", http_status: 200,
    first_dispatched_at: h.now().toISOString(),
    request_payload: { connection_id: h.deps.config.callControlAppId, to: operator.to_number, from: operator.from_number,
      client_state: encodeClientState({ sid: call.sessionId, role: "operator", operatorId: PROFILES.o1 }) },
    result: { data: { call_control_id: operator.telnyx_call_control_id, call_leg_id: operator.telnyx_call_leg_id, call_session_id: call.telnyxSessionId } },
  });
  const envelope = (type = "call.initiated", extra: Record<string, unknown> = {}, id = `mirror-${type}`) => h.envelope(type, {
    connection_id: h.deps.config.configured ? h.deps.config.credentialConnectionId : "", call_session_id: call.telnyxSessionId,
    call_control_id: "browser-counterpart", call_leg_id: "browser-counterpart-leg", to: "gencred001", from: operator.from_number,
    client_state: null, ...(type === "call.initiated" ? { direction: "incoming", state: "bridging" } : {}), ...extra,
  }, id);
  return { h, call, operator, envelope };
}

describe("credential-side mirrored browser events", () => {
  it("records exactly proven counterparts as ignored without changing call state or dispatching", async () => {
    const { h, call, envelope } = await mirrorFixture();
    const sessions = structuredClone(h.rows("motorist_call_sessions")), legs = structuredClone(h.rows("motorist_call_legs"));
    const commands = [...h.telnyx.calls];
    for (const type of ["call.initiated", "call.answered", "call.bridged", "call.hangup"]) {
      expect(await h.process(envelope(type))).toMatchObject({ status: 200, outcome: "ignored", sessionId: call.sessionId,
        notes: ["verified credential browser mirror"] });
      expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === `mirror-${type}`)).toMatchObject({ status: "processed", attempts: 1 });
      expect(await h.process(envelope(type))).toMatchObject({ status: 200, outcome: "duplicate" });
    }
    expect(h.rows("motorist_call_sessions")).toEqual(sessions);
    expect(h.rows("motorist_call_legs")).toEqual(legs);
    expect(h.telnyx.calls).toEqual(commands);
    expect(h.rows("motorist_job_incidents")).toHaveLength(0);
  });

  it.each([
    ["missing session", { call_session_id: null }], ["different session", { call_session_id: "other-session" }],
    ["missing leg", { call_leg_id: null }], ["missing control", { call_control_id: null }],
    ["foreign destination", { to: "unregistered" }], ["wrong SIP domain", { to: "sip:gencred001@foreign.test" }],
    ["phone destination", { to: NUMBERS.customer }], ["wrong caller", { from: "+421999999999" }],
    ["outgoing direction", { direction: "outgoing" }], ["wrong initial state", { state: "ringing" }],
    ["malformed client state", { client_state: "not-our-state" }], ["non-string client state", { client_state: {} }],
    ["unknown client state", { client_state: encodeClientState({ sid: "unknown-session", role: "operator" }) }],
  ])("does not acknowledge %s as a mirror", async (_name, extra) => {
    const { h, envelope } = await mirrorFixture();
    const result = await h.process(envelope("call.initiated", extra as Record<string, unknown>));
    expect(result.notes).not.toContain("verified credential browser mirror");
    // A payload with no control ID retains the existing provider-session path;
    // it cannot be classified as the distinct credential-side leg.
    if (_name !== "missing control") expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "mirror-call.initiated")?.status).not.toBe("processed");
  });

  it.each(["wrong session environment", "foreign session org", "wrong device environment", "foreign device org", "no credential",
    "ambiguous enrollment", "unaccepted dial", "foreign app dial", "unknown dial", "wrong returned session", "wrong returned leg", "wrong returned control",
    "future dial", "wrong command client state", "wrong operator", "missing app leg"])("requires independent proof: %s", async mode => {
    const { h, call, operator, envelope } = await mirrorFixture();
    const session = h.db.storage("motorist_call_sessions").find(row => row.id === call.sessionId)!;
    const device = h.db.storage("motorist_operator_devices").find(row => row.profile_id === PROFILES.o1)!;
    const journal = h.db.storage("motorist_provider_commands").find(row => row.command_id === "mirror-proof-dial")!;
    const request = journal.request_payload as Record<string, unknown>, result = (journal.result as { data: Record<string, unknown> }).data;
    if (mode === "wrong session environment") session.metadata = { ...(session.metadata as object), environment: "production" };
    if (mode === "foreign session org") session.organization_id = "foreign-org";
    if (mode === "wrong device environment") device.environment = "production";
    if (mode === "foreign device org") device.organization_id = "foreign-org";
    if (mode === "no credential") device.telnyx_credential_id = null;
    if (mode === "ambiguous enrollment") h.db.insert("motorist_operator_mobile_devices", { ...device, profile_id: PROFILES.o2 });
    if (mode === "unaccepted dial") journal.outcome = "unknown";
    if (mode === "foreign app dial") request.connection_id = "other-app";
    if (mode === "unknown dial") request.to = "sip:other@sip.telnyx.com";
    if (mode === "wrong returned session") result.call_session_id = "other-session";
    if (mode === "wrong returned leg") result.call_leg_id = "unknown-leg";
    if (mode === "wrong returned control") result.call_control_id = "unknown-control";
    if (mode === "future dial") journal.first_dispatched_at = new Date(h.now().getTime() + 1).toISOString();
    if (mode === "wrong command client state") request.client_state = encodeClientState({ sid: "other-session", role: "operator", operatorId: PROFILES.o1 });
    if (mode === "wrong operator") request.client_state = encodeClientState({ sid: call.sessionId, role: "operator", operatorId: PROFILES.o2 });
    if (mode === "missing app leg") h.db.update("motorist_call_legs", { telnyx_call_control_id: "other-control" }, row => row.id === operator.id);
    expect(await h.process(envelope())).toMatchObject({ status: 500, outcome: "awaiting_correlation" });
  });

  it("keeps foreign connections rejected and normal customer events on their ordinary path", async () => {
    const { h, call, operator, envelope } = await mirrorFixture();
    expect(await h.process(envelope("call.initiated", { connection_id: "foreign-connection" }))).toMatchObject({ outcome: "unverified_connection" });
    expect(h.rows("motorist_telnyx_webhook_events").some(row => row.event_id === "mirror-call.initiated")).toBe(false);
    await completeCallAnnouncements(h, call.sessionId);
    h.telnyx.physical.answered(String(operator.telnyx_call_control_id));
    await h.legEvent(String(operator.telnyx_call_control_id), "call.answered");
    h.telnyx.physical.ended(call.callControlId);
    const hangup = await h.legEvent(call.callControlId, "call.hangup");
    expect(hangup).toMatchObject({ outcome: "processed" });
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.legs(call.sessionId).find(row => row.role === "customer")?.ended_at).toEqual(expect.any(String));
  });

  it("keeps missing proof retryable, and never revives a historical terminal claim after proof arrives", async () => {
    const { h, envelope } = await mirrorFixture();
    const journal = h.db.storage("motorist_provider_commands").find(row => row.command_id === "mirror-proof-dial")!;
    journal.outcome = "unknown";
    expect(await h.process(envelope())).toMatchObject({ outcome: "awaiting_correlation" });
    h.advance(60_001);
    journal.outcome = "accepted";
    expect(await h.process(envelope())).toMatchObject({ outcome: "unresolved", error: "awaiting_correlation_expired" });
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "mirror-call.initiated")).toMatchObject({ retry_state: "dead_letter", processed_at: null });
  });

  it.each(["webhook", "action"])("recovers all four early mirrors after the %s owner makes dial proof durable", async owner => {
    const { h, call, operator, envelope } = await mirrorFixture();
    const journal = h.db.storage("motorist_provider_commands").find(row => row.command_id === "mirror-proof-dial")!;
    const leg = h.db.storage("motorist_call_legs").find(row => row.id === operator.id)!;
    journal.outcome = "unknown";
    leg.telnyx_call_control_id = "not-persisted-yet";
    const deliveries = ["call.initiated", "call.answered", "call.bridged", "call.hangup"].map(type => envelope(type));
    for (const event of deliveries) {
      expect(await h.process(event)).toMatchObject({ outcome: "awaiting_correlation" });
      // All provider retries can be consumed before the app dial returns.
      for (let retry = 0; retry < 5; retry++) expect(await h.process(event)).toMatchObject({ outcome: "busy" });
    }
    const retained: Array<() => Promise<void>> = [];
    h.deps.deferMaintenance = work => retained.push(work);
    if (owner === "webhook") {
      expect(await h.legEvent(call.callControlId, "call.answered")).toMatchObject({ outcome: "ignored" });
      expect(retained).toHaveLength(1);
    }
    journal.outcome = "accepted";
    leg.telnyx_call_control_id = operator.telnyx_call_control_id;
    const session = structuredClone(h.session(call.sessionId)), legs = structuredClone(h.legs(call.sessionId));
    const commands = [...h.telnyx.calls];
    // SQL's correlation claim may pass its ordinary retry due-time, but still
    // checks a competing claim and the 60-second awaiting expiry itself.
    if (owner === "webhook") await retained[0]();
    else await replayDeferredSessionEvents(h.deps, call.sessionId);
    expect(h.rows("motorist_telnyx_webhook_events").filter(row => String(row.event_id).startsWith("mirror-")))
      .toEqual(expect.arrayContaining(deliveries.map((_, index) => expect.objectContaining({
        event_id: `mirror-${["call.initiated", "call.answered", "call.bridged", "call.hangup"][index]}`,
        status: "processed", attempts: 2, delivery_count: 6, retry_state: "ready",
      }))));
    expect(h.session(call.sessionId)).toEqual(session);
    expect(h.legs(call.sessionId)).toEqual(legs);
    expect(h.telnyx.calls).toEqual(commands);
    expect(retained).toHaveLength(owner === "webhook" ? 1 : 0);
  });

  it.each(["unknown proof", "competing claim", "expired", "payload identity"])("retained mirror replay preserves %s", async mode => {
    const { h, call, envelope } = await mirrorFixture();
    const journal = h.db.storage("motorist_provider_commands").find(row => row.command_id === "mirror-proof-dial")!;
    journal.outcome = "unknown";
    await h.process(envelope());
    const row = h.db.storage("motorist_telnyx_webhook_events").find(row => row.event_id === "mirror-call.initiated")!;
    if (mode !== "unknown proof") journal.outcome = "accepted";
    if (mode === "competing claim") row.claimed_at = h.now().toISOString();
    if (mode === "expired") h.advance(60_001);
    if (mode === "payload identity") (row.payload as Record<string, unknown>).call_session_id = "foreign-session";
    const commands = [...h.telnyx.calls];
    await replayDeferredSessionEvents(h.deps, call.sessionId);
    expect(row).toMatchObject({ processed_at: null, attempts: 1,
      retry_state: mode === "expired" ? "dead_letter" : "awaiting_correlation" });
    expect(h.telnyx.calls).toEqual(commands);
  });

  it("retains the TEST deployment guard before any mirror claim", async () => {
    const { h, envelope } = await mirrorFixture();
    if (!h.deps.config.configured) throw new Error("configured fixture required");
    h.deps.config.testSafety = { restricted: true, deploymentAllowed: false, enabled: false, allowedNumbers: [], fromNumbers: [] };
    for (const type of ["call.initiated", "call.answered", "call.bridged", "call.hangup"]) {
      expect(await h.process(envelope(type))).toMatchObject({ outcome: "unverified_connection" });
    }
    expect(h.rows("motorist_telnyx_webhook_events").filter(row => String(row.event_id).startsWith("mirror-"))).toEqual([]);
  });

  it("does not claim success when another invocation took over the mirror ledger", async () => {
    const { h, envelope } = await mirrorFixture();
    h.db.registerRpc("motorist_telnyx_finish_webhook_event_v2", () => false);
    expect(await h.process(envelope())).toMatchObject({ status: 500, outcome: "busy" });
  });
});

function earlyHangup(h: TelephonyHarness, extra: Record<string, unknown> = {}) {
  return h.envelope("call.hangup", { call_control_id: "early-customer", call_leg_id: "early-customer-leg",
    call_session_id: "early-session", hangup_cause: "originator_cancel", hangup_source: "caller", ...extra }, "early-hangup");
}

async function failedInbound(h: TelephonyHarness, retained: Array<() => Promise<void>>) {
  h.telnyx.failNext("answer", new TelnyxCommandError({ status: 422, code: "90018", detail: "Call has already ended" }));
  return processTelnyxEvent({ ...h.deps, deferMaintenance: work => retained.push(work) }, h.envelope("call.initiated", {
    call_control_id: "early-customer", call_leg_id: "early-customer-leg", call_session_id: "early-session",
    direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer,
  }, "late-init"));
}

describe("early customer terminal correlation after an unsuccessful owner", () => {
  it.each([0, 59_000])("drains the real early hangup after callGone before expiry (age %sms)", async age => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    expect(await h.process(earlyHangup(h))).toMatchObject({ outcome: "awaiting_correlation" });
    h.advance(age);
    const retained: Array<() => Promise<void>> = [];
    const failed = await failedInbound(h, retained);
    expect(failed).toMatchObject({ outcome: "failed", status: 200 });
    expect(retained).toHaveLength(1);
    const commands = [...h.telnyx.calls];
    await retained[0]();
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "early-hangup"))
      .toMatchObject({ status: "processed", retry_state: "ready", attempts: 2, delivery_count: 1 });
    // callGone already closed the call as failed. A late exact hangup is
    // acknowledged without rewriting or reviving that terminal outcome.
    expect(h.legs(failed.sessionId!).find(row => row.role === "customer")).toMatchObject({ state: "failed", ended_at: expect.any(String) });
    expect(h.session(failed.sessionId!)).toMatchObject({ state: "failed", ended_at: expect.any(String) });
    expect(h.telnyx.calls.slice(commands.length).some(row => ["dial", "answer", "gather", "playbackStart"].includes(row.method))).toBe(false);
    expect(retained).toHaveLength(1);
  });

  it("preserves the ledger expiry instead of resurrecting a late or historical early hangup", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    await h.process(earlyHangup(h));
    h.advance(60_001);
    const retained: Array<() => Promise<void>> = [];
    const failed = await failedInbound(h, retained);
    await retained[0]();
    const row = h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "early-hangup");
    expect(row).toMatchObject({ retry_state: "dead_letter", terminal_reason: "awaiting_correlation_expired", processed_at: null });
    await drainCustomerTerminal(h.deps, h.session(failed.sessionId!) as SessionRow);
    expect(h.rows("motorist_telnyx_webhook_events").find(item => item.event_id === "early-hangup")).toEqual(row);
  });

  it.each(["foreign org", "wrong environment", "payload control", "payload session", "payload leg", "malformed state", "non-string state", "conflicting state"])
    ("does not drain early customer rows with %s", async mode => {
      const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
      await h.process(earlyHangup(h));
      const retained: Array<() => Promise<void>> = [];
      const failed = await failedInbound(h, retained);
      const row = h.db.storage("motorist_telnyx_webhook_events").find(item => item.event_id === "early-hangup")!;
      const payload = row.payload as Record<string, unknown>;
      if (mode === "foreign org") row.organization_id = "foreign-org";
      if (mode === "wrong environment") h.db.update("motorist_call_sessions", { metadata: { environment: "production" } }, item => item.id === failed.sessionId);
      if (mode === "payload control") payload.call_control_id = "unknown-control";
      if (mode === "payload session") payload.call_session_id = "unknown-session";
      if (mode === "payload leg") payload.call_leg_id = "unknown-leg";
      if (mode === "malformed state") payload.client_state = "invalid";
      if (mode === "non-string state") payload.client_state = {};
      if (mode === "conflicting state") payload.client_state = encodeClientState({ sid: "wrong-session", role: "customer" });
      // The retained owner captured a session snapshot; use the public drain for
      // the environment test so it receives the changed authoritative snapshot.
      if (mode === "wrong environment") await drainCustomerTerminal(h.deps, h.session(failed.sessionId!) as SessionRow);
      else await retained[0]();
      expect(h.rows("motorist_telnyx_webhook_events").find(item => item.event_id === "early-hangup"))
        .toMatchObject({ retry_state: "awaiting_correlation", attempts: 1, processed_at: null });
    });
});
