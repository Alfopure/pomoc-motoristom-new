import type { RingGroupDoc, RingPlanDoc, RoutingDocument } from "@/server/telephony/config-service";
import { groupDraftsFromDocument, ringGroupsPayload, type GroupDraft } from "./ring-groups-model";
import { planDraftsFromDocument, ringPlansPayload, type PlanDraft } from "./ring-plan-model";

export type IncomingDraft = { groups: GroupDraft[]; plans: PlanDraft[] };
export const incomingDraft = (document: RoutingDocument): IncomingDraft => ({ groups: groupDraftsFromDocument(document.groups), plans: planDraftsFromDocument(document.plans) });
/** UUIDs are created at addition, not serialization: new steps can refer to new groups in the same save. */
export function identifyGroups(groups: GroupDraft[], uuid: () => string = () => crypto.randomUUID()): GroupDraft[] {
  return groups.map(group => ({ ...group, id: group.id ?? uuid(), members: group.members.map(member => ({ ...member, id: member.id ?? uuid() })) }));
}
export function identifyPlans(plans: PlanDraft[], uuid: () => string = () => crypto.randomUUID()): PlanDraft[] {
  return plans.map(plan => ({ ...plan, id: plan.id ?? uuid(), steps: plan.steps.map(step => ({ ...step, id: step.id ?? uuid() })) }));
}
export function incomingPayload(draft: IncomingDraft) { return { groups: ringGroupsPayload(draft.groups), plans: ringPlansPayload(draft.plans) }; }
export function incomingMatches(draft: IncomingDraft, document: RoutingDocument): boolean {
  const canonical = (value: ReturnType<typeof incomingPayload>) => JSON.stringify({
    groups: [...value.groups].sort((a,b) => String(a.id).localeCompare(String(b.id))).map(group => ({ ...group, members: group.members.map(({ ownerProfileId, ...member }) => ({ ...member, ownerProfileId: ownerProfileId ?? null })) })),
    plans: [...value.plans].sort((a,b) => String(a.id).localeCompare(String(b.id))),
  });
  return canonical(incomingPayload(draft)) === canonical(incomingPayload(incomingDraft(document)));
}
export function documentWithDraft(document: RoutingDocument, draft: IncomingDraft): RoutingDocument {
  const payload = incomingPayload(draft);
  const history = new Map(document.groups.flatMap(group => group.members.map(member => [member.id, member] as const)));
  return { ...document,
    groups: payload.groups.map(group => ({ ...group, id: group.id!, description: group.description ?? null, active: group.active ?? true, members: group.members.map(member => ({ ...member, id: member.id!, profileId: member.profileId ?? null, externalNumber: member.externalNumber ?? null, ringSecs: member.ringSecs ?? null, lastOfferedAt: history.get(member.id!)?.lastOfferedAt ?? null, lastAnsweredAt: history.get(member.id!)?.lastAnsweredAt ?? null })) })) as RingGroupDoc[],
    plans: payload.plans.map(plan => ({ ...plan, id: plan.id!, active: plan.active ?? true, fallbackNumber: plan.fallbackNumber ?? null, steps: plan.steps.map(step => ({ ...step, id: step.id! })) })) as RingPlanDoc[],
  };
}
