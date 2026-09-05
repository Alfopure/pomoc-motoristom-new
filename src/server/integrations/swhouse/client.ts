import "server-only";

import {
  buildBasicAuthHeader,
  buildUserAuthHeader,
  swhouseConfigFromEnv,
  type SwhouseConfig,
} from "./config";
import type {
  SwhouseCarOccupancyRaw,
  SwhouseCarRaw,
  SwhouseCodelistItem,
  SwhouseLoginResponse,
  SwhouseResponse,
} from "./types";

const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const FALLBACK_TOKEN_TTL_MS = 60_000; // ak expirationISO chýba/je nevalidný

type TokenCacheEntry = { token: string; expiresAt: number };
type OccupancyCacheEntry = { data: SwhouseCarOccupancyRaw[]; expiresAt: number };
type AllOccupancyCacheEntry = { data: SwhouseCarOccupancyRaw[]; expiresAt: number };
type CarsCacheEntry = { data: SwhouseCarRaw[]; expiresAt: number };

// Module-scope cache prežíva medzi requestmi v rámci jednej (warm) serverless instancie.
let tokenCache: TokenCacheEntry | null = null;
let loginInFlight: Promise<string> | null = null;
let occupancyCache: OccupancyCacheEntry | null = null;
let occupancyInFlight: Promise<SwhouseResponse<SwhouseCarOccupancyRaw[]>> | null = null;
let allOccupancyCache: AllOccupancyCacheEntry | null = null;
let allOccupancyInFlight: Promise<SwhouseResponse<SwhouseCarOccupancyRaw[]>> | null = null;
let carsCache: CarsCacheEntry | null = null;
let carsInFlight: Promise<SwhouseResponse<SwhouseCarRaw[]>> | null = null;

/** Len pre testy — vyčistí module-scope cache. */
export function __resetSwhouseCaches(): void {
  tokenCache = null;
  loginInFlight = null;
  occupancyCache = null;
  occupancyInFlight = null;
  allOccupancyCache = null;
  allOccupancyInFlight = null;
  carsCache = null;
  carsInFlight = null;
}

function computeExpiry(expirationISO: string | undefined, now: number): number {
  if (expirationISO) {
    const parsed = Date.parse(expirationISO);
    if (Number.isFinite(parsed)) {
      return parsed - TOKEN_EXPIRY_BUFFER_MS;
    }
  }
  return now + FALLBACK_TOKEN_TTL_MS;
}

function redactedError(message: string): string {
  // Nikdy nevkladáme token/heslo/UserAuth do správ.
  return message.slice(0, 300);
}

export class SwhouseClient {
  private readonly config: SwhouseConfig;

  constructor(config: SwhouseConfig = swhouseConfigFromEnv()) {
    this.config = config;
  }

  private basicHeader(): string {
    return buildBasicAuthHeader(this.config.basicUsername, this.config.basicPassword);
  }

  /** Vykoná GET /rest/login a vráti token (single-flight). */
  private async login(): Promise<string> {
    if (loginInFlight) {
      return loginInFlight;
    }
    loginInFlight = (async () => {
      const userAuth = buildUserAuthHeader(this.config.loginUsername, this.config.loginPassword);
      const res = await this.fetchJson<SwhouseLoginResponse>("/login", {
        Authorization: this.basicHeader(),
        UserAuth: userAuth,
      });
      if (!res.ok || !res.data?.token) {
        throw new Error(redactedError(`SWHouse login zlyhal (HTTP ${res.status}).`));
      }
      tokenCache = {
        token: res.data.token,
        expiresAt: computeExpiry(res.data.expirationISO, Date.now()),
      };
      return res.data.token;
    })();
    try {
      return await loginInFlight;
    } finally {
      loginInFlight = null;
    }
  }

  private async ensureToken(): Promise<string> {
    if (tokenCache && Date.now() < tokenCache.expiresAt) {
      return tokenCache.token;
    }
    return this.login();
  }

