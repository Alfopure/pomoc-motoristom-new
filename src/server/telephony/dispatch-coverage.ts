import "server-only";

import type { ViptelExtension, ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import { DISPATCH_QUEUE_NUMBERS, type DispatchQueueNumber } from "./dispatch-queues";
import type { DispatchPriorityPlan } from "./dispatch-routing";

/**
 * Makes ring coverage follow how many operators are actually online.
 *
 * VIPTel owns the rotation: a waiting caller moves 601 -> 602 -> 603 on the
 * PBX's own timer, and the application must not reproduce those timers. What
 * the application does control is which extension sits in which queue, and
 * until now that was a static manager-authored map of exactly one extension per
 * queue. So a lone operator planned into 601 stopped ringing after the first
 * rotation step and the caller sat in two empty queues until the fallback.
 *
 * Packing fixes that by deriving membership from the online set:
 *
 *   The operator at priority index k is a member of queue index min(k, Q-1),
 *   and the LAST online operator additionally joins every remaining queue.
 *
 *     N=0   -    -    -      -> every queue empty, fallback fires immediately
 *     N=1   e0   e0   e0     -> one operator rings for the whole window
 *     N=2   e0   e1   e1     -> 1st, then 2nd for the rest
 *     N=3   e0   e1   e2
 *     N=4   e0   e1   e2,e3
 *
 * The rule is ordinal. It contains no time constant, so it stays correct when
 * the PBX rotation period changes from 30 to 20 seconds.
 */

export type DispatchCoverageMap = Record<DispatchQueueNumber, string[]>;

export type CoverageStep = {
  action: "add" | "remove";
  queue: DispatchQueueNumber;
  extension: string;
};

/**
 * Whether the last online operator also covers the remaining queues.
 *
 * This is the half of the rule that makes a lone operator ring for the whole
 * window, and it is off by default because VIPTel re-offers a caller to an
 * agent who is already on that very call. Observed in production: one caller
 * rang extension 20 through 602, was answered, and 33 seconds later the
 * rotation rang the same extension again through 603. That leaves two live
 * legs sharing one queue identity, the provider reports the current
 * destination as a queue rather than the extension, and call control then
 * correctly refuses to act on a leg it cannot attribute -- so hanging up an
 * inbound call fails with "Aktuálny VIPTel leg už patrí inému pracovnému
 * miestu".
 *
 * Turn this on only once VIPTel confirms a queue will not ring a member who is
 * already in use (an `ringinuse=no` style setting). Until then each operator
 * covers exactly one queue, which is the behaviour that existed before
 * coverage and which keeps hangup and transfer working.
 */
export const COVERAGE_FILL_FORWARD_ENV_FLAG = "VIPTEL_DISPATCH_COVERAGE_FILL_FORWARD";

export function dispatchCoverageFillForwardEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env[COVERAGE_FILL_FORWARD_ENV_FLAG]?.trim().toLowerCase() === "true";
}

/** THE packing rule. Pure, ordinal, no time constants. */
export function packDispatchQueueCoverage(
  queues: readonly DispatchQueueNumber[],
  onlineInPlanOrder: readonly string[],
  options: { fillForward?: boolean } = {},
): DispatchCoverageMap {
  const map = Object.fromEntries(queues.map((queue) => [queue, [] as string[]])) as DispatchCoverageMap;
  if (onlineInPlanOrder.length === 0) return map;

  const lastIndex = onlineInPlanOrder.length - 1;
  queues.forEach((queue, queueIndex) => {
    // With fill-forward the queues from the last operator's own index onwards
    // are all covered by them, which is what keeps a single operator ringing
    // for the whole window. Without it each operator covers exactly their own
    // queue and the later ones stay empty, so nobody is ever a member of two
    // queues at once and the rotation cannot re-offer a caller to the agent
    // already talking to them.
    const operatorIndex = options.fillForward ? Math.min(queueIndex, lastIndex) : queueIndex;
    const extension = onlineInPlanOrder[operatorIndex];
    if (extension) map[queue] = [extension];
  });

  // Any operator beyond the queue count still belongs somewhere: put them in
  // the final queue alongside whoever already covers it.
  for (let index = queues.length; index <= lastIndex; index += 1) {
    const queue = queues[queues.length - 1];
    const extension = onlineInPlanOrder[index];
    if (queue && extension && !map[queue].includes(extension)) map[queue].push(extension);
  }
  return map;
}

