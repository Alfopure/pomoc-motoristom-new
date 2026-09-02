"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Clock3, Columns3, Phone, UserRound } from "lucide-react";
import type { CallCenterCall } from "@/data/dispatch-types";
import type { Branch, DispatchCase, FleetAsset, Operator } from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import { casePriorityLabels, caseStatusLabels, caseStatusTone, priorityTone } from "@/domain/statuses";
import { requiresTowDestination } from "@/domain/case-card";
import { isTaskOpen } from "@/domain/tasks";

export type CaseSortKey =
  | "caseNumber"
  | "status"
  | "priority"
  | "createdAt"
  | "updatedAt"
  | "callStartedAt"
  | "answeredAt"
  | "caller"
  | "owner"
  | "caseType"
  | "vehicle"
  | "pickup"
  | "destination"
  | "branch"
  | "asset"
  | "nextStep"
  | "openTasks"
  | "latestActivityAt";

export type CaseSortState = {
  key: CaseSortKey;
  direction: "asc" | "desc";
};

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

type CaseSourceType = NonNullable<DispatchCase["sourceType"]>;

const sourceLabels: Record<CaseSourceType, string> = {
  client: "Klient",
  assistance: "Asistenčka",
  samoplatca: "Samoplatca",
  partner: "Partner",
  internal: "Interné",
};

const caseTableColumns: Array<{ defaultVisible: boolean; key: CaseSortKey; label: string }> = [
  { key: "caseNumber", label: "Prípad", defaultVisible: true },
  { key: "status", label: "Stav", defaultVisible: true },
  { key: "priority", label: "Priorita", defaultVisible: true },
  { key: "createdAt", label: "Založené", defaultVisible: true },
  { key: "updatedAt", label: "Upravené", defaultVisible: true },
  { key: "caller", label: "Volal", defaultVisible: true },
  { key: "callStartedAt", label: "Hovor", defaultVisible: false },
  { key: "answeredAt", label: "Prijaté / ukončené", defaultVisible: false },
  { key: "owner", label: "Operátor", defaultVisible: true },
  { key: "caseType", label: "Typ / zdroj", defaultVisible: true },
  { key: "vehicle", label: "Vozidlo", defaultVisible: true },
  { key: "pickup", label: "Pickup", defaultVisible: true },
  { key: "destination", label: "Cieľ", defaultVisible: true },
  { key: "branch", label: "Pobočka", defaultVisible: false },
  { key: "asset", label: "Technika", defaultVisible: true },
  { key: "nextStep", label: "Ďalší krok", defaultVisible: true },
  { key: "openTasks", label: "Úlohy", defaultVisible: true },
  { key: "latestActivityAt", label: "Posledná poznámka", defaultVisible: false },
];

const defaultVisibleColumns = caseTableColumns.filter((column) => column.defaultVisible).map((column) => column.key);
const DEFAULT_VISIBLE_COLUMNS_STORAGE_KEY = "motorist:dispatch-case-table:visible-columns:v1";

