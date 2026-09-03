import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AppRole } from "@/domain/types";
import type { Database, Json } from "@/lib/supabase/database.types";

import { COUNTRY_DIAL_PREFIXES, isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import type { TelephonyEnvironment } from "./state/types";

/**
 * Routing configuration read model and validated replace operations
 * (design §3/§4 Phase 3).
 *
 * One read (`getRoutingDocument`) returns everything the settings screens need
 * — ring groups with members, ring plans with steps, business hours with
 * intervals and exceptions, pause reasons, lines, IVR menus, operators and the
 * organisation settings — so the editors never have to stitch six responses
 * together and always validate against a consistent world.
 *
 * Every write is validated as a whole document *before* it is applied
 * (`validateRoutingReplace`), then applied transactionally through the
 * `motorist_replace_ring_plan` RPC, and finally recorded in
 * `motorist_audit_log` with a compact diff. Validation is deliberately pure and
 * exported so the matrix test can run it without a database.
 *
 * Editing configuration can never disturb a call in progress: the ring plan is
 * frozen into the session at call start (`materialiseRingPlan`), and the RPC
 * refuses to delete a group/plan/business-hours row that something still
 * points at.
 */

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];

export type ConfigDeps = { admin: AdminClient; now?: () => Date };

export type ConfigActor = { profileId: string; role: AppRole; displayName?: string | null };

export class ConfigServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(message: string, status = 400, code = "config_invalid", issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ConfigServiceError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export type ValidationIssue = { path: string; code: string; message: string };

// ---------------------------------------------------------------------------
// Limits (mirror the CHECK constraints of the foundation migration)
// ---------------------------------------------------------------------------

export const MIN_TIMEOUT_SECS = 5;
export const MAX_TIMEOUT_SECS = 120;
export const MIN_RING_SECS = 5;
export const MAX_RING_SECS = 120;
export const MAX_WRAP_UP_SECONDS = 600;
export const MAX_PARK_MINUTES = 240;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FALLBACK_KINDS = ["external_number", "waiting_room", "callback_prompt", "hangup_message"] as const;
const STRATEGIES = ["all", "ordered"] as const;
const MEMBER_KINDS = ["operator", "external_number"] as const;
const ENVIRONMENTS: TelephonyEnvironment[] = ["production", "development"];

export type RingFallbackKind = (typeof FALLBACK_KINDS)[number];
export type RingStrategy = (typeof STRATEGIES)[number];
export type RingMemberKind = (typeof MEMBER_KINDS)[number];

// ---------------------------------------------------------------------------
// Wire types (camelCase; the RPC document is snake_case, see `toRpcDocument`)
// ---------------------------------------------------------------------------

export type RingGroupMemberInput = {
  id?: string | null;
  memberKind: RingMemberKind;
  profileId?: string | null;
  externalNumber?: string | null;
  position: number;
  ringSecs?: number | null;
};

export type RingGroupInput = {
  id?: string | null;
  name: string;
  description?: string | null;
  active?: boolean;
  members: RingGroupMemberInput[];
};

export type RingPlanStepInput = {
  id?: string | null;
  stepIndex: number;
  ringGroupId: string;
  timeoutSecs: number;
  strategy: RingStrategy;
};

export type RingPlanInput = {
  id?: string | null;
  name: string;
  fallbackKind: RingFallbackKind;
  fallbackNumber?: string | null;
  active?: boolean;
  steps: RingPlanStepInput[];
};

export type BusinessHoursIntervalInput = { weekday: number; opens: string; closes: string };
export type BusinessHoursExceptionInput = { date: string; closed?: boolean; intervals?: Array<{ opens: string; closes: string }>; label?: string | null };

export type BusinessHoursInput = {
  id?: string | null;
  name: string;
  timezone?: string | null;
  active?: boolean;
  intervals: BusinessHoursIntervalInput[];
  exceptions: BusinessHoursExceptionInput[];
};

export type PauseReasonInput = {
  id?: string | null;
  code: string;
  label: string;
  maxMinutes?: number | null;
  sortOrder?: number;
  active?: boolean;
};

export type LinePatchInput = {
  label?: string;
  partnerName?: string | null;
  ringPlanId?: string | null;
  ivrMenuId?: string | null;
  businessHoursId?: string | null;
  environment?: TelephonyEnvironment;
  active?: boolean;
};

export type TelephonySettingsPatchInput = {
  liveCallsEnabled?: boolean;
  smsLiveSends?: boolean;
  dailyLegSoftCap?: number;
  parkMaxMinutes?: number;
  destinationAllowlist?: string[];
  maxRingFanout?: number;
  maxConcurrentLegs?: number;
};

export type OperatorSettingsPatchInput = {
  defaultFromLineId?: string | null;
  wrapUpSeconds?: number;
  autoAnswerOutbound?: boolean;
  ringDeviceVolume?: number;
};

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type RingGroupDoc = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  members: Array<{ id: string; memberKind: RingMemberKind; profileId: string | null; externalNumber: string | null; position: number; ringSecs: number | null; lastOfferedAt: string | null; lastAnsweredAt: string | null }>;
};

export type RingPlanDoc = {
  id: string;
  name: string;
  fallbackKind: RingFallbackKind;
  fallbackNumber: string | null;
  active: boolean;
  steps: Array<{ id: string; stepIndex: number; ringGroupId: string; timeoutSecs: number; strategy: RingStrategy }>;
};

export type BusinessHoursDoc = {
  id: string;
  name: string;
  timezone: string;
  active: boolean;
  intervals: Array<{ weekday: number; opens: string; closes: string }>;
  exceptions: Array<{ date: string; closed: boolean; intervals: Array<{ opens: string; closes: string }>; label: string | null }>;
};

export type PauseReasonDoc = { id: string; code: string; label: string; maxMinutes: number | null; sortOrder: number; active: boolean };

export type LineDoc = {
  id: string;
  phoneNumber: string;
  label: string;
  partnerName: string | null;
  telnyxNumberId: string | null;
  ringPlanId: string | null;
  ivrMenuId: string | null;
  businessHoursId: string | null;
  environment: TelephonyEnvironment;
  active: boolean;
};

export type IvrMenuDoc = { id: string; name: string; active: boolean };

export type OperatorDoc = {
  profileId: string;
  displayName: string;
  role: AppRole;
  active: boolean;
  settings: { defaultFromLineId: string | null; wrapUpSeconds: number; autoAnswerOutbound: boolean; ringDeviceVolume: number } | null;
  device: { environment: TelephonyEnvironment; credentialId: string | null; sipUsername: string | null; registrationState: string; deviceSeenAt: string | null } | null;
};

export type TelephonySettingsDoc = {
  liveCallsEnabled: boolean;
  smsLiveSends: boolean;
  dailyLegSoftCap: number;
  parkMaxMinutes: number;
  destinationAllowlist: string[];
  maxRingFanout: number;
  maxConcurrentLegs: number;
};

export type RoutingDocument = {
  organizationId: string;
  groups: RingGroupDoc[];
  plans: RingPlanDoc[];
  businessHours: BusinessHoursDoc[];
  pauseReasons: PauseReasonDoc[];
  lines: LineDoc[];
  ivrMenus: IvrMenuDoc[];
  operators: OperatorDoc[];
  /** `null` for member-level readers: the kill switches are manager/admin material. */
  settings: TelephonySettingsDoc | null;
};

export const DEFAULT_SETTINGS: TelephonySettingsDoc = {
  liveCallsEnabled: false,
  smsLiveSends: false,
  dailyLegSoftCap: 500,
  parkMaxMinutes: 30,
  destinationAllowlist: ["SK", "CZ"],
  maxRingFanout: 8,
  maxConcurrentLegs: 9,
};

