import "server-only";

import type { Database } from "@/lib/supabase/database.types";

import { AI_DEMO_ALLOWED_VOICES } from "./config";
import { AiDemoError, type AiDemoDeps } from "./orchestrator";

export type AgentSettingsRow = Database["public"]["Tables"]["motorist_ai_agent_settings"]["Row"];

/**
 * How much room the standing rules get inside the voice prompt.
 *
 * Not a round number and not a guess. The assembled prompt measures 1 981
 * characters at its longest scenario, against the 2 000 the prompt tests
 * enforce — nineteen characters of headroom. So standing rules cannot be free:
 * they push the total past a ceiling that exists because a 5 500-character
 * prompt once made her read the manual aloud and doubled the time to her first
 * word.
 *
 * 350 buys a usable field while keeping the total inside 2 350, which
 * `prompts.test.ts` asserts. That total is above the range verified on live
 * calls (1 500–1 981), so the first call with a full field is a measurement,
 * not a formality — if the pause before her first word grows, this number
 * comes down, not up.
 */
export const AI_DEMO_STANDING_RULES_MAX_CHARS = 350;

export const AI_DEMO_NAME_MIN_CHARS = 2;
export const AI_DEMO_NAME_MAX_CHARS = 20;
export const AI_DEMO_INTRO_CUSTOM_MAX_CHARS = 60;

export const AI_DEMO_INTRO_STYLES = ["expert_helper", "assistant", "custom"] as const;
export type AiDemoIntroStyle = (typeof AI_DEMO_INTRO_STYLES)[number];

export const AI_DEMO_DEFAULT_STANDING_RULES =
  "Hovor vecne a priateľsky, bez zbytočných fráz. Jedna otázka naraz a počkaj na odpoveď. " +
  "Keď niečo hľadáš, povedz to nahlas. Neopakuj, čo klient už povedal. Keď odpoveď nevieš, " +
  "priznaj to a sľúb, že sa ozve kolega — nevymýšľaj si. Nesľubuj cenu ani termín.";

export type AgentSettings = {
  displayName: string;
  voice: string;
  introStyle: AiDemoIntroStyle;
  introCustom: string | null;
  standingRules: string | null;
  readsCallerCases: boolean;
  requiresPlateCheck: boolean;
  createsDraftCases: boolean;
  addsCaseNotes: boolean;
  smsEnabled: boolean;
  smsMaxPerCall: number;
  profileId: string | null;
};

/** What a deployment that has never opened the panel gets. Everything off. */
export const AI_DEMO_AGENT_DEFAULTS: AgentSettings = {
  displayName: "Veronika",
  voice: "gleam",
  introStyle: "expert_helper",
  introCustom: null,
  standingRules: null,
  readsCallerCases: false,
  requiresPlateCheck: true,
  createsDraftCases: false,
  addsCaseNotes: false,
  smsEnabled: false,
  smsMaxPerCall: 1,
  profileId: null,
};

