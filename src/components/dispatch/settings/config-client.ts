/**
 * Browser transport for the `/api/telephony/config/*` routes (plan "Fáza 3").
 *
 * Every read returns the whole routing document — the editors cross-reference
 * each other (a step needs its group, a line needs its plan) — so one loader
 * and one saver serve all of them. Requests are bounded like every other
 * telephony fetch, and a rejected save keeps the server's validation issues so
 * the editor can show them next to the offending row.
 */

import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";
import type { OperatorSettingsDoc, RoutingDocument, TelephonySettingsDoc, ValidationIssue } from "@/server/telephony/config-service";

export const TELEPHONY_CONFIG_ENDPOINTS = {
  ringGroups: "/api/telephony/config/ring-groups",
  ringPlans: "/api/telephony/config/ring-plans",
  businessHours: "/api/telephony/config/business-hours",
  pauseReasons: "/api/telephony/config/pause-reasons",
  numbers: "/api/telephony/config/numbers",
  settings: "/api/telephony/config/settings",
} as const;

export type TelephonyConfigSection = keyof typeof TELEPHONY_CONFIG_ENDPOINTS;

/** Mirrors `ConfigDocumentResponse` of `src/server/telephony/config-route.ts`. */
export type RoutingConfigResponse = {
  document: RoutingDocument;
  canEdit: boolean;
  canManageSettings: boolean;
};

export class ConfigRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ValidationIssue[];

  constructor(message: string, status: number, code: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = "ConfigRequestError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

type ErrorBody = { error?: string; code?: string; issues?: ValidationIssue[] };

type Runtime = Parameters<typeof telephonyJson>[2];

export type ConfigRequestOptions = { signal?: AbortSignal | null; runtime?: Runtime };

function unwrap(result: { ok: boolean; status: number; body: (RoutingConfigResponse & ErrorBody) | null }, fallback: string): RoutingConfigResponse {
  if (!result.ok || !result.body || !("document" in result.body) || !result.body.document) {
    const body = (result.body ?? {}) as ErrorBody;
    throw new ConfigRequestError(body.error ?? fallback, result.status, body.code ?? "config_failed", body.issues ?? []);
  }
  return { document: result.body.document, canEdit: Boolean(result.body.canEdit), canManageSettings: Boolean(result.body.canManageSettings) };
}

export async function loadRoutingConfig(section: TelephonyConfigSection, options: ConfigRequestOptions = {}): Promise<RoutingConfigResponse> {
  const result = await telephonyJson<RoutingConfigResponse & ErrorBody>(
    TELEPHONY_CONFIG_ENDPOINTS[section],
    { label: "nastavenia telefónie", timeoutMs: TELEPHONY_TIMEOUT_MS.read, signal: options.signal ?? null },
    options.runtime,
  );
  return unwrap(result, "Nastavenia telefónie sa nepodarilo načítať.");
}

export async function saveRoutingConfig(
  section: TelephonyConfigSection,
  body: Record<string, unknown>,
  options: ConfigRequestOptions & { method?: "PUT" | "PATCH" } = {},
): Promise<RoutingConfigResponse> {
  const result = await telephonyJson<RoutingConfigResponse & ErrorBody>(
    TELEPHONY_CONFIG_ENDPOINTS[section],
    {
      method: options.method ?? "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      label: "uloženie nastavení telefónie",
      timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      signal: options.signal ?? null,
    },
    options.runtime,
  );
  return unwrap(result, "Nastavenia telefónie sa nepodarilo uložiť.");
}

/**
 * `PATCH /api/telephony/config/settings` answers with the saved row, not with
 * the whole routing document (the kill switches are admin-only, so the route
 * never widens its response). The panel merges the result into the document it
 * already holds.
 */
export async function saveTelephonySettings(patch: Record<string, unknown>, options: ConfigRequestOptions = {}): Promise<TelephonySettingsDoc> {
  const result = await telephonyJson<{ ok?: boolean; settings?: TelephonySettingsDoc } & ErrorBody>(
    TELEPHONY_CONFIG_ENDPOINTS.settings,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch }),
      label: "uloženie nastavení telefónie",
      timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      signal: options.signal ?? null,
    },
    options.runtime,
  );
  if (!result.ok || !result.body || !result.body.settings) {
    const body = (result.body ?? {}) as ErrorBody;
    throw new ConfigRequestError(body.error ?? "Nastavenia telefónie sa nepodarilo uložiť.", result.status, body.code ?? "config_failed", body.issues ?? []);
  }
  return result.body.settings;
}

