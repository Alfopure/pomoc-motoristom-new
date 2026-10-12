import type { LineDoc, LinePatchInput, RoutingDocument } from "@/server/telephony/config-service";
import type { LineWorkspaceChange } from "@/server/telephony/line-workspace-service";
import { incomingFlowChanges, type FlowDrafts } from "./incoming-flow-model";

export type LineProperties = Pick<LineDoc, "label" | "partnerName" | "active" | "businessHoursId" | "environment" | "returnLineId" | "ringPlanId" | "ivrMenuId" | "inboundCallMode">;
export type LinePropertyDrafts = Record<string, LineProperties>;
export const lineProperties = (line: LineDoc): LineProperties => ({ label: line.label, partnerName: line.partnerName, active: line.active, businessHoursId: line.businessHoursId, environment: line.environment, returnLineId: line.returnLineId ?? null, ringPlanId: line.ringPlanId, ivrMenuId: line.ivrMenuId, inboundCallMode: line.inboundCallMode ?? null });
export function lineWorkspaceChanges(flows: FlowDrafts, drafts: LinePropertyDrafts, document: RoutingDocument): LineWorkspaceChange[] {
  const changedFlows = incomingFlowChanges(flows, document);
  return [...new Set([...changedFlows.map(change => change.id), ...Object.keys(drafts)])].flatMap(id => {
    const original = document.lines.find(line => line.id === id);
    if (!original) return [];
    const draft = drafts[id], patch: LinePatchInput = {};
    if (draft) {
      const values = { ...draft, label: draft.label.trim(), partnerName: draft.partnerName?.trim() || null };
      for (const key of ["label", "partnerName", "active", "businessHoursId", "environment", "returnLineId", "ringPlanId", "ivrMenuId", "inboundCallMode"] as const) if ((values[key] ?? null) !== (original[key] ?? null)) Object.assign(patch, { [key]: values[key] });
    }
    const flow = changedFlows.find(change => change.id === id)?.flow ?? null;
    return flow || Object.keys(patch).length ? [{ id, flow, expectedFlow: original.incomingFlow ?? null, patch }] : [];
  });
}
export function workspaceChangesMatch(changes: LineWorkspaceChange[], document: RoutingDocument): boolean {
  const equal = (left: unknown, right: unknown): boolean => {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  };
  return changes.every(change => {
    const line = document.lines.find(line => line.id === change.id);
    return Boolean(line && !line.incomingFlowInvalid && equal(line.incomingFlow ?? null, change.flow ?? change.expectedFlow) && Object.entries(change.patch ?? {}).every(([key, value]) => equal(line[key as keyof LineDoc] ?? null, value)));
  });
}
