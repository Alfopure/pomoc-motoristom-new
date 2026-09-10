"use client";

import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Headphones, Loader2, Mail, Maximize2, MessageSquareText, Minimize2, Smartphone } from "lucide-react";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type { Branch, DispatchCase, FleetAsset, Operator, PartnerDirectoryEntry, PriceRule } from "@/domain/types";
import { casePriorityLabels, caseStatusLabels, caseStatusTone, priorityTone } from "@/domain/statuses";
import type { DispatchMapModel } from "@/lib/map-adapter";
import type { PhoneBarCall } from "@/lib/telephony/active-calls-model";
import { requestCallbackTargetConfirmation } from "@/lib/telephony/callback-target-client";
import { CaseEditorHeader, type CaseEditorControls } from "./CaseEditorHeader";
import { CaseDetail } from "./CaseDetail";
import type { SaveCaseDraft } from "./NewCaseDrawer";
import { SmsComposerDialog } from "./SmsComposerDialog";
import styles from "./case-detail.module.css";

type WorkspaceMode = "collapsed" | "split" | "expanded";

type CaseCockpitPanelProps = {
  assets: FleetAsset[];
  branches: Branch[];
  caseItem: DispatchCase;
  callLinkCandidates?: PhoneBarCall[];
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
  onLinkCall?: (call: PhoneBarCall, caseId: string) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  onExpand: () => void;
  onRestore: () => void;
  onSaveDraftChange: (saveDraft: SaveCaseDraft | null) => void;
  onSavingChange: (saving: boolean) => void;
  viewerProfileId?: string;
};

