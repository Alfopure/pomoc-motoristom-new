import type { Branch, DispatchCase, FleetAsset, GeoPoint, PriceRule } from "@/domain/types";
import { requiresTowDestination } from "@/domain/case-card";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import { renderEtaUpdateSmsPreview, renderLocationRequestSmsPreview } from "@/lib/sms/templates";

const EARTH_RADIUS_KM = 6371;

function toRad(value: number) {
  return (value * Math.PI) / 180;
}

export function distanceKm(from: GeoPoint, to: GeoPoint) {
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_KM * c * 10) / 10;
}

export function etaMinutes(distance: number) {
  return Math.max(12, Math.round((distance / 68) * 60 + 10));
}

export function calculateAssetArrivalEta(from: GeoPoint, to: GeoPoint) {
  const directKm = distanceKm(from, to);
  const operationalKm = roundOne(directKm * 1.22);

  return {
    directKm,
    operationalKm,
    eta: Math.max(8, Math.round((operationalKm / 58) * 60 + 8)),
  };
}

export function findNearestBranch(caseItem: DispatchCase, branches: Branch[]) {
  const pickup = caseItem.pickup;
  if (!pickup) {
    return undefined;
  }

  return branches
    .map((branch) => ({
      branch,
      distance: distanceKm(pickup, branch.point),
    }))
    .sort((a, b) => a.distance - b.distance)[0];
}

