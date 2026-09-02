import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ViptelActiveCall,
  ViptelClient,
  ViptelExtension,
  ViptelQueue,
  ViptelQueueStatus,
} from "@/lib/integrations/viptel/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";
import { configuredPersonalExtensions } from "./personal-extension-config";

type AdminClient = SupabaseClient<Database>;
type SnapshotCommandRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_commands"]["Row"],
  "confirmed_at" | "created_at" | "id" | "provider_response" | "request_payload" | "sent_at" | "status"
>;
type SnapshotRequestCommandRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_commands"]["Row"],
  "command_type" | "id" | "idempotency_key" | "organization_id" | "provider" | "request_payload" | "requested_by"
>;

export const VIPTEL_PROVIDER_SNAPSHOT_COMMAND = "provider.snapshot";
export const VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION = 1;
export const VIPTEL_PROVIDER_SNAPSHOT_QUEUES = ["601", "602", "603"] as const;
export const VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY = "requestHmac";

const PROVIDER = "viptel";
const ENABLED_VALUE = "true";
const MIN_AUTHORITY_TOKEN_LENGTH = 32;
const DEFAULT_WAIT_MS = 8_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 12_000;
const DEFAULT_MAX_AGE_MS = 4_000;
const MAX_ALLOWED_AGE_MS = 30_000;
// Listener releases before d8dfd2e stamped capturedAt when they claimed the
// command, before the parallel VIPTel REST reads.  Keep that exact, detectable
// wire shape compatible during the listener-only rollout: the provider read
// itself must still finish within the requester's bounded wait, and the
// confirmed result must be no older than the caller's requested max age.
const LEGACY_PRE_READ_CAPTURE_MAX_DURATION_MS = DEFAULT_WAIT_MS;
const POLL_INTERVAL_MS = 150;
const REQUEST_DEADLINE_MS = 15_000;
const CLOCK_SKEW_MS = 5_000;
const MAX_WIRE_BYTES = 256 * 1024;
const MAX_EXTENSIONS = 32;
const MAX_ACTIVE_CALLS = 100;
const MAX_QUEUE_MEMBERS = 100;
const MAX_ALLOWED_CHANGES = 24;
const MAX_TEXT = 256;

const LIVE_CALL_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
const LIVE_CALL_STATUSES = [
  "incoming",
  "ringing_agent",
  "answered",
  "missed",
  "abandoned_queue",
  "outbound",
  "ended",
  "failed",
] as const;

export type ViptelProviderSnapshotBridgeGateStatus = {
  enabled: boolean;
  reason: "enabled" | "preview_blocked" | "flag_disabled" | "authority_missing";
};

export type ViptelProviderSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  personalExtensions: string[];
  extensions: ViptelExtension[];
  activeCalls: ViptelActiveCall[];
  queues: ViptelQueue[];
  queueStatuses: ViptelQueueStatus[];
};

type WireExtension = Omit<ViptelExtension, "raw">;
type WireActiveCall = Omit<ViptelActiveCall, "raw">;

export type ViptelProviderSnapshotWire = {
  schemaVersion: 1;
  capturedAt: string;
  personalExtensions: string[];
  extensions: WireExtension[];
  activeCalls: WireActiveCall[];
  queues: ViptelQueue[];
  queueStatuses: ViptelQueueStatus[];
};

type SnapshotProvider = Pick<ViptelClient, "getQueueStatus" | "listActiveCalls" | "listExtensions">;

type SnapshotRequestDependencies = {
  client?: AdminClient;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  waitMs?: number;
  maxAgeMs?: number;
  requireNewCapture?: boolean;
  randomId?: () => string;
  env?: Readonly<Record<string, string | undefined>>;
};

type StoredSnapshotReadDependencies = Pick<
  SnapshotRequestDependencies,
  "client" | "env" | "maxAgeMs" | "now"
>;

export function viptelProviderSnapshotBridgeGateStatus(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ViptelProviderSnapshotBridgeGateStatus {
  if (env.VERCEL_ENV?.trim().toLowerCase() === "preview") {
    return { enabled: false, reason: "preview_blocked" };
  }
  if (env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED?.trim().toLowerCase() !== ENABLED_VALUE) {
    return { enabled: false, reason: "flag_disabled" };
  }
  if ((env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN?.trim().length ?? 0) < MIN_AUTHORITY_TOKEN_LENGTH) {
    return { enabled: false, reason: "authority_missing" };
  }
  return { enabled: true, reason: "enabled" };
}

export function assertViptelProviderSnapshotBridgeEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const status = viptelProviderSnapshotBridgeGateStatus(env);
  if (status.enabled) return;
  const detail = status.reason === "preview_blocked"
    ? "Preview používa produkčné dáta a živé VIPTel snapshoty sú v ňom zakázané."
    : "Serverový VIPTel snapshot bridge nie je pre toto prostredie výslovne povolený.";
  throw new MutationError(detail, 503);
}

