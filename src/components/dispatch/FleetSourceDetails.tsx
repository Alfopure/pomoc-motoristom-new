"use client";
import type { CommanderVehicleConnection, FleetProviderVehicle, IntegrationConnection } from "@/data/dispatch-types";
import type { FleetAsset } from "@/domain/types";
import { isFreshFleetTimestamp } from "@/lib/fleet-observation";
import { FleetAvailabilityPill, fleetDateTime, gpsStatusText, relativeTime } from "@/lib/fleet-presentation";

export function FleetSourceHealth({ assets, commander, webdispecink, integrations }: {
  assets: FleetAsset[]; commander: CommanderVehicleConnection[]; webdispecink: FleetProviderVehicle[]; integrations: IntegrationConnection[];
}) {
  const sources = [
    { provider: "client_vehicle_db", title: "Software House", role: "Produkčný roster a obsadenosť", count: assets.filter((asset) => asset.swhouseLinked).length,
      detail: `${assets.filter((asset) => asset.occupancy === "free").length} voľných · ${assets.filter((asset) => asset.occupancy === "occupied").length} obsadených` },
    { provider: "commander", title: "Commander", role: "GPS náhradných vozidiel", count: commander.filter((car) => car.sourceActive).length,
      detail: `${commander.filter((car) => car.sourceActive && car.position).length} s polohou · ${commander.filter((car) => car.sourceActive && isFreshFleetTimestamp(car.position?.gpsTime)).length} čerstvých` },
    { provider: "fleet", title: "WebDispečink", role: "GPS odťahových vozidiel", count: webdispecink.filter((car) => !car.disabled).length,
      detail: `${webdispecink.filter((car) => car.linkedAssetId).length} napárovaných · ${webdispecink.filter((car) => isFreshFleetTimestamp(car.latestPositionAt)).length} čerstvých` },
  ];
  return <div className="mb-3 grid gap-2 md:grid-cols-3">{sources.map((source) => {
    const integration = integrations.find((item) => item.provider === source.provider);
    const fresh = integration?.status === "live" && isFreshFleetTimestamp(integration.lastSuccessAt);
    return <section key={source.provider} className="min-w-0 rounded-lg border border-zinc-200 bg-white px-3 py-2.5">
      <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{source.title}</h2><span className={`flex items-center gap-1.5 text-xs ${fresh ? "text-emerald-700" : "text-amber-800"}`}><span className={`h-1.5 w-1.5 rounded-full ${fresh ? "bg-emerald-500" : "bg-amber-500"}`} />{fresh ? "Pripojené" : "Overiť spojenie"}</span></div>
      <p className="mt-0.5 hidden text-xs text-zinc-500 md:block">{source.role}</p>
      <p className="mt-2 text-xs text-zinc-700"><strong className="text-base tabular-nums text-zinc-950">{source.count}</strong> vozidiel · {source.detail}</p>
      <p className="mt-1 text-[11px] text-zinc-500" title={fleetDateTime(integration?.lastSuccessAt)}>Úspešné čítanie: {integration?.lastSuccessAt ? relativeTime(integration.lastSuccessAt) : "zatiaľ neoverené"}</p>
    </section>;
  })}</div>;
}

const fieldLabels: Record<string, string> = {
  carId: "ID vozidla", ecv: "EČV", vin: "VIN", model: "Model", manufacturerId: "ID značky", colorId: "ID farby", typeId: "ID typu", ownerTypeId: "ID vlastníctva", cotp: "Číslo technického preukazu",
  lasFilialId: "ID pobočky", lastUserId: "ID posledného používateľa", rentId: "ID prenájmu", assistanceRentId: "ID asistenčného prenájmu", rentTo: "Prenájom do",
  price1: "Tarifa 1 (API)", price2: "Tarifa 2 (API)", price3: "Tarifa 3 (API)", price4: "Tarifa 4 (API)",
  insuranceValidUntil: "Poistenie do", lastCarService: "Posledný servis", insuranceDeductiblePercentage: "Spoluúčasť (%)", insuranceDeductibleAmount: "Spoluúčasť – suma (API)",
};

