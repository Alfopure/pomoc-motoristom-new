/** Versioned, provider-neutral DTOs. Native imports these as types only. */
export type MobileEnvironment = "test" | "production";
export type MobileRole = "dispatcher" | "senior_dispatcher" | "manager" | "admin";
export type MobilePresence = "available" | "ringing" | "on_call" | "after_call_work" | "paused" | "offline";
export type MobileScope = {
  ok: true;
  apiVersion: 1;
  environment: MobileEnvironment;
  profileId: string;
  checkedAt: string;
};
export type MobileMe = MobileScope & {
  profile: { id: string; displayName: string; email: string | null; role: MobileRole };
  capabilities: { voice: false; presenceWrite: false };
};
export type MobileActiveCall = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  state: string;
  number: string | null;
  name: string | null;
  lineLabel: string | null;
  startedAt: string;
};
export type MobileConsole = MobileScope & {
  presence: { status: MobilePresence; since: string | null };
  activeCalls: MobileActiveCall[];
  // These are capabilities of this native release, not the web phone's state.
  capabilities: { voice: false; presenceWrite: false };
};
export type MobileHistoryCall = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  status: string;
  number: string | null;
  name: string | null;
  lineLabel: string;
  operatorName: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
};
export type MobileHistory = MobileScope & {
  calls: MobileHistoryCall[];
  nextCursor: string | null;
};