export async function captureViptelProviderSnapshot(
  provider: SnapshotProvider,
  clock: () => Date = () => new Date(),
): Promise<ViptelProviderSnapshotWire> {
  assertViptelProviderSnapshotBridgeEnabled();
  const personalExtensions = configuredPersonalExtensions();
  if (personalExtensions.length === 0 || personalExtensions.length > MAX_EXTENSIONS) {
    throw new Error("VIPTel personal-extension allowlist is outside snapshot bounds.");
  }
  const [extensions, activeCalls, queueStatuses] = await Promise.all([
    provider.listExtensions(),
    provider.listActiveCalls(),
    Promise.all(VIPTEL_PROVIDER_SNAPSHOT_QUEUES.map((queue) => provider.getQueueStatus(queue))),
  ]);
  // The snapshot describes the completed provider read, not the moment the
  // listener started waiting for VIPTel. Stamping before the REST calls made
  // their transport latency consume the caller's entire freshness window.
  const capturedAt = clock();
  if (!(capturedAt instanceof Date) || !Number.isFinite(capturedAt.getTime())) {
    throw new Error("VIPTel snapshot capture clock is invalid.");
  }
  const wire = normalizeProviderSnapshotWire({
    schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: capturedAt.toISOString(),
    personalExtensions,
    extensions,
    activeCalls,
    queues: VIPTEL_PROVIDER_SNAPSHOT_QUEUES.map((queue) => ({ id: queue, name: `Rad ${queue}` })),
    queueStatuses,
  });
  assertWireSize(wire);
  return wire;
}

/**
 * Reads the latest listener-confirmed snapshot without creating or waiting for
 * a provider command. Disabled environments deliberately return no snapshot so
 * callers can retain their stored-data fallback without bypassing Preview
 * isolation. A present row is always authenticated and time-bounded before it
 * is returned.
 */
export async function readLatestConfirmedViptelProviderSnapshot(
  organizationId: string,
  dependencies: StoredSnapshotReadDependencies = {},
): Promise<ViptelProviderSnapshot | null> {
  assertUuid(organizationId, "Organizácia");
  if (!viptelProviderSnapshotBridgeGateStatus(dependencies.env).enabled) return null;

  const client = dependencies.client ?? createSupabaseAdminClient();
  const now = dependencies.now ?? (() => new Date());
  const maxAgeMs = boundedInteger(
    dependencies.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    0,
    MAX_ALLOWED_AGE_MS,
    "Maximálny vek uloženého VIPTel snapshotu",
  );
  const cached = await loadLatestConfirmedSnapshot(client, organizationId);
  if (!cached) return null;

  const snapshot = parseConfirmedSnapshot(cached, organizationId, dependencies.env);
  return snapshotIsFresh(snapshot, now(), maxAgeMs) ? snapshot : null;
}

