import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import {
  correlateViptelCall,
  getViptelCorrelationCatalog,
  type ViptelCorrelationCatalog,
} from "./viptel-correlation";
import {
  buildViptelLineCatalog,
  findExactViptelLine,
  normalizeViptelPublicNumber,
} from "./viptel-line-catalog";

type AdminClient = SupabaseClient<Database>;
type CallRow = Database["public"]["Tables"]["motorist_calls"]["Row"];
type CallUpdate = Database["public"]["Tables"]["motorist_calls"]["Update"];
type CallStatus = CallRow["status"];
type CallDirection = CallRow["direction"];

const PROVIDER = "viptel";
const TERMINAL_STATUSES = new Set<CallStatus>(["ended", "missed", "abandoned_queue", "failed"]);

export type NormalizedViptelEvent = {
  eventType: string;
  uniqueId?: string;
  providerCallId?: string;
  direction: CallDirection;
  directionAuthoritative: boolean;
  status?: CallStatus;
  endReason?: string;
  callerNumber?: string;
  callerName?: string;
  calledNumber?: string;
  receivedNumber?: string;
  destinationNumber?: string;
  callerExtension?: string;
  receivedExtension?: string;
  destinationExtension?: string;
  queueNumber?: string;
  fromQueueUniqueId?: string;
  operatorName?: string;
  startedAt?: string;
  answeredAt?: string;
  endedAt?: string;
  providerTimestamp?: string;
  waitSeconds?: number;
  handled: boolean;
  normalizedPayload: Record<string, Json | undefined>;
};

export type ViptelCallSnapshot = {
  uniqueId?: string;
  providerCallId?: string;
  direction: CallDirection;
  directionAuthoritative?: boolean;
  status: CallStatus;
  type?: string;
  application?: string;
  endReason?: string;
  callerNumber?: string;
  callerName?: string;
  calledNumber?: string;
  receivedNumber?: string;
  destinationNumber?: string;
  callerExtension?: string;
  receivedExtension?: string;
  destinationExtension?: string;
  queueNumber?: string;
  fromQueueUniqueId?: string;
  startedAt?: string;
  answeredAt?: string;
  endedAt?: string;
  waitSeconds?: number;
  ringSeconds?: number;
  durationSeconds?: number;
  completeDurationSeconds?: number;
  recordingFile?: string;
  authoritativeTerminal?: boolean;
  raw: Record<string, unknown>;
};

export async function persistViptelEvent(
  client: AdminClient,
  organizationId: string,
  payload: unknown,
  receivedAt = new Date().toISOString(),
  correlationCatalog?: ViptelCorrelationCatalog,
) {
  const raw = asRecord(payload);
  const rawJson = toJson(payload);
  const event = normalizeViptelEvent(payload, receivedAt);
  const fingerprint = viptelEventFingerprint(event, payload);
  const inserted = await client.from("motorist_call_events").insert({
    organization_id: organizationId,
    call_id: null,
    provider: PROVIDER,
    viptel_unique_id: event.uniqueId ?? null,
    event_type: event.eventType,
    event_fingerprint: fingerprint,
    payload: compactJson(event.normalizedPayload),
    raw_payload: rawJson,
    normalized_payload: compactJson(event.normalizedPayload),
    handled_status: "unknown",
    provider_created_at: event.providerTimestamp ?? null,
    provider_timestamp: event.providerTimestamp ?? null,
    received_at: receivedAt,
  }).select("id, call_id").maybeSingle();

  let duplicate = false;
  let eventRow = inserted.data;
  if (inserted.error) {
    if (!isUniqueViolation(inserted.error)) {
      throw new Error(inserted.error.message);
    }
    duplicate = true;
    const existingEvent = await client
      .from("motorist_call_events")
      .select("id, call_id")
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("event_fingerprint", fingerprint)
      .maybeSingle();
    throwOnError(existingEvent.error);
    eventRow = existingEvent.data;
  }

  try {
    const call = event.uniqueId || event.providerCallId
      ? await upsertViptelCall(
          client,
          organizationId,
          {
            uniqueId: event.uniqueId,
            providerCallId: event.providerCallId,
            direction: event.direction,
            directionAuthoritative: event.directionAuthoritative,
            status: event.status ?? (event.direction === "outbound" ? "outbound" : "incoming"),
            endReason: event.endReason,
            callerNumber: event.callerNumber,
            callerName: event.callerName,
            calledNumber: event.calledNumber,
            receivedNumber: event.receivedNumber,
            destinationNumber: event.destinationNumber,
            callerExtension: event.callerExtension,
            receivedExtension: event.receivedExtension,
            destinationExtension: event.destinationExtension,
            queueNumber: event.queueNumber,
            fromQueueUniqueId: event.fromQueueUniqueId,
            startedAt: event.startedAt,
            answeredAt: event.answeredAt,
            endedAt: event.endedAt,
            waitSeconds: event.waitSeconds,
            // A call.end closes that exact VIPTel leg. Treat it as stronger
            // than a concurrent CDR/active snapshot so we can never persist
            // status=answered together with an end timestamp.
            authoritativeTerminal: event.eventType === "call.end",
            raw,
          },
          correlationCatalog,
        )
      : null;

    if (eventRow) {
      const linked = await client
        .from("motorist_call_events")
        .update({
          call_id: call?.id ?? eventRow.call_id,
          handled_status: event.handled ? "processed" : "unknown",
        })
        .eq("id", eventRow.id);
      throwOnError(linked.error);
    }

    return {
      eventType: event.eventType,
      fingerprint,
      duplicate,
      handled: event.handled,
      callId: call?.id ?? eventRow?.call_id ?? null,
    };
  } catch (error) {
    if (eventRow) {
      await client.from("motorist_call_events").update({ handled_status: "failed" }).eq("id", eventRow.id);
    }
    throw error;
  }
}

