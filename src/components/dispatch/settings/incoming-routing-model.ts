import type { LineDoc, RingGroupDoc, RingPlanDoc, RoutingDocument } from "@/server/telephony/config-service";
import type { RoutingNavigationTarget } from "@/lib/telephony/routing-summary";
import { groupDraftsFromDocument, ringGroupsPayload, type GroupDraft } from "./ring-groups-model";
import { FALLBACK_LABELS, planDraftsFromDocument, ringPlansPayload, type PlanDraft } from "./ring-plan-model";

export type IncomingDraft = { groups: GroupDraft[]; plans: PlanDraft[] };

/** The dialled line's override wins, including when it borrows a return route. */
export function incomingLineBehaviour(line: LineDoc | undefined, defaultMode: "ring_first" | "queue_first" | null) {
  const mode = line?.inboundCallMode ?? defaultMode;
  return {
    mode: mode === "queue_first" ? "queue_first" as const : mode ? "ring_first" as const : null,
    strategyOverride: mode === "ring_all" ? "all" as const : mode === "ring_ordered" ? "ordered" as const : null,
  };
}

/** A display scope only: callers must keep the full draft for validation/save. */
export function incomingPlanIdsForLine(document: RoutingDocument, lineId: string): string[] | null {
  if (!lineId) return null;
  const source = document.lines.find(line => line.id === lineId);
  const line = source?.returnLineId ? document.lines.find(row => row.id === source.returnLineId) : source;
  const menu = document.ivrMenus.find(row => row.id === line?.ivrMenuId);
  return [...new Set([
    line?.ringPlanId,
    ...(menu?.ringPlanIds ?? []),
    ...(menu?.options.filter(option => option.action === "ring_plan").map(option => option.targetRingPlanId) ?? []),
  ].filter((id): id is string => Boolean(id)))];
}

/** Describe branches as alternatives, and never promise an inactive group's fallback. */
export function incomingRouteSummary(document: RoutingDocument, lineId: string): { ring: string; fallback: string } {
  const source = document.lines.find(line => line.id === lineId);
  const line = source?.returnLineId ? document.lines.find(row => row.id === source.returnLineId) : source;
  if (!source?.active || !line?.active) return { ring: "Linka nie je aktívna", fallback: "Smerovanie sa nespustí" };
  const menu = document.ivrMenus.find(row => row.id === line.ivrMenuId);
  if (menu?.active) return { ring: "Podľa voľby v hlasovom menu", fallback: "Podľa zvolenej vetvy" };
  const plan = document.plans.find(row => row.id === line.ringPlanId);
  const groups = plan?.active ? plan.steps.flatMap(step => document.groups.filter(group => group.id === step.ringGroupId && group.active)) : [];
  if (!plan?.active || groups.length === 0) return { ring: "Bez aktívnych krokov", fallback: "Spätné volanie, ak je možné" };
  return { ring: [...new Set(groups.filter(group => group.members.length > 0).map(group => group.name))].join(", ") || "Bez členov na zvonenie",
    fallback: FALLBACK_LABELS[plan.fallbackKind] };
}

/** Explicit navigation can reveal a plan/group outside the default active line. */
export function initialIncomingLineId(document: RoutingDocument, target?: RoutingNavigationTarget | null): string {
  const requested = document.lines.find(line => line.id === target?.lineId);
  if (target?.planId || target?.groupId) {
    const visible = requested ? incomingPlanIdsForLine(document, requested.id) : [];
    if (target.planId && !visible?.includes(target.planId)) return "";
    if (target.groupId && !document.plans.some(plan => visible?.includes(plan.id) && plan.steps.some(step => step.ringGroupId === target.groupId))) return "";
  }
  return requested?.id ?? document.lines.find(line => line.active)?.id ?? document.lines[0]?.id ?? "";
}

/** A line PATCH returns a legacy document; keep the coherent plan snapshot and unsaved draft baseline. */
export function mergeSavedLine(document: RoutingDocument, saved: RoutingDocument): RoutingDocument {
  return { ...document, lines: saved.lines, settings: saved.settings ?? document.settings,
    capabilities: saved.capabilities ?? document.capabilities };
}
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
