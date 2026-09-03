"use client";

import { useMemo, useState } from "react";
import { Coffee, Loader2, Plus, Save, Trash2 } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import {
  MAX_PAUSE_MINUTES,
  addPauseReason,
  codeFromLabel,
  describePauseReason,
  movePauseReason,
  pauseReasonDraftsFromDocument,
  pauseReasonsDirty,
  pauseReasonsPayload,
  pauseReasonsInUseWarning,
  pauseReasonsWarning,
  removePauseReason,
  updatePauseReason,
  validatePauseReasonDrafts,
  type PauseReasonDraft,
} from "./pause-reasons-model";
import { issuesByPath } from "./ring-groups-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";
import { SortableList, SortableRow } from "./sortable-list";

/**
 * Pause reasons screen (plan "Fáza 3"): the list an operator picks from when
 * they step away. The order is the order of the buttons in `MyPhonePanel`, so
 * it is drag-and-drop; `sortOrder` is derived from it in the model.
 *
 * A reason is never hard-deleted from the UI's point of view — removing a row
 * deletes it, which the server refuses if presence still points at it — so the
 * usual way to retire one is the "Aktívny" switch.
 */
export function PauseReasonsEditor({
  canEdit,
  document,
  onSaved,
}: {
  canEdit: boolean;
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [reasons, setReasons] = useState<PauseReasonDraft[]>(() => pauseReasonDraftsFromDocument(document.pauseReasons));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const issues = useMemo(() => validatePauseReasonDrafts(reasons), [reasons]);
  const issuesFor = useMemo(() => issuesByPath(issues), [issues]);
  const formIssues = [...(issuesFor.get("") ?? []), ...serverIssues];
  const dirty = pauseReasonsDirty(reasons, document.pauseReasons);
  const warning = pauseReasonsWarning(reasons);
  // `motorist_operator_presence.pause_reason_id` is `on delete set null`, so the
  // RPC refuses to delete a reason somebody is paused under (`pause_reason_in_use`).
  const inUseWarning = pauseReasonsInUseWarning(reasons, document.pauseReasonsInUse);

  async function save() {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      const response = await saveRoutingConfig("pauseReasons", { pauseReasons: pauseReasonsPayload(reasons), version: document.routingVersion });
      onSaved(response);
      const saved = "Dôvody pauzy sú uložené.";
      setNotice(response.warning ? `${saved} ${response.warning}` : saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dôvody pauzy sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="pause-reasons-heading">
      <SettingsSectionHeader
        icon={Coffee}
        title="Dôvody pauzy"
        description="Čo si operátor zvolí, keď odchádza od telefónu. Počas pauzy mu hovory nezvonia."
      />

      <div className="grid gap-4 p-4">
        <h3 id="pause-reasons-heading" className="sr-only">
          Dôvody pauzy
        </h3>

        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {warning && <SettingsNotice tone="warning">{warning}</SettingsNotice>}
        {inUseWarning && <SettingsNotice tone="error">{inUseWarning}</SettingsNotice>}
        {formIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={formIssues} />
          </div>
        )}

        {reasons.length > 0 && (
          <SortableList items={reasons.map((reason) => reason.key)} onMove={(activeKey, overKey) => setReasons((current) => movePauseReason(current, activeKey, overKey))}>
            {reasons.map((reason, index) => (
              <SortableRow key={reason.key} id={reason.key} disabled={!canEdit} handleLabel={`Presunúť ${index + 1}. dôvod pauzy`}>
                <div className="grid gap-2 sm:grid-cols-[28px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,130px)_auto_auto] sm:items-end">
                  <span className="pb-3 text-sm font-semibold text-zinc-500">{index + 1}.</span>

                  <SettingsField label="Názov">
                    <input
                      className={settingsInputClass}
                      disabled={!canEdit}
                      placeholder="Napríklad Obed"
                      value={reason.label}
                      onChange={(event) => {
                        const label = event.target.value;
                        setReasons((current) =>
                          updatePauseReason(current, reason.key, {
                            label,
                            // A brand-new row gets its code suggested from the
                            // label; an existing code is never rewritten.
                            ...(reason.id === null && reason.code === codeFromLabel(reason.label) ? { code: codeFromLabel(label) } : {}),
                          }),
                        );
                      }}
                    />
                  </SettingsField>

                  <SettingsField label="Kód" hint="Používa sa v štatistikách.">
                    <input
                      className={settingsInputClass}
                      disabled={!canEdit}
                      placeholder="obed"
                      value={reason.code}
                      onChange={(event) => setReasons((current) => updatePauseReason(current, reason.key, { code: event.target.value }))}
                    />
                  </SettingsField>

                  <SettingsField label="Maximum (min)">
                    <input
                      className={settingsInputClass}
                      disabled={!canEdit}
                      inputMode="numeric"
                      placeholder="bez limitu"
                      title={`Prázdne = bez limitu. Inak 1 až ${MAX_PAUSE_MINUTES} minút.`}
                      value={reason.maxMinutes}
                      onChange={(event) => setReasons((current) => updatePauseReason(current, reason.key, { maxMinutes: event.target.value }))}
                    />
                  </SettingsField>

                  <div className="pb-3">
                    <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[#FCD703]"
                        disabled={!canEdit}
                        checked={reason.active}
                        onChange={(event) => setReasons((current) => updatePauseReason(current, reason.key, { active: event.target.checked }))}
                      />
                      Aktívny
                    </label>
                  </div>

                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setReasons((current) => removePauseReason(current, reason.key))}
                    aria-label={`Odobrať ${index + 1}. dôvod pauzy`}
                    className="mb-1 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Odobrať
                  </button>
                </div>
                <p className="mt-1 text-xs text-zinc-600">{describePauseReason(reason)}</p>
                <SettingsIssueList issues={issuesFor.get(reason.key) ?? []} />
              </SortableRow>
            ))}
          </SortableList>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setReasons((current) => addPauseReason(current))}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" />
            Pridať dôvod
          </button>
          <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť dôvody pauzy
          </button>
          {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}
