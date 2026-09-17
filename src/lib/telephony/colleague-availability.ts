/**
 * Why a colleague cannot take a transfer right now, in the dispatcher's words.
 *
 * The presence badge alone lies by omission: someone who closed their laptop
 * stays "Dostupný" forever, because presence is what the operator last chose
 * and nothing revokes it. The browser phone is what actually rings, and it
 * reports itself every 30 s (`isDeviceLive`, 120 s window). On 17 Sep a
 * colleague sat in the list as available for four hours without their phone
 * ringing once, while two callers waited in the queue.
 *
 * We do not claim a cause: a closed laptop and a dropped connection look the
 * same from here. The elapsed time carries the meaning — four hours is a closed
 * laptop, two minutes is a bad connection, and the dispatcher can tell which.
 */
export type ColleagueDeviceState = {
  available: boolean;
  deviceLive: boolean;
  deviceSeenAt?: string | null;
};

/** `null` when there is nothing worth adding to the presence badge. */
export function colleagueDeviceNote(target: ColleagueDeviceState, now: Date): string | null {
  if (target.available || target.deviceLive) return null;
  const seen = target.deviceSeenAt ? Date.parse(target.deviceSeenAt) : NaN;
  if (!Number.isFinite(seen)) return "Telefón nepripojený";
  const minutes = Math.floor((now.getTime() - seen) / 60_000);
  if (minutes < 1) return "Nie je pri počítači";
  if (minutes < 90) return `Nie je pri počítači (${minutes} min)`;
  const hours = Math.floor(minutes / 60);
  return `Nie je pri počítači (${hours} h)`;
}
