import type { CallLegRole } from "@/lib/supabase/database.types";

/**
 * `client_state` is the opaque base64 blob Telnyx echoes on every webhook of a
 * leg. It is a routing hint only (session, role, operator, step, intent,
 * auto-answer); the database remains the source of truth. It is kept tiny —
 * the encoded form must fit in 200 bytes — so wire keys are single letters.
 */
export type TelnyxClientState = {
  /** `motorist_call_sessions.id`. */
  sid: string;
  role: CallLegRole;
  /** `motorist_profiles.id` for operator/consult/supervisor legs. */
  operatorId?: string;
  /** Ring step index this leg belongs to. */
  step?: number;
  /** Short intent label (`ring`, `consult`, `callback`, `simulate`…). */
  intent?: string;
  /** The browser auto-answers the invite for this leg (outbound click-to-call). */
  autoAnswer?: boolean;
};

export const CLIENT_STATE_MAX_BYTES = 200;
const MAX_ID_LENGTH = 64;
const MAX_INTENT_LENGTH = 32;

const ROLES: ReadonlySet<string> = new Set<CallLegRole>(["customer", "operator", "consult", "supervisor", "external"]);

type WireState = {
  s: string;
  r: string;
  o?: string;
  p?: number;
  i?: string;
  a?: 1;
};

export class ClientStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientStateError";
  }
}

function isPlainId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && /^[A-Za-z0-9:_.-]+$/.test(value);
}

function isIntent(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_INTENT_LENGTH && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function isStep(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999;
}

/** Validates an in-memory state object; throws `ClientStateError`. */
export function assertClientState(value: unknown): asserts value is TelnyxClientState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientStateError("client_state must be an object");
  }
  const state = value as Record<string, unknown>;
  if (!isPlainId(state.sid)) throw new ClientStateError("client_state.sid is required");
  if (typeof state.role !== "string" || !ROLES.has(state.role)) throw new ClientStateError("client_state.role is invalid");
  if (state.operatorId !== undefined && !isPlainId(state.operatorId)) throw new ClientStateError("client_state.operatorId is invalid");
  if (state.step !== undefined && !isStep(state.step)) throw new ClientStateError("client_state.step is invalid");
  if (state.intent !== undefined && !isIntent(state.intent)) throw new ClientStateError("client_state.intent is invalid");
  if (state.autoAnswer !== undefined && typeof state.autoAnswer !== "boolean") {
    throw new ClientStateError("client_state.autoAnswer is invalid");
  }
}

/** Encodes to the base64 string expected by Telnyx; throws when over budget. */
export function encodeClientState(state: TelnyxClientState): string {
  assertClientState(state);
  const wire: WireState = { s: state.sid, r: state.role };
  if (state.operatorId !== undefined) wire.o = state.operatorId;
  if (state.step !== undefined) wire.p = state.step;
  if (state.intent !== undefined) wire.i = state.intent;
  if (state.autoAnswer) wire.a = 1;

  const encoded = Buffer.from(JSON.stringify(wire), "utf8").toString("base64");
  if (encoded.length > CLIENT_STATE_MAX_BYTES) {
    throw new ClientStateError(`client_state exceeds ${CLIENT_STATE_MAX_BYTES} bytes`);
  }
  return encoded;
}

/**
 * Decodes a webhook `client_state`. Returns `null` for absent, foreign or
 * malformed values so that a poisoned state can never crash the processor.
 */
export function decodeClientState(value: unknown): TelnyxClientState | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CLIENT_STATE_MAX_BYTES + 8) return null;

  let parsed: unknown;
  try {
    const json = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const wire = parsed as Record<string, unknown>;

  const state: TelnyxClientState = { sid: String(wire.s ?? ""), role: String(wire.r ?? "") as CallLegRole };
  if (wire.o !== undefined) state.operatorId = wire.o as string;
  if (wire.p !== undefined) state.step = wire.p as number;
  if (wire.i !== undefined) state.intent = wire.i as string;
  if (wire.a !== undefined) {
    if (wire.a !== 1 && wire.a !== true) return null;
    state.autoAnswer = true;
  }

  try {
    assertClientState(state);
  } catch {
    return null;
  }
  return state;
}
