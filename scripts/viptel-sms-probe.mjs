#!/usr/bin/env node

const argv = process.argv.slice(2);
const outputJson = hasFlag("--json");
const sendTest = hasFlag("--send-test");
const testBody = argValue("--body") ?? "Test SMS z Pomoc Motoristom dispecingu.";

try {
  const result = await run();

  if (outputJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
} catch (error) {
  const payload = serializeError(error);

  if (outputJson) {
    console.error(JSON.stringify({ ok: false, ...payload }, null, 2));
  } else {
    console.error(`VIPTel SMS probe failed: ${payload.error}`);
    if (payload.providerStatus) {
      console.error(`Provider status: ${payload.providerStatus}`);
    }
  }

  process.exitCode = 1;
}

async function run() {
  const config = readConfig();
  const [identitiesResponse, creditResponse] = await Promise.all([apiJson(config, "/identities/"), apiJson(config, "/credits/")]);
  const identities = extractArrayPayload(identitiesResponse.body, ["identities", "data", "results", "items"]).map(normalizeIdentity).filter((identity) => identity.value);
  const credit = normalizeCredit(asRecord(creditResponse.body).credit ?? creditResponse.body);
  const selectedFromIdentity = config.fromIdentity ? cleanSmsIdentity(config.fromIdentity, "VIPTEL_SMS_FROM_IDENTITY") : firstUsableIdentity(identities);
  const missingForLiveSend = [
    config.liveSendsEnabled ? null : "VIPTEL_SMS_LIVE_SENDS=true",
    selectedFromIdentity ? null : "VIPTEL_SMS_FROM_IDENTITY or at least one VIPTel identity",
    config.testMsisdn ? null : "VIPTEL_SMS_TEST_MSISDN",
  ].filter(Boolean);
  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    sms: {
      baseUrl: config.baseUrl,
      identitiesStatus: identitiesResponse.status,
      creditsStatus: creditResponse.status,
      identityCount: identities.length,
      identitySamples: identities.slice(0, 10).map(({ id, name, value }) => ({ id, name, value })),
      credit,
    },
    liveSend: {
      enabled: config.liveSendsEnabled,
      ready: missingForLiveSend.length === 0,
      missing: missingForLiveSend,
      selectedFromIdentity: selectedFromIdentity ?? null,
      testMsisdnConfigured: Boolean(config.testMsisdn),
    },
    send: null,
  };

  if (sendTest) {
    result.send = await sendConfiguredTestMessage(config, selectedFromIdentity, testBody);
  }

  return result;
}

async function sendConfiguredTestMessage(config, selectedFromIdentity, body) {
  if (!config.liveSendsEnabled) {
    throw new Error("VIPTel SMS live sends are disabled. Set VIPTEL_SMS_LIVE_SENDS=true before using --send-test.");
  }

  if (!selectedFromIdentity) {
    throw new Error("VIPTEL_SMS_FROM_IDENTITY is required because VIPTel did not return a usable identity.");
  }

  if (!config.testMsisdn) {
    throw new Error("VIPTEL_SMS_TEST_MSISDN is required before using --send-test.");
  }

  const formData = new FormData();
  formData.set("from_identity", selectedFromIdentity);
  formData.set("body", cleanSmsBody(body));
  formData.set("dest_msisdn", config.testMsisdn);

  const response = await apiJson(config, "/messages/", {
    body: formData,
    method: "POST",
  });

  return {
    providerStatus: response.status,
    providerResponse: response.body,
  };
}

