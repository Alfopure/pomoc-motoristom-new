import { recordDiagnostic } from "@/lib/diagnostics/client";
import { DIAGNOSTIC_REASONS, isDiagnosticUuid, type DiagnosticEventInput, type DiagnosticOperation, type DiagnosticReason } from "@/lib/diagnostics/types";

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

export function logWebphoneDiagnostic(entry: Record<string, unknown>): void {
  try { const event = webphoneDiagnostic(entry); if (event) recordDiagnostic(event); } catch { /* Voice work has priority. */ }
}
