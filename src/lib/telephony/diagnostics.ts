import { recordDiagnostic } from "@/lib/diagnostics/client";
import { DIAGNOSTIC_REASONS, isDiagnosticUuid, type DiagnosticEventInput, type DiagnosticOperation, type DiagnosticReason } from "@/lib/diagnostics/types";
import { expectedVoiceSilence, voiceQualityWarning } from "@/lib/diagnostics/voice-quality";
import type { ActiveCallPayload } from "./active-calls-model";
import type { WebphoneCallView } from "./telnyx-webphone";

export function telephonyRequestDiagnostic(path: string, method = "GET"): { operation: DiagnosticOperation; callSessionId?: string } | null {
  if (method !== "POST") return null;
  if (path === "/api/telephony/calls" || path === "/api/telephony/calls/colleague" || /^\/api\/telephony\/callbacks\/[^/]+\/call$/.test(path)) return { operation: "call.start" };
  const match = /^\/api\/telephony\/calls\/([a-f0-9-]{36})\/(pickup|hangup|transfer|hold|unhold|park|resume|consult|complete-transfer|cancel-transfer)$/.exec(path);
  if (!match || !isDiagnosticUuid(match[1])) return null;
  const operation: DiagnosticOperation = match[2] === "pickup" ? "call.pickup" : match[2] === "hangup" ? "call.hangup"
    : ["hold", "unhold", "park", "resume"].includes(match[2]) ? "call.hold" : "call.transfer";
  return { operation, callSessionId: match[1] };
}

/** Deliberately discard SDK payloads, messages, phone numbers and credentials. */
export function webphoneDiagnostic(entry: Record<string, unknown>): DiagnosticEventInput | null {
  if (entry.event === "sdk_quality_warning") {
    const warning = voiceQualityWarning(entry.code);
    if (!warning || !isDiagnosticUuid(entry.callSessionId)) return null;
    return { type: "phone_lifecycle", module: "telephony", outcome: "unknown", reason: warning.reason,
      sdkWarningCode: warning.code, callSessionId: entry.callSessionId,
      ...(isDiagnosticUuid(entry.deviceSessionId) ? { deviceSessionId: entry.deviceSessionId } : {}) };
  }
  const reason = typeof entry.reason === "string" && (DIAGNOSTIC_REASONS as readonly string[]).includes(entry.reason)
    ? entry.reason as DiagnosticReason
    : entry.event === "sdk_warning" || entry.event === "sdk_socket_error" || entry.event === "sdk_recoverable_error" ? entry.event
    : entry.status === "registered" ? "registered"
    : entry.status === "connecting" || entry.status === "minting" ? "registering"
    : entry.status === "reconnecting" ? "reconnecting"
    : entry.status === "superseded" ? "superseded"
    : entry.status === "failed" ? "disconnected" : null;
  if (!reason) return null;
  return { type: "phone_lifecycle", module: "telephony", outcome: ["superseded", "recovery_timeout", "auth_failure", "disconnected", "sdk_socket_error"].includes(reason) ? "failed" : "ok", reason,
    ...(isDiagnosticUuid(entry.deviceSessionId) ? { deviceSessionId: entry.deviceSessionId } : {}),
    ...(isDiagnosticUuid(entry.callSessionId) ? { callSessionId: entry.callSessionId } : {}) };
}

/** Resolve only the current media leg, never the first/most recent app call.
 * Server hold/park can leave the SDK state active, so apply silence suppression
 * using the existing console snapshot as well. No extra request is needed. */
export function correlateWebphoneDiagnostic(
  entry: Record<string, unknown>,
  current: WebphoneCallView | null | undefined,
  calls: ReadonlyArray<Pick<ActiveCallPayload, "sessionId" | "state" | "legs">>,
): Record<string, unknown> | null {
  if (entry.event !== "sdk_quality_warning") {
    const controlId = current?.telnyxCallControlId;
    const sessionId = entry.callSessionId ?? (controlId ? calls.find(call => call.legs.some(leg => leg.callControlId === controlId))?.sessionId : undefined);
    return { ...entry, callSessionId: sessionId };
  }
  const warning = voiceQualityWarning(entry.code);
  if (!warning || !current || !current.telnyxCallControlId || entry.sdkCallId !== current.id ||
    entry.callControlId !== current.telnyxCallControlId || !["active", "held"].includes(current.state)) return null;
  const matches = calls.filter(call => call.legs.some(leg => leg.callControlId === current.telnyxCallControlId));
  if (matches.length !== 1) return null;
  const call = matches[0];
  if (!isDiagnosticUuid(call.sessionId) || ["missed", "wrap_up", "ended", "failed"].includes(call.state) ||
    (entry.callSessionId && entry.callSessionId !== call.sessionId) || (current.sessionId && current.sessionId !== call.sessionId)) return null;
  const leg = call.legs.find(leg => leg.callControlId === current.telnyxCallControlId);
  if (expectedVoiceSilence(warning, current.state === "held" || ["held", "parked", "consulting", "waiting"].includes(call.state), current.muted || leg?.muted === true)) return null;
  return { ...entry, callSessionId: call.sessionId };
}

export function logWebphoneDiagnostic(entry: Record<string, unknown>): void {
  try { const event = webphoneDiagnostic(entry); if (event) recordDiagnostic(event); } catch { /* Voice work has priority. */ }
}