export function CaseTable({
  activeCaseId,
  assets,
  branches,
  calls,
  cases,
  operators,
  onOpenDetails,
  onSortChange,
  sort,
  storageKey = DEFAULT_VISIBLE_COLUMNS_STORAGE_KEY,
  totalCases,
  workspaceMode = "collapsed",
}: CaseTableProps) {
  const [visibleColumns, setVisibleColumns] = useState<CaseSortKey[]>(defaultVisibleColumns);
  const callsByCaseId = latestCallByCaseId(calls);
  const ownersById = new Map(operators.map((operator) => [operator.id, operator.name]));
  const branchesById = new Map(branches.map((branch) => [branch.id, branch.name]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset.label]));
  const visibleColumnSet = new Set(visibleColumns);
  const visibleColumnCount = visibleColumns.length;

  useEffect(() => {
    const syncVisibleColumns = () => setVisibleColumns(readStoredVisibleColumns(storageKey));
    const frameId = window.requestAnimationFrame(syncVisibleColumns);

    function handleStorage(event: StorageEvent) {
      if (event.key === storageKey) {
        syncVisibleColumns();
      }
    }

    window.addEventListener("storage", handleStorage);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("storage", handleStorage);
    };
  }, [storageKey]);

  function show(column: CaseSortKey) {
    return visibleColumnSet.has(column);
  }

  function toggleColumn(column: CaseSortKey) {
    setVisibleColumns((current) => {
      const next = current.includes(column)
        ? current.length === 1
          ? current
          : current.filter((candidate) => candidate !== column)
        : caseTableColumns
            .filter((definition) => definition.key === column || current.includes(definition.key))
            .map((definition) => definition.key);

      persistVisibleColumns(storageKey, next);
      return next;
    });
  }

  const caseRows = cases.map((caseItem) => {
    const call = callsByCaseId.get(caseItem.id);

    return {
      active: caseItem.id === activeCaseId,
      call,
      caller: callerInfo(caseItem, call),
      caseItem,
      latestTimeline: latestTimelineEvent(caseItem),
      needsDestination: requiresTowDestination(caseItem.jobTypes),
      openTasks: caseItem.tasks.filter(isTaskOpen),
      ownerName: ownersById.get(caseItem.ownerId) ?? "Nepriradené",
    };
  });

  const rootClassName =
    workspaceMode === "expanded"
      ? "flex h-full min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden rounded-md border border-zinc-200 bg-white"
      : workspaceMode === "split"
        ? "flex h-full min-h-[300px] w-full min-w-0 max-w-full flex-col overflow-hidden rounded-md border border-zinc-200 bg-white"
        : "flex h-full min-h-[420px] w-full min-w-0 max-w-full flex-col overflow-hidden rounded-md border border-zinc-200 bg-white";

  return (
    <section className={rootClassName}>
      <div className="z-20 flex w-full min-w-0 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-500">
        <span>{cases.length} z {totalCases} prípadov</span>
        <details className="relative hidden md:block">
          <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
            <Columns3 size={14} />
            Stĺpce ({visibleColumns.length})
          </summary>
          <div className="absolute right-0 top-9 z-30 grid w-[min(560px,calc(100vw-32px))] grid-cols-2 gap-1 rounded-md border border-zinc-200 bg-white p-2 shadow-lg sm:grid-cols-3">
            {caseTableColumns.map((column) => (
              <label key={column.key} className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                <input
                  type="checkbox"
                  checked={show(column.key)}
                  onChange={() => toggleColumn(column.key)}
                />
                {column.label}
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto md:overflow-auto">
        <div className="space-y-2 p-2 md:hidden">
          {caseRows.length > 0 ? (
            caseRows.map(({ active, caller, caseItem, openTasks, ownerName }) => (
              <button
                key={caseItem.id}
                type="button"
                onClick={() => onOpenDetails(caseItem.id)}
                aria-label={`Otvoriť prípad ${caseItem.caseNumber}`}
                className={`block w-full min-w-0 max-w-full rounded-md border p-3 text-left transition ${
                  active ? "border-yellow-400 bg-yellow-50 ring-1 ring-yellow-300" : "border-zinc-200 bg-white hover:bg-zinc-50"
                }`}
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-zinc-950">{caseItem.caseNumber}</div>
                    {caseItem.summary && <div className="mt-1 line-clamp-2 break-words text-xs leading-5 text-zinc-500">{caseItem.summary}</div>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${caseStatusTone[caseItem.status]}`}>
                      {caseStatusLabels[caseItem.status]}
                    </span>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${priorityTone[caseItem.priority]}`}>
                      {casePriorityLabels[caseItem.priority]}
                    </span>
                  </div>
                </div>

                <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t border-zinc-100 pt-3 text-xs">
                  <MobileDetail label="Kontakt" value={caller.name} detail={caller.phone} detailClassName="break-all" />
                  <MobileDetail label="Vozidlo" value={vehicleLabel(caseItem)} />
                  <MobileDetail
                    className="col-span-2"
                    label="Miesto zásahu"
                    value={caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress || "Nezadané"}
                    detail={caseItem.pickup?.address || (caseItem.locationDetails.manualPickupAddress ? "Ručne zadané bez súradníc" : undefined)}
                  />
                  <MobileDetail label="Operátor" value={ownerName} />
                  <MobileDetail label="Založené" value={formatDateTime(caseItem.createdAt)} />
                  <MobileDetail label="Upravené" value={formatDateTime(caseItem.updatedAt)} />
                </dl>

                <div className="mt-3 flex min-w-0 items-start justify-between gap-3 border-t border-zinc-100 pt-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-semibold text-zinc-500">Ďalší krok</div>
                    <div className="mt-1 line-clamp-2 break-words leading-5 text-zinc-800">{caseItem.nextStep || "Nezadaný"}</div>
                  </div>
                  <div className="shrink-0 rounded-md bg-zinc-100 px-2 py-1 font-semibold text-zinc-700">{openTasks.length} úloh</div>
                </div>
              </button>
            ))
          ) : (
            <div className="px-3 py-12 text-center text-sm font-medium text-zinc-500">Žiadne prípady nevyhovujú filtru.</div>
          )}
        </div>

        <table
          className="hidden w-max min-w-full border-separate border-spacing-0 text-left text-sm md:table"
          style={{ minWidth: `${Math.max(860, visibleColumnCount * 160)}px` }}
        >
          <thead className="sticky top-0 z-10 bg-zinc-50 text-xs font-semibold uppercase tracking-normal text-zinc-500">
            <tr>
              {show("caseNumber") && <SortableHeader label="Prípad" sortKey="caseNumber" sort={sort} onSortChange={onSortChange} />}
              {show("status") && <SortableHeader label="Stav" sortKey="status" sort={sort} onSortChange={onSortChange} />}
              {show("priority") && <SortableHeader label="Priorita" sortKey="priority" sort={sort} onSortChange={onSortChange} />}
              {show("createdAt") && <SortableHeader label="Založené" sortKey="createdAt" sort={sort} onSortChange={onSortChange} />}
              {show("updatedAt") && <SortableHeader label="Upravené" sortKey="updatedAt" sort={sort} onSortChange={onSortChange} />}
              {show("caller") && <SortableHeader label="Volal" sortKey="caller" sort={sort} onSortChange={onSortChange} />}
              {show("callStartedAt") && <SortableHeader label="Hovor" sortKey="callStartedAt" sort={sort} onSortChange={onSortChange} />}
              {show("answeredAt") && <SortableHeader label="Prijaté / ukončené" sortKey="answeredAt" sort={sort} onSortChange={onSortChange} />}
              {show("owner") && <SortableHeader label="Operátor" sortKey="owner" sort={sort} onSortChange={onSortChange} />}
              {show("caseType") && <SortableHeader label="Typ / zdroj" sortKey="caseType" sort={sort} onSortChange={onSortChange} />}
              {show("vehicle") && <SortableHeader label="Vozidlo" sortKey="vehicle" sort={sort} onSortChange={onSortChange} />}
              {show("pickup") && <SortableHeader label="Pickup" sortKey="pickup" sort={sort} onSortChange={onSortChange} />}
              {show("destination") && <SortableHeader label="Cieľ" sortKey="destination" sort={sort} onSortChange={onSortChange} />}
              {show("branch") && <SortableHeader label="Pobočka" sortKey="branch" sort={sort} onSortChange={onSortChange} />}
              {show("asset") && <SortableHeader label="Technika" sortKey="asset" sort={sort} onSortChange={onSortChange} />}
              {show("nextStep") && <SortableHeader label="Ďalší krok" sortKey="nextStep" sort={sort} onSortChange={onSortChange} />}
              {show("openTasks") && <SortableHeader label="Úlohy" sortKey="openTasks" sort={sort} onSortChange={onSortChange} />}
              {show("latestActivityAt") && <SortableHeader label="Posledná poznámka" sortKey="latestActivityAt" sort={sort} onSortChange={onSortChange} />}
            </tr>
          </thead>
          <tbody>
            {caseRows.length > 0 ? (
              caseRows.map(({ active, call, caller, caseItem, latestTimeline, needsDestination, openTasks, ownerName }) => (
                <tr
                  key={caseItem.id}
                  onClick={() => onOpenDetails(caseItem.id)}
                  className={`cursor-pointer transition ${active ? "bg-yellow-50" : "hover:bg-zinc-50"}`}
                >
                    {show("caseNumber") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top">
                        <div className="min-w-[170px]">
                          <div className="font-semibold text-zinc-950">{caseItem.caseNumber}</div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{caseItem.summary}</div>
                        </div>
                      </td>
                    )}
                    {show("status") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${caseStatusTone[caseItem.status]}`}>
                          {caseStatusLabels[caseItem.status]}
                        </span>
                      </td>
                    )}
                    {show("priority") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${priorityTone[caseItem.priority]}`}>
                          {casePriorityLabels[caseItem.priority]}
                        </span>
                      </td>
                    )}
                    {show("createdAt") && <DateCell value={caseItem.createdAt} />}
                    {show("updatedAt") && <DateCell value={caseItem.updatedAt} />}
                    {show("caller") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top">
                        <div className="min-w-[190px]">
                          <div className="flex items-center gap-2 font-semibold text-zinc-950">
                            <Phone size={14} className="text-zinc-400" />
                            {caller.name}
                          </div>
                          <div className="mt-1 text-xs text-zinc-500">{caller.phone}</div>
                        </div>
                      </td>
                    )}
                    {show("callStartedAt") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs font-medium text-zinc-700">
                        <div className="min-w-[130px]">{call ? formatDateTime(call.startedAt) : "Bez linked hovoru"}</div>
                      </td>
                    )}
                    {show("answeredAt") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-600">
                        <div className="min-w-[150px]">
                          <div>Prijaté: {formatTimeOrDash(call?.answeredAt)}</div>
                          <div className="mt-1">Koniec: {formatTimeOrDash(call?.endedAt)}</div>
                        </div>
                      </td>
                    )}
                    {show("owner") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top">
                        <div className="min-w-[150px]">
                          <div className="flex items-center gap-2 font-semibold text-zinc-950">
                            <UserRound size={14} className="text-zinc-400" />
                            {call?.operatorName ?? ownerName}
                          </div>
                          <div className="mt-1 text-xs text-zinc-500">Owner: {ownerName}</div>
                        </div>
                      </td>
                    )}
                    {show("caseType") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-600">
                        <div className="min-w-[190px]">
                          <div className="font-semibold text-zinc-900">{caseItem.caseType || "Nezadané"}</div>
                          <div className="mt-1">{sourceLabel(caseItem.sourceType)}</div>
                        </div>
                      </td>
                    )}
                    {show("vehicle") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top">
                        <div className="min-w-[220px]">
                          <div className="font-semibold text-zinc-950">
                            {caseItem.vehicle.licensePlate} · {caseItem.vehicle.make} {caseItem.vehicle.model}
                          </div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{caseItem.vehicle.issue}</div>
                        </div>
                      </td>
                    )}
                    {show("pickup") && (
                      <AddressCell
                        label={caseItem.pickup?.label || (caseItem.locationDetails.manualPickupAddress ? "Ručne zadané miesto" : undefined)}
                        address={caseItem.pickup?.address || caseItem.locationDetails.manualPickupAddress}
                      />
                    )}
                    {show("destination") && (
                      <AddressCell
                        label={needsDestination ? caseItem.destination?.label || (caseItem.locationDetails.manualDestinationAddress ? "Ručne zadaný cieľ" : undefined) : "Bez cieľa odťahu"}
                        address={needsDestination ? caseItem.destination?.address || caseItem.locationDetails.manualDestinationAddress : "Asistencia na mieste"}
                      />
                    )}
                    {show("branch") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-600">
                        <div className="min-w-[160px]">{caseItem.branchId ? branchesById.get(caseItem.branchId) ?? "Neznáma pobočka" : "Bez pobočky"}</div>
                      </td>
                    )}
                    {show("asset") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-600">
                        <div className="min-w-[160px]">{caseItem.selectedAssetId ? assetsById.get(caseItem.selectedAssetId) ?? "Neznáma technika" : "Nepriradené"}</div>
                      </td>
                    )}
                    {show("nextStep") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-700">
                        <div className="min-w-[230px] line-clamp-3 leading-5">{caseItem.nextStep}</div>
                      </td>
                    )}
                    {show("openTasks") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-600">
                        <div className="min-w-[190px]">
                          <div className="font-semibold text-zinc-900">{openTasks.length} otvorené</div>
                          <div className="mt-1 line-clamp-2 leading-5">{openTasks[0] ? `${openTasks[0].title} · ${formatTimeOrDash(openTasks[0].dueAt)}` : "Bez otvorenej úlohy"}</div>
                        </div>
                      </td>
                    )}
                    {show("latestActivityAt") && (
                      <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-600">
                        <div className="min-w-[260px]">
                          <div className="flex items-center gap-2 font-semibold text-zinc-900">
                            <Clock3 size={14} className="text-zinc-400" />
                            {latestTimeline ? `${formatTimeOrDash(latestTimeline.time)} · ${latestTimeline.actor}` : "Bez timeline"}
                          </div>
                          <div className="mt-1 line-clamp-2 leading-5">{latestTimeline ? `${latestTimeline.title}: ${latestTimeline.body}` : caseItem.mainNote}</div>
                        </div>
                      </td>
                    )}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={visibleColumnCount} className="px-3 py-12 text-center text-sm font-medium text-zinc-500">
                  Žiadne prípady nevyhovujú filtru.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MobileDetail({
  className = "",
  detail,
  detailClassName = "",
  label,
  value,
}: {
  className?: string;
  detail?: string | null;
  detailClassName?: string;
  label: string;
  value?: string | null;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="font-semibold text-zinc-500">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-zinc-900">{value || "Nezadané"}</dd>
      {detail && <dd className={`mt-0.5 break-words leading-5 text-zinc-500 ${detailClassName}`}>{detail}</dd>}
    </div>
  );
}

