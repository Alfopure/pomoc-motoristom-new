import type { Operator } from "@/domain/types";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";

/**
 * Provider-neutral operator presence snapshot.
 *
 * `devices` describes the browser phone registration per operator and
 * `presence` the operator's own availability state. Both are keyed by profile
 * id; an operator missing from `presence` is not part of the ring pool at all.
 */
export type TelephonyPresenceStatus =
  | "available"
  | "ringing"
  | "on_call"
  | "after_call_work"
  | "paused"
  | "offline";

export type TelephonyDeviceSnapshot = {
  profileId: string;
  registered: boolean;
  seenAt?: string;
};

export type TelephonyOperatorPresenceRow = {
  profileId: string;
  status: TelephonyPresenceStatus;
  currentSessionId?: string | null;
};

export type TelephonyPresenceSnapshot = {
  actorProfileId: string;
  canManageAssignments: boolean;
  checkedAt: string;
  devices: TelephonyDeviceSnapshot[];
  presence: TelephonyOperatorPresenceRow[];
};

export type TelephonyOperatorPresenceState =
  | "available"
  | "ringing"
  | "on_call"
  | "paused"
  | "unregistered"
  | "offline"
  | "unassigned"
  | "stale"
  | "error";

export type TelephonyAvailabilityAction = "available" | "pause" | "offline";

export type TelephonyOperatorPresence = {
  profileId: string;
  operatorName: string;
  extensions: string[];
  primaryExtension?: string;
  state: TelephonyOperatorPresenceState;
  available: boolean;
  queueMember: boolean;
  queueNumbers: string[];
  availableQueues: string[];
  paused: boolean;
  inUse: boolean;
  registered: boolean;
  detail: string;
  checkedAt?: string;
};

export function deriveTelephonyOperatorPresences(input: {
  operators: Operator[];
  snapshot: TelephonyPresenceSnapshot | null;
  health?: TelephonyHealthSignal;
}): TelephonyOperatorPresence[] {
  const { health, operators, snapshot } = input;
  const devicesByProfile = new Map(snapshot?.devices.map((device) => [device.profileId, device]) ?? []);
  const presenceByProfile = new Map(snapshot?.presence.map((row) => [row.profileId, row]) ?? []);
  const healthState = healthPresenceState(health);
  const checkedAt = snapshot?.checkedAt ?? health?.lastSuccessAt ?? health?.checkedAt;

  return operators.map((operator) => {
    const device = devicesByProfile.get(operator.id);
    const presence = presenceByProfile.get(operator.id);
    const registered = device?.registered === true;
    const paused = presence?.status === "paused" || presence?.status === "after_call_work";
    const inUse =
      presence?.status === "ringing" ||
      presence?.status === "on_call" ||
      Boolean(presence?.currentSessionId);
    const state = healthState ?? presenceState({ presence, registered });

    return {
      profileId: operator.id,
      operatorName: operator.name,
      extensions: [],
      state,
      available: state === "available",
      queueMember: presence !== undefined,
      queueNumbers: [],
      availableQueues: [],
      paused,
      inUse,
      registered,
      detail: presenceDetail({ health, presence, state }),
      checkedAt,
    };
  });
}

function healthPresenceState(health: TelephonyHealthSignal | undefined): TelephonyOperatorPresenceState | null {
  if (!health) return null;
  if (health.state === "degraded" || health.state === "unavailable") return "error";
  if (health.state === "stale" || health.state === "checking") return "stale";
  return null;
}

/**
 * Precedence: no presence row → unassigned; explicit offline wins; live call
 * states come from the server and beat a lapsed device heartbeat; otherwise an
 * unregistered browser phone cannot be reached regardless of availability.
 */
function presenceState(input: {
  presence: TelephonyOperatorPresenceRow | undefined;
  registered: boolean;
}): TelephonyOperatorPresenceState {
  const { presence, registered } = input;
  if (!presence) return "unassigned";
  if (presence.status === "offline") return "offline";
  if (presence.status === "ringing") return "ringing";
  if (presence.status === "on_call") return "on_call";
  if (!registered) return "unregistered";
  if (presence.status === "paused" || presence.status === "after_call_work") return "paused";
  return "available";
}

function presenceDetail(input: {
  health: TelephonyHealthSignal | undefined;
  presence: TelephonyOperatorPresenceRow | undefined;
  state: TelephonyOperatorPresenceState;
}) {
  const { health, presence, state } = input;
  if ((state === "error" || state === "stale") && health) return health.detail;

  switch (state) {
    case "unassigned":
      return "Operátor nie je zaradený do telefónie.";
    case "offline":
      return "Operátor je odhlásený z telefónie.";
    case "ringing":
      return "Operátorovi práve zvoní hovor.";
    case "on_call":
      return "Operátor je na hovore.";
    case "unregistered":
      return "Telefón operátora nie je pripojený.";
    case "paused":
      return presence?.status === "after_call_work"
        ? "Operátor dokončuje predchádzajúci hovor."
        : "Operátor má pauzu.";
    case "available":
      return "Operátor je pripojený a dostupný.";
    default:
      return "Stav telefónie nie je známy.";
  }
}
