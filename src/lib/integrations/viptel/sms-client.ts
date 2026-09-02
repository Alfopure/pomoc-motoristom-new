import "server-only";

import { randomUUID } from "node:crypto";
import { mapViptelSmsStatusCode, type NormalizedViptelSmsStatus } from "./sms-status";

export type ViptelSmsConfig = {
  baseUrl: string;
  username: string;
  password: string;
  fromIdentity?: string;
  testMsisdn?: string;
  liveSendsEnabled: boolean;
  requestTimeoutMs: number;
};

export type ViptelSmsIdentity = {
  id?: string;
  name?: string;
  value: string;
  raw: Record<string, unknown>;
};

export type ViptelSmsCredit = {
  credit: number | false | null;
  raw: unknown;
};

export type ViptelSmsSendRequest = {
  fromIdentity: string;
  body: string;
  destMsisdn: string;
};

export type ViptelSmsSendResult = {
  requestId: string;
  providerStatus: number;
  normalizedStatus: NormalizedViptelSmsStatus;
  providerResponse: unknown;
};

export class ViptelSmsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViptelSmsConfigError";
  }
}

export class ViptelSmsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViptelSmsInputError";
  }
}

export class ViptelSmsHttpError extends Error {
  constructor(
    message: string,
    readonly providerStatus: number,
    readonly providerResponse: unknown,
  ) {
    super(message);
    this.name = "ViptelSmsHttpError";
  }
}

export function getViptelSmsConfig(): ViptelSmsConfig {
  const username = configuredEnv("VIPTEL_SMS_USERNAME");
  const password = configuredEnv("VIPTEL_SMS_PASSWORD");

  if (!username || !password) {
    throw new ViptelSmsConfigError("VIPTel SMS API credentials are not configured.");
  }

  const testMsisdn = configuredEnv("VIPTEL_SMS_TEST_MSISDN");

  return {
    baseUrl: withTrailingSlash(configuredEnv("VIPTEL_SMS_BASE_URL") ?? "https://smsapi.viptel.sk/api/"),
    username,
    password,
    fromIdentity: configuredEnv("VIPTEL_SMS_FROM_IDENTITY"),
    testMsisdn: testMsisdn ? normalizeViptelSmsMsisdn(testMsisdn, "VIPTEL_SMS_TEST_MSISDN") : undefined,
    liveSendsEnabled: booleanEnv("VIPTEL_SMS_LIVE_SENDS"),
    requestTimeoutMs: numberEnv("VIPTEL_SMS_REQUEST_TIMEOUT_MS", numberEnv("VIPTEL_REQUEST_TIMEOUT_MS", 8000)),
  };
}

export function createViptelSmsClient(config = getViptelSmsConfig()) {
  return new ViptelSmsClient(config);
}

export class ViptelSmsClient {
  constructor(readonly config: ViptelSmsConfig) {}

  async listIdentities(): Promise<ViptelSmsIdentity[]> {
    const response = await this.requestJson("/identities/");
    const identities = extractArrayPayload(response.data, ["identities", "data", "results", "items"]);

    if (!identities) {
      throw new ViptelSmsHttpError("VIPTel SMS returned an unexpected identities payload.", response.status, response.data);
    }

    return identities.map(normalizeIdentity).filter((identity) => identity.value);
  }

  async getCredit(): Promise<ViptelSmsCredit> {
    const response = await this.requestJson("/credits/");
    const rawCredit = asRecord(response.data).credit ?? response.data;

    return {
      credit: normalizeCredit(rawCredit),
      raw: response.data,
    };
  }

  async sendMessage(request: ViptelSmsSendRequest): Promise<ViptelSmsSendResult> {
    const formData = new FormData();
    formData.set("from_identity", cleanSmsIdentity(request.fromIdentity, "fromIdentity"));
    formData.set("body", cleanSmsBody(request.body));
    formData.set("dest_msisdn", normalizeViptelSmsMsisdn(request.destMsisdn, "destMsisdn"));

    const response = await this.requestJson("/messages/", {
      body: formData,
      method: "POST",
    });

    return {
      requestId: randomUUID(),
      providerStatus: response.status,
      normalizedStatus: mapViptelSmsStatusCode(response.status),
      providerResponse: response.data,
    };
  }

