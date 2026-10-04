/** Versioned, finite incoming call flow shared by the editor, API and runtime. */
export type IncomingFlowPerson = { profileId: string; application: boolean; personalNumber: string | null };
export type IncomingRingStep = { id: string; type: "ring"; seconds: number; people: IncomingFlowPerson[] };
export type IncomingWaitStep = { id: string; type: "wait"; minutes: number };
export type IncomingRepeatStep = { id: string; type: "repeat"; stepIds: string[]; times: number };
export type IncomingExternalStep = { id: string; type: "external"; number: string; seconds: number };
export type IncomingFlowStep = IncomingRingStep | IncomingWaitStep | IncomingRepeatStep | IncomingExternalStep;
export type IncomingFlow = { version: 1; steps: IncomingFlowStep[]; ending: "hangup_message" | "callback_prompt" | "hangup" };
export type ExpandedIncomingFlowStep = { step: Exclude<IncomingFlowStep, IncomingRepeatStep>; sourceId: string; occurrenceId: string };
export type IncomingFlowIssue = { path: string; code: string; message: string };

export const MAX_INCOMING_FLOW_STEPS = 20;
export const MAX_INCOMING_FLOW_PEOPLE = 20;
export const MAX_INCOMING_FLOW_EXPANDED_STEPS = 100;
export const MAX_INCOMING_FLOW_DURATION_SECONDS = 7200;
export const MIN_INCOMING_RING_SECONDS = 5;
export const MAX_INCOMING_RING_SECONDS = 120;
export const MAX_INCOMING_WAIT_MINUTES = 60;
export const MAX_INCOMING_REPEAT_TIMES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class IncomingFlowValidationError extends Error {
  constructor(readonly issues: IncomingFlowIssue[]) {
    super(issues[0]?.message ?? "Postup hovoru nie je platný.");
    this.name = "IncomingFlowValidationError";
  }
}

