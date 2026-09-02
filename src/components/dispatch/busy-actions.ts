/**
 * Scopes for the call centre's "an action is running" lock.
 *
 * The module used to hold one global busy string, so linking a call to a case
 * disabled every dial button in the history list and the whole phonebook. Only
 * actions that contend for the same resource should block each other:
 *
 * - `phone`     one browser SIP dialog exists, so two dials genuinely conflict;
 * - `call:<id>` per-call bookkeeping (outcome, case link) conflicts only with
 *               itself;
 * - `workplace` seat recovery.
 */
export type BusyActionScope = "phone" | "workplace" | `call:${string}`;

/** Longest any scope may stay locked before the UI offers a way out. */
export const BUSY_ACTION_DEADLINE_MS: Record<"phone" | "workplace" | "call", number> = {
  // A browser SIP dial waits on VIPTel confirmation, which the command helper
  // bounds at 75 s. The lock must outlive that, then surrender.
  phone: 80_000,
  workplace: 45_000,
  call: 25_000,
};

/**
 * Derives the scope from the existing busy key format, so call sites keep their
 * current keys (`<callId>:call_back`, `quick:<id>`, `workplace:recover`, ...).
 */
export function busyActionScope(key: string | null): BusyActionScope | null {
  if (!key) return null;
  if (key.startsWith("workplace:")) return "workplace";
  if (key.startsWith("quick:")) return "phone";
  const separator = key.lastIndexOf(":");
  if (separator <= 0) return null;
  const callId = key.slice(0, separator);
  const action = key.slice(separator + 1);
  if (action === "call_back") return "phone";
  return `call:${callId}`;
}

export function busyActionDeadlineMs(scope: BusyActionScope | null) {
  if (!scope) return 0;
  if (scope === "phone") return BUSY_ACTION_DEADLINE_MS.phone;
  if (scope === "workplace") return BUSY_ACTION_DEADLINE_MS.workplace;
  return BUSY_ACTION_DEADLINE_MS.call;
}

/** True when the browser's single SIP dialog is already claimed. */
export function phoneScopeBusy(key: string | null) {
  return busyActionScope(key) === "phone";
}

/** True when this exact call already has bookkeeping in flight. */
export function callScopeBusy(key: string | null, callId: string) {
  return busyActionScope(key) === `call:${callId}`;
}

/**
 * Whether starting `next` must wait for `current`. Different scopes never block
 * one another; the same scope always does.
 */
/**
 * Per-phase bounds for taking a waiting call over. `redirecting` must outlast
 * command confirmation, which is why it is the longest.
 */
export const WAITING_PICKUP_PHASE_DEADLINE_MS = {
  answering: 10_000,
  releasing_current: 8_000,
  redirecting: 25_000,
  waiting_for_phone: 15_000,
} as const;

export type WaitingPickupPhase = keyof typeof WAITING_PICKUP_PHASE_DEADLINE_MS;

export function busyActionBlocks(current: string | null, next: string) {
  const currentScope = busyActionScope(current);
  if (!currentScope) return false;
  return currentScope === busyActionScope(next);
}
