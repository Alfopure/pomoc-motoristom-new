import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { IncomingFlowValidationError, parseIncomingFlow, type IncomingFlow } from "@/lib/telephony/incoming-flow";
import type { Json } from "@/lib/supabase/database.types";
import {
  AUDIT_FAILED_WARNING, ConfigServiceError, getCoherentRoutingDocument, routingDocumentFromSnapshot,
  type ConfigActor, type ConfigDeps, type RoutingDocument, type RoutingSnapshot, type ValidationIssue,
} from "./config-service";

export type IncomingFlowChange = { id: string; flow: IncomingFlow; expectedFlow: IncomingFlow | null };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(["dispatcher", "senior_dispatcher", "manager", "admin"]);

export function parseIncomingFlowChanges(value: unknown): IncomingFlowChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new ConfigServiceError("Vyber 1 až 200 zmenených liniek.");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!record(raw) || Object.keys(raw).some(key => !["id", "flow", "expectedFlow"].includes(key)) || !("expectedFlow" in raw) || typeof raw.id !== "string" || !UUID.test(raw.id)) throw new ConfigServiceError("Zmena linky má neplatný formát.");
    const id = raw.id.toLowerCase();
    if (seen.has(id)) throw new ConfigServiceError("Každú linku možno uložiť iba raz.");
    seen.add(id);
    try { return { id, flow: parseIncomingFlow(raw.flow), expectedFlow: raw.expectedFlow === null ? null : parseIncomingFlow(raw.expectedFlow) }; }
    catch (error) {
      if (error instanceof IncomingFlowValidationError) throw new ConfigServiceError("Skontroluj postup hovoru.", 400, "config_invalid", error.issues.map(issue => ({ ...issue, path: `lines[${index}].${issue.path}` })));
      throw error;
    }
  });
}

/** JSONB object ordering must never make a successful write look uncertain. */
export function incomingFlowsEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Validate the entire candidate against the same coherent organization snapshot. */
export function validateIncomingFlowChanges(changes: IncomingFlowChange[], document: RoutingDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const operators = new Map(document.operators.map(operator => [operator.profileId, operator]));
  const ownNumbers = new Set(document.lines.map(line => line.phoneNumber));
  const owners = new Map<string, Set<string>>();
  const own = (number: string | null | undefined, profileId: string) => {
    if (!number) return;
    const set = owners.get(number) ?? new Set<string>(); set.add(profileId); owners.set(number, set);
  };
  document.operators.forEach(operator => own(operator.settings?.defaultMobileNumber, operator.profileId));
  document.groups.forEach(group => group.members.forEach(member => { if (member.ownerProfileId) own(member.externalNumber, member.ownerProfileId); }));
  const candidateFlows = document.lines.map(line => changes.find(change => change.id === line.id)?.flow ?? line.incomingFlow);
  candidateFlows.forEach(flow => flow?.steps.forEach(step => { if (step.type === "ring") step.people.forEach(person => own(person.personalNumber, person.profileId)); }));
  const checkNumber = (number: string, path: string, owner?: string) => {
    if (!isDestinationAllowed(number, document.limits?.destinationAllowlist)) add(path, "number_not_allowed", "Číslo nie je medzi povolenými cieľmi organizácie.");
    if (ownNumbers.has(number)) add(path, "number_loop", "Cieľ nemôže byť jednou z vlastných dispečerských liniek.");
    if (owner && [...(owners.get(number) ?? [])].some(id => id !== owner)) add(path, "number_owner_conflict", "Toto osobné číslo je už priradené inému operátorovi.");
  };
  changes.forEach((change, lineIndex) => {
    const path = `lines[${lineIndex}]`;
    const line = document.lines.find(line => line.id === change.id);
    if (!line || !line.active) { add(path, "line_unavailable", "Linka už nie je aktívna alebo dostupná."); return; }
    if (line.incomingFlowInvalid) add(path, "flow_unsupported", "Uložený postup má nepodporovaný formát; nebol prepísaný.");
    if (line.ivrMenuId || line.returnLineId || document.lines.some(other => other.returnLineId === line.id)) add(path, "legacy_route_unsupported", "Táto linka používa hlasové menu alebo návratovú linku. Uprav ju v pôvodných nastaveniach.");
    if (!incomingFlowsEqual(line.incomingFlow ?? null, change.expectedFlow)) add(path, "flow_conflict", "Postup linky medzitým zmenil niekto iný. Načítaj ho znova.");
    change.flow.steps.forEach((step, stepIndex) => {
      const stepPath = `${path}.flow.steps[${stepIndex}]`;
      if (step.type === "external") checkNumber(step.number, `${stepPath}.number`);
      if (step.type !== "ring") return;
      const endpointCount = step.people.reduce((sum, person) => sum + (person.application ? 2 : 0) + (person.personalNumber ? 1 : 0), 0);
      const max = Math.min(document.limits?.maxRingFanout ?? 0, (document.limits?.maxConcurrentLegs ?? 1) - 1);
      if (endpointCount > max) add(stepPath, "fanout_exceeded", `V jednom kroku môže zvoniť najviac ${max} zariadení. Aplikácia môže zvoniť na webe aj v mobile.`);
      step.people.forEach((person, personIndex) => {
        const personPath = `${stepPath}.people[${personIndex}]`;
        const operator = operators.get(person.profileId);
        if (!operator?.active || !ROLES.has(operator.role) || operator.accessStatus !== "active") add(personPath, "operator_unavailable", "Vyber aktívneho operátora s prístupom do dispečingu.");
        if (person.personalNumber) {
          if (!document.capabilities?.ownedMobileRouting) add(personPath, "owned_mobile_unavailable", "Zvonenie na osobné čísla tu ešte nie je aktivované.");
          checkNumber(person.personalNumber, `${personPath}.personalNumber`, person.profileId);
        }
      });
    });
  });
  return issues;
}

