import { telephonyStabilityEnabled } from "../stability";
import { buildBusinessHoursSchedule } from "@/lib/telephony/business-hours";
import { MAX_INCOMING_FLOW_DURATION_SECONDS, MAX_INCOMING_FLOW_EXPANDED_STEPS, parseIncomingFlow } from "@/lib/telephony/incoming-flow";
import { isArchivedLine } from "../line-archive";
import { lineModeBehaviour, type FrozenRingPlan, type LineInboundMode } from "../state/types";
import type { RuntimeRoutingSnapshot } from "./snapshot";
import { materialiseIncomingFlow } from "./incoming-flow";
import { materialiseRingPlanRows } from "./ring-plan";

/** Freeze the complete finite chain once. Every attempt keeps a unique index. */
export function materialiseLineFlow(snapshot: RuntimeRoutingSnapshot, sourceLineId: string, now: Date, pausedRouting: NonNullable<Parameters<typeof materialiseIncomingFlow>[2]>): FrozenRingPlan {
  const source = snapshot.lines.find(line => line.id === sourceLineId);
  if (!source) throw new Error("incoming_line_unavailable");
  function compile(id: string, path: string[]): FrozenRingPlan {
    const line = snapshot.lines.find(candidate => candidate.id === id);
    if (path.includes(id) || path.length >= 8) throw new Error("incoming_line_loop");
    if (!line?.active || line.environment !== source!.environment || isArchivedLine(line.metadata) || line.ivr_menu_id) throw new Error("incoming_line_unavailable");
    const metadata = (line.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.return_line_id === "string") return compile(metadata.return_line_id, [...path, id]);
    const flow = metadata.incoming_flow ? parseIncomingFlow(metadata.incoming_flow) : null;
    let plan = flow ? materialiseIncomingFlow(flow, now, pausedRouting) : materialiseRingPlanRows({
      plan: snapshot.plans.find(plan => plan.id === line.ring_plan_id) ?? null, steps: snapshot.steps, groups: snapshot.groups, members: snapshot.members,
      operatorRouting: snapshot.operatorSettings, pausedProfileIds: pausedRouting.pausedProfileIds, destinationAllowlist: pausedRouting.destinationAllowlist, personalMobileEnabled: telephonyStabilityEnabled(), now,
    });
    if (!plan) plan = { planId: null, name: line.label, frozenAt: now.toISOString(), steps: [], fallback: { kind: "callback_prompt", number: null }, queueMembers: [] };
    const last = flow?.steps.at(-1);
    if (last?.type === "line") {
      const target = snapshot.lines.find(candidate => candidate.id === last.lineId);
      if (!target) throw new Error("incoming_line_unavailable");
      const child = compile(target.id, [...path, id]);
      const effectiveTarget = typeof (target.metadata as Record<string, unknown> | null)?.return_line_id === "string"
        ? snapshot.lines.find(candidate => candidate.id === (target.metadata as Record<string, unknown>).return_line_id) ?? target : target;
      const hours = snapshot.hours.find(hours => hours.id === effectiveTarget.business_hours_id && hours.active);
      const transferHours = hours ? buildBusinessHoursSchedule({ timezone: hours.timezone, intervals: snapshot.intervals.filter(row => row.business_hours_id === hours.id), exceptions: snapshot.exceptions.filter(row => row.business_hours_id === hours.id) }) : null;
      const mode = lineModeBehaviour(((effectiveTarget.metadata as Record<string, unknown> | null)?.inbound_call_mode ?? null) as LineInboundMode | null, snapshot.settings?.inbound_call_mode ?? "ring_first");
      plan = { ...plan, steps: [...plan.steps.slice(0, -1), { ...plan.steps.at(-1)!, targetLineLabel: target.label, transferHours, transferMode: child.source === "incoming_flow" ? "ring_first" : mode.inboundCallMode }, ...child.steps], fallback: child.fallback, queueMembers: child.queueMembers };
    } else if (!flow) {
      const mode = lineModeBehaviour((metadata.inbound_call_mode ?? null) as LineInboundMode | null, snapshot.settings?.inbound_call_mode ?? "ring_first");
      if (mode.strategyOverride) plan = { ...plan, steps: plan.steps.map(step => ({ ...step, strategy: mode.strategyOverride! })) };
    }
    return plan;
  }
  const plan = compile(sourceLineId, []);
  const ownNumbers = new Set(snapshot.lines.map(line => line.phone_number));
  if (plan.steps.length > MAX_INCOMING_FLOW_EXPANDED_STEPS || plan.steps.reduce((sum, step) => sum + (step.waitMinutes ? step.waitMinutes * 60 : step.timeoutSecs), 0) > MAX_INCOMING_FLOW_DURATION_SECONDS || plan.steps.some(step => step.members.some(member => member.externalNumber && ownNumbers.has(member.externalNumber))) || plan.fallback.number && ownNumbers.has(plan.fallback.number)) throw new Error("incoming_line_route_invalid");
  return { ...plan, steps: plan.steps.map((step, index) => ({ ...step, index, occurrenceId: `${step.sourceId ?? step.groupId ?? "line"}:${index}` })) };
}
