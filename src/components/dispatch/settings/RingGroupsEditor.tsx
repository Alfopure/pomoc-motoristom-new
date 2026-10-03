"use client";

import { useId, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, Loader2, Monitor, Phone, Plus, Save, Trash2, Users } from "lucide-react";

import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
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
  type MemberDraft,
} from "./ring-groups-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";
import { SortableList } from "./sortable-list";
import { ringPeopleRows, setPersonDevice, type DetachedPersonDevice, type DetachedPersonDevices, type PersonDevice, type RingPeopleContext, type RingPerson } from "./ring-people-model";
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
  groupSelector,
  detachedDevices,
}: {
  detachedDevices?: { devices: DetachedPersonDevices; onChange: Dispatch<SetStateAction<DetachedPersonDevices>> };
  controlled?: { groups: GroupDraft[]; onChange: Dispatch<SetStateAction<GroupDraft[]>> };
  onlyGroupId?: string;
  timingContext?: { strategy: "all" | "ordered"; timeoutSecs: number; planId: string | null };
  groupSelector?: ReactNode;
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
  const [editingMembers, setEditingMembers] = useState<ReadonlySet<string>>(() => new Set());

  const [localDetachedDevices, setLocalDetachedDevices] = useState<{ version: number; devices: DetachedPersonDevices }>(() => ({ version: document.routingVersion, devices: new Map() }));
  const deviceCache: DetachedPersonDevices = detachedDevices?.devices ?? (localDetachedDevices.version === document.routingVersion ? localDetachedDevices.devices : new Map());
  function updateDetachedDevices(devices: DetachedPersonDevices) {
    if (detachedDevices) detachedDevices.onChange(devices);
    else setLocalDetachedDevices({ version: document.routingVersion, devices });
  }

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

  function setMemberEditing(key: string, editing: boolean) {
    setEditingMembers(current => {
      const next = new Set(current);
      if (editing) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function addRecipient(groupKey: string, kind: "operator" | "external_number") {
    const next = addMember(groups, groupKey, kind);
    const member = next.find(group => group.key === groupKey)?.members.at(-1);
    if (member) setMemberEditing(member.key, true);
    setGroups(next);
  }

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

      <div className={onlyGroupId ? "grid min-w-0 gap-3 px-2 pb-1 sm:px-3" : "grid gap-4 p-4"}>
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
          const peopleContext: RingPeopleContext = {
            operators,
            mobileAvailable,
            destinationAllowlist: document.limits?.destinationAllowlist ?? FALLBACK_DESTINATION_ALLOWLIST,
            canReadDelivery: canEdit,
            invalidMemberKeys: new Set(group.members.filter(member => (issuesFor.get(member.key)?.length ?? 0) > 0).map(member => member.key)),
            detachedDevices: deviceCache.get(group.key),
          };
          const peopleRows = onlyGroupId && timingContext?.strategy === "all" ? ringPeopleRows(group.members, peopleContext) : null;
          const grouped = peopleRows?.some(row => row.kind === "person") ?? false;
          function toggleDevice(person: RingPerson, device: PersonDevice, enabled: boolean) {
            const deviceKey = `${person.operator.profileId}:${device}`;
            const retained = new Map<string, DetachedPersonDevice>(deviceCache.get(group.key));
            const result = setPersonDevice(group, person.operator.profileId, device, enabled, { ...peopleContext, detachedDevices: retained }, retained.get(deviceKey));
            if (result.detached) retained.set(deviceKey, result.detached);
            const nextDetached = new Map(deviceCache);
            nextDetached.set(group.key, retained);
            updateDetachedDevices(nextDetached);
            setGroups(current => current.map(candidate => candidate.key === group.key ? result.group : candidate));
          }


          const renderMember = (member: MemberDraft, index: number, sortable = true) => {
            const operator = operators.find(candidate => candidate.profileId === member.profileId);
            const mobileNumber = normalizeE164(operator?.settings?.defaultMobileNumber);
            const personalMobile = Boolean(mobileAvailable && operator?.settings?.deliveryMode === "personal_mobile" && mobileNumber && isDestinationAllowed(mobileNumber, document.limits?.destinationAllowlist));
            const normalizedNumber = normalizeE164(member.externalNumber);
            const matchedOwners = normalizedNumber ? operators.filter(candidate => normalizeE164(candidate.settings?.defaultMobileNumber) === normalizedNumber) : [];
            const owner = member.ownerProfileId
              ? operators.find(candidate => candidate.profileId === member.ownerProfileId)
              : matchedOwners.length === 1 ? matchedOwners[0] : null;
            const external = member.memberKind === "external_number";
            const owned = external && Boolean(member.ownerProfileId || owner);
            const ambiguous = external && !member.ownerProfileId && matchedOwners.length > 1;
            const unavailable = (owned && !mobileAvailable) || ambiguous;
            const memberIssues = issuesFor.get(member.key) ?? [];
            const incomplete = external ? !normalizedNumber : !operator;
            const mustEdit = incomplete || member.id === null || memberIssues.length > 0;
            const editing = mustEdit || editingMembers.has(member.key);
            const phoneLabel = formatPhoneNumberForDisplay(member.externalNumber) || "Nové telefónne číslo";
            const label = external
              ? owner?.displayName || phoneLabel
              : operator?.displayName || "Nový operátor";
            const personName = external ? owner?.displayName : operator?.displayName;
            const initials = personName?.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toLocaleUpperCase("sk");
            const unknownDevice = !external && !canEdit && !operator?.settings && mobileAvailable;
            const endpoint = external ? owned ? "Mobil" : "Telefón" : personalMobile ? "Mobil" : unknownDevice ? "Operátor" : "Web";
            const editLabel = `${label}, ${endpoint.toLocaleLowerCase("sk")}${external && owner ? ` ${phoneLabel}` : ""}`;
            const EndpointIcon = endpoint === "Web" ? Monitor : endpoint === "Operátor" ? Users : Phone;
            const editId = `${headingId}-${member.key}-${sortable ? "sortable" : "plain"}`;
            const defaultSeconds = timingContext && Number.isFinite(timingContext.timeoutSecs) && timingContext.timeoutSecs >= MIN_RING_SECS && timingContext.timeoutSecs <= MAX_RING_SECS ? timingContext.timeoutSecs : null;
            const timeHint = defaultSeconds ? `Prázdne = ${defaultSeconds} s podľa kroku.` : "Prázdne = predvolený čas kroku.";
            return (
              <RecipientRow sortable={sortable} key={member.key} id={member.key} disabled={!canEdit} handleLabel={`Presunúť ${index + 1}. člena skupiny ${group.name}`}>
                <div className={`grid items-center gap-x-3 gap-y-2 ${ordered ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_100px_auto]" : "grid-cols-[minmax(0,1fr)_auto]"}`}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600" aria-hidden="true">{initials || <Phone size={17} />}</span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {ordered && <span className="text-xs tabular-nums text-zinc-400">{index + 1}.</span>}
                        <span className="break-words text-sm font-semibold text-zinc-900">{label}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600"><EndpointIcon size={12} aria-hidden="true" />{endpoint}</span>
                      </div>
                      {external && owner && <p className="mt-0.5 text-xs text-zinc-500">{phoneLabel}</p>}
                      {owned && !owner && <p className="mt-0.5 text-xs text-zinc-500">Priradené operátorovi, ktorý nie je v zozname.</p>}
                      {personalMobile && <p className="mt-0.5 text-xs text-zinc-500">{formatPhoneNumberForDisplay(mobileNumber)}</p>}
                      {unknownDevice && <p className="mt-0.5 text-xs text-zinc-500">Príjem podľa nastavenia operátora.</p>}
                    </div>
                  </div>
                  {ordered && <label className="col-start-1 row-start-2 ml-[52px] block w-[100px] sm:col-start-2 sm:row-start-1 sm:ml-0">
                    <span className="mb-1 block text-[10px] font-medium text-zinc-500">Vlastný čas (s)</span>
                    <input className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-sm tabular-nums outline-none focus:border-zinc-400 focus:ring-2 focus:ring-yellow-200 disabled:bg-zinc-50 disabled:text-zinc-400" disabled={!canEdit} inputMode="numeric" placeholder={defaultSeconds ? String(defaultSeconds) : "podľa kroku"} title={`${timeHint} Vlastný čas: ${MIN_RING_SECS} až ${MAX_RING_SECS} s.`} value={member.ringSecs} onChange={event => setGroups(current => updateMember(current, group.key, member.key, { ringSecs: event.target.value }))} />
                  </label>}
                  {canEdit && <div className={`col-start-2 row-start-1 flex items-center gap-0.5 ${ordered ? "sm:col-start-3" : ""}`}>
                    <button type="button" aria-label={`Upraviť príjemcu ${editLabel}`} aria-expanded={editing} aria-controls={editId} onClick={() => setMemberEditing(member.key, !editing)} disabled={mustEdit} className="min-h-9 rounded-md px-2 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:cursor-default disabled:text-zinc-300">Upraviť</button>
                    <button type="button" onClick={() => setGroups(current => removeMember(current, group.key, member.key))} aria-label={`Odobrať ${index + 1}. člena skupiny ${group.name}`} title={`Odobrať ${label}`} className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-yellow-400"><Trash2 size={15} aria-hidden="true" /></button>
                  </div>}
                </div>
                {unavailable && <p className="mt-2 pl-[52px] text-xs leading-5 text-amber-800">{ambiguous ? "Číslo patrí viacerým operátorom. Kým sa vlastníctvo nevyjasní, systém ho nevyzvoní." : "Zvonenie na osobné čísla tu nie je dostupné; tento príjemca sa preskočí."}</p>}
                {editing && <div id={editId} className="mt-3 border-l-2 border-yellow-300 bg-zinc-50/70 p-3">
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    {external ? <>
                      <SettingsField label="Externé číslo">
                        <PhoneNumberInput className={settingsInputClass} disabled={!canEdit} value={member.externalNumber} onChange={value => { setMemberEditing(member.key, true); setGroups(current => updateMember(current, group.key, member.key, { externalNumber: value })); }} />
                        <PhoneNumberHint value={member.externalNumber} />
                      </SettingsField>
                      {mobileAvailable && <SettingsField label="Komu patrí číslo">
                        <select aria-label="Vlastník externého čísla" className={settingsInputClass} disabled={!canEdit} value={member.ownerProfileId ?? ""} onChange={event => { setMemberEditing(member.key, true); setGroups(current => updateMember(current, group.key, member.key, { ownerProfileId: event.target.value || null })); }}>
                          <option value="">Bez ručného priradenia</option>
                          {operators.map(candidate => <option key={candidate.profileId} value={candidate.profileId}>{candidate.displayName} · osobný telefón</option>)}
                        </select>
                      </SettingsField>}
                    </> : <SettingsField label="Operátor">
                      <select className={settingsInputClass} disabled={!canEdit} value={member.profileId ?? ""} onChange={event => { setMemberEditing(member.key, true); setGroups(current => updateMember(current, group.key, member.key, { profileId: event.target.value || null })); }}>
                        <option value="">— vyber operátora —</option>
                        {operators.map(candidate => <option key={candidate.profileId} value={candidate.profileId}>{candidate.displayName}{candidate.active ? "" : " (neaktívny)"}</option>)}
                      </select>
                    </SettingsField>}
                  </div>
                  {external && owner && !member.ownerProfileId && <p className="mt-2 text-xs text-zinc-500">Číslo sa zhoduje s osobným telefónom operátora {owner.displayName}.</p>}
                  {owned && mobileAvailable && <p className="mt-2 text-xs text-zinc-500">Osobné číslo rešpektuje dostupnosť a pauzu svojho operátora.</p>}
                  {external && !owned && !ambiguous && mobileAvailable && <p className="mt-2 text-xs text-zinc-500">Osobný mobil priraď operátorovi, aby rešpektoval jeho pauzu a prebiehajúci hovor.</p>}
                  {canEdit && !mustEdit && <button type="button" onClick={() => setMemberEditing(member.key, false)} className="mt-3 min-h-8 text-xs font-medium text-zinc-600 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950">Zavrieť úpravu</button>}
                </div>}
                <SettingsIssueList issues={memberIssues} />
              </RecipientRow>
            );
          };

          return (
            <div key={group.key} className={onlyGroupId ? "min-w-0" : "min-w-0 border-b border-zinc-200 pb-6 last:border-b-0"}>
              {!onlyGroupId && <div className="mb-2 flex items-center gap-2">
                <h4 className="text-sm font-semibold text-zinc-900">{group.name || "Nová skupina"}</h4>
                <span className="text-xs text-zinc-400">{group.members.length} príjemcov</span>
              </div>}
              {!group.active && <p className="mb-2 text-xs text-amber-800">Skupina je vypnutá a pri hovore sa preskočí. Zapneš ju v podrobnostiach.</p>}
              {sharedElsewhere && <p className="mb-2 text-xs text-zinc-500">Týchto príjemcov používajú aj ďalšie plány. Úprava sa prejaví všade.</p>}
              {fanoutNote && <p className="mb-2 text-xs text-amber-800">{fanoutNote}</p>}
              <SettingsIssueList issues={groupIssues} />

              {group.members.length === 0 ? (
                <p className="py-5 text-sm text-zinc-500">Zatiaľ tu nikto nie je. Pridaj prvého príjemcu hovoru.</p>
              ) : (
                <>
                  <div role="list" aria-label={`Príjemcovia skupiny ${group.name}`}>
                    {grouped && peopleRows ? peopleRows.map(row => row.kind === "person"
                      ? <PersonRecipient key={row.key} person={row} canEdit={canEdit} onToggle={(device, enabled) => toggleDevice(row, device, enabled)} onRemove={() => setGroups(current => current.map(candidate => candidate.key === group.key ? { ...candidate, members: candidate.members.filter(member => member.key !== row.web?.key && member.key !== row.mobile?.key) } : candidate))} />
                      : renderMember(row.member, group.members.indexOf(row.member), false))
                      : <SortableList items={group.members.map(member => member.key)} onMove={(activeKey, overKey) => setGroups(current => moveMemberInGroups(current, group.key, activeKey, overKey))}>
                        {group.members.map((member, index) => renderMember(member, index))}
                      </SortableList>}
                  </div>
                  {grouped && <details className="group mt-2 text-zinc-500">
                    <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-xs hover:text-zinc-800 [&::-webkit-details-marker]:hidden"><ChevronDown size={13} className="transition group-open:rotate-180" aria-hidden="true" />Poradie a podrobnosti zariadení</summary>
                    <p className="mb-2 text-xs leading-5">Každé zariadenie je samostatný príjemca. Poradie rozhoduje pri limite súčasného zvonenia a v plánoch s postupným zvonením.</p>
                    <div role="list" aria-label={`Zariadenia skupiny ${group.name}`}>
                      <SortableList items={group.members.map(member => member.key)} onMove={(activeKey, overKey) => setGroups(current => moveMemberInGroups(current, group.key, activeKey, overKey))}>
                        {group.members.map((member, index) => renderMember(member, index))}
                      </SortableList>
                    </div>
                  </details>}
                </>
              )}

              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-100 pt-3">
                <AddButton disabled={!canEdit} label="Pridať operátora" onClick={() => addRecipient(group.key, "operator")} />
                <AddButton disabled={!canEdit} label="Pridať číslo" onClick={() => addRecipient(group.key, "external_number")} />
              </div>
              <details className={`group text-zinc-500 ${onlyGroupId ? "mt-1" : "mt-3"}`} open={groupIssues.length > 0 || undefined}>
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs hover:text-zinc-800 [&::-webkit-details-marker]:hidden">
                  <ChevronDown size={13} className="transition group-open:rotate-180" aria-hidden="true" />
                  Podrobnosti skupiny {group.name || "bez názvu"}
                </summary>
                {groupSelector && <div className="mt-3 max-w-md">{groupSelector}</div>}
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <SettingsField label="Názov skupiny"><input className={settingsInputClass} disabled={!canEdit} value={group.name} onChange={event => setGroups(current => updateGroup(current, group.key, { name: event.target.value }))} /></SettingsField>
                  <SettingsField label="Poznámka"><input className={settingsInputClass} disabled={!canEdit} value={group.description} onChange={event => setGroups(current => updateGroup(current, group.key, { description: event.target.value }))} /></SettingsField>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <label className="inline-flex min-h-10 items-center gap-2 text-sm text-zinc-800"><input type="checkbox" className="h-4 w-4 accent-[#FCD703]" disabled={!canEdit} checked={group.active} onChange={event => setGroups(current => updateGroup(current, group.key, { active: event.target.checked }))} /> Skupina je aktívna</label>
                  <button type="button" disabled={!canEdit || planReferences.length > 0} title={planReferences.length > 0 ? "Najprv odpoj skupinu od plánov uvedených nižšie." : "Odobrať skupinu z návrhu"} onClick={() => setGroups(current => removeGroup(current, group.key))} aria-label={`Odobrať skupinu ${group.name || "bez názvu"}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-transparent"><Trash2 size={14} aria-hidden="true" /> Odobrať skupinu</button>
                </div>
                {usageNote && <p className="mt-2 text-xs leading-5">{usageNote}</p>}
                {planReferences.length > 0 && <div className="mt-2 text-xs leading-5">
                  <p>Skupinu možno odstrániť až po odpojení od týchto plánov:</p>
                  <div className="mt-1 flex flex-wrap gap-2">{planReferences.map(plan => <button key={plan.id} type="button" onClick={() => onNavigateToPlan?.(plan.id)} disabled={!onNavigateToPlan} className="min-h-8 text-zinc-600 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950 disabled:cursor-default">Otvoriť {plan.name}{plan.active ? "" : " (neaktívny)"}</button>)}</div>
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

function PersonRecipient({ person, canEdit, onToggle, onRemove }: {
  person: RingPerson;
  canEdit: boolean;
  onToggle: (device: PersonDevice, enabled: boolean) => void;
  onRemove: () => void;
}) {
  const hintId = useId();
  const name = person.operator.displayName;
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toLocaleUpperCase("sk");
  return <div role="listitem" aria-label={name} className="min-w-0 border-b border-zinc-200/70 py-3 last:border-b-0">
    <div className="flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600" aria-hidden="true">{initials || <Users size={17} />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-9 items-center justify-between gap-2">
          <span className="break-words text-sm font-semibold text-zinc-900">{name}{!person.operator.active && <span className="ml-2 font-normal text-amber-800">Neaktívny</span>}</span>
          {canEdit && <button type="button" onClick={onRemove} aria-label={`Odobrať operátora ${name}`} title="Odobrať operátora aj jeho zariadenia z tejto skupiny" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-yellow-400"><Trash2 size={15} aria-hidden="true" /></button>}
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          {(["web", "mobile"] as const).map(device => {
            const checked = Boolean(person[device]);
            const lastDevice = checked && (!person[device === "web" ? "mobile" : "web"] || (device === "web" && Boolean(person.mobileUnavailable)));
            const unavailable = device === "mobile" && person.mobileUnavailable;
            const disabled = !canEdit || lastDevice || Boolean(unavailable);
            const Icon = device === "web" ? Monitor : Phone;
            const label = device === "web" ? "Web" : "Mobil";
            return <label key={device} title={unavailable || (lastDevice ? "Aspoň jedno dostupné zariadenie zostáva zapnuté. Celého operátora odstrániš ikonou koša." : undefined)} className={`inline-flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm ${checked && !unavailable ? "border-zinc-300 bg-white text-zinc-900" : "border-zinc-200 text-zinc-500"} ${disabled ? "cursor-default" : "cursor-pointer hover:border-zinc-400"}`}>
              <input type="checkbox" aria-label={`${label} pre ${name}`} aria-describedby={unavailable ? hintId : undefined} disabled={disabled} checked={checked} onChange={event => onToggle(device, event.target.checked)} className="h-4 w-4 accent-[#FCD703] focus-visible:outline-2 focus-visible:outline-yellow-400" />
              <Icon size={14} aria-hidden="true" />{label}
            </label>;
          })}
        </div>
        {person.mobileNumber && <p className="mt-2 text-xs text-zinc-500">Mobil · {formatPhoneNumberForDisplay(person.mobileNumber)}</p>}
        {person.mobileUnavailable && <p id={hintId} className="mt-2 text-xs leading-5 text-amber-800">{person.mobileUnavailable}</p>}
        <span className="sr-only">Na odobratie všetkých zariadení použi Odobrať operátora.</span>
      </div>
    </div>
  </div>;
}

/** The shared list supplies pointer and keyboard sensors; recipient rows stay flat. */
type RecipientRowProps = { children: ReactNode; handleLabel: string; id: string; disabled: boolean };
function RecipientRow({ sortable = true, ...props }: RecipientRowProps & { sortable?: boolean }) {
  return sortable ? <SortableRecipientRow {...props} /> : <div role="listitem" className="min-w-0 border-b border-zinc-200/70 py-3 last:border-b-0">{props.children}</div>;
}

function SortableRecipientRow({ children, handleLabel, id, disabled }: RecipientRowProps) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id, disabled });
  return <div
    ref={setNodeRef}
    role="listitem"
    style={{ transform: CSS.Transform.toString(transform), transition }}
    className={`flex min-w-0 items-start gap-1 border-b border-zinc-200/70 py-2 last:border-b-0 ${isDragging ? "relative z-10 bg-yellow-50 shadow-sm" : ""}`}
  >
    <button type="button" aria-label={handleLabel} disabled={disabled} className="mt-1 flex h-8 w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-zinc-300 hover:text-zinc-600 focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:cursor-default disabled:opacity-30" {...attributes} {...listeners}>
      <GripVertical size={15} aria-hidden="true" />
    </button>
    <div className="min-w-0 flex-1">{children}</div>
  </div>;
}

function AddButton({ disabled, label, onClick }: { disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-yellow-400 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Plus size={15} aria-hidden="true" />
      {label}
    </button>
  );
}
