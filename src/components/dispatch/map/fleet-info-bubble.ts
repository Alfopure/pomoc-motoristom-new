import type { Branch, FleetAsset } from "@/domain/types";
import { driverStatusLabel, gpsStatusText, occupancyText, statusLabel, statusTone } from "@/lib/fleet-presentation";

// Obsah pre google.maps.InfoWindow sa skladá mimo Reactu, preto sa bublina
// stavia cez DOM API (textContent chráni pred vložením HTML z dát).

export function createFleetBubbleHeader(asset: FleetAsset) {
  const header = document.createElement("div");
  header.className = "flex min-w-0 items-baseline gap-2";

  const name = document.createElement("span");
  name.className = "truncate text-sm font-semibold text-zinc-950";
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
  root.className = "grid w-56 max-w-full gap-1.5 pt-1 text-xs text-zinc-600";

  const statusRow = document.createElement("div");
  statusRow.className = "flex min-w-0 flex-wrap items-center gap-1.5";

  const status = document.createElement("span");
  status.className = `shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusTone[asset.status]}`;
  status.textContent = statusLabel[asset.status];
  statusRow.append(status);

  const occupancy = occupancyText(asset);
  if (occupancy && occupancy !== statusLabel[asset.status]) {
    const occupancyEl = document.createElement("span");
    occupancyEl.className = "min-w-0 truncate font-medium text-zinc-500";
    occupancyEl.textContent = occupancy;
    statusRow.append(occupancyEl);
  }

  root.append(statusRow);

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

  root.append(bubbleLine("Pobočka", branch?.name ?? "Bez pobočky"));

  return root;
}

function bubbleLine(label: string, value: string, valueClass = "text-zinc-900") {
  const line = document.createElement("div");
  line.className = "flex items-baseline justify-between gap-3";

  const labelEl = document.createElement("span");
  labelEl.className = "shrink-0 font-medium text-zinc-400";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = `min-w-0 truncate text-right font-semibold ${valueClass}`;
  valueEl.textContent = value;

  line.append(labelEl, valueEl);
  return line;
}