export function toAgentSettings(row: AgentSettingsRow | null): AgentSettings {
  if (!row) return { ...AI_DEMO_AGENT_DEFAULTS };
  return {
    displayName: row.display_name,
    voice: row.voice,
    introStyle: row.intro_style,
    introCustom: row.intro_custom,
    standingRules: row.standing_rules,
    readsCallerCases: row.reads_caller_cases,
    requiresPlateCheck: row.requires_plate_check,
    createsDraftCases: row.creates_draft_cases,
    addsCaseNotes: row.adds_case_notes,
    smsEnabled: row.sms_enabled,
    smsMaxPerCall: row.sms_max_per_call,
    profileId: row.profile_id,
  };
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/**
 * Validates a patch.
 *
 * Every rejection names the field in Slovak, because the panel shows this text
 * to the person who typed it. Unknown keys are refused rather than ignored: a
 * typo that silently does nothing is worse than an error.
 */
export function validateAgentPatch(body: Record<string, unknown>): Partial<AgentSettings> {
  const known = new Set([
    "displayName", "voice", "introStyle", "introCustom", "standingRules",
    "readsCallerCases", "requiresPlateCheck", "createsDraftCases", "addsCaseNotes",
    "smsEnabled", "smsMaxPerCall",
  ]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) throw new AiDemoError(`Neznáme nastavenie: ${key}.`, 400, "unknown_field");
  }

  const patch: Partial<AgentSettings> = {};

  if (body.displayName !== undefined) {
    const name = trimmedOrNull(body.displayName);
    if (!name || name.length < AI_DEMO_NAME_MIN_CHARS || name.length > AI_DEMO_NAME_MAX_CHARS) {
      throw new AiDemoError(`Meno musí mať ${AI_DEMO_NAME_MIN_CHARS} až ${AI_DEMO_NAME_MAX_CHARS} znakov.`, 400, "name_length");
    }
    patch.displayName = name;
  }

  if (body.voice !== undefined) {
    if (typeof body.voice !== "string" || !AI_DEMO_ALLOWED_VOICES.includes(body.voice)) {
      throw new AiDemoError("Tento hlas nie je povolený.", 400, "voice_not_allowed");
    }
    patch.voice = body.voice;
  }

  if (body.introStyle !== undefined) {
    if (typeof body.introStyle !== "string" || !AI_DEMO_INTRO_STYLES.includes(body.introStyle as AiDemoIntroStyle)) {
      throw new AiDemoError("Neplatný spôsob predstavenia.", 400, "intro_style");
    }
    patch.introStyle = body.introStyle as AiDemoIntroStyle;
  }

  if (body.introCustom !== undefined) {
    const custom = trimmedOrNull(body.introCustom);
    if (custom && custom.length > AI_DEMO_INTRO_CUSTOM_MAX_CHARS) {
      throw new AiDemoError(`Vlastné predstavenie má najviac ${AI_DEMO_INTRO_CUSTOM_MAX_CHARS} znakov.`, 400, "intro_custom_length");
    }
    patch.introCustom = custom;
  }

  if (body.standingRules !== undefined) {
    const rules = trimmedOrNull(body.standingRules);
    if (rules && rules.length > AI_DEMO_STANDING_RULES_MAX_CHARS) {
      throw new AiDemoError(
        `Stále pravidlá majú najviac ${AI_DEMO_STANDING_RULES_MAX_CHARS} znakov — dlhší pokyn by ju spomalil a znel by ako čítaný manuál.`,
        400,
        "standing_rules_length",
      );
    }
    patch.standingRules = rules;
  }

  for (const key of ["readsCallerCases", "requiresPlateCheck", "createsDraftCases", "addsCaseNotes", "smsEnabled"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") throw new AiDemoError(`Nastavenie ${key} musí byť áno alebo nie.`, 400, "not_boolean");
      patch[key] = body[key] as boolean;
    }
  }

  if (body.smsMaxPerCall !== undefined) {
    const count = body.smsMaxPerCall;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 3) {
      throw new AiDemoError("Počet SMS na hovor musí byť 1 až 3.", 400, "sms_max_per_call");
    }
    patch.smsMaxPerCall = count;
  }

  // A custom introduction that is empty is not a custom introduction.
  const style = patch.introStyle;
  if (style === "custom" && patch.introCustom === null) {
    throw new AiDemoError("Pri vlastnom predstavení treba napísať, ako sa má predstaviť.", 400, "intro_custom_missing");
  }

  return patch;
}

const COLUMNS = "id, organization_id, profile_id, display_name, voice, intro_style, intro_custom, standing_rules, reads_caller_cases, requires_plate_check, creates_draft_cases, adds_case_notes, sms_enabled, sms_max_per_call, created_at, updated_at";

export async function readAgentSettings(deps: AiDemoDeps): Promise<AgentSettings> {
  const { data, error } = await deps.admin
    .from("motorist_ai_agent_settings")
    .select(COLUMNS)
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (error) throw new AiDemoError("Nastavenia sa nepodarilo načítať.", 500, "settings_read_failed");
  return toAgentSettings((data as AgentSettingsRow | null) ?? null);
}

const TO_COLUMN: Record<keyof AgentSettings, string> = {
  displayName: "display_name", voice: "voice", introStyle: "intro_style", introCustom: "intro_custom",
  standingRules: "standing_rules", readsCallerCases: "reads_caller_cases", requiresPlateCheck: "requires_plate_check",
  createsDraftCases: "creates_draft_cases", addsCaseNotes: "adds_case_notes", smsEnabled: "sms_enabled",
  smsMaxPerCall: "sms_max_per_call", profileId: "profile_id",
};

export async function writeAgentSettings(deps: AiDemoDeps, patch: Partial<AgentSettings>): Promise<AgentSettings> {
  const values: Record<string, unknown> = { organization_id: deps.organizationId };
  for (const [key, value] of Object.entries(patch)) values[TO_COLUMN[key as keyof AgentSettings]] = value;

  const { data, error } = await deps.admin
    .from("motorist_ai_agent_settings")
    .upsert(values, { onConflict: "organization_id" })
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new AiDemoError("Nastavenia sa nepodarilo uložiť.", 500, "settings_write_failed");
  return toAgentSettings((data as AgentSettingsRow | null) ?? null);
}
