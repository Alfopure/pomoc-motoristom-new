import { expandIncomingFlow, MAX_INCOMING_FLOW_EXPANDED_STEPS, MAX_INCOMING_FLOW_DURATION_SECONDS } from "./incoming-flow";
import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

/** Check the candidate graph, including legacy return links, before any save. */
export function validateLineTransfers(document: RoutingDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = new Map(document.lines.map(line => [line.id, line]));
  function visit(id: string, path: string[], environment: string, root: string) {
    const line = lines.get(id);
    const add = (code: string, message: string) => issues.push({ path: root, code, message });
    if (path.includes(id)) { add("line_loop", "Presmerovanie liniek vytvára kruh. Vyber inú cieľovú linku."); return; }
    if (path.length >= 8) { add("line_depth", "Prepojenie môže prejsť najviac ôsmimi linkami."); return; }
    if (!line?.active || line.environment !== environment) { add("line_unavailable", "Cieľová linka musí byť aktívna a v rovnakom prostredí."); return; }
    if (line.ivrMenuId || line.incomingFlowInvalid) { add("line_route_unsupported", "Cieľová linka má hlasové menu alebo nepodporované smerovanie."); return; }
    const nextPath = [...path, id];
    if (line.returnLineId) visit(line.returnLineId, nextPath, environment, root);
    for (const step of line.incomingFlow?.steps ?? []) if (step.type === "line") visit(step.lineId, nextPath, environment, root);
  }
  for (const line of document.lines) for (const [index, step] of (line.incomingFlow?.steps ?? []).entries()) if (step.type === "line") visit(step.lineId, [line.id], line.environment, `${line.id}.steps.${index}`);
  function metrics(id: string, path: string[] = []): { count: number; seconds: number } {
    const line = lines.get(id);
    if (!line || path.includes(id) || path.length >= 8) return { count: 0, seconds: 0 };
    if (line.returnLineId) return metrics(line.returnLineId, [...path, id]);
    const expanded = line.incomingFlow ? expandIncomingFlow(line.incomingFlow) : null;
    const legacy = document.plans.find(plan => plan.id === line.ringPlanId);
    const count = expanded?.length ?? legacy?.steps.length ?? 0;
    const seconds = expanded?.reduce((sum, { step }) => sum + (step.type === "wait" ? step.minutes * 60 : step.type === "line" ? 0 : step.seconds), 0) ?? legacy?.steps.reduce((sum, step) => sum + step.timeoutSecs, 0) ?? 0;
    const target = line.incomingFlow?.steps.at(-1);
    const child = target?.type === "line" ? metrics(target.lineId, [...path, id]) : { count: 0, seconds: 0 };
    return { count: count + child.count, seconds: seconds + child.seconds };
  }
  for (const line of document.lines) if (line.incomingFlow?.steps.some(step => step.type === "line")) {
    const total = metrics(line.id);
    if (total.count > MAX_INCOMING_FLOW_EXPANDED_STEPS || total.seconds > MAX_INCOMING_FLOW_DURATION_SECONDS) issues.push({ path: line.id, code: "line_route_too_long", message: "Celý prepojený postup môže vykonať najviac 100 krokov a trvať dve hodiny. Skráť čakanie alebo opakovanie." });
  }
  return issues;
}
