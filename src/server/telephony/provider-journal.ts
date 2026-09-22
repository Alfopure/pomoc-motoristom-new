import { createHash } from "node:crypto";
import { assertOwnership, DATABASE_REQUEST_MS, ownershipRpc, recordProviderDispatch, sessionOwnership, type Ownership } from "./ownership";

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
  const parsedBody = body ? JSON.parse(body) : null;
  return {
    owner, commandId, method, path,
    payload: body ? parsedBody : {},
    correlationState: body && typeof parsedBody.client_state === "string" ? parsedBody.client_state : null,
    fingerprint: payloadFingerprint({ method, path, body: parsedBody }),
  };
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
  await sessionOwnership.run({ ...request.owner, deadline: Date.now() + DATABASE_REQUEST_MS }, async () => {
    const args = { p_session_id: request.owner.sessionId, p_command_id: request.commandId, p_fingerprint: request.fingerprint,
      p_generation: request.owner.generation, p_token: request.owner.token, p_status: status, p_result: result,
      p_retry_after_ms: retryAfterMs == null ? null : Math.min(2_147_483_647, Math.ceil(retryAfterMs)) };
    await ownershipRpc(request.owner.admin, "motorist_provider_command_result_v2", args);
  });
}

/** What the provider layer sends back: the status, the body, and 429 backoff. */
export type JournaledSend = { status: number; result: unknown; retryAfterMs?: number };
export type JournaledResult<S> = { cached: true; result: unknown } | { cached: false; sent: S };

/**
 * The fenced-dispatch protocol, in one place: fence the command in the
 * database, send it, record what came back.
 *
 * Both the real client and the test double go through here. That is the whole
 * point — the branches below (a command already accepted, already rejected,
 * already rate-limited, or dispatched with its outcome never recorded) are
 * exactly the ones that decide whether a redelivered webhook re-dials an
 * operator, and a test double with its own copy of them would be testing the
 * copy.
 *
 * `error` reconstructs the caller's own error type from a replayed status and
 * body, because this module must not depend on the provider client it serves.
 * `invalid` reports a 2xx body that does not actually acknowledge the command:
 * it is recorded as a 504, so the next attempt asks rather than assumes.
 */
export async function dispatchJournaled<S extends JournaledSend>(
  journal: JournalRequest | null,
  send: () => Promise<S>,
  hooks: { error: (status: number, body: unknown, commandId: string | null) => Error; invalid?: (sent: S) => boolean; trackDispatch?: boolean },
): Promise<JournaledResult<S>> {
  if (journal) {
    // Preparation renews ownership and fences the exact immutable command in
    // the database immediately before dispatch. A second renewal here adds a
    // database round trip to every answer, bridge and hangup.
    const decision = await prepareProviderRequest(journal);
    if (!decision.dispatch) {
      if (decision.outcome === "accepted") return { cached: true, result: decision.result };
      if (decision.outcome === "rejected") throw hooks.error(decision.http_status ?? 422, decision.result, journal.commandId);
      if (decision.outcome === "rate_limited") throw hooks.error(429, decision.result, journal.commandId);
      throw new ProviderOutcomeUnknownError(journal.commandId);
    }
  } else await assertOwnership();

  if (hooks.trackDispatch !== false) recordProviderDispatch();
  const sent = await send();
  if (journal) {
    const invalid = hooks.invalid?.(sent) ?? false;
    await recordProviderResponse(journal, invalid ? 504 : sent.status, sent.result, sent.retryAfterMs);
  }
  return { cached: false, sent };
}

/**
 * One fence, one lock, one statement per command: the journal for a whole
 * group.
 *
 * Every voice command otherwise costs two round trips of its own, and a ring
 * step that calls five operators pays ten of them — to a database that
 * serialises them on one session row regardless. The per-command functions
 * stay; this is what a caller that already holds the whole group reaches for.
 *
 * `sends` runs after every member is fenced and recorded as dispatched, so a
 * committed termination stops the group before any of it reaches the provider
 * rather than halfway through.
 */
export async function prepareProviderBatch(owner: Ownership, journals: readonly JournalRequest[]): Promise<JournalDecision[]> {
  await assertOwnership(owner);
  const decisions = await ownershipRpc<JournalDecision[]>(owner.admin, "motorist_provider_command_prepare_batch_v2", {
    p_session_id: owner.sessionId,
    p_commands: journals.map((journal) => ({
      command_id: journal.commandId, fingerprint: journal.fingerprint, method: journal.method,
      path: journal.path, correlation_state: journal.correlationState, payload: journal.payload,
    })),
  });
  return decisions ?? [];
}

