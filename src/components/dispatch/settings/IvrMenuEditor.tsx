"use client";

import { useMemo, useState } from "react";
import { Loader2, ListTree, Plus, Save, Trash2 } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import {
  ACTIONS_WITH_PROMPT,
  IVR_ACTIONS,
  IVR_ACTION_LABELS,
  MAX_IVR_TIMEOUT_SECS,
  MAX_IVR_TRIES,
  MAX_OPTIONS_PER_MENU,
  MIN_IVR_TIMEOUT_SECS,
  MIN_IVR_TRIES,
  addIvrMenu,
  addIvrOption,
  describeIvrOption,
  ivrMenuDraftsFromDocument,
  ivrMenuWarnings,
  ivrMenusDirty,
  ivrMenusInUseWarning,
  ivrMenusPayload,
  removeIvrMenu,
  removeIvrOption,
  updateIvrMenu,
  updateIvrOption,
  validateIvrMenuDrafts,
  type IvrAction,
  type IvrMenuDraft,
} from "./ivr-menu-model";
import { issuesByPath } from "./ring-groups-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";

/**
 * IVR menu screen (plan "Fáza 4"): what the caller hears before anybody's phone
 * rings, and where each digit takes them.
 *
 * The component only renders and forwards events; drafting, validation,
 * warnings and the payload live in `ivr-menu-model.ts`, which mirrors the
 * server's `validateIvrMenus` and the engine in
 * `src/server/telephony/routing/ivr.ts`.
 *
 * A menu a number still uses cannot be deleted (the server refuses it), so the
 * usual way to retire one is to switch it off — the call then goes straight to
 * the line's ring plan.
 */
