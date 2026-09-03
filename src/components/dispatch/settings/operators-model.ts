/**
 * Pure model behind `OperatorsTelephonyPanel.tsx` (design §3, plan "Fáza 3").
 *
 * Per operator the panel owns three things: the telephony settings row
 * (`motorist_operator_telephony_settings`), the state of the browser phone
 * (`motorist_operator_devices`) and the two device actions — regenerate the
 * SIP credential and disconnect the phone.
 *
 * The settings route takes one `profileId` and a patch of the fields that
 * actually changed, so the payload builder here is a diff: an untouched column
 * is never rewritten and never lands in the audit row. The device verdict uses
 * the same `isDeviceLive` rule as the router, so the panel cannot claim a phone
 * is connected while the ring plan is already stepping over it.
 */

import type { AppRole } from "@/domain/types";
import { DEVICE_LIVENESS_WINDOW_MS, isDeviceLive } from "@/lib/telephony/device-liveness";
import { DEFAULT_OPERATOR_SETTINGS, MAX_RING_DEVICE_VOLUME, MAX_WRAP_UP_SECONDS } from "@/lib/telephony/operator-settings";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { LineDoc, OperatorDoc, OperatorSettingsPatchInput, ValidationIssue } from "@/server/telephony/config-service";

export const ROLE_LABELS: Record<AppRole, string> = {
  dispatcher: "Dispečer",
  senior_dispatcher: "Senior dispečer",
  manager: "Manažér",
  admin: "Admin",
};