  /** Nízkoúrovňový fetch s timeoutom + JSON parse. NErieši token (používa sa aj pre login). */
  private async fetchJson<T>(path: string, headers: Record<string, string>, timeoutMs = this.config.requestTimeoutMs): Promise<SwhouseResponse<T>> {
    const url = `${this.config.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error";
      return { path, status: 599, ok: false, data: null, error: redactedError(`SWHouse request zlyhal: ${reason}.`) };
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    const data = parseJson<T>(text);
    return {
      path,
      status: response.status,
      ok: response.ok,
      data: response.ok ? data : null,
      error: response.ok ? null : redactedError(`SWHouse HTTP ${response.status}.`),
    };
  }

  /** Autentifikovaný GET s token cache + single-retry pri 401. */
  private async request<T>(path: string, timeoutMs?: number): Promise<SwhouseResponse<T>> {
    const token = await this.ensureToken();
    const first = await this.fetchJson<T>(
      path,
      {
        Authorization: this.basicHeader(),
        "x-user-token": token,
      },
      timeoutMs,
    );
    if (first.status !== 401) {
      return first;
    }
    // Token mohol vypršať — zneplatni a skús raz znova.
    tokenCache = null;
    let retryToken: string;
    try {
      retryToken = await this.login();
    } catch {
      return { path, status: 401, ok: false, data: null, error: "auth_failed" };
    }
    const second = await this.fetchJson<T>(
      path,
      {
        Authorization: this.basicHeader(),
        "x-user-token": retryToken,
      },
      timeoutMs,
    );
    if (second.status === 401) {
      return { path, status: 401, ok: false, data: null, error: "auth_failed" };
    }
    return second;
  }

  /** GET /rest/carOccupancy/getCarsOccupancy — len voľné vozidlá (s in-memory cache + single-flight). */
  async getCarsOccupancy(options?: { fresh?: boolean }): Promise<SwhouseResponse<SwhouseCarOccupancyRaw[]>> {
    if (!options?.fresh && occupancyCache && Date.now() < occupancyCache.expiresAt) {
      return { path: "/carOccupancy/getCarsOccupancy", status: 200, ok: true, data: occupancyCache.data, error: null };
    }
    if (occupancyInFlight) {
      return occupancyInFlight;
    }
    occupancyInFlight = (async () => {
      const res = await this.request<SwhouseCarOccupancyRaw[]>("/carOccupancy/getCarsOccupancy");
      if (res.ok && Array.isArray(res.data)) {
        occupancyCache = { data: res.data, expiresAt: Date.now() + this.config.occupancyTtlMs };
      }
      return res;
    })();
    try {
      return await occupancyInFlight;
    } finally {
      occupancyInFlight = null;
    }
  }

  /**
   * GET /rest/carOccupancy/getCarsOccupancyAll — autoritatívny roster náhradnej
   * flotily (voľné aj obsadené), vrátane lasFilialId. Toto je produkčný endpoint
   * doplnený SWHouse pre synchronizáciu; generický /car/getCars obsahuje aj
   * zákaznícke autá a neposkytuje pobočku.
   */
  async getCarsOccupancyAll(options?: { fresh?: boolean }): Promise<SwhouseResponse<SwhouseCarOccupancyRaw[]>> {
    if (!options?.fresh && allOccupancyCache && Date.now() < allOccupancyCache.expiresAt) {
      return {
        path: "/carOccupancy/getCarsOccupancyAll",
        status: 200,
        ok: true,
        data: allOccupancyCache.data,
        error: null,
      };
    }
    if (allOccupancyInFlight) {
      return allOccupancyInFlight;
    }
    allOccupancyInFlight = (async () => {
      const res = await this.request<SwhouseCarOccupancyRaw[]>("/carOccupancy/getCarsOccupancyAll", Math.max(this.config.requestTimeoutMs, 25_000));
      if (res.ok && Array.isArray(res.data)) {
        allOccupancyCache = { data: res.data, expiresAt: Date.now() + this.config.carsTtlMs };
      }
      return res;
    })();
    try {
      return await allOccupancyInFlight;
    } finally {
      allOccupancyInFlight = null;
    }
  }

  /**
   * Legacy discovery endpoint. Nepoužívať ako roster: vracia aj zákaznícke autá
   * a produkčný payload nemá lasFilialId. Zostáva iba pre kompatibilitu nástrojov.
   */
  async getCars(): Promise<SwhouseResponse<SwhouseCarRaw[]>> {
    if (carsCache && Date.now() < carsCache.expiresAt) {
      return { path: "/car/getCars", status: 200, ok: true, data: carsCache.data, error: null };
    }
    if (carsInFlight) {
      return carsInFlight;
    }
    carsInFlight = (async () => {
      // ~3 MB payload — štandardný timeout (8 s) je pri studenom vendorovi tesný.
      const res = await this.request<SwhouseCarRaw[]>("/car/getCars", Math.max(this.config.requestTimeoutMs, 25_000));
      if (res.ok && Array.isArray(res.data)) {
        // Plný payload má ~3 MB; držíme polia na párovanie (carId/ecv/ownerType) + roster (vin/značka/model/farba/pobočka) pre Fázu 2.
        const slim = res.data.map((car) => ({
          carId: car.carId,
          ecv: car.ecv,
          ownerTypeId: car.ownerTypeId,
          vin: car.vin ?? null,
          manufacturerId: car.manufacturerId ?? null,
          model: car.model ?? null,
          colorId: car.colorId ?? null,
          lasFilialId: car.lasFilialId ?? null,
        }));
        carsCache = { data: slim, expiresAt: Date.now() + this.config.carsTtlMs };
        return { ...res, data: slim };
      }
      return res;
    })();
    try {
      return await carsInFlight;
    } finally {
      carsInFlight = null;
    }
  }

  getManufacturers() {
    return this.request<SwhouseCodelistItem[]>("/codelist/getManufacturers");
  }
  getCarColors() {
    return this.request<SwhouseCodelistItem[]>("/codelist/getCarColors");
  }
  getCarTypes() {
    return this.request<SwhouseCodelistItem[]>("/codelist/getCarTypes");
  }
  getOwnerTypes() {
    return this.request<SwhouseCodelistItem[]>("/codelist/getOwnerTypes");
  }
  getBranches() {
    return this.request<SwhouseCodelistItem[]>("/codelist/getBranches");
  }
  getCarDetail(carId: number) {
    return this.request<unknown>(`/car/getCarDetail/${carId}`);
  }
}

function parseJson<T>(text: string): T | null {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
