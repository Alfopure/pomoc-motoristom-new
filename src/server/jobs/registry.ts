import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncCommander } from "@/server/integrations/commander/sync";
import { syncSwhouseOccupancy } from "@/server/integrations/swhouse/occupancy-sync";
import { syncSwhouseFleet } from "@/server/integrations/swhouse/sync";
import { resolveDefaultOrganizationId } from "@/server/default-organization";
import { materializeDueTaskReminders } from "@/server/task-notifications";
import { processTranscripts } from "@/server/telephony/transcripts-process";
import { syncWebdispecinkFleet } from "@/server/webdispecink-sync";
import type { JobContext, JobDefinition, JobExecutionResult, JobName } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const DEFINITIONS: { [K in JobName]: JobDefinition<K> } = {
  "fleet.webdispecink.positions": {
    name: "fleet.webdispecink.positions",
    schedule: { everyMs: MINUTE, offsetMs: 0 },
    timeoutMs: 45_000,
    leaseSeconds: 90,
    maxAttempts: 3,
    failureThreshold: 3,
    freshnessMs: 2 * MINUTE,
    run: async (context) => {
      assertNotAborted(context);
      if (!envEnabled("WEBDISPECINK_SYNC_ENABLED", true)) {
        return skipped("feature_disabled");
      }
      const result = await syncWebdispecinkFleet({ mode: "positions" });
      assertNotAborted(context);
      return success({
        mode: result.mode,
        positionCount: result.positionCount,
        updatedAssetPositions: result.updatedAssetPositions,
        unmappedPositionCount: result.unmappedPositionCount,
        syncedAt: result.syncedAt,
      });
    },
  },
  "fleet.webdispecink.catalog": {
    name: "fleet.webdispecink.catalog",
    schedule: { everyMs: 12 * HOUR, offsetMs: 7 * MINUTE },
    timeoutMs: 90_000,
    leaseSeconds: 150,
    maxAttempts: 2,
    failureThreshold: 1,
    freshnessMs: 13 * HOUR,
    run: async (context) => {
      assertNotAborted(context);
      if (!envEnabled("WEBDISPECINK_SYNC_ENABLED", true)) {
        return skipped("feature_disabled");
      }
      const result = await syncWebdispecinkFleet({ mode: "catalog" });
      assertNotAborted(context);
      return success({
        mode: result.mode,
        catalogCount: result.catalogCount,
        providerVehicleCount: result.providerVehicleCount,
        linkedVehicleCount: result.linkedVehicleCount,
        syncedAt: result.syncedAt,
      });
    },
  },
  "fleet.commander.positions": {
    name: "fleet.commander.positions",
    schedule: { everyMs: 5 * MINUTE, offsetMs: 4 * MINUTE },
    timeoutMs: 110_000,
    leaseSeconds: 180,
    maxAttempts: 3,
    failureThreshold: 3,
    freshnessMs: 10 * MINUTE,
    run: async (context) => {
      assertNotAborted(context);
      const result = await syncCommander({ mode: "positions" });
      if (result.status !== "success") {
        throw new Error(`Commander positions finished with ${result.status}.`);
      }
      assertNotAborted(context);
      return success({
        status: result.status,
        fetchedCount: result.fetchedCount,
        updatedCount: result.updatedCount,
        skippedCount: result.skippedCount,
        errorCount: result.errorCount,
      });
    },
  },
  "fleet.commander.catalog": {
    name: "fleet.commander.catalog",
    schedule: { everyMs: HOUR, offsetMs: 9 * MINUTE },
    timeoutMs: 60_000,
    leaseSeconds: 120,
    maxAttempts: 2,
    failureThreshold: 1,
    freshnessMs: 2 * HOUR,
    run: async (context) => {
      assertNotAborted(context);
      const result = await syncCommander({ mode: "vehicles" });
      if (result.status !== "success") {
        throw new Error(`Commander catalog finished with ${result.status}.`);
      }
      assertNotAborted(context);
      return success({
        status: result.status,
        fetchedCount: result.fetchedCount,
        createdCount: result.createdCount,
        updatedCount: result.updatedCount,
        errorCount: result.errorCount,
      });
    },
  },
  "fleet.swhouse.occupancy": {
    name: "fleet.swhouse.occupancy",
    schedule: { everyMs: 5 * MINUTE, offsetMs: 2 * MINUTE },
    timeoutMs: 110_000,
    leaseSeconds: 180,
    maxAttempts: 3,
    failureThreshold: 3,
    freshnessMs: 10 * MINUTE,
    run: async (context) => {
      assertNotAborted(context);
      const result = await syncSwhouseOccupancy();
      if (result.status !== "success") {
        throw new Error("SWHouse occupancy sync failed.");
      }
      assertNotAborted(context);
      return success({
        status: result.status,
        rosterCount: result.rosterCount,
        occupiedCount: result.occupiedCount,
        freeCount: result.freeCount,
      });
    },
  },
  "fleet.swhouse.roster": {
    name: "fleet.swhouse.roster",
    schedule: { everyMs: HOUR, offsetMs: 17 * MINUTE },
    timeoutMs: 300_000,
    leaseSeconds: 420,
    maxAttempts: 2,
    failureThreshold: 1,
    freshnessMs: 2 * HOUR,
    run: async (context) => {
      assertNotAborted(context);
      const result = await syncSwhouseFleet({ dryRun: false });
      if (result.status !== "success") {
        throw new Error("SWHouse roster sync failed.");
      }
      assertNotAborted(context);
      return success({
        status: result.status,
        fleetCount: result.fleetCount,
        recordsUpserted: result.recordsUpserted,
        recordsDeactivated: result.recordsDeactivated,
        linksRejected: result.linksRejected,
        assetsCreated: result.assetsCreated,
        assetsMatched: result.assetsMatched,
        unmappedBranchCount: result.unmappedBranchIds.length,
      });
    },
  },
  "notifications.materialize": {
    name: "notifications.materialize",
    schedule: { everyMs: MINUTE, offsetMs: 15_000 },
    timeoutMs: 45_000,
    leaseSeconds: 90,
    maxAttempts: 3,
    failureThreshold: 3,
    freshnessMs: 2 * MINUTE,
    run: async (context, payload) => {
      assertNotAborted(context);
      const organizationId = await resolveDefaultOrganizationId();
      const result = await materializeDueTaskReminders(
        createSupabaseAdminClient(),
        organizationId,
        new Date(),
        clamp(payload.limit ?? 50, 1, 200),
      );
      assertNotAborted(context);
      return success(result);
    },
  },
  "telephony.transcripts.process": {
    name: "telephony.transcripts.process",
    schedule: { everyMs: 10 * MINUTE, offsetMs: 2 * MINUTE },
    timeoutMs: 300_000,
    leaseSeconds: 420,
    maxAttempts: 2,
    failureThreshold: 2,
    freshnessMs: 30 * MINUTE,
    run: async (context, payload) => {
      assertNotAborted(context);
      const result = await processTranscripts({ maxItems: payload.maxItems });
      if (result.status === "disabled") {
        return skipped("feature_disabled");
      }
      if (result.status !== "ok") {
        throw new Error("Transcript processing failed.");
      }
      assertNotAborted(context);
      return success({
        status: result.status,
        candidates: result.candidates,
        processed: result.processed,
        failed: result.failed,
        skipped: result.skipped,
        aiProcessed: result.aiProcessed,
        aiFailed: result.aiFailed,
      });
    },
  },
};

export const JOB_DEFINITIONS = DEFINITIONS;

export function jobDefinition<K extends JobName>(jobName: K): JobDefinition<K> {
  return DEFINITIONS[jobName];
}

function assertNotAborted(context: JobContext) {
  if (context.signal.aborted) {
    throw context.signal.reason instanceof Error ? context.signal.reason : new Error("Job aborted.");
  }
}

function envEnabled(name: string, defaultValue: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return !["0", "false", "off", "disabled"].includes(value);
}

function success(summarySafe: JobExecutionResult["summarySafe"]): JobExecutionResult {
  return { status: "success", summarySafe };
}

function skipped(reason: string): JobExecutionResult {
  return { status: "skipped", summarySafe: { reason } };
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
