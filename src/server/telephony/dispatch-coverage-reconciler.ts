import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ViptelExtension, ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  assertNoPendingDispatchAvailabilityCommand,
  DISPATCH_QUEUE_NUMBERS,
  parseDispatchRoutingState,
  requireDispatchQueueCatalog,
  type DispatchQueueNumber,
} from "./dispatch-routing";
import {
  coverageStepIsSafe,
  diffDispatchCoverage,
  dispatchCoverageDigest,
  dispatchCoverageFillForwardEnabled,
  onlineDispatchExtensions,
  orderedDispatchPlanExtensions,
  packDispatchQueueCoverage,
  type CoverageStep,
} from "./dispatch-coverage";
import { beginTelephonyCommand } from "./telephony-commands";

type AdminClient = SupabaseClient<Database>;

/**
 * Keeps provider queue membership matching the packing rule.
 *
 * Runs from the listener, which already holds a fresh provider snapshot every
 * couple of seconds. Deliberately stateless in the database: the desired
 * arrangement is recomputed from the snapshot each tick, so there is no
 * coverage row to contend with the manager routing saga's compare-and-set, and
 * nothing to repair if the listener restarts.
 *
 * Change detection is held in memory only. A restart simply re-derives, and the
 * command idempotency key is deterministic, so two listeners briefly overlapping
 * during a handover collide harmlessly rather than double-applying.
 */

export const COVERAGE_ENV_FLAG = "VIPTEL_DISPATCH_COVERAGE_ENABLED";
/** Require the same desired state twice before acting on it. */
export const COVERAGE_STABILITY_TICKS = 2;
/** At most one membership command per tick; the outbox drains one at a time. */
export const COVERAGE_COMMANDS_PER_TICK = 1;

export type CoverageTickStatus =
  | "disabled" | "skipped" | "matched" | "emitted" | "deferred" | "unstable";

export type CoverageTickResult = {
  status: CoverageTickStatus;
  reason?: string;
  onlineCount?: number;
  desiredDigest?: string;
  step?: CoverageStep;
};

export type CoverageProviderSnapshot = {
  extensions: ViptelExtension[];
  queueStatuses: ViptelQueueStatus[];
};

/**
 * How long to leave an emitted step alone before considering it again.
 *
 * A membership change is not visible in the provider snapshot immediately: the
 * command has to be claimed, sent and confirmed, and the listener's own
 * snapshot is cached for a few seconds. Without this the reconciler re-derives
 * the same unmet desired state every couple of seconds and re-emits the same
 * step continuously.
 */
export const COVERAGE_EMIT_COOLDOWN_MS = 20_000;

/** In-memory stability and cooldown tracker, one per listener process. */
export function createCoverageStabilityTracker(now: () => number = Date.now) {
  let lastDigest: string | null = null;
  let repeats = 0;
  const emitted = new Map<string, number>();
  return {
    observe(digest: string) {
      if (digest === lastDigest) repeats += 1;
      else { lastDigest = digest; repeats = 1; }
      return repeats;
    },
    /** True while a step emitted recently should be left to take effect. */
    recentlyEmitted(key: string) {
      const at = emitted.get(key);
      return at !== undefined && now() - at < COVERAGE_EMIT_COOLDOWN_MS;
    },
    markEmitted(key: string) {
      const cutoff = now() - COVERAGE_EMIT_COOLDOWN_MS;
      for (const [existing, at] of emitted) if (at < cutoff) emitted.delete(existing);
      emitted.set(key, now());
    },
    reset() { lastDigest = null; repeats = 0; emitted.clear(); },
  };
}

export type CoverageStabilityTracker = ReturnType<typeof createCoverageStabilityTracker>;

export function dispatchCoverageEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env[COVERAGE_ENV_FLAG]?.trim().toLowerCase() === "true";
}

