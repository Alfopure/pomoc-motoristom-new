"use client";

import { useMemo, useState } from "react";
import { KeyRound, Loader2, PhoneOff, Save, Users } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import {
  ConfigRequestError,
  disconnectOperatorDevice,
  loadRoutingConfig,
  rotateOperatorCredential,
  saveOperatorSettings,
  type RoutingConfigResponse,
} from "./config-client";
import {
  AUTO_ANSWER_PENDING_NOTE,
  ROLE_LABELS,
  activeLines,
  confirmDisconnectDevice,
  confirmRotateCredential,
  describeCallHandling,
  describeDevice,
  describeLineOption,
  describeOutboundLine,
  findOperator,
  operatorDirty,
  operatorDraftsFromDocument,
  operatorPatch,
  updateOperator,
  validateOperatorDraft,
  type OperatorDraft,
  type OperatorValidationContext,
} from "./operators-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass, useMinuteClock } from "./settings-ui";

/**
 * Operators screen (plan "Fáza 3"), manager and admin only.
 *
 * Per operator: which line their outbound calls leave from, how long their
 * wrap-up lasts, whether their phone answers its own outbound leg, and the
 * state of their browser phone with the two device actions — regenerate the SIP
 * credential and disconnect the phone. Neither action touches a call in
 * progress; they revoke the device session only.
 *
 * Operators themselves are created in "Používatelia"; nothing here adds or
 * removes one.
 */
const DEVICE_TONE_CLASS = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-950",
  off: "border-zinc-200 bg-zinc-100 text-zinc-700",
} as const;

