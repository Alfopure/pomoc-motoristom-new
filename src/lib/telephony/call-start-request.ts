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
