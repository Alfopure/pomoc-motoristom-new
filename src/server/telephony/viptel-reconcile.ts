import "server-only";

import { createViptelClient, type ViptelCdrRecord } from "@/lib/integrations/viptel/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { resolveDefaultOrganizationId } from "@/server/default-organization";
import { getViptelCorrelationCatalog } from "./viptel-correlation";
import { upsertViptelCall, type ViptelCallSnapshot } from "./viptel-events";

const DEFAULT_LOOKBACK_HOURS = 6;
const MAX_CDR_RECORDS = 200;
export const VIPTEL_CALL_HISTORY_FLOOR_CONFIG_KEY = "call_history_not_before";
const ACTIVE_STATUSES = ["incoming", "ringing_agent", "answered", "outbound"] as const;
type CallRow = Database["public"]["Tables"]["motorist_calls"]["Row"];

export async function reconcileViptelCalls() {
  const client = createSupabaseAdminClient();
  const organizationId = await resolveDefaultOrganizationId();
  const viptel = createViptelClient();
  const [activeCalls, cdrRecords, correlationCatalog, historyFloor] = await Promise.all([
    viptel.listActiveCalls(),
    viptel.listCdr({
      dateFrom: viptelDateFrom(DEFAULT_LOOKBACK_HOURS),
      limit: MAX_CDR_RECORDS,
    }),
    getViptelCorrelationCatalog(client, organizationId, { fresh: true }),
    resolveViptelCallHistoryFloor(client, organizationId),
  ]);

  let activeUpserts = 0;
  let activeSkippedBeforeHistoryFloor = 0;
  let cdrUpserts = 0;
  let cdrSkippedBeforeHistoryFloor = 0;
  for (const call of activeCalls) {
    if (!call.viptelUniqueId && !call.providerCallId) continue;
    if (!viptelRecordIsAtOrAfterHistoryFloor(call, historyFloor)) {
      activeSkippedBeforeHistoryFloor += 1;
      continue;
    }
    await upsertViptelCall(client, organizationId, {
      uniqueId: call.viptelUniqueId,
      providerCallId: call.providerCallId,
      direction: call.direction,
      directionAuthoritative: false,
      status: call.status,
      callerNumber: call.callerNumber,
      callerName: call.callerName,
      calledNumber: call.calledNumber,
      queueNumber: call.queueNumber,
      startedAt: call.startedAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      waitSeconds: call.waitSeconds,
      durationSeconds: call.durationSeconds,
      raw: call.raw,
    }, correlationCatalog);
    activeUpserts += 1;
  }

  for (const record of cdrRecords) {
    if (!record.viptelUniqueId && !record.cdrId) continue;
    if (!viptelRecordIsAtOrAfterHistoryFloor(record, historyFloor)) {
      cdrSkippedBeforeHistoryFloor += 1;
      continue;
    }
    await upsertViptelCall(client, organizationId, cdrSnapshot(record), correlationCatalog);
    cdrUpserts += 1;
  }
  const terminalRepairs = await repairImpossibleActiveCalls(client, organizationId);

  return {
    activeFetched: activeCalls.length,
    activeUpserts,
    activeSkippedBeforeHistoryFloor,
    cdrFetched: cdrRecords.length,
    cdrUpserts,
    cdrSkippedBeforeHistoryFloor,
    historyFloor,
    terminalRepairs,
    reconciledAt: new Date().toISOString(),
  };
}

