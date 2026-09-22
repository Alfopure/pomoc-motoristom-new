export class SessionLeaseLostError extends Error {
  constructor() {
    super("session lease unavailable during effects");
    this.name = "SessionLeaseLostError";
  }
}

export class SessionConflictError extends Error {
  constructor(readonly sessionId: string, readonly expectedVersion: number) {
    super(`session ${sessionId} changed (expected version ${expectedVersion})`);
    this.name = "SessionConflictError";
  }
}

export class CallActionError extends Error {
  constructor(
    message: string,
    readonly status = 500,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CallActionError";
  }
}

/** Work has not completed; provider events must remain eligible for redelivery. */
export class SessionEventDeferredError extends CallActionError {
  constructor(message: string, code = "session_event_deferred") {
    super(message, 503, code);
    this.name = "SessionEventDeferredError";
  }
}

export type SessionLeaseBusyDetails = {
  /** Budget the caller waited out, e.g. 3000, 8000 or 1200. */
  leaseWaitMs: number;
  /** Acquire RPCs issued before giving up. */
  polls: number;
  /** Actual elapsed acquisition time, including RPC time. */
  waitedMs?: number;
  /** `app.hangup`, `app.pickup`, `call.playback.ended`, ... when known. */
  eventType?: string;
};

/** The ownership RPC succeeded, but another invocation still owns this call. */
export class SessionLeaseBusyError extends SessionEventDeferredError {
  readonly retryAfterMs = 1_000;

  constructor(readonly details?: SessionLeaseBusyDetails) {
    super("Prebieha iná zmena hovoru. Skúste akciu o chvíľu.", "session_busy");
    this.name = "SessionLeaseBusyError";
  }
}

/**
 * `name: message` plus, for lease contention, the budget that ran out — the
 * text that goes into the webhook ledger (`finish_v2 p_error`) and the log
 * line. The operator-facing `message` stays the plain Slovak sentence.
 */
export function describeServiceError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const base = `${error.name}: ${error.message}`;
  if (error instanceof SessionLeaseBusyError && error.details) {
    const { leaseWaitMs, polls, eventType, waitedMs } = error.details;
    return `${base} [deferral=lease_busy lease_wait_ms=${leaseWaitMs} polls=${polls}${waitedMs === undefined ? "" : ` waited_ms=${waitedMs}`}${eventType ? ` event=${eventType}` : ""}]`;
  }
  if (error instanceof SessionEventDeferredError) return `${base} [deferral=${error instanceof SessionLeaseBusyError ? "lease_busy" : error.code}]`;
  return base;
}

export class SessionTerminationPendingError extends CallActionError {
  constructor() { super("Ukončenie niektorých vetiev sa ešte overuje.", 503, "provider_outcome_unknown"); }
}

export class PresenceServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PresenceServiceError";
  }
}

export class OperatorDeviceError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "OperatorDeviceError";
  }
}

export type ValidationIssue = { path: string; code: string; message: string };

export class ConfigServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(message: string, status = 400, code = "config_invalid", issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ConfigServiceError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}