export function findNearestAsset(caseItem: DispatchCase, assets: FleetAsset[]) {
  const pickup = caseItem.pickup;
  if (!pickup) {
    return undefined;
  }

  const recommendedTow = recommendAssetForCase(caseItem, assets, "tow_truck");

  if (recommendedTow) {
    return {
      asset: recommendedTow.asset,
      distance: recommendedTow.distance,
    };
  }

  const recommendedAnyAsset = recommendAssetForCase(caseItem, assets);

  if (recommendedAnyAsset) {
    return {
      asset: recommendedAnyAsset.asset,
      distance: recommendedAnyAsset.distance,
    };
  }

  const eligibleFallback = assets.filter(
    (asset) =>
      asset.status !== "service" &&
      asset.status !== "offline" &&
      (asset.kind !== "replacement_car" || asset.occupancy !== "occupied"),
  );
  const nearestEligible = eligibleFallback
    .map((asset) => ({
      asset,
      distance: distanceKm(pickup, asset.point),
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  return nearestEligible;
}

export type AssetRecommendation = {
  asset: FleetAsset;
  distance: number;
  score: number;
  reasons: string[];
  warnings: string[];
};

export function recommendAssetForCase(
  caseItem: DispatchCase,
  assets: FleetAsset[],
  kind?: FleetAsset["kind"],
): AssetRecommendation | undefined {
  const pickup = caseItem.pickup;
  if (!pickup) {
    return undefined;
  }

  const candidates = (kind ? assets.filter((asset) => asset.kind === kind) : assets).filter(
    (asset) => asset.kind !== "replacement_car" || asset.occupancy !== "occupied",
  );

  return candidates
    .map((asset) => scoreAssetForCase(caseItem, asset, pickup))
    .filter((recommendation) => recommendation.score > -120)
    .sort((left, right) => right.score - left.score || left.distance - right.distance)[0];
}

function scoreAssetForCase(caseItem: DispatchCase, asset: FleetAsset, pickup: GeoPoint): AssetRecommendation {
  const distance = distanceKm(pickup, asset.point);
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = availabilityScore(asset, reasons, warnings);

  score -= distance * 1.2;

  if (asset.branchId === caseItem.branchId) {
    score += 8;
    reasons.push("rovnaká pobočka");
  }

  if (asset.kind === "tow_truck") {
    score += towSuitabilityScore(caseItem, asset, reasons, warnings);
  } else {
    score += replacementSuitabilityScore(caseItem, asset, reasons, warnings);
  }

  score += documentScore(asset, warnings);

  if (distance <= 15) {
    score += 12;
    reasons.push("veľmi blízko pickup miesta");
  } else if (distance <= 45) {
    score += 6;
    reasons.push("dobrý dojazd");
  }

  return {
    asset,
    distance,
    score: Math.round(score),
    reasons: reasons.slice(0, 4),
    warnings,
  };
}

function availabilityScore(asset: FleetAsset, reasons: string[], warnings: string[]) {
  const now = new Date();
  const startsAt = parseDate(asset.occupiedFrom);
  const endsAt = parseDate(asset.occupiedUntil);
  const occupiedNow = Boolean(startsAt && startsAt <= now && (!endsAt || endsAt >= now));

  if (asset.kind === "replacement_car" && asset.status === "available" && asset.occupancy === "stale") {
    warnings.push("SWHouse obsadenosť je neaktuálna — dostupnosť treba overiť");
    return 10;
  }

  if (asset.kind === "replacement_car" && asset.status === "available" && asset.occupancy === "unverified") {
    warnings.push("vozidlo nie je overené v SWHouse");
    return 20;
  }

  if (asset.status === "available") {
    reasons.push("dostupné");
    return 130;
  }

  if (asset.status === "reserved") {
    if (occupiedNow) {
      warnings.push("aktuálne rezervované");
      return -70;
    }

    if (startsAt && startsAt.getTime() - now.getTime() <= 12 * 60 * 60 * 1000) {
      warnings.push(`rezervácia začína ${formatShortDateTime(startsAt)}`);
      return 25;
    }

    warnings.push("rezervované neskôr");
    return 55;
  }

  if (asset.status === "rented") {
    warnings.push(endsAt ? `prenajaté do ${formatShortDateTime(endsAt)}` : "prenajaté");
    return -95;
  }

  if (asset.status === "assigned" || asset.status === "busy") {
    warnings.push(endsAt ? `obsadené do ${formatShortDateTime(endsAt)}` : "obsadené");
    return -55;
  }

  if (asset.status === "service") {
    warnings.push("v servise");
    return -140;
  }

  warnings.push("mimo prevádzky");
  return -180;
}

function towSuitabilityScore(caseItem: DispatchCase, asset: FleetAsset, reasons: string[], warnings: string[]) {
  const text = caseSearchText(caseItem);
  let score = 0;

  if (includesAny(text, ["dodavka", "sprinter", "transit", "jumper", "ducato", "nalozena"])) {
    if (asset.towCategory === "van" || asset.towCategory === "specialized" || asset.towCategory === "heavy") {
      score += 38;
      reasons.push("vhodné pre dodávku");
    } else {
      score -= 28;
      warnings.push("slabšia zhoda pre dodávku");
    }

    if (asset.capabilities.includes("vans")) {
      score += 18;
    }
  }

  if (includesAny(text, ["kamion", "naklad", "tazk", "truck"])) {
    if (asset.towCategory === "heavy" || asset.capabilities.includes("trucks")) {
      score += 55;
      reasons.push("ťažká technika");
    } else {
      score -= 90;
      warnings.push("nevhodné pre ťažké vozidlo");
    }
  }

  if (includesAny(text, ["garaz", "podzem", "-2", "nizk"])) {
    if (asset.capabilities.includes("low_garage")) {
      score += 42;
      reasons.push("nízka garáž");
    } else {
      score -= 34;
      warnings.push("overiť výšku garáže");
    }
  }

  if (includesAny(text, ["nepojazd", "blokovan", "havar", "nehod", "koleso"])) {
    if (asset.capabilities.includes("winch")) {
      score += 18;
    }
    if (asset.capabilities.includes("immobile") || asset.capabilities.includes("crashed")) {
      score += 18;
      reasons.push("nepojazdné/havarované");
    }
  }

  return score;
}

function replacementSuitabilityScore(caseItem: DispatchCase, asset: FleetAsset, reasons: string[], warnings: string[]) {
  const text = caseSearchText(caseItem);
  let score = 0;

  if (!includesAny(text, ["nahrad", "prenaj", "mobilita", "poistn"])) {
    score -= 12;
  }

  if (includesAny(text, ["dodavka", "sprinter", "transit", "jumper", "ducato"])) {
    if (asset.category === "van") {
      score += 52;
      reasons.push("náhradná dodávka");
    } else {
      score -= 42;
      warnings.push("klient má dodávku");
    }
  } else if (includesAny(text, ["suv", "x3", "kodiaq", "rodina", "batozina"])) {
    if (asset.category === "suv" || asset.category === "wagon") {
      score += 30;
      reasons.push("veľkosť sedí klientovi");
    } else {
      score -= 16;
    }
  } else if (asset.category === "small_car" || asset.category === "wagon") {
    score += 16;
    reasons.push("bežná náhrada");
  }

  return score;
}

function documentScore(asset: FleetAsset, warnings: string[]) {
  const documents = [
    ["poistenie", asset.insuranceValidUntil],
    ["diaľničná", asset.highwayVignetteValidUntil],
    ["STK", asset.technicalInspectionValidUntil],
    ["EK", asset.emissionInspectionValidUntil],
  ] as const;

  return documents.reduce((score, [label, date]) => {
    const days = daysUntil(date);

    if (days === null) {
      return score;
    }

    if (days < 0) {
      warnings.push(`${label} expirované`);
      return score - 45;
    }

    if (days <= 30) {
      warnings.push(`${label} končí do 30 dní`);
      return score - 8;
    }

    return score;
  }, 0);
}

function caseSearchText(caseItem: DispatchCase) {
  return normalizeText(
    [
      caseItem.caseType,
      caseItem.summary,
      caseItem.mainNote,
      caseItem.vehicle.category,
      caseItem.vehicle.make,
      caseItem.vehicle.model,
      caseItem.vehicle.issue,
      caseItem.vehicle.specifics,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function includesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function parseDate(value: string | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysUntil(value: string | undefined) {
  const date = parseDate(value);
  if (!date) {
    return null;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.ceil((date.getTime() - today.getTime()) / 86_400_000);
}

function formatShortDateTime(value: Date) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(value);
}

export function calculateRoute(caseItem: DispatchCase) {
  if (!caseItem.pickup) {
    return null;
  }

  if (!requiresTowDestination(caseItem.jobTypes)) {
    return {
      directKm: 0,
      operationalKm: 0,
      eta: 0,
      polyline: [caseItem.pickup],
    };
  }

  if (!caseItem.destination) {
    return null;
  }

  const directKm = distanceKm(caseItem.pickup, caseItem.destination);
  const operationalKm = Math.round(directKm * 1.18 * 10) / 10;
  return {
    directKm,
    operationalKm,
    eta: etaMinutes(operationalKm),
    polyline: [caseItem.pickup, caseItem.destination],
  };
}

export type DispatchRouteSegment = {
  id: string;
  label: string;
  detail: string;
  from: GeoPoint;
  to: GeoPoint;
  directKm: number;
  operationalKm: number;
  eta: number;
  tone: "asset" | "tow" | "handover";
};

export type DispatchRoutePlan = {
  segments: DispatchRouteSegment[];
  totalDirectKm: number;
  totalOperationalKm: number;
  totalEta: number;
  googleReady: boolean;
};

export function calculateRoutePlan(caseItem: DispatchCase, branch: Branch, asset: FleetAsset): DispatchRoutePlan | null {
  if (!caseItem.pickup) {
    return null;
  }

  const needsDestination = requiresTowDestination(caseItem.jobTypes);
  if (needsDestination && !caseItem.destination) {
    return null;
  }

  const pickup = caseItem.pickup;
  const destination = caseItem.destination;
  const segments = [
    routeSegment({
      id: "asset-to-pickup",
      label: "Výjazd techniky",
      detail: `${asset.label} → ${pickup.label}`,
      from: asset.point,
      to: pickup,
      roadFactor: 1.22,
      speedKmh: 58,
      tone: "asset",
    }),
    ...(needsDestination
      ? [
          routeSegment({
            id: "pickup-to-destination",
            label: "Odťah klienta",
            detail: `${pickup.label} → ${destination!.label}`,
            from: pickup,
            to: destination!,
            roadFactor: 1.18,
            speedKmh: 68,
            tone: "tow" as const,
          }),
        ]
      : []),
    routeSegment({
      id: "destination-to-branch",
      label: "Uzavretie výjazdu",
      detail: `${needsDestination ? destination!.label : pickup.label} → ${branch.name}`,
      from: needsDestination ? destination! : pickup,
      to: branch.point,
      roadFactor: 1.2,
      speedKmh: 62,
      tone: "handover",
    }),
  ];

  return {
    segments,
    totalDirectKm: roundOne(segments.reduce((total, segment) => total + segment.directKm, 0)),
    totalOperationalKm: roundOne(segments.reduce((total, segment) => total + segment.operationalKm, 0)),
    totalEta: segments.reduce((total, segment) => total + segment.eta, 0),
    googleReady: true,
  };
}

/**
 * Bez bezpečne použiteľnej techniky nevymýšľame výjazd z obsadeného/offline assetu.
 * Zostane iba orientačná trasa klient → cieľ → pobočka, kým dispečer techniku neuvoľní.
 */
export function calculateUnassignedRoutePlan(caseItem: DispatchCase, branch: Branch): DispatchRoutePlan | null {
  if (!caseItem.pickup) {
    return null;
  }

  const needsDestination = requiresTowDestination(caseItem.jobTypes);
  if (needsDestination && !caseItem.destination) {
    return null;
  }

  const pickup = caseItem.pickup;
  const destination = caseItem.destination;
  const segments = [
    ...(needsDestination
      ? [
          routeSegment({
            id: "pickup-to-destination",
            label: "Odťah klienta",
            detail: `${pickup.label} → ${destination!.label}`,
            from: pickup,
            to: destination!,
            roadFactor: 1.18,
            speedKmh: 68,
            tone: "tow" as const,
          }),
        ]
      : []),
    routeSegment({
      id: "destination-to-branch",
      label: "Orientačná trasa k pobočke",
      detail: `${needsDestination ? destination!.label : pickup.label} → ${branch.name}`,
      from: needsDestination ? destination! : pickup,
      to: branch.point,
      roadFactor: 1.2,
      speedKmh: 62,
      tone: "handover",
    }),
  ];

  return {
    segments,
    totalDirectKm: roundOne(segments.reduce((total, segment) => total + segment.directKm, 0)),
    totalOperationalKm: roundOne(segments.reduce((total, segment) => total + segment.operationalKm, 0)),
    totalEta: segments.reduce((total, segment) => total + segment.eta, 0),
    googleReady: false,
  };
}

function routeSegment({
  id,
  label,
  detail,
  from,
  to,
  roadFactor,
  speedKmh,
  tone,
}: {
  id: string;
  label: string;
  detail: string;
  from: GeoPoint;
  to: GeoPoint;
  roadFactor: number;
  speedKmh: number;
  tone: DispatchRouteSegment["tone"];
}): DispatchRouteSegment {
  const directKm = distanceKm(from, to);
  const operationalKm = roundOne(directKm * roadFactor);

  return {
    id,
    label,
    detail,
    from,
    to,
    directKm,
    operationalKm,
    eta: Math.max(8, Math.round((operationalKm / speedKmh) * 60 + 8)),
    tone,
  };
}

function roundOne(value: number) {
  return Math.round(value * 10) / 10;
}

export function calculatePrice(distance: number, rule: PriceRule) {
  const subtotal = Math.max(rule.minimumPrice, rule.baseFee + distance * rule.pricePerKm);
  const vat = subtotal * rule.vatRate;
  return {
    subtotal: Math.round(subtotal),
    vat: Math.round(vat),
    total: Math.round(subtotal + vat),
  };
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("sk-SK", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(new Date(value));
}

/**
 * Zobrazované meno asistenčnej služby prípadu: explicitné pole má prednosť,
 * pri asistenčnom zdroji/kontakte sa použije meno kontaktu (P-05).
 */
export function caseAssistanceServiceName(caseItem: DispatchCase) {
  const explicit = caseItem.customerDetails.assistanceServiceName?.trim();

  if (explicit) {
    return explicit;
  }

  if (caseItem.sourceType === "assistance" || caseItem.contact.role === "assistance") {
    return caseItem.contact.name?.trim() ?? "";
  }

  return "";
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(new Date(value));
}

export function buildSmsPreview(caseItem: DispatchCase, eta: number) {
  return `${renderLocationRequestSmsPreview(caseItem.caseNumber)}\n\n${renderEtaUpdateSmsPreview(caseItem.caseNumber, eta)}`;
}
