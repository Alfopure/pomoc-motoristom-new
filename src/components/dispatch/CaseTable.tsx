"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, CarFront, ChevronRight, Columns3, ListChecks, MapPin, RotateCcw, Search, X } from "lucide-react";
import type { CallCenterCall } from "@/data/dispatch-types";
import type { Branch, DispatchCase, FleetAsset, Operator } from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import { casePriorityLabels, caseStatusLabels, caseStatusTone, priorityTone } from "@/domain/statuses";
import { requiresTowDestination } from "@/domain/case-card";
import { isTaskOpen } from "@/domain/tasks";
import { caseTableColumns, defaultCaseTableColumns, moveCaseTableColumn, parseCaseTableColumns, type CaseSortKey, type CaseSortState } from "./case-table-columns";
import styles from "./case-table.module.css";

export type { CaseSortKey, CaseSortState } from "./case-table-columns";
type CaseTableProps = {
  activeCaseId: string;
  assets: FleetAsset[];
  branches: Branch[];
  calls: CallCenterCall[];
  cases: DispatchCase[];
  operators: Operator[];
  sort: CaseSortState;
  storageKey?: string;
  totalCases: number;
  workspaceMode?: "collapsed" | "split" | "expanded";
  onOpenDetails: (caseId: string) => void;
  onSortChange: (sort: CaseSortState) => void;
};
const sourceLabels: Record<NonNullable<DispatchCase["sourceType"]>, string> = {
  client: "Klient", assistance: "Asistenčka", samoplatca: "Samoplatca", partner: "Partner", internal: "Interné",
};
const DEFAULT_STORAGE_KEY = "motorist:dispatch-case-table:visible-columns:v1";
const columnDefinitions = new Map(caseTableColumns.map(column => [column.key, column]));

