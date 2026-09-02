"use client";

export const DEFAULT_WORKPLACE_HEARTBEAT_INTERVAL_MS = 15_000;
const WORKPLACE_RESUME_STORAGE_PREFIX = "motorist.workplace.resume.v1";
const WORKPLACE_PENDING_MUTATION_STORAGE_KEY = "motorist.workplace.pending-mutation.v1";
const WORKPLACE_PENDING_RESUME_STORAGE_KEY = "motorist.workplace.pending-resume.v1";
const WORKPLACE_LEADER_CHANNEL_PREFIX = "motorist-workplace-leader-v1";
const FALLBACK_LEADER_PULSE_MS = 2_000;
const FALLBACK_LEADER_STALE_MS = 5_000;
const WORKPLACE_PENDING_MUTATION_MAX_AGE_MS = 10 * 60_000;
const inMemoryResumeCredentials = new Map<string, WorkplaceResumeCredential>();
let inMemoryPendingMutation: WorkplacePendingMutation | null = null;
let inMemoryPendingResume: WorkplacePendingResume | null = null;
let ignorePersistedPendingMutation = false;
let ignorePersistedPendingResume = false;

export type WorkplaceLease = {
  assignmentGeneration: string;
  extension: string;
  expiresAt: string;
  heartbeatIntervalMs: number;
  leaderEpoch: number;
  leaseId: string;
  leaseVersion: number;
  seatId: string;
};

export type WorkplaceLeasePresenceOutcome =
  | { kind: "confirmed"; lease?: WorkplaceLease; resumeSecret?: string }
  | { kind: "transitioning"; message: string }
  | { kind: "lease_lost"; message: string }
  | { kind: "retryable"; message: string };

export type WorkplaceMutationResponseDisposition =
  | { kind: "confirmed" }
  | { kind: "convergence_pending"; code: "workplace_source_unregister_pending"; message?: string }
  | { kind: "terminal"; code?: string; message?: string }
  | { kind: "transport_ambiguous"; message?: string };

const WORKPLACE_ALWAYS_TERMINAL_MUTATION_CODES = new Set([
  "hotdesk_claims_disabled",
  "hotdesk_disabled",
  "hotdesk_resume_key_missing",
  "lease_lost",
  // Both arrive on 5xx statuses and are definite refusals, not lost
  // responses: the snapshot command was already marked failed, or the
  // precommit was already rolled back. Classifying them by status alone
  // armed the exact-replay journal for a request that could never succeed,
  // which blocked every other workplace action behind it.
  "provider_snapshot_unavailable",
  "workplace_precommit_aborted",
]);

const WORKPLACE_TERMINAL_CONFLICT_CODES = new Set([
  "WORKPLACE_TRANSITION_RECOVERY_REQUIRED",
  "queue_probe_evidence_mismatch",
  "queue_probe_scope_mismatch",
  "queue_probe_waiting_calls",
  "queue_probe_window_closed",
  "queue_vacate_not_verified",
  "workplace_bootstrap_required",
  "workplace_conflict",
  "workplace_operation_superseded",
  "workplace_precommit_aborted",
  "workplace_recovery_required",
]);

export type WorkplaceDocumentLeaderState = "starting" | "leader" | "follower" | "stopped";

type WorkplaceResumeCredential = {
  browserInstanceId: string;
  leaseId: string;
  resumeSecret: string;
};

export type WorkplacePendingMutation = {
  action: "confirm_seat_change" | "leave_seat" | "select_seat";
  actorProfileId: string;
  attempts: number;
  browserDisconnectOutcome?: "accepted" | "not_connected";
  browserInstanceId: string;
  createdAt: number;
  expectedVersion?: string;
  extension?: string;
  idempotencyKey: string;
  kind: "leave" | "select";
  organizationId?: string;
  operationId?: string;
  phase: "finalize" | "prepare";
};

export type WorkplacePendingResume = {
  actorProfileId: string;
  assignmentGeneration: string;
  attempts: number;
  browserInstanceId: string;
  createdAt: number;
  idempotencyKey: string;
  leaderEpoch: number;
  leaseId: string;
  leaseVersion: number;
  organizationId?: string;
  resumeSecret: string;
};

type WorkplaceLeaderMessage = {
  at: number;
  browserInstanceId: string;
  kind: "candidate" | "leader" | "lease_lost" | "stopped";
};

