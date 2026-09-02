import "server-only";

import { randomUUID } from "node:crypto";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import {
  formatViptelDialTarget,
  sameDialNumber as phoneNumbersMatch,
  TelephonyPhoneInputError,
} from "@/lib/telephony/phone";

type QueryValue = string | number | boolean | null | undefined;

/**
 * VIPTel REST is hard-limited to 20 requests per rolling 5 seconds per IP, and
 * exceeding it blocks the IP for 30 minutes (REST API v26.3.2, "Obmedzenie
 * maximálneho množstva požiadaviek"). One provider snapshot alone is five
 * requests, and the listener also runs the fallback pump and the command
 * outbox from the same address, so bursts genuinely approach the limit. This
 * process-wide sliding window keeps us under it with headroom: a request over
 * budget waits for the oldest one to leave the window instead of being sent
 * into a 30-minute ban.
 */
export const VIPTEL_REST_WINDOW_MS = 5_000;
export const VIPTEL_REST_MAX_PER_WINDOW = 12;
const restWindows = new Map<string, number[]>();

export async function acquireViptelRestSlot(
  host: string,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<number> {
  let waitedMs = 0;
  for (;;) {
    const timestamps = restWindows.get(host) ?? [];
    const cutoff = now() - VIPTEL_REST_WINDOW_MS;
    const live = timestamps.filter((at) => at > cutoff);
    if (live.length < VIPTEL_REST_MAX_PER_WINDOW) {
      live.push(now());
      restWindows.set(host, live);
      return waitedMs;
    }
    const oldest = Math.min(...live);
    const waitMs = Math.max(50, oldest + VIPTEL_REST_WINDOW_MS - now() + 25);
    waitedMs += waitMs;
    await sleep(waitMs);
  }
}

export type ViptelConfig = {
  restBaseUrl: string;
  websocketUrl: string;
  username: string;
  password: string;
  defaultExtension?: string;
  callerId?: string;
  requestTimeoutMs: number;
};

export type ViptelExtension = {
  extension: string;
  name?: string;
  outboundCid?: string;
  callForwarding?: string | boolean;
  isRegistered?: boolean;
  isViptelPhoneActive?: boolean;
  allowedChanges: string[];
  raw: Record<string, unknown>;
};

export type ViptelCreateCallRequest = {
  caller: string;
  destination: string;
};

export type ViptelCreateCallResult = {
  requestId: string;
  providerStatus: number;
  providerResponse: unknown;
};

export type ViptelActiveCall = {
  providerCallId?: string;
  viptelUniqueId?: string;
  fromQueueUniqueId?: string;
  direction: "inbound" | "outbound" | "internal";
  status: "incoming" | "ringing_agent" | "answered" | "missed" | "abandoned_queue" | "outbound" | "ended" | "failed";
  callerNumber?: string;
  callerName?: string;
  calledNumber?: string;
  receivedNumber?: string;
  destinationNumber?: string;
  callerExtension?: string;
  receivedExtension?: string;
  destinationExtension?: string;
  queueNumber?: string;
  queueLabel?: string;
  operatorName?: string;
  startedAt?: string;
  answeredAt?: string;
  endedAt?: string;
  waitSeconds?: number;
  durationSeconds?: number;
  raw: Record<string, unknown>;
};

export type ViptelCdrQuery = {
  limit?: number;
  offset?: number;
  dateFrom?: string;
  dateTo?: string;
};

export type ViptelCdrRecord = {
  cdrId?: string;
  viptelUniqueId?: string;
  direction?: "inbound" | "outbound";
  type?: string;
  application?: string;
  startedAt?: string;
  answeredAt?: string;
  endedAt?: string;
  callerNumber?: string;
  callerName?: string;
  calledNumber?: string;
  callerExtension?: string;
  receivedExtension?: string;
  destinationExtension?: string;
  receivedNumber?: string;
  receivedName?: string;
  destinationNumber?: string;
  destinationName?: string;
  queueNumber?: string;
  durationSeconds?: number;
  billSeconds?: number;
  ringSeconds?: number;
  completeDurationSeconds?: number;
  disposition?: string;
  recordingFile?: string;
  hasRecording: boolean;
  raw: Record<string, unknown>;
};

export type ViptelRecordingDownload = {
  data: ArrayBuffer;
  contentType: string | null;
  contentDisposition: string | null;
  sizeBytes: number;
  providerStatus: number;
};

export class ViptelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViptelConfigError";
  }
}

