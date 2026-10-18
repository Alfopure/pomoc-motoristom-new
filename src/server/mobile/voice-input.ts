import type { StartOutboundInput } from "@/server/telephony/call-actions";

/** One immutable outbound shape for the dial and for its later attempt cleanup. */
export function nativeOutboundInput(requestId: string, to: string, verificationId?: string): StartOutboundInput {
  return { requestId, to, ...(verificationId ? { callbackTargetVerificationId: verificationId } : {}) };
}