  async sendConfiguredTestMessage(body = "Test SMS z Pomoc Motoristom dispecingu."): Promise<ViptelSmsSendResult> {
    if (!this.config.liveSendsEnabled) {
      throw new ViptelSmsInputError("VIPTel SMS live sends are disabled. Set VIPTEL_SMS_LIVE_SENDS=true to send a real SMS.");
    }

    const identities = await this.listIdentities();
    const fromIdentity = this.config.fromIdentity ? cleanSmsIdentity(this.config.fromIdentity, "VIPTEL_SMS_FROM_IDENTITY") : firstUsableIdentity(identities);

    if (!fromIdentity) {
      throw new ViptelSmsInputError("VIPTEL_SMS_FROM_IDENTITY is required because VIPTel did not return a usable identity.");
    }

    if (!this.config.testMsisdn) {
      throw new ViptelSmsInputError("VIPTEL_SMS_TEST_MSISDN is required for a real test SMS.");
    }

    return this.sendMessage({
      body,
      destMsisdn: this.config.testMsisdn,
      fromIdentity,
    });
  }

  private async requestJson(path: string, init: { body?: BodyInit; method?: "GET" | "POST" } = {}) {
    const url = new URL(path.replace(/^\//, ""), this.config.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        body: init.body,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`, "utf8").toString("base64")}`,
        },
        method: init.method ?? "GET",
        signal: controller.signal,
      });
      const text = await response.text();
      const data = parseJson(text);

      if (!response.ok) {
        throw new ViptelSmsHttpError(`VIPTel SMS returned HTTP ${response.status}.`, response.status, data ?? text);
      }

