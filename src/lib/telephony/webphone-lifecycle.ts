import type { BrowserWebphoneCallStatus } from "@/lib/telephony/webphone-client";

const ACTIVE_WEBPHONE_CALL_STATES: ReadonlySet<BrowserWebphoneCallStatus> = new Set([
  "incoming",
  "outgoing",
  "in_call",
]);

export function disconnectWebphoneForSeatTransition<T>(input: {
  callStatus: BrowserWebphoneCallStatus;
  disconnect: () => T;
}) {
  if (ACTIVE_WEBPHONE_CALL_STATES.has(input.callStatus)) {
    throw new Error("Počas prebiehajúceho hovoru sa pracovné miesto nedá zmeniť. Najprv hovor ukonči.");
  }
  return input.disconnect();
}

export function applyWebphoneExtensionSelection(input: {
  callStatus: BrowserWebphoneCallStatus;
  currentExtension: string;
  nextExtension: string;
  disconnect: () => void;
  suspended?: boolean;
}) {
  if (input.suspended) return "suspended" as const;
  if (input.currentExtension === input.nextExtension) return "unchanged" as const;
  if (ACTIVE_WEBPHONE_CALL_STATES.has(input.callStatus)) return "deferred" as const;
  input.disconnect();
  return "disconnected" as const;
}