export async function requestViptelProviderSnapshot(
  organizationId: string,
  requestedBy: string,
  dependencies: SnapshotRequestDependencies = {},
): Promise<ViptelProviderSnapshot> {
  assertUuid(organizationId, "Organizácia");
  assertUuid(requestedBy, "Žiadateľ snapshotu");
  assertViptelProviderSnapshotBridgeEnabled(dependencies.env);
  const client = dependencies.client ?? createSupabaseAdminClient();
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const waitMs = boundedInteger(
    dependencies.waitMs ?? envInteger(dependencies.env ?? process.env, "VIPTEL_PROVIDER_SNAPSHOT_WAIT_MS", DEFAULT_WAIT_MS),
    MIN_WAIT_MS,
    MAX_WAIT_MS,
    "Čas čakania na VIPTel snapshot",
  );
  const maxAgeMs = boundedInteger(
    dependencies.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    0,
    MAX_ALLOWED_AGE_MS,
    "Maximálny vek VIPTel snapshotu",
  );
  const startedAt = now();
  const requireNewCapture = dependencies.requireNewCapture === true;

  if (!requireNewCapture) {
    const cached = await loadLatestConfirmedSnapshot(client, organizationId);
    if (cached) {
      const snapshot = parseConfirmedSnapshot(cached, organizationId, dependencies.env);
      if (snapshotIsFresh(snapshot, startedAt, maxAgeMs)) return snapshot;
    }
  }

  const pending = await loadPendingSnapshotCommand(
    client,
    organizationId,
    requireNewCapture ? "newest" : "oldest",
  );
  // A listener snapshot is organization-wide, signed and immutable. Sharing
  // its exact command avoids racing page polling against a workplace action;
  // requireNewCapture still accepts it only when captured in this request's
  // bounded time window below.
  const command = pending ?? await insertSnapshotCommand(
    client,
    organizationId,
    requestedBy,
    startedAt,
    dependencies.randomId ?? randomUUID,
    {
      env: dependencies.env,
    },
  );

  while (now().getTime() - startedAt.getTime() <= waitMs) {
    const current = await loadSnapshotCommand(client, organizationId, command.id);
    if (!current) throw new MutationError("Auditná požiadavka VIPTel snapshotu sa stratila.", 502);
    if (current.id !== command.id) {
      throw new MutationError("VIPTel snapshot odpovedal na inú požiadavku.", 502);
    }
    if (current.status === "confirmed_by_event") {
      const snapshot = parseConfirmedSnapshot(current, organizationId, dependencies.env);
      if (requireNewCapture) assertNewCaptureWindow(snapshot, startedAt);
      if (!commandSnapshotIsFresh(current, snapshot, now(), maxAgeMs)) {
        throw new MutationError("Hetzner listener vrátil zastaraný VIPTel snapshot.", 502);
      }
      return snapshot;
    }
    if (current.status === "failed") {
      const response = jsonRecord(current.provider_response);
      throw new MutationError(readSafeError(response.error) ?? "Hetzner listener nedokázal načítať VIPTel snapshot.", 502);
    }
    if (!["queued", "sent"].includes(current.status)) {
      throw new MutationError("VIPTel snapshot skončil v nepovolenom stave.", 502);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await failTimedOutQueuedSnapshot(client, organizationId, command.id, now().toISOString());
  // Carries a code because this is a definite refusal, not a lost response:
  // the snapshot command has just been marked failed above, so nothing is
  // still in flight that a journal replay could be waiting for.
  throw new MutationError(
    "Hetzner listener nevrátil VIPTel snapshot v bezpečnom časovom limite.",
    504,
    "provider_snapshot_unavailable",
  );
}

export function requirePersonalExtensionInSnapshot(
  snapshot: ViptelProviderSnapshot,
  extension: string,
  options: {
    allowInactiveForRegistration?: boolean;
    allowInactiveForBrowserSipIntent?: boolean;
    requireRegistered?: boolean;
  } = {},
) {
  if (options.allowInactiveForBrowserSipIntent === true && options.requireRegistered !== true) {
    throw new Error("Browser SIP intent inactive-state exception requires a registered provider endpoint.");
  }
  if (!snapshot.personalExtensions.includes(extension)) {
    throw new MutationError(`Klapka ${extension} nie je povolená v aktuálnej VIPTel konfigurácii.`, 409);
  }
  const match = snapshot.extensions.find((candidate) => candidate.extension === extension);
  if (!match) {
    throw new MutationError(`Klapka ${extension} chýba v čerstvom stave VIPTel.`, 409);
  }
  // VIPTel reports a successfully registered browser endpoint as inactive.
  // Session issuance bootstraps that endpoint, while browser_sip only records
  // an intent before the browser sends the INVITE. Both exceptions remain
  // explicit and still require the fresh allowlist and extension above. A call
  // intent additionally keeps `requireRegistered`, unlike session bootstrap.
  const allowInactive = options.allowInactiveForRegistration === true ||
    options.allowInactiveForBrowserSipIntent === true;
  if (match.isViptelPhoneActive === false && !allowInactive) {
    throw new MutationError(`Klapka ${extension} nie je vo VIPTel aktívna.`, 409);
  }
  if (options.requireRegistered && match.isRegistered !== true) {
    throw new MutationError(`Klapka ${extension} momentálne nie je zaregistrovaná vo VIPTel.`, 409);
  }
  return match;
}

export function providerSnapshotRequestExpired(command: Pick<SnapshotCommandRow, "request_payload">, now: Date) {
  const request = parseSnapshotRequest(command.request_payload);
  return now.getTime() > Date.parse(request.deadlineAt);
}

export function signViptelProviderSnapshotRequest(
  command: SnapshotRequestCommandRow,
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  assertSnapshotRequestIdentity(command, organizationId);
  return createHmac("sha256", requiredBridgeToken(env))
    .update(canonicalJson({
      domain: "motorist.viptel.provider-snapshot-request.v1",
      commandId: command.id,
      organizationId,
      requestedBy: command.requested_by,
      idempotencyKey: command.idempotency_key,
      request: parseSnapshotRequest(command.request_payload),
    }))
    .digest("hex");
}

export function verifyViptelProviderSnapshotRequest(
  command: SnapshotRequestCommandRow,
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const payload = jsonRecord(command.request_payload);
  const received = typeof payload[VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY] === "string" &&
    /^[a-f0-9]{64}$/.test(payload[VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY])
    ? payload[VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY]
    : undefined;
  const expected = signViptelProviderSnapshotRequest(command, organizationId, env);
  if (!received || !timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("VIPTel snapshot request authentication is invalid.");
  }
  return { requestHmac: received, request: parseSnapshotRequest(command.request_payload) };
}

export function parseSnapshotRequest(value: unknown) {
  const record = jsonRecord(value);
  const schemaVersion = readInteger(record.schemaVersion);
  const requestedAt = readIsoDate(record.requestedAt);
  const deadlineAt = readIsoDate(record.deadlineAt);
  if (
    schemaVersion !== VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION ||
    !requestedAt ||
    !deadlineAt ||
    Date.parse(deadlineAt) <= Date.parse(requestedAt) ||
    Date.parse(deadlineAt) - Date.parse(requestedAt) > REQUEST_DEADLINE_MS
  ) {
    throw new Error("VIPTel snapshot request metadata is invalid.");
  }
  return { schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION, requestedAt, deadlineAt } as const;
}

export function parseViptelProviderSnapshotWire(value: unknown): ViptelProviderSnapshot {
  assertRawWireSize(value);
  if (containsForbiddenSnapshotKey(value)) throw new Error("VIPTel snapshot contains forbidden raw or secret fields.");
  const wire = normalizeProviderSnapshotWire(value);
  assertWireSize(wire);
  return {
    ...wire,
    extensions: wire.extensions.map((extension) => ({ ...extension, raw: {} })),
    activeCalls: wire.activeCalls.map((call) => ({ ...call, raw: {} })),
  };
}

export function signViptelProviderSnapshotResponse(
  command: Pick<SnapshotCommandRow, "id" | "request_payload">,
  organizationId: string,
  snapshot: ViptelProviderSnapshotWire,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  assertUuid(organizationId, "Organizácia snapshot podpisu");
  assertUuid(command.id, "Príkaz snapshot podpisu");
  const token = requiredBridgeToken(env);
  return createHmac("sha256", token)
    .update(canonicalJson({
      commandId: command.id,
      organizationId,
      request: parseSnapshotRequest(command.request_payload),
      schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
      snapshot,
    }))
    .digest("hex");
}

function normalizeProviderSnapshotWire(value: unknown): ViptelProviderSnapshotWire {
  const record = jsonRecord(value);
  if (readInteger(record.schemaVersion) !== VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("VIPTel snapshot schema version is unsupported.");
  }
  const capturedAt = readIsoDate(record.capturedAt);
  if (!capturedAt) throw new Error("VIPTel snapshot capturedAt is invalid.");
  const expectedPersonal = configuredPersonalExtensions();
  const personalExtensions = readNumericStringArray(record.personalExtensions, MAX_EXTENSIONS);
  if (
    personalExtensions.length !== expectedPersonal.length ||
    expectedPersonal.some((extension, index) => personalExtensions[index] !== extension)
  ) {
    throw new Error("VIPTel snapshot personal-extension allowlist does not match this runtime.");
  }
  if (!Array.isArray(record.extensions) || record.extensions.length > MAX_EXTENSIONS) {
    throw new Error("VIPTel snapshot extension count is outside bounds.");
  }
  const allExtensions = record.extensions.map(normalizeWireExtension);
  const extensions = allExtensions.filter((extension) => personalExtensions.includes(extension.extension));
  if (
    extensions.length !== personalExtensions.length ||
    personalExtensions.some((extension) => extensions.filter((candidate) => candidate.extension === extension).length !== 1)
  ) {
    throw new Error("VIPTel snapshot must contain exactly one row for every personal extension.");
  }
  if (!Array.isArray(record.activeCalls) || record.activeCalls.length > MAX_ACTIVE_CALLS) {
    throw new Error("VIPTel snapshot active-call count is outside bounds.");
  }
  const activeCalls = record.activeCalls.map(normalizeWireActiveCall);
  const queues = normalizeWireQueues(record.queues);
  const queueStatuses = normalizeWireQueueStatuses(record.queueStatuses);
  return {
    schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
    capturedAt,
    personalExtensions,
    extensions,
    activeCalls,
    queues,
    queueStatuses,
  };
}

function normalizeWireExtension(value: unknown): WireExtension {
  const record = jsonRecord(value);
  const extension = readNumeric(record.extension, 8);
  if (!extension) throw new Error("VIPTel snapshot contains an invalid extension.");
  const allowedChanges = readTextArray(record.allowedChanges, MAX_ALLOWED_CHANGES, 80);
  return compactObject({
    extension,
    name: readOptionalText(record.name),
    outboundCid: readOptionalText(record.outboundCid, 80),
    callForwarding: readOptionalForwarding(record.callForwarding),
    isRegistered: readOptionalBoolean(record.isRegistered),
    isViptelPhoneActive: readOptionalBoolean(record.isViptelPhoneActive),
    allowedChanges,
  }) as WireExtension;
}

function normalizeWireActiveCall(value: unknown): WireActiveCall {
  const record = jsonRecord(value);
  const direction = readEnum(record.direction, LIVE_CALL_DIRECTIONS);
  const status = readEnum(record.status, LIVE_CALL_STATUSES);
  if (!direction || !status) throw new Error("VIPTel snapshot contains an invalid active-call state.");
  const call = compactObject({
    providerCallId: readOptionalText(record.providerCallId, 128),
    viptelUniqueId: readOptionalText(record.viptelUniqueId, 128),
    fromQueueUniqueId: readOptionalText(record.fromQueueUniqueId, 128),
    direction,
    status,
    callerNumber: readOptionalText(record.callerNumber, 128),
    callerName: readOptionalText(record.callerName),
    calledNumber: readOptionalText(record.calledNumber, 128),
    receivedNumber: readOptionalText(record.receivedNumber, 128),
    destinationNumber: readOptionalText(record.destinationNumber, 128),
    callerExtension: readOptionalText(record.callerExtension, 128),
    receivedExtension: readOptionalText(record.receivedExtension, 128),
    destinationExtension: readOptionalText(record.destinationExtension, 128),
    queueNumber: readOptionalText(record.queueNumber, 32),
    queueLabel: readOptionalText(record.queueLabel),
    operatorName: readOptionalText(record.operatorName),
    startedAt: readOptionalIsoDate(record.startedAt),
    answeredAt: readOptionalIsoDate(record.answeredAt),
    endedAt: readOptionalIsoDate(record.endedAt),
    waitSeconds: readOptionalBoundedInteger(record.waitSeconds, 7 * 24 * 60 * 60),
    durationSeconds: readOptionalBoundedInteger(record.durationSeconds, 7 * 24 * 60 * 60),
  }) as WireActiveCall;
  if (!call.providerCallId && !call.viptelUniqueId && !call.callerNumber && !call.calledNumber) {
    throw new Error("VIPTel snapshot contains an unidentifiable active call.");
  }
  return call;
}

function normalizeWireQueues(value: unknown): ViptelQueue[] {
  if (!Array.isArray(value) || value.length !== VIPTEL_PROVIDER_SNAPSHOT_QUEUES.length) {
    throw new Error("VIPTel snapshot queue catalog is incomplete.");
  }
  const queues = value.map((item) => {
    const record = jsonRecord(item);
    const id = readNumeric(record.id, 8);
    const name = readRequiredText(record.name);
    if (!id) throw new Error("VIPTel snapshot queue identity is invalid.");
    return { id, name };
  });
  assertExactQueues(queues.map((queue) => queue.id));
  return queues;
}

function normalizeWireQueueStatuses(value: unknown): ViptelQueueStatus[] {
  if (!Array.isArray(value) || value.length !== VIPTEL_PROVIDER_SNAPSHOT_QUEUES.length) {
    throw new Error("VIPTel snapshot queue statuses are incomplete.");
  }
  const statuses = value.map((item) => {
    const record = jsonRecord(item);
    const queue = readNumeric(record.queue, 8);
    const waitingCalls = readInteger(record.waitingCalls);
    if (!queue || waitingCalls === undefined || waitingCalls < 0 || waitingCalls > 10_000 || !Array.isArray(record.members)) {
      throw new Error("VIPTel snapshot queue status is invalid.");
    }
    if (record.members.length > MAX_QUEUE_MEMBERS) throw new Error("VIPTel snapshot queue member count is outside bounds.");
    const members = record.members.map((member) => {
      const candidate = jsonRecord(member);
      const extension = readNumeric(candidate.extension, 20);
      const paused = readBoolean(candidate.paused);
      const inUse = readBoolean(candidate.inUse);
      const dynamic = readBoolean(candidate.dynamic);
      const callsTaken = readInteger(candidate.callsTaken);
      if (!extension || paused === undefined || inUse === undefined || dynamic === undefined || callsTaken === undefined || callsTaken < 0) {
        throw new Error("VIPTel snapshot queue member is invalid.");
      }
      return { extension, paused, inUse, dynamic, callsTaken };
    });
    if (new Set(members.map((member) => member.extension)).size !== members.length) {
      throw new Error("VIPTel snapshot queue contains duplicate members.");
    }
    return { queue, waitingCalls, members };
  });
  assertExactQueues(statuses.map((status) => status.queue));
  return statuses;
}

function assertExactQueues(queues: string[]) {
  if (
    queues.length !== VIPTEL_PROVIDER_SNAPSHOT_QUEUES.length ||
    VIPTEL_PROVIDER_SNAPSHOT_QUEUES.some((queue) => queues.filter((candidate) => candidate === queue).length !== 1)
  ) {
    throw new Error("VIPTel snapshot must contain exactly queues 601, 602 and 603.");
  }
}

async function loadLatestConfirmedSnapshot(client: AdminClient, organizationId: string) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, status, request_payload, provider_response, created_at, sent_at, confirmed_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("command_type", VIPTEL_PROVIDER_SNAPSHOT_COMMAND)
    .eq("status", "confirmed_by_event")
    .order("confirmed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwQueryError(result.error, "Posledný VIPTel snapshot sa nepodarilo načítať.");
  return result.data as SnapshotCommandRow | null;
}

async function loadPendingSnapshotCommand(
  client: AdminClient,
  organizationId: string,
  preference: "newest" | "oldest",
) {
  const ascending = preference === "oldest";
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, status, request_payload, provider_response, created_at, sent_at, confirmed_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("command_type", VIPTEL_PROVIDER_SNAPSHOT_COMMAND)
    .in("status", ["queued", "sent"])
    .order("created_at", { ascending })
    .order("id", { ascending })
    .limit(1)
    .maybeSingle();
  throwQueryError(result.error, "Rozpracované VIPTel snapshoty sa nepodarilo načítať.");
  return result.data as SnapshotCommandRow | null;
}

async function insertSnapshotCommand(
  client: AdminClient,
  organizationId: string,
  requestedBy: string,
  requestedAt: Date,
  randomId: () => string,
  options: {
    env?: Readonly<Record<string, string | undefined>>;
  },
) {
  const id = randomId();
  assertUuid(id, "Auditný identifikátor snapshotu");
  const request = {
    schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
    requestedAt: requestedAt.toISOString(),
    deadlineAt: new Date(requestedAt.getTime() + REQUEST_DEADLINE_MS).toISOString(),
  };
  const bucket = Math.floor(requestedAt.getTime() / 2_000);
  const idempotencyKey = createHash("sha256")
    .update(`${VIPTEL_PROVIDER_SNAPSHOT_COMMAND}|${organizationId}|${bucket}`)
    .digest("hex");
  const unsignedCommand: SnapshotRequestCommandRow = {
    id,
    organization_id: organizationId,
    provider: PROVIDER,
    command_type: VIPTEL_PROVIDER_SNAPSHOT_COMMAND,
    requested_by: requestedBy,
    request_payload: toJson(request),
    idempotency_key: idempotencyKey,
  };
  const requestHmac = signViptelProviderSnapshotRequest(unsignedCommand, organizationId, options.env ?? process.env);
  const result = await client
    .from("motorist_telephony_commands")
    .insert({
      id,
      organization_id: organizationId,
      provider: PROVIDER,
      command_type: VIPTEL_PROVIDER_SNAPSHOT_COMMAND,
      requested_by: requestedBy,
      request_payload: toJson({ ...request, [VIPTEL_PROVIDER_SNAPSHOT_REQUEST_HMAC_KEY]: requestHmac }),
      provider_response: {},
      status: "queued",
      idempotency_key: idempotencyKey,
    })
    .select("id, status, request_payload, provider_response, created_at, sent_at, confirmed_at")
    .maybeSingle();
  if (isUniqueViolation(result.error)) {
    const raced = await client
      .from("motorist_telephony_commands")
      .select("id, status, request_payload, provider_response, created_at, sent_at, confirmed_at")
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    throwQueryError(raced.error, "Súbežný VIPTel snapshot sa nepodarilo načítať.");
    if (!raced.data) throw new MutationError("Súbežný VIPTel snapshot sa stratil.", 502);
    return raced.data as SnapshotCommandRow;
  }
  throwQueryError(result.error, "VIPTel snapshot sa nepodarilo zaradiť listeneru.");
  if (!result.data) throw new MutationError("VIPTel snapshot sa po zaradení nenašiel.", 502);
  if (result.data.id !== id) {
    throw new MutationError("Čerstvý VIPTel snapshot nevrátil identitu tejto požiadavky.", 502);
  }
  return result.data as SnapshotCommandRow;
}

async function loadSnapshotCommand(client: AdminClient, organizationId: string, commandId: string) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, status, request_payload, provider_response, created_at, sent_at, confirmed_at")
    .eq("id", commandId)
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("command_type", VIPTEL_PROVIDER_SNAPSHOT_COMMAND)
    .maybeSingle();
  throwQueryError(result.error, "Stav VIPTel snapshotu sa nepodarilo načítať.");
  return result.data as SnapshotCommandRow | null;
}

async function failTimedOutQueuedSnapshot(
  client: AdminClient,
  organizationId: string,
  commandId: string,
  failedAt: string,
) {
  const result = await client
    .from("motorist_telephony_commands")
    .update({
      status: "failed",
      provider_response: toJson({
        schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
        reason: "requester_timeout_before_claim",
        error: "Snapshot request timed out before the listener claimed it.",
        failedAt,
      }),
    })
    .eq("id", commandId)
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("command_type", VIPTEL_PROVIDER_SNAPSHOT_COMMAND)
    .eq("status", "queued");
  throwQueryError(result.error, "Expirovaný VIPTel snapshot sa nepodarilo bezpečne uzavrieť.");
}

function parseConfirmedSnapshot(
  command: SnapshotCommandRow,
  organizationId: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
) {
  if (command.status !== "confirmed_by_event" || !command.confirmed_at) {
    throw new MutationError("VIPTel snapshot nie je terminálne potvrdený.", 502);
  }
  const response = jsonRecord(command.provider_response);
  if (
    readInteger(response.schemaVersion) !== VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION ||
    response.delivery !== "listener_rest_read"
  ) {
    throw new MutationError("VIPTel snapshot response metadata sú neplatné.", 502);
  }
  try {
    const snapshot = parseViptelProviderSnapshotWire(response.snapshot);
    const wire = snapshotToWire(snapshot);
    const expected = signViptelProviderSnapshotResponse(command, organizationId, wire, env ?? process.env);
    const received = typeof response.responseHmac === "string" && /^[a-f0-9]{64}$/.test(response.responseHmac)
      ? response.responseHmac
      : undefined;
    if (!received || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))) {
      throw new Error("VIPTel snapshot response authentication is invalid.");
    }
    return snapshot;
  } catch (error) {
    throw new MutationError(`VIPTel snapshot response je poškodený: ${safeError(error)}`, 502);
  }
}

