export type FleetIdentity = { id: string; plate?: string | null; vin?: string | null };
export const pairingKey = (value?: string | null) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function vinFromRegistration(value: unknown): string | null {
  const normalized = typeof value === "string" ? pairingKey(value) : "";
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalized) ? normalized : null;
}

/** Both sides must be unique. Conflicting VIN/plate identities and many-to-one matches require a human. */
export function matchFleetIdentities(sources: FleetIdentity[], targets: FleetIdentity[]) {
  const index = (items: FleetIdentity[], field: "vin" | "plate") => {
    const map = new Map<string, FleetIdentity[]>();
    for (const item of items) {
      const key = pairingKey(item[field]);
      if (key) map.set(key, [...map.get(key) ?? [], item]);
    }
    return map;
  };
  const sp = index(sources, "plate"), sv = index(sources, "vin");
  const tp = index(targets, "plate"), tv = index(targets, "vin");
  const proposed = sources.flatMap((source) => {
    const plate = pairingKey(source.plate), vin = pairingKey(source.vin);
    const plateMatches = tp.get(plate) ?? [], vinMatches = tv.get(vin) ?? [];
    const byPlate = plate && sp.get(plate)?.length === 1 && plateMatches.length === 1 ? plateMatches[0] : undefined;
    const byVin = vin && sv.get(vin)?.length === 1 && vinMatches.length === 1 ? vinMatches[0] : undefined;
    if (byVin && plateMatches.length && !plateMatches.some((target) => target.id === byVin.id)) return [];
    if (byPlate && vin && pairingKey(byPlate.vin) && pairingKey(byPlate.vin) !== vin) return [];
    const target = byVin ?? byPlate;
    return target ? [{ sourceId: source.id, targetId: target.id, method: byVin ? "vin" as const : "license_plate" as const }] : [];
  });
  return proposed.filter((match) => proposed.filter((candidate) => candidate.targetId === match.targetId).length === 1);
}
