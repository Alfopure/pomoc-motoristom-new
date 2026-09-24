import { TELEPHONY_TIMEOUT_MS, type TelephonyJsonResult } from "./client-request";

/** A further replay needs this much of the control budget left; otherwise the
 * last busy answer is returned and the console falls through to its ordinary
 * handling (a later 409 `not_active`/`call_gone` confirms the end). */
export const MIN_REMAINING_FOR_RETRY_MS = 10_000;

/**
 * Which controls may replay a proven pre-action `session_busy`, and how often.
 * Pickup reserves nothing before the lease, so one replay is idempotent (M24).
 * Hangup has committed its durable intent before waiting, so two replays are
 * safe; anything more is bounded by the remaining control budget (plan §7.9).
 */
export function callControlRetryPolicy(action: string): { enabled: true; attempts: number } {
  return { enabled: true, attempts: action === "hangup" ? 2 : 1 };
}

/** A replay is safe only for the server's proof that session ownership was
 * unavailable BEFORE action work. Transport failures/other responses are never replayed. */
export async function retryUnstartedCallControl<T extends { code?: string; retryAfterMs?: number }>(input: {
  request: () => Promise<TelephonyJsonResult<T>>;
  isCurrent: () => boolean;
  canRetry?: () => boolean;
  enabled: boolean;
  wait?: (milliseconds: number) => Promise<void>;
  /** Maximum replays after busy answers; default 1 (today's behaviour). */
  attempts?: number;
  /** Whole-sequence budget the second and later replays are checked against. */
  budgetMs?: number;
  now?: () => number;
  /** Called before each replay so the UI can show progress ("Ukončuje sa…"). */
  onRetry?: (attempt: number) => void;
}): Promise<TelephonyJsonResult<T> | null> {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = Math.max(0, input.attempts ?? 1);
  const budgetMs = input.budgetMs ?? TELEPHONY_TIMEOUT_MS.control;
  const started = now();
  let result = await input.request();
  if (!input.isCurrent()) return null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (!input.enabled || result.status !== 503 || result.body?.code !== "session_busy") return result;
    if (input.canRetry && !input.canRetry()) return result;
    // The 30 s timeout of `telephonyJson` is per attempt; this is the bound on
    // the whole click. Below it the ordinary 409 confirmation path takes over.
    if (attempt >= 2 && budgetMs - (now() - started) <= MIN_REMAINING_FOR_RETRY_MS) return result;
    input.onRetry?.(attempt);
    const suggested = result.body.retryAfterMs;
    const delay = typeof suggested === "number" && Number.isFinite(suggested) ? suggested : 1_000;
    await wait(Math.max(250, Math.min(1_500, delay)));
    if (!input.isCurrent() || (input.canRetry && !input.canRetry())) return null;
    result = await input.request();
    if (!input.isCurrent()) return null;
  }
  return result;
}
