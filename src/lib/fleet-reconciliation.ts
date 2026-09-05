import type { CommanderVehicleConnection } from "@/data/dispatch-types";
import type { FleetAsset } from "@/domain/types";

/** Spreadsheet-safe CSV, including unpaired provider records (not only already-created assets). */
export function fleetReconciliationCsv(assets: FleetAsset[], commander: CommanderVehicleConnection[]) {
  const authoritative = assets.filter((asset) => asset.swhouseLinked);
  const linked = new Set<string>();
  const rows: unknown[][] = [["Zdroj", "SWH carId", "EČV", "VIN", "Vozidlo", "Stav SWH", "Overené", "Pozorované od", "Pobočka SWH", "Commander ID", "Commander EČV", "Párovanie", "GPS čas", "GPS aktuálnosť"]];
  for (const asset of authoritative) {
    const source = commander.find((source) => source.link?.status === "confirmed" && source.link.fleetAssetId === asset.id);
    if (source) linked.add(source.id);
    rows.push(["Software House", asset.swhouse?.carId, asset.licensePlate, asset.vin, asset.label, asset.occupancy,
      asset.swhouse?.checkedAt, asset.swhouse?.observedSince, asset.swhouse?.branchName,
      source?.sourceVehicleId, source?.licensePlate, source?.link?.matchMethod ?? "bez zhody",
      source?.position?.gpsTime, source?.position ? source.position.stale ? "staršia" : "aktuálna" : "bez polohy"]);
  }
  for (const source of commander.filter((source) => source.sourceActive && !linked.has(source.id))) {
    rows.push(["Commander bez zhody", "", source.licensePlate, source.vin, source.label, "neoverený", "", "", "", source.sourceVehicleId, source.licensePlate, "ručná kontrola", source.position?.gpsTime, source.position ? source.position.stale ? "staršia" : "aktuálna" : "bez polohy"]);
  }
  return rows.map((row) => row.map((value) => {
    let cell = String(value ?? "");
    if (/^[\s]*[=+@-]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replace(/"/g, '""')}"`;
  }).join(";")).join("\r\n");
}
