/**
 * Pure state machine of the browser phone (design §4 Phase 2 `webphone-model.ts`).
 *
 * Everything that can be reasoned about without a WebSocket, a microphone or a
 * DOM lives here so it can be tested in the repo's node-only Vitest setup:
 * when to mint a token, when to reconnect, when a tab must give up because a
 * newer tab took the credential, and which incoming invite belongs to a dial
 * this tab just started.
 *
 * `telnyx-webphone.ts` is the thin browser shell around it: it performs the
 * effects this reducer asks for and feeds the resulting events back in.
 */

import { nextBackoffDelayMs } from "@/lib/telephony/client-request";

/** Heartbeat cadence for `POST /api/telephony/devices/heartbeat` (server window is 120 s). */
export const WEBPHONE_HEARTBEAT_MS = 30_000;

/** Never re-mint more often than this, however short the token is. */
export const TOKEN_REFRESH_MIN_MS = 60_000;
/** Nor sit on one longer than this, however long Telnyx says it is valid. */
export const TOKEN_REFRESH_MAX_MS = 6 * 60 * 60 * 1_000;
/** Re-mint this long before `exp` when 50 % of the lifetime is already gone. */
export const TOKEN_REFRESH_SKEW_MS = 30_000;

export const WEBPHONE_RECONNECT_BASE_MS = 2_000;
export const WEBPHONE_RECONNECT_MAX_MS = 60_000;
/** A dial we started stops being interesting after this long without an invite. */
export const EXPECTED_LEG_TTL_MS = 90_000;

export type WebphoneStatus =
  /** Nothing started yet (or `stop` was called). */
  | "idle"
  /** Waiting for `POST /api/telephony/webphone/token`. */
  | "requesting_token"
  /** Token in hand, the SDK is opening its socket / registering. */
  | "connecting"
  /** Registered: this tab can receive invites. */
  | "registered"
  /** Lost the socket or the token, waiting out a backoff before retrying. */
  | "reconnecting"
  /** Another tab minted a newer token; this tab is intentionally dead. */
  | "superseded"
  /** The deployment has no Telnyx configuration (token route answered 503). */
  | "not_configured"
  /** Retries are exhausted or the server refused for a reason retrying cannot fix. */
  | "failed";

export type WebphoneCredentials = {
  token: string;
  /** ISO timestamp from the token route (decoded `exp`). */
  expiresAt: string;
  deviceSessionId: string;
  sipUsername: string;
};

export type WebphoneState = {
  status: WebphoneStatus;
  /** Consecutive failures since the last successful registration. */
  attempts: number;
  credentials: WebphoneCredentials | null;
  /** Slovak, operator-facing explanation of the current status. */
  message: string | null;
};

export type WebphoneEvent =
  | { type: "start" }
  | { type: "stop" }
  | { type: "token_issued"; credentials: WebphoneCredentials }
  /** `status` is the HTTP status of the token route (0 for a transport failure). */
  | { type: "token_rejected"; status: number; message?: string | null }
  | { type: "client_ready" }
  | { type: "client_error"; message?: string | null; authFailure?: boolean }
  | { type: "socket_closed" }
  /** The refresh timer fired: mint a new token for the same registration. */
  | { type: "token_expiring" }
  /** The heartbeat came back 409: a newer tab owns the credential. */
  | { type: "superseded"; message?: string | null };

export type WebphoneEffect =
  | { kind: "mint_token" }
  | { kind: "connect"; credentials: WebphoneCredentials }
  | { kind: "disconnect" }
  /** Retry the whole connect sequence after `delayMs`. */
  | { kind: "retry_after"; delayMs: number }
  /** Mint the next token after `delayMs` (the socket stays up meanwhile). */
  | { kind: "refresh_after"; delayMs: number }
  /** Cancel every pending timer. */
  | { kind: "clear_timers" };

export type WebphoneReduceResult = {
  state: WebphoneState;
  effects: WebphoneEffect[];
};

export const WEBPHONE_INITIAL_STATE: WebphoneState = {
  status: "idle",
  attempts: 0,
  credentials: null,
  message: null,
};

const SUPERSEDED_MESSAGE = "Telefón je prihlásený v inom okne.";
const NOT_CONFIGURED_MESSAGE = "Telefónia nie je nakonfigurovaná.";
const FORBIDDEN_MESSAGE = "Prihlásený účet nemá telefón dispečingu.";
export const TAKEOVER_MESSAGE = "Telefón je prihlásený v inom okne a prebieha hovor.";

/** Terminal statuses: only an explicit `start` (a reload / new login) leaves them. */
export function isTerminalWebphoneStatus(status: WebphoneStatus): boolean {
  return status === "superseded" || status === "not_configured" || status === "failed";
}

export function webphoneIsLive(status: WebphoneStatus): boolean {
  return status === "registered";
}

