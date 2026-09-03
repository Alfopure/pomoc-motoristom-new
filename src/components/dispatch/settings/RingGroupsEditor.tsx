"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus, Save, Trash2, Users } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import {
  FALLBACK_DESTINATION_ALLOWLIST,
  MAX_RING_SECS,
  MIN_RING_SECS,
  addGroup,
  addMember,
  groupDraftsFromDocument,
  groupUsageNote,
  issuesByPath,
  moveMemberInGroups,
  removeMember,
  ringGroupsDirty,
  ringGroupsPayload,
  updateGroup,
  updateMember,
  validateRingGroupDrafts,
  type GroupDraft,
} from "./ring-groups-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";
import { SortableList, SortableRow } from "./sortable-list";

/**
 * Ring groups screen (plan "Fáza 3"): who rings, in what order and for how
 * long. The component only renders and forwards events; drafting, reordering,
 * validation and the payload live in `ring-groups-model.ts`.
 *
 * Groups are never deleted from here — a group a plan uses may not disappear —
 * they are switched off with "Neaktívna".
 */
export function RingGroupsEditor({
  canEdit,
  document,
  onSaved,
}: {
  canEdit: boolean;
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [groups, setGroups] = useState<GroupDraft[]>(() => groupDraftsFromDocument(document.groups));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const operators = useMemo(
    () => [...document.operators].sort((left, right) => left.displayName.localeCompare(right.displayName, "sk")),
    [document.operators],
  );

  const issues = useMemo(
    () =>
      validateRingGroupDrafts(groups, {
        operatorIds: operators.map((operator) => operator.profileId),
        destinationAllowlist: document.settings?.destinationAllowlist ?? FALLBACK_DESTINATION_ALLOWLIST,
        plans: document.plans,
      }),
    [document.plans, document.settings, groups, operators],
  );

  const issuesFor = useMemo(() => issuesByPath(issues), [issues]);
  const formIssues = [...(issuesFor.get("") ?? []), ...serverIssues];
  const dirty = ringGroupsDirty(groups, document.groups);

  async function save() {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      const response = await saveRoutingConfig("ringGroups", { groups: ringGroupsPayload(groups) });
      onSaved(response);
      setNotice("Skupiny zvonenia sú uložené. Prebiehajúce hovory ostávajú na pláne, s ktorým začali.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Skupiny zvonenia sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="ring-groups-heading">
      <SettingsSectionHeader
        icon={Users}
        title="Skupiny zvonenia"
        description="Kto zvoní pri prichádzajúcom hovore. Poradie členov sa dá ťahať myšou alebo klávesnicou."
      />

      <div className="grid gap-4 p-4">
        <h3 id="ring-groups-heading" className="sr-only">
          Skupiny zvonenia
        </h3>

        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {formIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={formIssues} />
          </div>
        )}

        {groups.length === 0 && <SettingsNotice tone="warning">Zatiaľ nie je vytvorená žiadna skupina zvonenia.</SettingsNotice>}

        {groups.map((group) => {
          const usageNote = groupUsageNote(group, document.plans);
          const groupIssues = issuesFor.get(group.key) ?? [];

          return (
            <div key={group.key} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                <SettingsField label="Názov skupiny">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={group.name}
                    onChange={(event) => setGroups((current) => updateGroup(current, group.key, { name: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Poznámka">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={group.description}
                    onChange={(event) => setGroups((current) => updateGroup(current, group.key, { description: event.target.value }))}
                  />
                </SettingsField>
                <div className="flex items-end pb-1">
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#FCD703]"
                      disabled={!canEdit}
                      checked={group.active}
                      onChange={(event) => setGroups((current) => updateGroup(current, group.key, { active: event.target.checked }))}
                    />
                    Aktívna
                  </label>
                </div>
              </div>

              {usageNote && <p className={`mt-2 text-xs ${group.active ? "text-zinc-600" : "text-amber-700"}`}>{usageNote}</p>}
              <SettingsIssueList issues={groupIssues} />

              <div className="mt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase text-zinc-500">Členovia ({group.members.length})</span>
                  <div className="flex gap-2">
                    <AddButton disabled={!canEdit} label="Operátor" onClick={() => setGroups((current) => addMember(current, group.key, "operator"))} />
                    <AddButton disabled={!canEdit} label="Externé číslo" onClick={() => setGroups((current) => addMember(current, group.key, "external_number"))} />
                  </div>
                </div>

                {group.members.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-600">
                    Skupina nemá členov. Pridaj operátora alebo externé číslo (napríklad mobil dispečera), inak v tejto skupine nikto nezazvoní.
                  </p>
                ) : (
                  <SortableList
                    items={group.members.map((member) => member.key)}
                    onMove={(activeKey, overKey) => setGroups((current) => moveMemberInGroups(current, group.key, activeKey, overKey))}
                  >
                    {group.members.map((member, index) => (
                      <SortableRow key={member.key} id={member.key} disabled={!canEdit} handleLabel={`Presunúť ${index + 1}. člena skupiny ${group.name}`}>
                        <div className="grid gap-2 sm:grid-cols-[28px_minmax(0,1.6fr)_minmax(0,110px)_auto] sm:items-end">
                          <span className="text-sm font-semibold text-zinc-500">{index + 1}.</span>

                          {member.memberKind === "operator" ? (
                            <SettingsField label="Operátor">
                              <select
                                className={settingsInputClass}
                                disabled={!canEdit}
                                value={member.profileId ?? ""}
                                onChange={(event) => setGroups((current) => updateMember(current, group.key, member.key, { profileId: event.target.value || null }))}
                              >
                                <option value="">— vyber operátora —</option>
                                {operators.map((operator) => (
                                  <option key={operator.profileId} value={operator.profileId}>
                                    {operator.displayName}
                                    {operator.active ? "" : " (neaktívny)"}
                                  </option>
                                ))}
                              </select>
                            </SettingsField>
                          ) : (
                            <SettingsField label="Externé číslo" hint="Napríklad mobil dispečera, zvoní aj keď je prehliadač zavretý.">
                              <input
                                className={settingsInputClass}
                                disabled={!canEdit}
                                inputMode="tel"
                                placeholder="+421900123456"
                                value={member.externalNumber}
                                onChange={(event) => setGroups((current) => updateMember(current, group.key, member.key, { externalNumber: event.target.value }))}
                              />
                            </SettingsField>
                          )}

                          <SettingsField label="Zvonenie (s)">
                            <input
                              className={settingsInputClass}
                              disabled={!canEdit}
                              inputMode="numeric"
                              placeholder="podľa kroku"
                              title={`Prázdne = čas kroku. Inak ${MIN_RING_SECS} až ${MAX_RING_SECS} s.`}
                              value={member.ringSecs}
                              onChange={(event) => setGroups((current) => updateMember(current, group.key, member.key, { ringSecs: event.target.value }))}
                            />
                          </SettingsField>

                          <button
                            type="button"
                            disabled={!canEdit}
                            onClick={() => setGroups((current) => removeMember(current, group.key, member.key))}
                            aria-label={`Odobrať ${index + 1}. člena skupiny ${group.name}`}
                            className="mb-1 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Odobrať
                          </button>
                        </div>
                        <SettingsIssueList issues={issuesFor.get(member.key) ?? []} />
                      </SortableRow>
                    ))}
                  </SortableList>
                )}
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <AddButton disabled={!canEdit} label="Pridať skupinu" onClick={() => setGroups((current) => addGroup(current))} />
          <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť skupiny
          </button>
          {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}

function AddButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Plus size={15} aria-hidden="true" />
      {label}
    </button>
  );
}
