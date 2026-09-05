import type {
  FleetAsset,
  FleetAssetCategory,
  FleetAssetOccupancyType,
  FleetAssetStatus,
  FleetDriverStatus,
  TowCapability,
  TowTruckCategory,
} from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import type { SimpleIcon } from "simple-icons";
import {
  siAudi,
  siBmw,
  siCitroen,
  siDacia,
  siFord,
  siHyundai,
  siIveco,
  siKia,
  siMan,
  siOpel,
  siPeugeot,
  siRenault,
  siScania,
  siSkoda,
  siToyota,
  siVolkswagen,
  siVolvo,
} from "simple-icons";

export const statusOptions: FleetAssetStatus[] = ["available", "reserved", "rented", "assigned", "busy", "service", "offline"];

export function BrandBadge({ make, size = "md" }: { make?: string; size?: "md" | "lg" }) {
  const brand = brandVisual(make);
  const sizeClass = size === "lg" ? "h-12 w-12 text-sm" : "h-9 w-9 text-xs";
  const iconSizeClass = size === "lg" ? "h-7 w-7" : "h-5 w-5";

  return (
    <span
      title={brand.name}
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-white ring-1 ${sizeClass} ${brand.className}`}
      style={brand.icon ? { color: `#${brand.icon.hex}` } : undefined}
      aria-label={brand.name}
    >
      {brand.icon ? (
        <svg viewBox="0 0 24 24" className={iconSizeClass} aria-hidden="true" focusable="false">
          <path fill="currentColor" d={brand.icon.path} />
        </svg>
      ) : (
        <span className="font-semibold leading-none tracking-normal">{brand.mark}</span>
      )}
    </span>
  );
}

export function StatusPill({ status }: { status: FleetAssetStatus }) {
  return <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusTone[status]}`}>{statusLabel[status]}</span>;
}

export function fleetAvailability(asset: FleetAsset) {
  if (asset.availabilityVerified === false) return { label: "Stav neoverený", tone: "bg-amber-50 text-amber-800 ring-1 ring-amber-200" };
  if (asset.kind === "replacement_car" && asset.occupancy) {
    const labels = { free: "Voľné", occupied: "Obsadené", stale: "Stav neaktuálny", unverified: "Stav neoverený" };
    return {
      label: labels[asset.occupancy],
      tone: asset.occupancy === "free" ? statusTone.available : asset.occupancy === "occupied" ? statusTone.rented : "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
    };
  }
  return { label: statusLabel[asset.status], tone: statusTone[asset.status] };
}

export function FleetAvailabilityPill({ asset }: { asset: FleetAsset }) {
  const state = fleetAvailability(asset);
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${state.tone}`}>{state.label}</span>;
}

export function fleetDateTime(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("sk-SK", { dateStyle: "short", timeStyle: "short", timeZone: MOTORIST_TIME_ZONE }).format(new Date(value));
}

export function matchesSearch(asset: FleetAsset, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [asset.label, asset.make, asset.model, asset.licensePlate, asset.vin].filter(Boolean).join(" ").toLowerCase().includes(needle);
}

export function occupancyText(asset: FleetAsset, caseNumberById?: Map<string, string>) {
  if (asset.availabilityVerified === false) return "Stav neoverený · GPS neposkytuje obsadenosť";
  if (asset.kind === "replacement_car" && asset.occupancy) {
    return asset.swhouse?.observedSince && (asset.occupancy === "free" || asset.occupancy === "occupied")
      ? `${fleetAvailability(asset).label} · pozorované od ${fleetDateTime(asset.swhouse.observedSince)}`
      : fleetAvailability(asset).label;
  }
  if (asset.status === "available" && !asset.occupiedFrom && !asset.occupiedUntil) {
    return "Voľné";
  }

  const caseNumber = asset.occupancyCaseId ? caseNumberById?.get(asset.occupancyCaseId) : undefined;
  const from = asset.occupiedFrom ? `od ${formatDate(asset.occupiedFrom)}` : "";
  const until = asset.occupiedUntil ? `do ${formatDate(asset.occupiedUntil)}` : "";
  return [occupancyTypeLabel(asset.occupancyType), caseNumber, from, until].filter(Boolean).join(" · ") || statusLabel[asset.status];
}

export function gpsStatusText(asset: FleetAsset) {
  if (asset.positionKnown === false) return "Bez overenej polohy";
  if (!asset.gps) {
    return "Manuálna poloha";
  }

  const positionText = asset.gps.positionTime ? relativeTime(asset.gps.positionTime) : "bez času";
  const speedText = typeof asset.gps.speedKph === "number" ? ` · ${Math.round(asset.gps.speedKph)} km/h` : "";

  return `${gpsSourceLabel(asset.gps.source)} · ${asset.gps.stale ? "staršia poloha · " : ""}${positionText}${speedText}`;
}

export function gpsTone(asset: FleetAsset) {
  if (!asset.gps) {
    return "bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200";
  }

  if (asset.gps.stale) {
    return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
  }

  return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
}

export function occupancyTypeLabel(value: FleetAsset["occupancyType"]) {
  if (!value) {
    return "";
  }

  return occupancyLabels[value];
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("sk-SK", { day: "2-digit", month: "2-digit", timeZone: MOTORIST_TIME_ZONE }).format(new Date(value));
}

export function relativeTime(value: string) {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat("sk-SK", { numeric: "auto" });

  if (absoluteSeconds < 60) {
    return formatter.format(diffSeconds, "second");
  }

  const diffMinutes = Math.round(diffSeconds / 60);

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);

  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  return formatter.format(Math.round(diffHours / 24), "day");
}

