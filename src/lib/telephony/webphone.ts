export type ViptelWebphoneDialMode = "rest_first_leg" | "sip_invite";
export type ViptelDtmfMode = "rfc2833" | "rfc4733";

export type ViptelWebphoneStatus = "not_configured" | "configured" | "ready" | "blocked";

export const VIPTEL_PRODUCTION_WEBPHONE_EXTENSION = "10";

export type ViptelWebphoneExtension = {
  extension: string;
  label?: string;
  authUsername?: string;
  password?: string;
  passwordConfigured: boolean;
  outboundCallerId?: string;
  canCallExternal: boolean;
  registrationEnabled: boolean;
};

export type ViptelTelephonyIdentity = {
  defaultExtension?: string;
  extensions: Array<{
    extension: string;
    displayName?: string;
    registered?: boolean;
    lastSyncedAt?: string;
  }>;
};

export type ViptelWebphoneIceServer = {
  kind: "stun" | "turn";
  urls: string[];
  username?: string;
  credential?: string;
  credentialConfigured: boolean;
};

export type ViptelWebphoneConfig = {
  enabled: boolean;
  mockEnabled: boolean;
  status: ViptelWebphoneStatus;
  dialMode: ViptelWebphoneDialMode;
  credentialsExposure: "redacted" | "browser_test";
  sipWebSocketUrl?: string;
  sipDomain?: string;
  sipRealm?: string;
  outboundProxy?: string;
  browserRegistrationAllowed?: boolean;
  allowedOrigins: string[];
  codecs: string[];
  dtmfMode?: ViptelDtmfMode;
  iceServers: ViptelWebphoneIceServer[];
  extensions: ViptelWebphoneExtension[];
  missingFields: string[];
};

export type ViptelWebphoneSession = {
  dialMode: ViptelWebphoneDialMode;
  credentialsExposure: "browser_test";
  sipWebSocketUrl: string;
  sipDomain: string;
  sipRealm: string;
  outboundProxy?: string;
  browserRegistrationAllowed: true;
  allowedOrigins: string[];
  codecs: string[];
  dtmfMode: ViptelDtmfMode;
  iceServers: ViptelWebphoneIceServer[];
  extension: ViptelWebphoneExtension & {
    authUsername: string;
    password: string;
  };
};

type WebphoneConfigOptions = {
  includeSecrets?: boolean;
};

type RawExtensionConfig = {
  extension?: unknown;
  label?: unknown;
  authUsername?: unknown;
  password?: unknown;
  outboundCallerId?: unknown;
  canCallExternal?: unknown;
  registrationEnabled?: unknown;
};

export function getViptelWebphoneConfig(
  env: Record<string, string | undefined> = process.env,
  options: WebphoneConfigOptions = {},
): ViptelWebphoneConfig {
  const includeSecrets = options.includeSecrets === true;
  const sipWebSocketUrl = readEnv(env, "VIPTEL_SIP_WS_URL") ?? readEnv(env, "VIPTEL_WEBPHONE_WS_URL");
  const sipDomain = readEnv(env, "VIPTEL_SIP_DOMAIN") ?? readEnv(env, "VIPTEL_WEBPHONE_DOMAIN");
  const sipRealm = readEnv(env, "VIPTEL_SIP_REALM") ?? sipDomain;
  const outboundProxy = readEnv(env, "VIPTEL_SIP_OUTBOUND_PROXY");
  const browserRegistrationAllowed = readOptionalBoolean(env, "VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED");
  const dialMode = readDialMode(readEnv(env, "VIPTEL_WEBPHONE_DIAL_MODE"));
  const allowedOrigins = splitList(readEnv(env, "VIPTEL_SIP_ALLOWED_ORIGINS") ?? readEnv(env, "APP_BASE_URL"));
  const codecs = splitList(readEnv(env, "VIPTEL_SIP_CODECS"));
  const dtmfMode = readDtmfMode(readEnv(env, "VIPTEL_SIP_DTMF_MODE"));
  const extensions = readExtensions(env, includeSecrets);
  const iceServers = readIceServers(env, includeSecrets);
  const explicitEnabled = readOptionalBoolean(env, "VIPTEL_SIP_WEBPHONE_ENABLED");
  const mockEnabled = isViptelWebphoneMockEnabled(env);
  const hasAnyConfig = Boolean(sipWebSocketUrl || sipDomain || outboundProxy || extensions.length > 0 || iceServers.length > 0);
  const enabled = explicitEnabled ?? hasAnyConfig;
  const missingFields = collectMissingFields({
    browserRegistrationAllowed,
    codecs,
    dtmfMode,
    extensions,
    sipDomain,
    sipRealm,
    sipWebSocketUrl,
  });
  const status = resolveStatus({
    browserRegistrationAllowed,
    enabled,
    extensions,
    missingFields,
    sipDomain,
    sipRealm,
    sipWebSocketUrl,
  });

  return {
    enabled,
    mockEnabled,
    status,
    dialMode,
    credentialsExposure: includeSecrets ? "browser_test" : "redacted",
    sipWebSocketUrl,
    sipDomain,
    sipRealm,
    outboundProxy,
    browserRegistrationAllowed,
    allowedOrigins,
    codecs,
    dtmfMode,
    iceServers,
    extensions,
    missingFields,
  };
}

