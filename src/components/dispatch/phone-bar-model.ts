/**
 * Pure helpers behind `PhoneBar.tsx`.
 *
 * The component itself only renders; every decision about which control is
 * offered, what it is called and how the timer reads lives here so it can be
 * tested in the repo's node-only Vitest setup (no jsdom, design §4 Phase 2).
 */

import type { PhoneBarCall } from "@/lib/telephony/active-calls-model";
import type { WebphoneStatus } from "@/lib/telephony/webphone-model";

/** Server-side call actions, one per `POST /api/telephony/calls/[id]/…` route. */
export type PhoneCallAction =
  | "hold"
  | "unhold"
  | "park"
  | "pickup"
  | "transfer"
  | "consult"
  | "complete-transfer"
  | "cancel-consult"
  | "hangup";

export const PHONE_ACTION_LABELS: Record<PhoneCallAction, string> = {
  hold: "Podržať",
  unhold: "Pokračovať",
  park: "Do čakárne",
  pickup: "Prevziať",
  transfer: "Prepojiť",
  consult: "Konzultovať",
  "complete-transfer": "Dokončiť prepojenie",
  "cancel-consult": "Zrušiť konzultáciu",
  hangup: "Zavesiť",
};

export const PHONE_ACTION_ERRORS: Record<PhoneCallAction, string> = {
  hold: "Hovor sa nepodarilo podržať.",
  unhold: "Hovor sa nepodarilo obnoviť.",
  park: "Hovor sa nepodarilo odložiť do čakárne.",
  pickup: "Hovor sa nepodarilo prevziať.",
  transfer: "Prepojenie zlyhalo.",
  consult: "Konzultáciu sa nepodarilo spustiť.",
  "complete-transfer": "Prepojenie sa nepodarilo dokončiť.",
  "cancel-consult": "Konzultáciu sa nepodarilo zrušiť.",
  hangup: "Hovor sa nepodarilo ukončiť.",
};

export type PhoneBarCapabilities = {
  answer: boolean;
  hangup: boolean;
  hold: boolean;
  unhold: boolean;
  park: boolean;
  pickup: boolean;
  transfer: boolean;
  consult: boolean;
  completeTransfer: boolean;
  cancelConsult: boolean;
  mute: boolean;
  dtmf: boolean;
  newCase: boolean;
  linkCase: boolean;
};

const NO_CAPABILITIES: PhoneBarCapabilities = {
  answer: false,
  hangup: false,
  hold: false,
  unhold: false,
  park: false,
  pickup: false,
  transfer: false,
  consult: false,
  completeTransfer: false,
  cancelConsult: false,
  mute: false,
  dtmf: false,
  newCase: false,
  linkCase: false,
};

/**
 * What the operator may do with `call` right now.
 *
 * `browserCallActive` is the SDK's own view: mute and DTMF are browser-side
 * only (design §4), so they are offered exactly while this tab holds the media
 * leg, regardless of what the server thinks. `degraded` is set after a
 * conference promotion failed — the call keeps running, but the actions that
 * need a conference are refused rather than silently retried.
 */
export function phoneBarCapabilities(input: {
  call: PhoneBarCall | null;
  browserCallActive: boolean;
  browserCallRinging: boolean;
  degraded?: boolean;
}): PhoneBarCapabilities {
  const { call } = input;
  if (!call) {
    return { ...NO_CAPABILITIES, answer: input.browserCallRinging, hangup: input.browserCallRinging || input.browserCallActive };
  }

  if (call.kind === "waiting") {
    return { ...NO_CAPABILITIES, pickup: true, newCase: true, linkCase: true };
  }

  if (call.kind === "offer") {
    return {
      ...NO_CAPABILITIES,
      answer: input.browserCallRinging,
      hangup: input.browserCallRinging,
      newCase: true,
      linkCase: !call.caseId,
    };
  }

  const talking = call.state === "talking" || call.state === "conference";
  const advanced = !input.degraded;
  return {
    answer: false,
    hangup: true,
    hold: talking && advanced,
    unhold: call.state === "held",
    park: (talking || call.state === "held") && call.answered,
    pickup: false,
    transfer: talking || call.state === "held",
    consult: (talking || call.state === "held") && advanced,
    completeTransfer: call.state === "consulting",
    cancelConsult: call.state === "consulting",
    mute: input.browserCallActive,
    dtmf: input.browserCallActive,
    newCase: true,
    linkCase: true,
  };
}

/** `mm:ss`, or `h:mm:ss` past an hour. */
export function formatCallTimer(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const rest = safe % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(rest).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function callElapsedSeconds(call: Pick<PhoneBarCall, "timerSince">, now: number): number {
  const since = Date.parse(call.timerSince);
  if (!Number.isFinite(since)) return 0;
  return Math.max(0, Math.floor((now - since) / 1_000));
}

export type PhoneBarStateLabel = { label: string; tone: "live" | "hold" | "ring" | "wait" };

export function phoneBarStateLabel(call: PhoneBarCall): PhoneBarStateLabel {
  if (call.kind === "offer") return { label: "Zvoní", tone: "ring" };
  if (call.kind === "waiting") return { label: call.parked ? "V čakárni" : "Čaká", tone: "wait" };
  switch (call.state) {
    case "held":
      return { label: "Podržaný", tone: "hold" };
    case "consulting":
      return { label: "Konzultácia", tone: "hold" };
    case "conference":
      return { label: "Konferencia", tone: "live" };
    case "ringing":
      return { label: call.direction === "inbound" ? "Zvoní" : "Vytáčam", tone: "ring" };
    case "talking":
      return { label: "Prebieha", tone: "live" };
    case "wrap_up":
      return { label: "Dopisovanie", tone: "wait" };
    default:
      return { label: "Hovor", tone: "live" };
  }
}

/**
 * Whether the bar is worth rendering at all.
 *
 * Without a configured provider the console keeps its existing
 * "Telefónia nie je nakonfigurovaná" notice and the bar stays out of the way;
 * an idle, stopped phone with nothing happening is equally not worth a strip
 * across the top of every view.
 */
export function phoneBarVisible(input: {
  status: WebphoneStatus;
  hasCall: boolean;
  hasOffer: boolean;
  hasWaiting: boolean;
}): boolean {
  if (input.status === "not_configured") return false;
  if (input.hasCall || input.hasOffer || input.hasWaiting) return true;
  return input.status !== "idle";
}

/**
 * `failed` (the token route refused: another tab is ringing / on a call) and
 * `superseded` (a newer tab took the credential) are terminal statuses — the
 * client never retries by itself, so the operator needs an explicit takeover.
 */
export function phoneTakeoverAvailable(status: WebphoneStatus): boolean {
  return status === "failed" || status === "superseded";
}

export const DTMF_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

export function isDtmfKey(value: string): boolean {
  return (DTMF_KEYS as readonly string[]).includes(value);
}
