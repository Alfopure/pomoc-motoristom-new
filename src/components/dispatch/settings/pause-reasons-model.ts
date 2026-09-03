/**
 * Pure model behind `PauseReasonsEditor.tsx` (design §3, plan "Fáza 3").
 *
 * A pause reason is what an operator picks when they step away ("obed",
 * "porada"): `motorist_operator_presence.pause_reason_id` points at it and
 * eligibility then skips that operator, so the list is small, ordered and
 * visible in `MyPhonePanel`.
 *
 * Ordering is drag-and-drop; `sortOrder` is derived from the array order when
 * the payload is built, exactly like the ring group positions.
 */

import type { PauseReasonDoc, PauseReasonInput, ValidationIssue } from "@/server/telephony/config-service";

import { nextDraftKey } from "./ring-groups-model";

/** Mirrors the server's `code_invalid` rule. */
export const CODE_PATTERN = /^[a-z0-9_-]{2,32}$/;
/** A pause longer than a shift is a mistake, not a pause (mirrors `MAX_PAUSE_MINUTES` on the server). */
export const MAX_PAUSE_MINUTES = 480;
/** Step between two `sort_order` values, so a row can be squeezed in by hand later. */
export const SORT_STEP = 10;

export type PauseReasonDraft = {
  /** Stable identity of the row for React keys and dnd-kit; not a database id. */
  key: string;
  id: string | null;
  code: string;
  label: string;
  /** Empty string = "bez limitu". */
  maxMinutes: string;
  active: boolean;
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export function pauseReasonDraftsFromDocument(reasons: readonly PauseReasonDoc[]): PauseReasonDraft[] {
  return [...reasons]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code, "sk"))
    .map((reason) => ({
      key: `reason-${reason.id}`,
      id: reason.id,
      code: reason.code,
      label: reason.label,
      maxMinutes: reason.maxMinutes === null ? "" : String(reason.maxMinutes),
      active: reason.active,
    }));
}

export function newPauseReasonDraft(): PauseReasonDraft {
  return { key: nextDraftKey("reason"), id: null, code: "", label: "", maxMinutes: "", active: true };
}

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

export function addPauseReason(reasons: readonly PauseReasonDraft[]): PauseReasonDraft[] {
  return [...reasons, newPauseReasonDraft()];
}

export function updatePauseReason(reasons: readonly PauseReasonDraft[], key: string, patch: Partial<Omit<PauseReasonDraft, "key" | "id">>): PauseReasonDraft[] {
  return reasons.map((reason) => (reason.key === key ? { ...reason, ...patch } : reason));
}

export function removePauseReason(reasons: readonly PauseReasonDraft[], key: string): PauseReasonDraft[] {
  return reasons.filter((reason) => reason.key !== key);
}

/** Drag-and-drop reorder; `sortOrder` follows from the array order. */
export function movePauseReason(reasons: readonly PauseReasonDraft[], activeKey: string, overKey: string): PauseReasonDraft[] {
  if (activeKey === overKey) return [...reasons];
  const from = reasons.findIndex((reason) => reason.key === activeKey);
  const to = reasons.findIndex((reason) => reason.key === overKey);
  if (from < 0 || to < 0) return [...reasons];
  const next = [...reasons];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Suggests a code from the Slovak label ("Obed a pauza" → "obed-a-pauza"). */
export function codeFromLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export function parseMaxMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
}

export function pauseReasonsPayload(reasons: readonly PauseReasonDraft[]): PauseReasonInput[] {
  return reasons.map((reason, index) => ({
    id: reason.id,
    code: reason.code.trim().toLowerCase(),
    label: reason.label.trim(),
    maxMinutes: parseMaxMinutes(reason.maxMinutes),
    sortOrder: index * SORT_STEP,
    active: reason.active,
  }));
}

export function pauseReasonsDirty(reasons: readonly PauseReasonDraft[], original: readonly PauseReasonDoc[]): boolean {
  return JSON.stringify(pauseReasonsPayload(reasons)) !== JSON.stringify(pauseReasonsPayload(pauseReasonDraftsFromDocument(original)));
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/**
 * Local mirror of `validatePauseReasons`. Paths are draft keys so the editor can
 * hang the message on the offending row; `""` belongs to the form as a whole.
 */
export function validatePauseReasonDrafts(reasons: readonly PauseReasonDraft[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const codes = new Set<string>();

  for (const reason of reasons) {
    const code = reason.code.trim().toLowerCase();
    if (!CODE_PATTERN.test(code)) {
      issues.push(issue(reason.key, "code_invalid", "Kód môže obsahovať len malé písmená, číslice, - a _ (2 až 32 znakov)."));
    } else if (codes.has(code)) {
      issues.push(issue(reason.key, "duplicate_code", `Kód „${code}" je v zozname dvakrát.`));
    }
    codes.add(code);

    if (!reason.label.trim()) issues.push(issue(reason.key, "label_required", "Dôvod pauzy potrebuje názov."));

    const maxMinutes = parseMaxMinutes(reason.maxMinutes);
    if (maxMinutes !== null && !Number.isFinite(maxMinutes)) {
      issues.push(issue(reason.key, "max_minutes_invalid", "Maximálny čas pauzy musí byť celé číslo v minútach."));
    } else if (maxMinutes !== null && maxMinutes <= 0) {
      issues.push(issue(reason.key, "max_minutes_invalid", "Maximálny čas pauzy musí byť kladný."));
    } else if (maxMinutes !== null && maxMinutes > MAX_PAUSE_MINUTES) {
      issues.push(issue(reason.key, "max_minutes_too_high", `Maximálny čas pauzy môže byť najviac ${MAX_PAUSE_MINUTES} minút.`));
    }
  }

  return issues;
}

/**
 * Non-blocking warning: the server accepts a list where everything is switched
 * off, but the operator then has no way to go on a break at all.
 */
export function pauseReasonsWarning(reasons: readonly PauseReasonDraft[]): string | null {
  if (reasons.length === 0) return "Bez dôvodu pauzy sa operátor nevie prepnúť na pauzu.";
  if (reasons.every((reason) => !reason.active)) return "Všetky dôvody pauzy sú vypnuté — operátor sa nevie prepnúť na pauzu.";
  return null;
}

/** Sentence under a row: what the operator will see and how long the pause may last. */
export function describePauseReason(reason: PauseReasonDraft): string {
  const maxMinutes = parseMaxMinutes(reason.maxMinutes);
  const limit = maxMinutes !== null && Number.isFinite(maxMinutes) && maxMinutes > 0 ? `najviac ${maxMinutes} min` : "bez časového limitu";
  return reason.active ? `V ponuke operátora, ${limit}.` : "Vypnutý — operátor si ho nevie zvoliť.";
}