export async function upsertViptelCall(
  client: AdminClient,
  organizationId: string,
  snapshot: ViptelCallSnapshot,
  correlationCatalog?: ViptelCorrelationCatalog,
): Promise<Pick<CallRow, "id" | "status">> {
  const existing = await findCall(client, organizationId, snapshot);
  // Queue and transfer legs share one logical call row. A delayed terminal
  // event for an older leg must remain in the append-only event trail, but it
  // must not close the newer leg that currently owns the logical call.
  if (existing && terminalSnapshotIsForSupersededLeg(existing, snapshot)) return existing;
  if (existing && isQueueChannelRedirectLeg(existing, snapshot)) return existing;
  const catalog = correlationCatalog ?? await getViptelCorrelationCatalog(client, organizationId);
  const relations = correlateViptelCall(snapshot, catalog);
  const observedDirection =
    snapshot.directionAuthoritative === false
      ? relations.direction ?? existing?.direction ?? snapshot.direction
      : snapshot.direction;
  const direction = preserveExistingInboundOrigin(existing, observedDirection, catalog);
  const lineIdentity = mergeViptelCallLineIdentity({
    catalog,
    correlatedLineId: relations.lineId,
    direction,
    existing,
    snapshot,
  });
  const callerIdentity = mergeViptelCallerIdentity({
    catalog,
    direction,
    existing,
    snapshot,
  });
  const reopensQueueLifecycle = newerInboundQueueOffer(existing, snapshot);
  const status = nextCallStatus(
    existing?.status,
    snapshot.status,
    snapshot.authoritativeTerminal,
    reopensQueueLifecycle,
  );
  const canonicalUniqueId = mergedUniqueId(existing, snapshot);
  const update = compactRecord({
    provider_call_id: snapshot.providerCallId,
    viptel_unique_id: canonicalUniqueId,
    direction,
    status,
    type: snapshot.type,
    application: snapshot.application,
    end_reason: reopensQueueLifecycle ? null : snapshot.endReason,
    caller_number: callerIdentity.callerNumber,
    caller_name: callerIdentity.callerName,
    called_number: snapshot.calledNumber,
    received_number: lineIdentity.receivedNumber,
    destination_number: snapshot.destinationNumber,
    caller_extension: relations.callerExtension ?? snapshot.callerExtension,
    received_extension: relations.receivedExtension ?? snapshot.receivedExtension,
    destination_extension: relations.destinationExtension ?? snapshot.destinationExtension,
    line_id: lineIdentity.lineId,
    queue_id: relations.queueId,
    extension_id: relations.extensionId,
    operator_id: relations.operatorId,
    queue_number: relations.queueNumber ?? snapshot.queueNumber,
    from_queue_unique_id: mergedQueueUniqueId(existing, snapshot),
    // One logical queue call receives a new agent leg on every handoff. Do
    // not restart its business clock; the latest leg remains in raw payloads.
    started_at: existing?.started_at ?? snapshot.startedAt,
    answered_at: snapshot.answeredAt,
    ended_at: reopensQueueLifecycle ? null : snapshot.endedAt,
    wait_seconds: snapshot.waitSeconds,
    ring_seconds: snapshot.ringSeconds,
    duration_seconds: reopensQueueLifecycle ? null : snapshot.durationSeconds,
    complete_duration_seconds: reopensQueueLifecycle ? null : snapshot.completeDurationSeconds,
    recording_file: snapshot.recordingFile,
    raw_latest_payload: snapshot.raw as Json,
  }) as CallUpdate;

  if (existing) {
    const result = await client
      .from("motorist_calls")
      .update(update)
      .eq("id", existing.id)
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .select("id, status")
      .single();
    throwOnError(result.error);
    if (!result.data) throw new Error("VIPTel call update returned no row.");
    return result.data;
  }

  const inserted = await client
    .from("motorist_calls")
    .insert({
      organization_id: organizationId,
      provider: PROVIDER,
      direction,
      status,
      provider_call_id: snapshot.providerCallId ?? null,
      viptel_unique_id: canonicalUniqueId ?? null,
      type: snapshot.type ?? null,
      application: snapshot.application ?? null,
      end_reason: snapshot.endReason ?? null,
      caller_number: snapshot.callerNumber ?? null,
      caller_name: snapshot.callerName ?? null,
      called_number: snapshot.calledNumber ?? null,
      received_number: lineIdentity.receivedNumber ?? null,
      destination_number: snapshot.destinationNumber ?? null,
      caller_extension: relations.callerExtension ?? snapshot.callerExtension ?? null,
      received_extension: relations.receivedExtension ?? snapshot.receivedExtension ?? null,
      destination_extension: relations.destinationExtension ?? snapshot.destinationExtension ?? null,
      line_id: lineIdentity.lineId ?? null,
      queue_id: relations.queueId ?? null,
      extension_id: relations.extensionId ?? null,
      operator_id: relations.operatorId ?? null,
      queue_number: relations.queueNumber ?? snapshot.queueNumber ?? null,
      from_queue_unique_id: snapshot.fromQueueUniqueId ?? null,
      started_at: snapshot.startedAt ?? null,
      answered_at: snapshot.answeredAt ?? null,
      ended_at: snapshot.endedAt ?? null,
      wait_seconds: snapshot.waitSeconds ?? null,
      ring_seconds: snapshot.ringSeconds ?? null,
      duration_seconds: snapshot.durationSeconds ?? null,
      complete_duration_seconds: snapshot.completeDurationSeconds ?? null,
      recording_file: snapshot.recordingFile ?? null,
      raw_payload: snapshot.raw as Json,
      raw_latest_payload: snapshot.raw as Json,
    })
    .select("id, status")
    .single();

  if (inserted.error && isUniqueViolation(inserted.error)) {
    const raced = await findCall(client, organizationId, snapshot);
    if (raced) return raced;
  }
  throwOnError(inserted.error);
  if (!inserted.data) throw new Error("VIPTel call insert returned no row.");
  return inserted.data;
}

