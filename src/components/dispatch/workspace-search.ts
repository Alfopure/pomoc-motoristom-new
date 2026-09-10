import type { DispatchCase, FleetAsset, PartnerDirectoryEntry } from "@/domain/types";

export function normalizeWorkspaceSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("sk").replace(/[^a-z0-9]/g, "");
}
export type WorkspaceSearchResult = { kind: "case" | "contact" | "fleet"; id: string; label: string; detail: string; caseId?: string; phone?: string };
export function searchWorkspace(query: string, cases: DispatchCase[], contacts: PartnerDirectoryEntry[], fleet: FleetAsset[]): WorkspaceSearchResult[] {
  const needle = normalizeWorkspaceSearch(query);
  if (!needle) return [];
  const matches = (...values: (string | undefined)[]) => values.some(value => value && normalizeWorkspaceSearch(value).includes(needle));
  const results: WorkspaceSearchResult[] = [];
  for (const item of cases) if (matches(item.caseNumber, item.contact.name, item.contact.phone, item.vehicle.licensePlate)) {
    results.push({ kind: "case", id: item.id, caseId: item.id, label: item.caseNumber, detail: `${item.contact.name} · ${item.vehicle.licensePlate}`, phone: item.contact.phone });
  }
  for (const item of contacts) if (item.active && matches(item.name, item.phone)) {
    results.push({ kind: "contact", id: item.id, label: item.name, detail: item.phone ?? "Bez telefónu", phone: item.phone });
  }
  for (const item of fleet) if (matches(item.label, item.licensePlate, item.make, item.model)) {
    results.push({ kind: "fleet", id: item.id, label: item.licensePlate, detail: `${item.label} · ${fleetWidgetStatus(item)}` });
  }
  return results.slice(0, 30);
}

export function fleetWidgetStatus(asset: FleetAsset): string {
  if (asset.kind === "replacement_car") {
    switch (asset.occupancy) {
      case "free": return "Voľné";
      case "occupied": return "Obsadené";
      case "stale": return "Obsadenosť neaktuálna";
      default: return "Obsadenosť neoverená";
    }
  }
  const labels: Record<FleetAsset["status"], string> = { available: "Voľné", reserved: "Rezervované", rented: "Prenajaté", assigned: "Pridelené", busy: "Obsadené", service: "V servise", offline: "Nedostupné" };
  return labels[asset.status];
}