/** The manager plan, read as an ordered priority list of extensions. */
export function orderedDispatchPlanExtensions(plan: DispatchPriorityPlan): string[] {
  return DISPATCH_QUEUE_NUMBERS
    .map((queue) => plan[queue])
    .filter((extension): extension is string => Boolean(extension));
}

/**
 * Who is genuinely able to take a call right now.
 *
 * Membership of any dispatch queue is the operator's own expression of intent
 * ("Dostupný"), but intent alone must never ring a phone: the extension must
 * also be registered with the provider. A browser that crashed leaves its
 * membership behind, and this is what stops that stale membership counting.
 *
 * `inUse` is deliberately NOT excluded. VIPTel marks an operator in-use while
 * the very call being offered is ringing at them, so treating busy as offline
 * would make a ringing call trigger its own coverage change.
 */
export function onlineDispatchExtensions(input: {
  planOrder: readonly string[];
  queueStatuses: readonly ViptelQueueStatus[];
  extensions: readonly ViptelExtension[];
}): string[] {
  const registered = new Set(
    input.extensions.filter((extension) => extension.isRegistered === true).map((e) => e.extension),
  );
  const availableMembers = new Set<string>();
  for (const status of input.queueStatuses) {
    if (!DISPATCH_QUEUE_NUMBERS.includes(status.queue as DispatchQueueNumber)) continue;
    for (const member of status.members ?? []) {
      if (member.dynamic && !member.paused && registered.has(member.extension)) {
        availableMembers.add(member.extension);
      }
    }
  }
  // Plan order is the priority order; anyone outside the committed plan is not
  // ours to route.
  return input.planOrder.filter((extension) => availableMembers.has(extension));
}

/** Stable identity of a desired arrangement, for change detection. */
export function dispatchCoverageDigest(map: DispatchCoverageMap): string {
  return DISPATCH_QUEUE_NUMBERS
    .map((queue) => `${queue}:${[...(map[queue] ?? [])].sort().join(",")}`)
    .join("|");
}

/**
 * Diffs desired against observed membership.
 *
 * Adds come before removes so a caller is never left with an empty queue
 * mid-change, and only extensions inside the committed plan are ever touched.
 */
export function diffDispatchCoverage(
  desired: DispatchCoverageMap,
  queueStatuses: readonly ViptelQueueStatus[],
  options: { managed: ReadonlySet<string> },
): CoverageStep[] {
  const adds: CoverageStep[] = [];
  const removes: CoverageStep[] = [];

  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const status = queueStatuses.find((candidate) => candidate.queue === queue);
    if (!status) continue;
    const members = status.members ?? [];
    const present = new Set(members.map((member) => member.extension));
    const want = new Set(desired[queue] ?? []);

    for (const extension of want) {
      if (!present.has(extension) && options.managed.has(extension)) {
        adds.push({ action: "add", queue, extension });
      }
    }
    for (const member of members) {
      if (want.has(member.extension) || !options.managed.has(member.extension)) continue;
      // Never remove a statically configured member; the routing saga owns
      // those and a static member is not ours to evict.
      if (!member.dynamic) continue;
      removes.push({ action: "remove", queue, extension: member.extension });
    }
  }
  return [...adds, ...removes];
}

/**
 * Fail-closed per-step safety.
 *
 * A member who is on a call, or who has a live provider call referencing their
 * extension, is never removed. Removals are also deferred while callers wait in
 * the affected queue -- except when the target is "every queue empty", which is
 * precisely the case where removal is what must happen so the fallback can fire.
 */
export function coverageStepIsSafe(
  step: CoverageStep,
  input: {
    queueStatuses: readonly ViptelQueueStatus[];
    desired: DispatchCoverageMap;
  },
): { safe: boolean; reason?: string } {
  if (step.action === "add") return { safe: true };

  const status = input.queueStatuses.find((candidate) => candidate.queue === step.queue);
  const member = status?.members?.find((candidate) => candidate.extension === step.extension);
  if (member?.inUse) return { safe: false, reason: "member_in_use" };

  const busyElsewhere = input.queueStatuses.some((candidate) =>
    (candidate.members ?? []).some((m) => m.extension === step.extension && m.inUse),
  );
  if (busyElsewhere) return { safe: false, reason: "member_in_use_elsewhere" };

  const emptyingEverything = DISPATCH_QUEUE_NUMBERS.every(
    (queue) => (input.desired[queue] ?? []).length === 0,
  );
  if (!emptyingEverything && (status?.waitingCalls ?? 0) > 0) {
    return { safe: false, reason: "callers_waiting" };
  }
  return { safe: true };
}