export class ViptelInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViptelInputError";
  }
}

export class ViptelHttpError extends Error {
  constructor(
    message: string,
    readonly providerStatus: number,
    readonly providerResponse: unknown,
  ) {
    super(message);
    this.name = "ViptelHttpError";
  }
}

export function getViptelConfig(): ViptelConfig {
  const username = configuredEnv("VIPTEL_USERNAME");
  const password = configuredEnv("VIPTEL_PASSWORD");

  if (!username || !password) {
    throw new ViptelConfigError("VIPTel API credentials are not configured.");
  }

  return {
    restBaseUrl: withTrailingSlash(configuredEnv("VIPTEL_REST_BASE_URL") ?? "https://pbxmanager.viptel.sk/"),
    websocketUrl: configuredEnv("VIPTEL_WEBSOCKET_URL") ?? "wss://pbxwssv1.viptel.sk:8088/",
    username,
    password,
    defaultExtension: configuredEnv("VIPTEL_DEFAULT_EXTENSION"),
    callerId: configuredEnv("VIPTEL_CALLER_ID"),
    requestTimeoutMs: numberEnv("VIPTEL_REQUEST_TIMEOUT_MS", 8000),
  };
}

export type ViptelQueue = { id: string; name: string };
export type ViptelQueueMember = { extension: string; paused: boolean; inUse: boolean; dynamic: boolean; callsTaken: number };
/**
 * One caller currently waiting in a queue, from GET /api/queue/status
 * `waiting_calls[]`. The uniqueId is the caller's own channel and stays the
 * same for their whole journey through the rotation, which is what lets the
 * waiting room keep showing them steadily while agent legs come and go.
 */
export type ViptelQueueWaitingCall = {
  uniqueId: string;
  caller?: string;
  callerName?: string;
  waitSeconds?: number;
};
export type ViptelQueueStatus = {
  queue: string;
  members: ViptelQueueMember[];
  waitingCalls: number;
  /** Present only when the provider returned the per-caller list. */
  waitingCallEntries?: ViptelQueueWaitingCall[];
};
export type ViptelQueueAgentAction = "add" | "remove" | "pause" | "unpause";

export function createViptelClient(config = getViptelConfig()) {
  return new ViptelClient(config);
}

export class ViptelClient {
  constructor(readonly config: ViptelConfig) {}

  async listExtensions(): Promise<ViptelExtension[]> {
    const response = await this.requestJson("/api/extension");

    if (!Array.isArray(response.data)) {
      throw new ViptelHttpError("VIPTel returned an unexpected extension payload.", response.status, response.data);
    }

    return response.data.map(normalizeExtension).filter((extension) => /^\d{1,8}$/.test(extension.extension));
  }

  async listOutboundCallerIds(): Promise<string[]> {
    const response = await this.requestJson("/api/extension/outbounds");
    return extractOutboundCallerIds(response.data);
  }

  async createCall(request: ViptelCreateCallRequest, requestId: string = randomUUID()): Promise<ViptelCreateCallResult> {
    const response = await this.requestJson("/api/call/create", {
      caller: request.caller,
      destination: request.destination,
    });

    return {
      requestId,
      providerStatus: response.status,
      providerResponse: response.data,
    };
  }

  async listActiveCalls(): Promise<ViptelActiveCall[]> {
    const response = await this.requestJson("/api/call/statistics");
    const list = recognizedActiveCallsList(response.data);
    if (!list || list.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new ViptelHttpError("VIPTel returned an unexpected active-calls payload.", response.status, response.data);
    }
    const calls = list.map(normalizeActiveCall);
    if (calls.some((call) => !call.providerCallId && !call.viptelUniqueId && !call.callerNumber && !call.calledNumber)) {
      throw new ViptelHttpError("VIPTel returned an unidentifiable active call.", response.status, response.data);
    }
    return calls;
  }

