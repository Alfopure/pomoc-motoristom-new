import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { workplaceHotdeskCapability } from "./workplace-capability";
import {
  createWorkplaceOperationRepository,
  type WorkplaceOperationRepository,
} from "./workplace-operation-repository";
import { recoverExpiredWorkplaceOperations } from "./workplace-handoff";

type AdminClient = SupabaseClient<Database>;

/**
 * Durable recovery for stuck workplace state.
 *
 * Everything this does was previously reachable only from a request handler, so
 * in practice it happened because an operator had a console open and the browser
 * polled workplace-selection every ten seconds. With every console closed --
 * overnight, or exactly when something has gone wrong enough that people stopped
 * working -- nothing recovered at all.
 *
 * Each pass is bounded, and each row is isolated so one bad row cannot stop the
 * rest. Failures are collected and thrown as one redacted aggregate at the end,
 * because a sweeper that silently swallows its own errors is how a wedged claim
 * stays invisible for a week.
 */

export const WORKPLACE_SWEEP_LIMIT = 50;
/** A lease only just past expiry is a browser that may still be recovering. */
export const WORKPLACE_LEASE_REAP_GRACE_MS = 5 * 60_000;
/** How long a post-commit operation may sit before a human is asked to look. */
export const WORKPLACE_MANUAL_RECOVERY_THRESHOLD_MS = 15 * 60_000;

export type WorkplaceSweepFailure = { pass: string; entityId: string; reason: string };

export type WorkplaceSweepSummary = {
  scanned: number;
  recoveredOperations: number;
  releasedClaims: number;
  reapedLeases: number;
  markedManualRecovery: number;
  skipped: Record<string, number>;
  failures: WorkplaceSweepFailure[];
};

export type WorkplaceSweepDependencies = {
  client?: AdminClient;
  repository?: WorkplaceOperationRepository;
  now?: () => number;
};

export class WorkplaceSweepError extends Error {
  constructor(readonly summary: WorkplaceSweepSummary) {
    super(
      `Workplace sweep completed with ${summary.failures.length} failure(s): ` +
      summary.failures.map((f) => `${f.pass}/${f.entityId}: ${f.reason}`).join("; "),
    );
    this.name = "WorkplaceSweepError";
  }
}