type WorkplaceBroadcastChannel = {
  close: () => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: WorkplaceLeaderMessage) => void;
};

export type WorkplaceDocumentLeaderRuntime = {
  createChannel?: (name: string) => WorkplaceBroadcastChannel | null;
  now?: () => number;
  requestLock?: (
    name: string,
    hold: () => Promise<void>,
  ) => Promise<"acquired" | "unavailable" | "unsupported">;
  setInterval?: (callback: () => void, intervalMs: number) => ReturnType<typeof globalThis.setInterval>;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  clearInterval?: (timer: ReturnType<typeof globalThis.setInterval>) => void;
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
};

type WorkplaceHeartbeatWorker = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: { intervalMs: number; kind: "start" } | { kind: "stop" }) => void;
  terminate: () => void;
};

export function startWorkplaceHeartbeatLoop(input: {
  intervalMs: number;
  pulse: () => void;
  createWorker?: () => WorkplaceHeartbeatWorker | null;
  setInterval?: (callback: () => void, intervalMs: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval?: (timer: ReturnType<typeof globalThis.setInterval>) => void;
}) {
  const intervalMs = Math.max(5_000, input.intervalMs);
  const worker = (input.createWorker ?? createDefaultHeartbeatWorker)();
  if (worker) {
    worker.onmessage = (event) => {
      if (isRecord(event.data) && event.data.kind === "pulse") input.pulse();
    };
    worker.postMessage({ intervalMs, kind: "start" });
    return () => {
      worker.onmessage = null;
      worker.postMessage({ kind: "stop" });
      worker.terminate();
    };
  }

  const schedule = input.setInterval ?? ((callback, intervalMs) => globalThis.setInterval(callback, intervalMs));
  const clear = input.clearInterval ?? ((timer) => globalThis.clearInterval(timer));
  input.pulse();
  const timer = schedule(input.pulse, intervalMs);
  return () => clear(timer);
}

function createDefaultHeartbeatWorker(): WorkplaceHeartbeatWorker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker("/workplace-heartbeat-worker.js", { name: "motorist-workplace-heartbeat" });
  } catch {
    // Older or policy-restricted browsers keep the original main-thread loop.
    return null;
  }
}

export function createWorkplaceBrowserInstanceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  throw new Error("Tento prehliadač nevie bezpečne vytvoriť identifikátor pracovného miesta.");
}

export function normalizeWorkplaceLease(value: unknown): WorkplaceLease | null {
  if (!isRecord(value)) return null;
  const assignmentGeneration = stringValue(value.assignmentGeneration) ?? stringValue(value.generation);
  const extension = stringValue(value.extension);
  const expiresAt = stringValue(value.expiresAt);
  const leaseId = stringValue(value.leaseId);
  const seatId = stringValue(value.seatId) ?? extension;
  const heartbeatIntervalMs = positiveInteger(value.heartbeatIntervalMs) ?? DEFAULT_WORKPLACE_HEARTBEAT_INTERVAL_MS;
  const leaderEpoch = nonNegativeInteger(value.leaderEpoch) ?? 0;
  const leaseVersion = positiveInteger(value.leaseVersion) ?? 1;

  if (!assignmentGeneration || !extension || !expiresAt || !leaseId || !seatId) return null;
  return {
    assignmentGeneration,
    extension,
    expiresAt,
    heartbeatIntervalMs,
    leaderEpoch,
    leaseId,
    leaseVersion,
    seatId,
  };
}

export function classifyWorkplacePresenceResponse(
  status: number,
  body: unknown,
): WorkplaceLeasePresenceOutcome {
  const record = isRecord(body) ? body : {};
  const code = stringValue(record.code) ?? stringValue(record.errorCode);
  const message = stringValue(record.error) ?? stringValue(record.message);

  if (code === "lease_lost" || status === 410 || (status === 409 && code !== "lease_transitioning")) {
    return {
      kind: "lease_lost",
      message: message ?? "Toto pracovné miesto už používa iné okno alebo iný operátor.",
    };
  }
  if (code === "lease_transitioning" || status === 423) {
    return {
      kind: "transitioning",
      message: message ?? "Zmena pracovného miesta sa práve bezpečne dokončuje.",
    };
  }
  if (status >= 200 && status < 300 && record.ok !== false) {
    return {
      kind: "confirmed",
      lease: normalizeWorkplaceLease(record.lease) ?? undefined,
      resumeSecret: stringValue(record.resumeSecret),
    };
  }
  return {
    kind: "retryable",
    message: message ?? "Spojenie pracovného miesta sa nepodarilo obnoviť. Skúsime to znova.",
  };
}

