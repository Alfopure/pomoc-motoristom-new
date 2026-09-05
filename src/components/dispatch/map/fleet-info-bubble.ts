import type { Branch, FleetAsset } from "@/domain/types";
import { driverStatusLabel, gpsStatusText, occupancyText, fleetAvailability, fleetDateTime } from "@/lib/fleet-presentation";

// Obsah pre google.maps.InfoWindow sa skladá mimo Reactu, preto sa bublina
// stavia cez DOM API (textContent chráni pred vložením HTML z dát).

export function createFleetBubbleHeader(asset: FleetAsset) {
  const header = document.createElement("div");
  header.className = "flex min-w-0 items-baseline gap-2";

  const name = document.createElement("span");
  name.className = "min-w-0 break-words text-sm font-semibold text-zinc-950";
  name.textContent = [asset.make, asset.model].filter(Boolean).join(" ") || asset.label;
  header.append(name);

  if (asset.licensePlate) {
    const plate = document.createElement("span");
    plate.className = "shrink-0 text-xs font-semibold text-zinc-500";
    plate.textContent = asset.licensePlate;
    header.append(plate);
  }

  return header;
}

export function createFleetBubbleContent(asset: FleetAsset, branch?: Branch) {
  const root = document.createElement("div");
  root.className = "grid w-72 max-w-full gap-2 pt-1 text-xs text-zinc-600";

  const statusRow = document.createElement("div");
  statusRow.className = "flex min-w-0 flex-wrap items-center gap-1.5";

  const status = document.createElement("span");
  const availability = fleetAvailability(asset);
  status.className = `shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${availability.tone}`;
  status.textContent = availability.label;
  statusRow.append(status);

  const occupancy = occupancyText(asset);
  if (!asset.swhouse && occupancy && occupancy !== availability.label) {
    const occupancyEl = document.createElement("span");
    occupancyEl.className = "min-w-0 font-medium text-zinc-500";
    occupancyEl.textContent = occupancy;
    statusRow.append(occupancyEl);
  }

  root.append(statusRow);
  if (asset.swhouse) {
    root.append(bubbleLine("Stav overený", `Software House · ${fleetDateTime(asset.swhouse.checkedAt)}`));
    if (asset.swhouse.observedSince) root.append(bubbleLine("Pozorované od", fleetDateTime(asset.swhouse.observedSince)));
    if (asset.swhouse.rentTo) root.append(bubbleLine(asset.occupancy === "occupied" ? "Prenájom do" : "Posledný prenájom do", fleetDateTime(asset.swhouse.rentTo)));
  }

  const gpsClass = !asset.gps ? "text-zinc-600" : asset.gps.stale ? "text-amber-700" : "text-emerald-700";
  root.append(bubbleLine("GPS", gpsStatusText(asset), gpsClass));

  const driverText = asset.assignedDriverName
    ? [
        asset.assignedDriverName,
        asset.assignedDriverStatus ? driverStatusLabel[asset.assignedDriverStatus] : "",
        asset.assignedDriverPhone ?? "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "Bez posádky";
  root.append(bubbleLine("Vodič", driverText));

  root.append(bubbleLine("Pobočka", asset.swhouse?.branchName ?? branch?.name ?? "Nepriradená"));
  if (asset.gps?.ignitionOn !== undefined) root.append(bubbleLine("Zapaľovanie", asset.gps.ignitionOn ? "Zapnuté" : "Vypnuté"));

  return root;
}

function bubbleLine(label: string, value: string, valueClass = "text-zinc-900") {
  const line = document.createElement("div");
  line.className = "flex items-baseline justify-between gap-3";

  const labelEl = document.createElement("span");
  labelEl.className = "shrink-0 font-medium text-zinc-400";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = `min-w-0 break-words text-right font-semibold ${valueClass}`;
  valueEl.textContent = value;

  line.append(labelEl, valueEl);
  return line;
}