function vehicleLabel(caseItem: DispatchCase) {
  const plate = caseItem.vehicle?.licensePlate?.trim();
  const makeAndModel = [caseItem.vehicle?.make, caseItem.vehicle?.model].filter(Boolean).join(" ").trim();

  return [plate, makeAndModel].filter(Boolean).join(" · ") || "Nezadané";
}

function sourceLabel(sourceType: DispatchCase["sourceType"]) {
  return sourceType ? sourceLabels[sourceType] : "Nezadané";
}

function readStoredVisibleColumns(storageKey: string): CaseSortKey[] {
  try {
    const raw = window.localStorage.getItem(storageKey);

    if (!raw) {
      return [...defaultVisibleColumns];
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [...defaultVisibleColumns];
    }

    const requestedColumns = new Set(parsed.filter(isCaseSortKey));
    const storedColumns = caseTableColumns
      .filter((column) => requestedColumns.has(column.key))
      .map((column) => column.key);

    return storedColumns.length > 0 ? storedColumns : [...defaultVisibleColumns];
  } catch {
    // localStorage can be unavailable or contain stale data; defaults keep the table usable.
    return [...defaultVisibleColumns];
  }
}

function persistVisibleColumns(storageKey: string, visibleColumns: CaseSortKey[]) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(visibleColumns));
  } catch {
    // Column selection remains usable for this session even when persistence is unavailable.
  }
}

