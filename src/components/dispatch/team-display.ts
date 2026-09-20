/** Last confirmed phone connection, never the age of a manually chosen availability. */
export function lastOnlineLabel(online: boolean, lastOnlineAt: string | null, now: number, verified = true): string {
  if (!verified) return "Overuje sa spojenie";
  if (online) return "Online teraz";
  const timestamp = Date.parse(lastOnlineAt ?? "");
  if (!Number.isFinite(timestamp) || timestamp > now + 60_000) return "Bez záznamu pripojenia";
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "Naposledy pred chvíľou";
  if (minutes < 60) return `Naposledy pred ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Naposledy pred ${hours} h`;
  return `Naposledy pred ${Math.floor(hours / 24)} dňami`;
}