export function normalizeViptelEvent(payload: unknown, receivedAt = new Date().toISOString()): NormalizedViptelEvent {
  const root = asRecord(payload);
  const nested = asRecord(root.data ?? root.payload ?? root.event_data);
  const data = Object.keys(nested).length ? nested : root;
  const eventType = readString(root, ["event", "event_type", "type", "action"])?.toLowerCase() ?? "unknown";
  const uniqueId = readString(data, ["unique_id", "uniqueid", "viptel_unique_id"]);
  const providerCallId = eventType.startsWith("call.")
    ? readString(data, ["call_random_id", "call_id", "id", "linked_id", "linkedid"])
    : undefined;
  const directionValue = readString(data, ["direction", "call_direction", "type"]);
  const direction = normalizeDirection(directionValue, eventType);
  const directionAuthoritative =
    Boolean(directionValue) ||
    eventType === "call.create_response" ||
    eventType === "queue.join" ||
    eventType === "queue.left";
  const providerTimestamp = readDate(data, ["timestamp", "created_at", "event_time", "time"]);
  const callerNumber = readString(data, ["caller", "caller_number", "src", "source", "from"]);
  const receivedNumber = readString(data, ["called_number", "received", "received_number"]);
  const destinationNumber = readString(data, ["callee", "destination", "destination_number", "dst", "to"]);
  const calledNumber = receivedNumber ?? readString(data, ["called"]) ?? destinationNumber;
  const queueNumber = readString(data, ["queue", "queue_number", "queue_id", "from_queue"]);
  const endReason = eventType === "call.end" ? readString(data, ["status", "reason", "disposition"]) : undefined;
  const status = eventStatus(eventType, endReason, direction);
  const eventAt = providerTimestamp ?? receivedAt;
  const waitSeconds = readNumber(data, ["holdtime", "hold_time", "wait_seconds", "wait_time"]);

  return {
    eventType,
    uniqueId,
    providerCallId,
    direction,
    directionAuthoritative,
    status,
    endReason,
    callerNumber,
    callerName: readString(data, ["caller_name", "callername"]),
    calledNumber,
    receivedNumber,
    destinationNumber,
    callerExtension: readString(data, ["caller_extension"]),
    receivedExtension: readString(data, ["received_extension"]),
    destinationExtension: readString(data, ["destination_extension", "callee"]),
    queueNumber,
    fromQueueUniqueId: readString(data, ["from_queue_unique_id"]),
    operatorName: readString(data, ["member_name", "operator_name", "agent_name"]),
    startedAt: eventType === "call.begin" || eventType === "queue.join" ? eventAt : undefined,
    answeredAt: eventType === "call.pickup" ? eventAt : undefined,
    endedAt: eventType === "call.end" ? eventAt : undefined,
    providerTimestamp,
    waitSeconds,
    handled: isHandledEvent(eventType),
    normalizedPayload: {
      event_type: eventType,
      unique_id: uniqueId,
      provider_call_id: providerCallId,
      direction,
      direction_authoritative: directionAuthoritative,
      status,
      end_reason: endReason,
      caller_number: callerNumber,
      caller_name: readString(data, ["caller_name", "callername"]),
      called_number: calledNumber,
      received_number: receivedNumber,
      destination_number: destinationNumber,
      queue_number: queueNumber,
      from_queue_unique_id: readString(data, ["from_queue_unique_id"]),
      wait_seconds: waitSeconds,
      operator_name: readString(data, ["member_name", "operator_name", "agent_name"]),
      provider_timestamp: providerTimestamp,
    },
  };
}

