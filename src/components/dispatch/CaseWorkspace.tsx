"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Building2, ChevronDown, ChevronUp, ClipboardList, LayoutGrid, MessageSquareText, Route, UserRound, CarFront, ShieldCheck, MapPin, ArrowRight } from "lucide-react";
import type { DispatchCase, FleetAsset, Operator } from "@/domain/types";
import { jobTypeLabels, paymentMethodLabels, paymentStatusLabels } from "@/domain/case-card";
import { isTaskOpen } from "@/domain/tasks";
import { caseStatusLabels, caseStatusTone } from "@/domain/statuses";
import { formatDateTime, formatTime } from "@/lib/dispatch-calculations";
import styles from "./case-workspace.module.css";

type TabId = "overview" | "work" | "tasks" | "partner" | "notes" | "sms";
type Props = {
  caseItem: DispatchCase;
  assets: FleetAsset[];
  operators: Operator[];
  handoff: ReactNode;
  tasks: ReactNode;
  work: ReactNode;
  partner: ReactNode;
  notes?: ReactNode;
  sms: ReactNode;
  focusedTaskId?: string;
};

/** Visited panels stay mounted so switching tabs never discards a draft or pending command. */
export function CaseWorkspace({ caseItem, assets, operators, handoff, tasks, work, partner, notes, sms, focusedTaskId }: Props) {
  const id = useId();
  const [selected, setSelected] = useState<TabId>(focusedTaskId ? "tasks" : "overview");
  const [lastFocusedTask, setLastFocusedTask] = useState(focusedTaskId);
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set(["overview", ...(focusedTaskId ? ["tasks" as const] : [])]));
  const [collapsed, setCollapsed] = useState(false);
  if (lastFocusedTask !== focusedTaskId) {
    setLastFocusedTask(focusedTaskId);
    if (focusedTaskId) {
      setSelected("tasks");
      setVisited(current => new Set([...current, "tasks"]));
    }
  }
  const contact = caseItem.customerDetails.contacts?.find(item => item.isPrimary) ?? caseItem.customerDetails.contacts?.[0] ?? caseItem.contact;
  const customer = caseItem.customerDetails.companyName || [caseItem.customerDetails.firstName, caseItem.customerDetails.lastName].filter(Boolean).join(" ") || contact.name;
  const owner = operators.find(item => item.id === caseItem.ownerId)?.name || caseItem.ownerName || "Nepriradený";
  const pickup = caseItem.pickup?.address || caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress;
  const destination = caseItem.destination?.address || caseItem.destination?.label;
  const asset = assets.find(item => item.id === caseItem.selectedAssetId);
  const panels: Record<TabId, ReactNode> = {
    overview: <div className={styles.overview}>
      <div className={styles.nextStep}><span className={styles.stepIcon}><ClipboardList size={20} /></span><div><h3>Ďalší krok</h3><p>{caseItem.nextStep || "Ďalší krok zatiaľ nie je určený."}</p></div><button type="button" onClick={() => { selectTab("work"); document.getElementById(`${id}-tab-work`)?.focus(); }}>Otvoriť prácu <ArrowRight size={15} /></button></div>
      <dl className={styles.details}>
        <div><dt>Pridelená technika</dt><dd>{asset ? [asset.label, asset.assignedDriverName].filter(Boolean).join(" · ") : "Nepriradená"}</dd></div>
        <div><dt>Platba</dt><dd>{[caseItem.paymentDetails.method && paymentMethodLabels[caseItem.paymentDetails.method], caseItem.paymentDetails.status && paymentStatusLabels[caseItem.paymentDetails.status]].filter(Boolean).join(" · ") || "Zatiaľ neurčená"}</dd></div>
        {caseItem.closureDetails.closedAt && <div><dt>Uzavreté</dt><dd>{formatDateTime(caseItem.closureDetails.closedAt)}</dd></div>}
      </dl>
      {caseItem.summary && <div className={styles.description}><ExpandableText text={caseItem.summary} /></div>}
    </div>, work, tasks, partner, notes, sms,
  };
  const mainPanelId = `${id}-panel-main`;
  const mainTab = selected === "overview" || selected === "work";
  const tabs = [
    { id: "overview" as const, label: "Prehľad", icon: LayoutGrid },
    { id: "work" as const, label: "Práca a jazdy", icon: Route },
    { id: "tasks" as const, label: "Úlohy", icon: ClipboardList, count: caseItem.tasks.filter(isTaskOpen).length },
    { id: "partner" as const, label: "Partner", icon: Building2 },
    ...(notes ? [{ id: "notes" as const, label: "Poznámky a aktivita", icon: MessageSquareText }] : []),
    { id: "sms" as const, label: "SMS", icon: MessageSquareText },
  ];
  function selectTab(tab: TabId) {
    setSelected(tab);
    setVisited(current => current.has(tab) ? current : new Set([...current, tab]));
  }
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next].id);
    document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus();
  }
  return <section className={styles.workspace} data-case-workspace aria-label="Prehľad a správa prípadu">
    <div data-testid="case-summary" aria-label="Prehľad prípadu">
      <header className={styles.header}>
        <div className={styles.identity}><div className={styles.meta}><span>{caseItem.caseNumber}</span><span className={`${styles.status} ${caseStatusTone[caseItem.status]}`}>{caseStatusLabels[caseItem.status]}</span><span>{formatDateTime(caseItem.createdAt)}</span></div><h2>{caseItem.jobTypes.map(type => jobTypeLabels[type]).join(" · ") || caseItem.caseType || "Detail prípadu"}</h2></div>
        <div className={styles.actions}>{handoff}</div>
      </header>
      <div hidden={collapsed} className={styles.savedFacts} id={`${id}-facts`}>
        <dl className={styles.facts}>
          <div><UserRound size={18} /><div><dt>Klient / telefón</dt><dd><ExpandableText text={customer || "Klient zatiaľ nedoplnený"} /></dd><small>{contact.phone || "Telefón zatiaľ nedoplnený"}</small></div></div>
          <div><CarFront size={18} /><div><dt>Vozidlo klienta</dt><dd><ExpandableText text={[caseItem.vehicle.licensePlate, caseItem.vehicle.make, caseItem.vehicle.model].filter(Boolean).join(" · ") || "Vozidlo zatiaľ nedoplnené"} /></dd><small>{caseItem.replacementVehicle.needed ? "Požadované náhradné vozidlo" : "Náhradné vozidlo nepožadované"}</small></div></div>
          <div><ShieldCheck size={18} /><div><dt>Asistencia · referencia</dt><dd><ExpandableText text={[caseItem.customerDetails.assistanceServiceName, caseItem.customerDetails.assistanceReference].filter(Boolean).join(" · ") || "Zatiaľ nedoplnená"} /></dd><small>Dispečer: {owner}</small></div></div>
        </dl>
        <div className={styles.route}><MapPin size={15} /><span>{pickup || "Miesto zatiaľ nedoplnené"}</span><ArrowRight size={14} /><span>{destination || "Cieľ zatiaľ nedoplnený"}</span></div>
      </div>
    </div>
    <div role="tablist" aria-label="Časti prípadu" className={styles.tabs}>{tabs.map(({ id: tab, label, icon: Icon, ...rest }, index) => <button key={tab} type="button" id={`${id}-tab-${tab}`} role="tab" aria-selected={selected === tab} aria-controls={tab === "overview" || tab === "work" ? mainPanelId : `${id}-panel-${tab}`} tabIndex={selected === tab ? 0 : -1} onClick={() => selectTab(tab)} onKeyDown={event => onTabKey(event, index)}><Icon size={15} />{label}{"count" in rest && <span>{rest.count}</span>}</button>)}</div>
    <div id={mainPanelId} role="tabpanel" aria-labelledby={`${id}-tab-${selected === "work" ? "work" : "overview"}`} hidden={!mainTab} className={styles.panel}>
      <div hidden={selected !== "overview"} className={styles.overviewFacts}>{panels.overview}</div>
      <div className={styles.workOverview}>{work}</div>
    </div>
    {tabs.filter(({id:tab})=>tab!=="overview"&&tab!=="work").map(({ id: tab }) => <div key={tab} id={`${id}-panel-${tab}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} hidden={selected !== tab} className={styles.panel}>{visited.has(tab) ? panels[tab] : null}</div>)}
    <footer className={styles.footer}><span>Uložené údaje · {formatTime(caseItem.updatedAt)}</span><button type="button" aria-expanded={!collapsed} aria-controls={`${id}-facts`} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}{collapsed ? "Rozbaliť prehľad" : "Zbaliť prehľad"}</button></footer>
  </section>;
}

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 180;
  return <><span className={styles.breakText}>{long && !expanded ? `${text.slice(0, 180)}…` : text}</span>{long && <button type="button" className={styles.expand} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Zobraziť menej" : "Zobraziť viac"}</button>}</>;
}
