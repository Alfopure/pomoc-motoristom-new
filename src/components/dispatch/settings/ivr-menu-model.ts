/**
 * Pure model behind `IvrMenuEditor.tsx` (design §4 Phase 4, plan "Fáza 4").
 *
 * An IVR menu is what the caller hears before anybody's phone rings: a prompt
 * and a digit per option. Each option routes to a ring plan, an external
 * number, the waiting room, the callback offer, a repeat of the menu or a
 * closing message — exactly the actions `src/server/telephony/routing/ivr.ts`
 * knows how to execute, so this file mirrors its rules and never invents new
 * ones.
 *
 * The options are ordered by their digit (that is the order the caller hears
 * them announced in the recording), so there is nothing to drag.
 */

import {
  IVR_ACTIONS,
  IVR_DIGITS,
  MAX_IVR_TIMEOUT_SECS,
  MAX_IVR_TRIES,
  MAX_OPTIONS_PER_MENU,
  MAX_TTS_LENGTH,
  MIN_IVR_TIMEOUT_SECS,
  MIN_IVR_TRIES,
  type IvrAction,
  type IvrMenuDoc,
  type IvrMenuInput,
  type IvrOptionDoc,
  type LineDoc,
  type RingPlanDoc,
  type ValidationIssue,
} from "@/server/telephony/config-service";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";

import { nextDraftKey } from "./ring-groups-model";

export { IVR_ACTIONS, IVR_DIGITS, MAX_IVR_TIMEOUT_SECS, MAX_IVR_TRIES, MAX_OPTIONS_PER_MENU, MIN_IVR_TIMEOUT_SECS, MIN_IVR_TRIES };
export type { IvrAction };

