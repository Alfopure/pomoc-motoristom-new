import { createHash, randomBytes } from "node:crypto";

export type PublicLocationPayload = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  clientTimestamp?: string | null;
};

export type ValidatedPublicLocation = {
  lat: number;
  lng: number;
  accuracy: number | null;
  clientTimestamp: string | null;
};

const TOKEN_BYTES = 32;
const MAX_ACCURACY_METERS = 100000;

export function createLocationShareToken() {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");

  return {
    token,
    tokenHash: hashLocationShareToken(token),
  };
}

export function hashLocationShareToken(token: string, pepper = process.env.LOCATION_LINK_TOKEN_PEPPER ?? "") {
  const cleanToken = token.trim();

  if (!cleanToken) {
    throw new Error("Location link token is required.");
  }

  return createHash("sha256").update(`${pepper}:${cleanToken}`, "utf8").digest("hex");
}

export function validatePublicLocationPayload(payload: unknown): ValidatedPublicLocation {
  const record = isRecord(payload) ? payload : {};
  const lat = toFiniteNumber(record.lat);
  const lng = toFiniteNumber(record.lng);

  if (lat === null || lat < -90 || lat > 90) {
    throw new Error("Zemepisna sirka nie je platna.");
  }

  if (lng === null || lng < -180 || lng > 180) {
    throw new Error("Zemepisna dlzka nie je platna.");
  }

  const accuracy = toFiniteNumber(record.accuracy);

  if (accuracy !== null && (accuracy < 0 || accuracy > MAX_ACCURACY_METERS)) {
    throw new Error("Presnost polohy nie je platna.");
  }

  return {
    lat: roundCoordinate(lat),
    lng: roundCoordinate(lng),
    accuracy: accuracy === null ? null : Math.round(accuracy * 100) / 100,
    clientTimestamp: cleanClientTimestamp(record.clientTimestamp),
  };
}

export function publicLocationLinkStatus(status: string, expiresAt: string, now = new Date()) {
  if (status === "active" && new Date(expiresAt).getTime() <= now.getTime()) {
    return "expired";
  }

  if (status === "active" || status === "used" || status === "expired" || status === "revoked") {
    return status;
  }

  return "revoked";
}

function cleanClientTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function roundCoordinate(value: number) {
  return Math.round(value * 10000000) / 10000000;
}

function toFiniteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
