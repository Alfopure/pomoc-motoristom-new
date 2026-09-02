import type { ViptelQueueStatus } from "@/lib/integrations/viptel/client";
import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";

export type QueueCoverage = {
  available: number;
  needsOperator: boolean;
  total: number;
  waiting: number;
};

export function getQueueCoverage(
  status: ViptelQueueStatus | ViptelQueueStatus[] | null,
  operatorPresences?: TelephonyOperatorPresence[],
): QueueCoverage {
  const statuses = Array.isArray(status) ? status : status ? [status] : [];
  const members = deduplicatedMembers(statuses);
  const available = operatorPresences
    ? operatorPresences.filter((presence) => presence.available).length
    : members.filter((member) => !member.paused && !member.inUse).length;
  const total = operatorPresences
    ? operatorPresences.filter((presence) => presence.queueMember).length
    : members.length;
  const waiting = statuses.reduce((sum, queue) => sum + queue.waitingCalls, 0);

  return {
    available,
    needsOperator: waiting > 0 && available === 0,
    total,
    waiting,
  };
}

function deduplicatedMembers(statuses: ViptelQueueStatus[]) {
  const members = new Map<string, ViptelQueueStatus["members"][number]>();

  for (const status of statuses) {
    for (const member of status.members) {
      const current = members.get(member.extension);
      members.set(member.extension, current
        ? {
            ...member,
            inUse: current.inUse || member.inUse,
            paused: current.paused && member.paused,
          }
        : member);
    }
  }

  return [...members.values()];
}
