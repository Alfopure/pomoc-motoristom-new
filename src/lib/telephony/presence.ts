import type { CallCenterCall } from "@/data/dispatch-types";
import type { Operator } from "@/domain/types";
import type { ViptelQueue, ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import {
  callIsCurrentAtTelephonyStation,
  callIsRingingAtTelephonyStation,
  type TelephonyExtensionIdentity,
} from "@/lib/telephony/call-endpoints";

export type TelephonyExtensionSnapshot = {
  id: string;
  profileId?: string;
  extension: string;
  active: boolean;
  assignmentEligible?: boolean;
  assignmentRequirement?: "initial_provisioning" | "rotation_required";
  displayName?: string;
  outboundCid?: string;
  callForwarding?: string;
  registered?: boolean;
  viptelPhoneActive?: boolean;
  allowedChanges: string[];
  lastSyncedAt?: string;
};

export type TelephonyPresenceSnapshot = {
  actorProfileId: string;
  canManageAssignments: boolean;
  checkedAt: string;
  extensions: TelephonyExtensionSnapshot[];
  queues: ViptelQueue[];
  queueStatuses: ViptelQueueStatus[];
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
  activeCalls: CallCenterCall[];
  health: TelephonyHealthSignal;
}): TelephonyOperatorPresence[] {
  const { activeCalls, health, operators, snapshot } = input;
  const snapshotsByProfile = groupExtensionsByProfile(snapshot?.extensions ?? []);
  const queueMembersByExtension = groupQueueMembersByExtension(snapshot?.queueStatuses ?? []);
  const extensionIdentities: TelephonyExtensionIdentity[] = (snapshot?.extensions ?? [])
    .filter((extension) => extension.active)
    .map((extension) => ({ extension: extension.extension, profileId: extension.profileId }));

  return operators.map((operator) => {
    const owned = snapshotsByProfile.get(operator.id) ?? [];
    const extensions = owned.map((extension) => extension.extension);
    const primaryExtension = extensions[0];
    const registrations = owned.map((extension) => extension.registered === true);
    const queueMemberships = owned.flatMap((extension) => queueMembersByExtension.get(extension.extension) ?? []);
    const ringing = extensions.some((extension) => hasRingingCall(activeCalls, extension, operator.id, extensionIdentities));
    const callInUse = extensions.some((extension) => hasActiveCall(activeCalls, extension, operator.id, extensionIdentities));
    const queueInUse = queueMemberships.some(({ member }) => member.inUse);
    const inUse = callInUse || queueInUse;
    const queueMember = queueMemberships.length > 0;
    const queueNumbers = [...new Set(queueMemberships.map((membership) => membership.queue))];
    const paused = queueMember && queueMemberships.every(({ member }) => member.paused);
    const registered = registrations.some(Boolean);
    const availableQueues = [...new Set(owned.flatMap((extension) => {
      const memberships = queueMembersByExtension.get(extension.extension) ?? [];
      const usable =
        extension.active &&
        extension.registered === true &&
        !hasActiveCall(activeCalls, extension.extension, operator.id, extensionIdentities);
      return usable
        ? memberships.filter(({ member }) => !member.paused && !member.inUse).map((membership) => membership.queue)
        : [];
    }))];
    const available = availableQueues.length > 0;
    const state = presenceState({
      available,
      health,
      inUse,
      ownedCount: owned.length,
      paused,
      queueMember,
      registered,
      ringing,
    });

    return {
      profileId: operator.id,
      operatorName: operator.name,
      extensions,
      primaryExtension,
      state,
      available: state === "available",
      queueMember,
      queueNumbers,
      availableQueues,
      paused,
      inUse,
      registered,
      detail: presenceDetail({
        extensions,
        health,
        inUse,
        paused,
        queueMember,
        registered,
        state,
      }),
      checkedAt: snapshot?.checkedAt ?? health.lastSuccessAt ?? health.checkedAt,
    };
  });
}

function presenceState(input: {
  available: boolean;
  health: TelephonyHealthSignal;
  inUse: boolean;
  ownedCount: number;
  paused: boolean;
  queueMember: boolean;
  registered: boolean;
  ringing: boolean;
}): TelephonyOperatorPresenceState {
  if (input.health.state === "degraded" || input.health.state === "unavailable") return "error";
  if (input.health.state === "stale") return "stale";
  if (input.health.state !== "live") return "stale";
  if (input.ownedCount === 0) return "unassigned";
  if (input.ringing) return "ringing";
  if (input.inUse) return "on_call";
  if (input.available) return "available";
  if (input.paused) return "paused";
  if (input.queueMember && !input.registered) return "unregistered";
  return "offline";
}

function presenceDetail(input: {
  extensions: string[];
  health: TelephonyHealthSignal;
  inUse: boolean;
  paused: boolean;
  queueMember: boolean;
  registered: boolean;
  state: TelephonyOperatorPresenceState;
}) {
  if (input.state === "error" || input.state === "stale") return input.health.detail;
  if (input.state === "unassigned") return "Bez priradenej aktívnej internej linky VIPTel.";

  const identity = `Interná linka ${input.extensions.join(", ")}`;
  if (input.state === "ringing") return `${identity} práve zvoní.`;
  if (input.inUse) return `${identity} je na hovore.`;
  if (!input.queueMember) return `${identity} je mimo radu.`;
  if (input.paused) return `${identity} je v rade na pauze.`;
  if (!input.registered) return `${identity} je v rade, ale nie je registrovaná.`;
  return `${identity} je registrovaná a dostupná v rade.`;
}

function groupExtensionsByProfile(extensions: TelephonyExtensionSnapshot[]) {
  const grouped = new Map<string, TelephonyExtensionSnapshot[]>();

  for (const extension of extensions) {
    if (!extension.active || !extension.profileId) continue;
    const current = grouped.get(extension.profileId) ?? [];
    current.push(extension);
    grouped.set(extension.profileId, current);
  }

  for (const current of grouped.values()) {
    current.sort((left, right) => left.extension.localeCompare(right.extension, "en", { numeric: true }));
  }

  return grouped;
}

function groupQueueMembersByExtension(statuses: ViptelQueueStatus[]) {
  const grouped = new Map<string, Array<{ queue: string; member: ViptelQueueStatus["members"][number] }>>();

  for (const status of statuses) {
    for (const member of status.members) {
      const current = grouped.get(member.extension) ?? [];
      current.push({ queue: status.queue, member });
      grouped.set(member.extension, current);
    }
  }

  return grouped;
}

function hasRingingCall(
  calls: CallCenterCall[],
  extension: string,
  profileId: string,
  stations: TelephonyExtensionIdentity[],
) {
  return calls.some(
    (call) =>
      (call.status === "incoming" || call.status === "ringing_agent") &&
      callIsRingingAtTelephonyStation(call, { extension, profileId }, stations),
  );
}

function hasActiveCall(
  calls: CallCenterCall[],
  extension: string,
  profileId: string,
  stations: TelephonyExtensionIdentity[],
) {
  return calls.some(
    (call) =>
      ["incoming", "ringing_agent", "answered", "outbound"].includes(call.status) &&
      callIsCurrentAtTelephonyStation(call, { extension, profileId }, stations),
  );
}