export function viptelEventFingerprint(event: NormalizedViptelEvent, payload: unknown) {
  const rawHash = createHash("sha256").update(stableJson(payload)).digest("hex");
  return createHash("sha256")
    .update([PROVIDER, event.eventType, event.uniqueId ?? "", event.providerTimestamp ?? "", rawHash].join("\n"))
    .digest("hex");
}

export function nextCallStatus(
  current: CallStatus | undefined,
  incoming: CallStatus,
  authoritativeTerminal = false,
  reopensQueueLifecycle = false,
): CallStatus {
  if (!current || current === incoming) return incoming;
  if (authoritativeTerminal && TERMINAL_STATUSES.has(incoming)) return incoming;
  if (
    reopensQueueLifecycle &&
    (current === "abandoned_queue" || current === "missed") &&
    (incoming === "incoming" || incoming === "ringing_agent" || incoming === "answered")
  ) {
    return incoming;
  }
  if (TERMINAL_STATUSES.has(current)) return current;
  if (current === "answered" && ["incoming", "ringing_agent", "outbound", "abandoned_queue", "missed"].includes(incoming)) {
    return current;
  }
  return incoming;
}

export function terminalSnapshotIsForSupersededLeg(
  existing: Pick<CallMatch, "from_queue_unique_id" | "viptel_unique_id"> | null,
  snapshot: Pick<ViptelCallSnapshot, "authoritativeTerminal" | "uniqueId">,
) {
  if (!snapshot.authoritativeTerminal || !existing?.viptel_unique_id || !snapshot.uniqueId) return false;
  // The caller's own queue channel ending is the whole journey ending, no
  // matter how many agent legs came and went in between. When a waiting call
  // is picked up or transferred, the channel itself dials the workstation, so
  // the row's identity stays on the last dead agent leg while the live
  // conversation runs on the channel -- and its call.end then looked like a
  // stale superseded-leg event. Every call answered that way stayed open
  // forever, which is what later refused outbound calls with "Na osobnej
  // klapke uz prebieha aktivny hovor".
  if (existing.from_queue_unique_id && snapshot.uniqueId === existing.from_queue_unique_id) return false;
  return existing.viptel_unique_id !== snapshot.uniqueId;
}

