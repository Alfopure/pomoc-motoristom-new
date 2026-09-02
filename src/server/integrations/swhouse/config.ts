import "server-only";
import { createHash } from "node:crypto";

const DEFAULT_CODELIST_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_OCCUPANCY_TTL_MS = 45 * 1000; // 45s
const DEFAULT_CARS_TTL_MS = 10 * 60 * 1000; // 10 min — autoritatívny all-roster sa mení zriedka
const REQUEST_TIMEOUT_MS = 8000;
// ownerTypeId 3 = "Náhradné vozidlo", 4 = "Pomoc motoristom" (codelist getOwnerTypes)
const DEFAULT_FLEET_OWNER_TYPE_IDS = [3, 4];

export class SwhouseConfigError extends Error {
  readonly status = 500;
  constructor(message: string) {
    super(message);
    this.name = "SwhouseConfigError";
  }
}

export type SwhouseConfig = {
  baseUrl: string;
  basicUsername: string;
  basicPassword: string;
  loginUsername: string;
  loginPassword: string;
  codelistTtlMs: number;
  occupancyTtlMs: number;
  carsTtlMs: number;
  requestTimeoutMs: number;
  /** lasFilialId (string) -> naše motorist_branches.id */
  branchMap: Record<string, string>;
  /** ownerTypeId hodnoty, ktoré tvoria našu náhradnú flotilu v SWHouse. */
  fleetOwnerTypeIds: number[];
};

function requireSecret(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("replace-with-")) {
    throw new SwhouseConfigError(`Chýba SWHouse konfigurácia: ${name}.`);
  }
  return trimmed;
}

function requireBaseUrl(value: string | undefined): string {
  const raw = requireSecret(value, "SWHOUSE_API_BASE_URL").replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SwhouseConfigError("Neplatná SWHouse konfigurácia: SWHOUSE_API_BASE_URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new SwhouseConfigError("SWHOUSE_API_BASE_URL musí používať HTTPS.");
  }
  return raw;
}

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** SWHOUSE_FLEET_OWNER_TYPE_IDS je CSV čísel (napr. "3,4"). Nevalidný vstup → default. */
export function parseFleetOwnerTypeIds(raw: string | undefined): number[] {
  if (!raw || !raw.trim()) {
    return [...DEFAULT_FLEET_OWNER_TYPE_IDS];
  }
  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_FLEET_OWNER_TYPE_IDS];
}

/**
 * SWHOUSE_BRANCH_MAP je JSON `{"<lasFilialId>":"<branch-id>"}`.
 * Jediná autorita mapovania pobočiek (žiadny fuzzy match). Nevalidný JSON → prázdna mapa.
 */
export function parseBranchMap(raw: string | undefined): Record<string, string> {
  if (!raw || !raw.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) {
      result[String(key).trim()] = value.trim();
    }
  }
  return result;
}

export function swhouseConfigFromEnv(env: Record<string, string | undefined> = process.env): SwhouseConfig {
  return {
    // Bez implicitného fallbacku: produkcia nikdy nesmie potichu čítať starý testovací SWHouse.
    baseUrl: requireBaseUrl(env.SWHOUSE_API_BASE_URL),
    basicUsername: requireSecret(env.SWHOUSE_BASIC_USERNAME, "SWHOUSE_BASIC_USERNAME"),
    basicPassword: requireSecret(env.SWHOUSE_BASIC_PASSWORD, "SWHOUSE_BASIC_PASSWORD"),
    loginUsername: requireSecret(env.SWHOUSE_LOGIN_USERNAME, "SWHOUSE_LOGIN_USERNAME"),
    loginPassword: requireSecret(env.SWHOUSE_LOGIN_PASSWORD, "SWHOUSE_LOGIN_PASSWORD"),
    codelistTtlMs: positiveIntEnv(env.SWHOUSE_CODELIST_TTL_MS, DEFAULT_CODELIST_TTL_MS),
    occupancyTtlMs: positiveIntEnv(env.SWHOUSE_OCCUPANCY_TTL_MS, DEFAULT_OCCUPANCY_TTL_MS),
    carsTtlMs: positiveIntEnv(env.SWHOUSE_CARS_TTL_MS, DEFAULT_CARS_TTL_MS),
    requestTimeoutMs: positiveIntEnv(env.SWHOUSE_REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
    branchMap: parseBranchMap(env.SWHOUSE_BRANCH_MAP),
    fleetOwnerTypeIds: parseFleetOwnerTypeIds(env.SWHOUSE_FLEET_OWNER_TYPE_IDS),
  };
}

/** True ak sú nastavené aspoň povinné credentials (nehádže). */
export function isSwhouseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  try {
    swhouseConfigFromEnv(env);
    return true;
  } catch {
    return false;
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** `Authorization: Basic base64(user:pass)` */
export function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * UserAuth hlavička pre GET /rest/login = base64("meno:" + SHA256hex(heslo)).
 * Overený recept 2026-06-27.
 */
export function buildUserAuthHeader(username: string, plainPassword: string): string {
  return Buffer.from(`${username}:${sha256Hex(plainPassword)}`).toString("base64");
}