// ---------------------------------------------------------------------------
// Small readers (a body arrives as `unknown`, never as a typed object)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readId(value: unknown): string | null {
  const text = readText(value);
  return text && UUID_PATTERN.test(text) ? text.toLowerCase() : null;
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/** `HH:MM` (the DB stores `time`, PostgREST returns `HH:MM:SS`). */
function normalizeTime(value: unknown): string | null {
  const text = readText(value);
  if (!text || !TIME_PATTERN.test(text)) return null;
  return text.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Payload parsing (structure only; the semantic rules live in the validators)
// ---------------------------------------------------------------------------

export function parseRingGroups(value: unknown): RingGroupInput[] {
  if (!Array.isArray(value)) throw new ConfigServiceError("Zoznam skupín chýba alebo nie je pole.", 400, "config_invalid");
  return value.map((raw) => {
    const row = isRecord(raw) ? raw : {};
    const members = Array.isArray(row.members) ? row.members : [];
    return {
      id: readId(row.id),
      name: typeof row.name === "string" ? row.name.trim() : "",
      description: readText(row.description),
      active: readBoolean(row.active, true),
      members: members.map((rawMember, index) => {
        const member = isRecord(rawMember) ? rawMember : {};
        const kind = readText(member.memberKind);
        return {
          id: readId(member.id),
          memberKind: (kind ?? "operator") as RingMemberKind,
          profileId: readId(member.profileId),
          externalNumber: readText(member.externalNumber),
          position: readInteger(member.position) ?? index,
          ringSecs: readInteger(member.ringSecs),
        };
      }),
    };
  });
}

export function parseRingPlans(value: unknown): RingPlanInput[] {
  if (!Array.isArray(value)) throw new ConfigServiceError("Zoznam plánov chýba alebo nie je pole.", 400, "config_invalid");
  return value.map((raw) => {
    const row = isRecord(raw) ? raw : {};
    const steps = Array.isArray(row.steps) ? row.steps : [];
    return {
      id: readId(row.id),
      name: typeof row.name === "string" ? row.name.trim() : "",
      fallbackKind: (readText(row.fallbackKind) ?? "callback_prompt") as RingFallbackKind,
      fallbackNumber: readText(row.fallbackNumber),
      active: readBoolean(row.active, true),
      steps: steps.map((rawStep, index) => {
        const step = isRecord(rawStep) ? rawStep : {};
        return {
          id: readId(step.id),
          stepIndex: readInteger(step.stepIndex) ?? index,
          ringGroupId: readId(step.ringGroupId) ?? "",
          timeoutSecs: readInteger(step.timeoutSecs) ?? 0,
          strategy: (readText(step.strategy) ?? "all") as RingStrategy,
        };
      }),
    };
  });
}

export function parseBusinessHours(value: unknown): BusinessHoursInput[] {
  if (!Array.isArray(value)) throw new ConfigServiceError("Zoznam otváracích hodín chýba alebo nie je pole.", 400, "config_invalid");
  return value.map((raw) => {
    const row = isRecord(raw) ? raw : {};
    const intervals = Array.isArray(row.intervals) ? row.intervals : [];
    const exceptions = Array.isArray(row.exceptions) ? row.exceptions : [];
    return {
      id: readId(row.id),
      name: typeof row.name === "string" ? row.name.trim() : "",
      timezone: readText(row.timezone) ?? "Europe/Bratislava",
      active: readBoolean(row.active, true),
      intervals: intervals.map((rawInterval) => {
        const interval = isRecord(rawInterval) ? rawInterval : {};
        return {
          weekday: readInteger(interval.weekday) ?? 0,
          opens: normalizeTime(interval.opens) ?? String(interval.opens ?? ""),
          closes: normalizeTime(interval.closes) ?? String(interval.closes ?? ""),
        };
      }),
      exceptions: exceptions.map((rawException) => {
        const exception = isRecord(rawException) ? rawException : {};
        const nested = Array.isArray(exception.intervals) ? exception.intervals : [];
        return {
          date: readText(exception.date) ?? "",
          closed: readBoolean(exception.closed, true),
          intervals: nested.map((rawInterval) => {
            const interval = isRecord(rawInterval) ? rawInterval : {};
            return { opens: normalizeTime(interval.opens) ?? String(interval.opens ?? ""), closes: normalizeTime(interval.closes) ?? String(interval.closes ?? "") };
          }),
          label: readText(exception.label),
        };
      }),
    };
  });
}

export function parsePauseReasons(value: unknown): PauseReasonInput[] {
  if (!Array.isArray(value)) throw new ConfigServiceError("Zoznam dôvodov pauzy chýba alebo nie je pole.", 400, "config_invalid");
  return value.map((raw, index) => {
    const row = isRecord(raw) ? raw : {};
    return {
      id: readId(row.id),
      code: typeof row.code === "string" ? row.code.trim().toLowerCase() : "",
      label: typeof row.label === "string" ? row.label.trim() : "",
      maxMinutes: readInteger(row.maxMinutes),
      sortOrder: readInteger(row.sortOrder) ?? index * 10,
      active: readBoolean(row.active, true),
    };
  });
}

/** `PATCH` bodies carry only the fields the user touched; absent ≠ null. */
export function parseLinePatch(value: unknown): LinePatchInput {
  const row = isRecord(value) ? value : {};
  const patch: LinePatchInput = {};
  if ("label" in row) patch.label = typeof row.label === "string" ? row.label : "";
  if ("partnerName" in row) patch.partnerName = readText(row.partnerName);
  if ("ringPlanId" in row) patch.ringPlanId = readId(row.ringPlanId);
  if ("ivrMenuId" in row) patch.ivrMenuId = readId(row.ivrMenuId);
  if ("businessHoursId" in row) patch.businessHoursId = readId(row.businessHoursId);
  if ("environment" in row) patch.environment = (readText(row.environment) ?? "") as TelephonyEnvironment;
  if ("active" in row) patch.active = readBoolean(row.active, true);
  return patch;
}

export function parseSettingsPatch(value: unknown): TelephonySettingsPatchInput {
  const row = isRecord(value) ? value : {};
  const patch: TelephonySettingsPatchInput = {};
  if ("liveCallsEnabled" in row) patch.liveCallsEnabled = readBoolean(row.liveCallsEnabled, false);
  if ("smsLiveSends" in row) patch.smsLiveSends = readBoolean(row.smsLiveSends, false);
  if ("dailyLegSoftCap" in row) patch.dailyLegSoftCap = readInteger(row.dailyLegSoftCap) ?? Number.NaN;
  if ("parkMaxMinutes" in row) patch.parkMaxMinutes = readInteger(row.parkMaxMinutes) ?? Number.NaN;
  if ("maxRingFanout" in row) patch.maxRingFanout = readInteger(row.maxRingFanout) ?? Number.NaN;
  if ("maxConcurrentLegs" in row) patch.maxConcurrentLegs = readInteger(row.maxConcurrentLegs) ?? Number.NaN;
  if ("destinationAllowlist" in row) {
    patch.destinationAllowlist = Array.isArray(row.destinationAllowlist)
      ? row.destinationAllowlist.map((entry) => (typeof entry === "string" ? entry.trim() : String(entry))).filter((entry) => entry.length > 0)
      : [];
  }
  return patch;
}

export function parseOperatorSettingsPatch(value: unknown): OperatorSettingsPatchInput {
  const row = isRecord(value) ? value : {};
  const patch: OperatorSettingsPatchInput = {};
  if ("defaultFromLineId" in row) patch.defaultFromLineId = readId(row.defaultFromLineId);
  if ("wrapUpSeconds" in row) patch.wrapUpSeconds = readInteger(row.wrapUpSeconds) ?? Number.NaN;
  if ("autoAnswerOutbound" in row) patch.autoAnswerOutbound = readBoolean(row.autoAnswerOutbound, true);
  if ("ringDeviceVolume" in row) patch.ringDeviceVolume = readInteger(row.ringDeviceVolume) ?? Number.NaN;
  return patch;
}

// ---------------------------------------------------------------------------
// Validation context
// ---------------------------------------------------------------------------

export type ValidationContext = {
  organizationId: string;
  profileIds: ReadonlySet<string>;
  lineIds: ReadonlySet<string>;
  ivrMenuIds: ReadonlySet<string>;
  businessHoursIds: ReadonlySet<string>;
  ringPlanIds: ReadonlySet<string>;
  /** Business hours referenced by a line; they may not disappear. */
  businessHoursInUse: ReadonlySet<string>;
  /** Ring plans referenced by a line or an IVR option; they may not disappear. */
  ringPlansInUse: ReadonlySet<string>;
  destinationAllowlist: readonly string[];
  /** The world as it is stored today; the replace merges its own section over it. */
  groups: RingGroupInput[];
  plans: RingPlanInput[];
};

export async function loadValidationContext(deps: ConfigDeps, organizationId: string): Promise<ValidationContext> {
  const document = await getRoutingDocument(deps, { organizationId, includeSettings: true });
  return contextFromDocument(document);
}

/** Same context, derived from an already loaded document (no extra queries). */
export function contextFromDocument(document: RoutingDocument): ValidationContext {
  return {
    organizationId: document.organizationId,
    profileIds: new Set(document.operators.map((operator) => operator.profileId)),
    lineIds: new Set(document.lines.map((line) => line.id)),
    ivrMenuIds: new Set(document.ivrMenus.map((menu) => menu.id)),
    businessHoursIds: new Set(document.businessHours.map((hours) => hours.id)),
    ringPlanIds: new Set(document.plans.map((plan) => plan.id)),
    businessHoursInUse: new Set(document.lines.map((line) => line.businessHoursId).filter((id): id is string => Boolean(id))),
    ringPlansInUse: new Set(document.lines.map((line) => line.ringPlanId).filter((id): id is string => Boolean(id))),
    destinationAllowlist: document.settings?.destinationAllowlist ?? DEFAULT_SETTINGS.destinationAllowlist,
    groups: document.groups.map(groupToInput),
    plans: document.plans.map(planToInput),
  };
}

export function groupToInput(group: RingGroupDoc): RingGroupInput {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    active: group.active,
    members: group.members.map((member) => ({
      id: member.id,
      memberKind: member.memberKind,
      profileId: member.profileId,
      externalNumber: member.externalNumber,
      position: member.position,
      ringSecs: member.ringSecs,
    })),
  };
}

