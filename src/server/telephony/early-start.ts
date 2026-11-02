import "server-only";

import { after } from "next/server";

import { withBackgroundRequestMetrics } from "@/server/request-metrics";

import type { EarlyStart } from "./call-actions";
import { latencyFlagsOf, type LatencyFlags } from "./latency-flags";

/**
 * Call-speed S2.3 (`start_early_response`): the start routes answer as soon as
 * the operator's own leg is dialled, instead of after the bookkeeping behind it.
 *
 * `start` receives an `EarlyStart` hook only while the switch is on; with it
 * off the call is exactly today's. The hook fires once the own leg's dial has
 * a recorded accepted journal outcome and an open leg row, which is the same
 * evidence the full response is built from. The route then replies 201 with
 * those fields, and the rest of the same leased work (history, audit, final
 * checkpoint, lease release) continues after the response, kept alive by
 * `after()`. Nothing new starts there: it is the very promise the request
 * started, with its lease and its ownership context.
 *
 * What the client can then see:
 * - a tail failure leaves the staged startup entry, which cron or the next
 *   provider event resumes; the returned control id stays valid;
 * - a hangup during the tail ends the call through its ordinary path, and the
 *   console learns it from the next snapshot instead of a 409;
 * - without the hook (refused or unknown dial, lost lease, termination,
 *   recovery of an earlier attempt) the route waits for the full work and
 *   maps its errors exactly as before.
 */
export async function respondWhenDialled<T>(
  deps: { latencyFlags?: LatencyFlags; logger?: (entry: Record<string, unknown>) => void },
  start: (...early: [] | [EarlyStart<T>]) => Promise<T>,
): Promise<T> {
  if (!latencyFlagsOf(deps).start_early_response) return start();
  let dialled!: (value: T) => void;
  let answered = false;
  const proven = new Promise<T>((resolve) => { dialled = resolve; });
  const work = start((value) => {
    if (answered) return;
    answered = true;
    dialled(value);
  });
  const value = await Promise.race([proven, work]);
  if (answered) {
    const tail = () => work.then(() => undefined, (error: unknown) => {
      deps.logger?.({ level: "warn", scope: "call-actions", code: "start_tail_failed", error: error instanceof Error ? error.message : String(error) });
    });
    try { after(withBackgroundRequestMetrics(tail)); }
    catch {
      // No retained request lifecycle: the durable entry still owns recovery.
      void tail();
    }
  }
  return value;
}
