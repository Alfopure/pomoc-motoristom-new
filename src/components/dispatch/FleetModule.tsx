"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Ban, CalendarDays, Car, CheckCircle2, Clock3, FileWarning, Link2, Plus, RadioTower, RefreshCw, Save, Search, Truck } from "lucide-react";
import type { CreateFleetAssetInput, UpdateFleetAssetInput } from "@/data/case-inputs";
import type { CommanderVehicleConnection, DispatchData } from "@/data/dispatch-types";
import type {
  Branch,
  DispatchCase,
  FleetAsset,
  FleetAssetCategory,
  FleetAssetKind,
  FleetAssetOccupancyType,
  FleetAssetStatus,
  FleetDriverStatus,
  TowCapability,
  TowTruckCategory,
} from "@/domain/types";
import {
  BrandBadge,
  StatusPill,
  capabilityLabel,
  categoryLabel,
  driverStatusLabel,
  driverStatusTone,
  gpsStatusText,
  gpsTone,
  matchesSearch,
  occupancyText,
  relativeTime,
  statusLabel,
  statusOptions,
  statusRank,
  towCategoryLabel,
} from "@/lib/fleet-presentation";

type FleetMode = "replacement" | "tow" | "gps";
type FilterValue = "all" | string;

// Zladené s GPS_STALE_AFTER_MINUTES (dispatch-repository) — po tomto veku je Commander GPS sync „staršie".
const GPS_SYNC_STALE_AFTER_MINUTES = 10;

type FleetModuleProps = {
  assets: FleetAsset[];
  branches: Branch[];
  cases: DispatchCase[];
  commanderLastSuccessAt?: string;
  commanderLatestRunAt?: string;
  commanderLatestStatus?: "running" | "success" | "partial" | "failed";
  commanderVehicles: CommanderVehicleConnection[];
  onDataChange: (dispatchData: DispatchData) => void;
};

type ApiMutationResponse = {
  assetId?: string;
  dispatchData?: DispatchData;
  error?: string;
};

type FleetDraft = {
  id?: string;
  kind: FleetAssetKind;
  label: string;
  make: string;
  model: string;
  licensePlate: string;
  vin: string;
  status: FleetAssetStatus;
  category: "" | FleetAssetCategory;
  weightKg: string;
  branchId: string;
  notes: string;
  insuranceValidUntil: string;
  highwayVignetteValidUntil: string;
  technicalInspectionValidUntil: string;
  emissionInspectionValidUntil: string;
  occupiedFrom: string;
  occupiedUntil: string;
  occupancyType: "" | FleetAssetOccupancyType;
  occupancyCaseId: string;
  occupancyNote: string;
  assignedDriverName: string;
  assignedDriverPhone: string;
  assignedDriverStatus: "" | FleetDriverStatus;
  towCategory: "" | TowTruckCategory;
  capabilities: TowCapability[];
};

const replacementCategories: FleetAssetCategory[] = ["small_car", "wagon", "suv", "van"];
const towCategories: FleetAssetCategory[] = ["personal_tow", "van_tow", "specialized_tow", "heavy_tow"];
const towTypeOptions: TowTruckCategory[] = ["personal", "van", "specialized", "heavy"];
const capabilityOptions: TowCapability[] = ["winch", "low_garage", "vans", "trucks", "immobile", "crashed"];
const driverStatusOptions: FleetDriverStatus[] = ["available", "on_shift", "on_call", "off_shift"];

