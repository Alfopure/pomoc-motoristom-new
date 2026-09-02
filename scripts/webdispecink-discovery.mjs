#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOAP_NAMESPACE = "urn://api.webdispecink.cz/webdisser_02";

loadLocalEnv();

try {
  const soapUrl = process.env.WEBDISPECINK_SOAP_URL ?? "https://api.webdispecink.cz/code/WebDispecinkServiceNet.php";
  const credentials = {
    kodf: requiredEnv("WEBDISPECINK_COMPANY_CODE"),
    username: requiredEnv("WEBDISPECINK_USERNAME"),
    pass: requiredEnv("WEBDISPECINK_PASSWORD"),
  };
  const activeOnly = parseFlag(process.env.WEBDISPECINK_ACTIVE_ONLY, 1);
  const geocode = parseFlag(process.env.WEBDISPECINK_GEOCODE, 0);
  const requestTimeoutMs = parseFlag(process.env.WEBDISPECINK_REQUEST_TIMEOUT_MS, 12000);
  const showCoordinates = process.env.WEBDISPECINK_SHOW_COORDINATES === "1";

  console.log("WebDispecink read-only discovery");
  console.log(`SOAP endpoint: ${soapUrl}`);
  console.log(`Credentials: kodf=${redact(credentials.kodf)}, username=${redact(credentials.username)}, password=***`);

  const loginResponse = await soapCall(soapUrl, "_login", credentials, requestTimeoutMs);
  const loginResult = Number(extractValue(loginResponse, "return"));

  if (loginResult !== 1) {
    throw new Error(`_login returned ${Number.isNaN(loginResult) ? "an unreadable value" : loginResult}`);
  }

  console.log("Login: OK");

  const carsResponse = await soapCall(soapUrl, "_getCarsList2", { ...credentials, activeOnly }, requestTimeoutMs);
  const cars = parseItems(carsResponse, [
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
  ]);

  const positionsResponse = await soapCall(soapUrl, "_getAllCarsPosition", { ...credentials, geocode }, requestTimeoutMs);
  const positions = parseItems(positionsResponse, [
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
  ]);

  const positionsByCarId = new Map(positions.map((position) => [position.carid, position]));
  const matchedPositions = cars.filter((car) => positionsByCarId.has(car.carid));

  console.log(`Cars: ${cars.length}`);
  console.log(`Positions: ${positions.length}`);
  console.log(`Matched car positions: ${matchedPositions.length}/${cars.length}`);
  console.log("");
  console.log("Cars:");

  for (const car of cars) {
    const position = positionsByCarId.get(car.carid);
    const positionSummary = position ? summarizePosition(position, showCoordinates) : "no current position";
    console.log(
      [
        `- carid=${car.carid}`,
        `plate=${valueOrDash(car.identifikator)}`,
        `online=${valueOrDash(car.online)}`,
        `disabled=${valueOrDash(car.disabled)}`,
        `type=${valueOrDash(car.type)}`,
        `position=${positionSummary}`,
      ].join(" | "),
    );
  }

  console.log("");
  console.log("Discovery complete. No data was written.");
} catch (error) {
  console.error(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), fileName);

    if (!existsSync(path)) {
      continue;
    }

    const lines = readFileSync(path, "utf8").split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");

      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();

      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = unquote(rawValue);
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value || value.startsWith("replace-with")) {
    throw new Error(`${name} is required. Set it in .env.local or the shell environment.`);
  }

  return value;
}

function parseFlag(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Expected integer flag, got "${value}".`);
  }

  return parsed;
}

async function soapCall(soapUrl, operation, params, requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(soapUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `${SOAP_NAMESPACE}#${operation}`,
      },
      body: buildSoapEnvelope(operation, params),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${operation} failed with HTTP ${response.status}: ${summarizeSoapFault(text)}`);
    }

    const fault = summarizeSoapFault(text);

    if (fault) {
      throw new Error(`${operation} returned SOAP fault: ${fault}`);
    }

    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${operation} timed out after ${requestTimeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSoapEnvelope(operation, params) {
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

function parseItems(xml, fields) {
  return matchAll(xml, /<(?:[\w.-]+:)?item(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?item>/g).map((itemXml) => {
    const item = {};

    for (const field of fields) {
      const value = extractValue(itemXml, field);

      if (value !== undefined) {
        item[field] = normalizeValue(value);
      }
    }

    return item;
  });
}

function extractValue(xml, name) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${escapeRegExp(name)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escapeRegExp(name)}>`);
  const match = xml.match(pattern);

  if (!match) {
    return undefined;
  }

  return unescapeXml(match[1].trim());
}

function summarizeSoapFault(xml) {
  const faultString = extractValue(xml, "faultstring") ?? extractValue(xml, "faultcode");
  return faultString?.replace(/\s+/g, " ").trim();
}

function summarizePosition(position, includeCoordinates) {
  const pieces = [
    `seen=${valueOrDash(position.localpostime ?? position.positiontime)}`,
    `speed=${valueOrDash(position.speed)}km/h`,
  ];

  if (includeCoordinates) {
    const lat = Number(position.latitude ?? position.Zs);
    const lng = Number(position.longitude ?? position.Zd);

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      pieces.push(`lat=${lat}`, `lng=${lng}`);
    }
  } else {
    pieces.push("coordinates=hidden");
  }

  return pieces.join(", ");
}

function normalizeValue(value) {
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }

  if (/^-?\d+\.\d+$/.test(value)) {
    return Number(value);
  }

  return value;
}

function matchAll(value, pattern) {
  return Array.from(value.matchAll(pattern), (match) => match[1]);
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function redact(value) {
  if (value.length <= 2) {
    return "***";
  }

  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

function valueOrDash(value) {
  return value === undefined || value === "" ? "-" : String(value);
}