/** Mirrors `MEDIA_REF_PATTERN` on the server. */
export const MEDIA_REF_PATTERN = /^(https:\/\/[^\s"']+|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;

/** Actions that ignore the per-option recording (`routing/ivr.ts` plays it only for these two). */
export const ACTIONS_WITH_PROMPT: readonly IvrAction[] = ["callback", "hangup"];

export const IVR_ACTION_LABELS: Record<IvrAction, string> = {
  ring_plan: "Plán zvonenia",
  callback: "Spätné volanie",
  external_number: "Presmerovanie na číslo",
  waiting_room: "Čakáreň",
  repeat: "Zopakovať menu",
  hangup: "Odkaz a ukončenie",
};

export type IvrOptionDraft = {
  /** Stable identity for React keys; not a database id. */
  key: string;
  id: string | null;
  digit: string;
  action: IvrAction;
  targetRingPlanId: string | null;
  targetNumber: string;
  label: string;
  promptMediaUrl: string;
  ttsText: string;
};

export type IvrMenuDraft = {
  key: string;
  id: string | null;
  name: string;
  promptMediaUrl: string;
  ttsText: string;
  invalidMediaUrl: string;
  /** Kept as text so a half-typed number never becomes `NaN` in the draft. */
  timeoutSecs: string;
  maxTries: string;
  active: boolean;
  options: IvrOptionDraft[];
};

export const DEFAULT_TIMEOUT_SECS = 5;
export const DEFAULT_MAX_TRIES = 2;

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

function optionDraft(option: IvrOptionDoc): IvrOptionDraft {
  return {
    key: `ivr-option-${option.id}`,
    id: option.id,
    digit: option.digit,
    action: option.action,
    targetRingPlanId: option.targetRingPlanId,
    targetNumber: option.targetNumber ?? "",
    label: option.label,
    promptMediaUrl: option.promptMediaUrl ?? "",
    ttsText: option.ttsText ?? "",
  };
}

export function ivrMenuDraftsFromDocument(menus: readonly IvrMenuDoc[]): IvrMenuDraft[] {
  return [...menus]
    .sort((left, right) => left.name.localeCompare(right.name, "sk"))
    .map((menu) => ({
      key: `ivr-menu-${menu.id}`,
      id: menu.id,
      name: menu.name,
      promptMediaUrl: menu.promptMediaUrl ?? "",
      ttsText: menu.ttsText ?? "",
      invalidMediaUrl: menu.invalidMediaUrl ?? "",
      timeoutSecs: String(menu.timeoutSecs),
      maxTries: String(menu.maxTries),
      active: menu.active,
      options: [...menu.options].sort(byDigit).map(optionDraft),
    }));
}

function byDigit(left: { digit: string }, right: { digit: string }): number {
  const rank = (digit: string) => {
    const index = IVR_DIGITS.indexOf(digit);
    return index < 0 ? IVR_DIGITS.length : index;
  };
  return rank(left.digit) - rank(right.digit) || left.digit.localeCompare(right.digit);
}

/** The lowest digit the menu does not use yet; `""` when the keypad is full. */
export function nextFreeDigit(options: readonly IvrOptionDraft[]): string {
  const used = new Set(options.map((option) => option.digit));
  // 1…9, then 0, then * and #: the order a Slovak prompt announces them.
  for (const digit of "1234567890*#") {
    if (!used.has(digit)) return digit;
  }
  return "";
}

export function newIvrMenuDraft(): IvrMenuDraft {
  return {
    key: nextDraftKey("ivr-menu"),
    id: null,
    name: "",
    promptMediaUrl: "",
    ttsText: "",
    invalidMediaUrl: "",
    timeoutSecs: String(DEFAULT_TIMEOUT_SECS),
    maxTries: String(DEFAULT_MAX_TRIES),
    active: true,
    options: [],
  };
}

export function newIvrOptionDraft(digit: string): IvrOptionDraft {
  return { key: nextDraftKey("ivr-option"), id: null, digit, action: "ring_plan", targetRingPlanId: null, targetNumber: "", label: "", promptMediaUrl: "", ttsText: "" };
}

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

export function addIvrMenu(menus: readonly IvrMenuDraft[]): IvrMenuDraft[] {
  return [...menus, newIvrMenuDraft()];
}

export function updateIvrMenu(menus: readonly IvrMenuDraft[], key: string, patch: Partial<Omit<IvrMenuDraft, "key" | "id" | "options">>): IvrMenuDraft[] {
  return menus.map((menu) => (menu.key === key ? { ...menu, ...patch } : menu));
}

export function removeIvrMenu(menus: readonly IvrMenuDraft[], key: string): IvrMenuDraft[] {
  return menus.filter((menu) => menu.key !== key);
}

export function addIvrOption(menus: readonly IvrMenuDraft[], menuKey: string): IvrMenuDraft[] {
  return menus.map((menu) => {
    if (menu.key !== menuKey || menu.options.length >= MAX_OPTIONS_PER_MENU) return menu;
    return { ...menu, options: [...menu.options, newIvrOptionDraft(nextFreeDigit(menu.options))] };
  });
}

/**
 * Patching an option keeps the shape the server validates: a target belongs to
 * exactly one action, so switching the action drops the target that no longer
 * applies instead of sending a `target_shape` issue back from the server.
 */
export function updateIvrOption(
  menus: readonly IvrMenuDraft[],
  menuKey: string,
  optionKey: string,
  patch: Partial<Omit<IvrOptionDraft, "key" | "id">>,
): IvrMenuDraft[] {
  return menus.map((menu) => {
    if (menu.key !== menuKey) return menu;
    return {
      ...menu,
      options: menu.options.map((option) => {
        if (option.key !== optionKey) return option;
        const next = { ...option, ...patch };
        if (patch.action && patch.action !== option.action) {
          if (patch.action !== "ring_plan") next.targetRingPlanId = null;
          if (patch.action !== "external_number") next.targetNumber = "";
        }
        return next;
      }),
    };
  });
}

export function removeIvrOption(menus: readonly IvrMenuDraft[], menuKey: string, optionKey: string): IvrMenuDraft[] {
  return menus.map((menu) => (menu.key === menuKey ? { ...menu, options: menu.options.filter((option) => option.key !== optionKey) } : menu));
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export function parseCount(value: string): number {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
}

export function ivrMenusPayload(menus: readonly IvrMenuDraft[]): IvrMenuInput[] {
  return menus.map((menu) => ({
    id: menu.id,
    name: menu.name.trim(),
    promptMediaUrl: menu.promptMediaUrl.trim() || null,
    ttsText: menu.ttsText.trim() || null,
    invalidMediaUrl: menu.invalidMediaUrl.trim() || null,
    timeoutSecs: parseCount(menu.timeoutSecs),
    maxTries: parseCount(menu.maxTries),
    active: menu.active,
    options: [...menu.options].sort(byDigit).map((option) => ({
      id: option.id,
      digit: option.digit.trim(),
      action: option.action,
      targetRingPlanId: option.action === "ring_plan" ? option.targetRingPlanId : null,
      targetNumber: option.action === "external_number" ? option.targetNumber.trim() || null : null,
      label: option.label.trim(),
      promptMediaUrl: option.promptMediaUrl.trim() || null,
      ttsText: option.ttsText.trim() || null,
    })),
  }));
}

export function ivrMenusDirty(menus: readonly IvrMenuDraft[], original: readonly IvrMenuDoc[]): boolean {
  return JSON.stringify(ivrMenusPayload(menus)) !== JSON.stringify(ivrMenusPayload(ivrMenuDraftsFromDocument(original)));
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export type IvrValidationContext = {
  plans: readonly RingPlanDoc[];
  destinationAllowlist?: readonly string[];
};

/**
 * Local mirror of `validateIvrMenus`. Paths are draft keys (menu or option) so
 * the editor can hang the message on the offending row.
 */
export function validateIvrMenuDrafts(menus: readonly IvrMenuDraft[], context: IvrValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = new Set<string>();
  const planIds = new Set(context.plans.map((plan) => plan.id));

  const checkMedia = (value: string, key: string, code: string) => {
    const trimmed = value.trim();
    if (trimmed && !MEDIA_REF_PATTERN.test(trimmed)) {
      issues.push(issue(key, code, "Nahrávka musí byť názov súboru (napr. ivr-main.mp3) alebo https adresa."));
    }
  };
  const checkTts = (value: string, key: string) => {
    if (value.trim().length > MAX_TTS_LENGTH) issues.push(issue(key, "tts_too_long", `Text na prečítanie môže mať najviac ${MAX_TTS_LENGTH} znakov.`));
  };

  for (const menu of menus) {
    const name = menu.name.trim();
    if (!name) issues.push(issue(menu.key, "name_required", "IVR menu potrebuje názov."));
    const key = name.toLocaleLowerCase("sk");
    if (key && names.has(key)) issues.push(issue(menu.key, "duplicate_name", `IVR menu s názvom „${name}“ už existuje.`));
    names.add(key);

    checkMedia(menu.promptMediaUrl, menu.key, "prompt_invalid");
    checkMedia(menu.invalidMediaUrl, menu.key, "invalid_prompt_invalid");
    checkTts(menu.ttsText, menu.key);
    if (!menu.promptMediaUrl.trim() && !menu.ttsText.trim()) {
      issues.push(issue(menu.key, "prompt_required", "Menu potrebuje nahrávku alebo text, ktorý sa volajúcemu prečíta."));
    }

    const timeoutSecs = parseCount(menu.timeoutSecs);
    if (!Number.isInteger(timeoutSecs) || timeoutSecs < MIN_IVR_TIMEOUT_SECS || timeoutSecs > MAX_IVR_TIMEOUT_SECS) {
      issues.push(issue(menu.key, "timeout_invalid", `Čas na voľbu musí byť ${MIN_IVR_TIMEOUT_SECS} až ${MAX_IVR_TIMEOUT_SECS} sekúnd.`));
    }
    const maxTries = parseCount(menu.maxTries);
    if (!Number.isInteger(maxTries) || maxTries < MIN_IVR_TRIES || maxTries > MAX_IVR_TRIES) {
      issues.push(issue(menu.key, "tries_invalid", `Počet prehratí menu musí byť ${MIN_IVR_TRIES} až ${MAX_IVR_TRIES}.`));
    }

    const digits = new Set<string>();
    for (const option of menu.options) {
      const digit = option.digit.trim();
      if (digit.length !== 1 || !IVR_DIGITS.includes(digit)) {
        issues.push(issue(option.key, "digit_invalid", "Voľba musí byť jedna klávesa: 0 až 9, * alebo #."));
      } else if (digits.has(digit)) {
        issues.push(issue(option.key, "duplicate_digit", `Klávesa „${digit}“ je v menu dvakrát.`));
      }
      digits.add(digit);

      if (!option.label.trim()) issues.push(issue(option.key, "label_required", "Voľba potrebuje názov, aby bolo v prehľadoch vidno, čo si volajúci vybral."));
      checkMedia(option.promptMediaUrl, option.key, "prompt_invalid");
      checkTts(option.ttsText, option.key);

      if (!IVR_ACTIONS.includes(option.action)) {
        issues.push(issue(option.key, "action_invalid", "Neplatná akcia voľby."));
        continue;
      }
      if (option.action === "ring_plan") {
        if (!option.targetRingPlanId) issues.push(issue(option.key, "plan_required", "Vyber plán zvonenia, na ktorý voľba smeruje."));
        else if (!planIds.has(option.targetRingPlanId)) issues.push(issue(option.key, "plan_foreign", "Plán zvonenia nepatrí do tejto organizácie."));
      }
      if (option.action === "external_number" && !normalizeE164(option.targetNumber)) {
        issues.push(issue(option.key, "number_invalid", "Presmerovanie na číslo potrebuje platné číslo v tvare E.164 (napr. +421900123456)."));
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Warnings (non-blocking, they describe what the caller will experience)
// ---------------------------------------------------------------------------

export type IvrWarning = { key: string; message: string };

/**
 * What the menu does to a real call, said out loud: an unused menu is dead
 * configuration, an inactive one is skipped, a menu with no options wastes the
 * caller's time, and a recording that nothing plays is a promise not kept.
 */
export function ivrMenuWarnings(menu: IvrMenuDraft, lines: readonly LineDoc[]): IvrWarning[] {
  const warnings: IvrWarning[] = [];
  const usedBy = lines.filter((line) => line.ivrMenuId === menu.id);

  if (menu.id && usedBy.length === 0) {
    warnings.push({ key: menu.key, message: "Menu nepoužíva žiadne číslo — nastav ho v sekcii Čísla, inak sa nikdy neprehrá." });
  }
  if (!menu.active && usedBy.length > 0) {
    warnings.push({
      key: menu.key,
      message: `Menu je vypnuté — na ${usedBy.map((line) => line.label).join(", ")} sa neprehrá a hovor pôjde rovno na plán zvonenia linky.`,
    });
  }
  if (menu.options.length === 0) {
    warnings.push({ key: menu.key, message: "Menu nemá žiadnu voľbu — volajúci si vypočuje odkaz a hovor potom pôjde na plán zvonenia linky." });
  }
  if (!menu.promptMediaUrl.trim() && menu.ttsText.trim()) {
    warnings.push({ key: menu.key, message: "Bez nahrávky text prečíta hlasový robot. Znie to horšie ako nahrávka, ale hovor to nepokazí." });
  }
  for (const option of menu.options) {
    if (option.promptMediaUrl.trim() && !ACTIONS_WITH_PROMPT.includes(option.action)) {
      warnings.push({ key: option.key, message: `Nahrávka voľby ${option.digit} sa pri akcii „${IVR_ACTION_LABELS[option.action]}“ neprehrá — prehrá sa len pri spätnom volaní a pri odkaze s ukončením.` });
    }
    if (option.action === "hangup" && !option.promptMediaUrl.trim()) {
      warnings.push({ key: option.key, message: `Voľba ${option.digit} ukončí hovor bez odkazu — volajúci počuje len ticho a zavesenie.` });
    }
  }
  return warnings;
}

/** Menus a line still points at; deleting one is refused by the server. */
export function ivrMenusInUseWarning(menus: readonly IvrMenuDraft[], lines: readonly LineDoc[]): string | null {
  const kept = new Set(menus.map((menu) => menu.id).filter((id): id is string => Boolean(id)));
  const removed = lines.filter((line) => line.ivrMenuId && !kept.has(line.ivrMenuId));
  if (removed.length === 0) return null;
  return `Odstraňuješ IVR menu, ktoré používa ${removed.map((line) => line.label).join(", ")}. Server takú zmenu odmietne — najprv menu odober z čísla.`;
}

/** One-line description of an option, shown under its row. */
export function describeIvrOption(option: IvrOptionDraft, context: IvrValidationContext): string {
  switch (option.action) {
    case "ring_plan": {
      const plan = context.plans.find((candidate) => candidate.id === option.targetRingPlanId);
      if (!plan) return "Zazvoní podľa vybraného plánu zvonenia.";
      return plan.active ? `Zazvoní podľa plánu „${plan.name}“.` : `Plán „${plan.name}“ je vypnutý — hovor pôjde na plán zvonenia linky.`;
    }
    case "callback":
      return "Zapíše spätné volanie, prehrá potvrdenie a hovor ukončí.";
    case "external_number":
      return option.targetNumber.trim() ? `Prepojí hovor na ${normalizeE164(option.targetNumber) ?? option.targetNumber}.` : "Prepojí hovor na zadané číslo.";
    case "waiting_room":
      return "Presunie volajúceho do čakárne s hudbou, kde si ho môže prevziať operátor.";
    case "repeat":
      return "Prehrá menu znova (v rámci povoleného počtu prehratí).";
    case "hangup":
      return option.promptMediaUrl.trim() ? "Prehrá odkaz a hovor ukončí." : "Hovor ukončí bez odkazu.";
  }
}
