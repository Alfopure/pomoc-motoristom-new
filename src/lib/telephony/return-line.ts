import { normalizeE164 } from "./normalize-e164";

export type ReturnLine = { id: string; active: boolean; environment: string; ringPlanId: string | null; returnLineId?: string | null };
export type ReturnPlan = { id: string; active: boolean; steps: readonly { ringGroupId: string }[] };
export type ReturnGroup = { id: string; active: boolean; members: readonly { profileId: string | null; externalNumber: string | null }[] };

export function returnLineId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).return_line_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A return number uses one internal line's routing and greeting. Never dial a
 * public number to reach that line, and never accept an empty fallback plan. */
export function returnLineProblem(source: ReturnLine, lines: readonly ReturnLine[], plans: readonly ReturnPlan[], groups: readonly ReturnGroup[], profileIds: ReadonlySet<string>): string | null {
  if (!source.returnLineId) return null;
  const target = lines.find(line => line.id === source.returnLineId);
  if (!target || !target.active) return "Cieľová linka musí byť aktívna a patriť do tejto organizácie.";
  if (target.id === source.id || target.returnLineId) return "Návratová linka nesmie smerovať sama na seba ani na ďalšiu návratovú linku.";
  if (target.environment !== source.environment) return "Obe linky musia používať rovnaké prostredie.";
  const plan = plans.find(plan => plan.id === target.ringPlanId && plan.active);
  if (!plan || !plan.steps.some(step => groups.some(group => group.id === step.ringGroupId && group.active && group.members.some(member => (member.profileId && profileIds.has(member.profileId)) || (member.externalNumber && normalizeE164(member.externalNumber)))))) {
    return "Cieľová linka potrebuje aktívny plán s aspoň jednou obsadenou skupinou zvonenia.";
  }
  return null;
}
