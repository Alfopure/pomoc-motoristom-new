import type { Json } from "@/lib/supabase/database.types";
import { parseIncomingFlow, type IncomingFlow } from "@/lib/telephony/incoming-flow";
import { returnLineProblem } from "@/lib/telephony/return-line";
import { validateLineTransfers } from "@/lib/telephony/line-transfers";
import { isUuid } from "@/lib/telephony/uuid";
import { AUDIT_FAILED_WARNING, ConfigServiceError, contextFromDocument, getCoherentRoutingDocument, parseLinePatch, routingDocumentFromSnapshot, validateLinePatch, type ConfigActor, type ConfigDeps, type LinePatchInput, type RoutingDocument, type RoutingSnapshot } from "./config-service";
import { incomingFlowsEqual, validateIncomingFlowChanges } from "./incoming-flow-service";

export type LineWorkspaceChange = { id: string; flow: IncomingFlow | null; expectedFlow: IncomingFlow | null; patch?: LinePatchInput };
const PATCH_FIELDS = new Set(["label", "partnerName", "active", "businessHoursId", "environment", "returnLineId", "ringPlanId", "ivrMenuId", "inboundCallMode"]);
export function parseLineWorkspaceChanges(input: unknown): LineWorkspaceChange[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 200) throw new ConfigServiceError("Vyber 1 až 200 liniek.");
  const seen = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["id", "flow", "expectedFlow", "patch"].includes(key)) || !isUuid(raw.id) || !("expectedFlow" in raw) || !("flow" in raw)) throw new ConfigServiceError("Zmena linky má neplatný formát.");
    const id = raw.id.toLowerCase();
    if (seen.has(id)) throw new ConfigServiceError("Linka je v návrhu viackrát.");
    seen.add(id);
    if (raw.patch !== undefined && (!raw.patch || typeof raw.patch !== "object" || Array.isArray(raw.patch) || Object.keys(raw.patch).some(key => !PATCH_FIELDS.has(key)))) throw new ConfigServiceError("Nepodporované nastavenie linky.");
    try { return { id, flow: raw.flow === null ? null : parseIncomingFlow(raw.flow), expectedFlow: raw.expectedFlow === null ? null : parseIncomingFlow(raw.expectedFlow), ...(raw.patch ? { patch: parseLinePatch(raw.patch) } : {}) }; }
    catch (error) { throw new ConfigServiceError(error instanceof Error ? error.message : "Postup nie je platný."); }
  });
}

export function lineWorkspaceMatches(changes: LineWorkspaceChange[], document: RoutingDocument): boolean {
  return changes.every(change => {
    const line = document.lines.find(line => line.id === change.id);
    return Boolean(line && !line.incomingFlowInvalid && incomingFlowsEqual(line.incomingFlow ?? null, change.flow ?? change.expectedFlow) && Object.entries(change.patch ?? {}).every(([key, value]) => incomingFlowsEqual(line[key as keyof typeof line] ?? null, value)));
  });
}

