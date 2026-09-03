/**
 * Pure model behind `MyPhonePanel.tsx` (plan "Fáza 3": prezencia s dôvodom
 * pauzy, testovací hovor, výber audio zariadenia).
 *
 * This is the operator's own view of the telephony stack, so every rule here
 * mirrors a server rule they will otherwise meet as an error: a manual presence
 * change is refused during a call (`setPresence`, 409), wrap-up ends by itself
 * at `wrap_up_until` (`effectivePresenceStatus`), and a dialled number must be
 * E.164 inside the organisation's destination allowlist (`normalizeDestination`).
 */

import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";
import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { LineDoc, OperatorDoc, PauseReasonDoc, RoutingDocument } from "@/server/telephony/config-service";

import { formatCallTimer } from "./phone-bar-model";

export type MyPresence = {
  profileId: string;
  status: OperatorPresenceStatus;
  pauseReasonId: string | null;
  currentSessionId: string | null;
  wrapUpUntil: string | null;
  statusSince: string | null;
};

/** Shape of `GET /api/telephony/presence` this panel consumes. */
export type MyPresenceResponse = {
  snapshot?: { actorProfileId?: string } | null;
  own?: MyPresence | null;
  error?: string;
};

export type PresenceTone = "success" | "warning" | "info" | "neutral";

export const PRESENCE_LABELS: Record<OperatorPresenceStatus, string> = {
  available: "Dostupný",
  ringing: "Zvoní",
  on_call: "Na hovore",
  after_call_work: "Dopisuje",
  paused: "Pauza",
  offline: "Odhlásený",
};

export function presenceLabel(status: OperatorPresenceStatus | null | undefined): string {
  if (!status) return "Neznámy stav";
  return PRESENCE_LABELS[status] ?? status;
}