export function gpsSourceLabel(source: string) {
  const labels: Record<string, string> = {
    webdispecink: "WebDispečink",
    commander: "Commander",
    client_vehicle_db: "SWHouse",
    manual: "Manuál",
    seed: "Seed",
    settings_form: "Nastavenia",
  };

  return labels[source] ?? source;
}

export function statusRank(status: FleetAssetStatus) {
  return statusOptions.indexOf(status);
}

export function brandVisual(make: string | undefined) {
  const normalized = normalizeMake(make);
  const known = normalized ? brandBadges[normalized] : undefined;

  if (known) {
    return known;
  }

  const fallbackMark = make?.trim().slice(0, 2).toUpperCase() || "PM";

  return {
    name: make?.trim() || "Pomoc Motoristom",
    mark: fallbackMark,
    className: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  };
}

export function normalizeMake(make: string | undefined) {
  return make
    ?.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export const statusLabel: Record<FleetAssetStatus, string> = {
  available: "Dostupné",
  reserved: "Rezervované",
  rented: "Prenajaté",
  assigned: "Priradené",
  busy: "Na výjazde",
  service: "Servis",
  offline: "Mimo",
};

export const statusTone: Record<FleetAssetStatus, string> = {
  available: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  reserved: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  rented: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  assigned: "bg-yellow-50 text-yellow-800 ring-1 ring-yellow-200",
  busy: "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  service: "bg-zinc-100 text-zinc-700 ring-1 ring-zinc-200",
  offline: "bg-red-50 text-red-700 ring-1 ring-red-200",
};

export const driverStatusLabel: Record<FleetDriverStatus, string> = {
  available: "Dostupný",
  on_shift: "Služba",
  on_call: "Na zásahu",
  off_shift: "Mimo služby",
};

export const driverStatusTone: Record<FleetDriverStatus, string> = {
  available: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  on_shift: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  on_call: "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  off_shift: "bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200",
};

export const categoryLabel: Record<FleetAssetCategory, string> = {
  small_car: "Malé auto",
  wagon: "Kombi",
  suv: "SUV",
  van: "Dodávka",
  personal_tow: "Osobné vozidlá",
  van_tow: "Dodávky",
  specialized_tow: "Špecializované",
  heavy_tow: "Kamiónové/ťažké",
};

export const towCategoryLabel: Record<TowTruckCategory, string> = {
  personal: "Osobné vozidlá",
  van: "Dodávky",
  specialized: "Špecializované",
  heavy: "Kamiónové/ťažké",
};

export const capabilityLabel: Record<TowCapability, string> = {
  winch: "Navijak",
  low_garage: "Nízka garáž",
  vans: "Dodávky",
  trucks: "Kamióny",
  immobile: "Nepojazdné",
  crashed: "Havarované",
};

export const occupancyLabels: Record<FleetAssetOccupancyType, string> = {
  reservation: "Rezervácia",
  rental: "Prenájom",
  case_assignment: "Prípad",
};

export const brandBadges: Record<string, { name: string; mark: string; className: string; icon?: SimpleIcon }> = {
  audi: { name: "Audi", mark: "AU", className: "text-zinc-900 ring-zinc-200", icon: siAudi },
  bmw: { name: "BMW", mark: "BMW", className: "text-sky-800 ring-sky-200", icon: siBmw },
  citroen: { name: "Citroen", mark: "CT", className: "text-red-700 ring-red-200", icon: siCitroen },
  dacia: { name: "Dacia", mark: "DC", className: "text-teal-800 ring-teal-200", icon: siDacia },
  ford: { name: "Ford", mark: "FD", className: "text-blue-800 ring-blue-200", icon: siFord },
  hyundai: { name: "Hyundai", mark: "H", className: "text-cyan-800 ring-cyan-200", icon: siHyundai },
  isuzu: { name: "Isuzu", mark: "IZ", className: "text-red-800 ring-red-200" },
  iveco: { name: "Iveco", mark: "IV", className: "text-indigo-800 ring-indigo-200", icon: siIveco },
  kia: { name: "Kia", mark: "KIA", className: "text-rose-800 ring-rose-200", icon: siKia },
  man: { name: "MAN", mark: "MAN", className: "text-slate-800 ring-slate-300", icon: siMan },
  mercedesbenz: { name: "Mercedes-Benz", mark: "MB", className: "text-neutral-800 ring-neutral-300" },
  opel: { name: "Opel", mark: "OP", className: "text-yellow-800 ring-yellow-200", icon: siOpel },
  peugeot: { name: "Peugeot", mark: "PG", className: "text-zinc-800 ring-zinc-300", icon: siPeugeot },
  renault: { name: "Renault", mark: "RN", className: "text-amber-800 ring-amber-200", icon: siRenault },
  scania: { name: "Scania", mark: "SC", className: "text-blue-900 ring-blue-200", icon: siScania },
  skoda: { name: "Škoda", mark: "SK", className: "text-emerald-800 ring-emerald-200", icon: siSkoda },
  toyota: { name: "Toyota", mark: "TY", className: "text-red-800 ring-red-200", icon: siToyota },
  volkswagen: { name: "Volkswagen", mark: "VW", className: "text-blue-800 ring-blue-200", icon: siVolkswagen },
  volvo: { name: "Volvo", mark: "VO", className: "text-slate-800 ring-slate-300", icon: siVolvo },
};
