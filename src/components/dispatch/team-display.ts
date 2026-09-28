import { colleaguePresenceBlock, COLLEAGUE_CALL_MESSAGES } from "@/lib/telephony/colleague-call";
import type { TelephonyOperatorPresenceState } from "@/lib/telephony/presence";

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

export type ColleagueCallView =
  | { callable: true; paused: boolean; route: string }
  | { callable: false; reason: string };

/**
 * What the team strip says about calling this colleague, from the data already
 * on screen (no extra request). The server decides again on the click with
 * the same rule (`colleaguePresenceBlock`).
 */
export function colleagueCallView(input: {
  /** Fresh derived presence state, when the console snapshot has one. */
  presenceState?: TelephonyOperatorPresenceState;
  /** Team-strip status: the only source that tells wrap-up from a pause. */
  teamStatus: string;
  inCall: boolean;
  registered: boolean;
  deliveryMode?: "web" | "personal_mobile";
  verified: boolean;
}): ColleagueCallView {
  if (!input.verified || input.presenceState === "stale" || input.presenceState === "error") return { callable: false, reason: "Stav kolegu sa overuje." };
  const state = input.presenceState;
  const status = state === undefined ? input.teamStatus
    : state === "paused" && input.teamStatus === "after_call_work" ? "after_call_work"
      : state === "unregistered" ? "available"
        : state === "unassigned" ? "offline"
          : state;
  const block = colleaguePresenceBlock({ status, inCall: input.inCall });
  if (block) return { callable: false, reason: COLLEAGUE_CALL_MESSAGES[block] };
  if (input.deliveryMode === "personal_mobile") return { callable: false, reason: COLLEAGUE_CALL_MESSAGES.personal_mobile };
  if (!input.registered) return { callable: false, reason: COLLEAGUE_CALL_MESSAGES.no_phone };
  return status === "paused"
    ? { callable: true, paused: true, route: "Zazvoní mu v aplikácii. Je na pauze a pauza mu ostane." }
    : { callable: true, paused: false, route: "Zazvoní mu v aplikácii. Ak má aj mobilnú aplikáciu, príde mu upozornenie." };
}