export async function sweepStuckWorkplaceState(
  context: { organizationId: string; recoveryOwner: string },
  dependencies: WorkplaceSweepDependencies = {},
): Promise<WorkplaceSweepSummary> {
  const summary: WorkplaceSweepSummary = {
    scanned: 0,
    recoveredOperations: 0,
    releasedClaims: 0,
    reapedLeases: 0,
    markedManualRecovery: 0,
    skipped: {},
    failures: [],
  };

  // Hot-desking off means none of this state exists. Do nothing rather than
  // scan tables that are not in use.
  if (!workplaceHotdeskCapability().runtimeEnabled) {
    summary.skipped.hotdesk_runtime_disabled = 1;
    return summary;
  }

  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  const databaseNow = await repository.databaseNow();
  const nowMs = Date.parse(databaseNow);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Workplace sweep could not read an authoritative database clock.");
  }
  const skip = (reason: string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };
  const fail = (pass: string, entityId: string, error: unknown) => {
    summary.failures.push({ pass, entityId, reason: safeReason(error) });
  };

  // Pass 1 -- expired precommit operations, through the real recovery path.
  try {
    const recovery = await recoverExpiredWorkplaceOperations(context, { client, repository }, {
      limit: WORKPLACE_SWEEP_LIMIT,
    });
    summary.recoveredOperations += recovery.recovered;
    for (const entry of recovery.skipped) skip(`recover:${firstToken(entry.reason)}`);
    for (const entry of recovery.failures) {
      summary.failures.push({ pass: "recover_expired", entityId: entry.operationId, reason: entry.reason });
    }
  } catch (error) {
    fail("recover_expired", "batch", error);
  }

  // Pass 2 -- claims whose owning operation already finished. This is the case
  // the acquire RPC could never resolve on its own before.
  try {
    const terminal = await client
      .from("motorist_workplace_operations")
      .select("id")
      .eq("organization_id", context.organizationId)
      .in("phase", ["completed", "aborted"])
      .limit(WORKPLACE_SWEEP_LIMIT);
    if (terminal.error) throw new Error(terminal.error.message);
    const terminalIds = (terminal.data ?? []).map((row) => row.id);
    summary.scanned += terminalIds.length;
    if (terminalIds.length > 0) {
      const held = await client
        .from("motorist_workplace_resource_claims")
        .select("operation_id")
        .eq("organization_id", context.organizationId)
        .in("operation_id", terminalIds);
      if (held.error) throw new Error(held.error.message);
      const stuck = [...new Set((held.data ?? [])
        .map((row) => row.operation_id)
        .filter((id): id is string => Boolean(id)))];
      for (const operationId of stuck) {
        try {
          const released = await repository.releaseTerminalClaims({
            organizationId: context.organizationId,
            operationId,
            recoveryOwner: context.recoveryOwner,
          });
          summary.releasedClaims += released.releasedClaims;
        } catch (error) {
          const reason = safeReason(error);
          if (reason.includes("TELEPHONY_RESOURCE_BUSY")) skip("release:resource_busy");
          else fail("release_terminal_claims", operationId, error);
        }
      }
    }
  } catch (error) {
    fail("release_terminal_claims", "batch", error);
  }

  // Pass 3 -- post-commit operations long past their guard. These must roll
  // forward, so they are marked for a human rather than released.
  try {
    const threshold = new Date(nowMs - WORKPLACE_MANUAL_RECOVERY_THRESHOLD_MS).toISOString();
    const stranded = await client
      .from("motorist_workplace_operations")
      .select("id")
      .eq("organization_id", context.organizationId)
      .in("phase", ["ownership_committed", "audits_verified"])
      .lt("claim_expires_at", threshold)
      .limit(WORKPLACE_SWEEP_LIMIT);
    if (stranded.error) throw new Error(stranded.error.message);
    summary.scanned += (stranded.data ?? []).length;
    for (const operation of stranded.data ?? []) {
      try {
        await repository.markManualRecovery({
          organizationId: context.organizationId,
          operationId: operation.id,
          recoveryOwner: context.recoveryOwner,
          reasonSafe: "Post-commit operation stranded past its guard.",
        });
        summary.markedManualRecovery += 1;
      } catch (error) {
        const reason = safeReason(error);
        if (reason.includes("WORKPLACE_OPERATION_NOT_RECOVERABLE")) skip("manual:not_recoverable");
        else fail("mark_manual_recovery", operation.id, error);
      }
    }
  } catch (error) {
    fail("mark_manual_recovery", "batch", error);
  }

  // Pass 4 -- expired leases. Ending the lease is what lets availability drop
  // the operator; extension ownership deliberately stays untouched.
  try {
    const graceCutoff = new Date(nowMs - WORKPLACE_LEASE_REAP_GRACE_MS).toISOString();
    const expired = await client
      .from("motorist_workplace_leases")
      .select("id")
      .eq("organization_id", context.organizationId)
      .in("state", ["active", "ending"])
      .lt("expires_at", graceCutoff)
      .order("expires_at", { ascending: true })
      .limit(WORKPLACE_SWEEP_LIMIT);
    if (expired.error) throw new Error(expired.error.message);
    summary.scanned += (expired.data ?? []).length;
    for (const lease of expired.data ?? []) {
      try {
        const result = await repository.reapLease({
          organizationId: context.organizationId,
          leaseId: lease.id,
          recoveryOwner: context.recoveryOwner,
        });
        if (result.reaped) summary.reapedLeases += 1;
        else skip("reap:already_ended");
      } catch (error) {
        const reason = safeReason(error);
        if (reason.includes("TELEPHONY_RESOURCE_BUSY")) skip("reap:referenced");
        else if (reason.includes("WORKPLACE_OPERATION_NOT_RECOVERABLE")) skip("reap:within_grace");
        else fail("reap_lease", lease.id, error);
      }
    }
  } catch (error) {
    fail("reap_lease", "batch", error);
  }

  if (summary.failures.length > 0) throw new WorkplaceSweepError(summary);
  return summary;
}

/** Redacted: symbolic codes and safe text only, never row values. */
function safeReason(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const symbolic = raw.match(/[A-Z][A-Z0-9_]{4,80}/g);
  if (symbolic && symbolic.length > 0) return symbolic.join(",");
  return raw.slice(0, 120).replace(/[^A-Za-z0-9 .,:_-]/g, "");
}

function firstToken(reason: string) {
  return reason.match(/[A-Z][A-Z0-9_]{4,80}/)?.[0] ?? "other";
}