export function FleetModule({
  assets,
  branches,
  cases,
  commanderLastSuccessAt,
  commanderLatestRunAt,
  commanderLatestStatus,
  commanderVehicles,
  onDataChange,
}: FleetModuleProps) {
  const [mode, setMode] = useState<FleetMode>("replacement");
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState<FilterValue>("all");
  const [statusFilter, setStatusFilter] = useState<FilterValue>("all");
  const [categoryFilter, setCategoryFilter] = useState<FilterValue>("all");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(assets[0]?.id ?? null);
  const [draft, setDraft] = useState<FleetDraft>(() => assetToDraft(assets[0], branches[0]?.id, "replacement"));
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // T2: SWHouse je jediný zdroj pravdy o obsadenosti. Server už dodáva asset.status (rented pri obsadenom)
  // + asset.occupancy (occupied/free/unverified/stale). Žiadny klientský overlay — renderujeme priamo zo servera.
  const occupancyStale = assets.some((asset) => asset.kind === "replacement_car" && asset.occupancy === "stale");

  const visibleKind: FleetAssetKind = mode === "tow" ? "tow_truck" : "replacement_car";
  const filteredAssets = useMemo(
    () =>
      assets
        .filter((asset) => asset.kind === visibleKind)
        .filter((asset) => branchFilter === "all" || asset.branchId === branchFilter)
        .filter((asset) => statusFilter === "all" || asset.status === statusFilter)
        .filter((asset) => categoryFilter === "all" || asset.category === categoryFilter)
        .filter((asset) => matchesSearch(asset, search))
        .sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.label.localeCompare(right.label, "sk")),
    [assets, branchFilter, categoryFilter, search, statusFilter, visibleKind],
  );
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) ?? filteredAssets[0] ?? null;
  const caseNumberById = new Map(cases.map((caseItem) => [caseItem.id, caseItem.caseNumber]));
  const replacementUnverified = assets.filter(
    (asset) => asset.kind === "replacement_car" && (asset.occupancy === "unverified" || asset.occupancy === "stale"),
  ).length;
  const replacementAvailable = assets.filter(
    (asset) => asset.kind === "replacement_car" && asset.status === "available" && asset.occupancy === "free",
  ).length;
  const replacementOccupied = assets.filter((asset) => asset.kind === "replacement_car" && ["reserved", "rented", "assigned"].includes(asset.status)).length;
  const towAvailable = assets.filter((asset) => asset.kind === "tow_truck" && asset.status === "available").length;
  const docsAttention = assets.filter(hasDocumentAttention).length;
  const gpsOverview = useMemo(() => fleetGpsOverview(assets), [assets]);
  const gpsSyncFreshness = useMemo(
    () => commanderGpsSyncFreshness(commanderLastSuccessAt, commanderLatestRunAt, commanderLatestStatus),
    [commanderLastSuccessAt, commanderLatestRunAt, commanderLatestStatus],
  );
  const commanderUnpaired = commanderVehicles.filter((vehicle) => vehicle.link?.status !== "confirmed" && vehicle.link?.status !== "rejected").length;

  function switchMode(nextMode: FleetMode) {
    const nextAsset = assets.find((asset) => asset.kind === (nextMode === "replacement" ? "replacement_car" : "tow_truck"));
    setMode(nextMode);
    setCategoryFilter("all");
    if (nextMode === "gps") {
      setMessage(null);
      return;
    }
    setSelectedAssetId(nextAsset?.id ?? null);
    setDraft(assetToDraft(nextAsset, branches[0]?.id, nextMode));
    setMessage(null);
  }

  function selectAsset(asset: FleetAsset) {
    setSelectedAssetId(asset.id);
    // Draft vždy z uloženého záznamu — SWHouse override je len na zobrazenie, nesmie sa prepísať do DB.
    const stored = assets.find((candidate) => candidate.id === asset.id) ?? asset;
    setDraft(assetToDraft(stored, branches[0]?.id, mode));
    setMessage(null);
  }

  function startNewAsset() {
    setSelectedAssetId(null);
    setDraft(emptyDraft(branches[0]?.id, mode));
    setMessage(null);
  }

  async function saveDraft() {
    if (!draft.label.trim() || !draft.branchId || isSaving) {
      return;
    }

    setIsSaving(true);
    setMessage(null);

    try {
      const payload = draftToPayload(draft);
      const response = await fetch(draft.id ? `/api/fleet-assets/${draft.id}` : "/api/fleet-assets", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData || !result.assetId) {
        throw new Error(result.error ?? "Vozidlo sa nepodarilo uložiť.");
      }

      onDataChange(result.dispatchData);
      const nextAsset = result.dispatchData.fleetAssets.find((asset) => asset.id === result.assetId);
      setSelectedAssetId(result.assetId);
      setDraft(assetToDraft(nextAsset, branches[0]?.id, mode));
      setMessage(draft.id ? "Vozidlo je upravené." : "Vozidlo je uložené vo flotile.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Vozidlo sa nepodarilo uložiť.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-auto bg-zinc-50 p-3 sm:p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-950">Flotila</h1>
          <p className="text-sm text-zinc-600">Dostupnosť náhradných vozidiel a odťahoviek pre denný dispečing.</p>
          <GpsSyncIndicator freshness={gpsSyncFreshness} />
        </div>
        {mode !== "gps" && (
          <button
            type="button"
            onClick={startNewAsset}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800"
          >
            <Plus size={16} />
            Nové vozidlo
          </button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi icon={Car} label="Voľné náhradné" value={String(replacementAvailable)} />
        <Kpi icon={CalendarDays} label="Obsadené náhradné" value={String(replacementOccupied)} />
        <Kpi icon={AlertTriangle} label="Neoverené" value={String(replacementUnverified)} tone={replacementUnverified > 0 ? "warn" : "ok"} />
        <Kpi icon={Truck} label="Voľné odťahovky" value={String(towAvailable)} />
        <Kpi icon={FileWarning} label="Doklady do 30 dní" value={String(docsAttention)} tone={docsAttention > 0 ? "warn" : "ok"} />
      </div>

      {occupancyStale && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
          <AlertTriangle size={14} className="shrink-0" />
          SWHouse obsadenosť je zastaraná alebo nedostupná — overená dostupnosť náhradných vozidiel nemusí byť aktuálna.
        </div>
      )}

      <GpsHealthPanel overview={gpsOverview} />

      {mode === "gps" ? (
        <GpsConnectionsPanel
          assets={assets}
          branches={branches}
          commanderVehicles={commanderVehicles}
          message={message}
          onDataChange={onDataChange}
          onMessage={setMessage}
          onSwitchMode={switchMode}
        />
      ) : (
      <div className="grid gap-4 xl:min-h-[620px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0 rounded-md border border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 p-3">
            <div className="inline-flex w-full overflow-x-auto rounded-md bg-zinc-100 p-1 sm:w-auto">
              <ModeButton active={mode === "replacement"} icon={Car} label="Náhradné vozidlá" onClick={() => switchMode("replacement")} />
              <ModeButton active={mode === "tow"} icon={Truck} label="Odťahovky" onClick={() => switchMode("tow")} />
              <ModeButton active={false} icon={RadioTower} label={`Párovanie vozidiel${commanderUnpaired ? ` (${commanderUnpaired})` : ""}`} onClick={() => switchMode("gps")} />
            </div>
            <div className="grid w-full gap-2 lg:w-auto lg:grid-cols-[220px_170px_150px_180px]">
              <label className="relative">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Hľadať"
                  className="h-9 w-full rounded-md border border-zinc-200 pl-9 pr-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
                />
              </label>
              <CompactSelect value={branchFilter} onChange={setBranchFilter} options={[["all", "Všetky pobočky"], ...branches.map((branch) => [branch.id, branch.name] as const)]} />
              <CompactSelect value={statusFilter} onChange={setStatusFilter} options={[["all", "Všetky stavy"], ...statusOptions.map((status) => [status, statusLabel[status]] as const)]} />
              <CompactSelect
                value={categoryFilter}
                onChange={setCategoryFilter}
                options={[["all", "Všetky kategórie"], ...(mode === "replacement" ? replacementCategories : towCategories).map((category) => [category, categoryLabel[category]] as const)]}
              />
            </div>
          </div>

          <div className="overflow-auto">
            <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-xs font-semibold uppercase tracking-normal text-zinc-500">
                <tr>
                  <th className="border-b border-zinc-200 px-3 py-2">Vozidlo</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Stav</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Pobočka</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Posádka</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Obsadenie</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Poloha</th>
                  <th className="border-b border-zinc-200 px-3 py-2">Doklady</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssets.map((asset) => (
                  <tr
                    key={asset.id}
                    onClick={() => selectAsset(asset)}
                    className={`cursor-pointer transition ${asset.id === selectedAssetId ? "bg-yellow-50" : "hover:bg-zinc-50"}`}
                  >
                    <td className="border-b border-zinc-100 px-3 py-3">
                      <div className="flex min-w-[260px] items-center gap-3">
                        <BrandBadge make={asset.make} />
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-zinc-950">{asset.label}</div>
                          <div className="truncate text-xs text-zinc-500">
                            {[asset.make, asset.model, asset.licensePlate].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-3">
                      {asset.occupancy === "unverified" ? (
                        <span className="inline-flex rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800" title="SWHouse toto auto pod danou ŠPZ nepozná — stav nie je overený">
                          Neoverené
                        </span>
                      ) : asset.occupancy === "stale" ? (
                        <span className="inline-flex rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800" title="SWHouse snapshot je starší ako 10 minút">
                          Neaktuálne
                        </span>
                      ) : (
                        <StatusPill status={asset.status} />
                      )}
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-3 text-xs text-zinc-600">{branchName(asset.branchId, branches)}</td>
                    <td className="border-b border-zinc-100 px-3 py-3 text-xs text-zinc-600">
                      <DriverSummary asset={asset} />
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-3 text-xs text-zinc-600">
                      {asset.occupancy === "occupied"
                        ? "Prenajaté · SWHouse"
                        : asset.occupancy === "unverified"
                          ? "Mimo SWHouse"
                          : asset.occupancy === "stale"
                            ? "SWHouse dáta neaktuálne"
                          : occupancyText(asset, caseNumberById)}
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-3">
                      <GpsSummary asset={asset} />
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-3">
                      <DocumentSummary asset={asset} />
                    </td>
                  </tr>
                ))}
                {filteredAssets.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-10 text-center text-sm font-medium text-zinc-500">
                      Žiadne vozidlo nevyhovuje filtru.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="min-w-0 rounded-md border border-zinc-200 bg-white p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <BrandBadge make={draft.make || selectedAsset?.make} size="lg" />
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-zinc-950">{draft.id ? "Detail vozidla" : "Nové vozidlo"}</h2>
                <p className="truncate text-xs text-zinc-500">{selectedAsset ? detailSubtitle(selectedAsset, branches) : "Vyplň základné údaje a ulož vozidlo."}</p>
              </div>
            </div>
            {selectedAsset && <StatusPill status={selectedAsset.status} />}
          </div>

          {message && <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">{message}</div>}

          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Typ" value={draft.kind} onChange={(value) => setDraft((current) => ({ ...current, kind: value as FleetAssetKind }))} options={fleetKindOptions} />
              <SelectField label="Stav" value={draft.status} onChange={(value) => setDraft((current) => ({ ...current, status: value as FleetAssetStatus }))} options={statusOptions.map((status) => [status, statusLabel[status]])} />
            </div>
            <TextField label="Názov" value={draft.label} onChange={(value) => setDraft((current) => ({ ...current, label: value }))} />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Značka" value={draft.make} onChange={(value) => setDraft((current) => ({ ...current, make: value }))} />
              <TextField label="Model" value={draft.model} onChange={(value) => setDraft((current) => ({ ...current, model: value }))} />
              <TextField label="EČV" value={draft.licensePlate} onChange={(value) => setDraft((current) => ({ ...current, licensePlate: value }))} />
              <TextField label="VIN" value={draft.vin} onChange={(value) => setDraft((current) => ({ ...current, vin: value }))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Kategória"
                value={draft.category}
                onChange={(value) => setDraft((current) => ({ ...current, category: value as FleetAssetCategory }))}
                options={categoryOptionsForKind(draft.kind)}
              />
              <TextField label="Hmotnosť kg" value={draft.weightKg} onChange={(value) => setDraft((current) => ({ ...current, weightKg: value }))} type="number" />
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Pobočka</span>
              <select
                value={draft.branchId}
                onChange={(event) => setDraft((current) => ({ ...current, branchId: event.target.value }))}
                className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
              >
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>

            {draft.kind === "tow_truck" && (
              <div className="grid gap-3 rounded-md bg-zinc-50 p-3">
                <SelectField
                  label="Odťahová kategória"
                  value={draft.towCategory}
                  onChange={(value) => setDraft((current) => ({ ...current, towCategory: value as TowTruckCategory }))}
                  options={[["", "Nezadané"], ...towTypeOptions.map((category) => [category, towCategoryLabel[category]] as const)]}
                />
                <CapabilityPicker draft={draft} onChange={(capabilities) => setDraft((current) => ({ ...current, capabilities }))} />
              </div>
            )}

            <div className="grid gap-3 rounded-md bg-zinc-50 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">
                <Truck size={14} />
                Posádka
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Šofér / posádka" value={draft.assignedDriverName} onChange={(value) => setDraft((current) => ({ ...current, assignedDriverName: value }))} />
                <TextField label="Telefón" value={draft.assignedDriverPhone} onChange={(value) => setDraft((current) => ({ ...current, assignedDriverPhone: value }))} />
                <SelectField
                  label="Stav posádky"
                  value={draft.assignedDriverStatus}
                  onChange={(value) => setDraft((current) => ({ ...current, assignedDriverStatus: value as FleetDraft["assignedDriverStatus"] }))}
                  options={[["", "Nezadané"], ...driverStatusOptions.map((status) => [status, driverStatusLabel[status]] as const)]}
                />
              </div>
            </div>

            <div className="grid gap-3 rounded-md bg-zinc-50 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">
                <CalendarDays size={14} />
                Obsadenie
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label="Typ obsadenia"
                  value={draft.occupancyType}
                  onChange={(value) => setDraft((current) => ({ ...current, occupancyType: value as FleetAssetOccupancyType }))}
                  options={[["", "Voľné / nezadané"], ["reservation", "Rezervácia"], ["rental", "Prenájom"], ["case_assignment", "Prípad"]]}
                />
                <SelectField
                  label="Prípad"
                  value={draft.occupancyCaseId}
                  onChange={(value) => setDraft((current) => ({ ...current, occupancyCaseId: value }))}
                  options={[["", "Bez prípadu"], ...cases.map((caseItem) => [caseItem.id, caseItem.caseNumber] as const)]}
                />
                <TextField label="Od" value={dateInputValue(draft.occupiedFrom)} onChange={(value) => setDraft((current) => ({ ...current, occupiedFrom: value }))} type="date" />
                <TextField label="Do" value={dateInputValue(draft.occupiedUntil)} onChange={(value) => setDraft((current) => ({ ...current, occupiedUntil: value }))} type="date" />
              </div>
              <TextField label="Poznámka k obsadeniu" value={draft.occupancyNote} onChange={(value) => setDraft((current) => ({ ...current, occupancyNote: value }))} />
            </div>

            <div className="grid gap-3 rounded-md bg-zinc-50 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">
                <FileWarning size={14} />
                Doklady
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Poistenie do" value={draft.insuranceValidUntil} onChange={(value) => setDraft((current) => ({ ...current, insuranceValidUntil: value }))} type="date" />
                <TextField label="Diaľničná do" value={draft.highwayVignetteValidUntil} onChange={(value) => setDraft((current) => ({ ...current, highwayVignetteValidUntil: value }))} type="date" />
                <TextField label="STK do" value={draft.technicalInspectionValidUntil} onChange={(value) => setDraft((current) => ({ ...current, technicalInspectionValidUntil: value }))} type="date" />
                <TextField label="EK do" value={draft.emissionInspectionValidUntil} onChange={(value) => setDraft((current) => ({ ...current, emissionInspectionValidUntil: value }))} type="date" />
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Poznámka</span>
              <textarea
                value={draft.notes}
                onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                className="min-h-20 w-full resize-y rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none ring-yellow-300 transition focus:ring-2"
              />
            </label>

            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={!draft.label.trim() || !draft.branchId || isSaving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              <Save size={16} />
              {draft.id ? "Uložiť zmeny" : "Uložiť vozidlo"}
            </button>
          </div>
        </aside>
      </div>
      )}
    </main>
  );
}

function Kpi({ icon: Icon, label, tone = "default", value }: { icon: LucideIcon; label: string; tone?: "default" | "ok" | "warn"; value: string }) {
  const toneClass = tone === "warn" ? "bg-amber-50 text-amber-800" : tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-white text-zinc-950";

  return (
    <section className={`rounded-md border border-zinc-200 p-3 ${toneClass}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal opacity-75">
        <Icon size={15} />
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </section>
  );
}

function GpsHealthPanel({ overview }: { overview: FleetGpsOverview }) {
  const toneClass =
    overview.state === "ok"
      ? "border-emerald-200 bg-emerald-50 text-emerald-950"
      : overview.state === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-950"
        : "border-red-200 bg-red-50 text-red-950";
  const Icon = overview.state === "ok" ? CheckCircle2 : AlertTriangle;
  const latestSyncText = overview.latestSyncAt ? relativeTime(overview.latestSyncAt) : "bez syncu";
  const latestPositionText = overview.latestPositionAt ? relativeTime(overview.latestPositionAt) : "bez času polohy";

  return (
    <section className={`mb-4 rounded-md border px-3 py-3 ${toneClass}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/80">
            <Icon size={19} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">WebDispečink – poloha</h2>
              <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold">
                {overview.liveCount}/{overview.webdispecinkCount} aktuálne
              </span>
            </div>
            <p className="mt-0.5 text-xs font-medium opacity-80">{overview.detail}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <GpsHealthMetric icon={RadioTower} label="Vozidlá" value={String(overview.webdispecinkCount)} />
          <GpsHealthMetric icon={CheckCircle2} label="Aktuálne" value={String(overview.liveCount)} />
          <GpsHealthMetric icon={AlertTriangle} label="Staršie" value={String(overview.staleCount)} />
          <GpsHealthMetric icon={Clock3} label="Obnovené" value={latestSyncText} title={`Posledná poloha: ${latestPositionText}`} />
        </div>
      </div>
    </section>
  );
}

function GpsHealthMetric({ icon: Icon, label, title, value }: { icon: LucideIcon; label: string; title?: string; value: string }) {
  return (
    <div title={title} className="min-w-[92px] rounded-md bg-white/80 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-normal opacity-70">
        <Icon size={12} />
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function GpsConnectionsPanel({
  assets,
  commanderVehicles,
  message,
  onDataChange,
  onMessage,
  onSwitchMode,
}: {
  assets: FleetAsset[];
  branches: Branch[];
  commanderVehicles: CommanderVehicleConnection[];
  message: string | null;
  onDataChange: (dispatchData: DispatchData) => void;
  onMessage: (message: string | null) => void;
  onSwitchMode: (mode: FleetMode) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openTargetId, setOpenTargetId] = useState<string | null>(null);
  const [chosenSourceId, setChosenSourceId] = useState("");

  // Commander vozidlo potvrdene napojene na dane auto (podla neho vieme, kto ma polohu).
  const commanderByAssetId = useMemo(() => {
    const map = new Map<string, CommanderVehicleConnection>();
    for (const vehicle of commanderVehicles) {
      if (vehicle.link?.status === "confirmed" && vehicle.link.fleetAssetId) {
        map.set(vehicle.link.fleetAssetId, vehicle);
      }
    }
    return map;
  }, [commanderVehicles]);

  const swhouseCars = useMemo(() => assets.filter((asset) => asset.kind === "replacement_car" && asset.swhouseLinked), [assets]);
  const ghostCars = useMemo(() => assets.filter((asset) => asset.kind === "replacement_car" && !asset.swhouseLinked), [assets]);
  const ghostSources = useMemo(() => ghostCars.filter((ghost) => commanderByAssetId.has(ghost.id)), [ghostCars, commanderByAssetId]);
  const missing = useMemo(() => swhouseCars.filter((asset) => !commanderByAssetId.has(asset.id)), [swhouseCars, commanderByAssetId]);
  const withPosition = swhouseCars.length - missing.length;

  function sourcesFor(target: FleetAsset) {
    return [...ghostSources].sort((left, right) => matchScore(right, target) - matchScore(left, target) || left.label.localeCompare(right.label, "sk"));
  }

  async function callAndApply(body: unknown, successText: string) {
    setBusy(true);
    onMessage(null);
    try {
      const response = await fetch("/api/integrations/fleet/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { dispatchData?: DispatchData; error?: string };
      if (!response.ok || !data.dispatchData) {
        throw new Error(data.error ?? "Akciu sa nepodarilo vykonať.");
      }
      onDataChange(data.dispatchData);
      onMessage(successText);
      setOpenTargetId(null);
      setChosenSourceId("");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Akciu sa nepodarilo vykonať.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    onMessage(null);
    try {
      const response = await fetch("/api/integrations/fleet/refresh", { method: "POST" });
      const data = (await response.json()) as {
        dispatchData?: DispatchData;
        error?: string;
        summary?: { autoPaired: number; warnings: string[] };
      };
      if (!response.ok || !data.dispatchData) {
        throw new Error(data.error ?? "Obnovenie zlyhalo.");
      }
      onDataChange(data.dispatchData);
      const autoPaired = data.summary?.autoPaired ?? 0;
      const warnings = data.summary?.warnings?.length ? ` ${data.summary.warnings.join(" ")}` : "";
      onMessage(`Aktualizované. Automaticky spárované: ${autoPaired}.${warnings}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Obnovenie zlyhalo.");
    } finally {
      setRefreshing(false);
    }
  }

  function assign(target: FleetAsset, sourceGhostId: string) {
    const source = ghostSources.find((ghost) => ghost.id === sourceGhostId);
    const record = source ? commanderByAssetId.get(source.id) : undefined;
    if (!record) {
      onMessage("Vyber vozidlo z Commandera.");
      return;
    }
    void callAndApply({ action: "assign", commanderRecordId: record.id, swhouseAssetId: target.id }, "Vozidlo spárované, poloha presunutá.");
  }

  function markSold(asset: FleetAsset) {
    void callAndApply({ action: "markSold", assetId: asset.id }, "Vozidlo označené ako predané.");
  }

  return (
    <section className="min-w-0 rounded-md border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 p-3">
        <div className="inline-flex w-full overflow-x-auto rounded-md bg-zinc-100 p-1 sm:w-auto">
          <ModeButton active={false} icon={Car} label="Náhradné vozidlá" onClick={() => onSwitchMode("replacement")} />
          <ModeButton active={false} icon={Truck} label="Odťahovky" onClick={() => onSwitchMode("tow")} />
          <ModeButton active icon={RadioTower} label="Párovanie vozidiel" onClick={() => onSwitchMode("gps")} />
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing || busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
        >
          <RefreshCw size={16} className={refreshing ? "animate-spin" : undefined} />
          {refreshing ? "Obnovujem…" : "Obnoviť dáta"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b border-zinc-200 p-3 sm:grid-cols-4">
        <SummaryChip label="Vozidlá zo SWHouse" value={swhouseCars.length} />
        <SummaryChip label="S polohou" value={withPosition} />
        <SummaryChip label="Bez polohy" value={missing.length} tone={missing.length > 0 ? "warn" : "default"} />
        <SummaryChip label="Mimo SWHouse" value={ghostCars.length} tone={ghostCars.length > 0 ? "warn" : "default"} />
      </div>

      {message && <div className="border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">{message}</div>}

      <div className="grid gap-4 p-3">
        <ConnectionSection title="Vozidlá bez polohy" subtitle="Tieto autá sú v systéme, ale nemajú živú polohu. Priraď k nim vozidlo z Commandera.">
          {missing.length > 0 ? (
            missing.map((car) => (
              <div key={car.id} className="border-b border-zinc-100 px-3 py-3 last:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-zinc-950">{[car.make, car.model].filter(Boolean).join(" ") || car.label}</div>
                    <div className="truncate text-xs text-zinc-500">{car.licensePlate}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpenTargetId(openTargetId === car.id ? null : car.id);
                      setChosenSourceId("");
                    }}
                    disabled={busy}
                    className="inline-flex h-9 items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-950 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Link2 size={15} />
                    Priradiť vozidlo z Commandera
                  </button>
                </div>
                {openTargetId === car.id && (
                  <div className="mt-3 grid gap-2 rounded-md bg-zinc-50 p-3 ring-1 ring-zinc-200 sm:grid-cols-[1fr_auto]">
                    <select
                      value={chosenSourceId}
                      onChange={(event) => setChosenSourceId(event.target.value)}
                      className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
                    >
                      <option value="">Vyber vozidlo z Commandera…</option>
                      {sourcesFor(car).map((source) => (
                        <option key={source.id} value={source.id}>
                          {[source.licensePlate, source.make, source.model].filter(Boolean).join(" · ")}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => assign(car, chosenSourceId)}
                      disabled={!chosenSourceId || busy}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                    >
                      Spárovať
                    </button>
                  </div>
                )}
              </div>
            ))
          ) : (
            <EmptyConnectionState text="Všetky vozidlá zo SWHouse majú polohu. Netreba nič priraďovať." />
          )}
        </ConnectionSection>

        <ConnectionSection title="Z Commandera, mimo SWHouse" subtitle="SWHouse tieto ŠPZ nepozná (prepis značky alebo predané auto). Priraď ich vyššie k správnemu autu, alebo označ ako predané.">
          {ghostCars.length > 0 ? (
            ghostCars.map((car) => {
              const commander = commanderByAssetId.get(car.id);
              return (
                <div key={car.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-zinc-950">{[car.make, car.model].filter(Boolean).join(" ") || car.label}</div>
                    <div className="truncate text-xs text-zinc-500">{car.licensePlate}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <PolohaPill stale={commander?.position ? commander.position.stale : null} />
                    <button
                      type="button"
                      onClick={() => markSold(car)}
                      disabled={busy}
                      className="inline-flex h-9 items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Ban size={15} />
                      Označiť ako predané
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyConnectionState text="Žiadne vozidlá mimo SWHouse. Všetko je spárované." />
          )}
        </ConnectionSection>
      </div>
    </section>
  );
}

function PolohaPill({ stale }: { stale: boolean | null }) {
  if (stale === null) {
    return <span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-500">Bez polohy</span>;
  }
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${stale ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>
      {stale ? "Staršia poloha" : "Aktuálna poloha"}
    </span>
  );
}

function matchScore(ghost: FleetAsset, target: FleetAsset) {
  let score = 0;
  const ghostPlate = pairingPlate(ghost.licensePlate);
  if (ghostPlate && ghostPlate === pairingPlate(target.licensePlate)) {
    score += 100;
  }
  if (ghost.make && target.make && ghost.make.toLowerCase() === target.make.toLowerCase()) {
    score += 20;
  }
  if (ghost.model && target.model && ghost.model.toLowerCase() === target.model.toLowerCase()) {
    score += 20;
  }
  return score;
}

function SummaryChip({ label, tone = "default", value }: { label: string; tone?: "default" | "warn"; value: number }) {
  return (
    <div className={`rounded-md px-3 py-2 ring-1 ${tone === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-white text-zinc-700 ring-zinc-200"}`}>
      <div className="text-[11px] uppercase tracking-normal opacity-75">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function ConnectionSection({ children, subtitle, title }: { children: ReactNode; subtitle: string; title: string }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 bg-zinc-50 px-3 py-2">
        <h2 className="text-sm font-semibold text-zinc-950">{title}</h2>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

function EmptyConnectionState({ text }: { text: string }) {
  return <div className="px-3 py-8 text-center text-sm font-medium text-zinc-500">{text}</div>;
}

/** Normalizácia ŠPZ na párovanie so SWHouse ECV: uppercase, len A-Z0-9. */
function pairingPlate(value: string | undefined) {
  const normalized = value?.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || undefined;
}


function ModeButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold transition ${active ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950"}`}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

function DocumentSummary({ asset }: { asset: FleetAsset }) {
  const documents = [
    asset.insuranceValidUntil,
    asset.highwayVignetteValidUntil,
    asset.technicalInspectionValidUntil,
    asset.emissionInspectionValidUntil,
  ].filter(Boolean);

  if (documents.length === 0) {
    return <span className="text-xs font-medium text-zinc-400">Nezadané</span>;
  }

  const worst = documents.map((date) => docState(date)).sort((left, right) => docRank[left] - docRank[right])[0];
  const Icon = worst === "expired" ? AlertTriangle : worst === "soon" ? FileWarning : CheckCircle2;

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${docTone[worst]}`}>
      <Icon size={12} />
      {docLabel[worst]}
    </span>
  );
}

function DriverSummary({ asset }: { asset: FleetAsset }) {
  if (!asset.assignedDriverName) {
    return <span className="text-zinc-400">Bez posádky</span>;
  }

  return (
    <div>
      <div className="font-medium text-zinc-800">{asset.assignedDriverName}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        {asset.assignedDriverStatus && (
          <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${driverStatusTone[asset.assignedDriverStatus]}`}>
            {driverStatusLabel[asset.assignedDriverStatus]}
          </span>
        )}
        {asset.assignedDriverPhone && <span className="text-zinc-500">{asset.assignedDriverPhone}</span>}
      </div>
    </div>
  );
}

function GpsSummary({ asset }: { asset: FleetAsset }) {
  return (
    <span className={`inline-flex max-w-[210px] items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${gpsTone(asset)}`}>
      <RadioTower size={12} className="shrink-0" />
      <span className="truncate">{gpsStatusText(asset)}</span>
    </span>
  );
}

function CapabilityPicker({ draft, onChange }: { draft: FleetDraft; onChange: (capabilities: TowCapability[]) => void }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-normal text-zinc-500">Schopnosti</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {capabilityOptions.map((capability) => (
          <label key={capability} className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-2 text-xs font-medium text-zinc-700">
            <input
              type="checkbox"
              checked={draft.capabilities.includes(capability)}
              onChange={(event) => {
                onChange(
                  event.target.checked
                    ? [...draft.capabilities, capability]
                    : draft.capabilities.filter((candidate) => candidate !== capability),
                );
              }}
            />
            {capabilityLabel[capability]}
          </label>
        ))}
      </div>
    </div>
  );
}

function TextField({
  label,
  onChange,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  type?: "date" | "number" | "text";
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
      />
    </label>
  );
}

function SelectField({ label, onChange, options, value }: { label: string; onChange: (value: string) => void; options: ReadonlyArray<readonly [string, string]>; value: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompactSelect({ onChange, options, value }: { onChange: (value: string) => void; options: ReadonlyArray<readonly [string, string]>; value: string }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
    >
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>
          {optionLabel}
        </option>
      ))}
    </select>
  );
}

function assetToDraft(asset: FleetAsset | undefined, defaultBranchId: string | undefined, mode: FleetMode): FleetDraft {
  if (!asset) {
    return emptyDraft(defaultBranchId, mode);
  }

  return {
    id: asset.id,
    kind: asset.kind,
    label: asset.label,
    make: asset.make ?? "",
    model: asset.model ?? "",
    licensePlate: asset.licensePlate === "-" ? "" : asset.licensePlate,
    vin: asset.vin ?? "",
    status: asset.status,
    category: asset.category ?? "",
    weightKg: asset.weightKg ? String(asset.weightKg) : "",
    branchId: asset.branchId,
    notes: asset.notes ?? "",
    insuranceValidUntil: dateInputValue(asset.insuranceValidUntil),
    highwayVignetteValidUntil: dateInputValue(asset.highwayVignetteValidUntil),
    technicalInspectionValidUntil: dateInputValue(asset.technicalInspectionValidUntil),
    emissionInspectionValidUntil: dateInputValue(asset.emissionInspectionValidUntil),
    occupiedFrom: dateInputValue(asset.occupiedFrom),
    occupiedUntil: dateInputValue(asset.occupiedUntil),
    occupancyType: asset.occupancyType ?? "",
    occupancyCaseId: asset.occupancyCaseId ?? "",
    occupancyNote: asset.occupancyNote ?? "",
    assignedDriverName: asset.assignedDriverName ?? "",
    assignedDriverPhone: asset.assignedDriverPhone ?? "",
    assignedDriverStatus: asset.assignedDriverStatus ?? "",
    towCategory: asset.towCategory ?? "",
    capabilities: asset.capabilities ?? [],
  };
}

function emptyDraft(defaultBranchId: string | undefined, mode: FleetMode): FleetDraft {
  const kind = mode === "replacement" ? "replacement_car" : "tow_truck";

  return {
    kind,
    label: "",
    make: "",
    model: "",
    licensePlate: "",
    vin: "",
    status: "available",
    category: kind === "replacement_car" ? "wagon" : "personal_tow",
    weightKg: "",
    branchId: defaultBranchId ?? "",
    notes: "",
    insuranceValidUntil: "",
    highwayVignetteValidUntil: "",
    technicalInspectionValidUntil: "",
    emissionInspectionValidUntil: "",
    occupiedFrom: "",
    occupiedUntil: "",
    occupancyType: "",
    occupancyCaseId: "",
    occupancyNote: "",
    assignedDriverName: "",
    assignedDriverPhone: "",
    assignedDriverStatus: "",
    towCategory: kind === "tow_truck" ? "personal" : "",
    capabilities: kind === "tow_truck" ? ["winch"] : [],
  };
}

function draftToPayload(draft: FleetDraft): CreateFleetAssetInput | UpdateFleetAssetInput {
  return {
    kind: draft.kind,
    label: draft.label,
    make: draft.make || undefined,
    model: draft.model || undefined,
    licensePlate: draft.licensePlate,
    vin: draft.vin || undefined,
    status: draft.status,
    category: draft.category || undefined,
    weightKg: draft.weightKg ? Number(draft.weightKg) : undefined,
    branchId: draft.branchId,
    notes: draft.notes || undefined,
    insuranceValidUntil: draft.insuranceValidUntil || undefined,
    highwayVignetteValidUntil: draft.highwayVignetteValidUntil || undefined,
    technicalInspectionValidUntil: draft.technicalInspectionValidUntil || undefined,
    emissionInspectionValidUntil: draft.emissionInspectionValidUntil || undefined,
    occupiedFrom: draft.occupiedFrom || undefined,
    occupiedUntil: draft.occupiedUntil || undefined,
    occupancyType: draft.occupancyType || undefined,
    occupancyCaseId: draft.occupancyCaseId || undefined,
    occupancyNote: draft.occupancyNote || undefined,
    assignedDriverName: draft.assignedDriverName || undefined,
    assignedDriverPhone: draft.assignedDriverPhone || undefined,
    assignedDriverStatus: draft.assignedDriverStatus || undefined,
    towCategory: draft.towCategory || undefined,
    capabilities: draft.capabilities,
  };
}

function categoryOptionsForKind(kind: FleetAssetKind): Array<readonly [string, string]> {
  const categories = kind === "replacement_car" ? replacementCategories : towCategories;
  return [["", "Nezadané"], ...categories.map((category) => [category, categoryLabel[category]] as const)];
}

function branchName(branchId: string, branches: Branch[]) {
  return branches.find((branch) => branch.id === branchId)?.name ?? "Bez pobočky";
}

function detailSubtitle(asset: FleetAsset, branches: Branch[]) {
  return `${asset.licensePlate} · ${branchName(asset.branchId, branches)} · ${gpsStatusText(asset)}`;
}

function hasDocumentAttention(asset: FleetAsset) {
  return [
    asset.insuranceValidUntil,
    asset.highwayVignetteValidUntil,
    asset.technicalInspectionValidUntil,
    asset.emissionInspectionValidUntil,
  ].some((date) => {
    const days = daysUntil(date);
    return days !== null && days <= 30;
  });
}

function docState(date: string | undefined) {
  const days = daysUntil(date);
  if (days === null) {
    return "missing" as const;
  }
  if (days < 0) {
    return "expired" as const;
  }
  if (days <= 30) {
    return "soon" as const;
  }
  return "ok" as const;
}

function daysUntil(value: string | undefined) {
  if (!value) {
    return null;
  }

  const target = new Date(value);
  if (Number.isNaN(target.getTime())) {
    return null;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

function dateInputValue(value: string | undefined) {
  return value?.slice(0, 10) ?? "";
}

type FleetGpsOverview = {
  state: "ok" | "warn" | "bad";
  webdispecinkCount: number;
  liveCount: number;
  staleCount: number;
  latestPositionAt?: string;
  latestSyncAt?: string;
  detail: string;
};

type GpsSyncFreshness = { lastSyncAt?: string; state: "ok" | "warn"; status?: "running" | "success" | "partial" | "failed" };

/**
 * Vek poslednej úspešnej Commander synchronizácie z integračnej telemetrie.
 * Na rozdiel od GPS časovej pečiatky sa posúva aj pri zdravom pollingu stojaceho vozidla.
 */
function commanderGpsSyncFreshness(
  lastSuccessAt?: string,
  latestRunAt?: string,
  latestStatus?: "running" | "success" | "partial" | "failed",
): GpsSyncFreshness {
  const validLastSuccessAt = lastSuccessAt && Number.isFinite(Date.parse(lastSuccessAt)) ? lastSuccessAt : undefined;
  const validLatestRunAt = latestRunAt && Number.isFinite(Date.parse(latestRunAt)) ? latestRunAt : undefined;
  const stale = !validLastSuccessAt || Date.now() - Date.parse(validLastSuccessAt) > GPS_SYNC_STALE_AFTER_MINUTES * 60 * 1000;
  const latestFailed = Boolean(latestStatus && latestStatus !== "success");
  return {
    lastSyncAt: validLatestRunAt ?? validLastSuccessAt,
    state: stale || latestFailed ? "warn" : "ok",
    status: latestStatus,
  };
}

function GpsSyncIndicator({ freshness }: { freshness: GpsSyncFreshness }) {
  const statusSuffix = freshness.status && freshness.status !== "success" ? ` · ${freshness.status}` : "";
  const text = freshness.lastSyncAt ? `${relativeTime(freshness.lastSyncAt)}${statusSuffix}` : "bez dát";
  const tone = freshness.state === "warn" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200";
  const Icon = freshness.state === "warn" ? AlertTriangle : CheckCircle2;
  return (
    <span
      title="Najnovší Commander positions/full beh; warning pri chybe alebo bez úspechu dlhšie než 10 min"
      className={`mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${tone}`}
    >
      <Icon size={12} className="shrink-0" />
      Posledný GPS sync: {text}
    </span>
  );
}

function fleetGpsOverview(assets: FleetAsset[]): FleetGpsOverview {
  const webdispecinkAssets = assets.filter((asset) => asset.gps?.source === "webdispecink");
  const staleCount = webdispecinkAssets.filter((asset) => asset.gps?.stale).length;
  const latestPositionAt = latestIsoDate(webdispecinkAssets.map((asset) => asset.gps?.positionTime));
  const latestSyncAt = latestIsoDate(webdispecinkAssets.map((asset) => asset.gps?.syncedAt ?? asset.gps?.positionTime ?? asset.lastSeen));
  const syncIsOld = !latestSyncAt || Date.now() - Date.parse(latestSyncAt) > 10 * 60 * 1000;
  const state = webdispecinkAssets.length === 0 ? "bad" : staleCount > 0 || syncIsOld ? "warn" : "ok";
  const liveCount = webdispecinkAssets.length - staleCount;

  return {
    state,
    webdispecinkCount: webdispecinkAssets.length,
    liveCount,
    staleCount,
    latestPositionAt,
    latestSyncAt,
    detail:
      webdispecinkAssets.length === 0
        ? "Žiadna odťahovka nemá polohu z WebDispečinku."
        : staleCount > 0
          ? `${staleCount} vozidiel má staršiu polohu ako 10 min.`
          : syncIsOld
            ? "Posledná synchronizácia je staršia ako 10 min."
            : "Poloha je aktuálna.",
  };
}

function latestIsoDate(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

const fleetKindOptions: Array<readonly [FleetAssetKind, string]> = [
  ["replacement_car", "Náhradné vozidlo"],
  ["tow_truck", "Odťahovka"],
];

const docRank = {
  expired: 0,
  soon: 1,
  ok: 2,
  missing: 3,
};

const docTone = {
  expired: "bg-red-50 text-red-700 ring-1 ring-red-200",
  soon: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  ok: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  missing: "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200",
};

const docLabel = {
  expired: "Expirované",
  soon: "Končí čoskoro",
  ok: "OK",
  missing: "Nezadané",
};