export function CaseTable({ activeCaseId, assets, branches, calls, cases, operators, onOpenDetails, onSortChange, sort, storageKey = DEFAULT_STORAGE_KEY, totalCases, workspaceMode = "collapsed" }: CaseTableProps) {
  const [visibleColumns, setVisibleColumns] = useState<CaseSortKey[]>(defaultCaseTableColumns);
  const [columnsOpen, setColumnsOpen] = useState(false), [columnSearch, setColumnSearch] = useState("");
  const columnsId = useId();
  const callsByCaseId = latestCallByCaseId(calls);
  const ownersById = new Map(operators.map(operator => [operator.id, operator.name]));
  const branchesById = new Map(branches.map(branch => [branch.id, branch.name]));
  const assetsById = new Map(assets.map(asset => [asset.id, asset.label]));

  useEffect(() => {
    const sync = () => {
      try { setVisibleColumns(parseCaseTableColumns(window.localStorage.getItem(storageKey))); }
      catch { setVisibleColumns([...defaultCaseTableColumns]); }
    };
    const frame = window.requestAnimationFrame(sync);
    const onStorage = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) sync(); };
    window.addEventListener("storage", onStorage);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener("storage", onStorage); };
  }, [storageKey]);

  function changeColumns(next: CaseSortKey[]) {
    setVisibleColumns(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Session selection still works without storage. */ }
  }
  function closeColumns() {
    setColumnsOpen(false);
    document.getElementById(`${columnsId}-trigger`)?.focus();
  }
  function toggleColumn(key: CaseSortKey) {
    if (key === "caseNumber") return;
    changeColumns(visibleColumns.includes(key) ? visibleColumns.filter(column => column !== key) : [...visibleColumns, key]);
  }
  const orderedColumns = [...visibleColumns, ...caseTableColumns.map(column => column.key).filter(key => !visibleColumns.includes(key))];
  const matchingColumns = orderedColumns.filter(key => normalize(columnDefinitions.get(key)!.label).includes(normalize(columnSearch)));
  const width = visibleColumns.reduce((sum, key) => sum + columnDefinitions.get(key)!.width, 0);
  const caseRows = cases.map(caseItem => {
    const call = callsByCaseId.get(caseItem.id);
    return { active: caseItem.id === activeCaseId, call, caller: callerInfo(caseItem, call), caseItem,
      latestTimeline: latestTimelineEvent(caseItem), needsDestination: requiresTowDestination(caseItem.jobTypes),
      openTasks: caseItem.tasks.filter(isTaskOpen), ownerName: ownersById.get(caseItem.ownerId) ?? "Nepriradené" };
  });

  function cell(key: CaseSortKey, row: typeof caseRows[number]): ReactNode {
    const { call, caller, caseItem, latestTimeline, needsDestination, openTasks, ownerName } = row;
    switch (key) {
      case "caseNumber": return <button type="button" className={styles.caseButton} aria-label={`Otvoriť prípad ${caseItem.caseNumber}`} onClick={event => { event.stopPropagation(); onOpenDetails(caseItem.id); }}><span className={styles.primary}>{caseItem.caseNumber}</span><span className={styles.secondary} title={caseItem.summary}>{caseItem.summary || caseItem.caseType || "Bez popisu"}</span></button>;
      case "status": return <span className={`${styles.badge} ${caseStatusTone[caseItem.status]}`} title={caseStatusLabels[caseItem.status]}>{caseStatusLabels[caseItem.status]}</span>;
      case "priority": return <span className={`${styles.badge} ${priorityTone[caseItem.priority]}`}>{casePriorityLabels[caseItem.priority]}</span>;
      case "createdAt": return <span title={formatDateTime(caseItem.createdAt)}>{formatDateTime(caseItem.createdAt)}</span>;
      case "updatedAt": return <span title={formatDateTime(caseItem.updatedAt)}>{formatDateTime(caseItem.updatedAt)}</span>;
      case "caller": return <CellText primary={caller.name || "Bez mena"} secondary={caller.phone || "Bez telefónu"} />;
      case "callStartedAt": return call ? formatDateTime(call.startedAt) : "Bez prepojeného hovoru";
      case "answeredAt": return <CellText primary={`Prijaté: ${formatTimeOrDash(call?.answeredAt)}`} secondary={`Koniec: ${formatTimeOrDash(call?.endedAt)}`} />;
      case "owner": return <CellText primary={call?.operatorName ?? ownerName} secondary={call?.operatorName && call.operatorName !== ownerName ? `Zodpovedný: ${ownerName}` : undefined} />;
      case "caseType": return <CellText primary={caseItem.caseType || "Nezadané"} secondary={caseItem.sourceType ? sourceLabels[caseItem.sourceType] : "Nezadaný zdroj"} />;
      case "vehicle": return <CellText primary={vehicleLabel(caseItem)} secondary={caseItem.vehicle.issue || undefined} />;
      case "pickup": return <CellText primary={caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress || "Nezadané"} secondary={caseItem.pickup?.address || undefined} />;
      case "destination": return needsDestination ? <CellText primary={caseItem.destination?.label || caseItem.locationDetails.manualDestinationAddress || "Nezadané"} secondary={caseItem.destination?.address || undefined} /> : "Asistencia na mieste";
      case "branch": return <CellText primary={caseItem.branchId ? branchesById.get(caseItem.branchId) ?? "Neznáma pobočka" : "Bez pobočky"} />;
      case "asset": return <CellText primary={caseItem.selectedAssetId ? assetsById.get(caseItem.selectedAssetId) ?? "Neznáma technika" : "Nepriradené"} />;
      case "nextStep": return <CellText primary={caseItem.nextStep || "Zatiaľ neurčený"} />;
      case "openTasks": return <CellText primary={`${openTasks.length} otvorené`} secondary={openTasks[0] ? `${openTasks[0].title} · ${formatTimeOrDash(openTasks[0].dueAt)}` : "Bez otvorenej úlohy"} />;
      case "latestActivityAt": return <CellText primary={latestTimeline ? `${formatDateTime(latestTimeline.time)} · ${latestTimeline.actor}` : caseItem.mainNote ? "Poznámka prípadu" : "Bez aktivity"} secondary={latestTimeline ? `${latestTimeline.title}: ${latestTimeline.body}` : caseItem.mainNote || undefined} />;
    }
  }
  return <section className={styles.root} data-workspace-mode={workspaceMode} aria-label="Tabuľkový prehľad prípadov">
    <div className={styles.toolbar}>
      <div className={styles.count}><span><strong>{cases.length}</strong> z {totalCases} prípadov</span>{sort.key !== "priority" && cases.some(item => item.priority === "urgent") && <span className={styles.sortHint}>Naliehavé prípady sú vždy navrchu</span>}</div>
      <button id={`${columnsId}-trigger`} type="button" className={styles.control} aria-expanded={columnsOpen} aria-controls={columnsId} onClick={() => setColumnsOpen(value => !value)}><Columns3 size={15} aria-hidden="true" />Stĺpce ({visibleColumns.length})</button>
    </div>
    {columnsOpen && <section id={columnsId} className={styles.columnPanel} aria-label="Nastavenie stĺpcov" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeColumns(); } }}>
      <div className={styles.columnToolbar}>
        <label className={styles.columnSearch}><Search size={15} aria-hidden="true" /><input aria-label="Nájsť stĺpec" placeholder="Nájsť stĺpec…" value={columnSearch} onChange={event => setColumnSearch(event.target.value)} /></label>
        <button type="button" className={styles.control} onClick={() => changeColumns([...defaultCaseTableColumns])}><RotateCcw size={14} aria-hidden="true" />Obnoviť základ</button>
        <button type="button" className={styles.control} onClick={() => changeColumns(caseTableColumns.map(column => column.key))}>Všetky</button>
        <button type="button" className={styles.iconButton} aria-label="Zavrieť nastavenie stĺpcov" onClick={closeColumns}><X size={16} aria-hidden="true" /></button>
      </div>
      <p className={styles.columnHint}>Zaškrtnite stĺpce a šípkami upravte ich poradie. Prípad zostáva vždy prvý.</p>
      <div className={styles.columnList}>
        {matchingColumns.map(key => {
          const column = columnDefinitions.get(key)!, index = visibleColumns.indexOf(key), visible = index >= 0;
          return <div key={key} className={styles.columnOption}>
            <label><input type="checkbox" checked={visible} disabled={key === "caseNumber"} onChange={() => toggleColumn(key)} />{column.label}</label>
            {visible && key !== "caseNumber" && <span className={styles.moveButtons}>
              <button type="button" className={styles.iconButton} aria-label={`Posunúť ${column.label} doľava`} disabled={index <= 1} onClick={() => changeColumns(moveCaseTableColumn(visibleColumns, key, -1))}><ArrowLeft size={13} aria-hidden="true" /></button>
              <button type="button" className={styles.iconButton} aria-label={`Posunúť ${column.label} doprava`} disabled={index === visibleColumns.length - 1} onClick={() => changeColumns(moveCaseTableColumn(visibleColumns, key, 1))}><ArrowRight size={13} aria-hidden="true" /></button>
            </span>}
          </div>;
        })}
        {!matchingColumns.length && <p className={styles.columnHint}>Žiadny stĺpec nevyhovuje hľadaniu.</p>}
      </div>
    </section>}
    <div className={styles.scroll}>
      <div className={styles.mobileList}>
        {caseRows.map(({ active, caller, caseItem, openTasks, ownerName }) => <button key={caseItem.id} type="button" onClick={() => onOpenDetails(caseItem.id)} aria-label={`Otvoriť prípad ${caseItem.caseNumber}`} className={styles.mobileCard} data-active={active}>
          <span className={styles.mobileHeading}><strong>{caseItem.caseNumber}</strong><span className={`${styles.badge} ${caseStatusTone[caseItem.status]}`}>{caseStatusLabels[caseItem.status]}</span><ChevronRight size={14} aria-hidden="true" /></span>
          <span className={styles.mobileLine}><CarFront size={13} aria-hidden="true" /><span title={`${vehicleLabel(caseItem)} · ${caller.name}`}>{vehicleLabel(caseItem)} · {caller.name}</span></span>
          <span className={styles.mobileLine}><MapPin size={13} aria-hidden="true" /><span title={caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress}>{caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress || "Miesto nezadané"}</span></span>
          <span className={styles.mobileFooter}><span title={`${ownerName} · ${formatDateTime(caseItem.updatedAt)}`}>{ownerName} · {formatDateTime(caseItem.updatedAt)}</span><span className={`${styles.badge} ${priorityTone[caseItem.priority]}`}>{casePriorityLabels[caseItem.priority]}</span><span><ListChecks size={12} aria-hidden="true" />{openTasks.length}</span></span>
        </button>)}
        {!caseRows.length && <p className={styles.empty}>Žiadne prípady nevyhovujú filtru.</p>}
      </div>
      <table className={styles.table} style={{ minWidth: width }} aria-label="Prehľad prípadov">
        <colgroup>{visibleColumns.map(key => <col key={key} style={{ width: columnDefinitions.get(key)!.width }} />)}</colgroup>
        <thead><tr>{visibleColumns.map(key => <SortableHeader key={key} label={columnDefinitions.get(key)!.label} sortKey={key} sort={sort} onSortChange={onSortChange} />)}</tr></thead>
        <tbody>{caseRows.map(row => <tr key={row.caseItem.id} data-active={row.active} onClick={() => onOpenDetails(row.caseItem.id)}>{visibleColumns.map(key => <td key={key} data-column={key}>{cell(key, row)}</td>)}</tr>)}
          {!caseRows.length && <tr><td colSpan={visibleColumns.length} className={styles.empty}>Žiadne prípady nevyhovujú filtru.</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}