export function CaseCockpitPanel({
  assets,
  branches,
  caseItem,
  callLinkCandidates,
  commanderVehicles,
  focusedTaskId,
  mode,
  model,
  onCollapse,
  onDataChange,
  onDial,
  onLinkCall,
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
  const [editorControls, setEditorControls] = useState<CaseEditorControls | null>(null);
  const [smsComposerOpen, setSmsComposerOpen] = useState(false);
  const [isDialingFromHeader, setIsDialingFromHeader] = useState(false);
  const [nativeCallBusy, setNativeCallBusy] = useState(false);
  const [nativeCallError, setNativeCallError] = useState<string | null>(null);
  const nativeSequence = useRef(0);
  const owner = operators.find((operator) => operator.id === caseItem.ownerId)?.name ?? caseItem.ownerName ?? "Nepriradené";
  const selectedAsset = caseItem.selectedAssetId ? assets.find((asset) => asset.id === caseItem.selectedAssetId) : undefined;
  const asset = selectedAsset ?? model.nearestAsset?.asset;
  const primaryContact = caseItem.customerDetails.contacts?.find((contact) => contact.isPrimary) ?? caseItem.customerDetails.contacts?.[0];
  const contactName = primaryContact?.name || caseItem.contact.name;
  const contactPhone = primaryContact?.phone || caseItem.contact.phone;
  useEffect(() => () => { nativeSequence.current++; }, [caseItem.id, contactPhone]);
  async function callFromNativePhone() {
    if (!contactPhone || nativeCallBusy) return;
    const sequence = nativeSequence.current;
    setNativeCallBusy(true); setNativeCallError(null);
    try {
      const target = await requestCallbackTargetConfirmation(contactPhone);
      if (target && sequence === nativeSequence.current) window.location.href = `tel:${cleanPhone(target.dialNumber)}`;
    } catch (error) {
      if (sequence === nativeSequence.current) setNativeCallError(error instanceof Error ? error.message : "Číslo sa nepodarilo overiť.");
    } finally { setNativeCallBusy(false); }
  }
  const contactEmail = primaryContact?.email || caseItem.contact.email;
  const customerName = caseItem.customerDetails.companyName || caseItem.customerDetails.assistanceServiceName || contactName;
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
        mobileLabel="Web"
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
        onClick={() => void callFromNativePhone()}
        disabled={!contactPhone || nativeCallBusy}
        busy={nativeCallBusy}
        icon={Smartphone}
        label="Volať cez mobil"
        mobileLabel="Mobil"
        title={contactPhone ? "Volať cez mobilný telefón" : "Najprv doplňte telefónne číslo"}
      />
    </div>
  );

  return (
    <>
      {nativeCallError && <p role="alert" className="shrink-0 bg-amber-50 px-3 py-2 text-sm text-amber-950">{nativeCallError}</p>}
      {mode === "collapsed" && (
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
          <div className="hidden items-center gap-2 lg:flex">
            {callActions}
            <QuickAction onClick={() => setSmsComposerOpen(true)} icon={MessageSquareText} label="SMS" compact tone="yellow" />
          </div>
          <button
            type="button"
            onClick={onRestore}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-zinc-950 text-white hover:bg-zinc-800 lg:h-9 lg:w-9"
            aria-label="Maximalizovať spodnú lištu"
            title="Maximalizovať spodnú lištu"
          >
            <Maximize2 size={15} />
          </button>
        </section>
      )}
    <section hidden={mode === "collapsed"} inert={mode === "collapsed" ? true : undefined} className={`${styles.surface} ${mode === "collapsed" ? "hidden" : "flex"} h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white lg:rounded-md lg:border lg:border-zinc-200 lg:shadow-sm`}>
      <div className={`${styles.cockpitHeader} shrink-0 border-b border-zinc-200 bg-white`}>
        <div className={styles.cockpitTopline}>
          <div className="min-w-0 flex-1">
            <div className={styles.caseIdentity}>
              <span className={styles.caseNumber}>{caseItem.caseNumber}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 lg:px-2 lg:text-xs ${caseStatusTone[caseItem.status]}`}>
                {caseStatusLabels[caseItem.status]}
              </span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold lg:px-2 lg:text-xs ${priorityTone[caseItem.priority]}`}>
                {casePriorityLabels[caseItem.priority]}
              </span>
              <span className={styles.caseCustomer}>{customerName}</span>
            </div>
            <div className={styles.caseMeta}>
              <span>{routeSummary}</span>
              <span>{owner}</span>
              <span className="truncate">{asset ? (selectedAsset ? asset.label : `Návrh: ${asset.label}`) : "Bez dostupnej techniky"}</span>
            </div>
          </div>
          <div className={styles.headerActions}>
            {callActions}
            <QuickAction onClick={() => setSmsComposerOpen(true)} icon={MessageSquareText} label="SMS" tone="yellow" />
            {contactEmail && <QuickAction href={`mailto:${contactEmail}`} icon={Mail} label="Email" mobileLabel="" />}
            <button
              type="button"
              onClick={onCollapse}
              className={`${styles.headerIcon} hidden items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50 lg:inline-flex`}
              aria-label="Minimalizovať na spodnú lištu"
              title="Minimalizovať na spodnú lištu"
            >
              <Minimize2 size={16} />
            </button>
            {mode !== "expanded" && (
              <button
                type="button"
                onClick={onExpand}
                className={`${styles.headerIcon} hidden items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50 lg:inline-flex`}
                aria-label="Maximalizovať kokpit"
                title="Maximalizovať kokpit"
              >
                <Maximize2 size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {editorControls && <div className={`${styles.headerControlRow} shrink-0`}><CaseEditorHeader controls={editorControls} /></div>}
      <div data-case-detail-scroll-region className={`${styles.scrollRegion} min-h-0 flex-1 overflow-y-auto overscroll-contain bg-zinc-50`}>
        <CaseDetail
          onEditorControlsChange={setEditorControls}
          key={caseItem.id}
          assets={assets}
          branches={branches}
          caseItem={caseItem}
          callLinkCandidates={callLinkCandidates}
          commanderVehicles={commanderVehicles}
          compactEditor
          editing
          embedded
          focusedTaskId={focusedTaskId}
          onDataChange={onDataChange}
          onDial={onDial}
          onLinkCall={onLinkCall}
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

      </div>
    </section>
      <SmsComposerDialog caseId={caseItem.id} caseNumber={caseItem.caseNumber} initialPhone={contactPhone} locationPhone={contactPhone} onClose={() => setSmsComposerOpen(false)} onSent={(result) => result.dispatchData && onDataChange(result.dispatchData)} open={smsComposerOpen} />
    </>
  );
}

function QuickAction({
  busy = false,
  compact = false,
  disabled = false,
  href,
  icon: Icon,
  label,
  mobileLabel,
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
  mobileLabel?: string;
  onClick?: () => void;
  title?: string;
  tone?: "neutral" | "yellow";
}) {
  const className =
    tone === "yellow"
      ? "border-yellow-300 bg-[#FCD703] text-zinc-950 hover:bg-yellow-300"
      : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50";
  const text = !compact && (
    <span className={`${mobileLabel === "" ? "hidden lg:inline" : ""} max-w-[120px] truncate text-[11px] font-semibold lg:text-xs`}>
      <span className="lg:hidden">{mobileLabel ?? label}</span>
      <span className="hidden lg:inline">{label}</span>
    </span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={title ?? label}
        className={`${styles.headerAction} inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 lg:px-2.5 ${className}`}
      >
        {busy ? <Loader2 size={compact ? 15 : 14} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={compact ? 15 : 14} aria-hidden="true" />}
        {text}
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
        className={`${styles.headerAction} inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold opacity-50 ${className}`}
      >
        <Icon size={compact ? 15 : 14} aria-hidden="true" />
        {text}
      </button>
    );
  }

  return (
    <a href={href} aria-label={label} title={title ?? label} className={`${styles.headerAction} inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold ${className}`}>
      <Icon size={compact ? 15 : 14} aria-hidden="true" />
      {text}
    </a>
  );
}

function cleanPhone(phone: string) {
  return phone.replace(/[^\d+]/g, "");
}