export function planToInput(plan: RingPlanDoc): RingPlanInput {
  return {
    id: plan.id,
    name: plan.name,
    fallbackKind: plan.fallbackKind,
    fallbackNumber: plan.fallbackNumber,
    active: plan.active,
    steps: plan.steps.map((step) => ({ id: step.id, stepIndex: step.stepIndex, ringGroupId: step.ringGroupId, timeoutSecs: step.timeoutSecs, strategy: step.strategy })),
  };
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

function checkPositions(values: number[], path: string, field: string, issues: ValidationIssue[]): void {
  const sorted = [...values].sort((left, right) => left - right);
  const contiguous = sorted.every((value, index) => value === index);
  if (new Set(values).size !== values.length) {
    issues.push(issue(path, "duplicate_position", `Poradie sa opakuje (${field}).`));
    return;
  }
  if (!contiguous) issues.push(issue(path, "position_gap", `Poradie musí ísť od 0 bez medzier (${field}).`));
}

/**
 * Validates the merged routing world: the sections present in `input` replace
 * their counterparts in `context`, everything else stays as stored. That is the
 * only way to catch "the group this step needs just lost its last member".
 */
export function validateRoutingReplace(input: { groups?: RingGroupInput[]; plans?: RingPlanInput[] }, context: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const groups = input.groups ?? context.groups;
  const plans = input.plans ?? context.plans;

  // --- groups -------------------------------------------------------------
  const groupNames = new Set<string>();
  const groupIds = new Set<string>();
  const memberCounts = new Map<string, number>();

  groups.forEach((group, groupIndex) => {
    const path = `groups[${groupIndex}]`;
    if (!group.name) issues.push(issue(path, "name_required", "Skupina potrebuje názov."));
    const key = group.name.toLocaleLowerCase("sk");
    if (key && groupNames.has(key)) issues.push(issue(path, "duplicate_name", `Skupina s názvom „${group.name}" už existuje.`));
    groupNames.add(key);

    const id = group.id ?? null;
    if (id) {
      if (groupIds.has(id)) issues.push(issue(path, "duplicate_id", "Skupina je v zozname dvakrát."));
      groupIds.add(id);
      memberCounts.set(id, group.members.length);
    }

    checkPositions(
      group.members.map((member) => member.position),
      path,
      "členovia",
      issues,
    );

    const seenProfiles = new Set<string>();
    const seenNumbers = new Set<string>();

    group.members.forEach((member, memberIndex) => {
      const memberPath = `${path}.members[${memberIndex}]`;
      if (!MEMBER_KINDS.includes(member.memberKind)) {
        issues.push(issue(memberPath, "member_kind_invalid", "Neplatný typ člena skupiny."));
        return;
      }

      if (member.ringSecs !== null && member.ringSecs !== undefined) {
        if (member.ringSecs < MIN_RING_SECS) issues.push(issue(memberPath, "ring_secs_too_low", `Čas zvonenia člena musí byť aspoň ${MIN_RING_SECS} s.`));
        else if (member.ringSecs > MAX_RING_SECS) issues.push(issue(memberPath, "ring_secs_too_high", `Čas zvonenia člena môže byť najviac ${MAX_RING_SECS} s.`));
      }

      if (member.memberKind === "operator") {
        if (member.externalNumber) issues.push(issue(memberPath, "member_shape", "Operátor nemôže mať externé číslo."));
        if (!member.profileId) {
          issues.push(issue(memberPath, "profile_required", "Vyber operátora."));
          return;
        }
        if (!context.profileIds.has(member.profileId)) {
          issues.push(issue(memberPath, "profile_foreign", "Operátor nepatrí do tejto organizácie."));
          return;
        }
        if (seenProfiles.has(member.profileId)) issues.push(issue(memberPath, "duplicate_member", "Operátor je v skupine dvakrát."));
        seenProfiles.add(member.profileId);
        return;
      }

      if (member.profileId) issues.push(issue(memberPath, "member_shape", "Externé číslo nemôže mať operátora."));
      const normalized = normalizeE164(member.externalNumber);
      if (!normalized) {
        issues.push(issue(memberPath, "number_invalid", "Externé číslo nie je platné (formát E.164, napr. +421900123456)."));
        return;
      }
      if (!isDestinationAllowed(normalized, context.destinationAllowlist)) {
        issues.push(issue(memberPath, "number_not_allowed", `Číslo ${normalized} nie je v povolených cieľoch organizácie.`));
      }
      if (seenNumbers.has(normalized)) issues.push(issue(memberPath, "duplicate_member", "Číslo je v skupine dvakrát."));
      seenNumbers.add(normalized);
    });
  });

  // --- plans --------------------------------------------------------------
  const planNames = new Set<string>();
  const planIds = new Set<string>();

  plans.forEach((plan, planIndex) => {
    const path = `plans[${planIndex}]`;
    if (!plan.name) issues.push(issue(path, "name_required", "Plán potrebuje názov."));
    const key = plan.name.toLocaleLowerCase("sk");
    if (key && planNames.has(key)) issues.push(issue(path, "duplicate_name", `Plán s názvom „${plan.name}" už existuje.`));
    planNames.add(key);
    if (plan.id) {
      if (planIds.has(plan.id)) issues.push(issue(path, "duplicate_id", "Plán je v zozname dvakrát."));
      planIds.add(plan.id);
    }

    if (!FALLBACK_KINDS.includes(plan.fallbackKind)) issues.push(issue(path, "fallback_invalid", "Neplatné správanie po vyčerpaní plánu."));
    if (plan.fallbackKind === "external_number") {
      const normalized = normalizeE164(plan.fallbackNumber);
      if (!normalized) issues.push(issue(path, "fallback_number_invalid", "Presmerovanie na číslo potrebuje platné číslo v tvare E.164."));
      else if (!isDestinationAllowed(normalized, context.destinationAllowlist)) {
        issues.push(issue(path, "fallback_number_not_allowed", `Číslo ${normalized} nie je v povolených cieľoch organizácie.`));
      }
    }

    if (plan.steps.length === 0) {
      issues.push(issue(path, "plan_empty", "Plán zvonenia potrebuje aspoň jeden krok."));
    }

    checkPositions(
      plan.steps.map((step) => step.stepIndex),
      path,
      "kroky",
      issues,
    );

    plan.steps.forEach((step, stepIndex) => {
      const stepPath = `${path}.steps[${stepIndex}]`;
      if (!STRATEGIES.includes(step.strategy)) issues.push(issue(stepPath, "strategy_invalid", "Neplatná stratégia kroku."));
      if (step.timeoutSecs < MIN_TIMEOUT_SECS) issues.push(issue(stepPath, "timeout_too_low", `Čas kroku musí byť aspoň ${MIN_TIMEOUT_SECS} s.`));
      else if (step.timeoutSecs > MAX_TIMEOUT_SECS) issues.push(issue(stepPath, "timeout_too_high", `Čas kroku môže byť najviac ${MAX_TIMEOUT_SECS} s.`));

      if (!step.ringGroupId || !groupIds.has(step.ringGroupId)) {
        issues.push(issue(stepPath, "group_unknown", "Krok odkazuje na skupinu, ktorá v tejto organizácii neexistuje."));
        return;
      }
      if ((memberCounts.get(step.ringGroupId) ?? 0) === 0) {
        issues.push(issue(stepPath, "group_empty", "Skupina použitá v pláne nemá žiadneho člena."));
      }
    });
  });

  // --- referential integrity of what is being removed ----------------------
  if (input.plans) {
    for (const planId of context.ringPlansInUse) {
      if (!planIds.has(planId)) issues.push(issue("plans", "plan_in_use", "Plán, ktorý používa niektorá linka, sa nedá zmazať. Najprv prepni linku na iný plán."));
    }
  }
  if (input.groups) {
    for (const plan of plans) {
      for (const step of plan.steps) {
        if (step.ringGroupId && !groupIds.has(step.ringGroupId)) {
          issues.push(issue("groups", "group_in_use", `Skupina sa nedá zmazať: používa ju plán „${plan.name}".`));
        }
      }
    }
  }

  return issues;
}

export function validateBusinessHours(input: BusinessHoursInput[], context: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();

  input.forEach((hours, index) => {
    const path = `businessHours[${index}]`;
    if (!hours.name) issues.push(issue(path, "name_required", "Otváracie hodiny potrebujú názov."));
    const key = hours.name.toLocaleLowerCase("sk");
    if (key && names.has(key)) issues.push(issue(path, "duplicate_name", `Otváracie hodiny s názvom „${hours.name}" už existujú.`));
    names.add(key);
    if (hours.id) ids.add(hours.id);
    if (hours.timezone && !/^[A-Za-z]+\/[A-Za-z_+-]+$/.test(hours.timezone)) {
      issues.push(issue(path, "timezone_invalid", "Neplatné časové pásmo."));
    }

    const seen = new Set<string>();
    hours.intervals.forEach((interval, intervalIndex) => {
      const intervalPath = `${path}.intervals[${intervalIndex}]`;
      if (!Number.isInteger(interval.weekday) || interval.weekday < 1 || interval.weekday > 7) {
        issues.push(issue(intervalPath, "weekday_invalid", "Deň v týždni musí byť 1 (pondelok) až 7 (nedeľa)."));
        return;
      }
      if (!TIME_PATTERN.test(interval.opens) || !TIME_PATTERN.test(interval.closes)) {
        issues.push(issue(intervalPath, "time_invalid", "Čas musí byť v tvare HH:MM."));
        return;
      }
      if (interval.opens >= interval.closes) {
        issues.push(issue(intervalPath, "time_order", "Otvorenie musí byť skôr ako zatvorenie."));
        return;
      }
      const dayKey = `${interval.weekday}|${interval.opens}`;
      if (seen.has(dayKey)) issues.push(issue(intervalPath, "duplicate_interval", "Rovnaký interval je v zozname dvakrát."));
      seen.add(dayKey);
    });

    const seenDates = new Set<string>();
    hours.exceptions.forEach((exception, exceptionIndex) => {
      const exceptionPath = `${path}.exceptions[${exceptionIndex}]`;
      if (!DATE_PATTERN.test(exception.date) || Number.isNaN(Date.parse(exception.date))) {
        issues.push(issue(exceptionPath, "date_invalid", "Dátum výnimky musí byť v tvare RRRR-MM-DD."));
        return;
      }
      if (seenDates.has(exception.date)) issues.push(issue(exceptionPath, "duplicate_date", "Dátum výnimky je v zozname dvakrát."));
      seenDates.add(exception.date);
      for (const interval of exception.intervals ?? []) {
        if (!TIME_PATTERN.test(interval.opens) || !TIME_PATTERN.test(interval.closes) || interval.opens >= interval.closes) {
          issues.push(issue(exceptionPath, "time_invalid", "Interval výnimky musí byť platný (HH:MM, otvorenie pred zatvorením)."));
        }
      }
    });
  });

  for (const hoursId of context.businessHoursInUse) {
    if (!ids.has(hoursId)) issues.push(issue("businessHours", "business_hours_in_use", "Otváracie hodiny používa niektorá linka, nedajú sa zmazať."));
  }

  return issues;
}

export function validatePauseReasons(input: PauseReasonInput[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const codes = new Set<string>();

  input.forEach((reason, index) => {
    const path = `pauseReasons[${index}]`;
    if (!reason.code || !/^[a-z0-9_-]{2,32}$/.test(reason.code)) {
      issues.push(issue(path, "code_invalid", "Kód môže obsahovať len malé písmená, číslice, - a _ (2 až 32 znakov)."));
    } else if (codes.has(reason.code)) {
      issues.push(issue(path, "duplicate_code", `Kód „${reason.code}" je v zozname dvakrát.`));
    }
    codes.add(reason.code);
    if (!reason.label) issues.push(issue(path, "label_required", "Dôvod pauzy potrebuje názov."));
    if (reason.maxMinutes !== null && reason.maxMinutes !== undefined && reason.maxMinutes <= 0) {
      issues.push(issue(path, "max_minutes_invalid", "Maximálny čas pauzy musí byť kladný."));
    }
  });

  return issues;
}

export function validateLinePatch(patch: LinePatchInput, context: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (patch.label !== undefined && !patch.label.trim()) issues.push(issue("label", "label_required", "Linka potrebuje štítok."));
  if (patch.ringPlanId !== undefined && patch.ringPlanId !== null && !context.ringPlanIds.has(patch.ringPlanId)) {
    issues.push(issue("ringPlanId", "plan_foreign", "Plán zvonenia nepatrí do tejto organizácie."));
  }
  if (patch.ivrMenuId !== undefined && patch.ivrMenuId !== null && !context.ivrMenuIds.has(patch.ivrMenuId)) {
    issues.push(issue("ivrMenuId", "ivr_foreign", "IVR menu nepatrí do tejto organizácie."));
  }
  if (patch.businessHoursId !== undefined && patch.businessHoursId !== null && !context.businessHoursIds.has(patch.businessHoursId)) {
    issues.push(issue("businessHoursId", "hours_foreign", "Otváracie hodiny nepatria do tejto organizácie."));
  }
  if (patch.environment !== undefined && !ENVIRONMENTS.includes(patch.environment)) {
    issues.push(issue("environment", "environment_invalid", "Neplatné prostredie linky."));
  }
  return issues;
}

export function validateSettingsPatch(patch: TelephonySettingsPatchInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (patch.dailyLegSoftCap !== undefined && (!Number.isInteger(patch.dailyLegSoftCap) || patch.dailyLegSoftCap <= 0)) {
    issues.push(issue("dailyLegSoftCap", "cap_invalid", "Denný limit hovorov musí byť kladné číslo."));
  }
  if (patch.parkMaxMinutes !== undefined && (!Number.isInteger(patch.parkMaxMinutes) || patch.parkMaxMinutes < 1 || patch.parkMaxMinutes > MAX_PARK_MINUTES)) {
    issues.push(issue("parkMaxMinutes", "park_invalid", `Maximálny čas v čakárni musí byť 1 až ${MAX_PARK_MINUTES} minút.`));
  }
  if (patch.maxRingFanout !== undefined && (!Number.isInteger(patch.maxRingFanout) || patch.maxRingFanout < 1 || patch.maxRingFanout > 20)) {
    issues.push(issue("maxRingFanout", "fanout_invalid", "Počet súčasne zvoniacich zariadení musí byť 1 až 20."));
  }
  if (patch.maxConcurrentLegs !== undefined && (!Number.isInteger(patch.maxConcurrentLegs) || patch.maxConcurrentLegs < 1 || patch.maxConcurrentLegs > 50)) {
    issues.push(issue("maxConcurrentLegs", "legs_invalid", "Počet súčasných liniek musí byť 1 až 50."));
  }
  if (patch.destinationAllowlist !== undefined) {
    if (patch.destinationAllowlist.length === 0) {
      issues.push(issue("destinationAllowlist", "allowlist_empty", "Zoznam povolených cieľov nesmie byť prázdny — volanie by sa nedalo uskutočniť."));
    }
    for (const entry of patch.destinationAllowlist) {
      const trimmed = entry.trim();
      const known = trimmed === "*" || /^\+\d{1,4}$/.test(trimmed) || Boolean(COUNTRY_DIAL_PREFIXES[trimmed.toUpperCase()]);
      if (!known) issues.push(issue("destinationAllowlist", "allowlist_entry_invalid", `„${entry}" nie je kód krajiny (napr. SK) ani predvoľba (napr. +421).`));
    }
  }
  return issues;
}

export function validateOperatorSettingsPatch(patch: OperatorSettingsPatchInput, context: ValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (patch.wrapUpSeconds !== undefined && (!Number.isInteger(patch.wrapUpSeconds) || patch.wrapUpSeconds < 0 || patch.wrapUpSeconds > MAX_WRAP_UP_SECONDS)) {
    issues.push(issue("wrapUpSeconds", "wrap_up_invalid", `Čas po hovore musí byť 0 až ${MAX_WRAP_UP_SECONDS} sekúnd.`));
  }
  if (patch.ringDeviceVolume !== undefined && (!Number.isInteger(patch.ringDeviceVolume) || patch.ringDeviceVolume < 0 || patch.ringDeviceVolume > 100)) {
    issues.push(issue("ringDeviceVolume", "volume_invalid", "Hlasitosť zvonenia musí byť 0 až 100."));
  }
  if (patch.defaultFromLineId !== undefined && patch.defaultFromLineId !== null && !context.lineIds.has(patch.defaultFromLineId)) {
    issues.push(issue("defaultFromLineId", "line_foreign", "Linka nepatrí do tejto organizácie."));
  }
  return issues;
}

function assertValid(issues: ValidationIssue[]): void {
  if (issues.length === 0) return;
  throw new ConfigServiceError(issues[0].message, 400, "config_invalid", issues);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function timeOf(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 5) : "";
}

function exceptionIntervals(value: Json | null): Array<{ opens: string; closes: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (isRecord(entry) ? { opens: timeOf(entry.opens), closes: timeOf(entry.closes) } : null))
    .filter((entry): entry is { opens: string; closes: string } => Boolean(entry?.opens && entry?.closes));
}

export async function getRoutingDocument(deps: ConfigDeps, input: { organizationId: string; includeSettings: boolean }): Promise<RoutingDocument> {
  const { organizationId } = input;
  const scoped = <T>(promise: PromiseLike<{ data: T | null; error: { message: string } | null }>, label: string) =>
    Promise.resolve(promise).then((result) => {
      if (result.error) throw new ConfigServiceError(`${label} sa nepodarilo načítať: ${result.error.message}`, 500, "config_read_failed");
      return (result.data ?? []) as T;
    });

  const [groups, members, plans, steps, hours, intervals, exceptions, pauseReasons, lines, ivrMenus, profiles, operatorSettings, devices, settings] = await Promise.all([
    scoped<Tables["motorist_ring_groups"]["Row"][]>(deps.admin.from("motorist_ring_groups").select("*").eq("organization_id", organizationId).order("name"), "Skupiny"),
    scoped<Tables["motorist_ring_group_members"]["Row"][]>(deps.admin.from("motorist_ring_group_members").select("*").eq("organization_id", organizationId).order("position"), "Členovia skupín"),
    scoped<Tables["motorist_ring_plans"]["Row"][]>(deps.admin.from("motorist_ring_plans").select("*").eq("organization_id", organizationId).order("name"), "Plány zvonenia"),
    scoped<Tables["motorist_ring_plan_steps"]["Row"][]>(deps.admin.from("motorist_ring_plan_steps").select("*").eq("organization_id", organizationId).order("step_index"), "Kroky plánov"),
    scoped<Tables["motorist_business_hours"]["Row"][]>(deps.admin.from("motorist_business_hours").select("*").eq("organization_id", organizationId).order("name"), "Otváracie hodiny"),
    scoped<Tables["motorist_business_hours_intervals"]["Row"][]>(deps.admin.from("motorist_business_hours_intervals").select("*").eq("organization_id", organizationId).order("weekday"), "Intervaly otváracích hodín"),
    scoped<Tables["motorist_business_hours_exceptions"]["Row"][]>(deps.admin.from("motorist_business_hours_exceptions").select("*").eq("organization_id", organizationId).order("date"), "Výnimky otváracích hodín"),
    scoped<Tables["motorist_pause_reasons"]["Row"][]>(deps.admin.from("motorist_pause_reasons").select("*").eq("organization_id", organizationId).order("sort_order"), "Dôvody pauzy"),
    scoped<Tables["motorist_telephony_lines"]["Row"][]>(deps.admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId).order("phone_number"), "Linky"),
    scoped<Tables["motorist_ivr_menus"]["Row"][]>(deps.admin.from("motorist_ivr_menus").select("*").eq("organization_id", organizationId).order("name"), "IVR menu"),
    scoped<Array<Pick<Tables["motorist_profiles"]["Row"], "id" | "display_name" | "role" | "active" | "access_status">>>(
      deps.admin.from("motorist_profiles").select("id, display_name, role, active, access_status").eq("organization_id", organizationId).order("display_name"),
      "Operátori",
    ),
    scoped<Tables["motorist_operator_telephony_settings"]["Row"][]>(deps.admin.from("motorist_operator_telephony_settings").select("*").eq("organization_id", organizationId), "Nastavenia operátorov"),
    scoped<Tables["motorist_operator_devices"]["Row"][]>(deps.admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId), "Zariadenia operátorov"),
    Promise.resolve(deps.admin.from("motorist_telephony_settings").select("*").eq("organization_id", organizationId).maybeSingle()).then((result) => {
      if (result.error) throw new ConfigServiceError(`Nastavenia telefónie sa nepodarilo načítať: ${result.error.message}`, 500, "config_read_failed");
      return result.data;
    }),
  ]);

  const membersByGroup = new Map<string, RingGroupDoc["members"]>();
  for (const member of [...members].sort((left, right) => left.position - right.position)) {
    const list = membersByGroup.get(member.ring_group_id) ?? [];
    list.push({
      id: member.id,
      memberKind: member.member_kind as RingMemberKind,
      profileId: member.profile_id,
      externalNumber: member.external_number,
      position: member.position,
      ringSecs: member.ring_secs,
      lastOfferedAt: member.last_offered_at,
      lastAnsweredAt: member.last_answered_at,
    });
    membersByGroup.set(member.ring_group_id, list);
  }

  const stepsByPlan = new Map<string, RingPlanDoc["steps"]>();
  for (const step of [...steps].sort((left, right) => left.step_index - right.step_index)) {
    const list = stepsByPlan.get(step.ring_plan_id) ?? [];
    list.push({ id: step.id, stepIndex: step.step_index, ringGroupId: step.ring_group_id, timeoutSecs: step.timeout_secs, strategy: step.strategy });
    stepsByPlan.set(step.ring_plan_id, list);
  }

  const intervalsByHours = new Map<string, BusinessHoursDoc["intervals"]>();
  for (const interval of intervals) {
    const list = intervalsByHours.get(interval.business_hours_id) ?? [];
    list.push({ weekday: interval.weekday, opens: timeOf(interval.opens), closes: timeOf(interval.closes) });
    intervalsByHours.set(interval.business_hours_id, list);
  }

  const exceptionsByHours = new Map<string, BusinessHoursDoc["exceptions"]>();
  for (const exception of exceptions) {
    const list = exceptionsByHours.get(exception.business_hours_id) ?? [];
    list.push({ date: exception.date, closed: exception.closed, intervals: exceptionIntervals(exception.intervals), label: exception.label });
    exceptionsByHours.set(exception.business_hours_id, list);
  }

  const settingsByProfile = new Map(operatorSettings.map((row) => [row.profile_id, row]));
  const deviceByProfile = new Map(devices.map((row) => [row.profile_id, row]));

  return {
    organizationId,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      active: group.active,
      members: (membersByGroup.get(group.id) ?? []).sort((left, right) => left.position - right.position),
    })),
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      fallbackKind: plan.fallback_kind,
      fallbackNumber: plan.fallback_number,
      active: plan.active,
      steps: (stepsByPlan.get(plan.id) ?? []).sort((left, right) => left.stepIndex - right.stepIndex),
    })),
    businessHours: hours.map((row) => ({
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      active: row.active,
      intervals: (intervalsByHours.get(row.id) ?? []).sort((left, right) => left.weekday - right.weekday || left.opens.localeCompare(right.opens)),
      exceptions: (exceptionsByHours.get(row.id) ?? []).sort((left, right) => left.date.localeCompare(right.date)),
    })),
    pauseReasons: pauseReasons.map((row) => ({ id: row.id, code: row.code, label: row.label, maxMinutes: row.max_minutes, sortOrder: row.sort_order, active: row.active })),
    lines: lines.map((line) => ({
      id: line.id,
      phoneNumber: line.phone_number,
      label: line.label,
      partnerName: line.partner_name,
      telnyxNumberId: line.telnyx_number_id,
      ringPlanId: line.ring_plan_id,
      ivrMenuId: line.ivr_menu_id,
      businessHoursId: line.business_hours_id,
      environment: line.environment,
      active: line.active,
    })),
    ivrMenus: ivrMenus.map((menu) => ({ id: menu.id, name: menu.name, active: menu.active })),
    operators: profiles
      .filter((profile) => profile.active !== false)
      .map((profile) => {
        const operatorSetting = settingsByProfile.get(profile.id) ?? null;
        const device = deviceByProfile.get(profile.id) ?? null;
        return {
          profileId: profile.id,
          displayName: profile.display_name,
          role: profile.role as AppRole,
          active: profile.active,
          settings: operatorSetting
            ? {
                defaultFromLineId: operatorSetting.default_from_line_id,
                wrapUpSeconds: operatorSetting.wrap_up_seconds,
                autoAnswerOutbound: operatorSetting.auto_answer_outbound,
                ringDeviceVolume: operatorSetting.ring_device_volume,
              }
            : null,
          device: device
            ? {
                environment: device.environment,
                credentialId: device.telnyx_credential_id,
                sipUsername: device.sip_username,
                registrationState: device.registration_state,
                deviceSeenAt: device.device_seen_at,
              }
            : null,
        };
      }),
    settings: input.includeSettings
      ? settings
        ? {
            liveCallsEnabled: settings.live_calls_enabled,
            smsLiveSends: settings.sms_live_sends,
            dailyLegSoftCap: settings.daily_leg_soft_cap,
            parkMaxMinutes: settings.park_max_minutes,
            destinationAllowlist: settings.destination_allowlist ?? [],
            maxRingFanout: settings.max_ring_fanout,
            maxConcurrentLegs: settings.max_concurrent_legs,
          }
        : { ...DEFAULT_SETTINGS }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type CompactDiff = {
  added: string[];
  removed: string[];
  changed: Array<{ id: string; label: string; fields: string[] }>;
};