type CallMatch = Pick<
  CallRow,
  "caller_name" | "caller_number" | "direction" | "ended_at" | "from_queue_unique_id" | "id" | "line_id" | "received_number" | "started_at" | "status" | "viptel_unique_id"
>;

/**
 * The queue channel itself beginning a new leg is the caller being redirected
 * out of the rotation -- by the fallback timer or an operator's transfer.
 * VIPTel reuses the channel's unique_id and the leg carries no from_queue of
 * its own; its "caller" is the CID the PBX presents to the redirect target
 * (one of our own numbers) and its "destination" is the fallback or transfer
 * number. Merging that identity into the logical call replaced the real
 * caller with the presented CID (observed live on 2026-09-02: the caller
 * became "0412289133" dialling "090909090") and reopened the row as a fresh
 * waiting caller in every dispatcher's queue panel. Such an event must leave
 * the row exactly as it is; the channel's own call.pickup and call.end still
 * update the journey.
 */
export function isQueueChannelRedirectLeg(
  existing: Pick<CallMatch, "from_queue_unique_id" | "viptel_unique_id">,
  snapshot: Pick<ViptelCallSnapshot, "fromQueueUniqueId" | "status" | "uniqueId">,
) {
  return (
    snapshot.status === "incoming" &&
    !snapshot.fromQueueUniqueId &&
    Boolean(snapshot.uniqueId) &&
    existing.from_queue_unique_id === snapshot.uniqueId &&
    existing.viptel_unique_id !== snapshot.uniqueId
  );
}

/**
 * `queue.left` closes one queue attempt, not necessarily the caller's whole
 * journey. VIPTel can immediately offer the same queue parent to the next
 * workstation with a new agent-leg id. Reopen only that exact lifecycle and
 * only for an observation newer than the previous leg's end, so a delayed old
 * event cannot revive a call already closed by CDR reconciliation.
 */
export function newerInboundQueueOffer(
  existing: Pick<CallMatch, "direction" | "ended_at" | "from_queue_unique_id" | "status" | "viptel_unique_id"> | null,
  snapshot: Pick<ViptelCallSnapshot, "answeredAt" | "direction" | "fromQueueUniqueId" | "startedAt" | "status" | "uniqueId">,
) {
  if (
    !existing ||
    existing.direction !== "inbound" ||
    snapshot.direction !== "inbound" ||
    (existing.status !== "abandoned_queue" && existing.status !== "missed") ||
    !["incoming", "ringing_agent", "answered"].includes(snapshot.status)
  ) {
    return false;
  }

  const queueParent = existing.from_queue_unique_id?.trim();
  const observedParent = snapshot.fromQueueUniqueId?.trim() || (
    queueParent && snapshot.uniqueId?.trim() === queueParent ? queueParent : undefined
  );
  if (!queueParent || observedParent !== queueParent) return false;

  const observedAt = Date.parse(snapshot.startedAt ?? snapshot.answeredAt ?? "");
  if (!Number.isFinite(observedAt)) return false;
  if (!existing.ended_at) return true;
  const previousEndedAt = Date.parse(existing.ended_at);
  return Number.isFinite(previousEndedAt) && observedAt > previousEndedAt;
}

export function mergeViptelCallerIdentity({
  catalog,
  direction,
  existing,
  snapshot,
}: {
  catalog: ViptelCorrelationCatalog;
  direction: CallDirection;
  existing: Pick<CallMatch, "caller_name" | "caller_number"> | null;
  snapshot: Pick<ViptelCallSnapshot, "callerName" | "callerNumber">;
}) {
  const existingNumber = existing?.caller_number?.trim() || undefined;
  const existingName = existing?.caller_name?.trim() || undefined;
  const observedNumber = snapshot.callerNumber?.trim() || undefined;
  if (direction !== "inbound" || !existingNumber) {
    return {
      callerNumber: observedNumber,
      callerName: snapshot.callerName?.trim() || undefined,
    };
  }

  const internalExtensions = new Set(catalog.extensions.map((extension) => extension.extension.trim()));
  const existingIsExternal = !internalExtensions.has(existingNumber);
  const observedIsInternal = Boolean(observedNumber && internalExtensions.has(observedNumber));
  if (existingIsExternal && (!observedNumber || observedIsInternal)) {
    // Queue-parent events carry the customer identity. A later agent leg can
    // report the internal workstation as caller; that routing detail must not
    // replace the customer shown in the UI or durable history.
    return {
      callerNumber: existingNumber,
      callerName: existingName,
    };
  }

  return {
    callerNumber: observedNumber ?? existingNumber,
    callerName: snapshot.callerName?.trim() || existingName,
  };
}

