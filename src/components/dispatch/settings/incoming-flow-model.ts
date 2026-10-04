import { IncomingFlowValidationError, parseIncomingFlow, type IncomingFlow, type IncomingFlowStep } from "@/lib/telephony/incoming-flow";
import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import type { LineDoc, RingGroupDoc, RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";
import { incomingLineBehaviour } from "./incoming-routing-model";

export type FlowDrafts = Record<string, IncomingFlow>;
export type FlowConversion = { flow: IncomingFlow | null; reason: string | null; canReplace: boolean };
export const FLOW_ENDINGS = {
  hangup_message: "Prehrať záverečnú hlášku a ukončiť hovor",
  callback_prompt: "Ponúknuť spätné volanie",
  hangup: "Ukončiť hovor bez hlášky",
} as const;

export function emptyIncomingFlow(): IncomingFlow {
  return { version: 1, steps: [], ending: "hangup_message" };
}

export function personalNumberIssue(value: string, document: RoutingDocument, profileId?: string): string | null {
  const number = normalizeE164(value);
  if (!number) return "Zadaj platné telefónne číslo, napríklad +421 910 123 456.";
  if (!isDestinationAllowed(number, document.limits?.destinationAllowlist)) return "Toto číslo nepatrí medzi povolené destinácie organizácie.";
  if (document.lines.some(line => normalizeE164(line.phoneNumber) === number)) return "Použi číslo príjemcu, nie jednu z liniek dispečingu. Hovor by sa vracal do rovnakého systému.";
  if (profileId) {
    const ownedByOther = document.operators.some(operator => operator.profileId !== profileId && normalizeE164(operator.settings?.defaultMobileNumber) === number)
      || document.groups.some(group => group.members.some(member => member.ownerProfileId && member.ownerProfileId !== profileId && normalizeE164(member.externalNumber) === number))
      || document.lines.some(line => line.incomingFlow?.steps.some(step => step.type === "ring" && step.people.some(person => person.profileId !== profileId && normalizeE164(person.personalNumber) === number)));
    if (ownedByOther) return "Toto osobné číslo je už priradené inému operátorovi.";
  }
  return null;
}

/** Stable preview identity across hydration; this is not a provider command ID. */
function legacyStepId(stepId: string, memberId: string): string {
  const left = stepId.replaceAll("-", ""), right = memberId.replaceAll("-", "");
  const hex = Array.from({ length: 32 }, (_, index) => (Number.parseInt(left[index], 16) ^ Number.parseInt(right[(index + 7) % 32], 16)).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** This is a preview only. No conversion is persisted until the user explicitly edits and saves it. */
export function legacyIncomingFlow(document: RoutingDocument, line: LineDoc): FlowConversion {
  const blocked = (reason: string, canReplace = true): FlowConversion => ({ flow: null, reason, canReplace });
  if (line.incomingFlowInvalid) return blocked("Uložený postup sa nepodarilo bezpečne načítať. Pred úpravou je potrebné opraviť jeho údaje.", false);
  if (line.returnLineId || document.lines.some(candidate => candidate.returnLineId === line.id)) return blocked("Linka je prepojená s návratovým číslom. Pred novým postupom uprav toto priradenie v nastavení čísel.", false);
  if (line.ivrMenuId) return blocked("Linka má priradené hlasové menu. Jeho jednotlivé vetvy nájdeš v pôvodnom nastavení.", false);
  if (!line.active) return blocked("Linka je vypnutá. Pred vytvorením nového postupu ju zapni v nastavení čísel.", false);
  const behaviour = incomingLineBehaviour(line, document.capabilities?.defaultInboundCallMode ?? document.settings?.inboundCallMode ?? null);
  if (behaviour.mode === null) return blocked("Predvolený spôsob prijímania hovorov nie je dostupný.", false);
  if (behaviour.mode === "queue_first") return blocked("Hovor teraz vstupuje priamo do pôvodnej čakárne. Nový postup ju nahradí až po výslovnom uložení.");
  const plan = document.plans.find(candidate => candidate.id === line.ringPlanId);
  if (!plan?.active) return blocked("Linka nemá aktívny plán zvonenia. Môžeš pre ňu pripraviť nový postup.");
  if (plan.fallbackKind === "waiting_room") return blocked("Pôvodná čakáreň automaticky ponúka hovory operátorom. Nový krok Čakáreň čaká na ručné prevzatie a potom pokračuje ďalej; nejde o rovnaké správanie.");
  if (plan.fallbackKind === "external_number") return blocked("Pôvodné záložné presmerovanie má vlastné ukončenie. V novom postupe ho nastav ako krok s konkrétnym časom a pokračovaním.");
  const steps: IncomingFlowStep[] = [];
  const personFor = (member: RingGroupDoc["members"][number]) => {
    let profileId = member.memberKind === "operator" ? member.profileId : member.ownerProfileId;
    if (!profileId && member.memberKind === "external_number") {
      const matches = document.operators.filter(operator => normalizeE164(operator.settings?.defaultMobileNumber) === normalizeE164(member.externalNumber));
      if (matches.length === 1) profileId = matches[0].profileId;
    }
    const operator = document.operators.find(candidate => candidate.profileId === profileId);
    if (!operator?.active || !operator.settings) return null;
    const mobile = member.memberKind === "external_number" || operator.settings.deliveryMode === "personal_mobile";
    const number = mobile ? normalizeE164(member.memberKind === "external_number" ? member.externalNumber : operator.settings.defaultMobileNumber) : null;
    if (mobile && (!number || personalNumberIssue(number, document, operator.profileId))) return null;
    return { profileId: operator.profileId, application: !mobile, personalNumber: number };
  };
  for (const step of [...plan.steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
    const group = document.groups.find(candidate => candidate.id === step.ringGroupId);
    if (!group?.active || !group.members.length) return blocked("Pôvodný plán obsahuje vypnutú alebo prázdnu skupinu. Skontroluj ho pred nahradením novým postupom.");
    const members = [...group.members].sort((a, b) => a.position - b.position);
    if ((behaviour.strategyOverride ?? step.strategy) === "ordered") {
      for (const member of members) {
        const person = personFor(member);
        const seconds = Math.min(120, Math.max(5, Math.round(member.ringSecs ?? step.timeoutSecs)));
        if (person) steps.push({ id: legacyStepId(step.id, member.id), type: "ring", seconds, people: [person] });
        else if (member.memberKind === "external_number" && !member.ownerProfileId && normalizeE164(member.externalNumber) && !personalNumberIssue(member.externalNumber!, document)) {
          steps.push({ id: legacyStepId(step.id, member.id), type: "external", number: normalizeE164(member.externalNumber)!, seconds });
        } else return blocked("Niektorého príjemcu nemožno bezpečne previesť. Skontroluj jeho aktivitu a nastavené telefónne číslo.");
      }
    } else {
      const people: Extract<IncomingFlowStep, { type: "ring" }>["people"] = [];
      for (const member of members) {
        const person = personFor(member);
        if (!person) return blocked("Súčasné zvonenie obsahuje samostatné číslo alebo nedostupného operátora. Jeho správanie ponechávame v pôvodnom nastavení.");
        const existing = people.find(candidate => candidate.profileId === person.profileId);
        if (existing) {
          if ((existing.application && person.application) || (existing.personalNumber && person.personalNumber)) return blocked("Ten istý príjemca má v skupine opakovaný spôsob zvonenia. Skontroluj pôvodné nastavenie.");
          existing.application ||= person.application;
          existing.personalNumber ??= person.personalNumber;
        } else people.push(person);
      }
      steps.push({ id: step.id, type: "ring", seconds: step.timeoutSecs, people });
    }
  }
  try {
    return { flow: parseIncomingFlow({ version: 1, steps, ending: plan.fallbackKind }), reason: null, canReplace: true };
  } catch { return blocked("Pôvodný plán presahuje možnosti nového postupu. Zostáva uložený bez zmeny."); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function comparable(flow: IncomingFlow | null | undefined): string {
  if (!flow) return "null";
  try { return canonical(parseIncomingFlow(flow)); } catch { return canonical(flow); }
}

export function incomingFlowChanges(drafts: FlowDrafts, document: RoutingDocument) {
  return Object.entries(drafts).filter(([id, flow]) => comparable(flow) !== comparable(document.lines.find(line => line.id === id)?.incomingFlow))
    .map(([id, flow]) => ({ id, flow, expectedFlow: document.lines.find(line => line.id === id)?.incomingFlow ?? null }));
}

/** Only the attempted changes must match. A different, unrelated line may have changed meanwhile. */
export function incomingFlowsMatch(changes: ReturnType<typeof incomingFlowChanges>, document: RoutingDocument): boolean {
  return changes.every(change => {
    const line = document.lines.find(candidate => candidate.id === change.id);
    return Boolean(line) && !line!.incomingFlowInvalid && comparable(change.flow) === comparable(line!.incomingFlow);
  });
}

export function validateIncomingFlowDraft(flow: IncomingFlow, document: RoutingDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  try { parseIncomingFlow(flow); } catch (error) {
    if (error instanceof IncomingFlowValidationError) issues.push(...error.issues.map(issue => {
      const step = /^steps\[(\d+)\]/.exec(issue.path);
      return step ? { ...issue, message: `Krok ${Number(step[1]) + 1}: ${issue.message}` } : issue;
    }));
    else issues.push({ path: "flow", code: "invalid_flow", message: "Postup sa nepodarilo overiť." });
  }
  flow.steps.forEach((step, index) => {
    const add = (code: string, message: string) => issues.push({ path: `steps.${index}`, code, message: `Krok ${index + 1}: ${message}` });
    if (step.type === "external") {
      const error = personalNumberIssue(step.number, document);
      if (error) add("invalid_number", error);
    }
    if (step.type !== "ring") return;
    let endpoints = 0;
    const numbers = new Set<string>();
    for (const person of step.people) {
      const operator = document.operators.find(candidate => candidate.profileId === person.profileId);
      if (!operator?.active || (operator.accessStatus && operator.accessStatus !== "active") || !["dispatcher", "senior_dispatcher", "manager", "admin"].includes(operator.role)) add("inactive_person", `${operator?.displayName ?? "Príjemca"} nie je aktívny operátor.`);
      endpoints += (person.application ? 2 : 0) + (person.personalNumber ? 1 : 0);
      if (person.personalNumber) {
        if (!document.capabilities?.ownedMobileRouting) add("personal_unavailable", "Zvonenie na osobné čísla tu nie je aktivované.");
        const error = personalNumberIssue(person.personalNumber, document, person.profileId);
        if (error) add("invalid_number", `${operator?.displayName ?? "Príjemca"}: ${error}`);
        const number = normalizeE164(person.personalNumber);
        if (number && numbers.has(number)) add("duplicate_number", "Rovnaké osobné číslo je vybraté viackrát.");
        if (number) numbers.add(number);
      }
    }
    const limit = document.limits ? Math.min(document.limits.maxRingFanout, document.limits.maxConcurrentLegs - 1) : null;
    if (limit && endpoints > limit) add("fanout_limit", `Vybratých je až ${endpoints} zariadení, súčasný limit je ${limit}. Rozdeľ ľudí do ďalšieho kroku alebo uprav limit organizácie.`);
  });
  return issues;
}

export function moveFlowStep(flow: IncomingFlow, id: string, direction: -1 | 1): IncomingFlow | null {
  const from = flow.steps.findIndex(step => step.id === id), to = from + direction;
  if (from < 0 || to < 0 || to >= flow.steps.length) return null;
  const steps = [...flow.steps];
  [steps[from], steps[to]] = [steps[to], steps[from]];
  if (steps.some((step, index) => step.type === "repeat" && step.stepIds.some(target => !steps.slice(0, index).some(candidate => candidate.id === target && (candidate.type === "ring" || candidate.type === "external"))))) return null;
  return { ...flow, steps };
}

export function removeFlowStep(flow: IncomingFlow, id: string): IncomingFlow {
  return { ...flow, steps: flow.steps.filter(step => step.id !== id).map(step => step.type === "repeat" ? { ...step, stepIds: step.stepIds.filter(target => target !== id) } : step).filter(step => step.type !== "repeat" || step.stepIds.length > 0) };
}

export function incomingStepSummary(step: IncomingFlowStep, flow: IncomingFlow, document: RoutingDocument): string {
  if (step.type === "ring") return `${step.people.map(person => document.operators.find(operator => operator.profileId === person.profileId)?.displayName ?? "Nedostupný operátor").join(" + ") || "Zvonenie bez ľudí"} (najviac ${step.seconds} s)`;
  if (step.type === "wait") {
    const policy = step.policy ?? { mode: "callback", intervalSeconds: 60 };
    const audio = policy.mode === "music" ? "iba hudba" : `${policy.mode === "callback" ? "ponuka spätného volania" : "informácia o čakaní"}, medzi hláškami ${policy.intervalSeconds} s hudby`;
    return `čakáreň ${step.minutes} min (${audio})`;
  }
  if (step.type === "external") return `číslo ${step.number || "nie je doplnené"} (najviac ${step.seconds} s)`;
  return `zopakovať kroky ${step.stepIds.map(id => flow.steps.findIndex(candidate => candidate.id === id) + 1).join(", ")} ešte ${step.times}×`;
}

export function incomingFlowSummary(flow: IncomingFlow, document: RoutingDocument): string {
  return [...flow.steps.map(step => incomingStepSummary(step, flow, document)), FLOW_ENDINGS[flow.ending]].join(" → ");
}