export function presenceTone(status: OperatorPresenceStatus | null | undefined): PresenceTone {
  switch (status) {
    case "available":
      return "success";
    case "ringing":
    case "on_call":
      return "info";
    case "paused":
    case "after_call_work":
      return "warning";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Wrap-up
// ---------------------------------------------------------------------------

/**
 * Seconds left of after-call work, `0` once it has run out.
 *
 * The server expires wrap-up lazily (`effectivePresenceStatus`): the row still
 * says `after_call_work` while `wrap_up_until` is already in the past, and the
 * operator is nevertheless ringable. The panel therefore counts down to zero
 * and then reports "dostupný" instead of a stuck timer.
 */
export function wrapUpRemainingSeconds(presence: Pick<MyPresence, "status" | "wrapUpUntil"> | null, now: Date): number {
  if (!presence || presence.status !== "after_call_work" || !presence.wrapUpUntil) return 0;
  const until = Date.parse(presence.wrapUpUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, Math.ceil((until - now.getTime()) / 1_000));
}

export function describeWrapUp(presence: MyPresence | null, now: Date): string | null {
  if (!presence || presence.status !== "after_call_work") return null;
  const remaining = wrapUpRemainingSeconds(presence, now);
  if (remaining === 0) return "Čas na dopísanie vypršal, hovor ti môže znova zazvoniť.";
  return `Dopisovanie: zostáva ${formatCallTimer(remaining)}. Do konca ti hovor nezazvoní.`;
}

/** "Ukončiť dopisovanie" only makes sense in `after_call_work`. */
export function canEndWrapUp(presence: MyPresence | null): boolean {
  return presence?.status === "after_call_work";
}

/**
 * Mirrors `setPresence`: the call flow owns the row while the operator is on a
 * call, so the buttons are disabled instead of collecting a 409.
 */
export function canChangePresence(presence: MyPresence | null): boolean {
  if (!presence) return true;
  return !(presence.status === "on_call" && Boolean(presence.currentSessionId));
}

export function describePresence(presence: MyPresence | null, reasons: readonly PauseReasonDoc[]): string {
  if (!presence) return "Prezencia sa ešte nenačítala.";
  switch (presence.status) {
    case "available":
      return "Si dostupný — hovor ti môže zazvoniť.";
    case "ringing":
      return "Práve ti zvoní hovor.";
    case "on_call":
      return "Si na hovore. Stav sa dá zmeniť až po jeho skončení.";
    case "after_call_work":
      return "Dopisuješ predchádzajúci hovor.";
    case "paused": {
      const reason = reasons.find((entry) => entry.id === presence.pauseReasonId);
      return reason ? `Máš pauzu: ${reason.label}. Hovor ti nezazvoní.` : "Máš pauzu. Hovor ti nezazvoní.";
    }
    case "offline":
      return "Si odhlásený z telefónie. Hovor ti nezazvoní.";
    default:
      return "Stav telefónie nie je známy.";
  }
}

export function activePauseReasons(reasons: readonly PauseReasonDoc[]): PauseReasonDoc[] {
  return [...reasons].filter((reason) => reason.active).sort((left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label, "sk"));
}

export function describePauseReason(reason: PauseReasonDoc): string {
  return reason.maxMinutes ? `${reason.label} (max ${reason.maxMinutes} min)` : reason.label;
}

// ---------------------------------------------------------------------------
// Test call
// ---------------------------------------------------------------------------

export type TestCallTarget = {
  /** The operator's default outbound line, when they have a usable one. */
  line: LineDoc | null;
  /** Prefill of the number field: their own line, so the loop can be tested. */
  number: string;
  note: string;
};

/**
 * What the "skúšobný hovor" starts with.
 *
 * `resolveFromLine` in `call-actions.ts` only accepts an **active** line, so an
 * operator whose default line was switched off would silently call from the
 * organisation's system number — the note says so rather than pretending.
 */
export function testCallTarget(document: Pick<RoutingDocument, "lines" | "operators">, profileId: string | null): TestCallTarget {
  const operator: OperatorDoc | null = profileId ? document.operators.find((entry) => entry.profileId === profileId) ?? null : null;
  const defaultLineId = operator?.settings?.defaultFromLineId ?? null;
  const line = defaultLineId ? document.lines.find((entry) => entry.id === defaultLineId) ?? null : null;

  if (!line) {
    return {
      line: null,
      number: "",
      note: "Nemáš nastavenú vlastnú odchádzajúcu linku, hovor odíde zo systémového čísla organizácie. Zadaj číslo, na ktoré chceš skúšobne zavolať.",
    };
  }
  if (!line.active) {
    return {
      line: null,
      number: line.phoneNumber,
      note: `Tvoja linka „${line.label}" je vypnutá, takže hovor odíde zo systémového čísla organizácie.`,
    };
  }
  return {
    line,
    number: line.phoneNumber,
    note: `Hovor odíde z linky „${line.label}" (${formatPhoneNumberForDisplay(line.phoneNumber)}). Najprv zazvoní tvoj telefón v prehliadači, po prijatí sa vytočí zadané číslo.`,
  };
}

export type TestCallCheck = { number: string | null; error: string | null; warning: string | null };

/**
 * Local mirror of `normalizeDestination`: E.164 plus the organisation's
 * destination allowlist. Dialling one of our own numbers is allowed — it is the
 * only way to test the whole loop — but it walks the line's ring plan, so
 * colleagues may hear it ring; that deserves a warning before the click.
 *
 * `allowlist: null` means "this reader does not see the organisation settings"
 * (they are manager/admin material, `getRoutingDocument({ includeSettings })`).
 * The check is then left to the server, which answers 403 with its own Slovak
 * message — an unknown allowlist must not reject every number.
 */
export function checkTestCallNumber(raw: string, input: { allowlist: readonly string[] | null; lines: readonly LineDoc[] }): TestCallCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { number: null, error: "Zadaj číslo, na ktoré sa má skúšobne zavolať.", warning: null };

  const number = normalizeE164(trimmed);
  if (!number) return { number: null, error: "Neplatné telefónne číslo.", warning: null };
  if (input.allowlist !== null && !isDestinationAllowed(number, input.allowlist)) {
    return { number: null, error: "Cieľové číslo nie je v povolených destináciách organizácie.", warning: null };
  }

  const ownLine = input.lines.find((line) => line.phoneNumber === number) ?? null;
  return {
    number,
    error: null,
    warning: ownLine
      ? `${formatPhoneNumberForDisplay(number)} je naša vlastná linka „${ownLine.label}" — hovor pôjde jej plánom zvonenia a môže zazvoniť aj kolegom.`
      : null,
  };
}

/** Confirmation before a real, billable leg leaves the system. */
export function confirmTestCall(number: string, warning: string | null): string {
  const head = `Spustiť skúšobný hovor na ${formatPhoneNumberForDisplay(number)}?\n\nIde o skutočný hovor a je spoplatnený.`;
  return warning ? `${head}\n\n${warning}` : head;
}
