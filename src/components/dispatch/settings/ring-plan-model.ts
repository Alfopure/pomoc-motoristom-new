/**
 * Pure model behind `RingPlanEditor.tsx` (design §2.6, plan "Fáza 3").
 *
 * Besides drafting, reordering and the local mirror of the server validation,
 * this module owns the plain-language preview: a manager must be able to read
 * back what the plan will do ("Skupina „Dispečing A" zvoní všetkým 20 s, potom
 * skupina „Dispečing B" zvoní po jednom po 15 s, potom ponuka spätného
 * volania.") without knowing what a step or a strategy is.
 *
 * Editing a plan never disturbs a call in progress: the plan is frozen into the
 * session at call start (`materialiseRingPlan`).
 */

import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import type {
  IvrMenuDoc,
  LineDoc,
  RingFallbackKind,
  RingGroupDoc,
  RingPlanDoc,
  RingPlanInput,
  RingStrategy,
  ValidationIssue,
} from "@/server/telephony/config-service";

import { MAX_RING_SECS, MIN_RING_SECS, nextDraftKey } from "./ring-groups-model";

/** Mirrors the CHECK constraints and `config-service.ts`. */
export const MIN_TIMEOUT_SECS = 5;
export const MAX_TIMEOUT_SECS = 120;
export const DEFAULT_TIMEOUT_SECS = 20;

export const STRATEGY_LABELS: Record<RingStrategy, string> = {
  all: "všetkým naraz",
  ordered: "postupne",
};

export const FALLBACK_LABELS: Record<RingFallbackKind, string> = {
  external_number: "presmerovať na externé číslo",
  waiting_room: "nechať hovor v čakárni",
  callback_prompt: "ponúknuť spätné volanie",
  hangup_message: "prehrať záverečnú hlášku a ukončiť",
};

export const FALLBACK_ORDER: RingFallbackKind[] = ["callback_prompt", "waiting_room", "external_number", "hangup_message"];

export type StepDraft = {
  /** Stable identity of the row for React keys and dnd-kit; not a database id. */
  key: string;
  id: string | null;
  ringGroupId: string;
  timeoutSecs: string;
  strategy: RingStrategy;
};

