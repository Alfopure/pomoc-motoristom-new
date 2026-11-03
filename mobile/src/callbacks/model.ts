import type { MobileCallbackRequest, MobileCallTarget } from "../../../src/lib/mobile-callbacks";
import { formatNumber } from "../lib/display";

export type CallbackFilter = "all" | "unclaimed" | "mine" | "requested";
export const callbackFilters: { id: CallbackFilter; label: string }[] = [
  { id: "all", label: "Všetky" }, { id: "unclaimed", label: "Nepridelené" },
  { id: "mine", label: "Moje" }, { id: "requested", label: "Vyžiadané" },
];
export const callbackOriginLabels: Record<MobileCallbackRequest["origin"], string> = {
  requested: "Vyžiadané klientom", missed: "Zmeškaný hovor · bez žiadosti", manual: "Zadané dispečerom", unknown: "Starší záznam · voľba neoverená",
};
export const callbackStatusLabels: Record<MobileCallbackRequest["status"], string> = {
  open: "Čaká na prevzatie", scheduled: "Prevzaté", done: "Vybavené", cancelled: "Zrušené",
};

/** Slovak plural: 1 požiadavka čaká, 2–4 požiadavky čakajú, 5+ požiadaviek čaká. */
export function waitingLabel(count: number): string {
  return count === 1 ? "1 požiadavka čaká" : count >= 2 && count <= 4 ? count + " požiadavky čakajú" : count + " požiadaviek čaká";
}

/** Applies to the loaded page; the server's totals stay the source of the full count. */
export function filterCallbacks(requests: MobileCallbackRequest[], filter: CallbackFilter): MobileCallbackRequest[] {
  if (filter === "unclaimed") return requests.filter(item => item.claimant === null);
  if (filter === "mine") return requests.filter(item => item.claimant?.mine);
  if (filter === "requested") return requests.filter(item => item.origin === "requested");
  return requests;
}

/** Same thresholds as the web queue: amber in the last 15 minutes, red after the promise. */
export type CallbackUrgency = "fresh" | "due" | "overdue";
export function callbackUrgency(request: Pick<MobileCallbackRequest, "status" | "deadlineAt">, now: number): CallbackUrgency {
  if (request.status === "done" || request.status === "cancelled" || !request.deadlineAt) return "fresh";
  const deadline = Date.parse(request.deadlineAt);
  if (!Number.isFinite(deadline)) return "fresh";
  if (now >= deadline) return "overdue";
  return now >= deadline - 15 * 60_000 ? "due" : "fresh";
}

/** "< 1 min", "7 min", "1 h 12 min"; the queue is measured in minutes. */
export function formatWait(fromIso: string, until: number): string {
  const from = Date.parse(fromIso);
  const minutes = Number.isFinite(from) ? Math.floor(Math.max(0, until - from) / 60_000) : 0;
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? hours + " h " + rest + " min" : hours + " h";
}

export function deadlineText(request: Pick<MobileCallbackRequest, "status" | "deadlineAt">, now: number): string | null {
  if (!request.deadlineAt || request.status === "done" || request.status === "cancelled") return null;
  const deadline = Date.parse(request.deadlineAt);
  if (!Number.isFinite(deadline)) return null;
  return now >= deadline ? "Po termíne " + formatWait(request.deadlineAt, now) : "Zavolať do " + formatWait(new Date(now).toISOString(), deadline);
}

export type DialDecision =
  | { kind: "dial"; number: string; verificationId?: undefined }
  | { kind: "confirm"; number: string; verificationId: string; title: string; message: string }
  | { kind: "blocked"; message: string };

/** The directory decision for a number about to be dialed. `checked` runs as soon as the decision
 * (or a failure) is known, before any dialing, so the call setup is not shown as a number check. */
export async function checkDialTarget(read: () => Promise<MobileCallTarget["target"]>, checked: () => void): Promise<DialDecision> {
  try { return dialDecision(await read()); } finally { checked(); }
}

/** Directory decision before dialing; the server repeats it when the call starts. */
export function dialDecision(target: MobileCallTarget["target"]): DialDecision {
  if (target.status === "original") return { kind: "dial", number: target.originalNumber };
  if (target.status === "blocked" || !target.dialNumber || !target.verificationId) {
    return { kind: "blocked", message: "Na číslo " + formatNumber(target.originalNumber) + (target.sourceName ? " (" + target.sourceName + ")" : "")
      + " sa nedá volať späť. V kontakte najprv overte náhradné číslo." };
  }
  return {
    kind: "confirm", number: target.dialNumber, verificationId: target.verificationId, title: "Volať na overené číslo?",
    message: "Na pôvodné číslo " + formatNumber(target.originalNumber) + (target.sourceName ? " (" + target.sourceName + ")" : "") + " sa nedá volať späť.\n\n"
      + "Zavolať na overené číslo " + formatNumber(target.dialNumber) + (target.targetName ? " (" + target.targetName + ")" : "") + "?\n\nPôvodné číslo ostane v histórii.",
  };
}