// ---------------------------------------------------------------------------
// Operator routes (`/api/telephony/operators/[id]/…`)
// ---------------------------------------------------------------------------

export const TELEPHONY_OPERATOR_ENDPOINTS = {
  settings: (profileId: string) => `/api/telephony/operators/${encodeURIComponent(profileId)}/settings`,
  credential: (profileId: string) => `/api/telephony/operators/${encodeURIComponent(profileId)}/credential`,
  disconnect: (profileId: string) => `/api/telephony/operators/${encodeURIComponent(profileId)}/disconnect`,
} as const;

export type OperatorDeviceResult = {
  environment: string;
  credentialId: string | null;
  sipUsername: string | null;
  registrationState: string;
};

async function operatorRequest<T extends ErrorBody>(url: string, init: { method: "PATCH" | "POST"; body: Record<string, unknown> }, options: ConfigRequestOptions, fallback: string): Promise<T> {
  const result = await telephonyJson<T>(
    url,
    {
      method: init.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init.body),
      label: "nastavenia operátora",
      timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      signal: options.signal ?? null,
    },
    options.runtime,
  );
  if (!result.ok || !result.body) {
    const body = (result.body ?? {}) as ErrorBody;
    throw new ConfigRequestError(body.error ?? fallback, result.status, body.code ?? "config_failed", body.issues ?? []);
  }
  return result.body;
}

/** `PATCH /api/telephony/operators/[id]/settings` — self, or anyone for a manager. */
export async function saveOperatorSettings(profileId: string, patch: Record<string, unknown>, options: ConfigRequestOptions = {}): Promise<OperatorSettingsDoc> {
  const body = await operatorRequest<{ settings?: OperatorSettingsDoc } & ErrorBody>(
    TELEPHONY_OPERATOR_ENDPOINTS.settings(profileId),
    { method: "PATCH", body: { patch } },
    options,
    "Nastavenia operátora sa nepodarilo uložiť.",
  );
  if (!body.settings) throw new ConfigRequestError("Nastavenia operátora sa nepodarilo uložiť.", 500, "config_failed");
  return body.settings;
}

/**
 * `POST /api/telephony/operators/[id]/credential` with `{ rotate: true }`:
 * mints a new SIP credential and revokes the live browser session, because the
 * token minted from the old credential stops working.
 */
export async function rotateOperatorCredential(profileId: string, options: ConfigRequestOptions = {}): Promise<OperatorDeviceResult | null> {
  const body = await operatorRequest<{ device?: OperatorDeviceResult } & ErrorBody>(
    TELEPHONY_OPERATOR_ENDPOINTS.credential(profileId),
    { method: "POST", body: { rotate: true } },
    options,
    "Prihlasovacie údaje telefónu sa nepodarilo vytvoriť.",
  );
  return body.device ?? null;
}

/** `POST /api/telephony/operators/[id]/disconnect`: the phone, not the call. */
export async function disconnectOperatorDevice(profileId: string, options: ConfigRequestOptions = {}): Promise<void> {
  await operatorRequest<ErrorBody>(
    TELEPHONY_OPERATOR_ENDPOINTS.disconnect(profileId),
    { method: "POST", body: {} },
    options,
    "Telefón sa nepodarilo odpojiť.",
  );
}

/** Message shown above the form when a request failed as a whole. */
export function configErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConfigRequestError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

/** Server issues that could not be matched to a row, ready to be listed. */
export function serverIssues(error: unknown): ValidationIssue[] {
  return error instanceof ConfigRequestError ? error.issues : [];
}