export type PlanDraft = {
  key: string;
  id: string | null;
  name: string;
  fallbackKind: RingFallbackKind;
  fallbackNumber: string;
  active: boolean;
  steps: StepDraft[];
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export function planDraftsFromDocument(plans: readonly RingPlanDoc[]): PlanDraft[] {
  return plans.map((plan) => ({
    key: `plan-${plan.id}`,
    id: plan.id,
    name: plan.name,
    fallbackKind: plan.fallbackKind,
    fallbackNumber: plan.fallbackNumber ?? "",
    active: plan.active,
    steps: [...plan.steps]
      .sort((left, right) => left.stepIndex - right.stepIndex)
      .map((step) => ({
        key: `step-${step.id}`,
        id: step.id,
        ringGroupId: step.ringGroupId,
        timeoutSecs: String(step.timeoutSecs),
        strategy: step.strategy,
      })),
  }));
}

export function newPlanDraft(name = ""): PlanDraft {
  return { key: nextDraftKey("plan"), id: null, name, fallbackKind: "callback_prompt", fallbackNumber: "", active: true, steps: [] };
}

export function newStepDraft(ringGroupId = ""): StepDraft {
  return { key: nextDraftKey("step"), id: null, ringGroupId, timeoutSecs: String(DEFAULT_TIMEOUT_SECS), strategy: "all" };
}

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

export function addPlan(plans: readonly PlanDraft[]): PlanDraft[] {
  return [...plans, newPlanDraft()];
}

export function updatePlan(plans: readonly PlanDraft[], planKey: string, patch: Partial<Omit<PlanDraft, "key" | "id" | "steps">>): PlanDraft[] {
  return plans.map((plan) => (plan.key === planKey ? { ...plan, ...patch } : plan));
}

export function addStep(plans: readonly PlanDraft[], planKey: string, ringGroupId = ""): PlanDraft[] {
  return plans.map((plan) => (plan.key === planKey ? { ...plan, steps: [...plan.steps, newStepDraft(ringGroupId)] } : plan));
}

export function removeStep(plans: readonly PlanDraft[], planKey: string, stepKey: string): PlanDraft[] {
  return plans.map((plan) => (plan.key === planKey ? { ...plan, steps: plan.steps.filter((step) => step.key !== stepKey) } : plan));
}

export function updateStep(plans: readonly PlanDraft[], planKey: string, stepKey: string, patch: Partial<Omit<StepDraft, "key" | "id">>): PlanDraft[] {
  return plans.map((plan) =>
    plan.key === planKey ? { ...plan, steps: plan.steps.map((step) => (step.key === stepKey ? { ...step, ...patch } : step)) } : plan,
  );
}

/** Drag-and-drop reorder of the steps; `step_index` is derived from the order. */
export function moveStep(steps: readonly StepDraft[], activeKey: string, overKey: string): StepDraft[] {
  if (activeKey === overKey) return [...steps];
  const from = steps.findIndex((step) => step.key === activeKey);
  const to = steps.findIndex((step) => step.key === overKey);
  if (from < 0 || to < 0) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function moveStepInPlans(plans: readonly PlanDraft[], planKey: string, activeKey: string, overKey: string): PlanDraft[] {
  return plans.map((plan) => (plan.key === planKey ? { ...plan, steps: moveStep(plan.steps, activeKey, overKey) } : plan));
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export function parseTimeout(value: string): number {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
}

export function ringPlansPayload(plans: readonly PlanDraft[]): RingPlanInput[] {
  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name.trim(),
    fallbackKind: plan.fallbackKind,
    fallbackNumber: plan.fallbackKind === "external_number" ? normalizeE164(plan.fallbackNumber) ?? plan.fallbackNumber.trim() : null,
    active: plan.active,
    steps: plan.steps.map((step, index) => ({
      id: step.id,
      stepIndex: index,
      ringGroupId: step.ringGroupId,
      timeoutSecs: parseTimeout(step.timeoutSecs),
      strategy: step.strategy,
    })),
  }));
}

