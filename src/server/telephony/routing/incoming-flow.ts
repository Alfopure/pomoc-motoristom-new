import { expandIncomingFlow, type IncomingFlow } from "@/lib/telephony/incoming-flow";
import { incomingFlowSignature } from "@/lib/telephony/call-journey";
import type { FrozenRingMember, FrozenRingPlan, FrozenRingStep } from "../state/types";
import { applyPausedOperatorRouting, type PausedOperatorRouting } from "./ring-plan";

/**
 * Compile an explicitly saved flow once per call. Repeats become new execution
 * indices: no provider command key or old attempt is ever reused for a retry.
 * The resulting plan owns no legacy plan/group rows, so all database FKs stay null.
 */
export function materialiseIncomingFlow(flow: IncomingFlow, now: Date, pausedRouting?: {
  pausedProfileIds: ReadonlySet<string>;
  routing: readonly PausedOperatorRouting[];
  destinationAllowlist: readonly string[];
}): FrozenRingPlan {
  const origins: Array<{ repeatStepId?: string; repeatRound?: number }> = [];
  for (const step of flow.steps) {
    if (step.type === "repeat") for (let round = 1; round <= step.times; round++) for (const _id of step.stepIds) origins.push({ repeatStepId: step.id, repeatRound: round });
    else origins.push({});
  }
  const steps: FrozenRingStep[] = expandIncomingFlow(flow).map(({ step, sourceId, occurrenceId }, index) => {
    const common = { index, groupId: null, sourceId, occurrenceId, ...origins[index], strategy: "all" as const };
    if (step.type === "wait") return { ...common, kind: "wait", groupName: "Čakáreň", timeoutSecs: 0, waitMinutes: step.minutes, ...(step.policy ? { waitPolicy: { ...step.policy } } : {}), members: [] };
    if (step.type === "external") return {
      ...common, kind: "ring", groupName: "Záložné číslo", timeoutSecs: step.seconds,
      members: [{ kind: "external_number", profileId: null, externalNumber: step.number, provenance: "configured_external", position: 0, ringSecs: step.seconds, memberId: null }],
    };
    const members: FrozenRingMember[] = [];
    for (const person of step.people) {
      if (person.application) members.push({ kind: "operator", profileId: person.profileId, externalNumber: null, application: true, position: members.length, ringSecs: step.seconds, memberId: null });
      if (person.personalNumber) members.push({ kind: "external_number", profileId: person.profileId, ownerProfileId: person.profileId, externalNumber: person.personalNumber, provenance: "personal_mobile", position: members.length, ringSecs: step.seconds, memberId: null });
    }
    return { ...common, kind: "ring", groupName: "Operátori", timeoutSecs: step.seconds,
      members: pausedRouting ? applyPausedOperatorRouting(members, pausedRouting) : members };
  });
  return { source: "incoming_flow", flowSignature: incomingFlowSignature(flow), planId: null, name: "Postup prichádzajúceho hovoru", frozenAt: now.toISOString(), steps,
    fallback: { kind: flow.ending, number: null }, queueMembers: [] };
}