function snapshotToWire(snapshot: ViptelProviderSnapshot): ViptelProviderSnapshotWire {
  return {
    schemaVersion: VIPTEL_PROVIDER_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: snapshot.capturedAt,
    personalExtensions: snapshot.personalExtensions,
    extensions: snapshot.extensions.map(extensionToWire),
    activeCalls: snapshot.activeCalls.map(activeCallToWire),
    queues: snapshot.queues,
    queueStatuses: snapshot.queueStatuses,
  };
}

function extensionToWire(extension: ViptelExtension): WireExtension {
  const wire = { ...extension } as Partial<ViptelExtension>;
  delete wire.raw;
  return wire as WireExtension;
}

function activeCallToWire(call: ViptelActiveCall): WireActiveCall {
  const wire = { ...call } as Partial<ViptelActiveCall>;
  delete wire.raw;
  return wire as WireActiveCall;
}

function snapshotIsFresh(snapshot: ViptelProviderSnapshot, now: Date, maxAgeMs: number) {
  const capturedAt = Date.parse(snapshot.capturedAt);
  const age = now.getTime() - capturedAt;
  if (!Number.isFinite(capturedAt) || age < -CLOCK_SKEW_MS) {
    throw new MutationError("VIPTel snapshot má neplatný alebo budúci čas zachytenia.", 502);
  }
  return age <= maxAgeMs;
}