/**
 * How long to wait before minting the next token: half of the remaining
 * lifetime, clamped, and never past `exp` minus a safety skew.
 */
export function tokenRefreshDelayMs(input: { expiresAt: string; now: number; minMs?: number; maxMs?: number }): number {
  const min = input.minMs ?? TOKEN_REFRESH_MIN_MS;
  const max = input.maxMs ?? TOKEN_REFRESH_MAX_MS;
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt)) return min;
  const remaining = expiresAt - input.now;
  // Already expired (clock skew, a very short token): mint again immediately,
  // but keep the floor so a broken `exp` cannot become a mint loop.
  if (remaining <= 0) return min;
  const half = Math.floor(remaining / 2);
  const beforeExpiry = remaining - TOKEN_REFRESH_SKEW_MS;
  return Math.max(min, Math.min(max, half, Math.max(min, beforeExpiry)));
}

export function webphoneRetryDelayMs(attempts: number, random?: () => number): number {
  return nextBackoffDelayMs({
    baseMs: WEBPHONE_RECONNECT_BASE_MS,
    consecutiveFailures: Math.max(1, attempts),
    maxMs: WEBPHONE_RECONNECT_MAX_MS,
    random,
  });
}

export function reduceWebphone(
  state: WebphoneState,
  event: WebphoneEvent,
  context: { now: number; random?: () => number },
): WebphoneReduceResult {
  switch (event.type) {
    case "start": {
      if (state.status === "requesting_token" || state.status === "connecting" || state.status === "registered") {
        return { state, effects: [] };
      }
      return {
        state: { status: "requesting_token", attempts: 0, credentials: null, message: null },
        effects: [{ kind: "clear_timers" }, { kind: "mint_token" }],
      };
    }

    case "stop": {
      if (state.status === "idle") return { state, effects: [] };
      return {
        state: { ...WEBPHONE_INITIAL_STATE },
        effects: [{ kind: "clear_timers" }, { kind: "disconnect" }],
      };
    }

    case "token_issued": {
      if (state.status === "idle" || isTerminalWebphoneStatus(state.status)) return { state, effects: [] };
      const refreshIn = tokenRefreshDelayMs({ expiresAt: event.credentials.expiresAt, now: context.now });
      return {
        state: {
          // A refresh while registered must not flap the pill back to
          // "connecting": the socket is still up, only the token is new.
          status: state.status === "registered" ? "registered" : "connecting",
          attempts: state.attempts,
          credentials: event.credentials,
          message: state.status === "registered" ? state.message : null,
        },
        effects: [{ kind: "connect", credentials: event.credentials }, { kind: "refresh_after", delayMs: refreshIn }],
      };
    }

    case "token_rejected": {
      if (state.status === "idle" || isTerminalWebphoneStatus(state.status)) return { state, effects: [] };
      if (event.status === 503) {
        return {
          state: { status: "not_configured", attempts: 0, credentials: null, message: event.message ?? NOT_CONFIGURED_MESSAGE },
          effects: [{ kind: "clear_timers" }, { kind: "disconnect" }],
        };
      }
      if (event.status === 403) {
        return {
          state: { status: "failed", attempts: 0, credentials: null, message: event.message ?? FORBIDDEN_MESSAGE },
          effects: [{ kind: "clear_timers" }, { kind: "disconnect" }],
        };
      }
      // 409: another tab holds the credential and is ringing / on a call.
      // Retrying cannot help; only an explicit takeover may proceed.
      if (event.status === 409) {
        return {
          state: { status: "failed", attempts: 0, credentials: null, message: event.message ?? TAKEOVER_MESSAGE },
          effects: [{ kind: "clear_timers" }, { kind: "disconnect" }],
        };
      }
      const attempts = state.attempts + 1;
      return {
        state: {
          status: "reconnecting",
          attempts,
          credentials: state.credentials,
          message: event.message ?? "Telefón sa nepodarilo prihlásiť, skúšam znova.",
        },
        effects: [{ kind: "clear_timers" }, { kind: "retry_after", delayMs: webphoneRetryDelayMs(attempts, context.random) }],
      };
    }

    case "client_ready": {
      if (state.status === "idle" || isTerminalWebphoneStatus(state.status)) return { state, effects: [] };
      return {
        state: { status: "registered", attempts: 0, credentials: state.credentials, message: null },
        effects: [],
      };
    }

    case "client_error":
    case "socket_closed": {
      if (state.status === "idle" || isTerminalWebphoneStatus(state.status)) return { state, effects: [] };
      const attempts = state.attempts + 1;
      const message =
        (event.type === "client_error" ? event.message : null) ?? "Spojenie telefónu vypadlo, obnovujem ho.";
      return {
        state: {
          status: "reconnecting",
          attempts,
          // An auth failure means the token is the problem: drop it so the
          // retry mints a fresh one rather than replaying the rejected JWT.
          credentials: event.type === "client_error" && event.authFailure ? null : state.credentials,
          message,
        },
        effects: [
          { kind: "clear_timers" },
          { kind: "disconnect" },
          { kind: "retry_after", delayMs: webphoneRetryDelayMs(attempts, context.random) },
        ],
      };
    }

    case "token_expiring": {
      if (state.status === "idle" || isTerminalWebphoneStatus(state.status)) return { state, effects: [] };
      return { state, effects: [{ kind: "mint_token" }] };
    }

    case "superseded": {
      if (state.status === "idle") return { state, effects: [] };
      return {
        state: { status: "superseded", attempts: 0, credentials: null, message: event.message ?? SUPERSEDED_MESSAGE },
        effects: [{ kind: "clear_timers" }, { kind: "disconnect" }],
      };
    }

    default: {
      // Exhaustive: every event above is handled.
      return { state, effects: [] };
    }
  }
}

