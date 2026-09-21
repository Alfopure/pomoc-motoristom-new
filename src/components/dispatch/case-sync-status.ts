/** Only cases and notifications; this never describes phone readiness or saved form drafts. */
export type CaseSyncSnapshot = {
  available: boolean | null;
  hidden: boolean;
  denied: boolean;
  connected: boolean;
  authorizedUntil: number;
  inFlight: boolean;
  incomplete: boolean;
  lastVerifiedAt: number | null;
  error: string;
};

export const EMPTY_CASE_SYNC_SNAPSHOT: CaseSyncSnapshot = {
  available: null, hidden: true, denied: false, connected: false, authorizedUntil: 0,
  inFlight: false, incomplete: false, lastVerifiedAt: null, error: "",
};
export const UNAVAILABLE_CASE_SYNC_SNAPSHOT: CaseSyncSnapshot = { ...EMPTY_CASE_SYNC_SNAPSHOT, available: false, hidden: false };

export type CaseSyncKind = "initial" | "updating" | "current" | "error" | "expired" | "denied" | "unavailable" | "offline";
export type CaseSyncPresentation = { kind: CaseSyncKind; label: string; detail: string; retry: boolean; spinning: boolean };

export function caseSyncPresentation(snapshot: CaseSyncSnapshot, online = true, now = Date.now()): CaseSyncPresentation {
  const status = (kind: CaseSyncKind, label: string, detail: string, retry = false): CaseSyncPresentation => ({ kind, label, detail, retry, spinning: kind === "updating" && snapshot.inFlight });
  if (snapshot.denied) return status("denied", "Prístup k prípadom nie je dostupný.", "Údaje sú skryté. Overte prístup k svojmu účtu.");
  if (snapshot.available === false) return status("unavailable", "Stav aktualizácií nie je dostupný.", "Automatické overenie prípadov a upozornení tu nie je aktívne.");
  if (snapshot.authorizedUntil > 0 && (snapshot.hidden || now >= snapshot.authorizedUntil)) return status("expired", "Aktuálnosť údajov sa nepodarilo overiť.", "Prístup sa overuje. Údaje sú dočasne skryté.", online);
  if (!online) return status("offline", "Zariadenie je offline.", "Prípady a upozornenia overím po obnovení spojenia.");
  if (snapshot.error) return status("error", "Aktuálnosť údajov sa nepodarilo overiť.", "Zmeny môžu byť oneskorené. Automatické overovanie pokračuje.", true);
  if (snapshot.inFlight || snapshot.incomplete) return status("updating", "Aktualizujem prípady a upozornenia…", snapshot.inFlight ? "Overujem posledné uložené zmeny." : "Dokončujem načítanie ďalších prípadov.");
  if (snapshot.lastVerifiedAt !== null && !snapshot.hidden && snapshot.authorizedUntil > now) return status("current", "Prípady a upozornenia sú aktuálne.", snapshot.connected ? "Zmeny sa zobrazujú priebežne." : "Zmeny sa kontrolujú automaticky, približne každých 25 sekúnd.");
  return status("initial", "Prípady a upozornenia ešte nie sú overené.", "Čakám na prvé úspešné načítanie.");
}

type Rectangle = { left: number; bottom: number; width: number; height: number };
type Viewport = { left: number; top: number; width: number; height: number; bottomInset: number };
/** The panel must always stay below the phone bars, even when a new call expands them. */
export function caseSyncPanelPosition(anchor: Rectangle, viewport: Viewport, topBarsBottom: number) {
  if (anchor.width <= 0 || anchor.height <= 0 || viewport.width < 160) return null;
  const width = Math.min(312, viewport.width - 16);
  const left = Math.max(viewport.left + 8, Math.min(anchor.left, viewport.left + viewport.width - width - 8));
  const top = Math.max(viewport.top + 8, anchor.bottom + 8, topBarsBottom + 8);
  const maxHeight = viewport.top + viewport.height - viewport.bottomInset - top - 8;
  return maxHeight < 112 ? null : { top, left, width, maxHeight };
}