/**
 * Separates a response whose outcome is known from a response that may have
 * been lost after the server committed it. Only the latter may keep and replay
 * the exact pending-mutation journal.
 */
export function classifyWorkplaceMutationResponse(
  status: number,
  body: unknown,
): WorkplaceMutationResponseDisposition {
  if (!isRecord(body)) {
    return {
      kind: "transport_ambiguous",
      message: "Server nevrátil čitateľnú odpoveď na zmenu pracovného miesta.",
    };
  }
  const code = stringValue(body.code) ?? stringValue(body.errorCode);
  const message = stringValue(body.error) ?? stringValue(body.message);
  const ok = status >= 200 && status < 300 && body.ok !== false;
  if (ok) return { kind: "confirmed" };
  if (status === 423 && code === "workplace_source_unregister_pending") {
    return {
      kind: "convergence_pending",
      code,
      ...(message ? { message } : {}),
    };
  }

  if (
    (code && WORKPLACE_ALWAYS_TERMINAL_MUTATION_CODES.has(code)) ||
    (status === 409 && code && WORKPLACE_TERMINAL_CONFLICT_CODES.has(code)) ||
    status === 409 ||
    (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 423 && status !== 429)
  ) {
    return { kind: "terminal", ...(code ? { code } : {}), ...(message ? { message } : {}) };
  }

  if (status === 408 || status === 423 || status === 429 || status >= 500) {
    return { kind: "transport_ambiguous", ...(message ? { message } : {}) };
  }

  return { kind: "terminal", ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

export function readWorkplaceResumeCredential(leaseId: string): WorkplaceResumeCredential | null {
  const inMemory = inMemoryResumeCredentials.get(leaseId);
  if (inMemory) return inMemory;
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(resumeStorageKey(leaseId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const browserInstanceId = stringValue(parsed.browserInstanceId);
    const storedLeaseId = stringValue(parsed.leaseId);
    const resumeSecret = stringValue(parsed.resumeSecret);
    if (!browserInstanceId || storedLeaseId !== leaseId || !resumeSecret) return null;
    const credential = { browserInstanceId, leaseId: storedLeaseId, resumeSecret };
    inMemoryResumeCredentials.set(leaseId, credential);
    return credential;
  } catch {
    return null;
  }
}

export function storeWorkplaceResumeCredential(
  leaseId: string,
  browserInstanceId: string,
  resumeSecret: string,
) {
  if (!leaseId || !browserInstanceId || !resumeSecret) return false;
  const credential = { browserInstanceId, leaseId, resumeSecret } satisfies WorkplaceResumeCredential;
  inMemoryResumeCredentials.set(leaseId, credential);
  if (typeof sessionStorage === "undefined") return false;
  try {
    sessionStorage.setItem(resumeStorageKey(leaseId), JSON.stringify(credential));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkplaceResumeCredential(leaseId: string) {
  if (!leaseId) return;
  inMemoryResumeCredentials.delete(leaseId);
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(resumeStorageKey(leaseId));
  } catch {
    // The in-memory credential is already cleared; storage denial must not break cleanup.
  }
}

export function readWorkplacePendingMutation(): WorkplacePendingMutation | null {
  if (inMemoryPendingMutation) {
    if (Date.now() - inMemoryPendingMutation.createdAt <= WORKPLACE_PENDING_MUTATION_MAX_AGE_MS) {
      return inMemoryPendingMutation;
    }
    clearWorkplacePendingMutation();
  }
  if (ignorePersistedPendingMutation) return null;
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(WORKPLACE_PENDING_MUTATION_STORAGE_KEY);
    if (!raw) return null;
    const pending = normalizePendingMutation(JSON.parse(raw) as unknown);
    if (!pending || Date.now() - pending.createdAt > WORKPLACE_PENDING_MUTATION_MAX_AGE_MS) {
      clearWorkplacePendingMutation();
      return null;
    }
    inMemoryPendingMutation = pending;
    return pending;
  } catch {
    return null;
  }
}

export function storeWorkplacePendingMutation(pending: WorkplacePendingMutation) {
  ignorePersistedPendingMutation = false;
  inMemoryPendingMutation = pending;
  if (typeof sessionStorage === "undefined") return false;
  try {
    sessionStorage.setItem(WORKPLACE_PENDING_MUTATION_STORAGE_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkplacePendingMutation(options: { persistent?: boolean } = {}) {
  inMemoryPendingMutation = null;
  ignorePersistedPendingMutation = options.persistent === false;
  if (options.persistent === false || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(WORKPLACE_PENDING_MUTATION_STORAGE_KEY);
  } catch {
    // Best effort only. A persisted exact request is safer than inventing a new one.
  }
}

export function readWorkplacePendingResume(): WorkplacePendingResume | null {
  if (inMemoryPendingResume) {
    if (Date.now() - inMemoryPendingResume.createdAt <= WORKPLACE_PENDING_MUTATION_MAX_AGE_MS) {
      return inMemoryPendingResume;
    }
    clearWorkplacePendingResume();
  }
  if (ignorePersistedPendingResume) return null;
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(WORKPLACE_PENDING_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const pending = normalizePendingResume(JSON.parse(raw) as unknown);
    if (!pending || Date.now() - pending.createdAt > WORKPLACE_PENDING_MUTATION_MAX_AGE_MS) {
      clearWorkplacePendingResume();
      return null;
    }
    inMemoryPendingResume = pending;
    return pending;
  } catch {
    return null;
  }
}

export function storeWorkplacePendingResume(pending: WorkplacePendingResume) {
  ignorePersistedPendingResume = false;
  inMemoryPendingResume = pending;
  if (typeof sessionStorage === "undefined") return false;
  try {
    sessionStorage.setItem(WORKPLACE_PENDING_RESUME_STORAGE_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkplacePendingResume(options: { persistent?: boolean } = {}) {
  inMemoryPendingResume = null;
  ignorePersistedPendingResume = options.persistent === false;
  if (options.persistent === false || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(WORKPLACE_PENDING_RESUME_STORAGE_KEY);
  } catch {
    // Retaining the original exact resume is safer than inventing a replacement request.
  }
}

export class WorkplaceDocumentLeader {
  private readonly browserInstanceId: string;
  private readonly leaseId: string;
  private readonly runtime: Required<Pick<WorkplaceDocumentLeaderRuntime,
    "now" | "setInterval" | "setTimeout" | "clearInterval" | "clearTimeout"
  >> & WorkplaceDocumentLeaderRuntime;
  private readonly listeners = new Set<(state: WorkplaceDocumentLeaderState) => void>();
  private channel: WorkplaceBroadcastChannel | null = null;
  private state: WorkplaceDocumentLeaderState = "starting";
  private stopped = false;
  private fallbackLeaderId: string | null = null;
  private fallbackLeaderSeenAt = 0;
  private usingWebLock = false;
  private candidates = new Set<string>();
  private electionTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private retryTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private pulseTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private releaseLock: (() => void) | null = null;

  constructor(
    input: { browserInstanceId: string; leaseId: string },
    runtime: WorkplaceDocumentLeaderRuntime = {},
  ) {
    this.browserInstanceId = input.browserInstanceId;
    this.leaseId = input.leaseId;
    this.runtime = {
      ...runtime,
      now: runtime.now ?? (() => Date.now()),
      setInterval: runtime.setInterval ?? ((callback, intervalMs) => globalThis.setInterval(callback, intervalMs)),
      setTimeout: runtime.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs)),
      clearInterval: runtime.clearInterval ?? ((timer) => globalThis.clearInterval(timer)),
      clearTimeout: runtime.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer)),
    };
  }

  get currentState() {
    return this.state;
  }

  subscribe(listener: (state: WorkplaceDocumentLeaderState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start() {
    if (this.stopped || this.channel) return;
    this.channel = (this.runtime.createChannel ?? defaultChannelFactory)(
      `${WORKPLACE_LEADER_CHANNEL_PREFIX}:${this.leaseId}`,
    );
    if (this.channel) this.channel.onmessage = (event) => this.onMessage(event.data);
    void this.tryAcquireLeadership();
  }

  announceLeaseLost() {
    this.post("lease_lost");
    this.updateState("follower");
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.post("stopped");
    this.releaseLock?.();
    this.releaseLock = null;
    this.clearTimers();
    this.channel?.close();
    this.channel = null;
    this.updateState("stopped");
  }

  private async tryAcquireLeadership() {
    if (this.stopped) return;
    const requestLock = this.runtime.requestLock ?? defaultLockRequester;
    const lockResult = await requestLock(
      `${WORKPLACE_LEADER_CHANNEL_PREFIX}:${this.leaseId}`,
      () => new Promise<void>((resolve) => {
        this.releaseLock = resolve;
      }),
    ).catch(() => "unsupported" as const);
    if (this.stopped) return;
    if (lockResult === "acquired") {
      this.usingWebLock = true;
      this.becomeLeader();
      return;
    }
    if (lockResult === "unavailable") {
      this.usingWebLock = true;
      this.updateState("follower");
      this.startLockRetry();
      return;
    }
    this.startFallbackElection();
  }

  private startLockRetry() {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = this.runtime.setInterval(() => {
      if (this.stopped || this.state === "leader") return;
      void this.tryAcquireLeadership();
    }, FALLBACK_LEADER_PULSE_MS);
  }

  private startFallbackElection() {
    if (this.stopped) return;
    this.candidates.add(this.browserInstanceId);
    this.post("candidate");
    if (this.electionTimer) this.runtime.clearTimeout(this.electionTimer);
    this.electionTimer = this.runtime.setTimeout(() => {
      this.electionTimer = null;
      const leader = [...this.candidates].sort()[0] ?? this.browserInstanceId;
      this.fallbackLeaderId = leader;
      if (leader === this.browserInstanceId) this.becomeLeader();
      else this.updateState("follower");
      this.startFallbackMonitor();
    }, 80);
  }

  private startFallbackMonitor() {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = this.runtime.setInterval(() => {
      if (this.stopped) return;
      if (this.state === "leader") {
        this.post("leader");
        return;
      }
      if (this.runtime.now() - this.fallbackLeaderSeenAt > FALLBACK_LEADER_STALE_MS) {
        this.candidates.clear();
        this.startFallbackElection();
      }
    }, FALLBACK_LEADER_PULSE_MS);
  }

  private becomeLeader() {
    if (this.stopped) return;
    this.fallbackLeaderId = this.browserInstanceId;
    this.fallbackLeaderSeenAt = this.runtime.now();
    this.updateState("leader");
    this.post("leader");
    if (!this.pulseTimer) {
      this.pulseTimer = this.runtime.setInterval(() => this.post("leader"), FALLBACK_LEADER_PULSE_MS);
    }
  }

  private onMessage(value: unknown) {
    if (!isLeaderMessage(value) || value.browserInstanceId === this.browserInstanceId) return;
    if (value.kind === "lease_lost") {
      this.updateState("follower");
      return;
    }
    if (value.kind === "candidate") {
      this.candidates.add(value.browserInstanceId);
      if (
        this.state === "leader" &&
        !this.usingWebLock &&
        value.browserInstanceId.localeCompare(this.browserInstanceId) < 0
      ) {
        this.releaseLock?.();
        this.releaseLock = null;
        this.updateState("follower");
      }
      this.post("leader");
      return;
    }
    if (value.kind === "leader") {
      this.fallbackLeaderSeenAt = this.runtime.now();
      this.fallbackLeaderId = value.browserInstanceId;
      if (!this.usingWebLock && value.browserInstanceId.localeCompare(this.browserInstanceId) < 0) {
        this.updateState("follower");
      }
      return;
    }
    if (value.kind === "stopped" && this.fallbackLeaderId === value.browserInstanceId) {
      this.fallbackLeaderSeenAt = 0;
    }
  }

  private post(kind: WorkplaceLeaderMessage["kind"]) {
    this.channel?.postMessage({
      at: this.runtime.now(),
      browserInstanceId: this.browserInstanceId,
      kind,
    });
  }

  private updateState(next: WorkplaceDocumentLeaderState) {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  private clearTimers() {
    if (this.electionTimer) this.runtime.clearTimeout(this.electionTimer);
    if (this.retryTimer) this.runtime.clearInterval(this.retryTimer);
    if (this.pulseTimer) this.runtime.clearInterval(this.pulseTimer);
    this.electionTimer = null;
    this.retryTimer = null;
    this.pulseTimer = null;
  }
}

function resumeStorageKey(leaseId: string) {
  return `${WORKPLACE_RESUME_STORAGE_PREFIX}:${leaseId}`;
}

function normalizePendingMutation(value: unknown): WorkplacePendingMutation | null {
  if (!isRecord(value)) return null;
  const action = stringValue(value.action);
  const actorProfileId = stringValue(value.actorProfileId);
  const attempts = nonNegativeInteger(value.attempts);
  const browserDisconnectOutcome = stringValue(value.browserDisconnectOutcome);
  const browserInstanceId = stringValue(value.browserInstanceId);
  const createdAt = nonNegativeInteger(value.createdAt);
  const expectedVersion = stringValue(value.expectedVersion);
  const extension = stringValue(value.extension);
  const idempotencyKey = stringValue(value.idempotencyKey);
  const kind = stringValue(value.kind);
  const operationId = stringValue(value.operationId);
  const organizationId = stringValue(value.organizationId);
  const phase = stringValue(value.phase);
  if (
    !["confirm_seat_change", "leave_seat", "select_seat"].includes(action ?? "") ||
    !actorProfileId ||
    attempts === undefined ||
    !browserInstanceId ||
    createdAt === undefined ||
    !idempotencyKey ||
    !["leave", "select"].includes(kind ?? "") ||
    !["finalize", "prepare"].includes(phase ?? "")
  ) return null;
  if (phase === "finalize" && (!operationId || action !== "confirm_seat_change")) return null;
  if (phase === "prepare" && action === "confirm_seat_change") return null;
  if (browserDisconnectOutcome && !["accepted", "not_connected"].includes(browserDisconnectOutcome)) return null;
  return {
    action: action as WorkplacePendingMutation["action"],
    actorProfileId,
    attempts,
    ...(browserDisconnectOutcome
      ? { browserDisconnectOutcome: browserDisconnectOutcome as NonNullable<WorkplacePendingMutation["browserDisconnectOutcome"]> }
      : {}),
    browserInstanceId,
    createdAt,
    idempotencyKey,
    kind: kind as WorkplacePendingMutation["kind"],
    phase: phase as WorkplacePendingMutation["phase"],
    ...(expectedVersion ? { expectedVersion } : {}),
    ...(extension ? { extension } : {}),
    ...(operationId ? { operationId } : {}),
    ...(organizationId ? { organizationId } : {}),
  };
}

function normalizePendingResume(value: unknown): WorkplacePendingResume | null {
  if (!isRecord(value)) return null;
  const actorProfileId = stringValue(value.actorProfileId);
  const assignmentGeneration = stringValue(value.assignmentGeneration);
  const attempts = nonNegativeInteger(value.attempts);
  const browserInstanceId = stringValue(value.browserInstanceId);
  const createdAt = nonNegativeInteger(value.createdAt);
  const idempotencyKey = stringValue(value.idempotencyKey);
  const leaderEpoch = nonNegativeInteger(value.leaderEpoch);
  const leaseId = stringValue(value.leaseId);
  const leaseVersion = positiveInteger(value.leaseVersion);
  const organizationId = stringValue(value.organizationId);
  const resumeSecret = stringValue(value.resumeSecret);
  if (
    !actorProfileId ||
    !assignmentGeneration ||
    attempts === undefined ||
    !browserInstanceId ||
    createdAt === undefined ||
    !idempotencyKey ||
    leaderEpoch === undefined ||
    !leaseId ||
    leaseVersion === undefined ||
    !resumeSecret
  ) return null;
  return {
    actorProfileId,
    assignmentGeneration,
    attempts,
    browserInstanceId,
    createdAt,
    idempotencyKey,
    leaderEpoch,
    leaseId,
    leaseVersion,
    ...(organizationId ? { organizationId } : {}),
    resumeSecret,
  };
}

function defaultChannelFactory(name: string): WorkplaceBroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(name);
}

async function defaultLockRequester(
  name: string,
  hold: () => Promise<void>,
): Promise<"acquired" | "unavailable" | "unsupported"> {
  if (!supportsWebLocks()) return "unsupported";
  return new Promise((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        resolve("unavailable");
        return;
      }
      resolve("acquired");
      await hold();
    }).catch(() => resolve("unsupported"));
  });
}

function supportsWebLocks() {
  return typeof navigator !== "undefined" && Boolean(navigator.locks?.request);
}

function isLeaderMessage(value: unknown): value is WorkplaceLeaderMessage {
  return isRecord(value) &&
    typeof value.at === "number" &&
    typeof value.browserInstanceId === "string" &&
    ["candidate", "leader", "lease_lost", "stopped"].includes(String(value.kind));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