// --- registration presentation ----------------------------------------------

export type WebphoneRegistrationView = {
  status: WebphoneStatus;
  label: string;
  tone: "ok" | "warn" | "error" | "neutral";
  detail: string;
};

const REGISTRATION_LABELS: Record<WebphoneStatus, { label: string; tone: WebphoneRegistrationView["tone"]; detail: string }> = {
  idle: { label: "Telefón vypnutý", tone: "neutral", detail: "Telefón v prehliadači nie je spustený." },
  requesting_token: { label: "Prihlasujem…", tone: "warn", detail: "Získavam prihlasovací token telefónu." },
  connecting: { label: "Pripájam…", tone: "warn", detail: "Telefón sa pripája k Telnyxu." },
  registered: { label: "Registrované", tone: "ok", detail: "Telefón je pripojený a môže prijímať hovory." },
  reconnecting: { label: "Obnovujem spojenie…", tone: "warn", detail: "Spojenie telefónu vypadlo, obnovujem ho." },
  superseded: { label: "Iné okno", tone: "error", detail: SUPERSEDED_MESSAGE },
  not_configured: { label: "Nenakonfigurované", tone: "neutral", detail: NOT_CONFIGURED_MESSAGE },
  failed: { label: "Telefón nedostupný", tone: "error", detail: "Telefón sa nepodarilo prihlásiť." },
};

export function webphoneRegistrationView(state: Pick<WebphoneState, "status" | "message">): WebphoneRegistrationView {
  const base = REGISTRATION_LABELS[state.status];
  return { status: state.status, label: base.label, tone: base.tone, detail: state.message ?? base.detail };
}

/** Heartbeat registration state reported to the server (`motorist_operator_devices`). */
export function heartbeatRegistrationState(status: WebphoneStatus): "registered" | "registering" | "unregistered" | "error" {
  switch (status) {
    case "registered":
      return "registered";
    case "requesting_token":
    case "connecting":
    case "reconnecting":
      return "registering";
    case "failed":
      return "error";
    default:
      return "unregistered";
  }
}

// --- auto-answer correlation -------------------------------------------------

export type ExpectedOperatorLeg = {
  /** `operatorLegCallControlId` returned by `POST /api/telephony/calls`. */
  callControlId: string;
  sessionId: string;
  /** Epoch ms when the dial was started. */
  at: number;
};

export type InviteIdentity = {
  telnyxCallControlId?: string | null;
  telnyxSessionId?: string | null;
  telnyxLegId?: string | null;
  customHeaders?: Array<{ name?: string | null; value?: string | null }> | null;
};

export function rememberExpectedLeg(
  expected: readonly ExpectedOperatorLeg[],
  next: ExpectedOperatorLeg,
  now: number,
): ExpectedOperatorLeg[] {
  return [...pruneExpectedLegs(expected, now).filter((entry) => entry.callControlId !== next.callControlId), next];
}

export function pruneExpectedLegs(expected: readonly ExpectedOperatorLeg[], now: number): ExpectedOperatorLeg[] {
  return expected.filter((entry) => now - entry.at < EXPECTED_LEG_TTL_MS);
}

/**
 * Decides whether an incoming invite is the operator leg of a dial this tab
 * started. `telnyxIDs.telnyxCallControlId` is the primary discriminator (design
 * §2.2); the `X-PM-Auto-Answer` custom header is only a fallback hint and never
 * auto-answers on its own, because it carries no session identity.
 */
export function matchExpectedLeg(
  expected: readonly ExpectedOperatorLeg[],
  invite: InviteIdentity,
  now: number,
): ExpectedOperatorLeg | null {
  const callControlId = invite.telnyxCallControlId?.trim();
  if (!callControlId) return null;
  return pruneExpectedLegs(expected, now).find((entry) => entry.callControlId === callControlId) ?? null;
}

export function inviteHasAutoAnswerHeader(invite: InviteIdentity): boolean {
  return (invite.customHeaders ?? []).some(
    (header) => header?.name?.toLowerCase() === "x-pm-auto-answer" && header?.value === "1",
  );
}
