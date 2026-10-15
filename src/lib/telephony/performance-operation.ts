/** Fixed, low-cardinality labels. Never retain a URL, call ID, number or body. */
export const CALL_PERFORMANCE_OPERATIONS = [
  "call.outbound", "call.internal", "call.callback", "call.pickup", "call.hangup",
  "call.hold", "call.unhold", "call.park", "call.defer", "call.consult", "call.cancel-consult",
  "call.complete-transfer", "call.transfer", "call.add-party", "call.leave", "call.supervise",
  "call.stop-supervise", "call.reconcile", "call.party-mute", "call.party-unmute", "call.party-kick",
] as const;
export type CallPerformanceOperation = typeof CALL_PERFORMANCE_OPERATIONS[number];
export function isCallPerformanceOperation(value: unknown): value is CallPerformanceOperation {
  return typeof value === "string" && (CALL_PERFORMANCE_OPERATIONS as readonly string[]).includes(value);
}
export function callPerformanceOperation(input: string, method = "POST"): CallPerformanceOperation | undefined {
  if (method.toUpperCase() !== "POST") return;
  let path: string;
  try { path = new URL(input, "https://app.invalid").pathname; } catch { return; }
  if (path === "/api/telephony/calls") return "call.outbound";
  if (path === "/api/telephony/calls/internal") return "call.internal";
  if (/^\/api\/telephony\/callbacks\/[^/]+\/call$/.test(path)) return "call.callback";
  const action = /^\/api\/telephony\/calls\/[^/]+\/([^/]+)$/.exec(path)?.[1];
  const party = /^\/api\/telephony\/calls\/[^/]+\/parties\/[^/]+\/(mute|unmute|kick)$/.exec(path)?.[1];
  const label = party ? `call.party-${party}` : `call.${action}`;
  return isCallPerformanceOperation(label) ? label : undefined;
}