export function isViptelBrowserCredentialExposureEnabled(env: Record<string, string | undefined> = process.env) {
  return readOptionalBoolean(env, "VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS") === true;
}

export function isViptelWebphoneMockEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV === "development" && readOptionalBoolean(env, "VIPTEL_WEBPHONE_MOCK_ENABLED") === true;
}

export function getViptelWebphoneSession(
  env: Record<string, string | undefined> = process.env,
  requestedExtension: unknown,
): ViptelWebphoneSession {
  const extensionNumber = readString(requestedExtension);

  if (!extensionNumber) {
    throw new ViptelWebphoneSessionError("Browser klapka je povinná.", 400);
  }

  if (extensionNumber === VIPTEL_PRODUCTION_WEBPHONE_EXTENSION) {
    throw new ViptelWebphoneSessionError("Produkčná klapka 10 nie je povolená pre browser phone test.", 400);
  }

  if (!isViptelBrowserCredentialExposureEnabled(env)) {
    throw new ViptelWebphoneSessionError("Browser SIP credentials nie sú povolené v runtime konfigurácii.", 403);
  }

  const config = getViptelWebphoneConfig(env, { includeSecrets: true });
  const extension = config.extensions.find((item) => item.extension === extensionNumber);

  if (!config.enabled) {
    throw new ViptelWebphoneSessionError("Telefonovanie v prehliadači je vypnuté.", 503);
  }

  if (!extension) {
    throw new ViptelWebphoneSessionError(`Browser klapka ${extensionNumber} nie je nakonfigurovaná.`, 404);
  }

  if (!extension.registrationEnabled) {
    throw new ViptelWebphoneSessionError(`Browser registrácia pre klapku ${extensionNumber} nie je povolená.`, 409);
  }

  if (!extension.authUsername || !extension.password) {
    throw new ViptelWebphoneSessionError(`Browser klapka ${extensionNumber} nemá kompletné SIP credentials.`, 409);
  }

  if (config.browserRegistrationAllowed !== true) {
    throw new ViptelWebphoneSessionError("PBX registrácia priamo z browsera nie je potvrdená.", 409);
  }

  const sipWebSocketUrl = config.sipWebSocketUrl;
  const sipDomain = config.sipDomain;
  const sipRealm = config.sipRealm;
  const hasCodecs = config.codecs.length > 0;
  const dtmfMode = config.dtmfMode;

  if (!sipWebSocketUrl || !sipDomain || !sipRealm || !hasCodecs || !dtmfMode) {
    const missingCoreFields = [
      sipWebSocketUrl ? undefined : "VIPTEL_SIP_WS_URL",
      sipDomain ? undefined : "VIPTEL_SIP_DOMAIN",
      sipRealm ? undefined : "VIPTEL_SIP_REALM",
      hasCodecs ? undefined : "VIPTEL_SIP_CODECS",
      dtmfMode ? undefined : "VIPTEL_SIP_DTMF_MODE (rfc2833 or rfc4733)",
    ].filter(Boolean);

    throw new ViptelWebphoneSessionError(`Chýba webphone konfigurácia: ${missingCoreFields.join(", ")}.`, 409);
  }

  return {
    dialMode: config.dialMode,
    credentialsExposure: "browser_test",
    sipWebSocketUrl,
    sipDomain,
    sipRealm,
    outboundProxy: config.outboundProxy,
    browserRegistrationAllowed: true,
    allowedOrigins: config.allowedOrigins,
    codecs: config.codecs,
    dtmfMode,
    iceServers: config.iceServers,
    extension: {
      ...extension,
      authUsername: extension.authUsername,
      password: extension.password,
    },
  };
}