  async listCdr(query: ViptelCdrQuery = {}): Promise<ViptelCdrRecord[]> {
    const response = await this.requestJson("/api/cdr/", cdrQueryParams(query));
    return extractCdrRecords(response.data);
  }

  async listCdrRecordings(query: ViptelCdrQuery = {}): Promise<ViptelCdrRecord[]> {
    const response = await this.requestJson("/api/cdr/recordings", cdrQueryParams(query));
    return extractCdrRecords(response.data);
  }

  async downloadRecording(idOrUniqueId: string): Promise<ViptelRecordingDownload> {
    const id = String(idOrUniqueId ?? "").trim();

    if (!id) {
      throw new ViptelInputError("Recording id is required.");
    }

    return this.requestBinary(`/api/cdr/download/${encodeURIComponent(id)}`);
  }

  async listQueues(): Promise<ViptelQueue[]> {
    const response = await this.requestJson("/api/queue/");

    if (!Array.isArray(response.data)) {
      return [];
    }

    return response.data
      .map((raw) => {
        const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        return {
          id: readStringCandidate(record, ["queue", "queue_number", "queue_id", "id"]) ?? "",
          name: readStringCandidate(record, ["nazov", "name", "label", "description"]) ?? "",
        };
      })
      .filter((queue) => queue.id);
  }