function isCaseSortKey(value: unknown): value is CaseSortKey {
  return typeof value === "string" && caseTableColumns.some((column) => column.key === value);
}

function SortableHeader({
  label,
  onSortChange,
  sort,
  sortKey,
}: {
  label: string;
  onSortChange: (sort: CaseSortState) => void;
  sort: CaseSortState;
  sortKey: CaseSortKey;
}) {
  const active = sort.key === sortKey;
  const nextDirection = active && sort.direction === "asc" ? "desc" : "asc";
  const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <th className="border-b border-zinc-200 px-3 py-2">
      <button
        type="button"
        onClick={() => onSortChange({ key: sortKey, direction: nextDirection })}
        className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition hover:bg-zinc-100 ${
          active ? "text-zinc-950" : "text-zinc-500"
        }`}
      >
        {label}
        <Icon size={13} />
      </button>
    </th>
  );
}

function DateCell({ value }: { value: string }) {
  return (
    <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs font-medium text-zinc-700">
      <div className="min-w-[130px]">{formatDateTime(value)}</div>
    </td>
  );
}

function AddressCell({ address, label }: { address?: string; label?: string }) {
  return (
    <td className="border-b border-zinc-100 px-3 py-3 align-top text-xs text-zinc-600">
      <div className="min-w-[240px]">
        <div className="font-semibold text-zinc-900">{label || "Nezadané"}</div>
        <div className="mt-1 line-clamp-2 leading-5">{address || "Bez adresy"}</div>
      </div>
    </td>
  );
}

function latestCallByCaseId(calls: CallCenterCall[]) {
  const callsByCaseId = new Map<string, CallCenterCall>();

  calls.forEach((call) => {
    if (!call.caseId) {
      return;
    }

    const previous = callsByCaseId.get(call.caseId);

    if (!previous || new Date(call.startedAt).getTime() > new Date(previous.startedAt).getTime()) {
      callsByCaseId.set(call.caseId, call);
    }
  });

  return callsByCaseId;
}

function callerInfo(caseItem: DispatchCase, call?: CallCenterCall) {
  if (!call) {
    return {
      name: caseItem.contact.name,
      phone: caseItem.contact.phone,
    };
  }

  return {
    name: call.callerName ?? caseItem.contact.name,
    phone: call.direction === "outbound" ? call.calledNumber : call.callerNumber,
  };
}

function latestTimelineEvent(caseItem: DispatchCase) {
  return [...caseItem.timeline].sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime())[0];
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("sk-SK", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(date);
}

function formatTimeOrDash(value: string | undefined) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("sk-SK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(date);
}