/** Compact structural diff of two keyed lists — small enough for an audit row. */
export function compactDiff<T>(before: T[], after: T[], keyOf: (row: T) => string, labelOf: (row: T) => string, fingerprint: (row: T) => Record<string, unknown>): CompactDiff {
  const beforeByKey = new Map(before.map((row) => [keyOf(row), row]));
  const afterByKey = new Map(after.map((row) => [keyOf(row), row]));
  const diff: CompactDiff = { added: [], removed: [], changed: [] };

  for (const [key, row] of afterByKey) {
    const previous = beforeByKey.get(key);
    if (!previous) {
      diff.added.push(labelOf(row));
      continue;
    }
    const beforeFields = fingerprint(previous);
    const afterFields = fingerprint(row);
    const fields = Object.keys(afterFields).filter((field) => JSON.stringify(beforeFields[field]) !== JSON.stringify(afterFields[field]));
    if (fields.length > 0) diff.changed.push({ id: key, label: labelOf(row), fields });
  }
  for (const [key, row] of beforeByKey) {
    if (!afterByKey.has(key)) diff.removed.push(labelOf(row));
  }
  return diff;
}

export function isEmptyDiff(diff: CompactDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

async function writeAudit(
  deps: ConfigDeps,
  input: { organizationId: string; actor: ConfigActor; action: string; entityId: string | null; before: Json | null; after: Json | null },
): Promise<void> {
  const { error } = await deps.admin.from("motorist_audit_log").insert({
    organization_id: input.organizationId,
    actor_profile_id: input.actor.profileId,
    action: input.action,
    entity_type: "telephony_config",
    entity_id: input.entityId,
    source: "dispatch_console",
    before_payload: input.before,
    after_payload: input.after,
  });
  // An audit failure must not roll back a configuration that is already applied;
  // it is loud in the logs instead.
  if (error) console.error("telephony config audit failed", { action: input.action, message: error.message });
}

// ---------------------------------------------------------------------------
// Transactional replace through the RPC
// ---------------------------------------------------------------------------

const RPC_MESSAGES: Array<{ match: RegExp; message: string; status: number; code: string }> = [
  { match: /cross_organization/, message: "Konfigurácia odkazuje na záznam inej organizácie.", status: 403, code: "cross_organization" },
  { match: /ring_group_in_use/, message: "Skupinu používa plán zvonenia, najprv ju odober z plánu.", status: 409, code: "ring_group_in_use" },
  { match: /ring_plan_in_use/, message: "Plán používa linka alebo IVR, najprv ho odpoj.", status: 409, code: "ring_plan_in_use" },
  { match: /business_hours_in_use/, message: "Otváracie hodiny používa linka, najprv ju prepni.", status: 409, code: "business_hours_in_use" },
  { match: /duplicate key|23505/, message: "Názov alebo kód sa už v organizácii používa.", status: 409, code: "duplicate" },
];

async function applyReplace(deps: ConfigDeps, organizationId: string, document: Json): Promise<void> {
  const { error } = await deps.admin.rpc("motorist_replace_ring_plan", { p_organization_id: organizationId, p_document: document });
  if (!error) return;
  const mapped = RPC_MESSAGES.find((entry) => entry.match.test(error.message));
  if (mapped) throw new ConfigServiceError(mapped.message, mapped.status, mapped.code);
  throw new ConfigServiceError(`Konfiguráciu sa nepodarilo uložiť: ${error.message}`, 500, "config_write_failed");
}

function groupsToRpc(groups: RingGroupInput[]): Json {
  return groups.map((group) => ({
    id: group.id ?? randomUUID(),
    name: group.name,
    description: group.description ?? null,
    active: group.active ?? true,
    members: group.members.map((member) => ({
      id: member.id ?? randomUUID(),
      member_kind: member.memberKind,
      profile_id: member.memberKind === "operator" ? member.profileId : null,
      external_number: member.memberKind === "external_number" ? normalizeE164(member.externalNumber) : null,
      position: member.position,
      ring_secs: member.ringSecs ?? null,
    })),
  })) as unknown as Json;
}

function plansToRpc(plans: RingPlanInput[]): Json {
  return plans.map((plan) => ({
    id: plan.id ?? randomUUID(),
    name: plan.name,
    fallback_kind: plan.fallbackKind,
    fallback_number: plan.fallbackKind === "external_number" ? normalizeE164(plan.fallbackNumber) : null,
    active: plan.active ?? true,
    steps: plan.steps.map((step) => ({
      id: step.id ?? randomUUID(),
      step_index: step.stepIndex,
      ring_group_id: step.ringGroupId,
      timeout_secs: step.timeoutSecs,
      strategy: step.strategy,
    })),
  })) as unknown as Json;
}

function hoursToRpc(hours: BusinessHoursInput[]): Json {
  return hours.map((row) => ({
    id: row.id ?? randomUUID(),
    name: row.name,
    timezone: row.timezone ?? "Europe/Bratislava",
    active: row.active ?? true,
    intervals: row.intervals.map((interval) => ({ weekday: interval.weekday, opens: interval.opens, closes: interval.closes })),
    exceptions: row.exceptions.map((exception) => ({
      date: exception.date,
      closed: exception.closed ?? true,
      intervals: (exception.intervals ?? []).map((interval) => ({ opens: interval.opens, closes: interval.closes })),
      label: exception.label ?? null,
    })),
  })) as unknown as Json;
}

function reasonsToRpc(reasons: PauseReasonInput[]): Json {
  return reasons.map((reason, index) => ({
    id: reason.id ?? randomUUID(),
    code: reason.code,
    label: reason.label,
    max_minutes: reason.maxMinutes ?? null,
    sort_order: reason.sortOrder ?? index * 10,
    active: reason.active ?? true,
  })) as unknown as Json;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export type ReplaceResult = { document: RoutingDocument; diff: CompactDiff };

export async function replaceRingGroups(deps: ConfigDeps, input: { organizationId: string; actor: ConfigActor; groups: RingGroupInput[] }): Promise<ReplaceResult> {
  const before = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const context = contextFromDocument(before);
  assertValid(validateRoutingReplace({ groups: input.groups }, context));

  await applyReplace(deps, input.organizationId, { groups: groupsToRpc(input.groups) } as unknown as Json);

  const after = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const diff = compactDiff(
    before.groups,
    after.groups,
    (group) => group.id,
    (group) => group.name,
    (group) => ({ name: group.name, active: group.active, members: group.members.map((member) => [member.position, member.memberKind, member.profileId ?? member.externalNumber, member.ringSecs]) }),
  );
  await writeAudit(deps, { organizationId: input.organizationId, actor: input.actor, action: "telephony.ring_groups.replace", entityId: null, before: null, after: diff as unknown as Json });
  return { document: after, diff };
}

export async function replaceRingPlans(deps: ConfigDeps, input: { organizationId: string; actor: ConfigActor; plans: RingPlanInput[] }): Promise<ReplaceResult> {
  const before = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const context = contextFromDocument(before);
  assertValid(validateRoutingReplace({ plans: input.plans }, context));

  await applyReplace(deps, input.organizationId, { plans: plansToRpc(input.plans) } as unknown as Json);

  const after = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const diff = compactDiff(
    before.plans,
    after.plans,
    (plan) => plan.id,
    (plan) => plan.name,
    (plan) => ({ name: plan.name, active: plan.active, fallback: [plan.fallbackKind, plan.fallbackNumber], steps: plan.steps.map((step) => [step.stepIndex, step.ringGroupId, step.timeoutSecs, step.strategy]) }),
  );
  await writeAudit(deps, { organizationId: input.organizationId, actor: input.actor, action: "telephony.ring_plans.replace", entityId: null, before: null, after: diff as unknown as Json });
  return { document: after, diff };
}

export async function replaceBusinessHours(deps: ConfigDeps, input: { organizationId: string; actor: ConfigActor; businessHours: BusinessHoursInput[] }): Promise<ReplaceResult> {
  const before = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  assertValid(validateBusinessHours(input.businessHours, contextFromDocument(before)));

  await applyReplace(deps, input.organizationId, { business_hours: hoursToRpc(input.businessHours) } as unknown as Json);

  const after = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const diff = compactDiff(
    before.businessHours,
    after.businessHours,
    (hours) => hours.id,
    (hours) => hours.name,
    (hours) => ({ name: hours.name, timezone: hours.timezone, active: hours.active, intervals: hours.intervals, exceptions: hours.exceptions }),
  );
  await writeAudit(deps, { organizationId: input.organizationId, actor: input.actor, action: "telephony.business_hours.replace", entityId: null, before: null, after: diff as unknown as Json });
  return { document: after, diff };
}

export async function replacePauseReasons(deps: ConfigDeps, input: { organizationId: string; actor: ConfigActor; pauseReasons: PauseReasonInput[] }): Promise<ReplaceResult> {
  const before = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  assertValid(validatePauseReasons(input.pauseReasons));

  await applyReplace(deps, input.organizationId, { pause_reasons: reasonsToRpc(input.pauseReasons) } as unknown as Json);

  const after = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const diff = compactDiff(
    before.pauseReasons,
    after.pauseReasons,
    (reason) => reason.id,
    (reason) => reason.code,
    (reason) => ({ code: reason.code, label: reason.label, maxMinutes: reason.maxMinutes, sortOrder: reason.sortOrder, active: reason.active }),
  );
  await writeAudit(deps, { organizationId: input.organizationId, actor: input.actor, action: "telephony.pause_reasons.replace", entityId: null, before: null, after: diff as unknown as Json });
  return { document: after, diff };
}

export async function updateTelephonyLine(
  deps: ConfigDeps,
  input: { organizationId: string; actor: ConfigActor; lineId: string; patch: LinePatchInput },
): Promise<{ document: RoutingDocument; line: LineDoc }> {
  const before = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const context = contextFromDocument(before);
  const current = before.lines.find((line) => line.id === input.lineId);
  if (!current) throw new ConfigServiceError("Linka neexistuje.", 404, "line_not_found");
  assertValid(validateLinePatch(input.patch, context));

  const values: Tables["motorist_telephony_lines"]["Update"] = {};
  if (input.patch.label !== undefined) values.label = input.patch.label.trim();
  if (input.patch.partnerName !== undefined) values.partner_name = input.patch.partnerName?.trim() || null;
  if (input.patch.ringPlanId !== undefined) values.ring_plan_id = input.patch.ringPlanId;
  if (input.patch.ivrMenuId !== undefined) values.ivr_menu_id = input.patch.ivrMenuId;
  if (input.patch.businessHoursId !== undefined) values.business_hours_id = input.patch.businessHoursId;
  if (input.patch.environment !== undefined) values.environment = input.patch.environment;
  if (input.patch.active !== undefined) values.active = input.patch.active;

  if (Object.keys(values).length > 0) {
    const { error } = await deps.admin.from("motorist_telephony_lines").update(values).eq("id", input.lineId).eq("organization_id", input.organizationId);
    if (error) throw new ConfigServiceError(`Linku sa nepodarilo uložiť: ${error.message}`, 500, "config_write_failed");
  }

  const after = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: true });
  const line = after.lines.find((row) => row.id === input.lineId) ?? current;
  const changed = Object.keys(values);
  if (changed.length > 0) {
    await writeAudit(deps, {
      organizationId: input.organizationId,
      actor: input.actor,
      action: "telephony.line.update",
      entityId: input.lineId,
      before: { number: current.phoneNumber, ...pick(current, changed) } as unknown as Json,
      after: { number: line.phoneNumber, ...pick(line, changed) } as unknown as Json,
    });
  }
  return { document: after, line };
}

