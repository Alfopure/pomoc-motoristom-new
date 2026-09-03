/**
 * Pure model behind `NumbersPanel.tsx` (design §3, plan "Fáza 3").
 *
 * A line is a DID already provisioned in `motorist_telephony_lines`: the panel
 * gives it a label and a partner, and points it at a ring plan, an IVR menu and
 * a business-hours schedule. Buying a number from Telnyx is **not** part of
 * this phase — a new number is added by an administrator — so nothing here
 * creates or deletes a line.
 *
 * The route is `PATCH /api/telephony/config/numbers` with one `lineId` and a
 * patch of the fields that actually changed, so the payload builder is a diff,
 * not a full row: an untouched column is never rewritten and never lands in the
 * audit row.
 */

import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { BusinessHoursDoc, IvrMenuDoc, LineDoc, LinePatchInput, RingPlanDoc, ValidationIssue } from "@/server/telephony/config-service";
import type { TelephonyEnvironment } from "@/server/telephony/state/types";

export const ENVIRONMENTS: TelephonyEnvironment[] = ["production", "development"];

export const ENVIRONMENT_LABELS: Record<TelephonyEnvironment, string> = {
  production: "Produkcia",
  development: "Test / vývoj",
};

export type LineDraft = {
  /** The database id doubles as the React key: lines are never created here. */
  id: string;
  phoneNumber: string;
  label: string;
  partnerName: string;
  ringPlanId: string | null;
  ivrMenuId: string | null;
  businessHoursId: string | null;
  environment: TelephonyEnvironment;
  active: boolean;
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export function lineDraftsFromDocument(lines: readonly LineDoc[]): LineDraft[] {
  return [...lines]
    .sort((left, right) => left.phoneNumber.localeCompare(right.phoneNumber))
    .map((line) => ({
      id: line.id,
      phoneNumber: line.phoneNumber,
      label: line.label,
      partnerName: line.partnerName ?? "",
      ringPlanId: line.ringPlanId,
      ivrMenuId: line.ivrMenuId,
      businessHoursId: line.businessHoursId,
      environment: line.environment,
      active: line.active,
    }));
}

export function updateLine(lines: readonly LineDraft[], lineId: string, patch: Partial<Omit<LineDraft, "id" | "phoneNumber">>): LineDraft[] {
  return lines.map((line) => (line.id === lineId ? { ...line, ...patch } : line));
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** Only the fields that differ from the stored line; `{}` means "nothing to save". */
export function linePatch(draft: LineDraft, original: LineDoc): LinePatchInput {
  const patch: LinePatchInput = {};
  const label = draft.label.trim();
  const partnerName = draft.partnerName.trim() ? draft.partnerName.trim() : null;
  if (label !== original.label) patch.label = label;
  if (partnerName !== original.partnerName) patch.partnerName = partnerName;
  if (draft.ringPlanId !== original.ringPlanId) patch.ringPlanId = draft.ringPlanId;
  if (draft.ivrMenuId !== original.ivrMenuId) patch.ivrMenuId = draft.ivrMenuId;
  if (draft.businessHoursId !== original.businessHoursId) patch.businessHoursId = draft.businessHoursId;
  if (draft.environment !== original.environment) patch.environment = draft.environment;
  if (draft.active !== original.active) patch.active = draft.active;
  return patch;
}

export function lineDirty(draft: LineDraft, original: LineDoc): boolean {
  return Object.keys(linePatch(draft, original)).length > 0;
}

export function findLine(lines: readonly LineDoc[], lineId: string): LineDoc | null {
  return lines.find((line) => line.id === lineId) ?? null;
}

/** Ids of the lines the manager has edited but not saved yet. */
export function dirtyLineIds(drafts: readonly LineDraft[], lines: readonly LineDoc[]): string[] {
  return drafts.filter((draft) => {
    const original = findLine(lines, draft.id);
    return original ? lineDirty(draft, original) : false;
  }).map((draft) => draft.id);
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export type LineValidationContext = {
  plans: readonly RingPlanDoc[];
  ivrMenus: readonly IvrMenuDoc[];
  businessHours: readonly BusinessHoursDoc[];
};

/** Local mirror of `validateLinePatch`; the path is the line id. */
export function validateLineDraft(draft: LineDraft, context: LineValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!draft.label.trim()) issues.push(issue(draft.id, "label_required", "Linka potrebuje štítok."));
  if (draft.ringPlanId && !context.plans.some((plan) => plan.id === draft.ringPlanId)) {
    issues.push(issue(draft.id, "plan_foreign", "Plán zvonenia nepatrí do tejto organizácie."));
  }
  if (draft.ivrMenuId && !context.ivrMenus.some((menu) => menu.id === draft.ivrMenuId)) {
    issues.push(issue(draft.id, "ivr_foreign", "IVR menu nepatrí do tejto organizácie."));
  }
  if (draft.businessHoursId && !context.businessHours.some((hours) => hours.id === draft.businessHoursId)) {
    issues.push(issue(draft.id, "hours_foreign", "Otváracie hodiny nepatria do tejto organizácie."));
  }
  if (!ENVIRONMENTS.includes(draft.environment)) issues.push(issue(draft.id, "environment_invalid", "Neplatné prostredie linky."));
  return issues;
}

export function validateLineDrafts(drafts: readonly LineDraft[], context: LineValidationContext): ValidationIssue[] {
  return drafts.flatMap((draft) => validateLineDraft(draft, context));
}

// ---------------------------------------------------------------------------
// Notes and preview
// ---------------------------------------------------------------------------

/**
 * Warnings the server accepts but the manager should see: an active line with no
 * plan has nowhere to ring, and a plan, schedule or IVR menu that is switched
 * off changes what the caller hears (`loadBusinessHours`/`loadIvr`/`loadRingPlan`
 * all return `null` for an inactive row).
 */
export function lineWarnings(draft: LineDraft, context: LineValidationContext): string[] {
  const warnings: string[] = [];
  if (!draft.active) {
    // `findLine` filters on `active`, but `createInboundSession` still creates
    // the session and answers the call with `line_id: null`: no plan, no IVR, no
    // opening hours, and `startRingPlan(…, null)` offers a callback. Deactivating
    // is therefore "unrouted", not "not processed".
    warnings.push(
      "Linka je vypnutá — nedá sa z nej volať von a prichádzajúci hovor stratí plán zvonenia, IVR aj otváracie hodiny. Hovor sa však aj tak prijme, zaznamená a účtuje a volajúcemu sa ponúkne spätné volanie. Ak má číslo prestať zvoniť úplne, treba ho odpojiť u operátora (Telnyx), nestačí ho vypnúť tu.",
    );
    return warnings;
  }
  const plan = context.plans.find((candidate) => candidate.id === draft.ringPlanId) ?? null;
  if (!plan) {
    warnings.push("Linka nemá plán zvonenia — hovor na ňu by nikomu nezazvonil.");
  } else if (!plan.active) {
    warnings.push(`Plán „${plan.name}" je vypnutý.`);
  } else if (plan.steps.length === 0) {
    warnings.push(`Plán „${plan.name}" nemá žiadny krok.`);
  }

  const hours = context.businessHours.find((candidate) => candidate.id === draft.businessHoursId) ?? null;
  if (!hours) warnings.push("Linka nemá otváracie hodiny — zvoní nonstop.");
  else if (!hours.active) warnings.push(`Otváracie hodiny „${hours.name}" sú vypnuté, linka zvoní nonstop.`);

  const menu = context.ivrMenus.find((candidate) => candidate.id === draft.ivrMenuId) ?? null;
  if (menu && !menu.active) warnings.push(`IVR menu „${menu.name}" je vypnuté, hovor pôjde rovno na plán zvonenia.`);

  if (draft.environment === "development") {
    // `findLine` prefers a line whose environment matches the running app and
    // only falls back to another one, so a test line is not dead — it just
    // loses to its production twin.
    warnings.push("Linka je označená ako testovacia; ak pre to isté číslo existuje produkčná linka, v produkcii má prednosť ona.");
  }
  return warnings;
}

/** One-line routing summary: plan → IVR → hours. */
export function describeLineRouting(draft: LineDraft, context: LineValidationContext): string {
  const plan = context.plans.find((candidate) => candidate.id === draft.ringPlanId);
  const menu = context.ivrMenus.find((candidate) => candidate.id === draft.ivrMenuId);
  const hours = context.businessHours.find((candidate) => candidate.id === draft.businessHoursId);
  const parts = [
    hours ? `hodiny „${hours.name}"` : "bez otváracích hodín",
    menu ? `IVR „${menu.name}"` : "bez IVR",
    plan ? `plán „${plan.name}"` : "bez plánu zvonenia",
  ];
  return `${parts.join(" → ")}.`;
}

/** `+421 900 123 456 — Hlavná linka (Partner)` for the card header. */
export function describeLineTitle(draft: LineDraft): string {
  const label = draft.label.trim() || "bez štítku";
  const partner = draft.partnerName.trim();
  return `${formatPhoneNumberForDisplay(draft.phoneNumber)} — ${label}${partner ? ` (${partner})` : ""}`;
}