function CellText({ primary, secondary }: { primary: string; secondary?: string }) {
  return <><span className={styles.primary} title={primary}>{primary}</span>{secondary && <span className={styles.secondary} title={secondary}>{secondary}</span>}</>;
}
function SortableHeader({ label, onSortChange, sort, sortKey }: { label: string; onSortChange: (sort: CaseSortState) => void; sort: CaseSortState; sortKey: CaseSortKey }) {
  const active = sort.key === sortKey, nextDirection = active && sort.direction === "asc" ? "desc" : "asc";
  const Icon = active ? sort.direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
  return <th scope="col" data-column={sortKey} aria-sort={active ? sort.direction === "asc" ? "ascending" : "descending" : undefined}><button type="button" onClick={() => onSortChange({ key: sortKey, direction: nextDirection })}>{label}<Icon size={12} aria-hidden="true" /></button></th>;
}
function normalize(value: string) { return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("sk").trim(); }
function vehicleLabel(caseItem: DispatchCase) { return [caseItem.vehicle.licensePlate?.trim(), [caseItem.vehicle.make, caseItem.vehicle.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "Nezadané"; }
function latestCallByCaseId(calls: CallCenterCall[]) {
  const result = new Map<string, CallCenterCall>();
  for (const call of calls) if (call.caseId) { const previous = result.get(call.caseId); if (!previous || new Date(call.startedAt).getTime() > new Date(previous.startedAt).getTime()) result.set(call.caseId, call); }
  return result;
}
function callerInfo(caseItem: DispatchCase, call?: CallCenterCall) { return call ? { name: call.callerName ?? caseItem.contact.name, phone: call.direction === "outbound" ? call.calledNumber : call.callerNumber } : caseItem.contact; }
function latestTimelineEvent(caseItem: DispatchCase) { return [...caseItem.timeline].sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime())[0]; }
function formatDateTime(value: string | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat("sk-SK", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: MOTORIST_TIME_ZONE }).format(new Date(value));
}
function formatTimeOrDash(value: string | undefined) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  return new Intl.DateTimeFormat("sk-SK", { hour: "2-digit", minute: "2-digit", timeZone: MOTORIST_TIME_ZONE }).format(new Date(value));
}
