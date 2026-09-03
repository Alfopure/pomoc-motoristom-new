/**
 * Pure model behind `TelephonySettingsPanel.tsx` (design §3, plan "Fáza 3").
 *
 * This is the organisation's telephony safety row: the two kill switches read
 * before every provider command, the destination allowlist that decides which
 * numbers may be dialled at all, the park limit and the daily leg soft cap.
 * Admin only — turning `liveCallsEnabled` on is the moment the system starts
 * spending real money and calling real people, so the panel states that in
 * words and the model provides the sentences.
 *
 * The allowlist is edited as free text ("SK, CZ, +43") because that is how the
 * column reads; parsing, de-duplication and the mirror of the server validation
 * live here.
 */

import { COUNTRY_DIAL_PREFIXES, isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import type { RingGroupDoc, RingPlanDoc, TelephonySettingsDoc, TelephonySettingsPatchInput, ValidationIssue } from "@/server/telephony/config-service";

/**
 * Mirrors the bounds of `validateSettingsPatch`. They are re-declared instead of
 * imported because `config-service.ts` pulls in `node:crypto` and the Supabase
 * client, which must never reach the browser bundle; `settings-bounds.test.ts`
 * keeps the two copies equal.
 */
export const MAX_PARK_MINUTES = 240;
export const MAX_RING_FANOUT_LIMIT = 20;
export const MAX_CONCURRENT_LEGS_LIMIT = 50;
export const MAX_DAILY_LEG_SOFT_CAP = 100_000;
export const MAX_ALLOWLIST_ENTRIES = 100;
/** One concurrent leg is always the caller's own, so a fan-out needs at least one more. */
export const MIN_CONCURRENT_LEGS = 2;

export type SettingsDraft = {
  liveCallsEnabled: boolean;
  smsLiveSends: boolean;
  /** Numeric fields stay strings while the admin types. */
  dailyLegSoftCap: string;
  parkMaxMinutes: string;
  maxRingFanout: string;
  maxConcurrentLegs: string;
  /** Free text, comma or whitespace separated: `SK, CZ, +43`. */
  destinationAllowlist: string;
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export function settingsDraftFromDocument(settings: TelephonySettingsDoc): SettingsDraft {
  return {
    liveCallsEnabled: settings.liveCallsEnabled,
    smsLiveSends: settings.smsLiveSends,
    dailyLegSoftCap: String(settings.dailyLegSoftCap),
    parkMaxMinutes: String(settings.parkMaxMinutes),
    maxRingFanout: String(settings.maxRingFanout),
    maxConcurrentLegs: String(settings.maxConcurrentLegs),
    destinationAllowlist: settings.destinationAllowlist.join(", "),
  };
}

export function updateSettingsDraft(draft: SettingsDraft, patch: Partial<SettingsDraft>): SettingsDraft {
  return { ...draft, ...patch };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `NaN` for anything that is not a whole number, so the validator can name it. */
export function parseCount(value: string): number {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
}

/** Splits on commas, semicolons and whitespace; uppercases country codes, keeps `+` prefixes and `*`. */
export function parseAllowlist(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const entry = trimmed.startsWith("+") || trimmed === "*" ? trimmed : trimmed.toUpperCase();
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function settingsPayload(draft: SettingsDraft): TelephonySettingsPatchInput {
  return {
    liveCallsEnabled: draft.liveCallsEnabled,
    smsLiveSends: draft.smsLiveSends,
    dailyLegSoftCap: parseCount(draft.dailyLegSoftCap),
    parkMaxMinutes: parseCount(draft.parkMaxMinutes),
    maxRingFanout: parseCount(draft.maxRingFanout),
    maxConcurrentLegs: parseCount(draft.maxConcurrentLegs),
    destinationAllowlist: parseAllowlist(draft.destinationAllowlist),
  };
}

export function settingsDirty(draft: SettingsDraft, original: TelephonySettingsDoc): boolean {
  return JSON.stringify(settingsPayload(draft)) !== JSON.stringify(settingsPayload(settingsDraftFromDocument(original)));
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/** Local mirror of `validateSettingsPatch`; paths are the draft field names. */
export function validateSettingsDraft(draft: SettingsDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const dailyLegSoftCap = parseCount(draft.dailyLegSoftCap);
  if (!Number.isInteger(dailyLegSoftCap) || dailyLegSoftCap <= 0 || dailyLegSoftCap > MAX_DAILY_LEG_SOFT_CAP) {
    issues.push(issue("dailyLegSoftCap", "cap_invalid", `Denný limit hovorov musí byť 1 až ${MAX_DAILY_LEG_SOFT_CAP}.`));
  }

  const parkMaxMinutes = parseCount(draft.parkMaxMinutes);
  if (!Number.isInteger(parkMaxMinutes) || parkMaxMinutes < 1 || parkMaxMinutes > MAX_PARK_MINUTES) {
    issues.push(issue("parkMaxMinutes", "park_invalid", `Maximálny čas v čakárni musí byť 1 až ${MAX_PARK_MINUTES} minút.`));
  }

  const maxRingFanout = parseCount(draft.maxRingFanout);
  if (!Number.isInteger(maxRingFanout) || maxRingFanout < 1 || maxRingFanout > MAX_RING_FANOUT_LIMIT) {
    issues.push(issue("maxRingFanout", "fanout_invalid", `Počet súčasne zvoniacich zariadení musí byť 1 až ${MAX_RING_FANOUT_LIMIT}.`));
  }

  // The organisation-wide leg count includes the caller's own leg, so
  // `planRingStep` gets `maxConcurrentLegs - 1` free slots: at 1 nobody's phone
  // can ever ring, and below `maxRingFanout + 1` the fan-out is cut down by the
  // capacity guard instead of by the intended limit.
  const maxConcurrentLegs = parseCount(draft.maxConcurrentLegs);
  if (!Number.isInteger(maxConcurrentLegs) || maxConcurrentLegs < MIN_CONCURRENT_LEGS || maxConcurrentLegs > MAX_CONCURRENT_LEGS_LIMIT) {
    issues.push(
      issue("maxConcurrentLegs", "legs_invalid", `Počet súčasných liniek musí byť ${MIN_CONCURRENT_LEGS} až ${MAX_CONCURRENT_LEGS_LIMIT} — jedna linka vždy patrí volajúcemu.`),
    );
  } else if (Number.isInteger(maxRingFanout) && maxConcurrentLegs < maxRingFanout + 1) {
    issues.push(
      issue(
        "maxConcurrentLegs",
        "legs_below_fanout",
        `Počet súčasných liniek musí byť aspoň o jednu vyšší ako počet súčasne zvoniacich zariadení (teraz aspoň ${maxRingFanout + 1}) — jedna linka patrí volajúcemu.`,
      ),
    );
  }

  const allowlist = parseAllowlist(draft.destinationAllowlist);
  if (allowlist.length === 0) {
    issues.push(issue("destinationAllowlist", "allowlist_empty", "Zoznam povolených cieľov nesmie byť prázdny — volanie by sa nedalo uskutočniť."));
  }
  if (allowlist.length > MAX_ALLOWLIST_ENTRIES) {
    issues.push(issue("destinationAllowlist", "allowlist_too_long", `Zoznam povolených cieľov môže mať najviac ${MAX_ALLOWLIST_ENTRIES} položiek.`));
  }
  for (const entry of allowlist) {
    const known = entry === "*" || /^\+\d{1,4}$/.test(entry) || Boolean(COUNTRY_DIAL_PREFIXES[entry.toUpperCase()]);
    if (!known) issues.push(issue("destinationAllowlist", "allowlist_entry_invalid", `„${entry}" nie je kód krajiny (napr. SK) ani predvoľba (napr. +421).`));
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Wording (the panel only renders these)
// ---------------------------------------------------------------------------

export type SettingsWarning = { tone: "warning" | "error" | "info"; text: string };

/**
 * The routing rows the warnings have to cross-check: numbers already stored in
 * the configuration against the allowlist, and group sizes against the fan-out
 * cap.
 */
export type SettingsWarningContext = {
  groups: readonly RingGroupDoc[];
  plans: readonly RingPlanDoc[];
};

/**
 * Numbers stored in the configuration that the drafted allowlist would reject.
 *
 * Mirrors `destinationsOutsideAllowlist` on the server, which refuses the save
 * (409 `destination_in_use`): neither `planRingStep` nor `applyFallback` checks
 * the allowlist, so such a number would keep being dialled — and billed — while
 * the admin believed the opposite.
 */
export function storedDestinationsOutside(allowlist: readonly string[], context: SettingsWarningContext): string[] {
  const offenders: string[] = [];
  for (const group of context.groups) {
    for (const member of group.members) {
      if (member.memberKind !== "external_number") continue;
      const normalized = normalizeE164(member.externalNumber);
      if (normalized && !isDestinationAllowed(normalized, allowlist)) offenders.push(`${normalized} (skupina „${group.name}")`);
    }
  }
  for (const plan of context.plans) {
    if (plan.fallbackKind !== "external_number") continue;
    const normalized = normalizeE164(plan.fallbackNumber);
    if (normalized && !isDestinationAllowed(normalized, allowlist)) offenders.push(`${normalized} (plán „${plan.name}")`);
  }
  return offenders;
}

/** Groups an `all` step would truncate under the drafted fan-out cap. */
export function groupsOverFanout(maxRingFanout: number, context: SettingsWarningContext): Array<{ name: string; members: number }> {
  const groupsById = new Map(context.groups.map((group) => [group.id, group]));
  const over = new Map<string, { name: string; members: number }>();
  for (const plan of context.plans) {
    for (const step of plan.steps) {
      if (step.strategy !== "all") continue;
      const group = groupsById.get(step.ringGroupId);
      if (!group || group.members.length <= maxRingFanout) continue;
      over.set(group.id, { name: group.name, members: group.members.length });
    }
  }
  return [...over.values()];
}

/**
 * What is about to change, in words. Switching a kill switch **on** is the
 * dangerous direction: from that moment the system dials real numbers and sends
 * real SMS, and it must not be possible to do it by accident.
 */
export function settingsWarnings(draft: SettingsDraft, original: TelephonySettingsDoc, context: SettingsWarningContext = { groups: [], plans: [] }): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];

  if (draft.liveCallsEnabled && !original.liveCallsEnabled) {
    warnings.push({ tone: "error", text: "Zapínaš ostré hovory. Systém začne po uložení volať na skutočné čísla a hovory sa účtujú." });
  }
  if (!draft.liveCallsEnabled && original.liveCallsEnabled) {
    // `assertCallsAllowed` gates only `dial` and `transfer`; `answer` is
    // deliberately not gated, so an inbound caller is still answered.
    warnings.push({
      tone: "warning",
      text:
        "Vypínaš ostré hovory. Odchádzajúce hovory a prepojenia sa odmietnu (423), prebiehajúce hovory dobehnú. Prichádzajúce hovory sa ale naďalej prijmú a účtujú — nikomu nezazvonia, volajúci skončí na správaní po vyčerpaní plánu (spravidla ponuka spätného volania). Ak má prestať aj príjem, číslo treba odpojiť u operátora.",
    });
  }
  if (draft.smsLiveSends && !original.smsLiveSends) {
    warnings.push({ tone: "error", text: "Zapínaš ostré SMS. Správy pôjdu skutočným príjemcom a účtujú sa." });
  }
  if (!draft.smsLiveSends && original.smsLiveSends) {
    warnings.push({ tone: "warning", text: "Vypínaš ostré SMS. Nové odoslania sa zastavia." });
  }

  const next = parseAllowlist(draft.destinationAllowlist);
  const removed = parseAllowlist(original.destinationAllowlist.join(",")).filter((entry) => !next.includes(entry));
  if (removed.length > 0) {
    // Honest wording: the allowlist gates the operator's own dialling
    // (`normalizeDestination` in call-actions) and SMS, not the ring engine.
    warnings.push({
      tone: "warning",
      text: `Odoberáš z povolených cieľov: ${removed.join(", ")}. Operátor už na takéto číslo nezavolá ani ho nepridá do skupiny zvonenia; číslo, ktoré v konfigurácii ostane, by sa ale vytáčalo ďalej.`,
    });
  }
  const stranded = storedDestinationsOutside(next, context);
  if (stranded.length > 0) {
    warnings.push({
      tone: "error",
      text: `Tieto čísla sú stále v konfigurácii a nový zoznam ich nepokrýva: ${stranded.join(", ")}. Uloženie server odmietne — najprv ich odstráň zo skupiny alebo z plánu.`,
    });
  }
  if (next.includes("*")) {
    warnings.push({ tone: "warning", text: "Hviezdička povoľuje volanie do celého sveta vrátane drahých destinácií. Radšej vymenuj krajiny." });
  }

  // `assertLegBudget` throws 429 on every operator-initiated leg once the cap is
  // reached — it is not a monitoring threshold, so lowering it has to be said
  // out loud.
  const cap = parseCount(draft.dailyLegSoftCap);
  if (Number.isInteger(cap) && cap < original.dailyLegSoftCap) {
    warnings.push({
      tone: "warning",
      text: `Znižuješ denný limit hovorov z ${original.dailyLegSoftCap} na ${cap}. Po jeho vyčerpaní systém odmietne (429) každé odchádzajúce volanie, prepojenie aj spätné volanie až do polnoci (Europe/Bratislava). Prichádzajúcich volajúcich limit neodmieta.`,
    });
  }

  const fanout = parseCount(draft.maxRingFanout);
  if (Number.isInteger(fanout) && fanout > 0) {
    const truncated = groupsOverFanout(fanout, context);
    if (truncated.length > 0) {
      warnings.push({
        tone: "warning",
        text: `Pri limite ${fanout} sa v krokoch „všetkým naraz" nedostane na všetkých členov skupín: ${truncated
          .map((group) => `${group.name} (${group.members})`)
          .join(", ")}.`,
      });
    }
  }

  return warnings;
}

/**
 * The DB switch is only half of the gate: `resolveTelnyxLiveGate` ANDs it with
 * the environment variable, so an admin who flips it on and sees nothing happen
 * needs to know where to look.
 */
export const ENV_GATE_NOTE =
  "Prepínač v databáze platí spolu s premennou prostredia TELNYX_LIVE_CALLS_ENABLED (pre SMS TELNYX_SMS_LIVE_SENDS). Ak je premenná vypnutá, hovory ani SMS nepôjdu von ani po zapnutí tohto prepínača.";

/** Sentence describing the current state of both kill switches. */
export function describeKillSwitches(draft: SettingsDraft): string {
  if (draft.liveCallsEnabled && draft.smsLiveSends) return "Hovory aj SMS sú ostré.";
  if (draft.liveCallsEnabled) return "Hovory sú ostré, SMS sa neodosielajú.";
  if (draft.smsLiveSends) return "SMS sú ostré, hovory sa neuskutočňujú.";
  return "Hovory ani SMS sa neodosielajú — systém je v bezpečnom režime.";
}

/** Human list of the allowlist entries, with the dial prefix behind each country. */
export function describeAllowlist(draft: SettingsDraft): string {
  const entries = parseAllowlist(draft.destinationAllowlist);
  if (entries.length === 0) return "Žiadny povolený cieľ.";
  return entries
    .map((entry) => {
      if (entry === "*") return "všetky krajiny";
      if (entry.startsWith("+")) return entry;
      const prefix = COUNTRY_DIAL_PREFIXES[entry];
      return prefix ? `${entry} (${prefix})` : entry;
    })
    .join(", ");
}