function commandSnapshotIsFresh(
  command: SnapshotCommandRow,
  snapshot: ViptelProviderSnapshot,
  now: Date,
  maxAgeMs: number,
) {
  if (snapshotIsFresh(snapshot, now, maxAgeMs)) return true;
  if (!command.sent_at || !command.confirmed_at) return false;

  const capturedAt = Date.parse(snapshot.capturedAt);
  const sentAt = Date.parse(command.sent_at);
  const confirmedAt = Date.parse(command.confirmed_at);
  const responseConfirmedValue = jsonRecord(command.provider_response).confirmedAt;
  const responseConfirmedAt = Date.parse(typeof responseConfirmedValue === "string" ? responseConfirmedValue : "");
  const request = parseSnapshotRequest(command.request_payload);
  const requestedAt = Date.parse(request.requestedAt);
  const deadlineAt = Date.parse(request.deadlineAt);
  const providerReadDuration = confirmedAt - capturedAt;
  const confirmedAge = now.getTime() - confirmedAt;
  if (
    !Number.isFinite(sentAt) ||
    !Number.isFinite(confirmedAt) ||
    !Number.isFinite(responseConfirmedAt) ||
    sentAt !== capturedAt ||
    responseConfirmedAt !== confirmedAt ||
    capturedAt < requestedAt - CLOCK_SKEW_MS ||
    confirmedAt > deadlineAt ||
    confirmedAge < -CLOCK_SKEW_MS ||
    providerReadDuration < 0
  ) {
    return false;
  }
  return providerReadDuration <= LEGACY_PRE_READ_CAPTURE_MAX_DURATION_MS && confirmedAge <= maxAgeMs;
}