export async function reconcileDispatchQueueCoverage(input: {
  organizationId: string;
  snapshot: CoverageProviderSnapshot;
  stability: CoverageStabilityTracker;
  client?: AdminClient;
  requestedBy?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CoverageTickResult> {
  if (!dispatchCoverageEnabled(input.env)) return { status: "disabled" };

  const client = input.client ?? createSupabaseAdminClient();
  const queues = await requireDispatchQueueCatalog(client, input.organizationId);
  const root = queues.get("601");
  if (!root) return { status: "skipped", reason: "missing_root_queue" };

  const state = parseDispatchRoutingState(root.metadata);
  // A manager routing change owns membership while it runs. Stay completely
  // inert rather than fighting it.
  if (state.operation) {
    input.stability.reset();
    return { status: "skipped", reason: "routing_operation_active" };
  }

  const planOrder = orderedDispatchPlanExtensions(state.currentPlan);
  if (planOrder.length === 0) return { status: "skipped", reason: "no_committed_plan" };

  const online = onlineDispatchExtensions({
    planOrder,
    queueStatuses: input.snapshot.queueStatuses,
    extensions: input.snapshot.extensions,
  });
  const desired = packDispatchQueueCoverage(DISPATCH_QUEUE_NUMBERS, online, {
    fillForward: dispatchCoverageFillForwardEnabled(input.env),
  });
  const desiredDigest = dispatchCoverageDigest(desired);

  const steps = diffDispatchCoverage(desired, input.snapshot.queueStatuses, {
    managed: new Set(planOrder),
  });
  if (steps.length === 0) {
    input.stability.observe(desiredDigest);
    return { status: "matched", onlineCount: online.length, desiredDigest };
  }

  // Two consecutive identical readings before acting, so a single odd snapshot
  // during a queue handoff cannot cause a membership change.
  if (input.stability.observe(desiredDigest) < COVERAGE_STABILITY_TICKS) {
    return { status: "unstable", onlineCount: online.length, desiredDigest };
  }

  for (const step of steps.slice(0, COVERAGE_COMMANDS_PER_TICK)) {
    const safety = coverageStepIsSafe(step, {
      queueStatuses: input.snapshot.queueStatuses,
      desired,
    });
    if (!safety.safe) {
      return { status: "deferred", reason: safety.reason, onlineCount: online.length, desiredDigest, step };
    }

    // A step that was just emitted needs time to reach the provider and show up
    // in a fresh snapshot. Re-deriving the same unmet state every two seconds
    // and re-emitting is what turned this into a per-tick error loop.
    const stepKey = `${step.action}:${step.queue}:${step.extension}`;
    if (input.stability.recentlyEmitted(stepKey)) {
      return { status: "deferred", reason: "emit_cooldown", onlineCount: online.length, desiredDigest, step };
    }

    // One availability command in flight at a time, matching the existing fence
    // used by the operator-facing availability route.
    await assertNoPendingDispatchAvailabilityCommand(input.organizationId, step.queue, step.extension);

    const queueRow = queues.get(step.queue);
    const extensionId = await resolveExtensionId(client, input.organizationId, step.extension);
    // Coverage commands have no interactive actor, so they are attributed to
    // whoever committed the plan being enforced. That keeps the audit trail
    // pointing at a real accountable person without inventing a system profile.
    const requestedBy = input.requestedBy ?? await resolvePlanCommitterProfileId(client, input.organizationId);
    if (!queueRow || !extensionId || !requestedBy) {
      return { status: "skipped", reason: "unresolved_queue_extension_or_actor", desiredDigest, step };
    }

    input.stability.markEmitted(stepKey);
    try {
      await beginTelephonyCommand({
        organizationId: input.organizationId,
        requestedBy,
        commandType: `queue.${step.action}`,
        queueId: queueRow.id,
        extensionId,
        // Deterministic within a coarse time bucket: two listeners overlapping
        // during a handover produce the same key and collide instead of
        // applying the change twice, while a later genuine retry still gets a
        // fresh key rather than being blocked forever.
        idempotencyKey: coverageIdempotencyKey(input.organizationId, state.revision, desiredDigest, step),
        requestPayload: {
          queue: step.queue,
          extension: step.extension,
          action: step.action,
          routingCoverage: {
            kind: "coverage",
            planRevision: state.revision,
            desiredDigest,
            onlineCount: online.length,
          },
        },
      });
    } catch (error) {
      // Another listener recorded the identical intent first. That is the
      // collision working as designed, not a failure.
      if (isDuplicateIntent(error)) {
        return { status: "deferred", reason: "already_recorded", onlineCount: online.length, desiredDigest, step };
      }
      throw error;
    }
    return { status: "emitted", onlineCount: online.length, desiredDigest, step };
  }

  return { status: "deferred", reason: "no_safe_step", onlineCount: online.length, desiredDigest };
}

/** Coarse bucket so a later genuine retry gets a fresh key. */
export const COVERAGE_IDEMPOTENCY_BUCKET_MS = 60_000;

function coverageIdempotencyKey(
  organizationId: string,
  planRevision: number,
  desiredDigest: string,
  step: CoverageStep,
  now = Date.now(),
) {
  const bucket = Math.floor(now / COVERAGE_IDEMPOTENCY_BUCKET_MS);
  return createHash("sha256")
    .update(`motorist.viptel.coverage.v1\n${organizationId}\n${planRevision}\n${desiredDigest}\n${step.action}\n${step.queue}\n${step.extension}\n${bucket}`)
    .digest("hex");
}

/**
 * A duplicate idempotency key or its derived audit id means an identical intent
 * is already recorded -- the collision fence doing its job.
 */
function isDuplicateIntent(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("duplicate key value") || message.includes("23505");
}

async function resolvePlanCommitterProfileId(
  client: AdminClient,
  organizationId: string,
): Promise<string | null> {
  const result = await client
    .from("motorist_audit_log")
    .select("actor_profile_id")
    .eq("organization_id", organizationId)
    .eq("entity_type", "motorist_telephony_queues")
    .eq("action", "telephony.routing.plan.committed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return result.data?.actor_profile_id ?? null;
}

async function resolveExtensionId(
  client: AdminClient,
  organizationId: string,
  extension: string,
): Promise<string | null> {
  const result = await client
    .from("motorist_telephony_extensions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .eq("extension", extension)
    .eq("active", true)
    .maybeSingle();
  return result.data?.id ?? null;
}

export type { DispatchQueueNumber };