export async function saveIncomingFlows(deps: ConfigDeps, input: { organizationId: string; actor: ConfigActor; changes: IncomingFlowChange[]; expectedVersion: number; expectedSnapshotId: string }): Promise<{ document: RoutingDocument; warning: string | null }> {
  if (!["admin", "manager"].includes(input.actor.role)) throw new ConfigServiceError("Nemáš oprávnenie upravovať smerovanie.", 403, "forbidden");
  const readInput = { organizationId: input.organizationId, includeSettings: true };
  const before = await getCoherentRoutingDocument(deps, readInput);
  if (!before.capabilities?.unifiedIncomingFlow) throw new ConfigServiceError("Nový postup ešte nie je na tomto prostredí aktivovaný.", 503, "config_migration_missing");
  if (before.routingVersion !== input.expectedVersion || before.snapshotId !== input.expectedSnapshotId) throw new ConfigServiceError("Nastavenia medzitým zmenil niekto iný. Načítaj ich znova.", 409, "stale_document");
  // Service callers receive the same parser guarantees as HTTP callers.
  const changes = parseIncomingFlowChanges(input.changes);
  const issues = validateIncomingFlowChanges(changes, before);
  if (issues.length) throw new ConfigServiceError("Skontroluj nastavenie postupu hovoru.", issues.some(issue => issue.code === "flow_conflict") ? 409 : 400, "config_invalid", issues);
  const actual = changes.filter(change => !incomingFlowsEqual(change.flow, change.expectedFlow));
  if (!actual.length) return { document: before, warning: null };
  const { data, error } = await deps.admin.rpc("motorist_save_incoming_flow", {
    p_organization_id: input.organizationId,
    p_expected_version: input.expectedVersion,
    p_expected_snapshot_id: input.expectedSnapshotId,
    p_changes: actual.map(change => ({ id: change.id, flow: change.flow, expected_flow: change.expectedFlow })) as unknown as Json,
  });
  if (error) {
    if (/stale_document|flow_conflict|incoming_line_not_found|incoming_route_changed/.test(`${error.code} ${error.message}`)) throw new ConfigServiceError("Nastavenia medzitým zmenil niekto iný. Žiadna časť návrhu sa neuložila.", 409, "stale_document");
    if (/incoming_number_owner_conflict/.test(error.message)) throw new ConfigServiceError("Osobné číslo medzitým priradil inému operátorovi niekto iný. Načítaj nastavenia znova.", 409, "stale_document");
    if (/incoming_flow_invalid|incoming_profile_invalid/.test(error.message)) throw new ConfigServiceError("Postup obsahuje nedostupnú linku alebo operátora.", 400, "config_invalid");
    if (/PGRST202|does not exist|schema cache/.test(`${error.code} ${error.message}`)) throw new ConfigServiceError("Uloženie postupu tu ešte nie je aktivované.", 503, "config_migration_missing");
    throw new ConfigServiceError("Uloženie sa nepodarilo potvrdiť. Najprv over uložený stav.", 503, "config_save_uncertain");
  }
  let document: RoutingDocument;
  try {
    const result = data as unknown as { before: RoutingSnapshot; after: RoutingSnapshot };
    document = routingDocumentFromSnapshot(result.after, readInput);
    if (actual.some(change => !incomingFlowsEqual(document.lines.find(line => line.id === change.id)?.incomingFlow, change.flow))) throw new Error("flow_readback_mismatch");
  } catch { throw new ConfigServiceError("Uloženie sa nepodarilo potvrdiť. Najprv over uložený stav.", 503, "config_save_uncertain"); }
  const audit = await deps.admin.from("motorist_audit_log").insert({
    organization_id: input.organizationId, actor_profile_id: input.actor.profileId,
    action: "telephony.incoming_flow.replace", entity_type: "telephony_config", entity_id: null, source: "dispatch_console",
    before_payload: actual.map(change => ({ id: change.id, flow: change.expectedFlow })) as unknown as Json,
    after_payload: actual.map(change => ({ id: change.id, flow: change.flow })) as unknown as Json,
  });
  return { document, warning: audit.error ? AUDIT_FAILED_WARNING : null };
}