function assertNewCaptureWindow(snapshot: ViptelProviderSnapshot, requestedAt: Date) {
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt < requestedAt.getTime() - CLOCK_SKEW_MS) {
    throw new MutationError("VIPTel snapshot bol zachytený pred požiadavkou na nový stav.", 502);
  }
}

function containsForbiddenSnapshotKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenSnapshotKey);
  if (!value || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["raw", "password", "secret", "token", "authorization", "credential"].includes(key.toLowerCase())) return true;
    if (containsForbiddenSnapshotKey(nested)) return true;
  }
  return false;
}

function assertWireSize(wire: ViptelProviderSnapshotWire) {
  if (Buffer.byteLength(JSON.stringify(wire), "utf8") > MAX_WIRE_BYTES) {
    throw new Error("VIPTel snapshot exceeds the maximum normalized response size.");
  }
}

function assertRawWireSize(value: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("VIPTel snapshot response is not serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_WIRE_BYTES) {
    throw new Error("VIPTel snapshot exceeds the maximum response size.");
  }
}

function requiredBridgeToken(env: Readonly<Record<string, string | undefined>>) {
  const token = env.VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN?.trim();
  if (!token || token.length < MIN_AUTHORITY_TOKEN_LENGTH) {
    throw new MutationError("VIPTel snapshot response authority is missing.", 503);
  }
  return token;
}