export async function saveLineWorkspace(deps: ConfigDeps, input: { organizationId: string; actor: ConfigActor; changes: LineWorkspaceChange[]; expectedVersion: number; expectedSnapshotId: string }) {
  if (!["admin", "manager"].includes(input.actor.role)) throw new ConfigServiceError("Nemáš oprávnenie upravovať linky.", 403, "forbidden");
  const readInput = { organizationId: input.organizationId, includeSettings: true };
  const before = await getCoherentRoutingDocument(deps, readInput);
  if (!before.capabilities?.lineWorkspace) throw new ConfigServiceError("Spoločné uloženie liniek ešte nie je aktivované.", 503, "config_migration_missing");
  if (before.routingVersion !== input.expectedVersion || before.snapshotId !== input.expectedSnapshotId) throw new ConfigServiceError("Nastavenia medzitým zmenil kolega. Načítaj ich znova.", 409, "stale_document");
  const changes = parseLineWorkspaceChanges(input.changes);
  const candidate = { ...before, lines: before.lines.map(line => {
    const change = changes.find(change => change.id === line.id);
    return { ...line, ...change?.patch, incomingFlow: change?.flow ?? line.incomingFlow };
  }) };
  const issues = changes.flatMap(change => {
    const line = before.lines.find(line => line.id === change.id);
    if (!line || !incomingFlowsEqual(line.incomingFlow ?? null, change.expectedFlow)) throw new ConfigServiceError("Linka alebo postup sa medzitým zmenili.", 409, "stale_document");
    if ((line.incomingFlow || change.flow) && ["returnLineId", "ringPlanId", "ivrMenuId", "inboundCallMode"].some(key => key in (change.patch ?? {}))) throw new ConfigServiceError("Zvonenie tejto linky nastav v krokoch postupu.", 400, "config_invalid");
    return validateLinePatch(change.patch ?? {}, contextFromDocument(candidate));
  });
  const flowChanges = changes.flatMap(change => change.flow ? [{ ...change, flow: change.flow }] : []);
  // Source drafts may be saved while disabling a line; destinations still
  // use the candidate's real active flags in the graph validation below.
  issues.push(...validateIncomingFlowChanges(flowChanges, { ...candidate, lines: candidate.lines.map(line => ({ ...line, active: flowChanges.some(change => change.id === line.id) || line.active, incomingFlow: before.lines.find(original => original.id === line.id)?.incomingFlow })) }));
  issues.push(...validateLineTransfers(candidate));
  for (const line of candidate.lines) {
    const problem = returnLineProblem(line, candidate.lines, candidate.plans, candidate.groups, new Set(candidate.operators.filter(operator => operator.active).map(operator => operator.profileId)));
    if (problem) issues.push({ path: `${line.id}.returnLineId`, code: "return_line_invalid", message: problem });
  }
  if (issues.length) throw new ConfigServiceError("Skontroluj nastavenia liniek.", 400, "config_invalid", issues);
  const actual = changes.filter(change => !lineWorkspaceMatches([change], before));
  if (!actual.length) return { document: before, warning: null };
  const { data, error } = await deps.admin.rpc("motorist_save_line_workspace", {
    p_organization_id: input.organizationId, p_expected_version: input.expectedVersion, p_expected_snapshot_id: input.expectedSnapshotId,
    p_changes: actual.map(change => ({ id: change.id, flow: change.flow, expected_flow: change.expectedFlow, patch: change.patch ?? {} })) as unknown as Json,
  });
  if (error) {
    if (/stale_document|flow_conflict|incoming_route_changed|incoming_line_not_found/.test(error.message)) throw new ConfigServiceError("Nastavenia medzitým zmenil kolega. Žiadna časť návrhu sa neuložila.", 409, "stale_document");
    if (/incoming_.*(invalid|loop|conflict)/.test(error.message)) throw new ConfigServiceError("Cieľová linka alebo príjemca nie sú dostupní. Skontroluj prepojenia.", 400, "config_invalid");
    throw new ConfigServiceError("Uloženie sa nepodarilo potvrdiť. Over uložený stav.", 503, "config_save_uncertain");
  }
  let document: RoutingDocument;
  try {
    const committed = data as unknown as { after: RoutingSnapshot };
    document = routingDocumentFromSnapshot(committed.after, readInput);
    if (!lineWorkspaceMatches(actual, document)) throw new Error("readback_mismatch");
  } catch { throw new ConfigServiceError("Uloženie sa nepodarilo potvrdiť. Over uložený stav.", 503, "config_save_uncertain"); }
  const audit = await deps.admin.from("motorist_audit_log").insert({ organization_id: input.organizationId, actor_profile_id: input.actor.profileId, action: "telephony.lines.replace", entity_type: "telephony_config", source: "dispatch_console", after_payload: actual as unknown as Json });
  return { document, warning: audit.error ? AUDIT_FAILED_WARNING : null };
}
