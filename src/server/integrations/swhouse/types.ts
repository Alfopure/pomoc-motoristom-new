import "server-only";

/**
 * Typy pre SWHouse API náhradných vozidiel (produkcia: app.pomocmotoristom.sk/rest).
 * Read-only integrácia, fáza 1 (žiadna perzistencia). Viď .omc/plans/swhouse-replacement-vehicles.md.
 */

export type SwhouseResponse<T> = {
  path: string;
  status: number;
  ok: boolean;
  data: T | null;
  /** Vždy redaktované — nikdy neobsahuje token/heslo/UserAuth. */
  error: string | null;
};

export type SwhouseLoginResponse = {
  token?: string;
  expirationISO?: string;
  login?: string;
};

/**
 * Surový tvar z carOccupancy endpointov. getCarsOccupancy vracia iba voľné
 * vozidlá; getCarsOccupancyAll vracia autoritatívny roster voľných aj obsadených.
 */
export type SwhouseCarOccupancyRaw = {
  carId: number;
  manufacturerId: number;
  colorId: number;
  model: string;
  ecv: string;
  vin: string;
  cotp: string | null;
  typeId: number;
  ownerTypeId: number;
  price1?: number;
  price2?: number;
  price3?: number;
  price4?: number;
  lasFilialId: number | null;
  lastUserId?: number | null;
  rentId: number | null;
  assistanceRentId: number | null;
  rentTo: string | null;
};

/**
 * Surový tvar legacy GET /rest/car/getCars (všetky autá vrátane zákazníckych).
 * Produkčný payload neposkytuje lasFilialId, preto tento endpoint nesmie byť
 * zdrojom rosteru. Roster používa SwhouseCarOccupancyRaw z getCarsOccupancyAll.
 */
export type SwhouseCarRaw = {
  carId: number;
  ecv: string | null;
  ownerTypeId: number | null;
  vin?: string | null;
  manufacturerId?: number | null;
  model?: string | null;
  colorId?: number | null;
  /** Legacy schema advertises this field, but the current production getCars payload omits it. */
  lasFilialId?: number | null;
};

/**
 * Párovanie obsadenosti flotily: ECV (normalizované — uppercase, bez medzier/pomlčiek)
 * náhradných vozidiel SWHouse. getCarsOccupancy vracia LEN voľné autá, takže
 * obsadené = flotila (ownerTypeId vo fleetOwnerTypeIds) mínus voľné.
 */
export type SwhouseFleetOccupancy = {
  freePlates: string[];
  occupiedPlates: string[];
};

/** Číselníkové položky (manufacturers/colors/types/owner/branches majú rôzne id polia + name). */
export type SwhouseCodelistItem = {
  name?: string;
  manufacturerId?: number;
  colorId?: number;
  typeId?: number;
  ownerTypeId?: number;
  branchId?: number;
  active?: boolean;
};

/**
 * Normalizovaný tvar náhradného vozidla — DURABLE artefakt.
 * Fáza 2 (sync do motorist_external_vehicle_records, provider='client_vehicle_db')
 * zapíše presne tento tvar; preto kindHint kopíruje commander enum.
 */
export type SwhouseReplacementVehicle = {
  carId: number;
  ecv: string;
  vin: string;
  make: string | null;
  model: string;
  color: string | null;
  ownerType: string | null;
  kindHint: "replacement_car";
  swhouseBranchId: number | null;
  swhouseBranchName: string | null;
  /** Namapované na naše motorist_branches.id cez SWHOUSE_BRANCH_MAP, alebo null (nepriradené). */
  branchInternalId: string | null;
  rentTo: string | null;
};

export type SwhouseAvailability = {
  /** internalBranchId -> počet voľných náhradných vozidiel */
  availabilityByBranch: Record<string, number>;
  /** vozidlá s lasFilialId, ktoré nie je v SWHOUSE_BRANCH_MAP (neprepíšu žiadnu pobočku) */
  unassignedCount: number;
  totalFree: number;
};