export function FleetSourceDetails({ asset }: { asset: FleetAsset }) {
  return <div className="mb-3 grid gap-3 text-xs">
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-zinc-600">{asset.swhouse ? "Software House · zdroj pravdy" : "Interný stav"}</span><FleetAvailabilityPill asset={asset} /></div>
      {asset.swhouse && <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-zinc-500">Overené</dt><dd className="text-right font-medium">{fleetDateTime(asset.swhouse.checkedAt)}</dd>
        <dt className="text-zinc-500">Pozorované od</dt><dd className="text-right font-medium">{fleetDateTime(asset.swhouse.observedSince)}</dd>
        <dt className="text-zinc-500">Pobočka SWH</dt><dd className="text-right font-medium">{asset.swhouse.branchName ?? "Nezadaná"}</dd>
        {asset.swhouse.rentTo && <><dt className="text-zinc-500">{asset.occupancy === "occupied" ? "Prenájom do" : "Posledný prenájom do"}</dt><dd className="text-right font-medium">{fleetDateTime(asset.swhouse.rentTo)}</dd></>}
      </dl>}
      {asset.swhouse && <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">„Pozorované od“ je začiatok súvislého sledovania stavu v tejto aplikácii. API neposkytuje skutočný začiatok obsadenosti.</p>}
    </div>
    {!!Object.keys(asset.gps?.details ?? {}).length && <details className="rounded-lg border border-zinc-200 p-3">
      <summary className="cursor-pointer font-semibold text-zinc-800">Telemetria z {asset.gps?.source === "commander" ? "Commandera" : "WebDispečinku"}</summary>
      <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2">{Object.entries(asset.gps?.details ?? {}).map(([key, value]) => <div key={key} className="contents"><dt className="break-words text-zinc-500">{telemetryLabels[key] ?? key}</dt><dd className="break-words text-right font-medium">{value === null || value === "" ? "—" : String(value)}</dd></div>)}</dl>
      <p className="mt-2 text-[11px] text-zinc-500">Hodnoty v tvare dodanom API. Dostupnosť vozidla sa z rýchlosti ani zapaľovania neodvodzuje.</p>
    </details>}
    <div className="rounded-lg border border-zinc-200 p-3">
      <h3 className="font-semibold text-zinc-900">{gpsStatusText(asset)}</h3>
      {asset.gps && <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-zinc-500">Čas merania</dt><dd className="text-right">{fleetDateTime(asset.gps.positionTime)}</dd>
        <dt className="text-zinc-500">Prijaté</dt><dd className="text-right">{fleetDateTime(asset.gps.syncedAt)}</dd>
        {asset.positionKnown !== false && <><dt className="text-zinc-500">Súradnice</dt><dd className="text-right font-mono text-[11px]">{asset.point.lat.toFixed(5)}, {asset.point.lng.toFixed(5)}</dd></>}
        {asset.gps.ignitionOn !== undefined && <><dt className="text-zinc-500">Zapaľovanie</dt><dd className="text-right">{asset.gps.ignitionOn ? "Zapnuté" : "Vypnuté"}</dd></>}
        {asset.gps.odometerKm !== undefined && <><dt className="text-zinc-500">Tachometer</dt><dd className="text-right">{Math.round(asset.gps.odometerKm).toLocaleString("sk-SK")} km</dd></>}
      </dl>}
    </div>
    {asset.swhouse && <details className="rounded-lg border border-zinc-200 p-3">
      <summary className="cursor-pointer font-semibold text-zinc-800">Všetky údaje zo Software House</summary>
      <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-zinc-500">Farba</dt><dd className="text-right">{asset.swhouse.color ?? "—"}</dd>
        <dt className="text-zinc-500">Vlastníctvo</dt><dd className="text-right">{asset.swhouse.ownerType ?? "—"}</dd>
        {Object.entries(asset.swhouse.details).map(([key, value]) => <div key={key} className="contents"><dt className="break-words text-zinc-500">{fieldLabels[key] ?? key}</dt><dd className="break-words text-right font-medium">{value === null || value === "" ? "—" : String(value)}</dd></div>)}
      </dl>
    </details>}
  </div>;
}

const telemetryLabels: Record<string, string> = {
  vehicleId: "ID vozidla", carid: "ID vozidla", gpsTime: "GPS čas", positiontime: "GPS čas", localpostime: "Lokálny GPS čas",
  gpsLat: "Zemepisná šírka", gpsLon: "Zemepisná dĺžka", gpsLAlt: "Nadmorská výška", gpsAzimut: "Azimut", gpsSpeed: "GPS rýchlosť",
  carIgnition: "Zapaľovanie", voltage: "Napätie (API)", canSpeed: "CAN rýchlosť", canThrottle: "CAN plyn", canConsumed: "CAN spotreba",
  canTankValue: "CAN palivo", canRpm: "Otáčky motora", canEngineHours: "Motohodiny", canOdometer: "CAN tachometer", temperatures: "Teploty",
  km: "Tachometer (API)", speed: "Rýchlosť (API)", fueltank: "Palivo (API)", Location_city: "Mesto", Location_state: "Krajina",
};