      return { data, status: response.status };
    } catch (error) {
      if (error instanceof ViptelSmsHttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new ViptelSmsHttpError("VIPTel SMS request timed out.", 504, null);
      }

      throw new ViptelSmsHttpError(error instanceof Error ? error.message : "VIPTel SMS request failed.", 502, null);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function probeViptelSms() {
  const config = getViptelSmsConfig();
  const client = createViptelSmsClient(config);
  const [identities, credit] = await Promise.all([client.listIdentities(), client.getCredit()]);
  const fromIdentity = config.fromIdentity ? cleanSmsIdentity(config.fromIdentity, "VIPTEL_SMS_FROM_IDENTITY") : firstUsableIdentity(identities);
  const missingForLiveSend = [
    config.liveSendsEnabled ? null : "VIPTEL_SMS_LIVE_SENDS=true",
    fromIdentity ? null : "VIPTEL_SMS_FROM_IDENTITY or at least one VIPTel identity",
    config.testMsisdn ? null : "VIPTEL_SMS_TEST_MSISDN",
  ].filter((item): item is string => Boolean(item));

  return {
    baseUrl: config.baseUrl,
    credit,
    identities: identities.map((identity) => ({
      id: identity.id,
      name: identity.name,
      value: identity.value,
    })),
    identityCount: identities.length,
    liveSendsEnabled: config.liveSendsEnabled,
    liveSendReady: missingForLiveSend.length === 0,
    missingForLiveSend,
    selectedFromIdentity: fromIdentity ?? null,
    testMsisdnConfigured: Boolean(config.testMsisdn),
  };
}

export function serializeViptelSmsError(error: unknown) {
  if (error instanceof ViptelSmsConfigError) {
    return {
      message: error.message,
      status: 503,
    };
  }

  if (error instanceof ViptelSmsInputError) {
    return {
      message: error.message,
      status: 400,
    };
  }

  if (error instanceof ViptelSmsHttpError) {
    return {
      message: error.message,
      status: 502,
      providerStatus: error.providerStatus,
      providerResponseSummary: summarizeProviderResponse(error.providerResponse),
    };
  }

  return {
    message: error instanceof Error ? error.message : "Unexpected VIPTel SMS integration error.",
    status: 500,
  };
}

export function normalizeViptelSmsMsisdn(value: unknown, fieldName = "number") {
  const input = String(value ?? "").trim();

  if (!input) {
    throw new ViptelSmsInputError(`${fieldName} is required.`);
  }

  if (!/^\+?[\d ()/.-]{1,40}$/.test(input)) {
    throw new ViptelSmsInputError(`${fieldName} must be a valid phone number.`);
  }

  const digits = input.replace(/\D/g, "");
  const normalized = digits.startsWith("00")
    ? digits
    : input.startsWith("+")
      ? `00${digits}`
      : digits.startsWith("421")
        ? `00${digits}`
      : digits.startsWith("0")
        ? `00421${digits.slice(1)}`
        : "";

  if (!/^00[1-9]\d{6,14}$/.test(normalized)) {
    throw new ViptelSmsInputError(`${fieldName} must use a local Slovak number or an international +/00 prefix.`);
  }

  return normalized;
}

function cleanSmsIdentity(value: unknown, fieldName = "fromIdentity") {
  const input = String(value ?? "").trim();

  if (!input) {
    throw new ViptelSmsInputError(`${fieldName} is required.`);
  }

  const digits = input.replace(/\D/g, "");

  if (/^\+?[\d ()/.-]+$/.test(input) && digits.length >= 9) {
    return normalizeViptelSmsMsisdn(input, fieldName);
  }

  if (input.length > 80) {
    throw new ViptelSmsInputError(`${fieldName} is too long.`);
  }

  return input;
}

function cleanSmsBody(value: unknown) {
  const body = String(value ?? "").trim();

  if (!body) {
    throw new ViptelSmsInputError("body is required.");
  }

  if (body.length > 1200) {
    throw new ViptelSmsInputError("body is too long for a guarded SMS send.");
  }

  return body;
}

function firstUsableIdentity(identities: ViptelSmsIdentity[]) {
  const preferred = identities.find((identity) => identity.name?.startsWith("00") || identity.value.startsWith("00"));
  return preferred?.name ?? preferred?.value ?? preferred?.id ?? identities[0]?.name ?? identities[0]?.value ?? identities[0]?.id;
}

function normalizeIdentity(value: unknown): ViptelSmsIdentity {
  if (typeof value === "string" || typeof value === "number") {
    const identity = String(value).trim();
    return {
      id: identity,
      value: identity,
      raw: { value },
    };
  }

  const raw = asRecord(value);
  const id = readStringCandidate(raw, ["id", "identity_id", "identityId"]);
  const name = readStringCandidate(raw, ["name", "identity", "label", "title"]);
  const valueCandidate = name ?? id ?? readStringCandidate(raw, ["value", "sender", "from_identity"]);

  return {
    id,
    name,
    value: valueCandidate ?? "",
    raw,
  };
}

function extractArrayPayload(value: unknown, keys: string[]) {
  if (Array.isArray(value)) {
    return value;
  }

  const record = asRecord(value);

  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key];
    }
  }

  return null;
}

function normalizeCredit(value: unknown): number | false | null {
  if (value === false) {
    return false;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readStringCandidate(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function parseJson(text: string) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function configuredEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value || value.startsWith("replace-with")) {
    return undefined;
  }

  return value;
}

function booleanEnv(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function withTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function summarizeProviderResponse(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value.slice(0, 240);
  }

  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      type: "object",
      keys: Object.keys(record).slice(0, 12),
      status: summarizeProviderField(record.status),
      message: summarizeProviderField(record.message),
      details: summarizeProviderField(record.details),
      error: summarizeProviderField(record.error),
    };
  }

  return value;
}

function summarizeProviderField(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.slice(0, 240);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 5).map(summarizeProviderField);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 8)
        .map(([key, fieldValue]) => [key, summarizeProviderField(fieldValue)]),
    );
  }

  return String(value).slice(0, 240);
}
