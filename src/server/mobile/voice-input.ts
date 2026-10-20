import type { StartOutboundInput } from "@/server/telephony/call-actions";

/** One immutable outbound shape for the dial and for its later attempt cleanup.
 * A call placed from a case names it, so the call is filed with that case. */
export function nativeOutboundInput(requestId: string, to: string, verificationId?: string, caseId?: string): StartOutboundInput {
  return { requestId, to, ...(verificationId ? { callbackTargetVerificationId: verificationId } : {}), ...(caseId ? { caseId: caseId.toLowerCase() } : {}) };
}
