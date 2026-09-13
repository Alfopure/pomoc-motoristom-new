import type { TelephonyJsonResult } from "./client-request";

/** One retry is safe only for the server's proof that session ownership was
 * unavailable BEFORE action work. Transport failures/other responses are never replayed. */
export async function retryUnstartedCallControl<T extends { code?: string; retryAfterMs?: number }>(input: {
  request: () => Promise<TelephonyJsonResult<T>>;
  isCurrent: () => boolean;
  canRetry?: () => boolean;
  enabled: boolean;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<TelephonyJsonResult<T> | null> {
  const first = await input.request();
  if (!input.isCurrent()) return null;
  if (!input.enabled || first.status !== 503 || first.body?.code !== "session_busy") return first;
  if (input.canRetry && !input.canRetry()) return first;
  const suggested = first.body.retryAfterMs;
  const delay = typeof suggested === "number" && Number.isFinite(suggested) ? suggested : 1_000;
  await (input.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(Math.max(250, Math.min(1_500, delay)));
  if (!input.isCurrent() || (input.canRetry && !input.canRetry())) return null;
  const second = await input.request();
  return input.isCurrent() ? second : null;
}
