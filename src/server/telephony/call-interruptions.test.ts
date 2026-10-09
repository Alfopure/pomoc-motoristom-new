import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { callInterruptionConfiguration, getCallInterruptionHealth, type CallInterruptionConfiguration } from "./call-interruptions";

const NOW = "2026-10-06T12:00:00.000Z";
const ENDED = "2026-10-06T11:50:00.000Z";
const CLASSIFIED = "2026-10-06T11:56:00.000Z";
const configuration: CallInterruptionConfiguration = { environment: "test", since: "2026-10-06T11:00:00.000Z", testConnectionIds: ["test-app", "test-credential"], testCallControlAppId: "test-app" };

function fixture() {
  const h = createTelephonyHarness();
  h.db.seed("motorist_diagnostic_incidents", [{ id: "incident", organization_id: ORG, environment: "test", kind: "call_interruption", classification: "interruption_observed", status: "new", call_session_id: "call", leg_id: "operator-leg", first_seen_at: ENDED, classified_at: CLASSIFIED }]);
  h.db.seed("motorist_call_sessions", [{ id: "call", organization_id: ORG, direction: "inbound", metadata: { environment: "development" }, telnyx_session_id: "provider-session", customer_leg_id: "customer-leg" }]);
  h.db.seed("motorist_call_legs", [
    { id: "operator-leg", organization_id: ORG, session_id: "call", profile_id: PROFILES.o1, role: "operator", answered_at: "2026-10-06T11:40:00.000Z", bridged_at: "2026-10-06T11:40:00.000Z", ended_at: ENDED, telnyx_call_control_id: "test-control" },
    { id: "customer-leg", organization_id: ORG, session_id: "call", role: "customer", answered_at: "2026-10-06T11:40:00.000Z", ended_at: null },
  ]);
  h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "ingress", organization_id: ORG, event_type: "call.initiated", call_control_id: "test-control", connection_id: "test-credential" }]);
  return { h, read: (config: CallInterruptionConfiguration | null = configuration) => getCallInterruptionHealth({ admin: h.admin, organizationId: ORG, now: new Date(NOW), configuration: config }) };
}