export function OperatorsTelephonyPanel({
  canEdit,
  document,
  onSaved,
}: {
  canEdit: boolean;
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [drafts, setDrafts] = useState<OperatorDraft[]>(() => operatorDraftsFromDocument(document.operators));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  // Device freshness is a clock question ("last seen 4 min ago"), so the rows
  // re-render on the shared minute tick instead of on every keystroke. Until the
  // store has a client clock (server pass and hydration) the device verdict is
  // withheld rather than computed against epoch zero.
  const clock = useMinuteClock();

  const context = useMemo<OperatorValidationContext>(() => ({ lines: document.lines }), [document.lines]);
  const lineOptions = useMemo(() => activeLines(document.lines), [document.lines]);

  function begin(profileId: string) {
    setBusyId(profileId);
    setError(null);
    setNotice(null);
    setServerIssues([]);
  }

  function fail(caught: unknown, fallback: string) {
    setError(caught instanceof Error ? caught.message : fallback);
    if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
  }

  /** The device routes answer with the device only, so the document is re-read. */
  async function reloadDocument() {
    const response = await loadRoutingConfig("ringGroups");
    onSaved(response);
  }

  async function saveOperator(draft: OperatorDraft) {
    const original = findOperator(document.operators, draft.profileId);
    if (!canEdit || busyId || !original) return;
    const patch = operatorPatch(draft, original);
    if (Object.keys(patch).length === 0) return;

    begin(draft.profileId);
    try {
      await saveOperatorSettings(draft.profileId, patch as Record<string, unknown>);
      await reloadDocument();
      setNotice(`Nastavenia operátora ${draft.displayName} sú uložené. Prebiehajúce hovory sa nemenia.`);
    } catch (caught) {
      fail(caught, "Nastavenia operátora sa nepodarilo uložiť.");
    } finally {
      setBusyId(null);
    }
  }

  async function rotateCredential(draft: OperatorDraft) {
    if (!canEdit || busyId) return;
    if (typeof window !== "undefined" && !window.confirm(confirmRotateCredential(draft.displayName))) return;

    begin(draft.profileId);
    try {
      await rotateOperatorCredential(draft.profileId);
      await reloadDocument();
      setNotice(`Operátor ${draft.displayName} má nové prihlasovacie údaje. Telefón sa musí znova prihlásiť.`);
    } catch (caught) {
      fail(caught, "Prihlasovacie údaje telefónu sa nepodarilo vytvoriť.");
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(draft: OperatorDraft) {
    if (!canEdit || busyId) return;
    if (typeof window !== "undefined" && !window.confirm(confirmDisconnectDevice(draft.displayName))) return;

    begin(draft.profileId);
    try {
      await disconnectOperatorDevice(draft.profileId);
      await reloadDocument();
      setNotice(`Telefón operátora ${draft.displayName} je odpojený.`);
    } catch (caught) {
      fail(caught, "Telefón sa nepodarilo odpojiť.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="operators-telephony-heading">
      <SettingsSectionHeader icon={Users} title="Operátori a ich telefóny" description="Z ktorej linky volajú, ako dlho majú po hovore a v akom stave je ich telefón." />

      <div className="grid gap-4 p-4">
        <h3 id="operators-telephony-heading" className="sr-only">
          Operátori a ich telefóny
        </h3>

        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        <SettingsNotice tone="info">
          {"Operátorov pridáva a odoberá sekcia „Používatelia\". Tu sa nastavuje len telefonovanie. Odpojenie telefónu ani nové prihlasovacie údaje neukončia prebiehajúci hovor."}
        </SettingsNotice>
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {serverIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={serverIssues} />
          </div>
        )}

        {drafts.length === 0 && <SettingsNotice tone="warning">V organizácii nie je žiadny aktívny operátor.</SettingsNotice>}

        {drafts.map((draft) => {
          const original = findOperator(document.operators, draft.profileId);
          const device = original && clock ? describeDevice(original, clock) : null;
          const issues = validateOperatorDraft(draft, context);
          const dirty = original ? operatorDirty(draft, original) : false;
          const busy = busyId === draft.profileId;

          return (
            <div key={draft.profileId} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-zinc-950">
                  {draft.displayName} <span className="font-normal text-zinc-500">· {ROLE_LABELS[draft.role]}</span>
                </span>
                {device && (
                  <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${DEVICE_TONE_CLASS[device.tone]}`}>{device.label}</span>
                )}
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <SettingsField label="Odchádzajúca linka" hint="Číslo, ktoré uvidí volaný.">
                  <select
                    className={settingsInputClass}
                    disabled={!canEdit || busy}
                    value={draft.defaultFromLineId ?? ""}
                    onChange={(event) => setDrafts((current) => updateOperator(current, draft.profileId, { defaultFromLineId: event.target.value || null }))}
                  >
                    <option value="">— systémové číslo organizácie —</option>
                    {lineOptions.map((line) => (
                      <option key={line.id} value={line.id}>
                        {describeLineOption(line)}
                      </option>
                    ))}
                  </select>
                </SettingsField>

                <SettingsField label="Čas po hovore (s)" hint="Koľko sekúnd po zložení mu nezazvoní ďalší hovor.">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit || busy}
                    type="number"
                    min={0}
                    max={600}
                    step={5}
                    value={draft.wrapUpSeconds}
                    onChange={(event) => setDrafts((current) => updateOperator(current, draft.profileId, { wrapUpSeconds: Number(event.target.value) }))}
                  />
                </SettingsField>

                <SettingsField label="Hlasitosť zvonenia (%)" hint="Predvolená hlasitosť zvonenia v prehliadači.">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit || busy}
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={draft.ringDeviceVolume}
                    onChange={(event) => setDrafts((current) => updateOperator(current, draft.profileId, { ringDeviceVolume: Number(event.target.value) }))}
                  />
                </SettingsField>

                <div className="flex items-end">
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#FCD703]"
                      disabled={!canEdit || busy}
                      checked={draft.autoAnswerOutbound}
                      onChange={(event) => setDrafts((current) => updateOperator(current, draft.profileId, { autoAnswerOutbound: event.target.checked }))}
                    />
                    Telefón sám prijme vlastnú vetvu odchádzajúceho hovoru
                  </label>
                </div>
              </div>

              <p className="mt-2 text-xs text-zinc-600">{describeOutboundLine(draft, document.lines)}</p>
              <p className="mt-1 text-xs text-zinc-600">{describeCallHandling(draft)}</p>
              <p className="mt-1 text-xs text-zinc-500">{AUTO_ANSWER_PENDING_NOTE}</p>
              {device && <p className="mt-1 text-xs text-zinc-600">{device.detail}</p>}
              <SettingsIssueList issues={issues} />

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canEdit || busy || !dirty || issues.length > 0}
                  onClick={() => void saveOperator(draft)}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
                >
                  {busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
                  Uložiť operátora
                </button>

                <button
                  type="button"
                  disabled={!canEdit || busy}
                  onClick={() => void rotateCredential(draft)}
                  title="Vytvorí nový SIP účet operátora a odhlási jeho telefón."
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                >
                  <KeyRound size={15} aria-hidden="true" />
                  Nové prihlasovacie údaje
                </button>

                <button
                  type="button"
                  disabled={!canEdit || busy || !device?.provisioned}
                  onClick={() => void disconnect(draft)}
                  title={device?.provisioned ? "Zruší registráciu telefónu operátora." : "Operátor nemá zaregistrovaný telefón."}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400"
                >
                  <PhoneOff size={15} aria-hidden="true" />
                  Odpojiť telefón
                </button>

                {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
