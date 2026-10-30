export type PendingCallStartRequest = { path: string; payload: string; requestId: string; body: string };

/** An unknown HTTP outcome keeps the exact original operation, including its body. */
export function prepareCallStartRequest(
  pending: PendingCallStartRequest | null,
  path: string,
  input: Record<string, unknown>,
  createId = () => crypto.randomUUID(),
): PendingCallStartRequest {
  const payload = JSON.stringify(input);
  if (pending) {
    if (pending.path !== path || pending.payload !== payload) {
      throw new Error("Výsledok predchádzajúceho volania ešte nie je potvrdený. Najprv znova overte pôvodné volanie.");
    }
    return pending;
  }
  const requestId = createId();
  return { path, payload, requestId, body: JSON.stringify({ ...input, requestId }) };
}

type EarlyAcceptPhone = {
  expectOperatorRequest(request: { requestId: string; timingOperationId?: string }): void;
  releaseOperatorRequest(requestId: string): void;
};

/**
 * Early accept of the own leg (call-speed S3, `tuning.webEarlyAccept`, off by
 * default). Arms the phone with the start POST's own `requestId` just before
 * the POST, so it can answer that request's own leg from the invite instead of
 * waiting for the response. The response then confirms the exact leg
 * (`expectOperatorLeg` with the same `requestId`); once the request is over,
 * whatever it did not confirm — a failed start included — is hung up.
 *
 * A client-side failure or timeout counts as a failed start: the early leg is
 * hung up even if the server went on to place the call. Reconciling that
 * operation re-arms the same `requestId`; the server answers it idempotently
 * (no second dial), and a leg already hung up is never answered again (the tab
 * remembers it as ended and its session ends). Accepted: it fails safe, at
 * worst the operator starts the call again.
 */
export function withEarlyAccept<Phone extends EarlyAcceptPhone>(requestId: string, enabled: () => boolean,
  execute: (webphone: Phone | null) => Promise<void>): (webphone: Phone | null) => Promise<void> {
  return async (webphone) => {
    const armed = webphone && enabled() ? webphone : null;
    armed?.expectOperatorRequest({ requestId, timingOperationId: requestId });
    try { await execute(webphone); }
    finally { armed?.releaseOperatorRequest(requestId); }
  };
}
