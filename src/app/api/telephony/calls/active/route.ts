import type { CallCenterCall } from "@/data/dispatch-types";
import { serializeViptelError, type ViptelActiveCall } from "@/lib/integrations/viptel/client";
import { collapseLogicalTelephonyCalls } from "@/lib/telephony/call-endpoints";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";
import { currentViptelProviderCallLegs } from "@/server/telephony/provider-call-state";
import { requestViptelProviderSnapshot } from "@/server/telephony/provider-snapshot-bridge";
import {
  loadViptelLineCatalog,
  resolveViptelLineIdentity,
  type ViptelLineCatalogEntry,
} from "@/server/telephony/viptel-line-catalog";

export const runtime = "nodejs";
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };
const LISTENER_WAITING_CALL_MAX_AGE_MS = 45_000;
/**
 * How long a caller between rotation steps stays visible.
 *
 * VIPTel moves a waiting caller to the next queue as queue.left followed a
 * couple of seconds later by queue.join with the same channel id, and the
 * stored row passes through "abandoned_queue" in between. Dropping the row for
 * that gap made every caller blink out of the waiting room once per rotation
 * step even though the call existed the whole time. A caller who genuinely
 * hangs up gets call.end within seconds, which sets ended_at and removes them
 * regardless of this grace.
 */
const ROTATION_HOP_GRACE_MS = 12_000;
const NORMAL_SNAPSHOT_WAIT_MS = 4_000;

type CallRow = Database["public"]["Tables"]["motorist_calls"]["Row"];