async function apiJson(config, path, init = {}) {
  if (typeof fetch !== "function") {
    throw new Error("This Node runtime does not expose fetch. Use the project Node version.");
  }

  const url = new URL(path.replace(/^\//, ""), config.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(url, {
      body: init.body,
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`,
      },
      method: init.method ?? "GET",
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);

    if (!response.ok) {
      const error = new Error(`VIPTel SMS returned HTTP ${response.status}.`);
      error.providerStatus = response.status;
      error.providerResponse = body ?? text;
      throw error;
    }

    return {
      body,
      status: response.status,
    };
  } catch (error) {
    if (error?.providerStatus) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      const timeoutError = new Error("VIPTel SMS request timed out.");
      timeoutError.providerStatus = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readConfig() {
  const testMsisdn = env("VIPTEL_SMS_TEST_MSISDN");

  return {
    baseUrl: withTrailingSlash(env("VIPTEL_SMS_BASE_URL") ?? "https://smsapi.viptel.sk/api/"),
    username: requiredEnv("VIPTEL_SMS_USERNAME"),
    password: requiredEnv("VIPTEL_SMS_PASSWORD"),
    fromIdentity: env("VIPTEL_SMS_FROM_IDENTITY"),
    liveSendsEnabled: booleanEnv("VIPTEL_SMS_LIVE_SENDS"),
    testMsisdn: testMsisdn ? normalizeViptelSmsMsisdn(testMsisdn, "VIPTEL_SMS_TEST_MSISDN") : undefined,
    requestTimeoutMs: numberEnv("VIPTEL_SMS_REQUEST_TIMEOUT_MS", numberEnv("VIPTEL_REQUEST_TIMEOUT_MS", 8000)),
  };
}

function printHuman(result) {
  console.log(`SMS API ${result.sms.baseUrl}`);
  console.log(`  /identities/: ${result.sms.identitiesStatus}, count=${result.sms.identityCount}`);
  console.log(`  /credits/: ${result.sms.creditsStatus}, credit=${result.sms.credit === false ? "not used" : result.sms.credit ?? "unknown"}`);

  for (const identity of result.sms.identitySamples) {
    console.log(`  identity: ${identity.id ?? "-"} ${identity.name ?? identity.value}`);
  }

  console.log(`  live send: ${result.liveSend.ready ? "ready" : "not ready"}`);

  if (result.liveSend.missing.length > 0) {
    console.log(`  missing for live send: ${result.liveSend.missing.join(", ")}`);
  }

  if (result.send) {
    console.log(`  test send: HTTP ${result.send.providerStatus}`);
  }
}

function serializeError(error) {
  return {
    error: error instanceof Error ? error.message : "Unexpected VIPTel SMS probe error.",
    providerStatus: error?.providerStatus,
    providerResponseSummary: summarizeProviderResponse(error?.providerResponse),
  };
}

function normalizeViptelSmsMsisdn(value, fieldName = "number") {
  const input = String(value ?? "").trim();

  if (!input) {
    throw new Error(`${fieldName} is required.`);
  }

  if (!/^\+?[\d ()/.-]{1,40}$/.test(input)) {
    throw new Error(`${fieldName} must be a valid phone number.`);
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
    throw new Error(`${fieldName} must use a local Slovak number or an international +/00 prefix.`);
  }

  return normalized;
}

function cleanSmsIdentity(value, fieldName = "fromIdentity") {
  const input = String(value ?? "").trim();

  if (!input) {
    throw new Error(`${fieldName} is required.`);
  }

  const digits = input.replace(/\D/g, "");

  if (/^\+?[\d ()/.-]+$/.test(input) && digits.length >= 9) {
    return normalizeViptelSmsMsisdn(input, fieldName);
  }

  if (input.length > 80) {
    throw new Error(`${fieldName} is too long.`);
  }

  return input;
}

function cleanSmsBody(value) {
  const body = String(value ?? "").trim();

  if (!body) {
    throw new Error("SMS body is required.");
  }

  if (body.length > 1200) {
    throw new Error("SMS body is too long for a guarded SMS send.");
  }

  return body;
}

function normalizeIdentity(value) {
  if (typeof value === "string" || typeof value === "number") {
    const identity = String(value).trim();
    return {
      id: identity,
      value: identity,
    };
  }

  const record = asRecord(value);
  const id = readStringCandidate(record, ["id", "identity_id", "identityId"]);
  const name = readStringCandidate(record, ["name", "identity", "label", "title"]);
  const valueCandidate = name ?? id ?? readStringCandidate(record, ["value", "sender", "from_identity"]);

  return {
    id,
    name,
    value: valueCandidate ?? "",
  };
}

function firstUsableIdentity(identities) {
  const preferred = identities.find((identity) => identity.name?.startsWith("00") || identity.value.startsWith("00"));
  return preferred?.name ?? preferred?.value ?? preferred?.id ?? identities[0]?.name ?? identities[0]?.value ?? identities[0]?.id;
}

function extractArrayPayload(value, keys) {
  if (Array.isArray(value)) {
    return value;
  }

  const record = asRecord(value);

  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key];
    }
  }

  return [];
}

function normalizeCredit(value) {
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

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readStringCandidate(record, keys) {
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

function parseJson(text) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requiredEnv(name) {
  const value = env(name);

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function env(name) {
  const value = process.env[name]?.trim();
  return value && !value.startsWith("replace-with") ? value : undefined;
}

function booleanEnv(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function hasFlag(name) {
  return argv.includes(name);
}

function argValue(name) {
  const direct = argv.find((arg) => arg.startsWith(`${name}=`));

  if (direct) {
    return direct.slice(name.length + 1);
  }

  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function summarizeProviderResponse(value) {
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
    return {
      type: "object",
      keys: Object.keys(value).slice(0, 12),
      status: summarizeProviderField(value.status),
      message: summarizeProviderField(value.message),
      details: summarizeProviderField(value.details),
      error: summarizeProviderField(value.error),
    };
  }

  return value;
}

function summarizeProviderField(value) {
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
    return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, fieldValue]) => [key, summarizeProviderField(fieldValue)]));
  }

  return String(value).slice(0, 240);
}