function assertSnapshotRequestIdentity(command: SnapshotRequestCommandRow, organizationId: string) {
  assertUuid(organizationId, "Organizácia snapshot požiadavky");
  assertUuid(command.id, "Príkaz snapshot požiadavky");
  if (!command.requested_by) throw new Error("VIPTel snapshot request has no requesting profile.");
  assertUuid(command.requested_by, "Žiadateľ snapshot požiadavky");
  if (
    command.organization_id !== organizationId ||
    command.provider !== PROVIDER ||
    command.command_type !== VIPTEL_PROVIDER_SNAPSHOT_COMMAND ||
    typeof command.idempotency_key !== "string" ||
    command.idempotency_key.length < 16 ||
    command.idempotency_key.length > 128
  ) {
    throw new Error("VIPTel snapshot request identity is invalid.");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  throw new Error("VIPTel snapshot signature payload is not canonicalizable.");
}

function readNumericStringArray(value: unknown, maxLength: number) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxLength) {
    throw new Error("VIPTel snapshot numeric allowlist is invalid.");
  }
  const result = value.map((item) => readNumeric(item, 8));
  if (result.some((item) => !item) || new Set(result).size !== result.length) {
    throw new Error("VIPTel snapshot numeric allowlist is invalid.");
  }
  return result as string[];
}