/** Reject, never coerce malformed payloads or unsupported future schemas. */
export function parseIncomingFlow(value: unknown): IncomingFlow {
  const issues: IncomingFlowIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const keys = (row: Record<string, unknown>, allowed: string[], path: string) => {
    if (Object.keys(row).some(key => !allowed.includes(key)) || allowed.some(key => !(key in row))) add(path, "shape_invalid", "Postup obsahuje neznáme alebo chýbajúce pole.");
  };
  const integer = (number: unknown, min: number, max: number, path: string) => {
    if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) add(path, "range_invalid", `Hodnota musí byť celé číslo od ${min} do ${max}.`);
  };
  const id = (input: unknown, path: string) => {
    if (typeof input !== "string" || !UUID.test(input)) add(path, "id_invalid", "Položka potrebuje platný identifikátor.");
  };
  const phone = (input: unknown, path: string) => {
    if (typeof input !== "string" || !E164.test(input)) add(path, "number_invalid", "Zadaj číslo v medzinárodnom tvare, napríklad +421910123456.");
  };
  if (!record(value)) throw new IncomingFlowValidationError([{ path: "flow", code: "shape_invalid", message: "Postup hovoru chýba." }]);
  keys(value, ["version", "steps", "ending"], "flow");
  if (value.version !== 1) add("version", "version_invalid", "Táto verzia postupu ešte nie je podporovaná.");
  if (!["hangup_message", "callback_prompt", "hangup"].includes(String(value.ending))) add("ending", "ending_invalid", "Vyber ukončenie hovoru.");
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_INCOMING_FLOW_STEPS) {
    add("steps", "steps_invalid", `Postup musí mať 1 až ${MAX_INCOMING_FLOW_STEPS} krokov.`);
    throw new IncomingFlowValidationError(issues);
  }
  const preceding = new Map<string, string>();
  value.steps.forEach((raw, index) => {
    const path = `steps[${index}]`;
    if (!record(raw)) { add(path, "step_invalid", "Krok nie je platný."); return; }
    id(raw.id, `${path}.id`);
    if (typeof raw.id === "string" && preceding.has(raw.id.toLowerCase())) add(`${path}.id`, "duplicate_id", "Každý krok musí mať vlastný identifikátor.");
    if (raw.type === "ring") {
      keys(raw, ["id", "type", "seconds", "people"], path);
      integer(raw.seconds, MIN_INCOMING_RING_SECONDS, MAX_INCOMING_RING_SECONDS, `${path}.seconds`);
      if (!Array.isArray(raw.people) || raw.people.length < 1 || raw.people.length > MAX_INCOMING_FLOW_PEOPLE) add(`${path}.people`, "people_invalid", `Vyber 1 až ${MAX_INCOMING_FLOW_PEOPLE} ľudí.`);
      else {
        const people = new Set<string>(); const numbers = new Set<string>();
        raw.people.forEach((person, personIndex) => {
          const personPath = `${path}.people[${personIndex}]`;
          if (!record(person)) { add(personPath, "person_invalid", "Operátor nie je platný."); return; }
          keys(person, ["profileId", "application", "personalNumber"], personPath);
          id(person.profileId, `${personPath}.profileId`);
          if (typeof person.profileId === "string") {
            if (people.has(person.profileId.toLowerCase())) add(personPath, "duplicate_person", "Operátor môže byť v jednom kroku iba raz.");
            people.add(person.profileId.toLowerCase());
          }
          if (typeof person.application !== "boolean") add(`${personPath}.application`, "type_invalid", "Voľba aplikácie musí byť zapnutá alebo vypnutá.");
          if (person.personalNumber !== null) {
            phone(person.personalNumber, `${personPath}.personalNumber`);
            if (typeof person.personalNumber === "string") {
              if (numbers.has(person.personalNumber)) add(personPath, "duplicate_number", "Rovnaké číslo nemôže zvoniť v jednom kroku dvakrát.");
              numbers.add(person.personalNumber);
            }
          }
          if (person.application !== true && person.personalNumber === null) add(personPath, "destination_required", "Zapni aplikáciu alebo vyber osobné číslo.");
        });
      }
    } else if (raw.type === "external") {
      keys(raw, ["id", "type", "number", "seconds"], path);
      phone(raw.number, `${path}.number`);
      integer(raw.seconds, MIN_INCOMING_RING_SECONDS, MAX_INCOMING_RING_SECONDS, `${path}.seconds`);
    } else if (raw.type === "wait") {
      keys(raw, ["id", "type", "minutes"], path);
      integer(raw.minutes, 1, MAX_INCOMING_WAIT_MINUTES, `${path}.minutes`);
    } else if (raw.type === "repeat") {
      keys(raw, ["id", "type", "stepIds", "times"], path);
      integer(raw.times, 1, MAX_INCOMING_REPEAT_TIMES, `${path}.times`);
      if (!Array.isArray(raw.stepIds) || raw.stepIds.length < 1 || raw.stepIds.length > MAX_INCOMING_FLOW_STEPS) add(`${path}.stepIds`, "repeat_invalid", "Vyber predchádzajúce kroky zvonenia.");
      else {
        const seen = new Set<string>();
        raw.stepIds.forEach((stepId, refIndex) => {
          id(stepId, `${path}.stepIds[${refIndex}]`);
          const normalized = typeof stepId === "string" ? stepId.toLowerCase() : "";
          if (!["ring", "external"].includes(preceding.get(normalized) ?? "") || seen.has(normalized)) add(`${path}.stepIds[${refIndex}]`, "repeat_invalid", "Opakovať možno iba rôzne predchádzajúce kroky zvonenia.");
          seen.add(normalized);
        });
      }
    } else add(`${path}.type`, "step_type_invalid", "Neznámy druh kroku.");
    if (typeof raw.id === "string") preceding.set(raw.id.toLowerCase(), String(raw.type));
  });
  if (issues.length) throw new IncomingFlowValidationError(issues);
  // New values are detached from the caller and identifiers have one spelling.
  const flow = structuredClone(value) as IncomingFlow;
  flow.steps = flow.steps.map(step => ({ ...step, id: step.id.toLowerCase(), ...(step.type === "ring" ? { people: step.people.map(person => ({ ...person, profileId: person.profileId.toLowerCase() })) } : {}), ...(step.type === "repeat" ? { stepIds: step.stepIds.map(ref => ref.toLowerCase()) } : {}) }));
  const expanded = expandIncomingFlow(flow);
  if (expanded.length > MAX_INCOMING_FLOW_EXPANDED_STEPS) add("steps", "expanded_too_long", `Postup môže vykonať najviac ${MAX_INCOMING_FLOW_EXPANDED_STEPS} krokov.`);
  const seconds = expanded.reduce((sum, { step }) => sum + (step.type === "wait" ? step.minutes * 60 : step.seconds), 0);
  if (seconds > MAX_INCOMING_FLOW_DURATION_SECONDS) add("steps", "duration_too_long", "Celý postup môže trvať najviac dve hodiny.");
  if (issues.length) throw new IncomingFlowValidationError(issues);
  return flow;
}

/** Pure finite expansion. Only call with validated data. */
export function expandIncomingFlow(flow: IncomingFlow): ExpandedIncomingFlowStep[] {
  const expanded: ExpandedIncomingFlowStep[] = [];
  const preceding = new Map<string, IncomingRingStep | IncomingExternalStep>();
  const append = (step: ExpandedIncomingFlowStep["step"]) => expanded.push({ step, sourceId: step.id, occurrenceId: `${step.id}:${expanded.length}` });
  for (const step of flow.steps) {
    if (step.type === "repeat") {
      for (let repeat = 0; repeat < step.times; repeat++) for (const id of step.stepIds) {
        const original = preceding.get(id);
        if (original) append(original);
      }
    } else {
      append(step);
      if (step.type === "ring" || step.type === "external") preceding.set(step.id, step);
    }
  }
  return expanded;
}

export function readIncomingFlow(value: unknown): IncomingFlow | null {
  if (value === null || value === undefined) return null;
  try { return parseIncomingFlow(value); } catch { return null; }
}