export class ViptelWebphoneSessionError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

function collectMissingFields({
  browserRegistrationAllowed,
  codecs,
  dtmfMode,
  extensions,
  sipDomain,
  sipRealm,
  sipWebSocketUrl,
}: {
  browserRegistrationAllowed?: boolean;
  codecs: string[];
  dtmfMode?: ViptelDtmfMode;
  extensions: ViptelWebphoneExtension[];
  sipDomain?: string;
  sipRealm?: string;
  sipWebSocketUrl?: string;
}) {
  const missing: string[] = [];

  if (!sipWebSocketUrl) missing.push("VIPTEL_SIP_WS_URL");
  if (!sipDomain) missing.push("VIPTEL_SIP_DOMAIN");
  if (!sipRealm) missing.push("VIPTEL_SIP_REALM");
  if (extensions.length === 0) missing.push("VIPTEL_WEBPHONE_EXTENSIONS_JSON or VIPTEL_WEBPHONE_EXTENSIONS");
  if (extensions.some((extension) => !extension.passwordConfigured)) missing.push("webphone extension passwords");
  if (browserRegistrationAllowed === undefined) missing.push("VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED");
  if (codecs.length === 0) missing.push("VIPTEL_SIP_CODECS");
  if (!dtmfMode) missing.push("VIPTEL_SIP_DTMF_MODE (rfc2833 or rfc4733)");

  return missing;
}

function resolveStatus({
  browserRegistrationAllowed,
  enabled,
  extensions,
  missingFields,
  sipDomain,
  sipRealm,
  sipWebSocketUrl,
}: {
  browserRegistrationAllowed?: boolean;
  enabled: boolean;
  extensions: ViptelWebphoneExtension[];
  missingFields: string[];
  sipDomain?: string;
  sipRealm?: string;
  sipWebSocketUrl?: string;
}): ViptelWebphoneStatus {
  if (!enabled) {
    return "not_configured";
  }

  if (browserRegistrationAllowed === false) {
    return "blocked";
  }

  const hasCoreConfig = Boolean(sipWebSocketUrl && sipDomain && sipRealm && extensions.length > 0);
  const hasExtensionSecrets = extensions.length > 0 && extensions.every((extension) => extension.passwordConfigured);

  if (hasCoreConfig && hasExtensionSecrets && missingFields.length === 0) {
    return "ready";
  }

  if (hasCoreConfig) {
    return "configured";
  }

  return "not_configured";
}

export function isViptelWebphoneReadyForBrowser(
  config: ViptelWebphoneConfig | null | undefined,
  extensionNumber?: string,
) {
  if (
    !config ||
    config.status !== "ready" ||
    config.credentialsExposure !== "browser_test" ||
    config.browserRegistrationAllowed !== true
  ) {
    return false;
  }

  const extension = extensionNumber
    ? config.extensions.find((candidate) => candidate.extension === extensionNumber)
    : config.extensions[0];
  return Boolean(extension?.passwordConfigured && extension.registrationEnabled);
}

