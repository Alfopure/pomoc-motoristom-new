import type { MobileDraftScope } from "./mobile-api";

/** After-call work on one call-log row (`motorist_calls.id`), shared with the web call history.
 * Same values as the web `CallOutcome`; the server checks the two stay identical. */
export type MobileCallOutcome = "reached" | "not_reached" | "callback" | "informational" | "bad_contact" | "case_created";
export const MOBILE_CALL_OUTCOMES: { value: MobileCallOutcome; label: string }[] = [
  { value: "reached", label: "Dovolané" },
  { value: "not_reached", label: "Nedovolané" },
  { value: "callback", label: "Zavolať naspäť" },
  { value: "informational", label: "Informačný hovor" },
  { value: "bad_contact", label: "Nesprávny kontakt" },
  { value: "case_created", label: "Prípad vytvorený" },
];
export const MOBILE_CALLBACK_MINUTES = [15, 30, 60, 120] as const;
export const MOBILE_CALL_NOTE_LIMIT = 500;

export type MobileCallCaseSuggestion = {
  caseId: string;
  caseNumber: string;
  statusLabel: string;
  open: boolean;
  contactName: string | null;
  /** Why it is offered: the caller's directory contact, or an earlier call already linked to it. */
  reason: "contact" | "previous_call";
};
export type MobileCallWrapUp = MobileDraftScope & {
  callId: string;
  number: string | null;
  /** Raw stored link; the expected value for a conditional relink. */
  linkedCaseId: string | null;
  linkedCase: { id: string; caseNumber: string; statusLabel: string } | null;
  outcome: { value: MobileCallOutcome; label: string; note: string | null; callbackMinutes: number | null; at: string | null } | null;
  /** queue: a callback request in the shared queue; case_task: a task on the linked case; unavailable: nothing would be scheduled. */
  callbackScheduling: "queue" | "case_task" | "unavailable";
  suggestions: MobileCallCaseSuggestion[];
  /** False when caller matching was not available; suggestions are then empty, not proof of none. */
  matchesAvailable: boolean;
};
export type MobileCallOutcomeInput = { mutationId: string; outcome: MobileCallOutcome; note: string | null; callbackMinutes: number | null };
export type MobileCallOutcomeSaved = MobileDraftScope & { callId: string; mutationId: string; replayed: boolean };
export type MobileCallCaseInput = { caseId: string; expectedCaseId: string | null };
export type MobileCallCaseLinked = MobileDraftScope & { callId: string; caseId: string; changed: boolean };
