import { describe, expect, it } from "vitest";
import { correlateWebphoneDiagnostic, telephonyRequestDiagnostic, webphoneDiagnostic } from "./diagnostics";
import { VOICE_QUALITY_WARNINGS } from "@/lib/diagnostics/voice-quality";
import { parseDiagnosticEvent } from "@/lib/diagnostics/types";
import type { ActiveCallPayload } from "./active-calls-model";
import type { WebphoneCallView } from "./telnyx-webphone";

const session = "00000000-0000-4000-8000-000000000001";
describe("phone diagnostics boundary", () => {
  it("discards provider payloads and unverified identifiers", () => {
    expect(webphoneDiagnostic({ event: "disconnect", reason: "component_unmount", callSessionId: session,
      deviceSessionId: "not-a-uuid", token: "secret", phone: "+421900111222", message: "private", sdp: "private" })).toEqual({
      type: "phone_lifecycle", module: "telephony", outcome: "ok", reason: "component_unmount", callSessionId: session,
    });
    expect(webphoneDiagnostic({ message: "private", event: "sdk_payload" })).toBeNull();
  });

  it("reports the browser RTC edge (call-speed S5) with closed values only", () => {
    const fallback = webphoneDiagnostic({ event: "rtc_region_fallback", reason: "rtc_region_fallback", rtcEdge: "eu", rtcTrigger: "socket_error" });
    expect(fallback).toEqual({ type: "phone_lifecycle", module: "telephony", outcome: "failed", reason: "rtc_region_fallback", rtcEdge: "eu", rtcTrigger: "socket_error" });
    const connected = webphoneDiagnostic({ event: "rtc_edge_connected", reason: "rtc_edge_connected", rtcEdge: "eu", rtcRegion: "eu", rtcDc: "fr5" });
    expect(connected).toEqual({ type: "phone_lifecycle", module: "telephony", outcome: "ok", reason: "rtc_edge_connected", rtcEdge: "eu", rtcRegion: "eu", rtcDc: "fr5" });
    // Provider strings outside the closed sets never leave the browser.
    expect(webphoneDiagnostic({ event: "rtc_edge_connected", reason: "rtc_edge_connected", rtcEdge: "default", rtcRegion: "mars", rtcDc: "wss://x.example/?t=1", rtcTrigger: "socket_error" }))
      .toEqual({ type: "phone_lifecycle", module: "telephony", outcome: "ok", reason: "rtc_edge_connected", rtcEdge: "default" });
    expect(webphoneDiagnostic({ event: "rtc_region_fallback", reason: "rtc_region_fallback", rtcEdge: "us", rtcTrigger: "anything" }))
      .toEqual({ type: "phone_lifecycle", module: "telephony", outcome: "failed", reason: "rtc_region_fallback" });
    expect(webphoneDiagnostic({ event: "registered", reason: "registered", rtcEdge: "eu", rtcRegion: "eu" })).not.toHaveProperty("rtcEdge");

    const envelope = { id: session, pageId: session, sequence: 1, occurredAt: "2026-11-02T10:00:00.000Z", monotonicMs: 1, buildId: "test-build", sampled: false, sampleRate: 1 };
    for (const event of [fallback, connected]) expect(parseDiagnosticEvent({ ...envelope, ...event })).toEqual({ ...envelope, ...event });
    for (const patch of [{ rtcTrigger: "offline" }, { reason: "registered" }, { module: "app" }, { rtcEdge: undefined }]) {
      expect(parseDiagnosticEvent({ ...envelope, ...fallback, ...patch })).toBeNull();
    }
    for (const patch of [{ rtcRegion: "mars" }, { rtcDc: "a.b" }, { rtcTrigger: "socket_error" }, { type: "ui_error" }]) {
      expect(parseDiagnosticEvent({ ...envelope, ...connected, ...patch })).toBeNull();
    }
    expect(parseDiagnosticEvent({ ...envelope, ...fallback, rtcRegion: "eu" })).toBeNull();
  });

  it.each([
    ["recovery_timeout", "recovery_timeout", undefined],
    ["sdk_recovery_exhausted", "sdk_recovery_failed", 45003],
    ["sdk_recovery_disabled", "sdk_recovery_failed", 36005],
    ["invalid_credentials", "auth_failure", 46002],
    ["sdk_fatal", "sdk_fatal", 45001],
    ["sdk_fatal", "sdk_fatal", 49001],
  ] as const)("keeps terminal cause %s distinct from a timeout and drops provider payloads", (phoneFailure, reason, sdkCode) => {
    const input = { event: "recovery_failed", status: "failed", reason, phoneFailure, ...(sdkCode === undefined ? {} : {sdkCode}),
      rtcEdge: "eu", rtcRegion: "eu", rtcDc: "fr5", message: "secret", token: "secret", payload: {sdp: "private"} };
    const diagnostic = webphoneDiagnostic(input);
    expect(diagnostic).toEqual({type: "phone_lifecycle", module: "telephony", outcome: "failed", reason, phoneFailure,
      ...(sdkCode === undefined ? {} : {sdkCode}), rtcEdge: "eu", rtcRegion: "eu", rtcDc: "fr5"});
    const envelope = { id: session, pageId: session, sequence: 1, occurredAt: "2026-11-02T10:00:00.000Z", monotonicMs: 1, buildId: "test-build", sampled: false, sampleRate: 1 };
    expect(parseDiagnosticEvent({...envelope, ...diagnostic})).toEqual({...envelope, ...diagnostic});
    for (const patch of [{module: "app"}, {type: "operation", operation: "call.start"}, {outcome: "ok"}, {phoneFailure: "secret"}, {sdkCode: 99999}, {reason: "registered"}, {rtcDc: "wss://private"}, {rtcTrigger: "sdk_error"}]) {
      expect(parseDiagnosticEvent({...envelope, ...diagnostic, ...patch})).toBeNull();
    }
    // A previously deployed browser remains valid without the new optional fields.
    expect(parseDiagnosticEvent({...envelope, type: "phone_lifecycle", module: "telephony", outcome: "failed", reason: "recovery_timeout"})).not.toBeNull();
    expect(parseDiagnosticEvent({...envelope, ...diagnostic, phoneFailure: undefined, sdkCode: 45003})).toBeNull();
    expect(webphoneDiagnostic({...input, sdkCode: "private-code"})).not.toHaveProperty("sdkCode");
    expect(webphoneDiagnostic({...input, phoneFailure: "private-cause"})).not.toHaveProperty("phoneFailure");
  });

  it("rejects mismatched SDK causes instead of accepting a different terminal diagnosis", () => {
    const envelope = { id: session, pageId: session, sequence: 1, occurredAt: "2026-11-02T10:00:00.000Z", monotonicMs: 1, buildId: "test-build", sampled: false, sampleRate: 1,
      type: "phone_lifecycle", module: "telephony", outcome: "failed", reason: "sdk_recovery_failed", phoneFailure: "sdk_recovery_exhausted", sdkCode: 36005 };
    expect(parseDiagnosticEvent(envelope)).toBeNull();
    expect(parseDiagnosticEvent({...envelope, reason: "sdk_fatal", phoneFailure: "sdk_fatal", sdkCode: 45003})).toBeNull();
    expect(parseDiagnosticEvent({...envelope, reason: "recovery_timeout", phoneFailure: "recovery_timeout", sdkCode: 45003})).toBeNull();
  });

  it("measures explicit controls but never the existing snapshot/heartbeat polling", () => {
    expect(telephonyRequestDiagnostic(`/api/telephony/calls/${session}/pickup`, "POST")).toEqual({ operation: "call.pickup", callSessionId: session });
    expect(telephonyRequestDiagnostic(`/api/telephony/calls/${session}/hangup`, "POST")?.operation).toBe("call.hangup");
    expect(telephonyRequestDiagnostic("/api/telephony/calls/active")).toBeNull();
    expect(telephonyRequestDiagnostic("/api/telephony/webphone/heartbeat", "POST")).toBeNull();
    expect(telephonyRequestDiagnostic(`/api/telephony/calls/${session}/reconcile`, "POST")).toBeNull();
  });

  it("keeps only allowlisted quality observations with an application call UUID", () => {
    for (const warning of VOICE_QUALITY_WARNINGS) {
      expect(webphoneDiagnostic({ event: "sdk_quality_warning", code: warning.code, callSessionId: session,
        sdkCallId: "private-sdk-id", callControlId: "private-control", reason: "private-reason", message: "private", stats: { ip: "192.0.2.1" } }))
        .toEqual({ type: "phone_lifecycle", module: "telephony", outcome: "unknown", reason: warning.reason, sdkWarningCode: warning.code, callSessionId: session });
    }
    expect(webphoneDiagnostic({ event: "sdk_quality_warning", code: 99999, callSessionId: session })).toBeNull();
    expect(webphoneDiagnostic({ event: "sdk_quality_warning", code: 31001, callSessionId: "sdk-session" })).toBeNull();
  });
});