export function IvrMenuEditor({
  canEdit,
  document,
  onSaved,
}: {
  canEdit: boolean;
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [menus, setMenus] = useState<IvrMenuDraft[]>(() => ivrMenuDraftsFromDocument(document.ivrMenus));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const context = useMemo(() => ({ plans: document.plans }), [document.plans]);
  const issues = useMemo(() => validateIvrMenuDrafts(menus, context), [context, menus]);
  const issuesFor = useMemo(() => issuesByPath(issues), [issues]);
  const formIssues = [...(issuesFor.get("") ?? []), ...serverIssues];
  const dirty = ivrMenusDirty(menus, document.ivrMenus);
  // `motorist_telephony_lines.ivr_menu_id` is `on delete set null`, so the RPC
  // refuses to delete a menu a number still points at (`ivr_menu_in_use`).
  const inUseWarning = ivrMenusInUseWarning(menus, document.lines);

  async function save() {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      const response = await saveRoutingConfig("ivrMenus", { ivrMenus: ivrMenusPayload(menus), version: document.routingVersion });
      onSaved(response);
      const saved = "IVR menu je uložené. Prebiehajúce hovory dokončia menu, s ktorým začali.";
      setNotice(response.warning ? `${saved} ${response.warning}` : saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "IVR menu sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="ivr-menus-heading">
      <SettingsSectionHeader
        icon={ListTree}
        title="IVR menu"
        description="Čo si volajúci vypočuje a kam ho pošle stlačená klávesa. Bez voľby (alebo po vyčerpaní pokusov) ide hovor na plán zvonenia linky."
      />

      <div className="grid gap-4 p-4">
        <h3 id="ivr-menus-heading" className="sr-only">
          IVR menu
        </h3>

        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {inUseWarning && <SettingsNotice tone="error">{inUseWarning}</SettingsNotice>}
        {formIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={formIssues} />
          </div>
        )}

        {menus.length === 0 && (
          <SettingsNotice tone="info">Zatiaľ nie je vytvorené žiadne IVR menu. Bez neho ide prichádzajúci hovor rovno na plán zvonenia linky.</SettingsNotice>
        )}

        {menus.map((menu) => {
          const warnings = ivrMenuWarnings(menu, document.lines);
          const usedBy = document.lines.filter((line) => line.ivrMenuId === menu.id);

          return (
            <div key={menu.key} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,110px)_minmax(0,110px)_auto_auto]">
                <SettingsField label="Názov menu">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    placeholder="Napríklad Hlavné menu"
                    value={menu.name}
                    onChange={(event) => setMenus((current) => updateIvrMenu(current, menu.key, { name: event.target.value }))}
                  />
                </SettingsField>

                <SettingsField label="Čas na voľbu (s)">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    inputMode="numeric"
                    title={`${MIN_IVR_TIMEOUT_SECS} až ${MAX_IVR_TIMEOUT_SECS} sekúnd po dohratí odkazu.`}
                    value={menu.timeoutSecs}
                    onChange={(event) => setMenus((current) => updateIvrMenu(current, menu.key, { timeoutSecs: event.target.value }))}
                  />
                </SettingsField>

                <SettingsField label="Prehratí menu">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    inputMode="numeric"
                    title={`Koľkokrát sa menu zopakuje, kým sa čaká na voľbu, a koľkokrát ho prehráme znova po neplatnej voľbe alebo po voľbe „Zopakovať menu“ (${MIN_IVR_TRIES} až ${MAX_IVR_TRIES}).`}
                    value={menu.maxTries}
                    onChange={(event) => setMenus((current) => updateIvrMenu(current, menu.key, { maxTries: event.target.value }))}
                  />
                </SettingsField>

                <div className="flex items-end pb-1">
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#FCD703]"
                      disabled={!canEdit}
                      checked={menu.active}
                      onChange={(event) => setMenus((current) => updateIvrMenu(current, menu.key, { active: event.target.checked }))}
                    />
                    Aktívne
                  </label>
                </div>

                <div className="flex items-end pb-1">
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setMenus((current) => removeIvrMenu(current, menu.key))}
                    aria-label={`Odobrať menu ${menu.name || "bez názvu"}`}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Odobrať
                  </button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <SettingsField label="Nahrávka menu" hint="Súbor v public/telephony (napr. ivr-main.mp3) alebo https adresa.">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    placeholder="ivr-main.mp3"
                    value={menu.promptMediaUrl}
                    onChange={(event) => setMenus((current) => updateIvrMenu(current, menu.key, { promptMediaUrl: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Nahrávka pri neplatnej voľbe" hint="Prehrá sa pred zopakovaním menu.">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    placeholder="invalid-input.mp3"
                    value={menu.invalidMediaUrl}
                    onChange={(event) => setMenus((current) => updateIvrMenu(current, menu.key, { invalidMediaUrl: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Text namiesto nahrávky" hint="Použije sa, len keď menu nemá nahrávku. Prečíta ho hlasový robot.">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    placeholder="Pre spojenie s dispečingom stlačte jednotku."
                    value={menu.ttsText}
                    onChange={(event) => setMenus((current) => updateIvrMenu(current, menu.key, { ttsText: event.target.value }))}
                  />
                </SettingsField>
              </div>

              <p className="mt-2 text-xs text-zinc-600">
                {usedBy.length > 0 ? `Prehrá sa na číslach: ${usedBy.map((line) => line.label).join(", ")}.` : "Zatiaľ ho nepoužíva žiadne číslo."}
              </p>
              {warnings
                .filter((warning) => warning.key === menu.key)
                .map((warning) => (
                  <p key={warning.message} className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                    {warning.message}
                  </p>
                ))}
              <SettingsIssueList issues={issuesFor.get(menu.key) ?? []} />

              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase text-zinc-500">Voľby ({menu.options.length})</span>
                  <button
                    type="button"
                    disabled={!canEdit || menu.options.length >= MAX_OPTIONS_PER_MENU}
                    onClick={() => setMenus((current) => addIvrOption(current, menu.key))}
                    className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus size={14} aria-hidden="true" />
                    Pridať voľbu
                  </button>
                </div>

                {menu.options.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-600">
                    Menu nemá žiadnu voľbu. Volajúci si vypočuje odkaz a hovor potom pôjde na plán zvonenia linky.
                  </p>
                ) : (
                  <ul className="grid gap-2">
                    {menu.options.map((option) => (
                      <li key={option.key} className="rounded-md border border-zinc-200 bg-white p-3">
                        <div className="grid gap-2 sm:grid-cols-[80px_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto] sm:items-end">
                          <SettingsField label="Klávesa">
                            <input
                              className={settingsInputClass}
                              disabled={!canEdit}
                              maxLength={1}
                              value={option.digit}
                              onChange={(event) => setMenus((current) => updateIvrOption(current, menu.key, option.key, { digit: event.target.value.trim() }))}
                            />
                          </SettingsField>

                          <SettingsField label="Názov voľby" hint="Zobrazí sa v histórii hovoru.">
                            <input
                              className={settingsInputClass}
                              disabled={!canEdit}
                              placeholder="Dispečing"
                              value={option.label}
                              onChange={(event) => setMenus((current) => updateIvrOption(current, menu.key, option.key, { label: event.target.value }))}
                            />
                          </SettingsField>

                          <SettingsField label="Akcia">
                            <select
                              className={settingsInputClass}
                              disabled={!canEdit}
                              value={option.action}
                              onChange={(event) => setMenus((current) => updateIvrOption(current, menu.key, option.key, { action: event.target.value as IvrAction }))}
                            >
                              {IVR_ACTIONS.map((action) => (
                                <option key={action} value={action}>
                                  {IVR_ACTION_LABELS[action]}
                                </option>
                              ))}
                            </select>
                          </SettingsField>

                          {option.action === "ring_plan" ? (
                            <SettingsField label="Plán zvonenia">
                              <select
                                className={settingsInputClass}
                                disabled={!canEdit}
                                value={option.targetRingPlanId ?? ""}
                                onChange={(event) => setMenus((current) => updateIvrOption(current, menu.key, option.key, { targetRingPlanId: event.target.value || null }))}
                              >
                                <option value="">— vyber plán —</option>
                                {document.plans.map((plan) => (
                                  <option key={plan.id} value={plan.id}>
                                    {plan.name}
                                    {plan.active ? "" : " (vypnutý)"}
                                  </option>
                                ))}
                              </select>
                            </SettingsField>
                          ) : option.action === "external_number" ? (
                            <SettingsField label="Cieľové číslo">
                              <input
                                className={settingsInputClass}
                                disabled={!canEdit}
                                inputMode="tel"
                                placeholder="+421900123456"
                                value={option.targetNumber}
                                onChange={(event) => setMenus((current) => updateIvrOption(current, menu.key, option.key, { targetNumber: event.target.value }))}
                              />
                            </SettingsField>
                          ) : ACTIONS_WITH_PROMPT.includes(option.action) ? (
                            <SettingsField label="Nahrávka voľby" hint="Prehrá sa pred ukončením hovoru.">
                              <input
                                className={settingsInputClass}
                                disabled={!canEdit}
                                placeholder={option.action === "callback" ? "callback-confirmed.mp3" : "odkaz.mp3"}
                                value={option.promptMediaUrl}
                                onChange={(event) => setMenus((current) => updateIvrOption(current, menu.key, option.key, { promptMediaUrl: event.target.value }))}
                              />
                            </SettingsField>
                          ) : (
                            <div className="pb-3 text-xs text-zinc-500">Táto akcia nepotrebuje ďalší cieľ.</div>
                          )}

                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => setMenus((current) => removeIvrOption(current, menu.key, option.key))}
                            aria-label={`Odobrať voľbu ${option.digit || "bez klávesy"}`}
                            className="mb-1 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Odobrať
                          </button>
                        </div>

                        <p className="mt-1 text-xs text-zinc-600">{describeIvrOption(option, context)}</p>
                        {warnings
                          .filter((warning) => warning.key === option.key)
                          .map((warning) => (
                            <p key={warning.message} className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                              {warning.message}
                            </p>
                          ))}
                        <SettingsIssueList issues={issuesFor.get(option.key) ?? []} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setMenus((current) => addIvrMenu(current))}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" />
            Pridať menu
          </button>
          <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť IVR menu
          </button>
          {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}
