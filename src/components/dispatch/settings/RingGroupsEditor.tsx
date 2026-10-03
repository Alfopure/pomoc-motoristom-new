"use client";

import { useId, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { ChevronDown, Loader2, Monitor, Phone, Plus, Save, Trash2, Users } from "lucide-react";

import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { isDestinationAllowed } from "@/lib/telephony/destinations";
import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import {
  FALLBACK_DESTINATION_ALLOWLIST,
  MAX_RING_SECS,
  MIN_RING_SECS,
  addGroup,
  addMember,
  groupDraftsFromDocument,
  groupFanoutNote,
  groupStepTimings,
  groupUsageNote,
  issuesByPath,
  moveMemberInGroups,
  planReferencesUsingGroup,
  removeGroup,
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
import { PhoneNumberHint, PhoneNumberInput } from "../PhoneNumberInput";

/**
 * Ring groups screen (plan "Fáza 3"): who rings, in what order and for how
 * long. The component only renders and forwards events; drafting, reordering,
 * validation and the payload live in `ring-groups-model.ts`.
 *
 * An unused group can be removed from the replacement draft. A plan reference,
 * including one from an inactive plan, keeps the group protected and links the
 * manager directly to the plan that must be changed first.
 */
export function RingGroupsEditor({
  canEdit,
  document,
  onNavigateToPlan,
  onSaved,
  controlled,
  onlyGroupId,
  timingContext,
}: {
  controlled?: { groups: GroupDraft[]; onChange: Dispatch<SetStateAction<GroupDraft[]>> };
  onlyGroupId?: string;
  timingContext?: { strategy: "all" | "ordered"; timeoutSecs: number; planId: string | null };
  canEdit: boolean;
  document: RoutingDocument;
  onNavigateToPlan?: (planId: string) => void;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const headingId = useId();
  const [localGroups, setLocalGroups] = useState<GroupDraft[]>(() => groupDraftsFromDocument(document.groups));
  const groups = controlled?.groups ?? localGroups;
  const setGroups = controlled?.onChange ?? setLocalGroups;
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
        destinationAllowlist: document.limits?.destinationAllowlist ?? FALLBACK_DESTINATION_ALLOWLIST,
        plans: document.plans,
      }),
    [document.plans, document.limits, groups, operators],
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
      const response = await saveRoutingConfig("ringGroups", { groups: ringGroupsPayload(groups), version: document.routingVersion });
      onSaved(response);
      const saved = "Skupiny zvonenia sú uložené. Prebiehajúce hovory ostávajú na pláne, s ktorým začali.";
      setNotice(response.warning ? `${saved} ${response.warning}` : saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Skupiny zvonenia sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={onlyGroupId ? "min-w-0" : "rounded-md border border-zinc-200 bg-white"} aria-labelledby={headingId}>
      {!onlyGroupId && <SettingsSectionHeader
        icon={Users}
        title="Skupiny zvonenia"
        description="Zdieľané zoznamy operátorov a telefónnych čísel. Zmena členov platí vo všetkých plánoch, ktoré skupinu používajú."
      />}

      <div className={onlyGroupId ? "grid min-w-0 gap-3 px-2 pb-3 sm:px-3" : "grid gap-4 p-4"}>
        <h3 id={headingId} className="sr-only">
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

        {groups.filter(group => !onlyGroupId || group.id === onlyGroupId).map((group) => {
          const usageNote = groupUsageNote(group, document.plans, groups);
          const planReferences = planReferencesUsingGroup(group.id, document.plans);
          const timings = groupStepTimings(group, document.plans);
          const ordered = timingContext
            ? timingContext.strategy === "ordered"
            : timings.some(timing => timing.strategy === "ordered");
          const mobileAvailable = document.capabilities?.ownedMobileRouting === true;
          const sharedElsewhere = onlyGroupId && planReferences.some(plan => plan.id !== timingContext?.planId);
          const fanoutNote = timingContext
            ? timingContext.strategy === "all" && document.limits && group.members.length > document.limits.maxRingFanout
              ? `Naraz môže zvoniť najviac ${document.limits.maxRingFanout} dostupných členov. Rozhoduje aj poradie v skupine.`
              : null
            : groupFanoutNote(group, document.plans, document.limits?.maxRingFanout);
          const groupIssues = issuesFor.get(group.key) ?? [];

          return (
            <div key={group.key} className={onlyGroupId ? "min-w-0" : "min-w-0 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 sm:p-4"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Users size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
                  <h4 className="break-words text-sm font-semibold text-zinc-900">{group.name || "Nová skupina"}</h4>
                  <span className="text-xs text-zinc-500">{group.members.length}</span>
                  {!group.active && <span className="rounded bg-zinc-200 px-2 py-1 text-xs text-zinc-700">Vypnutá</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <AddButton disabled={!canEdit} label="Operátor" onClick={() => setGroups(current => addMember(current, group.key, "operator"))} />
                  <AddButton disabled={!canEdit} label="Externé číslo" onClick={() => setGroups(current => addMember(current, group.key, "external_number"))} />
                </div>
              </div>
              {!group.active && <p className="mt-2 text-xs text-amber-800">Táto skupina sa pri hovore preskočí. Zapneš ju v podrobnostiach skupiny.</p>}
              {sharedElsewhere && <p className="mt-2 text-xs text-zinc-600">Zdieľaná skupina: úprava členov sa prejaví aj v ďalších plánoch. Väzby nájdeš v podrobnostiach.</p>}
              {fanoutNote && <p className="mt-2 text-xs text-amber-800">{fanoutNote}</p>}
              <SettingsIssueList issues={groupIssues} />

              <div className="mt-3">
                {group.members.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-300 px-3 py-3 text-sm text-zinc-600">
                    Pridaj operátora alebo telefónne číslo. Prázdna skupina nemá komu zvoniť.
                  </p>
                ) : (
                  <SortableList items={group.members.map(member => member.key)} onMove={(activeKey, overKey) => setGroups(current => moveMemberInGroups(current, group.key, activeKey, overKey))}>
                    {group.members.map((member, index) => {
                      const operator = operators.find(candidate => candidate.profileId === member.profileId);
                      const mobileNumber = normalizeE164(operator?.settings?.defaultMobileNumber);
                      const personalMobile = mobileAvailable && operator?.settings?.deliveryMode === "personal_mobile" && mobileNumber && isDestinationAllowed(mobileNumber, document.limits?.destinationAllowlist);
                      const normalizedNumber = normalizeE164(member.externalNumber);
                      const matchedOwners = normalizedNumber ? operators.filter(candidate => normalizeE164(candidate.settings?.defaultMobileNumber) === normalizedNumber) : [];
                      const owner = member.ownerProfileId
                        ? operators.find(candidate => candidate.profileId === member.ownerProfileId)
                        : matchedOwners.length === 1 ? matchedOwners[0] : null;
                      return (
                        <SortableRow key={member.key} id={member.key} disabled={!canEdit} handleLabel={`Presunúť ${index + 1}. člena skupiny ${group.name}`}>
                          <div className={`grid gap-3 ${ordered ? "lg:grid-cols-[minmax(0,1fr)_120px_auto]" : "sm:grid-cols-[minmax(0,1fr)_auto]"} items-start`}>
                            <div className="min-w-0">
                              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-600">
                                {member.memberKind === "operator" && !personalMobile ? <Monitor size={14} aria-hidden="true" /> : <Phone size={14} aria-hidden="true" />}
                                {ordered && <span>{index + 1}.</span>}
                                <span>{member.memberKind === "operator" ? personalMobile ? "Osobný mobil operátora" : "Operátor v aplikácii" : "Telefónne číslo"}</span>
                              </div>
                              {member.memberKind === "operator" ? (
                                <SettingsField label="Operátor">
                                  <select className={settingsInputClass} disabled={!canEdit} value={member.profileId ?? ""} onChange={event => setGroups(current => updateMember(current, group.key, member.key, { profileId: event.target.value || null }))}>
                                    <option value="">— vyber operátora —</option>
                                    {operators.map(candidate => <option key={candidate.profileId} value={candidate.profileId}>{candidate.displayName}{candidate.active ? "" : " (neaktívny)"}</option>)}
                                  </select>
                                  {personalMobile && <span className="mt-1 block text-xs text-zinc-500">{operator?.settings?.defaultMobileNumber || "Operátor nemá nastavené mobilné číslo."}</span>}
                                </SettingsField>
                              ) : (
                                <div className="grid gap-2">
                                  <SettingsField label="Externé číslo">
                                    <PhoneNumberInput className={settingsInputClass} disabled={!canEdit} value={member.externalNumber} onChange={value => setGroups(current => updateMember(current, group.key, member.key, { externalNumber: value }))} />
                                    <PhoneNumberHint value={member.externalNumber} />
                                  </SettingsField>
                                  {mobileAvailable && <SettingsField label="Komu patrí číslo">
                                    <select aria-label="Vlastník externého čísla" className={settingsInputClass} disabled={!canEdit} value={member.ownerProfileId ?? ""} onChange={event => setGroups(current => updateMember(current, group.key, member.key, { ownerProfileId: event.target.value || null }))}>
                                      <option value="">Bez ručného priradenia</option>
                                      {operators.map(candidate => <option key={candidate.profileId} value={candidate.profileId}>{candidate.displayName} · osobný telefón</option>)}
                                    </select>
                                  </SettingsField>}
                                  {owner && <p className="text-xs text-zinc-500">{member.ownerProfileId ? "Vlastník" : "Rozpoznaný vlastník"}: {owner.displayName}. {mobileAvailable ? "Zvonenie rešpektuje dostupnosť operátora." : "Zvonenie na osobné čísla tu nie je dostupné; tento člen sa preskočí."}</p>}
                                  {!member.ownerProfileId && matchedOwners.length > 1 && <p className="text-xs text-amber-800">Číslo patrí viacerým operátorom. Kým sa vlastníctvo nevyjasní, systém ho nevyzvoní.</p>}
                                  {!owner && matchedOwners.length === 0 && mobileAvailable && <p className="text-xs text-zinc-500">Osobný mobil priraď operátorovi, aby rešpektoval jeho pauzu a prebiehajúci hovor.</p>}
                                </div>
                              )}
                            </div>
                            {ordered && <div className="lg:pt-6"><SettingsField label="Vlastný čas (s)" hint={timingContext && Number.isFinite(timingContext.timeoutSecs) && timingContext.timeoutSecs >= MIN_RING_SECS && timingContext.timeoutSecs <= MAX_RING_SECS ? `Prázdne = ${timingContext.timeoutSecs} s podľa kroku.` : "Prázdne = čas kroku; platí pri postupnom zvonení."}>
                              <input className={settingsInputClass} disabled={!canEdit} inputMode="numeric" placeholder="podľa kroku" title={`Prázdne = čas kroku. Inak ${MIN_RING_SECS} až ${MAX_RING_SECS} s.`} value={member.ringSecs} onChange={event => setGroups(current => updateMember(current, group.key, member.key, { ringSecs: event.target.value }))} />
                            </SettingsField></div>}
                            <button type="button" disabled={!canEdit} onClick={() => setGroups(current => removeMember(current, group.key, member.key))} aria-label={`Odobrať ${index + 1}. člena skupiny ${group.name}`} className="inline-flex h-10 items-center justify-center gap-2 self-start rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-6">
                              <Trash2 size={14} aria-hidden="true" /> Odobrať
                            </button>
                          </div>
                          <SettingsIssueList issues={issuesFor.get(member.key) ?? []} />
                        </SortableRow>
                      );
                    })}
                  </SortableList>
                )}
              </div>

              <details className="group mt-3 border-t border-zinc-200 pt-3" open={groupIssues.length > 0 || undefined}>
                <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium text-zinc-600 hover:text-zinc-950 [&::-webkit-details-marker]:hidden">
                  <ChevronDown size={14} className="transition group-open:rotate-180" aria-hidden="true" />
                  Podrobnosti skupiny {group.name || "bez názvu"}
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <SettingsField label="Názov skupiny"><input className={settingsInputClass} disabled={!canEdit} value={group.name} onChange={event => setGroups(current => updateGroup(current, group.key, { name: event.target.value }))} /></SettingsField>
                  <SettingsField label="Poznámka"><input className={settingsInputClass} disabled={!canEdit} value={group.description} onChange={event => setGroups(current => updateGroup(current, group.key, { description: event.target.value }))} /></SettingsField>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <label className="inline-flex min-h-10 items-center gap-2 text-sm text-zinc-800"><input type="checkbox" className="h-4 w-4 accent-[#FCD703]" disabled={!canEdit} checked={group.active} onChange={event => setGroups(current => updateGroup(current, group.key, { active: event.target.checked }))} /> Skupina je aktívna</label>
                  <button type="button" disabled={!canEdit || planReferences.length > 0} onClick={() => setGroups(current => removeGroup(current, group.key))} aria-label={`Odobrať skupinu ${group.name || "bez názvu"}`} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-white"><Trash2 size={14} aria-hidden="true" /> Odobrať skupinu</button>
                </div>
                {usageNote && <p className="mt-2 text-xs leading-5 text-zinc-600">{usageNote}</p>}
                {planReferences.length > 0 && <div className="mt-2 text-xs leading-5 text-zinc-600">
                  <p>Skupinu možno odstrániť až po odpojení od týchto plánov:</p>
                  <div className="mt-1 flex flex-wrap gap-2">{planReferences.map(plan => <button key={plan.id} type="button" onClick={() => onNavigateToPlan?.(plan.id)} disabled={!onNavigateToPlan} className="min-h-8 rounded-md border border-zinc-200 bg-white px-2 text-zinc-800 hover:bg-zinc-100 disabled:cursor-default">Otvoriť {plan.name}{plan.active ? "" : " (neaktívny)"}</button>)}</div>
                </div>}
              </details>
            </div>
          );
        })}

        {!onlyGroupId && <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <AddButton disabled={!canEdit} label="Pridať skupinu" onClick={() => setGroups((current) => addGroup(current))} />
          {!controlled && <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť skupiny
          </button>}
          {!controlled && dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>}
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