/** Maps the changed DB columns back onto the document fields for the audit row. */
function pick(line: LineDoc, columns: string[]): Record<string, unknown> {
  const map: Record<string, keyof LineDoc> = {
    label: "label",
    partner_name: "partnerName",
    ring_plan_id: "ringPlanId",
    ivr_menu_id: "ivrMenuId",
    business_hours_id: "businessHoursId",
    environment: "environment",
    active: "active",
  };
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const key = map[column];
    if (key) out[key] = line[key];
  }
  return out;
}

export async function updateTelephonySettings(
  deps: ConfigDeps,
  input: { organizationId: string; actor: ConfigActor; patch: TelephonySettingsPatchInput },
): Promise<TelephonySettingsDoc> {
  assertValid(validateSettingsPatch(input.patch));

  const existing = await deps.admin.from("motorist_telephony_settings").select("*").eq("organization_id", input.organizationId).maybeSingle();
  if (existing.error) throw new ConfigServiceError(`Nastavenia sa nepodarilo načítať: ${existing.error.message}`, 500, "config_read_failed");

  const current: TelephonySettingsDoc = existing.data
    ? {
        liveCallsEnabled: existing.data.live_calls_enabled,
        smsLiveSends: existing.data.sms_live_sends,
        dailyLegSoftCap: existing.data.daily_leg_soft_cap,
        parkMaxMinutes: existing.data.park_max_minutes,
        destinationAllowlist: existing.data.destination_allowlist ?? [],
        maxRingFanout: existing.data.max_ring_fanout,
        maxConcurrentLegs: existing.data.max_concurrent_legs,
      }
    : { ...DEFAULT_SETTINGS };

  const next: TelephonySettingsDoc = {
    liveCallsEnabled: input.patch.liveCallsEnabled ?? current.liveCallsEnabled,
    smsLiveSends: input.patch.smsLiveSends ?? current.smsLiveSends,
    dailyLegSoftCap: input.patch.dailyLegSoftCap ?? current.dailyLegSoftCap,
    parkMaxMinutes: input.patch.parkMaxMinutes ?? current.parkMaxMinutes,
    destinationAllowlist: input.patch.destinationAllowlist?.map((entry) => entry.trim().toUpperCase()) ?? current.destinationAllowlist,
    maxRingFanout: input.patch.maxRingFanout ?? current.maxRingFanout,
    maxConcurrentLegs: input.patch.maxConcurrentLegs ?? current.maxConcurrentLegs,
  };

  const { error } = await deps.admin.from("motorist_telephony_settings").upsert(
    {
      ...(existing.data ? { id: existing.data.id } : {}),
      organization_id: input.organizationId,
      live_calls_enabled: next.liveCallsEnabled,
      sms_live_sends: next.smsLiveSends,
      daily_leg_soft_cap: next.dailyLegSoftCap,
      park_max_minutes: next.parkMaxMinutes,
      destination_allowlist: next.destinationAllowlist,
      max_ring_fanout: next.maxRingFanout,
      max_concurrent_legs: next.maxConcurrentLegs,
    },
    { onConflict: "organization_id" },
  );
  if (error) throw new ConfigServiceError(`Nastavenia sa nepodarilo uložiť: ${error.message}`, 500, "config_write_failed");

  const changed = (Object.keys(next) as Array<keyof TelephonySettingsDoc>).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]));
  if (changed.length > 0) {
    await writeAudit(deps, {
      organizationId: input.organizationId,
      actor: input.actor,
      action: "telephony.settings.update",
      entityId: null,
      before: Object.fromEntries(changed.map((key) => [key, current[key]])) as unknown as Json,
      after: Object.fromEntries(changed.map((key) => [key, next[key]])) as unknown as Json,
    });
  }
  return next;
}