export async function GET(request?: Request) {
  const checkedAt = new Date().toISOString();
  const requireFreshCapture = request ? new URL(request.url).searchParams.get("fresh") === "1" : false;

  try {
    const actor = await requireTelephonyActor();
    const supabase = createSupabaseAdminClient();
    let providerCalls: ViptelActiveCall[] = [];
    let providerCapturedAt: string | undefined;
    let providerError: unknown;
    const providerWaitingChannelIds = new Set<string>();
    try {
      const providerSnapshot = await requestViptelProviderSnapshot(
        actor.organizationId,
        actor.profileId,
        requireFreshCapture
          ? { maxAgeMs: 4_000, requireNewCapture: true }
          : { maxAgeMs: 3_000, waitMs: NORMAL_SNAPSHOT_WAIT_MS },
      );
      providerCapturedAt = providerSnapshot.capturedAt;
      providerCalls = currentViptelProviderCallLegs(providerSnapshot.activeCalls);
      for (const status of providerSnapshot.queueStatuses ?? []) {
        for (const entry of status.waitingCallEntries ?? []) {
          providerWaitingChannelIds.add(entry.uniqueId);
        }
      }
    } catch (error) {
      // Explicit fresh reads are used for call control and stay fail-closed.
      // The ordinary UI poll may show listener-confirmed queue calls while
      // REST recovers; those rows remain unassigned and non-authoritative.
      if (requireFreshCapture) throw error;
      providerError = error;
    }
    const [storedCallsByProviderIdentity, lineCatalog, provisionalQueueCalls] = await Promise.all([
      providerCalls.length > 0
        ? loadStoredActiveCalls(supabase, actor.organizationId, providerCalls)
        : Promise.resolve(new Map<string, CallRow>()),
      loadViptelLineCatalog(supabase, actor.organizationId),
      loadProvisionalQueueCalls(supabase, actor.organizationId, checkedAt),
    ]);
    const mappedProviderCalls = providerCalls.map((call, index) =>
      mapActiveCall(
        call,
        index,
        checkedAt,
        storedCallsByProviderIdentity.get(call.viptelUniqueId ?? "") ??
          storedCallsByProviderIdentity.get(call.fromQueueUniqueId ?? "") ??
          storedCallsByProviderIdentity.get(`provider:${call.providerCallId ?? ""}`),
        lineCatalog,
      ),
    );
    const providerVerified = providerError === undefined;
    // A successful provider snapshot is authoritative, including an empty
    // list after the caller hangs up. Listener rows supplement only a failed
    // snapshot; otherwise their ingestion lag could keep a dead call visible.
    const providerCapturedAtMs = providerCapturedAt ? Date.parse(providerCapturedAt) : Number.NaN;
    const handoffCalls = provisionalQueueCalls
      .filter((stored) =>
        storedCallIsProviderWaiting(stored, providerWaitingChannelIds) ||
        isListenerWaitingCall(stored, checkedAt))
      .filter((stored) => !mappedProviderCalls.some((live) => storedCallMatchesActiveCall(stored, live)))
      // Three ways a stored waiting row is corroborated. (1) The snapshot's
      // queue statuses list the caller's channel as waiting right now -- the
      // authoritative case, and the one that keeps a second caller steadily
      // visible: while the only agent rings with the first caller, the second
      // has no agent leg at all, so the active-call list cannot represent
      // them and only the queue status knows they exist. (2) The snapshot
      // failed or predates the listener's event, so listener evidence stands
      // in. (3) No snapshot timestamp to compare against. Requiring the row
      // to be newer than every snapshot made the second caller invisible
      // except for a blink at each rotation step, at different moments in
      // each browser.
      .filter((stored) =>
        storedCallIsProviderWaiting(stored, providerWaitingChannelIds) ||
        !providerVerified ||
        !Number.isFinite(providerCapturedAtMs) ||
        Date.parse(stored.updated_at) > providerCapturedAtMs)
      .map((stored) => mapProvisionalQueueCall(stored, lineCatalog));
    const calls = collapseLogicalTelephonyCalls([...mappedProviderCalls, ...handoffCalls]);

    return Response.json({
      ok: true,
      source: providerVerified
        ? handoffCalls.length > 0
          ? "viptel_call_statistics_with_listener_waiting"
          : "viptel_call_statistics"
        : "viptel_listener_waiting_fallback",
      providerVerified,
      warning: providerError === undefined ? undefined : serializeViptelError(providerError).message,
      checkedAt,
      calls,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json(
        { ok: false, source: "viptel_call_statistics", checkedAt, error: error.message },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }

    const serialized = serializeViptelError(error);

    return Response.json(
      {
        ok: false,
        source: "viptel_call_statistics",
        checkedAt,
        error: serialized.message,
        providerStatus: serialized.providerStatus,
        providerResponseSummary: serialized.providerResponseSummary,
      },
      { status: serialized.status, headers: NO_STORE_HEADERS },
    );
  }
}

async function loadProvisionalQueueCalls(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  organizationId: string,
  checkedAt: string,
) {
  const cutoff = new Date(Date.parse(checkedAt) - LISTENER_WAITING_CALL_MAX_AGE_MS).toISOString();
  const result = await supabase
    .from("motorist_calls")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .eq("direction", "inbound")
    .in("queue_number", ["601", "602", "603"])
    .in("status", ["incoming", "ringing_agent", "abandoned_queue"])
    .is("answered_at", null)
    .is("ended_at", null)
    .gte("updated_at", cutoff)
    .order("started_at", { ascending: true, nullsFirst: false })
    .limit(25);
  if (result.error) throw new Error(`Queue handoff calls could not be loaded: ${result.error.message}`);
  return result.data ?? [];
}

/** True when the provider's queue statuses list this row's own channel as waiting. */
export function storedCallIsProviderWaiting(
  call: Pick<CallRow, "from_queue_unique_id" | "viptel_unique_id">,
  waitingChannelIds: ReadonlySet<string>,
) {
  if (waitingChannelIds.size === 0) return false;
  const channel = call.from_queue_unique_id?.trim() || call.viptel_unique_id?.trim();
  return Boolean(channel && waitingChannelIds.has(channel));
}

export function isListenerWaitingCall(call: CallRow, checkedAt: string) {
  if (call.answered_at || call.ended_at) return false;
  const updatedAt = Date.parse(call.updated_at);
  const referenceAt = Date.parse(checkedAt);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(referenceAt) || updatedAt > referenceAt + 5_000) return false;
  if (call.status === "abandoned_queue") {
    // Between rotation steps: the caller left one queue and joins the next in
    // a couple of seconds. Only a freshly updated row qualifies, so a caller
    // whose journey truly stopped fades out quickly rather than lingering.
    return updatedAt >= referenceAt - ROTATION_HOP_GRACE_MS;
  }
  return ["incoming", "ringing_agent"].includes(call.status) &&
    updatedAt >= referenceAt - LISTENER_WAITING_CALL_MAX_AGE_MS;
}

export function mapProvisionalQueueCall(
  call: CallRow,
  lineCatalog: ReadonlyArray<ViptelLineCatalogEntry>,
): CallCenterCall {
  const lineIdentity = resolveViptelLineIdentity({
    catalog: lineCatalog,
    storedLineId: call.line_id ?? undefined,
    storedReceivedNumber: call.received_number ?? undefined,
    providerNumbers: [call.called_number].filter((value): value is string => Boolean(value)),
  });
  return {
    id: call.id,
    providerCallId: call.provider_call_id ?? undefined,
    viptelUniqueId: call.viptel_unique_id ?? undefined,
    fromQueueUniqueId: call.from_queue_unique_id ?? undefined,
    status: "incoming",
    direction: "inbound",
    callerNumber: call.caller_number ?? "Neznáme číslo",
    callerName: call.caller_name ?? undefined,
    calledNumber: call.called_number ?? call.queue_number ?? "-",
    receivedNumber: lineIdentity.phoneNumber ?? call.received_number ?? undefined,
    // The listener proves the logical queue call, not its current agent leg.
    // A stored destination can belong to a previous offer and must not grant
    // call control to that workstation.
    destinationNumber: undefined,
    callerExtension: call.caller_extension ?? undefined,
    receivedExtension: call.received_extension ?? undefined,
    destinationExtension: undefined,
    extensionId: undefined,
    operatorId: undefined,
    lineId: lineIdentity.lineId,
    lineLabel: lineIdentity.lineLabel,
    queueLabel: call.queue_number ?? undefined,
    caseId: call.case_id ?? undefined,
    createdAt: call.created_at,
    // Queue handoffs can rewrite the current leg's `started_at`. The caller
    // has still been waiting since this immutable logical row was created.
    startedAt: call.created_at,
    waitSeconds: call.wait_seconds ?? 0,
    recordingStatus: call.recording_status,
    transcriptStatus: call.transcript_status,
    history: ["Čakajúci hovor potvrdený listenerom; aktuálne pracovisko overí VIPTel snapshot."],
  };
}

function storedCallMatchesActiveCall(stored: CallRow, active: CallCenterCall) {
  if (stored.id === active.id) return true;
  if (stored.provider_call_id && stored.provider_call_id === active.providerCallId) return true;
  const storedIds = new Set([stored.viptel_unique_id, stored.from_queue_unique_id].filter(Boolean));
  return [active.viptelUniqueId, active.fromQueueUniqueId]
    .some((identity) => Boolean(identity && storedIds.has(identity)));
}

export function mapActiveCall(
  call: ViptelActiveCall,
  index: number,
  checkedAt: string,
  stored: CallRow | undefined,
  lineCatalog: ReadonlyArray<ViptelLineCatalogEntry>,
): CallCenterCall {
  const inbound = call.direction === "inbound";
  const providerReceivedCandidates = providerNumberCandidates(call, [
    "received_number",
    "receivedNumber",
    "received",
    "did",
    "called_number",
    "calledNumber",
    "called",
  ]);
  if (call.receivedNumber) providerReceivedCandidates.push(call.receivedNumber);
  if (inbound && call.calledNumber) providerReceivedCandidates.push(call.calledNumber);

  const explicitProviderReceivedNumber = call.receivedNumber ?? providerNumberCandidates(call, [
    "received_number",
    "receivedNumber",
    "received",
    "did",
  ])[0];
  const providerDestinationNumber =
    call.destinationNumber ??
    providerNumberCandidates(call, ["destination_number", "destinationNumber", "destination", "dst", "callee", "to"])[0] ??
    call.calledNumber;
  const destinationNumber = providerDestinationNumber ?? stored?.destination_number ?? undefined;
  const providerHasCurrentDestination = Boolean(
    call.destinationExtension?.trim() || providerDestinationNumber?.trim(),
  );
  const lineIdentity = resolveViptelLineIdentity({
    catalog: lineCatalog,
    storedLineId: inbound ? stored?.line_id : undefined,
    storedReceivedNumber: inbound ? stored?.received_number : undefined,
    providerNumbers: inbound ? providerReceivedCandidates : [],
  });
  const receivedNumber = inbound
    ? lineIdentity.phoneNumber ?? stored?.received_number ?? explicitProviderReceivedNumber
    : undefined;

  return {
    id: stored?.id ?? call.providerCallId ?? call.viptelUniqueId ?? `viptel-active-${index}`,
    providerCallId: call.providerCallId,
    viptelUniqueId: call.viptelUniqueId,
    fromQueueUniqueId: call.fromQueueUniqueId ?? stored?.from_queue_unique_id ?? undefined,
    status: providerCallPresentationStatus(call, stored),
    direction: call.direction,
    callerNumber: inbound
      ? stored?.caller_number ?? call.callerNumber ?? "Neznáme číslo"
      : call.callerNumber ?? stored?.caller_number ?? "Neznáme číslo",
    callerName: inbound
      ? stored?.caller_name ?? call.callerName ?? undefined
      : call.callerName ?? stored?.caller_name ?? undefined,
    calledNumber: call.calledNumber ?? stored?.called_number ?? call.queueNumber ?? "-",
    receivedNumber,
    destinationNumber,
    // Stored endpoints preserve history; the active provider leg owns current
    // call control and may change after a redirect. When VIPTel explicitly
    // identifies a current destination (including a queue or public DID), an
    // old stored agent extension must not be inherited by that provider row.
    callerExtension: call.callerExtension ?? stored?.caller_extension ?? undefined,
    receivedExtension: call.receivedExtension ?? stored?.received_extension ?? undefined,
    destinationExtension: call.destinationExtension ?? (
      providerHasCurrentDestination ? undefined : stored?.destination_extension ?? undefined
    ),
    extensionId: stored?.extension_id ?? undefined,
    operatorId: stored?.operator_id ?? undefined,
    lineId: lineIdentity.lineId,
    lineLabel: lineIdentity.lineLabel,
    queueLabel: call.queueLabel ?? call.queueNumber,
    operatorName: call.operatorName,
    caseId: stored?.case_id ?? undefined,
    // A queue agent leg can restart every time VIPTel offers the call to the
    // next workstation. Keep the waiting-room/fallback clock anchored to the
    // durable logical call instead of making sixty seconds start over.
    startedAt: inbound && stored?.from_queue_unique_id
      ? stored.created_at
      : call.startedAt ?? stored?.started_at ?? stored?.created_at ?? checkedAt,
    answeredAt: call.answeredAt ?? stored?.answered_at ?? undefined,
    endedAt: call.endedAt,
    waitSeconds: call.waitSeconds ?? 0,
    durationSeconds: call.durationSeconds,
    recordingStatus: "not_requested",
    transcriptStatus: "not_requested",
    history: ["Live VIPTel /api/call/statistics."],
  };
}

export function providerCallPresentationStatus(
  call: Pick<ViptelActiveCall, "direction" | "fromQueueUniqueId" | "status" | "viptelUniqueId">,
  stored: Pick<CallRow, "answered_at" | "ended_at" | "from_queue_unique_id" | "status"> | undefined,
): CallCenterCall["status"] {
  // A call.end listener event is stronger than a briefly stale REST parent.
  // This removes the short dead-call flash after the caller hangs up without
  // mistaking an ordinary queue.left handoff (which has no ended_at) for end.
  if (stored?.ended_at) {
    if (["missed", "abandoned_queue", "failed", "ended"].includes(stored.status)) return stored.status;
    return stored.answered_at ? "ended" : "missed";
  }
  const queueParentIsWaiting = call.direction === "inbound" &&
    call.status === "answered" &&
    !call.fromQueueUniqueId &&
    Boolean(call.viptelUniqueId && call.viptelUniqueId === stored?.from_queue_unique_id);
  return queueParentIsWaiting ? "incoming" : call.status;
}

async function loadStoredActiveCalls(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  organizationId: string,
  activeCalls: ViptelActiveCall[],
) {
  const uniqueIds = [...new Set(activeCalls
    .flatMap((call) => [call.viptelUniqueId, call.fromQueueUniqueId])
    .filter((value): value is string => Boolean(value)))];
  const providerIds = [...new Set(activeCalls.map((call) => call.providerCallId).filter((value): value is string => Boolean(value)))];
  const [callsResult, aliasesResult] = await Promise.all([
    supabase
      .from("motorist_calls")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("provider", "viptel")
      // `queue.left` can provisionally mark the logical call missed/abandoned
      // just before VIPTel exposes its next agent leg. Keep those recent rows
      // available for exact provider-id correlation so the next workstation
      // retains the stored UUID and caller identity during that handoff.
      .in("status", ["incoming", "ringing_agent", "answered", "outbound", "missed", "abandoned_queue"])
      .order("updated_at", { ascending: false })
      .limit(100),
    uniqueIds.length > 0
      ? supabase
          .from("motorist_call_events")
          .select("call_id, viptel_unique_id")
          .eq("organization_id", organizationId)
          .eq("provider", "viptel")
          .in("viptel_unique_id", uniqueIds)
          .not("call_id", "is", null)
          .order("received_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (callsResult.error) throw new Error(`Active call correlation failed: ${callsResult.error.message}`);
  if (aliasesResult.error) throw new Error(`Active call alias correlation failed: ${aliasesResult.error.message}`);

  const callsById = new Map((callsResult.data ?? []).map((call) => [call.id, call]));
  const result = new Map<string, CallRow>();
  for (const call of callsResult.data ?? []) {
    if (call.viptel_unique_id && uniqueIds.includes(call.viptel_unique_id)) result.set(call.viptel_unique_id, call);
    if (call.from_queue_unique_id && uniqueIds.includes(call.from_queue_unique_id)) result.set(call.from_queue_unique_id, call);
    if (call.provider_call_id && providerIds.includes(call.provider_call_id)) result.set(`provider:${call.provider_call_id}`, call);
  }
  for (const alias of aliasesResult.data ?? []) {
    const call = alias.call_id ? callsById.get(alias.call_id) : undefined;
    if (call && alias.viptel_unique_id && !result.has(alias.viptel_unique_id)) result.set(alias.viptel_unique_id, call);
  }
  return result;
}

function providerNumberCandidates(call: ViptelActiveCall, keys: string[]) {
  const values: string[] = [];

  for (const key of keys) {
    const value = call.raw[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    if (typeof value === "number" && Number.isFinite(value)) values.push(String(value));
  }

  return [...new Set(values)];
}