export type OperatorDraft = {
  /** The profile id doubles as the React key; operators are created elsewhere. */
  profileId: string;
  displayName: string;
  role: AppRole;
  defaultFromLineId: string | null;
  wrapUpSeconds: number;
  autoAnswerOutbound: boolean;
  ringDeviceVolume: number;
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

/** An operator with no settings row yet is drafted from the server defaults. */
export function operatorDraft(operator: OperatorDoc): OperatorDraft {
  const settings = operator.settings ?? DEFAULT_OPERATOR_SETTINGS;
  return {
    profileId: operator.profileId,
    displayName: operator.displayName,
    role: operator.role,
    defaultFromLineId: settings.defaultFromLineId,
    wrapUpSeconds: settings.wrapUpSeconds,
    autoAnswerOutbound: settings.autoAnswerOutbound,
    ringDeviceVolume: settings.ringDeviceVolume,
  };
}

export function operatorDraftsFromDocument(operators: readonly OperatorDoc[]): OperatorDraft[] {
  return [...operators]
    .sort((left, right) => left.displayName.localeCompare(right.displayName, "sk"))
    .map(operatorDraft);
}

export function updateOperator(
  drafts: readonly OperatorDraft[],
  profileId: string,
  patch: Partial<Omit<OperatorDraft, "profileId" | "displayName" | "role">>,
): OperatorDraft[] {
  return drafts.map((draft) => (draft.profileId === profileId ? { ...draft, ...patch } : draft));
}

export function findOperator(operators: readonly OperatorDoc[], profileId: string): OperatorDoc | null {
  return operators.find((operator) => operator.profileId === profileId) ?? null;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Only the fields that differ from the stored row; `{}` means "nothing to save".
 *
 * An operator without a settings row is compared against the defaults the
 * server would have used anyway, so opening the panel and pressing nothing
 * writes nothing.
 */
export function operatorPatch(draft: OperatorDraft, original: OperatorDoc): OperatorSettingsPatchInput {
  const current = original.settings ?? DEFAULT_OPERATOR_SETTINGS;
  const patch: OperatorSettingsPatchInput = {};
  if (draft.defaultFromLineId !== current.defaultFromLineId) patch.defaultFromLineId = draft.defaultFromLineId;
  if (draft.wrapUpSeconds !== current.wrapUpSeconds) patch.wrapUpSeconds = draft.wrapUpSeconds;
  if (draft.autoAnswerOutbound !== current.autoAnswerOutbound) patch.autoAnswerOutbound = draft.autoAnswerOutbound;
  if (draft.ringDeviceVolume !== current.ringDeviceVolume) patch.ringDeviceVolume = draft.ringDeviceVolume;
  return patch;
}

export function operatorDirty(draft: OperatorDraft, original: OperatorDoc): boolean {
  return Object.keys(operatorPatch(draft, original)).length > 0;
}

export function dirtyOperatorIds(drafts: readonly OperatorDraft[], operators: readonly OperatorDoc[]): string[] {
  return drafts
    .filter((draft) => {
      const original = findOperator(operators, draft.profileId);
      return original ? operatorDirty(draft, original) : false;
    })
    .map((draft) => draft.profileId);
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export type OperatorValidationContext = { lines: readonly LineDoc[] };

/** Local mirror of `validateOperatorSettingsPatch`; the path is the profile id. */
export function validateOperatorDraft(draft: OperatorDraft, context: OperatorValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Number.isInteger(draft.wrapUpSeconds) || draft.wrapUpSeconds < 0 || draft.wrapUpSeconds > MAX_WRAP_UP_SECONDS) {
    issues.push(issue(draft.profileId, "wrap_up_invalid", `Čas po hovore musí byť 0 až ${MAX_WRAP_UP_SECONDS} sekúnd.`));
  }
  if (!Number.isInteger(draft.ringDeviceVolume) || draft.ringDeviceVolume < 0 || draft.ringDeviceVolume > MAX_RING_DEVICE_VOLUME) {
    issues.push(issue(draft.profileId, "volume_invalid", "Hlasitosť zvonenia musí byť 0 až 100."));
  }
  if (draft.defaultFromLineId && !context.lines.some((line) => line.id === draft.defaultFromLineId)) {
    issues.push(issue(draft.profileId, "line_foreign", "Linka nepatrí do tejto organizácie."));
  }
  return issues;
}

export function validateOperatorDrafts(drafts: readonly OperatorDraft[], context: OperatorValidationContext): ValidationIssue[] {
  return drafts.flatMap((draft) => validateOperatorDraft(draft, context));
}

// ---------------------------------------------------------------------------
// Device state
// ---------------------------------------------------------------------------

export type DeviceTone = "ok" | "warn" | "off";

export type DeviceView = {
  tone: DeviceTone;
  /** Short state, e.g. "Pripojený". */
  label: string;
  /** One sentence with the detail: last heartbeat, SIP account, environment. */
  detail: string;
  /** True while the device row exists and its heartbeat is fresh. */
  live: boolean;
  /** A credential exists, so "disconnect" has something to revoke. */
  provisioned: boolean;
};

const REGISTRATION_LABELS: Record<string, string> = {
  registered: "Pripojený",
  registering: "Pripája sa",
  unregistered: "Odpojený",
  error: "Chyba registrácie",
};

/** "pred 12 s" / "pred 4 min" / "pred 3 h" / a date past a day. */
export function describeSeenAt(seenAt: string | null | undefined, now: Date): string {
  if (!seenAt) return "nikdy";
  const parsed = Date.parse(seenAt);
  if (Number.isNaN(parsed)) return "nikdy";
  const seconds = Math.max(0, Math.round((now.getTime() - parsed) / 1_000));
  if (seconds < 60) return `pred ${seconds} s`;
  if (seconds < 3_600) return `pred ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `pred ${Math.floor(seconds / 3_600)} h`;
  return new Date(parsed).toLocaleString("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * What the manager sees next to the operator's name.
 *
 * `live` is the router's own verdict (`isDeviceLive`): a phone that says
 * "registered" but stopped sending heartbeats more than
 * `DEVICE_LIVENESS_WINDOW_MS` ago is skipped when a call rings, so the panel
 * shows it as stale rather than connected.
 */
export function describeDevice(operator: OperatorDoc, now: Date): DeviceView {
  const device = operator.device;
  if (!device) {
    return {
      tone: "off",
      label: "Bez telefónu",
      detail: "Operátor si telefón v prehliadači ešte nikdy nezapol. Prihlasovacie údaje vzniknú samy pri prvom prihlásení.",
      live: false,
      provisioned: false,
    };
  }

  const live = isDeviceLive({ deviceSeenAt: device.deviceSeenAt, registrationState: device.registrationState }, now);
  const seen = describeSeenAt(device.deviceSeenAt, now);
  const account = device.sipUsername ? `SIP účet ${device.sipUsername}` : "SIP účet zatiaľ nie je vytvorený";
  const environment = device.environment === "production" ? "produkcia" : "test / vývoj";
  const stateLabel = REGISTRATION_LABELS[device.registrationState] ?? device.registrationState;

  if (live) {
    return {
      tone: "ok",
      label: stateLabel,
      detail: `Naposledy sa ozval ${seen} · ${account} · ${environment}.`,
      live: true,
      provisioned: Boolean(device.credentialId),
    };
  }

  const stale = device.registrationState === "registered";
  return {
    tone: stale ? "warn" : "off",
    label: stale ? "Neozýva sa" : stateLabel,
    detail: stale
      ? `Telefón sa hlási ako pripojený, ale heartbeat neprišiel viac ako ${Math.round(DEVICE_LIVENESS_WINDOW_MS / 1_000)} s (naposledy ${seen}), takže mu hovor nezazvoní. ${account} · ${environment}.`
      : `Naposledy sa ozval ${seen} · ${account} · ${environment}.`,
    live: false,
    provisioned: Boolean(device.credentialId),
  };
}

// ---------------------------------------------------------------------------
// Outbound line
// ---------------------------------------------------------------------------

export function activeLines(lines: readonly LineDoc[]): LineDoc[] {
  return lines.filter((line) => line.active);
}

export function findLine(lines: readonly LineDoc[], lineId: string | null): LineDoc | null {
  if (!lineId) return null;
  return lines.find((line) => line.id === lineId) ?? null;
}

export function describeLineOption(line: LineDoc): string {
  const label = line.label.trim() || "bez štítku";
  return `${label} · ${formatPhoneNumberForDisplay(line.phoneNumber)}${line.active ? "" : " (vypnutá)"}`;
}

/**
 * What the customer will see when this operator dials out.
 *
 * Mirrors `resolveFromLine` in `call-actions.ts`: with no default line the call
 * leaves from `TELNYX_DEFAULT_FROM_NUMBER`, and an inactive line is ignored
 * (the query filters on `active`), which silently falls back to the same
 * number — worth saying out loud.
 */
export function describeOutboundLine(draft: OperatorDraft, lines: readonly LineDoc[]): string {
  const line = findLine(lines, draft.defaultFromLineId);
  if (!line) return "Bez vlastnej linky: hovor odíde zo systémového čísla organizácie.";
  if (!line.active) {
    return `Linka „${line.label}" je vypnutá, takže hovor aj tak odíde zo systémového čísla organizácie.`;
  }
  return `Volanému sa zobrazí ${formatPhoneNumberForDisplay(line.phoneNumber)} (${line.label}).`;
}

/** One sentence about wrap-up and auto-answer, shown under the two fields. */
export function describeCallHandling(draft: OperatorDraft): string {
  const wrap =
    draft.wrapUpSeconds === 0
      ? "Po zložení je operátor hneď zase dostupný"
      : `Po zložení má ${draft.wrapUpSeconds} s na dopísanie, počas nich mu nezazvoní ďalší hovor`;
  const answer = draft.autoAnswerOutbound
    ? "pri odchádzajúcom hovore sa jeho telefón ohlási sám"
    : "pri odchádzajúcom hovore si má vlastnú vetvu prijať sám";
  return `${wrap}; ${answer}.`;
}

/**
 * Honest note under the auto-answer switch.
 *
 * The column is stored and audited, but the browser phone still answers every
 * leg the operator's own tab asked for (`autoAnswerCurrentCall` in
 * `telnyx-webphone.ts`), so switching it off changes nothing yet. Saying so
 * beats a switch that quietly does nothing.
 */
export const AUTO_ANSWER_PENDING_NOTE =
  "Prehliadačový telefón dnes vlastnú vetvu odchádzajúceho hovoru prijíma vždy automaticky. Voľba sa uloží do profilu operátora, ale zatiaľ hovor neovplyvní.";

/**
 * The same honesty for the ring volume: the column is stored and audited, but
 * `BrowserIncomingRingtone` plays at its own module constant and
 * `telnyx-webphone.ts` never touches gain, so nothing reads
 * `ring_device_volume` yet.
 */
export const RING_VOLUME_PENDING_NOTE =
  "Hlasitosť sa uloží do profilu operátora, ale prehliadačový telefón ju zatiaľ nepoužíva — zvonenie hrá vždy rovnako nahlas.";

// ---------------------------------------------------------------------------
// Device actions
// ---------------------------------------------------------------------------

/**
 * Both device actions are destructive for the operator's browser tab, so the
 * confirmation says exactly what happens: the revoked `device_session_id` makes
 * the tab's next heartbeat fail, the tab disconnects its WebRTC client and a
 * call in progress goes down with it. The server refuses outright while the
 * operator is `on_call`/`ringing` (409 `operator_on_call`) unless the manager
 * confirms the takeover — `confirmTakeover` is that second question.
 *
 * Both also delete a SIP identity at Telnyx (the superseded one on rotate, the
 * current one on disconnect), which is what makes the revocation real rather
 * than cooperative — an already minted token stays valid for up to 24 h. The
 * texts say so, because "odpojiť" that leaves a registerable credential behind
 * would be exactly the wrong thing to promise while offboarding somebody.
 */
export function confirmRotateCredential(displayName: string): string {
  return `Vygenerovať nové prihlasovacie údaje pre operátora ${displayName}?\n\nJeho telefón v prehliadači sa odhlási a musí sa znova prihlásiť. Pôvodné prihlasovacie údaje sa zrušia aj u operátora (Telnyx), takže sa s nimi už nikto nezaregistruje. Ak práve telefonuje, hovor sa preruší.`;
}

export function confirmDisconnectDevice(displayName: string): string {
  return `Odpojiť telefón operátora ${displayName}?\n\nJeho okno stratí registráciu pri najbližšom heartbeate a hovor mu prestane zvoniť. Prihlasovacie údaje sa zrušia aj u operátora (Telnyx), takže sa s nimi už nedá volať; nové sa vytvoria až pri ďalšom prihlásení. Ak práve telefonuje, hovor sa preruší.`;
}

/** Second question, asked only after the server answered 409 `operator_on_call`. */
export function confirmTakeover(displayName: string, message: string): string {
  return `${message}\n\nOperátor: ${displayName}. Naozaj pokračovať a ukončiť mu prebiehajúci hovor?`;
}
