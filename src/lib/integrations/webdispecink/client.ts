import "server-only";

import type { GeoPoint } from "@/domain/types";

const SOAP_NAMESPACE = "urn://api.webdispecink.cz/webdisser_02";
const DEFAULT_SOAP_URL = "https://api.webdispecink.cz/code/WebDispecinkServiceNet.php";
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

type SoapScalar = string | number | boolean;

export type WebdispecinkConfig = {
  soapUrl: string;
  credentials: WebdispecinkCredentials;
  activeOnly: number;
  geocode: number;
  requestTimeoutMs: number;
};

export type WebdispecinkCredentials = {
  kodf: string;
  username: string;
  pass: string;
};

export type WebdispecinkCar = {
  externalId: string;
  licensePlate?: string;
  driverName?: string;
  userRights?: string;
  type?: string;
  online?: boolean;
  disabled?: boolean;
  unitName?: string;
  objectNumber?: string;
  odometerKm?: number;
  raw: Record<string, string>;
};

export type WebdispecinkPosition = {
  externalId: string;
  point?: GeoPoint;
  positionTime?: string;
  localPositionTime?: string;
  speedKph?: number;
  odometerKm?: number;
  fuelTank?: number;
  addressState?: string;
  addressCity?: string;
  raw: Record<string, string>;
};

export class WebdispecinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebdispecinkConfigError";
  }
}

export class WebdispecinkHttpError extends Error {
  constructor(
    message: string,
    readonly providerStatus: number,
    readonly providerResponseSummary?: string,
  ) {
    super(message);
    this.name = "WebdispecinkHttpError";
  }
}