export type OperatorSettingsDoc = NonNullable<OperatorDoc["settings"]>;

export const DEFAULT_OPERATOR_SETTINGS: OperatorSettingsDoc = {
  defaultFromLineId: null,
  wrapUpSeconds: 30,
  autoAnswerOutbound: true,
  ringDeviceVolume: 80,
};

export async function updateOperatorTelephonySettings(
  deps: ConfigDeps,
  input: { organizationId: string; actor: ConfigActor; profileId: string; patch: OperatorSettingsPatchInput },
): Promise<OperatorSettingsDoc> {
  const document = await getRoutingDocument(deps, { organizationId: input.organizationId, includeSettings: false });
  const operator = document.operators.find((candidate) => candidate.profileId === input.profileId);
  if (!operator) throw new ConfigServiceError("Operátor neexistuje.", 404, "operator_not_found");
  assertValid(validateOperatorSettingsPatch(input.patch, contextFromDocument(document)));

  const current = operator.settings ?? DEFAULT_OPERATOR_SETTINGS;
  const next: OperatorSettingsDoc = {
    defaultFromLineId: input.patch.defaultFromLineId !== undefined ? input.patch.defaultFromLineId : current.defaultFromLineId,
    wrapUpSeconds: input.patch.wrapUpSeconds ?? current.wrapUpSeconds,
    autoAnswerOutbound: input.patch.autoAnswerOutbound ?? current.autoAnswerOutbound,
    ringDeviceVolume: input.patch.ringDeviceVolume ?? current.ringDeviceVolume,
  };

  const { error } = await deps.admin.from("motorist_operator_telephony_settings").upsert(
    {
      organization_id: input.organizationId,
      profile_id: input.profileId,
      default_from_line_id: next.defaultFromLineId,
      wrap_up_seconds: next.wrapUpSeconds,
      auto_answer_outbound: next.autoAnswerOutbound,
      ring_device_volume: next.ringDeviceVolume,
    },
    { onConflict: "profile_id" },
  );
  if (error) throw new ConfigServiceError(`Nastavenia operátora sa nepodarilo uložiť: ${error.message}`, 500, "config_write_failed");

  const changed = (Object.keys(next) as Array<keyof OperatorSettingsDoc>).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]));
  if (changed.length > 0) {
    await writeAudit(deps, {
      organizationId: input.organizationId,
      actor: input.actor,
      action: "telephony.operator_settings.update",
      entityId: input.profileId,
      before: Object.fromEntries(changed.map((key) => [key, current[key]])) as unknown as Json,
      after: Object.fromEntries(changed.map((key) => [key, next[key]])) as unknown as Json,
    });
  }
  return next;
}

/** Audit row for the credential/disconnect actions (the work itself is in `operator-devices.ts`). */
export async function auditOperatorDeviceAction(
  deps: ConfigDeps,
  input: { organizationId: string; actor: ConfigActor; profileId: string; action: "credential.rotate" | "device.disconnect"; details?: Record<string, unknown> },
): Promise<void> {
  await writeAudit(deps, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: `telephony.${input.action}`,
    entityId: input.profileId,
    before: null,
    after: (input.details ?? {}) as unknown as Json,
  });
}