function readTextArray(value: unknown, maxLength: number, maxItemLength: number) {
  if (!Array.isArray(value) || value.length > maxLength) throw new Error("VIPTel snapshot text array is outside bounds.");
  const items = value.map((item) => readRequiredText(item, maxItemLength));
  if (new Set(items).size !== items.length) throw new Error("VIPTel snapshot text array contains duplicates.");
  return items;
}

function readOptionalForwarding(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  return readRequiredText(value, 128);
}

function readOptionalBoolean(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const parsed = readBoolean(value);
  if (parsed === undefined) throw new Error("VIPTel snapshot contains an invalid boolean.");
  return parsed;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalIsoDate(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const parsed = readIsoDate(value);
  if (!parsed) throw new Error("VIPTel snapshot contains an invalid date.");
  return parsed;
}

function readIsoDate(value: unknown) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function readOptionalBoundedInteger(value: unknown, max: number) {
  if (value === undefined || value === null) return undefined;
  const parsed = readInteger(value);
  if (parsed === undefined || parsed < 0 || parsed > max) throw new Error("VIPTel snapshot contains an invalid duration.");
  return parsed;
}

function readInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readNumeric(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return new RegExp(`^\\d{1,${maxLength}}$`).test(trimmed) ? trimmed : undefined;
}

function readRequiredText(value: unknown, maxLength = MAX_TEXT) {
  const parsed = readOptionalText(value, maxLength);
  if (!parsed) throw new Error("VIPTel snapshot contains a missing text field.");
  return parsed;
}

function readOptionalText(value: unknown, maxLength = MAX_TEXT) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("VIPTel snapshot contains a non-text field.");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new Error("VIPTel snapshot contains invalid or oversized text.");
  }
  return trimmed;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]) {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function boundedInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < min || value > max) throw new MutationError(`${label} je mimo bezpečného rozsahu.`, 500);
  return value;
}

function envInteger(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number) {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new MutationError(`${key} musí byť celé číslo.`, 500);
  return parsed;
}

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MutationError(`${label} nemá platný identifikátor.`, 400);
  }
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readSafeError(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/[\r\n\t]+/g, " ");
  return trimmed ? trimmed.slice(0, 240) : undefined;
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 240) : "neznáma chyba";
}

function throwQueryError(error: { message?: string } | null | undefined, fallback: string) {
  if (error) throw new MutationError(fallback, 500);
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}