export function getWebdispecinkConfig(): WebdispecinkConfig {
  const kodf = configuredEnv("WEBDISPECINK_COMPANY_CODE");
  const username = configuredEnv("WEBDISPECINK_USERNAME");
  const pass = configuredEnv("WEBDISPECINK_PASSWORD");

  if (!kodf || !username || !pass) {
    throw new WebdispecinkConfigError("WebDispecink API credentials are not configured.");
  }

  return {
    soapUrl: configuredEnv("WEBDISPECINK_SOAP_URL") ?? DEFAULT_SOAP_URL,
    credentials: { kodf, username, pass },
    activeOnly: numberEnv("WEBDISPECINK_ACTIVE_ONLY", 1),
    geocode: numberEnv("WEBDISPECINK_GEOCODE", 0),
    requestTimeoutMs: numberEnv("WEBDISPECINK_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
  };
}

export function createWebdispecinkClient(config = getWebdispecinkConfig()) {
  return new WebdispecinkClient(config);
}

export class WebdispecinkClient {
  constructor(readonly config: WebdispecinkConfig) {}

  async login() {
    const response = await this.soapCall("_login", this.config.credentials);
    const loginResult = Number(extractSoapValue(response, "return"));

    if (loginResult !== 1) {
      throw new WebdispecinkHttpError(
        `_login returned ${Number.isNaN(loginResult) ? "an unreadable value" : loginResult}.`,
        401,
      );
    }

    return { ok: true };
  }

  async listCars() {
    const response = await this.soapCall("_getCarsList2", {
      ...this.config.credentials,
      activeOnly: this.config.activeOnly,
    });

    return parseWebdispecinkCars(response);
  }

  async listPositions() {
    const response = await this.soapCall("_getAllCarsPosition", {
      ...this.config.credentials,
      geocode: this.config.geocode,
    });

    return parseWebdispecinkPositions(response);
  }

  private async soapCall(operation: string, params: Record<string, SoapScalar>) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(this.config.soapUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `${SOAP_NAMESPACE}#${operation}`,
        },
        body: buildSoapEnvelope(operation, params),
        signal: controller.signal,
      });
      const text = await response.text();
      const fault = summarizeSoapFault(text);

      if (!response.ok) {
        throw new WebdispecinkHttpError(
          `${operation} failed with HTTP ${response.status}.`,
          response.status,
          fault ?? summarizeProviderResponse(text),
        );
      }

      if (fault) {
        throw new WebdispecinkHttpError(`${operation} returned a SOAP fault.`, 502, fault);
      }

      return text;
    } catch (error) {
      if (error instanceof WebdispecinkHttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new WebdispecinkHttpError("WebDispecink SOAP request timed out.", 504);
      }

      throw new WebdispecinkHttpError(
        error instanceof Error ? error.message : "WebDispecink SOAP request failed.",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseWebdispecinkCars(xml: string): WebdispecinkCar[] {
  return parseSoapItems(xml, [
    "carid",
    "identifikator",
    "driver",
    "userrights",
    "type",
    "online",
    "disabled",
    "unitname",
    "objectNum",
    "odometerKm",
  ])
    .map((raw): WebdispecinkCar | null => {
      const externalId = normalizeText(raw.carid);

      if (!externalId) {
        return null;
      }

      return {
        externalId,
        licensePlate: normalizeLicensePlate(raw.identifikator),
        driverName: normalizeText(raw.driver),
        userRights: normalizeText(raw.userrights),
        type: normalizeText(raw.type),
        online: parseProviderBoolean(raw.online),
        disabled: parseProviderBoolean(raw.disabled),
        unitName: normalizeText(raw.unitname),
        objectNumber: normalizeText(raw.objectNum),
        odometerKm: parseProviderNumber(raw.odometerKm),
        raw,
      };
    })
    .filter((car): car is WebdispecinkCar => Boolean(car));
}

export function parseWebdispecinkPositions(xml: string): WebdispecinkPosition[] {
  return parseSoapItems(xml, [
    "carid",
    "latitude",
    "longitude",
    "Zs",
    "Zd",
    "positiontime",
    "localpostime",
    "speed",
    "Location_state",
    "Location_city",
    "km",
    "fueltank",
  ])
    .map((raw): WebdispecinkPosition | null => {
      const externalId = normalizeText(raw.carid);

      if (!externalId) {
        return null;
      }

      const lat = parseProviderNumber(raw.latitude ?? raw.Zs);
      const lng = parseProviderNumber(raw.longitude ?? raw.Zd);
      const point = typeof lat === "number" && typeof lng === "number" ? { lat, lng } : undefined;

      return {
        externalId,
        point,
        positionTime: normalizeProviderTimestamp(raw.positiontime),
        localPositionTime: normalizeProviderTimestamp(raw.localpostime),
        speedKph: parseProviderNumber(raw.speed),
        odometerKm: parseProviderNumber(raw.km),
        fuelTank: parseProviderNumber(raw.fueltank),
        addressState: normalizeText(raw.Location_state),
        addressCity: normalizeText(raw.Location_city),
        raw,
      };
    })
    .filter((position): position is WebdispecinkPosition => Boolean(position));
}

export function serializeWebdispecinkError(error: unknown) {
  if (error instanceof WebdispecinkConfigError) {
    return { message: error.message, status: 503 };
  }

  if (error instanceof WebdispecinkHttpError) {
    return {
      message: error.message,
      providerStatus: error.providerStatus,
      providerResponseSummary: error.providerResponseSummary,
      status: error.providerStatus >= 400 && error.providerStatus < 600 ? error.providerStatus : 502,
    };
  }

  return {
    message: error instanceof Error ? error.message : "WebDispecink request failed.",
    status: 500,
  };
}

function buildSoapEnvelope(operation: string, params: Record<string, SoapScalar>) {
  const parameterXml = Object.entries(params)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="${SOAP_NAMESPACE}">
  <SOAP-ENV:Body>
    <ns1:${operation}>
      ${parameterXml}
    </ns1:${operation}>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function parseSoapItems(xml: string, fields: string[]) {
  return matchAll(xml, /<(?:[\w.-]+:)?item(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?item>/g).map((itemXml) => {
    const item: Record<string, string> = {};

    for (const field of fields) {
      const value = extractSoapValue(itemXml, field);

      if (value !== undefined) {
        item[field] = normalizeSoapValue(value);
      }
    }

    return item;
  });
}

function extractSoapValue(xml: string, name: string) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${escapeRegExp(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escapeRegExp(name)}>`);
  const match = xml.match(pattern);

  if (!match) {
    return undefined;
  }

  return unescapeXml(match[1].trim());
}

function summarizeSoapFault(xml: string) {
  const faultString = extractSoapValue(xml, "faultstring");
  const faultCode = extractSoapValue(xml, "faultcode");

  if (!faultString && !faultCode) {
    return null;
  }

  return [faultCode, faultString].filter(Boolean).join(": ");
}

function summarizeProviderResponse(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/<pass>[\s\S]*?<\/pass>/gi, "<pass>***</pass>")
    .slice(0, 240);
}

function parseProviderBoolean(value: string | undefined) {
  const normalized = normalizeText(value)?.toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "ano"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "nie"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseProviderNumber(value: string | undefined) {
  const normalized = normalizeText(value)?.replace(",", ".");

  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeProviderTimestamp(value: string | undefined) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return undefined;
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : normalized;
}

function normalizeLicensePlate(value: string | undefined) {
  return normalizeText(value)?.toUpperCase();
}

function normalizeSoapValue(value: string) {
  return unescapeXml(value.trim());
}

function normalizeText(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function matchAll(value: string, pattern: RegExp) {
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: string) {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configuredEnv(name: string) {
  const value = process.env[name]?.trim();
  return value && !value.startsWith("replace-with") && value !== "TODO" ? value : undefined;
}

function numberEnv(name: string, fallback: number) {
  const value = process.env[name]?.trim();

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
