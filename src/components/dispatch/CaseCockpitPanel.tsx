"use client";

import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  CarFront,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  CreditCard,
  Headphones,
  Loader2,
  Mail,
  MapPin,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Paperclip,
  Phone,
  Route,
  Smartphone,
  UserRound,
  Wrench,
} from "lucide-react";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type {
  Branch,
  CaseAttachmentMetadata,
  ClosureType,
  Contact,
  CustomerContact,
  DispatchCase,
  FleetAsset,
  Operator,
  PartnerDirectoryEntry,
  PriceRule,
  TimelineEvent,
} from "@/domain/types";
import {
  accessComplicationLabels,
  clientVehicleTypeLabels,
  customerContactRoleLabels,
  damageAreaLabels,
  incidentTypeLabels,
  jobTypeLabels,
  paymentMethodLabels,
  paymentStatusLabels,
  placeTypeLabels,
  replacementPreferenceLabels,
  replacementProvisionLabels,
  requiresTowDestination,
  transmissionLabels,
  vehicleConditionFlagLabels,
} from "@/domain/case-card";
import { casePriorityLabels, caseStatusLabels, caseStatusTone, priorityTone } from "@/domain/statuses";
import { formatCurrency, formatTime } from "@/lib/dispatch-calculations";
import type { DispatchMapModel } from "@/lib/map-adapter";
import { attachmentCategoryLabels } from "./case-form-shared";
import { CaseDetail } from "./CaseDetail";
import type { SaveCaseDraft } from "./NewCaseDrawer";
import { SmsComposerDialog } from "./SmsComposerDialog";

type WorkspaceMode = "collapsed" | "split" | "expanded";