export function ringPlansDirty(plans: readonly PlanDraft[], original: readonly RingPlanDoc[]): boolean {
  return JSON.stringify(ringPlansPayload(plans)) !== JSON.stringify(ringPlansPayload(planDraftsFromDocument(original)));
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

export type PlanValidationContext = {
  groups: readonly RingGroupDoc[];
  destinationAllowlist: readonly string[];
  /** Plans referenced by a line or an IVR option; removing one is refused by the server. */
  planIdsInUse: readonly string[];
  /**
   * `motorist_telephony_settings.max_ring_fanout`: how many devices `planRingStep`
   * lets ring at once. Members past the cap in an `all` step are marked
   * `fanout` and, because `remainingAfter` is 0 for `all`, never dialled in that
   * step at all — so the preview has to say so.
   */
  maxRingFanout?: number;
};

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/** Local mirror of `validateRoutingReplace`'s plan half; paths are draft keys. */
export function validateRingPlanDrafts(plans: readonly PlanDraft[], context: PlanValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = new Set<string>();
  const keptIds = new Set(plans.map((plan) => plan.id).filter((id): id is string => Boolean(id)));
  const groupsById = new Map(context.groups.map((group) => [group.id, group]));

  for (const plan of plans) {
    const name = plan.name.trim();
    if (!name) issues.push(issue(plan.key, "name_required", "Plán potrebuje názov."));
    const nameKey = name.toLocaleLowerCase("sk");
    if (nameKey && names.has(nameKey)) issues.push(issue(plan.key, "duplicate_name", `Plán s názvom „${name}" už existuje.`));
    names.add(nameKey);

    if (plan.fallbackKind === "external_number") {
      const normalized = normalizeE164(plan.fallbackNumber);
      if (!normalized) {
        issues.push(issue(plan.key, "fallback_number_invalid", "Presmerovanie na číslo potrebuje platné číslo v tvare E.164."));
      } else if (!isDestinationAllowed(normalized, context.destinationAllowlist)) {
        issues.push(issue(plan.key, "fallback_number_not_allowed", `Číslo ${normalized} nie je v povolených cieľoch organizácie.`));
      }
    }

    if (plan.steps.length === 0) issues.push(issue(plan.key, "plan_empty", "Plán zvonenia potrebuje aspoň jeden krok."));

    for (const step of plan.steps) {
      const timeout = parseTimeout(step.timeoutSecs);
      if (!Number.isFinite(timeout)) issues.push(issue(step.key, "timeout_invalid", "Čas kroku musí byť celé číslo v sekundách."));
      else if (timeout < MIN_TIMEOUT_SECS) issues.push(issue(step.key, "timeout_too_low", `Čas kroku musí byť aspoň ${MIN_TIMEOUT_SECS} s.`));
      else if (timeout > MAX_TIMEOUT_SECS) issues.push(issue(step.key, "timeout_too_high", `Čas kroku môže byť najviac ${MAX_TIMEOUT_SECS} s.`));

      const group = groupsById.get(step.ringGroupId);
      if (!group) {
        issues.push(issue(step.key, "group_unknown", "Vyber skupinu, ktorá bude v tomto kroku zvoniť."));
        continue;
      }
      if (group.members.length === 0) issues.push(issue(step.key, "group_empty", `Skupina „${group.name}" nemá žiadneho člena.`));
    }
  }

  for (const planId of context.planIdsInUse) {
    if (!keptIds.has(planId)) {
      issues.push(issue("", "plan_in_use", "Plán, ktorý používa niektorá linka alebo voľba IVR, sa nedá odstrániť. Najprv prepni linku alebo IVR na iný plán."));
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Plain-language preview
// ---------------------------------------------------------------------------

/**
 * Seconds one member of an `ordered` step rings. Mirrors `clampRingSecs` of
 * `routing/ring-plan.ts`: the member's own time when it has one, otherwise the
 * step timeout, clamped into the 5-120 s the runtime accepts.
 */
export function memberRingSeconds(memberRingSecs: number | null, timeoutSecs: number): number {
  return Math.min(MAX_RING_SECS, Math.max(MIN_RING_SECS, memberRingSecs ?? timeoutSecs));
}

/**
 * Longest time a step can ring (design §2.6: `ordered` sums, it does not
 * divide). A step whose group is switched off contributes nothing, because
 * `materialiseRingPlan` drops inactive groups when it freezes the plan.
 */
export function stepSeconds(step: StepDraft, group: RingGroupDoc | undefined): number {
  const parsed = parseTimeout(step.timeoutSecs);
  const timeout = Number.isFinite(parsed) ? parsed : 0;
  // No group, a switched-off group or a group without members: nobody rings and
  // the step is over before it starts.
  if (!group || !group.active || group.members.length === 0) return 0;
  if (step.strategy === "all") return timeout;
  return group.members.reduce((total, member) => total + memberRingSeconds(member.ringSecs, timeout), 0);
}

export function ringPlanSeconds(plan: PlanDraft, groups: readonly RingGroupDoc[]): number {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  return plan.steps.reduce((total, step) => total + stepSeconds(step, groupsById.get(step.ringGroupId)), 0);
}

function describeStep(step: StepDraft, group: RingGroupDoc | undefined, maxRingFanout?: number): string {
  const timeout = parseTimeout(step.timeoutSecs);
  const seconds = Number.isFinite(timeout) ? timeout : 0;
  if (!group) return "krok bez vybratej skupiny sa preskočí";
  // materialiseRingPlan skips an inactive group, so the step simply disappears.
  if (!group.active) return `skupina „${group.name}" je vypnutá, krok sa preskočí`;
  if (group.members.length === 0) return `skupina „${group.name}" nemá žiadneho člena, krok sa preskočí`;
  if (step.strategy === "all") {
    // `planRingStep` keeps only the first `maxRingFanout` eligible members and
    // finishes the step after that single fan-out, so the rest never ring.
    if (typeof maxRingFanout === "number" && maxRingFanout > 0 && group.members.length > maxRingFanout) {
      return `skupina „${group.name}" zvoní naraz najviac ${maxRingFanout} z ${group.members.length} členov (limit organizácie) ${seconds} s, na ostatných sa v tomto kroku nedostane`;
    }
    return `skupina „${group.name}" zvoní všetkým ${seconds} s`;
  }
  const times = group.members.map((member) => memberRingSeconds(member.ringSecs, seconds));
  const distinct = new Set(times);
  if (distinct.size === 1) return `skupina „${group.name}" zvoní po jednom po ${times[0]} s`;
  const total = times.reduce((sum, value) => sum + value, 0);
  return `skupina „${group.name}" zvoní po jednom, každý svojím časom (spolu ${total} s)`;
}

/**
 * What the engine really does when a plan freezes with **no** step.
 *
 * `startRingPlan` branches on `!plan || plan.steps.length === 0` and offers a
 * callback *before* `applyFallback` is ever reached, so `fallback_kind` is not
 * consulted at all. Two configurations land there: an inactive plan
 * (`materialiseRingPlan` returns `null`) and a plan whose every step points at a
 * missing or switched-off group (the freeze drops those steps). Describing the
 * configured fallback for either would be a lie — and with
 * `external_number` the lie is the whole point of the setting.
 */
export const NO_RUNNABLE_STEP_OUTCOME =
  "hovor dostane ponuku spätného volania — nastavené správanie po vyčerpaní plánu sa nepoužije, plán sa vôbec nespustí";

/** True while at least one step would survive `materialiseRingPlan`. */
export function planHasRunnableStep(plan: PlanDraft, groups: readonly RingGroupDoc[]): boolean {
  if (!plan.active) return false;
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  return plan.steps.some((step) => {
    const group = groupsById.get(step.ringGroupId);
    return Boolean(group && group.active);
  });
}

export function describeFallback(plan: PlanDraft): string {
  switch (plan.fallbackKind) {
    case "external_number": {
      const number = normalizeE164(plan.fallbackNumber) ?? plan.fallbackNumber.trim();
      return number ? `presmerovanie na ${number}` : "presmerovanie na externé číslo";
    }
    case "waiting_room":
      return "hovor ostane v čakárni";
    case "hangup_message":
      return "prehrá sa záverečná hláška a hovor sa ukončí";
    case "callback_prompt":
    default:
      return "ponuka spätného volania";
  }
}

/** One phrase per step plus the fallback phrase, in the order they happen. */
export function describeRingPlanParts(plan: PlanDraft, groups: readonly RingGroupDoc[], maxRingFanout?: number): string[] {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  return [...plan.steps.map((step) => describeStep(step, groupsById.get(step.ringGroupId), maxRingFanout)), describeFallback(plan)];
}

/**
 * The whole plan as one Slovak sentence shown above the steps.
 *
 * A plan that would freeze without a single step is described by what the engine
 * actually does (`NO_RUNNABLE_STEP_OUTCOME`), not by its configured fallback.
 */
export function describeRingPlan(plan: PlanDraft, groups: readonly RingGroupDoc[], maxRingFanout?: number): string {
  if (!plan.active) return `Plán je vypnutý — žiadny krok sa nevykoná a ${NO_RUNNABLE_STEP_OUTCOME}.`;
  if (plan.steps.length === 0) return `Plán zatiaľ nemá žiadny krok — ${NO_RUNNABLE_STEP_OUTCOME}.`;
  if (!planHasRunnableStep(plan, groups)) {
    return `Každý krok plánu odkazuje na chýbajúcu alebo vypnutú skupinu, takže po zmrazení plánu neostane ani jeden krok — ${NO_RUNNABLE_STEP_OUTCOME}.`;
  }
  const [first, ...rest] = describeRingPlanParts(plan, groups, maxRingFanout);
  const sentence = [first.charAt(0).toLocaleUpperCase("sk") + first.slice(1), ...rest.map((part) => `potom ${part}`)].join(", ");
  return `${sentence}.`;
}

/** Labels of the lines that route to this plan (only a saved plan has an id). */
export function linesUsingPlan(planId: string | null, lines: readonly LineDoc[]): string[] {
  if (!planId) return [];
  return lines.filter((line) => line.ringPlanId === planId).map((line) => line.label.trim() || line.phoneNumber);
}

/**
 * Names of the IVR menus whose digit options route to this plan.
 *
 * A plan reachable only through an IVR option used to be invisible here:
 * `transitions.ts` resolves the digit with
 * `(option.target_ring_plan_id && ringPlans[id]) || plan`, and an inactive plan
 * materialises as `null`, so switching it off silently sends those callers to
 * the line's default plan instead.
 */
export function ivrMenusUsingPlan(planId: string | null, ivrMenus: readonly IvrMenuDoc[]): string[] {
  if (!planId) return [];
  return ivrMenus.filter((menu) => menu.ringPlanIds.includes(planId)).map((menu) => menu.name);
}

/** Every plan id a line or an IVR option points at (mirror of `ringPlansInUse`). */
export function ringPlanIdsInUse(lines: readonly LineDoc[], ivrMenus: readonly IvrMenuDoc[] = []): string[] {
  return [
    ...new Set([
      ...lines.map((line) => line.ringPlanId).filter((id): id is string => Boolean(id)),
      ...ivrMenus.flatMap((menu) => menu.ringPlanIds),
    ]),
  ];
}

export type PlanUsageContext = { ivrMenus?: readonly IvrMenuDoc[]; groups?: readonly RingGroupDoc[] };

/**
 * Sentence under the plan header, mirroring `groupUsageNote`.
 *
 * Switching a plan off is allowed, but `materialiseRingPlan` then returns
 * `null` and `startRingPlan` takes the "no ring plan" branch: nobody's phone
 * rings and every caller is offered a callback — the configured fallback is
 * never reached. The most damaging of the three toggles must not be the silent
 * one, and an IVR digit that targets the plan counts as a user of it just like a
 * line does.
 */
export function planUsageNote(plan: PlanDraft, lines: readonly LineDoc[], context: PlanUsageContext = {}): { tone: "info" | "warning"; text: string } | null {
  const usedByLines = linesUsingPlan(plan.id, lines);
  const usedByIvr = ivrMenusUsingPlan(plan.id, context.ivrMenus ?? []);
  const users = [
    ...(usedByLines.length > 0 ? [`linky: ${usedByLines.join(", ")}`] : []),
    ...(usedByIvr.length > 0 ? [`voľby IVR menu: ${usedByIvr.join(", ")}`] : []),
  ];
  // "Runnable" is the engine's own test: an inactive plan, or one whose every
  // step points at a missing/switched-off group, freezes with zero steps.
  const runnable = planHasRunnableStep(plan, context.groups ?? []);

  if (users.length === 0) {
    return runnable ? null : { tone: "info", text: `Plán zatiaľ nepoužíva žiadna linka ani IVR menu, a v tomto stave by sa ani nespustil (${NO_RUNNABLE_STEP_OUTCOME}).` };
  }
  const list = users.join(", ");
  if (runnable) return { tone: "info", text: `Používajú ho ${list}.` };
  const ivrNote = usedByIvr.length > 0 ? " Volajúci, ktorí si zvolia takúto voľbu IVR, skončia na pôvodnom pláne linky." : "";
  return {
    tone: "warning",
    text: `Plán sa v tomto stave nespustí, ale používajú ho ${list}. Nikomu nezazvoní a ${NO_RUNNABLE_STEP_OUTCOME}.${ivrNote}`,
  };
}

/**
 * Groups whose `all` step would be truncated by the organisation fan-out cap.
 * The manager sees the same fact from the group side and from the settings side.
 */
export function groupsOverFanout(plans: readonly PlanDraft[], groups: readonly RingGroupDoc[], maxRingFanout: number): Array<{ name: string; members: number }> {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const over = new Map<string, { name: string; members: number }>();
  for (const plan of plans) {
    for (const step of plan.steps) {
      if (step.strategy !== "all") continue;
      const group = groupsById.get(step.ringGroupId);
      if (!group || group.members.length <= maxRingFanout) continue;
      over.set(group.id, { name: group.name, members: group.members.length });
    }
  }
  return [...over.values()];
}