export function mergeViptelCallLineIdentity({
  catalog,
  correlatedLineId,
  direction,
  existing,
  snapshot,
}: {
  catalog: ViptelCorrelationCatalog;
  correlatedLineId?: string;
  direction: CallDirection;
  existing: Pick<CallMatch, "line_id" | "received_number"> | null;
  snapshot: Pick<ViptelCallSnapshot, "calledNumber" | "destinationNumber" | "receivedNumber">;
}) {
  const lineCatalog = buildViptelLineCatalog(catalog.lines);

  // Public DID identity is meaningful only for inbound calls. Older versions
  // could persist an outbound destination as line_id/received_number; return
  // explicit nulls so the next authoritative outbound/internal event clears
  // that legacy misclassification instead of preserving it forever.
  if (direction !== "inbound") {
    return { receivedNumber: null, lineId: null };
  }

  const existingExactNumber = firstExactNumber(lineCatalog, [existing?.received_number]);

  // A stored relation is authoritative. In particular, an agent/queue leg may
  // expose another called number and must not replace the original public DID.
  if (existing?.line_id || existingExactNumber) {
    return {
      receivedNumber: existingExactNumber?.value ?? existing?.received_number ?? undefined,
      lineId: existing?.line_id ?? existingExactNumber?.line.id,
    };
  }

  const incomingExactNumber = firstExactNumber(lineCatalog, [snapshot.receivedNumber, snapshot.calledNumber]);

  if (incomingExactNumber) {
    return {
      receivedNumber: incomingExactNumber.value,
      lineId: incomingExactNumber.line.id ?? correlatedLineId,
    };
  }

  return {
    receivedNumber: existing?.received_number ?? snapshot.receivedNumber,
    lineId: existing?.line_id ?? correlatedLineId,
  };
}

export function preserveExistingInboundOrigin(
  existing: Pick<CallMatch, "direction" | "line_id" | "received_number"> | null,
  observedDirection: CallDirection,
  catalog: ViptelCorrelationCatalog,
): CallDirection {
  if (!existing || existing.direction !== "inbound" || observedDirection === "inbound") {
    return observedDirection;
  }

  const lineCatalog = buildViptelLineCatalog(catalog.lines);
  const hasConfiguredLine = Boolean(
    existing.line_id && lineCatalog.some((line) => line.configured && line.id === existing.line_id),
  );
  const hasPublicReceivedNumber = Boolean(normalizeViptelPublicNumber(existing.received_number));

  // A later internal/outbound provider leg may still belong to the same
  // correlated inbound call. Preserve its business origin only when the
  // existing row already carries public inbound evidence; otherwise allow a
  // later authoritative event to correct an early, non-authoritative guess.
  return hasConfiguredLine || hasPublicReceivedNumber ? "inbound" : observedDirection;
}

function firstExactNumber(
  catalog: ReturnType<typeof buildViptelLineCatalog>,
  values: ReadonlyArray<string | null | undefined>,
) {
  for (const value of values) {
    const line = findExactViptelLine(catalog, value);
    if (line && value) return { line, value };
  }

  return undefined;
}

