import { isUuid } from "@/lib/telephony/uuid";

import { commandId } from "../telnyx/command-id";
import { decodeClientState, encodeClientState } from "../telnyx/client-state";
import { AI_DEMO_INTENT_PREFIX, aiDemoLegOf, type AiDemoLeg } from "./flag";

/**
 * Identifiers that tie one demo attempt together across two providers.
 *
 * Nothing here is a permission. `client_state` and the SIP `From` display name
 * are routing hints Telnyx and OpenAI echo back to us, and the research is
 * explicit that SIP headers are untrusted caller metadata. The attempt row is
 * the authority: a webhook only ever *selects* a row that our own start
 * request already created.
 */

export type AiDemoLegRole = "external" | "customer";

/** `external` = the leg we dialled towards OpenAI, `customer` = the person's phone. */
export function aiDemoLegRole(leg: AiDemoLeg): AiDemoLegRole {
  return leg === "sip" ? "external" : "customer";
}

export function aiDemoClientState(attemptId: string, leg: AiDemoLeg): string {
  return encodeClientState({ sid: attemptId, role: aiDemoLegRole(leg), intent: `${AI_DEMO_INTENT_PREFIX}${leg}` });
}

export type ParsedAiDemoState = { attemptId: string; leg: AiDemoLeg };

/** Reads our own `client_state` back; `null` for anything that is not ours. */
export function parseAiDemoClientState(raw: unknown): ParsedAiDemoState | null {
  const state = decodeClientState(raw);
  if (!state) return null;
  const leg = aiDemoLegOf(state.intent);
  if (!leg || !isUuid(state.sid)) return null;
  return { attemptId: state.sid, leg };
}

export type AiDemoCommandIntent = "dial" | "hangup" | "orphan";

/**
 * Deterministic `command_id`. Telnyx drops a repeat of the same id on the same
 * call, so a redelivered webhook cannot dial or hang up twice.
 */
export function aiDemoCommandId(attemptId: string, leg: AiDemoLeg | "unknown", intent: AiDemoCommandIntent): string {
  return commandId({ sessionId: attemptId, legId: leg, step: 0, intent: `${AI_DEMO_INTENT_PREFIX}${intent}` });
}

/**
 * The SIP `From` display name we set on the OpenAI leg.
 *
 * OpenAI echoes `From` in `data.sip_headers`, so a mismatch is decisive
 * evidence that an `incoming` belongs to someone else's INVITE. It is used as a
 * negative filter only — a matching token grants nothing on its own.
 */
export function aiDemoCorrelationToken(attemptId: string): string {
  return `PM-AI-DEMO-${attemptId.replace(/-/g, "").slice(0, 8)}`;
}

export const AI_DEMO_TOKEN_PATTERN = /PM-AI-DEMO-[0-9a-f]{8}/;

/** Pulls the token out of a raw `From` header value (`"PM-AI-DEMO-1a2b" <sip:…>`). */
export function tokenFromHeader(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return AI_DEMO_TOKEN_PATTERN.exec(value)?.[0] ?? null;
}

/** `+421910988882` → `+421 910 ••• 882`; what the timeline and history show. */
export function maskNumber(e164: string | null | undefined): string | null {
  if (typeof e164 !== "string" || e164.length < 7) return null;
  return `${e164.slice(0, -6)}•••${e164.slice(-3)}`;
}