  async getQueueStatus(queue: string): Promise<ViptelQueueStatus> {
    const response = await this.requestJson("/api/queue/status", { queue });
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
      throw new ViptelHttpError("VIPTel returned an unexpected queue-status payload.", response.status, response.data);
    }
    const data = response.data as Record<string, unknown>;
    const returnedQueue = readStringCandidate(data, ["queue"]);
    if (returnedQueue !== queue || !Array.isArray(data.members)) {
      throw new ViptelHttpError("VIPTel queue-status identity or members are missing.", response.status, response.data);
    }
    const waitingCalls = Array.isArray(data.waiting_calls)
      ? data.waiting_calls.length
      : readStrictNonNegativeInteger(data, ["waiting", "waiting_calls", "calls_waiting"]);
    if (waitingCalls === undefined) {
      throw new ViptelHttpError("VIPTel queue-status waiting count is missing.", response.status, response.data);
    }
    const waitingCallEntries = Array.isArray(data.waiting_calls)
      ? data.waiting_calls.flatMap((raw): ViptelQueueWaitingCall[] => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const entry = raw as Record<string, unknown>;
          const uniqueId = readStringCandidate(entry, ["unique_id", "uniqueid"]);
          if (!uniqueId) return [];
          const waitSeconds = readStrictNonNegativeInteger(entry, ["wait_time", "wait_seconds"]);
          return [{
            uniqueId,
            caller: readStringCandidate(entry, ["caller"]),
            callerName: readStringCandidate(entry, ["caller_name"]),
            ...(waitSeconds === undefined ? {} : { waitSeconds }),
          }];
        })
      : undefined;
    const membersRaw = data.members;
    const members: ViptelQueueMember[] = membersRaw
      .map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new ViptelHttpError("VIPTel returned a malformed queue member.", response.status, response.data);
        }
        const member = raw as Record<string, unknown>;
        const extension = normalizeQueueMemberExtension(
          readStringCandidate(member, ["extension", "extension_number", "member", "interface"]),
        );
        const paused = readBoolean(member.paused);
        const inUse = readBoolean(member.in_use);
        const dynamic = readBoolean(member.dynamic);
        const callsTaken = readStrictNonNegativeInteger(member, ["calls_taken", "calls"]);
        if (!extension || paused === undefined || inUse === undefined || dynamic === undefined || callsTaken === undefined) {
          throw new ViptelHttpError("VIPTel returned an incomplete queue member.", response.status, response.data);
        }
        return {
          extension,
          paused,
          inUse,
          dynamic,
          callsTaken,
        };
      })
      .filter((member) => member.extension);

    return {
      queue: returnedQueue,
      members,
      waitingCalls,
      ...(waitingCallEntries ? { waitingCallEntries } : {}),
    };
  }

  async setQueueAgent(queue: string, extension: string, action: ViptelQueueAgentAction): Promise<unknown> {
    const response = await this.requestJson(`/api/queue/${action}`, { queue, extension });
    return response.data;
  }

  private async requestBinary(path: string): Promise<ViptelRecordingDownload> {
    const url = new URL(path.replace(/^\//, ""), this.config.restBaseUrl);
    await acquireViptelRestSlot(url.host);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(this.config.requestTimeoutMs, 30_000));

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`, "utf8").toString("base64")}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new ViptelHttpError(`VIPTel REST returned HTTP ${response.status}.`, response.status, parseJson(text) ?? text);
      }

      const data = await response.arrayBuffer();

      return {
        data,
        contentType: response.headers.get("content-type"),
        contentDisposition: response.headers.get("content-disposition"),
        sizeBytes: data.byteLength,
        providerStatus: response.status,
      };
    } catch (error) {
      if (error instanceof ViptelHttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ViptelHttpError("VIPTel recording download timed out.", 504, null);
      }

      throw new ViptelHttpError(error instanceof Error ? error.message : "VIPTel recording download failed.", 502, null);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson(path: string, query?: Record<string, QueryValue>) {
    const url = new URL(path.replace(/^\//, ""), this.config.restBaseUrl);

    Object.entries(query ?? {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    await acquireViptelRestSlot(url.host);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`, "utf8").toString("base64")}`,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const data = parseJson(text);

      if (!response.ok) {
        throw new ViptelHttpError(`VIPTel REST returned HTTP ${response.status}.`, response.status, data ?? text);
      }

      return { data, status: response.status };
    } catch (error) {
      if (error instanceof ViptelHttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ViptelHttpError("VIPTel REST request timed out.", 504, null);
      }

      throw new ViptelHttpError(error instanceof Error ? error.message : "VIPTel REST request failed.", 502, null);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function probeViptelRest(options: { extension?: string; callerId?: string } = {}) {
  const config = getViptelConfig();
  const client = createViptelClient(config);
  const extensionNumber = cleanExtension(options.extension ?? config.defaultExtension ?? "10", "extension");
  const callerId = cleanDialTarget(options.callerId ?? config.callerId ?? "0412289133", "callerId");
  const [extensions, outboundCallerIds] = await Promise.all([client.listExtensions(), client.listOutboundCallerIds()]);
  const extension = extensions.find((item) => item.extension === extensionNumber) ?? null;

  return {
    restBaseUrl: config.restBaseUrl,
    websocketUrl: config.websocketUrl,
    extensionCount: extensions.length,
    extension: extension
      ? {
          extension: extension.extension,
          name: extension.name,
          outboundCid: extension.outboundCid,
          isRegistered: extension.isRegistered,
          isViptelPhoneActive: extension.isViptelPhoneActive,
          allowedChanges: extension.allowedChanges,
        }
      : null,
    extensionFound: Boolean(extension),
    callerId,
    outboundCallerIdCount: outboundCallerIds.length,
    callerIdAllowed: outboundCallerIds.some((item) => phoneNumbersMatch(item, callerId)),
  };
}

export function cleanExtension(value: unknown, fieldName = "extension") {
  const extension = String(value ?? "").trim();

  if (!/^\d{1,8}$/.test(extension)) {
    throw new ViptelInputError(`${fieldName} must be a numeric PBX extension.`);
  }

  return extension;
}

export function cleanDialTarget(value: unknown, fieldName = "number") {
  try {
    return formatViptelDialTarget(value, fieldName);
  } catch (error) {
    if (error instanceof TelephonyPhoneInputError) {
      throw new ViptelInputError(error.message);
    }

    throw error;
  }
}

export function serializeViptelError(error: unknown) {
  if (error instanceof ViptelConfigError) {
    return {
      message: error.message,
      status: 503,
    };
  }

  if (error instanceof ViptelInputError) {
    return {
      message: error.message,
      status: 400,
    };
  }

  if (error instanceof ViptelHttpError) {
    return {
      message: error.message,
      status: 502,
      providerStatus: error.providerStatus,
      providerResponseSummary: summarizeProviderResponse(error.providerResponse),
    };
  }

  return {
    message: error instanceof Error ? error.message : "Unexpected VIPTel integration error.",
    status: 500,
  };
}

function normalizeExtension(value: unknown): ViptelExtension {
  const raw = asRecord(value);

  return {
    extension: String(raw.extension ?? ""),
    name: readString(raw.name),
    outboundCid: readString(raw.outboundcid),
    callForwarding: typeof raw.call_forwarding === "boolean" ? raw.call_forwarding : readString(raw.call_forwarding),
    isRegistered: readBoolean(raw.is_registered),
    isViptelPhoneActive: readBoolean(raw.is_viptel_phone_active),
    allowedChanges: Array.isArray(raw.allowed_changes) ? raw.allowed_changes.map(String) : [],
    raw,
  };
}

function normalizeQueueMemberExtension(value: string | undefined) {
  if (!value) return "";
  const normalized = value.trim();
  if (/^\d{1,8}$/.test(normalized)) return normalized;
  return normalized.match(/^(?:PJSIP|SIP|Local)\/(\d{1,8})(?:[-@/]|$)/i)?.[1] ?? normalized;
}

function cdrQueryParams(query: ViptelCdrQuery): Record<string, QueryValue> {
  return {
    limit: query.limit,
    offset: query.offset,
    date_from: query.dateFrom,
    date_to: query.dateTo,
  };
}

export function extractCdrRecords(value: unknown): ViptelCdrRecord[] {
  const root = asRecord(value);
  const candidates = [value, root.data, root.cdr, root.records, root.items, root.results, root.rows];
  const list = candidates.find(Array.isArray);

  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .filter((item) => item && typeof item === "object")
    .map(normalizeCdrRecord)
    .filter((record) => Boolean(record.cdrId ?? record.viptelUniqueId));
}

export function normalizeCdrRecord(value: unknown): ViptelCdrRecord {
  const raw = asRecord(value);
  const recordingFile = readStringCandidate(raw, ["recordingfile", "recording_file", "recording", "record_file", "filename"]);
  const hasRecordingFlag = raw.has_recording ?? raw.hasRecording ?? raw.recorded;

  const type = readStringCandidate(raw, ["type", "direction"])?.toLowerCase();
  const callerNumber = readStringCandidate(raw, ["src", "source", "caller", "caller_number", "callerid", "clid", "from"]);
  const receivedNumber = readStringCandidate(raw, ["received", "received_number"]);
  const destinationNumber = readStringCandidate(raw, ["destination", "destination_number", "dst", "to"]);
  const calledNumber = readStringCandidate(raw, ["called", "called_number"]) ?? receivedNumber ?? destinationNumber;
  const durationSeconds = readNumberCandidate(raw, ["duration", "duration_seconds"]);
  const completeDurationSeconds = readNumberCandidate(raw, ["complete_duration", "complete_duration_seconds", "total_duration"]);
  const explicitRingSeconds = readNumberCandidate(raw, ["ring_seconds", "ring_time", "ringtime"]);
  const ringSeconds =
    explicitRingSeconds ??
    (completeDurationSeconds !== undefined && durationSeconds !== undefined
      ? Math.max(0, completeDurationSeconds - durationSeconds)
      : undefined);

  return {
    cdrId: readStringCandidate(raw, ["id", "cdr_id", "cdrid"]),
    viptelUniqueId: readStringCandidate(raw, ["uniqueid", "unique_id", "viptel_unique_id"]),
    direction: type?.includes("out") ? "outbound" : type?.includes("in") ? "inbound" : undefined,
    type,
    application: readStringCandidate(raw, ["application", "app"]),
    startedAt: readDateCandidate(raw, ["when", "calldate", "call_date", "started_at", "start_time", "date", "datetime", "timestamp"], MOTORIST_TIME_ZONE),
    answeredAt: readDateCandidate(raw, ["answered_at", "answer_time", "answerdate"], MOTORIST_TIME_ZONE),
    endedAt: readDateCandidate(raw, ["ended_at", "end_time", "hangup_time", "enddate"], MOTORIST_TIME_ZONE),
    callerNumber,
    callerName: readStringCandidate(raw, ["caller_name", "callername"]),
    calledNumber,
    receivedNumber,
    receivedName: readStringCandidate(raw, ["received_name", "receivedname"]),
    destinationNumber,
    destinationName: readStringCandidate(raw, ["destination_name", "destinationname"]),
    callerExtension: readStringCandidate(raw, ["caller_extension", "src_extension"]),
    receivedExtension: readStringCandidate(raw, ["received_extension"]),
    destinationExtension: readStringCandidate(raw, ["destination_extension", "dst_extension"]),
    queueNumber: readStringCandidate(raw, ["queue", "queue_number", "from_queue"]),
    durationSeconds,
    billSeconds: readNumberCandidate(raw, ["billsec", "bill_seconds", "talk_time"]),
    ringSeconds,
    completeDurationSeconds,
    disposition: readStringCandidate(raw, ["disposition", "status", "call_status"]),
    recordingFile,
    hasRecording: Boolean(recordingFile) || hasRecordingFlag === true || hasRecordingFlag === 1 || hasRecordingFlag === "1",
    raw,
  };
}

export function extractActiveCalls(value: unknown): ViptelActiveCall[] {
  const root = asRecord(value);
  const candidates = [
    value,
    root.data,
    root.calls,
    root.active_calls,
    root.activeCalls,
    root.items,
    root.results,
    root.statistics,
  ];
  const list = candidates.find(Array.isArray);

  if (Array.isArray(list)) {
    return list.map(normalizeActiveCall).filter((call) => Boolean(call.providerCallId ?? call.viptelUniqueId ?? call.callerNumber ?? call.calledNumber));
  }

  if (Object.keys(root).length > 0) {
    const nestedLists = Object.values(root).filter(Array.isArray).flat();

    if (nestedLists.length > 0) {
      return nestedLists.map(normalizeActiveCall).filter((call) => Boolean(call.providerCallId ?? call.viptelUniqueId ?? call.callerNumber ?? call.calledNumber));
    }
  }

  return [];
}

function normalizeActiveCall(value: unknown): ViptelActiveCall {
  const raw = asRecord(value);
  const direction = normalizeDirection(readStringCandidate(raw, ["direction", "call_direction", "type", "kind"]));

  return {
    providerCallId: readStringCandidate(raw, ["id", "call_id", "callid", "linkedid", "linked_id"]),
    viptelUniqueId: readStringCandidate(raw, ["uniqueid", "unique_id", "viptel_unique_id", "channel_id"]),
    fromQueueUniqueId: readStringCandidate(raw, ["from_queue_unique_id"]),
    direction,
    status: normalizeProviderCallStatus(readStringCandidate(raw, ["status", "state", "call_status", "event", "disposition"]), direction),
    callerNumber: readStringCandidate(raw, ["caller", "caller_number", "callerid", "caller_id", "src", "source", "from"]),
    callerName: readStringCandidate(raw, ["caller_name", "calleridname", "name"]),
    calledNumber: readStringCandidate(raw, ["callee", "called", "called_number", "destination", "dst", "to", "extension"]),
    receivedNumber: readStringCandidate(raw, ["received_number", "receivedNumber", "received", "did"]),
    destinationNumber: readStringCandidate(raw, ["destination_number", "destinationNumber", "destination", "dst", "callee", "to"]),
    callerExtension: readStringCandidate(raw, ["caller_extension"]),
    receivedExtension: readStringCandidate(raw, ["received_extension"]),
    destinationExtension: readStringCandidate(raw, ["destination_extension"]),
    queueNumber: readStringCandidate(raw, ["queue", "queue_number", "queue_id"]),
    queueLabel: readStringCandidate(raw, ["queue_label", "queue_name", "queue_description"]),
    operatorName: readStringCandidate(raw, ["operator", "operator_name", "agent", "agent_name", "member_name"]),
    startedAt: readDateCandidate(raw, ["started_at", "start_time", "created_at", "time", "timestamp"]),
    answeredAt: readDateCandidate(raw, ["answered_at", "answer_time"]),
    endedAt: readDateCandidate(raw, ["ended_at", "end_time", "hangup_time"]),
    waitSeconds: readNumberCandidate(raw, ["wait_seconds", "wait", "ring_time", "ringtime"]),
    durationSeconds: readNumberCandidate(raw, ["duration_seconds", "duration", "billsec", "talk_time"]),
    raw,
  };
}

function recognizedActiveCallsList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return ["data", "calls", "active_calls", "activeCalls", "items", "results", "statistics"]
    .map((key) => record[key])
    .find(Array.isArray);
}

function readStrictNonNegativeInteger(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const raw = record[key];
    const parsed = typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readStringCandidate(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function readNumberCandidate(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.round(parsed));
      }
    }
  }

  return undefined;
}

function readDateCandidate(record: Record<string, unknown>, keys: string[], offsetlessTimeZone?: string) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      const timestamp = value > 10_000_000_000 ? value : value * 1000;
      const date = new Date(timestamp);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    if (typeof value === "string" && value.trim()) {
      const date = offsetlessTimeZone
        ? parseProviderDate(value.trim(), offsetlessTimeZone)
        : new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
  }

  return undefined;
}

/**
 * VIPTel CDR returns its `when` value as the PBX wall clock without a timezone
 * suffix. JavaScript otherwise treats that shape as UTC on the listener,
 * shifting Slovak summer calls two hours into the future. Values that already
 * carry `Z` or an explicit offset remain ordinary absolute timestamps.
 */
function parseProviderDate(value: string, offsetlessTimeZone: string) {
  const wallClock = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!wallClock) return new Date(value);

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw = "0", millisecondRaw = "0"] = wallClock;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number(millisecondRaw.padEnd(3, "0"));
  const target = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const targetDate = new Date(target);
  if (
    targetDate.getUTCFullYear() !== year || targetDate.getUTCMonth() !== month - 1 ||
    targetDate.getUTCDate() !== day || targetDate.getUTCHours() !== hour ||
    targetDate.getUTCMinutes() !== minute || targetDate.getUTCSeconds() !== second
  ) return new Date(Number.NaN);

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: offsetlessTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let guess = target;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value ?? Number.NaN);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"), millisecond);
    if (!Number.isFinite(represented)) return new Date(Number.NaN);
    guess -= represented - target;
  }
  return new Date(guess);
}

function normalizeDirection(value: string | undefined): ViptelActiveCall["direction"] {
  const normalized = value?.toLowerCase() ?? "";

  if (normalized.includes("out")) {
    return "outbound";
  }

  if (normalized.includes("internal")) {
    return "internal";
  }

  return "inbound";
}

function normalizeProviderCallStatus(value: string | undefined, direction: ViptelActiveCall["direction"]): ViptelActiveCall["status"] {
  const normalized = value?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";

  if (normalized.includes("fail") || normalized.includes("busy") || normalized.includes("error")) {
    return "failed";
  }

  if (normalized.includes("miss") || normalized.includes("noanswer")) {
    return "missed";
  }

  if (normalized.includes("abandon")) {
    return "abandoned_queue";
  }

  if (normalized.includes("end") || normalized.includes("hangup") || normalized.includes("complete")) {
    return "ended";
  }

  // Composite provider values such as `queue_active` or `ringing-active`
  // still describe a waiting offer. Test those before the generic `active`
  // marker so a ringing call does not disappear from the shared waiting room.
  if (normalized.includes("ring") || normalized.includes("queue") || normalized.includes("wait")) {
    return "ringing_agent";
  }

  if (normalized.includes("answer") || normalized.includes("bridge") || normalized === "up" || normalized.includes("active")) {
    return "answered";
  }

  return direction === "outbound" ? "outbound" : "incoming";
}

function extractOutboundCallerIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string" || typeof item === "number") {
        return [String(item)];
      }

      const record = asRecord(item);
      return [record.outboundcid, record.number, record.caller_id, record.phone_number, record.value].flatMap((candidate) =>
        candidate === undefined || candidate === null ? [] : [String(candidate)],
      );
    });
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function parseJson(text: string) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function configuredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value || value.startsWith("replace-with")) {
    return undefined;
  }

  return value;
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function withTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function summarizeProviderResponse(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.slice(0, 240);
  }

  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }

  if (typeof value === "object") {
    return { type: "object", keys: Object.keys(value).slice(0, 12) };
  }

  return value;
}
