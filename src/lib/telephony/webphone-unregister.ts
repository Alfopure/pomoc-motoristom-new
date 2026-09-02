export const WEBPHONE_UNREGISTER_RESPONSE_TIMEOUT_MS = 8_000;
export const WEBPHONE_UNREGISTER_PENDING_RETRY_MS = 100;

export type WebphoneUnregisterOutcome = "accepted" | "rejected" | "send_failed" | "timed_out";
export type HotdeskWebphoneDisconnectOutcome = WebphoneUnregisterOutcome | "not_connected";

export function assertHotdeskWebphoneDisconnectConfirmed(
  outcome: HotdeskWebphoneDisconnectOutcome,
): asserts outcome is "accepted" | "not_connected" {
  if (outcome === "accepted" || outcome === "not_connected") return;
  const reason = outcome === "timed_out"
    ? "VIPTel nepotvrdil odpojenie telefónu včas."
    : outcome === "rejected"
      ? "VIPTel odmietol odpojenie telefónu."
      : "Požiadavku na odpojenie telefónu sa nepodarilo odoslať.";
  throw new Error(`${reason} Pracovné miesto zostalo bez zmeny; skús to znova.`);
}

type UnregisterRequestDelegate = {
  onAccept?: () => void;
  onRedirect?: () => void;
  onReject?: () => void;
};

type UnregisteringWebphone = {
  unregister: (options?: { all?: boolean; requestDelegate?: UnregisterRequestDelegate }) => Promise<void>;
};

/**
 * SIP.js resolves `SimpleUser.unregister()` as soon as the un-REGISTER request
 * is sent. Keep the WebSocket open until the registrar returns a final
 * response (or a short bounded timeout elapses), otherwise the binding can
 * remain visible at the provider after the browser already considers itself
 * disconnected.
 */
export function waitForWebphoneUnregisterResponse(
  webphone: UnregisteringWebphone,
  timeoutMs = WEBPHONE_UNREGISTER_RESPONSE_TIMEOUT_MS,
  options: { allContacts?: boolean } = {},
): Promise<WebphoneUnregisterOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let retryId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (outcome: WebphoneUnregisterOutcome) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      if (retryId !== undefined) globalThis.clearTimeout(retryId);
      resolve(outcome);
    };
    const timeoutId = globalThis.setTimeout(() => finish("timed_out"), timeoutMs);

    const attempt = () => {
      if (settled) return;
      try {
        void webphone.unregister({
          // Explicit hotdesk handoffs clear the complete AOR to remove contacts
          // stranded by crashed tabs. Lease-loss/unmount cleanup removes only
          // this browser's Contact so an obsolete tab cannot disconnect a
          // newer owner.
          all: options.allContacts !== false,
          requestDelegate: {
            onAccept: () => finish("accepted"),
            onRedirect: () => finish("rejected"),
            onReject: () => finish("rejected"),
          },
        }).catch((error: unknown) => {
          if (isRegisterRequestPending(error)) {
            if (settled) return;
            retryId = globalThis.setTimeout(attempt, WEBPHONE_UNREGISTER_PENDING_RETRY_MS);
            return;
          }
          finish("send_failed");
        });
      } catch (error) {
        if (isRegisterRequestPending(error)) {
          if (settled) return;
          retryId = globalThis.setTimeout(attempt, WEBPHONE_UNREGISTER_PENDING_RETRY_MS);
          return;
        }
        finish("send_failed");
      }
    };

    attempt();
  });
}

function isRegisterRequestPending(error: unknown) {
  return error instanceof Error &&
    (error.name === "RequestPendingError" || error.message.includes("REGISTER request already in progress"));
}
