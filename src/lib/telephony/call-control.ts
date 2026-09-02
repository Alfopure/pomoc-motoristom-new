export type TelephonyTransferTransport = "browser_sip_refer" | "provider_redirect" | null;

/**
 * VIPTel call.redirect always replaces the called party. That preserves an
 * inbound caller while moving the receiving operator, but on an outbound call
 * it replaces the client and leaves the original operator calling the target.
 * A live browser SIP dialog instead transfers its remote party with SIP REFER
 * in either direction. Provider-only outbound calls therefore stay fail-closed.
 */
export function telephonyTransferTransport(
  direction: "inbound" | "internal" | "outbound" | null | undefined,
  hasBrowserSession: boolean,
  destinationKind?: "operator" | "phone",
): TelephonyTransferTransport {
  // VIPTel's provider-side redirect is reliable for moving an inbound queue
  // call to another verified extension. Production events show that using the
  // same action for an external number can end and immediately re-offer the
  // original agent leg without ever ringing the target. An established browser
  // dialog can transfer that remote caller directly and waits for the final SIP
  // REFER notification, so use it only for this external-number case.
  if (direction === "inbound") {
    if (hasBrowserSession && destinationKind === "phone") return "browser_sip_refer";
    return "provider_redirect";
  }
  if (hasBrowserSession) return "browser_sip_refer";
  return null;
}

/**
 * A local SIP rejection advances a queued caller. It may run only after the
 * provider has confirmed termination of the logical call.
 */
export async function terminateQueuedIncomingCall(
  terminateProviderCall: () => Promise<void>,
  closeLocalSipLeg: () => Promise<void>,
) {
  await terminateProviderCall();
  await closeLocalSipLeg().catch(() => undefined);
}