describe("confirmed interruption health", () => {
  it("requires explicit activation and accepts only rechecked same-environment, TEST-owned evidence", async () => {
    const { h, read } = fixture();
    expect(await read(null)).toMatchObject({ status: "skipped", detail: { reason: "not_activated", entries: [] } });
    const report = await read();
    expect(report).toMatchObject({ status: "fail", detail: { confirmed: 1, entries: [{ incidentId: "incident", sessionId: "call", legId: "operator-leg", environment: "test", classification: "interruption_observed", interruptedAt: ENDED }] } });
    expect(JSON.stringify(report)).not.toContain("test-control");
    expect(JSON.stringify(report)).not.toContain(PROFILES.o1);
    expect(h.rows("motorist_diagnostic_incidents")[0].status).toBe("new");
  });

  it.each(["production", "test", ""])("rejects %s call metadata copied into TEST", async environment => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { metadata: environment ? { environment } : {} }, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it.each([
    { environment: "production" }, { classification: "candidate" }, { classification: "unknown" },
    { classification: "expected_end" }, { status: "resolved" }, { organization_id: "foreign-org" },
    { first_seen_at: "2026-10-06T10:59:59.000Z" }, { first_seen_at: "2026-10-06T11:59:00.000Z" },
    { classified_at: "2026-10-06T11:54:59.000Z" }, { classified_at: "2026-10-06T11:49:00.000Z" },
    { classified_at: "2026-10-06T12:01:00.000Z" },
  ])("excludes stale, immature, foreign or already resolved incidents %j", async patch => {
    const { h, read } = fixture();
    h.db.update("motorist_diagnostic_incidents", patch, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it("does not use a copied signed event from a production connection as TEST provenance", async () => {
    const { h, read } = fixture();
    h.db.update("motorist_telnyx_webhook_events", { connection_id: "production-app" }, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it("accepts an exact accepted TEST dial without requiring copied provider IDs to be trusted", async () => {
    const { h, read } = fixture();
    h.db.delete("motorist_telnyx_webhook_events", () => true);
    const command = { command_id: "command", session_id: "call", method: "POST", path: "/calls", outcome: "accepted", request_payload: { connection_id: "test-app" }, result: { data: { call_control_id: "test-control" } } };
    h.db.seed("motorist_provider_commands", [command]);
    expect(await read()).toMatchObject({ status: "fail", detail: { confirmed: 1 } });
    h.db.update("motorist_provider_commands", { request_payload: { connection_id: "production-app" } }, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it.each(["hold_started_at", "parked_at", "termination_requested_at"])("rechecks fresh normal %s evidence before mailing", async field => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { [field]: ENDED }, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it.each([{ hangup: { at: ENDED } }, { transfer: { by: PROFILES.o1, completed_at: ENDED } }])("rechecks completed hangup/transfer metadata %j", async metadata => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { metadata: { environment: "development", ...metadata } }, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it.each([
    { park: { by: PROFILES.o1, at: ENDED } },
    { transfer: { kind: "blind", by: PROFILES.o1, at: ENDED, completed_at: "2026-10-06T11:50:40.000Z" } },
  ])("keeps normal park→pickup and delayed blind transfer departure expected %j", async metadata => {
    const { h, read } = fixture();
    h.db.update("motorist_call_sessions", { parked_at: null, metadata: { environment: "development", ...metadata } }, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
    h.db.update("motorist_call_sessions", { metadata: { environment: "development", ...("park" in metadata ? { park: { ...metadata.park, by: PROFILES.o2 } } : { transfer: { ...metadata.transfer, by: PROFILES.o2 } }) } }, () => true);
    expect(await read()).toMatchObject({ status: "fail" });
  });

  it("accepts only a successful same-actor conference departure with durable audit evidence", async () => {
    const { h, read } = fixture();
    const normalized = { session_id: "call", error: null, commands: [{ kind: "conference_leave", ok: true }] };
    h.db.seed("motorist_call_events", [{ id: "leave", event_fingerprint: "leave", organization_id: ORG, provider: "telnyx", provider_session_id: "provider-session", event_type: "app.leave_conference", handled_status: "processed", provider_timestamp: ENDED, payload: { actor: PROFILES.o1 }, normalized_payload: normalized }]);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
    for (const patch of [{ payload: { actor: PROFILES.o2 } }, { normalized_payload: { ...normalized, commands: [{ kind: "conference_leave", ok: false }] } }, { normalized_payload: { ...normalized, commands: [{ kind: "conference_leave", ok: true, skipped: true }] } }, { normalized_payload: { ...normalized, session_id: "foreign-session" } }]) {
      h.db.update("motorist_call_events", { payload: { actor: PROFILES.o1 }, normalized_payload: normalized, ...patch }, () => true);
      expect(await read()).toMatchObject({ status: "fail" });
    }
  });

  it("keeps an already connected same-profile sibling expected but does not hide later recovery", async () => {
    const { h, read } = fixture();
    h.db.seed("motorist_call_legs", [{ id: "sibling", organization_id: ORG, session_id: "call", profile_id: PROFILES.o1, role: "operator", bridged_at: "2026-10-06T11:49:00.000Z", ended_at: null }]);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
    h.db.update("motorist_call_legs", { bridged_at: "2026-10-06T11:50:01.000Z" }, row => row.id === "sibling");
    expect(await read()).toMatchObject({ status: "fail" });
    h.db.update("motorist_call_legs", { bridged_at: "2026-10-06T11:49:00.000Z", profile_id: PROFILES.o2 }, row => row.id === "sibling");
    expect(await read()).toMatchObject({ status: "fail" });
  });

  it("uses only the same operator's same-environment late hangup intent", async () => {
    const { h, read } = fixture();
    const intent = { id: "intent", organization_id: ORG, environment: "test", profile_id: PROFILES.o2, call_session_id: "call", received_at: NOW, event: { reason: "hangup_requested", occurredAt: ENDED } };
    h.db.seed("motorist_diagnostic_events", [intent]);
    expect(await read()).toMatchObject({ status: "fail" });
    h.db.update("motorist_diagnostic_events", { profile_id: PROFILES.o1, environment: "production" }, () => true);
    expect(await read()).toMatchObject({ status: "fail" });
    h.db.update("motorist_diagnostic_events", { environment: "test" }, () => true);
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it.each([{ role: "supervisor" }, { bridged_at: null }, { session_id: "another-call" }, { ended_at: "2026-10-06T11:49:00.000Z" }])("does not turn an unrelated leg into confirmed interruption %j", async patch => {
    const { h, read } = fixture();
    h.db.update("motorist_call_legs", patch, row => row.id === "operator-leg");
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
  });

  it("suppresses simultaneous customer end and reports incomplete reads without inventing an interruption", async () => {
    const { h, read } = fixture();
    h.db.update("motorist_call_legs", { ended_at: ENDED }, row => row.id === "customer-leg");
    expect(await read()).toMatchObject({ status: "ok", detail: { entries: [] } });
    h.db.failNext("motorist_diagnostic_incidents", "select", "private SQL response");
    const result = await read();
    expect(result).toMatchObject({ status: "warn", detail: { entries: [], error: "interruption_evidence_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("private SQL response");
  });

  it("bounds the incident batch and avoids a misleading complete result", async () => {
    const { h, read } = fixture();
    const original = h.rows("motorist_diagnostic_incidents")[0];
    h.db.seed("motorist_diagnostic_incidents", Array.from({ length: 21 }, (_, index) => ({ ...original, id: `incident-${index}` })));
    expect(await read()).toMatchObject({ status: "fail", detail: { truncated: true, confirmed: 20 } });
  });
});

describe("interruption activation", () => {
  const env = { MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", DIAGNOSTICS_CLASSIFIER_ENABLED: "true", DIAGNOSTICS_CALL_ALERTS_SINCE: configuration.since, TELNYX_API_KEY: "synthetic-fixture", TELNYX_CALL_CONTROL_APP_ID: "test-app", TELNYX_CREDENTIAL_CONNECTION_ID: "test-credential" };
  it("requires a full UTC cutoff and exact stable TEST deployment", () => {
    expect(callInterruptionConfiguration(env)).toEqual(configuration);
    for (const patch of [{ DIAGNOSTICS_CALL_ALERTS_SINCE: "" }, { DIAGNOSTICS_CALL_ALERTS_SINCE: "2026-10-06" }, { VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "production-project" }, { VERCEL_GIT_COMMIT_REF: "work-branch" }, { DIAGNOSTICS_CLASSIFIER_ENABLED: "false" }, { TELNYX_CALL_CONTROL_APP_ID: "" }]) {
      expect(callInterruptionConfiguration({ ...env, ...patch })).toBeNull();
    }
  });
});