export async function recordProviderBatch(
  owner: Ownership,
  results: ReadonlyArray<{ journal: JournalRequest; status: number; result: unknown; retryAfterMs?: number }>,
): Promise<void> {
  if (!results.length) return;
  // Acceptance is immutable evidence, not a topology checkpoint, so it outlives
  // the session deadline exactly as the single-command form does.
  await sessionOwnership.run({ ...owner, deadline: Date.now() + DATABASE_REQUEST_MS }, async () => {
    await ownershipRpc(owner.admin, "motorist_provider_command_result_batch_v2", {
      p_session_id: owner.sessionId, p_generation: owner.generation, p_token: owner.token,
      p_results: results.map((entry) => ({
        command_id: entry.journal.commandId, fingerprint: entry.journal.fingerprint, status: entry.status,
        result: entry.result, retry_after_ms: entry.retryAfterMs == null ? null : Math.min(2_147_483_647, Math.ceil(entry.retryAfterMs)),
      })),
    });
  });
}

/**
 * A group of provider calls under one journal: fence them all, send them all,
 * record them all.
 *
 * The decision branches are the single-command ones, member by member — a
 * command already accepted returns its recorded answer without being sent, a
 * refusal is thrown as the caller's own error, an outcome that was never
 * recorded refuses to be replayed blind.
 */
export async function dispatchJournaledBatch<S extends JournaledSend>(
  members: ReadonlyArray<{ journal: JournalRequest; send: () => Promise<S> }>,
  hooks: { error: (status: number, body: unknown, commandId: string | null) => Error; invalid?: (sent: S) => boolean; trackDispatch?: boolean },
): Promise<Array<PromiseSettledResult<JournaledResult<S>>>> {
  const owner = sessionOwnership.getStore();
  if (!owner || owner.contract !== 2 || !members.length) {
    throw new Error("provider journal batch requires an owned contract-2 scope");
  }

  const decisions = await prepareProviderBatch(owner, members.map((member) => member.journal));
  // Per member, never one verdict for the group: one operator's refusal is
  // that operator's, and the caller has to keep the others.
  const outcomes: Array<PromiseSettledResult<JournaledResult<S>>> = [];
  const dispatched: Array<{ index: number; member: (typeof members)[number] }> = [];
  for (const [index, decision] of decisions.entries()) {
    const member = members[index];
    if (decision?.dispatch) {
      dispatched.push({ index, member });
      outcomes.push({ status: "rejected", reason: new Error("not dispatched") });
      continue;
    }
    if (decision?.outcome === "accepted") outcomes.push({ status: "fulfilled", value: { cached: true, result: decision.result } });
    else if (decision?.outcome === "rejected") outcomes.push({ status: "rejected", reason: hooks.error(decision.http_status ?? 422, decision.result, member.journal.commandId) });
    else if (decision?.outcome === "rate_limited") outcomes.push({ status: "rejected", reason: hooks.error(429, decision.result, member.journal.commandId) });
    else outcomes.push({ status: "rejected", reason: new ProviderOutcomeUnknownError(member.journal.commandId) });
  }

  const sent = await Promise.allSettled(dispatched.map(({ member }) => {
    if (hooks.trackDispatch !== false) recordProviderDispatch();
    return member.send();
  }));
  const record: Array<{ journal: JournalRequest; status: number; result: unknown; retryAfterMs?: number }> = [];
  for (const [position, settled] of sent.entries()) {
    const { index, member } = dispatched[position];
    if (settled.status === "rejected") {
      // Nothing came back, so nothing is recorded: the entry stays open and the
      // replay has to ask rather than assume either way.
      outcomes[index] = { status: "rejected", reason: settled.reason instanceof Error ? settled.reason : new Error(String(settled.reason)) };
      continue;
    }
    const invalid = hooks.invalid?.(settled.value) ?? false;
    record.push({ journal: member.journal, status: invalid ? 504 : settled.value.status, result: settled.value.result, retryAfterMs: settled.value.retryAfterMs });
    outcomes[index] = { status: "fulfilled", value: { cached: false, sent: settled.value } };
  }
  // One write for everything that answered, after all of them answered.
  await recordProviderBatch(owner, record);

  return outcomes;
}
