import { createHash } from "node:crypto";
import { assertOwnership, ownershipRpc, sessionOwnership, type Ownership } from "./ownership";

export class ProviderOutcomeUnknownError extends Error {
  constructor(readonly commandId: string) {
    super(`Provider outcome unknown for ${commandId}; exact evidence required before replay`);
    this.name = "ProviderOutcomeUnknownError";
  }
}
export function payloadFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export type JournalRequest = { owner: Ownership; commandId: string; fingerprint: string; method: string; path: string; correlationState: string | null; payload: Record<string, unknown> };
export type JournalDecision = { dispatch: boolean; outcome?: string; result?: unknown; http_status?: number; next_attempt_at?: string };
export function journalRequest(method: string, path: string, commandId: string | null, body: string | undefined): JournalRequest | null {
  const owner = sessionOwnership.getStore();
  if (!owner || owner.contract !== 2 || method === "GET") return null;
  // A v2 voice mutation without stable identity is a programming error, not a
  // license to fall back to a nonjournaled request.
  if (!commandId) throw new Error(`Provider mutation ${path} lacks a stable command identity`);
  return { owner, commandId, method, path, payload: body ? JSON.parse(body) : {}, correlationState: body && typeof JSON.parse(body).client_state === "string" ? JSON.parse(body).client_state : null, fingerprint: payloadFingerprint({ method, path, body: body ? JSON.parse(body) : null }) };
}
export async function prepareProviderRequest(request: JournalRequest): Promise<JournalDecision> {
  await assertOwnership(request.owner);
  return ownershipRpc(request.owner.admin, "motorist_provider_command_prepare_v2", {
    p_session_id: request.owner.sessionId, p_command_id: request.commandId, p_fingerprint: request.fingerprint,
    p_method: request.method, p_path: request.path, p_correlation_state: request.correlationState, p_payload: request.payload,
  });
}
export async function recordProviderResponse(request: JournalRequest, status: number, result: unknown, retryAfterMs?: number): Promise<void> {
  // Acceptance is immutable evidence, not a topology checkpoint. Its dedicated
  // RPC accepts only the original dispatch tuple even after lease expiry.
  // Bypass the exhausted session deadline, retaining the DB request timeout.
  await sessionOwnership.run({ ...request.owner, deadline: Date.now() + 4_000 }, async () => {
    const args = { p_session_id: request.owner.sessionId, p_command_id: request.commandId, p_fingerprint: request.fingerprint,
      p_generation: request.owner.generation, p_token: request.owner.token, p_status: status, p_result: result,
      p_retry_after_ms: retryAfterMs == null ? null : Math.min(2_147_483_647, Math.ceil(retryAfterMs)) };
    await ownershipRpc(request.owner.admin, "motorist_provider_command_result_v2", args);
  });
}