function readExtensions(env: Record<string, string | undefined>, includeSecrets: boolean) {
  const fromJson = readExtensionsJson(env, includeSecrets);

  if (fromJson.length > 0) {
    return fromJson;
  }

  return splitList(readEnv(env, "VIPTEL_WEBPHONE_EXTENSIONS")).map((extension) => {
    const prefix = `VIPTEL_WEBPHONE_${extension.replace(/[^a-zA-Z0-9]/g, "_")}_`;
    const password = readEnv(env, `${prefix}PASSWORD`);

    return normalizeExtension(
      {
        extension,
        label: readEnv(env, `${prefix}LABEL`),
        authUsername: readEnv(env, `${prefix}AUTH_USERNAME`) ?? extension,
        password,
        outboundCallerId: readEnv(env, `${prefix}OUTBOUND_CALLER_ID`),
        canCallExternal: readOptionalBoolean(env, `${prefix}CAN_CALL_EXTERNAL`),
        registrationEnabled: readOptionalBoolean(env, `${prefix}REGISTRATION_ENABLED`),
      },
      includeSecrets,
    );
  });
}

function readExtensionsJson(env: Record<string, string | undefined>, includeSecrets: boolean) {
  const raw = readEnv(env, "VIPTEL_WEBPHONE_EXTENSIONS_JSON");

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      const normalized = normalizeExtension(item as RawExtensionConfig, includeSecrets);
      return normalized.extension ? [normalized] : [];
    });
  } catch {
    return [];
  }
}

function normalizeExtension(raw: RawExtensionConfig, includeSecrets: boolean): ViptelWebphoneExtension {
  const extension = readString(raw.extension) ?? "";
  const password = readString(raw.password);
  const outboundCallerId = readString(raw.outboundCallerId);

  return {
    extension,
    label: readString(raw.label),
    authUsername: readString(raw.authUsername) ?? extension,
    password: includeSecrets ? password : undefined,
    passwordConfigured: Boolean(password),
    outboundCallerId,
    canCallExternal: readBoolean(raw.canCallExternal) ?? Boolean(outboundCallerId),
    registrationEnabled: readBoolean(raw.registrationEnabled) ?? Boolean(password),
  };
}

function readIceServers(env: Record<string, string | undefined>, includeSecrets: boolean) {
  const stunUrls = splitList(readEnv(env, "VIPTEL_SIP_STUN_URLS"));
  const turnUrls = splitList(readEnv(env, "VIPTEL_SIP_TURN_URLS"));
  const turnUsername = readEnv(env, "VIPTEL_SIP_TURN_USERNAME");
  const turnCredential = readEnv(env, "VIPTEL_SIP_TURN_CREDENTIAL");
  const servers: ViptelWebphoneIceServer[] = [];

  if (stunUrls.length > 0) {
    servers.push({
      kind: "stun",
      urls: stunUrls,
      credentialConfigured: true,
    });
  }

  if (turnUrls.length > 0) {
    servers.push({
      kind: "turn",
      urls: turnUrls,
      username: turnUsername,
      credential: includeSecrets ? turnCredential : undefined,
      credentialConfigured: Boolean(turnUsername && turnCredential),
    });
  }

  return servers;
}

function readDialMode(value: string | undefined): ViptelWebphoneDialMode {
  return value === "rest_first_leg" ? "rest_first_leg" : "sip_invite";
}

function readDtmfMode(value: string | undefined): ViptelDtmfMode | undefined {
  const normalized = value?.toLowerCase();
  return normalized === "rfc2833" || normalized === "rfc4733" ? normalized : undefined;
}

function readOptionalBoolean(env: Record<string, string | undefined>, name: string) {
  const value = readEnv(env, name)?.toLowerCase();

  if (["1", "true", "yes", "on"].includes(value ?? "")) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value ?? "")) {
    return false;
  }

  return undefined;
}

function splitList(value: string | undefined) {
  return (value ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readEnv(env: Record<string, string | undefined>, name: string) {
  const value = env[name]?.trim();

  if (!value || value.startsWith("replace-with") || value === "TODO") {
    return undefined;
  }

  return value;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}
