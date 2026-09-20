import type { TelephonyPresenceStatus } from "./presence";

/** Operational team view, deliberately distinct from manager reports. */
export type TelephonyTeamOperator = {
  profileId: string; name: string; status: TelephonyPresenceStatus;
  statusSince: string | null; answeredToday: number;
  /** Verified phone connection in the current deployment, distinct from queue availability. */
  online: boolean; lastOnlineAt: string | null;
  talkSecondsToday: number; availableSecondsToday: number; pausedSecondsToday: number;
  lastDeviceContactAt: string | null; lastMobileContactAt: string | null;
  call?: { sessionId: string; callerNumber: string | null; callerName: string | null; lineLabel: string | null };
};
export type TelephonyTeamPayload = { checkedAt: string; operators: TelephonyTeamOperator[] };