async function findCall(
  client: AdminClient,
  organizationId: string,
  snapshot: Pick<ViptelCallSnapshot, "fromQueueUniqueId" | "providerCallId" | "uniqueId">,
): Promise<CallMatch | null> {
  const identityCandidates = [...new Set([snapshot.uniqueId, snapshot.fromQueueUniqueId].filter((value): value is string => Boolean(value)))];

  for (const identity of identityCandidates) {
    const direct = await findCallByColumn(client, organizationId, "viptel_unique_id", identity);
    if (direct) return direct;

    const queueParent = await findCallByColumn(client, organizationId, "from_queue_unique_id", identity);
    if (queueParent) return queueParent;
  }

  // motorist_call_events already forms an append-only alias trail for every
  // provider unique_id. It lets a queue parent and multiple agent legs resolve
  // to one logical call without adding a provider-ID alias table prematurely.
  for (const identity of identityCandidates) {
    const eventResult = await client
      .from("motorist_call_events")
      .select("call_id")
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("viptel_unique_id", identity)
      .not("call_id", "is", null)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    throwOnError(eventResult.error);

    if (eventResult.data?.call_id) {
      const callResult = await client
        .from("motorist_calls")
        .select("id, status, direction, viptel_unique_id, from_queue_unique_id, received_number, line_id, caller_number, caller_name, started_at, ended_at")
        .eq("id", eventResult.data.call_id)
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .maybeSingle();
      throwOnError(callResult.error);
      if (callResult.data) return callResult.data;
    }
  }

  if (snapshot.providerCallId) {
    const result = await client
      .from("motorist_calls")
      .select("id, status, direction, viptel_unique_id, from_queue_unique_id, received_number, line_id, caller_number, caller_name, started_at, ended_at")
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("provider_call_id", snapshot.providerCallId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    throwOnError(result.error);
    return result.data;
  }

  return null;
}

async function findCallByColumn(
  client: AdminClient,
  organizationId: string,
  column: "from_queue_unique_id" | "viptel_unique_id",
  value: string,
) {
  const result = await client
    .from("motorist_calls")
    .select("id, status, direction, viptel_unique_id, from_queue_unique_id, received_number, line_id, caller_number, caller_name, started_at, ended_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq(column, value)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwOnError(result.error);
  return result.data;
}

function mergedUniqueId(existing: CallMatch | null, snapshot: ViptelCallSnapshot) {
  if (!snapshot.uniqueId) return existing?.viptel_unique_id ?? undefined;
  if (existing?.from_queue_unique_id === snapshot.uniqueId && existing.viptel_unique_id) {
    return existing.viptel_unique_id;
  }
  if (
    snapshot.fromQueueUniqueId &&
    snapshot.uniqueId === snapshot.fromQueueUniqueId &&
    existing?.viptel_unique_id &&
    existing.viptel_unique_id !== snapshot.uniqueId
  ) {
    return existing.viptel_unique_id;
  }
  return snapshot.uniqueId;
}

function mergedQueueUniqueId(existing: CallMatch | null, snapshot: ViptelCallSnapshot) {
  return (
    snapshot.fromQueueUniqueId ??
    existing?.from_queue_unique_id ??
    (existing?.viptel_unique_id && existing.viptel_unique_id !== snapshot.uniqueId ? existing.viptel_unique_id : undefined)
  );
}

function eventStatus(eventType: string, reason: string | undefined, direction: CallDirection): CallStatus | undefined {
  if (eventType === "call.begin") return direction === "outbound" ? "outbound" : "incoming";
  if (eventType === "call.pickup") return "answered";
  if (eventType === "call.create_response") return "outbound";
  if (eventType === "queue.join") return "ringing_agent";
  // VIPTel documents queue.left as a call removed from a queue without being
  // answered by an agent (for example an abandoned, missed, or redirected call).
  // CDR reconciliation remains authoritative and can replace this provisional state.
  if (eventType === "queue.left") return "abandoned_queue";
  if (eventType !== "call.end") return undefined;

  const normalized = reason?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  if (["answer", "answered", "complete", "completed", "normalclearing"].includes(normalized)) return "ended";
  if (["busy", "noanswer", "cancel"].includes(normalized)) return direction === "outbound" ? "failed" : "missed";
  return "failed";
}

function normalizeDirection(value: string | undefined, eventType: string): CallDirection {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("out") || eventType === "call.create_response") return "outbound";
  if (normalized.includes("internal")) return "internal";
  return "inbound";
}

function isHandledEvent(eventType: string) {
  return [
    "call.begin",
    "call.end",
    "call.pickup",
    "call.create_response",
    "queue.add",
    "queue.remove",
    "queue.pause",
    "queue.unpause",
    "queue.join",
    "queue.left",
  ].includes(eventType);
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readDate(record: Record<string, unknown>, keys: string[]) {
  const value = readString(record, keys);
  if (!value) return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  return undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compactJson(value: Record<string, Json | undefined>) {
  return compactRecord(value) as Json;
}

function compactRecord<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toJson(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, toJson(item)]),
    );
  }
  return String(value);
}

function isUniqueViolation(error: { code?: string; message: string }) {
  return error.code === "23505" || /duplicate key|unique constraint/i.test(error.message);
}

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}
