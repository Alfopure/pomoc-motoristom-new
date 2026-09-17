/**
 * The one badge a dispatcher reads mid-call: can I hand this call over?
 *
 * Presence is what the operator last chose and nothing revokes it, so somebody
 * who closed their laptop stays "Dostupný" for ever. On 17 Sep two callers
 * waited seven and eight minutes while the list showed three operators and only
 * one could be reached. A green badge next to a disabled button is worse than
 * no badge, so when the browser phone is gone the badge says so instead.
 *
 * Only the browser phone can take a transfer. The elapsed time, though, is the
 * newest heartbeat across the browser phone and the mobile app — "when did we
 * last see this person at all" — because a colleague working on their phone with
 * a closed laptop is not away, they are merely unreachable by a transfer.
 *
 * No claim is made about where anybody is: a closed laptop and a dropped
 * connection look identical from here, and a backgrounded mobile app
 * disconnects on purpose to save battery. The time carries the meaning.
 */
export const COLLEAGUE_STATUS_LABELS: Record<string, string> = {
  available: "Dostupný",
  ringing: "Zvoní",
  on_call: "Na hovore",
  after_call_work: "Dopisuje",
  paused: "Pauza",
  offline: "Odhlásený",
};

export type ColleagueDeviceState = {
  status: string;
  deviceLive: boolean;
  deviceSeenAt?: string | null;
};

/** `2 min`, `20 min`, `4 h`. Nothing under a minute: a blink is not a number. */
function awayFor(seenAt: string | null | undefined, now: Date): string | null {
  const seen = seenAt ? Date.parse(seenAt) : NaN;
  if (!Number.isFinite(seen)) return null;
  const minutes = Math.floor((now.getTime() - seen) / 60_000);
  if (minutes < 1) return null;
  return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** The badge text for one colleague in the transfer picker. */
export function colleagueBadge(target: ColleagueDeviceState, now: Date): string {
  // Logging out is the operator's own decision and says more than the phone does.
  if (target.status === "offline") return COLLEAGUE_STATUS_LABELS.offline;
  if (target.deviceLive) return COLLEAGUE_STATUS_LABELS[target.status] ?? target.status;
  const away = awayFor(target.deviceSeenAt, now);
  return away ? `Nepripojený · ${away}` : "Nepripojený";
}