async function resolveViptelCallHistoryFloor(
  client: ReturnType<typeof createSupabaseAdminClient>,
  organizationId: string,
) {
  const result = await client
    .from("motorist_organization_integrations")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .maybeSingle();
  if (result.error) throw new Error(`VIPTel history floor could not be loaded: ${result.error.message}`);
  const config = asRecord(result.data?.config);
  const value = config[VIPTEL_CALL_HISTORY_FLOOR_CONFIG_KEY];
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function viptelRecordIsAtOrAfterHistoryFloor(
  record: Pick<ViptelCdrRecord, "startedAt" | "answeredAt" | "endedAt">,
  historyFloor: string | null,
) {
  if (!historyFloor) return true;
  const floorTimestamp = Date.parse(historyFloor);
  if (!Number.isFinite(floorTimestamp)) return true;
  const recordTimestamp = Date.parse(record.startedAt ?? record.answeredAt ?? record.endedAt ?? "");
  // A record without a trustworthy provider timestamp must not be discarded.
  return !Number.isFinite(recordTimestamp) || recordTimestamp >= floorTimestamp;
}

async function repairImpossibleActiveCalls(
  client: ReturnType<typeof createSupabaseAdminClient>,
  organizationId: string,
) {
  const result = await client
    .from("motorist_calls")
    .select("id, status, direction, answered_at, ended_at, end_reason, duration_seconds")
    .eq("organization_id", organizationId)
    .in("status", [...ACTIVE_STATUSES])
    .not("ended_at", "is", null)
    .limit(MAX_CDR_RECORDS);
  if (result.error) throw new Error(`Impossible active VIPTel calls could not be loaded: ${result.error.message}`);

  let repaired = 0;
  for (const call of result.data ?? []) {
    const status = terminalStatusForEndedCall(call);
    const update = await client
      .from("motorist_calls")
      .update({ status })
      .eq("organization_id", organizationId)
      .eq("id", call.id)
      .eq("status", call.status)
      .not("ended_at", "is", null)
      .select("id");
    if (update.error) throw new Error(`Impossible active VIPTel call could not be repaired: ${update.error.message}`);
    repaired += update.data?.length ?? 0;
  }
  return repaired;
}

export function terminalStatusForEndedCall(
  call: Pick<CallRow, "answered_at" | "direction" | "duration_seconds" | "end_reason">,
): CallRow["status"] {
  const reason = call.end_reason?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  const answered = Boolean(call.answered_at) || (call.duration_seconds ?? 0) > 0 ||
    ["answer", "answered", "complete", "completed", "normalclearing"].includes(reason);
  if (answered) return "ended";
  return call.direction === "outbound" ? "failed" : "missed";
}

export function cdrSnapshot(record: ViptelCdrRecord): ViptelCallSnapshot {
  const disposition = record.disposition?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  const answered = ["answer", "answered", "complete", "completed"].includes(disposition) || (record.billSeconds ?? 0) > 0;
  const queueCall = record.application?.toLowerCase() === "queue" || Boolean(record.queueNumber);
  const status = answered
    ? "ended"
    : record.direction === "outbound"
      ? "failed"
      : queueCall
        ? "abandoned_queue"
        : "missed";
  const totalDuration = record.completeDurationSeconds ?? record.durationSeconds;
  const endedAt = record.endedAt ?? addSeconds(record.startedAt, totalDuration);
  const answeredAt = record.answeredAt ?? (answered ? addSeconds(record.startedAt, record.ringSeconds) : undefined);

  return {
    uniqueId: record.viptelUniqueId,
    providerCallId: record.cdrId,
    direction: record.direction ?? "inbound",
    directionAuthoritative: Boolean(record.direction),
    status,
    type: record.type,
    application: record.application,
    endReason: record.disposition,
    callerNumber: record.callerNumber,
    callerName: record.callerName,
    calledNumber: record.calledNumber,
    receivedNumber: record.receivedNumber,
    destinationNumber: record.destinationNumber,
    callerExtension: record.callerExtension,
    receivedExtension: record.receivedExtension,
    destinationExtension: record.destinationExtension,
    queueNumber: record.queueNumber,
    startedAt: record.startedAt,
    answeredAt,
    endedAt,
    ringSeconds: record.ringSeconds,
    durationSeconds: record.durationSeconds,
    completeDurationSeconds: record.completeDurationSeconds,
    recordingFile: record.recordingFile,
    authoritativeTerminal: true,
    raw: record.raw,
  };
}

export function viptelDateFrom(hours: number, now = new Date()) {
  const date = new Date(now.getTime() - Math.max(1, hours) * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function addSeconds(value: string | undefined, seconds: number | undefined) {
  if (!value || seconds === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp + seconds * 1000).toISOString() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