describe("quality warning call correlation", () => {
  const current: WebphoneCallView = { id: "sdk-current", telnyxCallControlId: "control-current", state: "active", sessionId: null,
    direction: "inbound", number: "", callerName: null, muted: false, ringing: false, active: true };
  const server: Pick<ActiveCallPayload, "sessionId" | "state" | "legs"> = { sessionId: session, state: "talking", legs: [{
    id: session, callControlId: "control-current", role: "operator", profileId: session, state: "active", toNumber: null, fromNumber: null,
    answeredAt: null, bridgedAt: null, intent: null, muted: false, supervisorMode: null,
  }] };
  const entry = { event: "sdk_quality_warning", sdkCallId: "sdk-current", callControlId: "control-current", code: 31001 };

  it("resolves an inbound warning using the exact current server media leg, not array order", () => {
    const unrelated = { ...server, sessionId: "00000000-0000-4000-8000-000000000002", legs: [{ ...server.legs[0], callControlId: "other-control" }] };
    expect(correlateWebphoneDiagnostic(entry, current, [unrelated, server])).toEqual({ ...entry, callSessionId: session });
    expect(correlateWebphoneDiagnostic(entry, current, [unrelated])).toBeNull();
    expect(correlateWebphoneDiagnostic(entry, current, [server, server])).toBeNull();
    expect(correlateWebphoneDiagnostic({ ...entry, sdkCallId: "old-sdk" }, current, [server])).toBeNull();
    expect(correlateWebphoneDiagnostic({ ...entry, callControlId: "old-control" }, current, [server])).toBeNull();
    expect(correlateWebphoneDiagnostic({ ...entry, callSessionId: unrelated.sessionId }, current, [server])).toBeNull();
    expect(correlateWebphoneDiagnostic(entry, { ...current, sessionId: unrelated.sessionId }, [server])).toBeNull();
    expect(correlateWebphoneDiagnostic(entry, null, [server])).toBeNull();
    expect(correlateWebphoneDiagnostic(entry, current, [{ ...server, state: "ended" }])).toBeNull();
  });

  it.each(["held", "parked", "consulting", "waiting"] as const)("does not label silence during server %s as a fault even when SDK remains active", state => {
    for (const warning of VOICE_QUALITY_WARNINGS.filter(warning => warning.silence)) {
      expect(correlateWebphoneDiagnostic({ ...entry, code: warning.code }, current, [{ ...server, state }])).toBeNull();
    }
    expect(correlateWebphoneDiagnostic(entry, current, [{ ...server, state }])).toMatchObject({ callSessionId: session });
  });

  it("respects local and server mute, and never associates an idle lifecycle event by a missing leg ID", () => {
    expect(correlateWebphoneDiagnostic({ ...entry, code: 31005 }, { ...current, muted: true }, [server])).toBeNull();
    expect(correlateWebphoneDiagnostic({ ...entry, code: 32002 }, current, [{ ...server, legs: [{ ...server.legs[0], muted: true }] }])).toBeNull();
    expect(correlateWebphoneDiagnostic({ event: "disconnect", reason: "component_unmount" }, null, [{ ...server, legs: [{ ...server.legs[0], callControlId: undefined }] }]))
      .toEqual({ event: "disconnect", reason: "component_unmount", callSessionId: undefined });
  });
});