type CaseCockpitPanelProps = {
  assets: FleetAsset[];
  branches: Branch[];
  caseItem: DispatchCase;
  commanderVehicles: CommanderVehicleConnection[];
  focusedTaskId?: string;
  mode: WorkspaceMode;
  model: DispatchMapModel;
  operators: Operator[];
  partnerDirectory: PartnerDirectoryEntry[];
  priceRule?: PriceRule;
  onCollapse: () => void;
  onDataChange: (dispatchData: DispatchData) => void;
  /** Click-to-call from the case card; absent while telephony is not configured. */
  onDial?: (phone: string, caseId?: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onExpand: () => void;
  onRestore: () => void;
  onSaveDraftChange: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange: (saving: boolean) => void;
  viewerProfileId?: string;
};

const sourceLabels: Record<NonNullable<DispatchCase["sourceType"]>, string> = {
  assistance: "Asistenčka",
  client: "Klient",
  internal: "Interné",
  partner: "Partner",
  samoplatca: "Samoplatca",
};

export function CaseCockpitPanel({
  assets,
  branches,
  caseItem,
  commanderVehicles,
  focusedTaskId,
  mode,
  model,
  onCollapse,
  onDataChange,
  onDial,
  onDirtyChange,
  onExpand,
  onRestore,
  onSaveDraftChange,
  onSavingChange,
  operators,
  partnerDirectory,
  priceRule,
  viewerProfileId,
}: CaseCockpitPanelProps) {
  const [smsComposerOpen, setSmsComposerOpen] = useState(false);
  const [isDialingFromHeader, setIsDialingFromHeader] = useState(false);
  const owner = operators.find((operator) => operator.id === caseItem.ownerId)?.name ?? caseItem.ownerName ?? "Nepriradené";
  const selectedAsset = caseItem.selectedAssetId ? assets.find((asset) => asset.id === caseItem.selectedAssetId) : undefined;
  const asset = selectedAsset ?? model.nearestAsset?.asset;
  const branch = branches.find((candidate) => candidate.id === caseItem.branchId) ?? model.nearestBranch?.branch;
  const sortedTimeline = [...caseItem.timeline].sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime());
  const primaryContact = caseItem.customerDetails.contacts?.find((contact) => contact.isPrimary) ?? caseItem.customerDetails.contacts?.[0];
  const contactName = primaryContact?.name || caseItem.contact.name;
  const contactPhone = primaryContact?.phone || caseItem.contact.phone;
  const contactEmail = primaryContact?.email || caseItem.contact.email;
  const customerName = caseItem.customerDetails.companyName || caseItem.customerDetails.assistanceServiceName || contactName;
  const customerIdentity = getCustomerIdentity(caseItem);
  const contactRows = (caseItem.customerDetails.contacts?.length ?? 0) > 0 ? caseItem.customerDetails.contacts ?? [] : [caseItem.contact];
  const hasTowDestination = requiresTowDestination(caseItem.jobTypes);
  const vehicleMeta = [
    caseItem.vehicle.productionYear,
    caseItem.vehicle.color,
    caseItem.vehicle.vehicleType ? clientVehicleTypeLabels[caseItem.vehicle.vehicleType] : undefined,
    caseItem.vehicle.transmission ? transmissionLabels[caseItem.vehicle.transmission] : undefined,
    caseItem.vehicle.driveType,
    caseItem.vehicle.weightKg ? `${caseItem.vehicle.weightKg} kg` : undefined,
  ].filter(Boolean);
  const locationMeta = [
    caseItem.locationDetails.placeType ? placeTypeLabels[caseItem.locationDetails.placeType] : undefined,
    caseItem.locationDetails.roadName,
    caseItem.locationDetails.kilometerSection,
    caseItem.locationDetails.drivingDirection,
  ].filter(Boolean);
  const replacementText = caseItem.replacementVehicle.needed
    ? [
        caseItem.replacementVehicle.requestedType || "Vyžiadané",
        labelList(caseItem.replacementVehicle.preferences, replacementPreferenceLabels, ""),
        caseItem.replacementVehicle.note,
        caseItem.replacementVehicle.provisionStatus
          ? `${replacementProvisionLabels[caseItem.replacementVehicle.provisionStatus]}${caseItem.replacementVehicle.provisionReason ? ` (${caseItem.replacementVehicle.provisionReason})` : ""}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Nevyžiadané";
  const paymentText = [
    caseItem.paymentDetails.method ? paymentMethodLabels[caseItem.paymentDetails.method] : "Platba nezadaná",
    caseItem.paymentDetails.status ? paymentStatusLabels[caseItem.paymentDetails.status] : "Stav nezadaný",
  ].join(" · ");
  const closureText = [
    caseItem.closureDetails.type ? closureTypeLabel(caseItem.closureDetails.type) : "Typ nezadaný",
    caseItem.closureDetails.status ?? "Rozpracované",
    caseItem.closureDetails.closedAt ? `uzavreté ${formatTime(caseItem.closureDetails.closedAt)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const incidentMeta = [
    `účastníci ${caseItem.incidentDetails.participantsCount ?? 0}`,
    `pasažieri ${caseItem.incidentDetails.passengersCount ?? 0}`,
  ].join(" · ");
  const damageText = labelList(caseItem.incidentDetails.damageAreas, damageAreaLabels);
  const checklist = [
    { done: Boolean(contactPhone), label: "Kontakt" },
    { done: Boolean(caseItem.pickup?.address), label: "Pickup" },
    { done: !hasTowDestination || Boolean(caseItem.destination?.address), label: "Cieľ" },
    { done: Boolean(caseItem.selectedAssetId), label: "Technika" },
    { done: caseItem.attachments.length > 0, label: "Doklady/fotky" },
  ];
  const timelineLimit = mode === "expanded" ? 5 : 2;
  const contactLimit = mode === "expanded" ? contactRows.length : 3;
  const attachmentLimit = mode === "expanded" ? 6 : 2;
  const routeSummary = model.routePlan
    ? `${model.routePlan.totalOperationalKm} km · ${model.routePlan.totalEta} min`
    : "Trasa sa vypočíta po doplnení polohy";

  async function callFromWebPhone() {
    if (!contactPhone || !onDial || isDialingFromHeader) return;

    setIsDialingFromHeader(true);
    try {
      await onDial(contactPhone, caseItem.id);
    } catch {
      // The shared telephony controller presents the provider error in the
      // header status menu. Avoid an unhandled rejection in this compact action.
    } finally {
      setIsDialingFromHeader(false);
    }
  }

  const callActions = (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Možnosti volania">
      <QuickAction
        busy={isDialingFromHeader}
        compact={mode === "collapsed"}
        disabled={!contactPhone || !onDial || isDialingFromHeader}
        icon={Headphones}
        label="Volať cez web"
        onClick={() => void callFromWebPhone()}
        title={
          !contactPhone
            ? "Najprv doplňte telefónne číslo"
            : onDial
              ? "Volať cez webový telefón"
              : "Webový telefón nie je nakonfigurovaný"
        }
      />
      <QuickAction
        compact={mode === "collapsed"}
        href={contactPhone ? `tel:${cleanPhone(contactPhone)}` : undefined}
        icon={Smartphone}
        label="Volať cez mobil"
        title={contactPhone ? "Volať cez mobilný telefón" : "Najprv doplňte telefónne číslo"}
      />
    </div>
  );

  if (mode === "collapsed") {
    return (
      <>
        <section className="flex h-full min-h-0 items-center gap-2 overflow-hidden rounded-md border border-zinc-200 bg-white px-3 shadow-sm">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-zinc-950">{caseItem.caseNumber}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${caseStatusTone[caseItem.status]}`}>
                {caseStatusLabels[caseItem.status]}
              </span>
              <span className="hidden truncate text-xs font-semibold text-zinc-500 md:inline">
                {routeSummary} · {contactName || "Bez kontaktu"} · {caseItem.vehicle.licensePlate || "Bez vozidla"}
              </span>
            </div>
            <div className="mt-1 truncate text-xs font-medium text-zinc-600">{caseItem.nextStep}</div>
          </div>
          {callActions}
          <QuickAction onClick={() => setSmsComposerOpen(true)} icon={MessageSquareText} label="SMS" compact tone="yellow" />
          <button
            type="button"
            onClick={onRestore}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-950 text-white hover:bg-zinc-800"
            aria-label="Maximalizovať spodnú lištu"
            title="Maximalizovať spodnú lištu"
          >
            <Maximize2 size={15} />
          </button>
        </section>
        <SmsComposerDialog caseId={caseItem.id} caseNumber={caseItem.caseNumber} initialPhone={contactPhone} locationPhone={contactPhone} onClose={() => setSmsComposerOpen(false)} onSent={(result) => result.dispatchData && onDataChange(result.dispatchData)} open={smsComposerOpen} />
      </>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-zinc-950">{caseItem.caseNumber}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${caseStatusTone[caseItem.status]}`}>
                {caseStatusLabels[caseItem.status]}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${priorityTone[caseItem.priority]}`}>
                {casePriorityLabels[caseItem.priority]}
              </span>
              <span className="truncate text-sm font-semibold text-zinc-700">{customerName}</span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-zinc-600">
              <span>{routeSummary}</span>
              <span>{owner}</span>
              <span className="truncate">{asset ? (selectedAsset ? asset.label : `Návrh: ${asset.label}`) : "Bez dostupnej techniky"}</span>
              <span>Update {formatTime(caseItem.updatedAt)}</span>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:shrink-0">
            {callActions}
            <QuickAction onClick={() => setSmsComposerOpen(true)} icon={MessageSquareText} label="SMS" tone="yellow" />
            {contactEmail && <QuickAction href={`mailto:${contactEmail}`} icon={Mail} label="Email" />}
            <button
              type="button"
              onClick={onCollapse}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
              aria-label="Minimalizovať na spodnú lištu"
              title="Minimalizovať na spodnú lištu"
            >
              <Minimize2 size={16} />
            </button>
            {mode !== "expanded" && (
              <button
                type="button"
                onClick={onExpand}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                aria-label="Maximalizovať kokpit"
                title="Maximalizovať kokpit"
              >
                <Maximize2 size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto bg-zinc-50 p-2 sm:p-3">
        {/* P-10: kokpit je jediný pohľad prípadu. Sekcie idú v jednom toku pod sebou
            (karta → úlohy → poznámky a aktivita → prevádzkový prehľad) — bez úzkeho
            bočného pásu, ktorý text lámal a duplikoval zoznam úloh. */}
        <CaseDetail
          key={caseItem.id}
          assets={assets}
          branches={branches}
          caseItem={caseItem}
          commanderVehicles={commanderVehicles}
          compactEditor
          editing
          embedded
          focusedTaskId={focusedTaskId}
          onDataChange={onDataChange}
          onDial={onDial}
          onDirtyChange={onDirtyChange}
          onSaveDraftChange={onSaveDraftChange}
          onSavingChange={onSavingChange}
          operators={operators}
          partnerDirectory={partnerDirectory}
          persistentEditing
          priceRule={priceRule}
          showInlineEditButton={false}
          viewerProfileId={viewerProfileId}
        />

        <details className="group overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-l-4 border-l-[#FCD703] bg-yellow-50 px-3 py-2.5 transition hover:bg-yellow-100 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-zinc-950">Prevádzkový prehľad</span>
              <span className="block truncate text-xs font-medium text-zinc-600">Trasa, technika, komunikácia a doklady</span>
            </span>
            <ChevronDown size={18} className="shrink-0 text-zinc-600 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="grid auto-rows-min grid-flow-dense gap-2 border-t border-yellow-200 bg-zinc-50 p-2 lg:grid-cols-2 xl:grid-cols-12 sm:p-3">
          <InfoBlock className="xl:col-span-4" icon={CheckCircle2} title="Ďalší krok">
            <div className="rounded-md bg-[#FCD703] px-3 py-2 text-sm font-semibold leading-5 text-zinc-950">{caseItem.nextStep}</div>
            <div className="grid grid-cols-2 gap-1.5">
              {checklist.map((item) => (
                <div key={item.label} className={`rounded-md px-2 py-1.5 text-xs font-semibold ${item.done ? "bg-emerald-50 text-emerald-800" : "bg-white text-zinc-600 ring-1 ring-zinc-200"}`}>
                  {item.done ? "OK" : "Čaká"} · {item.label}
                </div>
              ))}
            </div>
            <Fact label="Owner" value={owner} />
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={Route} title="Trasa">
            {model.routePlan ? (
              <>
                <div className="grid grid-cols-3 gap-1.5">
                  <MetricTile label="KM" value={`${model.routePlan.totalOperationalKm}`} />
                  <MetricTile label="ETA" value={`${model.routePlan.totalEta} min`} />
                  <MetricTile label="Cena" value={model.price ? formatCurrency(model.price.total) : "Nezadaná"} />
                </div>
                <div className="grid gap-1.5">
                  {model.routePlan.segments.map((segment, index) => (
                <div key={segment.id} className="grid grid-cols-[22px_minmax(0,1fr)_auto] gap-2 rounded-md bg-white px-2 py-1.5 text-xs ring-1 ring-zinc-100">
                  <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950 text-[10px] font-bold text-white">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-zinc-900">{segment.label}</span>
                    <span className="block truncate text-zinc-500">{segment.detail}</span>
                  </span>
                  <span className="font-semibold text-zinc-700">{segment.operationalKm} km · {segment.eta} min</span>
                </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm font-medium text-zinc-600">Poloha nezadaná — nevytvárame falošnú trasu, ETA ani návrh techniky.</div>
            )}
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={UserRound} title="Kontakt">
            <div className="flex flex-wrap gap-1.5">
              <QuickAction href={contactPhone ? `tel:${cleanPhone(contactPhone)}` : undefined} icon={Phone} label={contactPhone || "Bez telefónu"} />
              <QuickAction onClick={() => setSmsComposerOpen(true)} icon={MessageSquareText} label="SMS" tone="yellow" />
              {contactEmail && <QuickAction href={`mailto:${contactEmail}`} icon={Mail} label="Email" />}
            </div>
            <div className="grid gap-1.5">
              {contactRows.slice(0, contactLimit).map((contact, index) => (
                <ContactRow key={contact.id ?? `${contact.phone}-${index}`} contact={contact} fallbackPrimary={index === 0} />
              ))}
            </div>
            {caseItem.customerDetails.alternativeContact && <Fact label="Alternatíva" value={caseItem.customerDetails.alternativeContact} />}
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={ClipboardList} title="Karta">
            <Fact label="Zákazka" value={labelList(caseItem.jobTypes, jobTypeLabels)} />
            <Fact label="Typ / zdroj" value={`${caseItem.caseType || "Nezadaný"} · ${caseItem.sourceType ? sourceLabels[caseItem.sourceType] : "Nezadaný"}`} />
            <Fact label="Zákazník" value={customerIdentity.name} detail={customerIdentity.detail} />
            <Fact label="Vytvorené" value={formatTime(caseItem.createdAt)} detail={`Update ${formatTime(caseItem.updatedAt)}`} />
            <Fact label="Poznámka" value={caseItem.mainNote || caseItem.summary || "Bez poznámky"} wide />
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={MapPin} title="Lokality">
            <Fact
              label="Pickup"
              value={caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress || "Poloha nezadaná"}
              detail={caseItem.pickup?.address || (caseItem.locationDetails.manualPickupAddress ? "Ručne zadané bez súradníc" : undefined)}
              wide
            />
            <Fact label="GPS" value={caseItem.pickup ? `${caseItem.pickup.lat}, ${caseItem.pickup.lng}` : "Nezadané"} />
            {caseItem.customerSharedLocation && (
              <Fact
                label="GPS klienta"
                value={`${caseItem.customerSharedLocation.lat}, ${caseItem.customerSharedLocation.lng}`}
                detail={`${formatTime(caseItem.customerSharedLocation.submittedAt)}${caseItem.customerSharedLocation.accuracyMeters !== undefined ? ` · presnosť ${Math.round(caseItem.customerSharedLocation.accuracyMeters)} m` : ""}`}
              />
            )}
            <Fact label="Miesto" value={locationMeta.join(" · ") || "Nezadané"} detail={caseItem.locationDetails.complications} />
            <ChipList items={caseItem.locationDetails.accessComplications.map((item) => accessComplicationLabels[item])} empty="Bez komplikácií prístupu" />
            {caseItem.pickup?.notes && <Fact label="Poznámka pickup" value={caseItem.pickup.notes} wide />}
            <Fact
              label="Cieľ"
              value={hasTowDestination ? caseItem.destination?.label || caseItem.locationDetails.manualDestinationAddress || "Cieľ nezadaný" : "Cieľ sa nevyžaduje"}
              detail={hasTowDestination ? caseItem.destination?.address || (caseItem.locationDetails.manualDestinationAddress ? "Ručne zadané bez súradníc" : caseItem.locationDetails.destinationNote) : caseItem.locationDetails.destinationNote}
              wide
            />
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={CarFront} title="Vozidlo a incident">
            <Fact label="Vozidlo" value={`${caseItem.vehicle.licensePlate} · ${caseItem.vehicle.make} ${caseItem.vehicle.model}`} />
            <Fact label="Technické" value={vehicleMeta.join(" · ") || "Nezadané"} />
            <Fact label="VIN" value={caseItem.vehicle.vin || "Nezadané"} />
            <Fact label="Incident" value={caseItem.incidentDetails.type ? incidentTypeLabels[caseItem.incidentDetails.type] : "Nezadaný"} detail={incidentMeta} />
            <Fact label="Poškodenia" value={damageText} detail={caseItem.incidentDetails.damageNote ?? caseItem.incidentDetails.damages} />
            <Fact label="Problém" value={caseItem.vehicle.issue || caseItem.incidentDetails.description || "Nezadané"} wide />
            <ChipList items={caseItem.vehicle.conditionFlags.map((flag) => vehicleConditionFlagLabels[flag])} empty="Bez príznakov" />
            {caseItem.vehicle.specifics && <Fact label="Špecifiká" value={caseItem.vehicle.specifics} wide />}
            {caseItem.vehicle.note && <Fact label="Poznámka" value={caseItem.vehicle.note} wide />}
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={Wrench} title="Technika / pobočka">
            <Fact label="Pobočka" value={branch?.name || "Nepriradená"} detail={branch?.address} />
            <Fact label="Pobočka tel." value={branch?.phone || "Nezadané"} />
            <Fact
              label={selectedAsset ? "Priradené" : "Navrhnuté"}
              value={asset ? `${asset.label} · ${asset.licensePlate}` : "Žiadna dostupná technika"}
              detail={asset?.notes}
            />
            <Fact label="Vodič" value={asset?.assignedDriverName || "Nepriradený"} detail={asset?.assignedDriverPhone} />
            <Fact label="Náhradné vozidlo" value={replacementText || "Nevyžiadané"} />
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={MessageSquareText} title="Komunikácia">
            <div className="grid gap-1.5">
              {sortedTimeline.slice(0, timelineLimit).map((event) => (
                <TimelineRow key={event.id} event={event} />
              ))}
              {sortedTimeline.length === 0 && <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-500">Bez timeline udalostí.</div>}
            </div>
            <Fact label="Zhrnutie" value={caseItem.summary || "Bez zhrnutia"} wide />
          </InfoBlock>

          <InfoBlock className="xl:col-span-4" icon={CreditCard} title="Doklady a platba">
            <Fact label="Platba" value={paymentText} />
            <Fact label="Cenník" value={model.price ? formatCurrency(model.price.total) : "Nevypočítaný"} detail={model.price ? `${formatCurrency(model.price.subtotal)} bez DPH` : undefined} />
            <Fact label="Uzávierka" value={closureText} detail={caseItem.closureDetails.note} />
            {caseItem.closureDetails.insurancePortalUrl && <Fact label="Portál" value={caseItem.closureDetails.insurancePortalUrl} wide />}
            <Fact label="Prílohy" value={`${caseItem.attachments.length} položiek`} />
            <div className="grid gap-1.5">
              {caseItem.attachments.slice(0, attachmentLimit).map((attachment) => (
                <AttachmentRow key={attachment.id} attachment={attachment} />
              ))}
              {caseItem.attachments.length === 0 && <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-500">Zatiaľ bez príloh.</div>}
            </div>
          </InfoBlock>
          </div>
        </details>
      </div>
      <SmsComposerDialog caseId={caseItem.id} caseNumber={caseItem.caseNumber} initialPhone={contactPhone} locationPhone={contactPhone} onClose={() => setSmsComposerOpen(false)} onSent={(result) => result.dispatchData && onDataChange(result.dispatchData)} open={smsComposerOpen} />
    </section>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase text-zinc-400">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function ContactRow({ contact, fallbackPrimary }: { contact: Contact | CustomerContact; fallbackPrimary: boolean }) {
  const note = contactNote(contact);
  const role = contactRoleLabel(contact.role);

  return (
    <div className="rounded-md border border-zinc-100 bg-white px-2 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-semibold text-zinc-950">{contact.name}</span>
        {("isPrimary" in contact ? contact.isPrimary : fallbackPrimary) && (
          <span className="shrink-0 rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-900">Primárny</span>
        )}
      </div>
      <div className="mt-0.5 truncate text-zinc-600">
        {role} · {contact.phone}
        {contact.email ? ` · ${contact.email}` : ""}
      </div>
      {note && <div className="mt-0.5 line-clamp-2 text-zinc-500">{note}</div>}
    </div>
  );
}

function contactNote(contact: Contact | CustomerContact) {
  if ("notes" in contact) {
    return contact.notes;
  }

  return (contact as CustomerContact).note;
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-2 rounded-md border border-zinc-100 bg-white px-2 py-1.5 text-xs">
      <span className="font-semibold text-zinc-400">{formatTime(event.time)}</span>
      <span className="min-w-0">
        <span className="block truncate font-semibold text-zinc-950">{event.actor}: {event.title}</span>
        <span className="block line-clamp-2 text-zinc-600">{event.body}</span>
      </span>
    </div>
  );
}

function AttachmentRow({ attachment }: { attachment: CaseAttachmentMetadata }) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md border border-zinc-100 bg-white px-2 py-1.5 text-xs text-zinc-700">
      <Paperclip size={13} className="mt-0.5 shrink-0 text-zinc-400" />
      <span className="min-w-0">
        <span className="block truncate font-semibold text-zinc-950">{attachment.fileName}</span>
        <span className="block truncate text-zinc-500">
          {attachmentCategoryLabels[attachment.category]}
          {attachment.mimeType ? ` · ${attachment.mimeType}` : ""}
          {attachment.note ? ` · ${attachment.note}` : ""}
        </span>
      </span>
    </div>
  );
}

function InfoBlock({ children, className = "", icon: Icon, title }: { children: ReactNode; className?: string; icon: LucideIcon; title: string }) {
  return (
    <section className={`grid content-start gap-2 rounded-md border border-zinc-200 bg-white p-2.5 ${className}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">
        <Icon size={14} />
        {title}
      </div>
      {children}
    </section>
  );
}

function QuickAction({
  busy = false,
  compact = false,
  disabled = false,
  href,
  icon: Icon,
  label,
  onClick,
  title,
  tone = "neutral",
}: {
  busy?: boolean;
  compact?: boolean;
  disabled?: boolean;
  href?: string;
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  title?: string;
  tone?: "neutral" | "yellow";
}) {
  const className =
    tone === "yellow"
      ? "border-yellow-300 bg-[#FCD703] text-zinc-950 hover:bg-yellow-300"
      : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50";

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={title ?? label}
        className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      >
        {busy ? <Loader2 size={compact ? 15 : 14} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={compact ? 15 : 14} aria-hidden="true" />}
        {!compact && <span className="max-w-[120px] truncate">{label}</span>}
      </button>
    );
  }

  if (!href) {
    return (
      <button
        type="button"
        disabled
        aria-label={label}
        title={title ?? label}
        className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold opacity-50 ${className}`}
      >
        <Icon size={compact ? 15 : 14} aria-hidden="true" />
        {!compact && <span className="max-w-[120px] truncate">{label}</span>}
      </button>
    );
  }

  return (
    <a href={href} aria-label={label} title={title ?? label} className={`inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold ${className}`}>
      <Icon size={compact ? 15 : 14} aria-hidden="true" />
      {!compact && <span className="max-w-[120px] truncate">{label}</span>}
    </a>
  );
}

function Fact({ detail, label, value, wide = false }: { detail?: string; label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0" : "grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-2"}>
      <div className="text-[11px] font-semibold uppercase text-zinc-400">{label}</div>
      <div className="min-w-0 text-xs font-semibold leading-5 text-zinc-900">
        <div className="line-clamp-2">{value}</div>
        {detail && <div className="line-clamp-2 font-medium text-zinc-500">{detail}</div>}
      </div>
    </div>
  );
}

function ChipList({ empty, items }: { empty: string; items: string[] }) {
  const visibleItems = items.length > 0 ? items : [empty];

  return (
    <div className="flex flex-wrap gap-1">
      {visibleItems.map((item) => (
        <span key={item} className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-600">
          {item}
        </span>
      ))}
    </div>
  );
}

function cleanPhone(phone: string) {
  return phone.replace(/[^\d+]/g, "");
}

function getCustomerIdentity(caseItem: DispatchCase) {
  if (caseItem.customerDetails.type === "company") {
    return {
      name: caseItem.customerDetails.companyName || caseItem.contact.name,
      detail: [caseItem.customerDetails.companyIdNumber ? `IČO ${caseItem.customerDetails.companyIdNumber}` : undefined, caseItem.customerDetails.note].filter(Boolean).join(" · ") || undefined,
    };
  }

  if (caseItem.customerDetails.type === "insurance") {
    return {
      name: caseItem.customerDetails.assistanceServiceName || caseItem.contact.name,
      detail: [caseItem.customerDetails.assistanceReference ? `Číslo prípadu ${caseItem.customerDetails.assistanceReference}` : undefined, caseItem.customerDetails.note]
        .filter(Boolean)
        .join(" · ") || undefined,
    };
  }

  return {
    name: [caseItem.customerDetails.firstName, caseItem.customerDetails.lastName].filter(Boolean).join(" ") || caseItem.contact.name,
    detail: caseItem.customerDetails.note,
  };
}

function contactRoleLabel(role: Contact["role"] | CustomerContact["role"]) {
  if (role in customerContactRoleLabels) {
    return customerContactRoleLabels[role as CustomerContact["role"]];
  }

  const fallbackLabels: Record<Contact["role"], string> = {
    assistance: "Asistenčná služba",
    branch: "Pobočka",
    client: "Klient",
    partner: "Partner",
  };

  return fallbackLabels[role as Contact["role"]];
}

function closureTypeLabel(type: ClosureType) {
  const labels: Record<ClosureType, string> = {
    insurance_portal: "Asistenčná služba",
    internal: "Interné",
    self_payer: "Samoplatca",
  };

  return labels[type];
}

function labelList<T extends string>(items: T[] | undefined, labels: Record<T, string>, fallback = "Nezadané") {
  return items && items.length > 0 ? items.map((item) => labels[item] ?? item).join(", ") : fallback;
}
