import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { cleanPhoneInput, formatDialTarget, TelephonyPhoneInputError } from "@/lib/telephony/phone";
import type { MotoristActor } from "@/server/api-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { MutationError } from "@/server/motorist-mutations";
import {
  parseViptelRotationSettings,
  validateFallbackAgainstRotation,
} from "./dispatch-rotation";

type AdminClient = SupabaseClient<Database>;

export const VIPTEL_FALLBACK_CONFIG_KEY = "inboundFallback";
export const VIPTEL_FALLBACK_SCHEMA_VERSION = 1;
export const DEFAULT_VIPTEL_FALLBACK_SECONDS = 60;
export const MIN_VIPTEL_FALLBACK_SECONDS = 10;
export const MAX_VIPTEL_FALLBACK_SECONDS = 3_600;

export type ViptelFallbackSettings = {
  enabled: boolean;
  destination: string | null;
  afterSeconds: number;
  revision: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type ViptelFallbackCommandMarker = {
  schemaVersion: 1;
  revision: string;
  destination: string;
  afterSeconds: number;
  trigger: "no_available_operators" | "timeout";
};

export async function loadViptelFallbackSettings(
  organizationId: string,
  client: AdminClient = createSupabaseAdminClient(),
) {
  const result = await client
    .from("motorist_organization_integrations")
    .select("id, config, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .maybeSingle();
  if (result.error) throw new Error(`VIPTel fallback settings could not be loaded: ${result.error.message}`);
  return {
    integrationId: result.data?.id ?? null,
    integrationUpdatedAt: result.data?.updated_at ?? null,
    settings: parseViptelFallbackSettings(result.data?.config),
  };
}

export async function updateViptelFallbackSettings(
  actor: MotoristActor,
  input: { destination?: unknown; afterSeconds?: unknown },
) {
  if (actor.role !== "manager" && actor.role !== "admin") {
    throw new MutationError("Záložné presmerovanie môže meniť iba manažér alebo administrátor.", 403);
  }

  const destinationInput = typeof input.destination === "string" ? input.destination.trim() : "";
  let destination: string | null = null;
  if (destinationInput) {
    try {
      const parsed = cleanPhoneInput(destinationInput, "Záložné telefónne číslo");
      if (parsed.kind !== "phone") {
        throw new MutationError("Záložný cieľ musí byť celé externé telefónne číslo, nie interná klapka.", 400);
      }
      destination = formatDialTarget(destinationInput, "Záložné telefónne číslo");
    } catch (error) {
      if (error instanceof MutationError) throw error;
      if (error instanceof TelephonyPhoneInputError) throw new MutationError(error.message, 400);
      throw error;
    }
  }

  const afterSeconds = Number(input.afterSeconds ?? DEFAULT_VIPTEL_FALLBACK_SECONDS);
  if (
    !Number.isInteger(afterSeconds) ||
    afterSeconds < MIN_VIPTEL_FALLBACK_SECONDS ||
    afterSeconds > MAX_VIPTEL_FALLBACK_SECONDS
  ) {
    throw new MutationError(
      `Čas záložného presmerovania musí byť celé číslo od ${MIN_VIPTEL_FALLBACK_SECONDS} do ${MAX_VIPTEL_FALLBACK_SECONDS} sekúnd.`,
      400,
    );
  }

  const client = createSupabaseAdminClient();
  const current = await loadViptelFallbackSettings(actor.organizationId, client);
  if (!current.integrationId || !current.integrationUpdatedAt) {
    throw new MutationError("VIPTel integrácia ešte nemá vytvorený konfiguračný záznam.", 409);
  }
  const integration = await client
    .from("motorist_organization_integrations")
    .select("config")
    .eq("id", current.integrationId)
    .eq("organization_id", actor.organizationId)
    .eq("provider", "viptel")
    .eq("updated_at", current.integrationUpdatedAt)
    .maybeSingle();
  if (integration.error) throw new Error(`VIPTel integration could not be loaded: ${integration.error.message}`);
  if (!integration.data) {
    throw new MutationError("Nastavenie VIPTel sa medzitým zmenilo. Obnov stránku a skús to znova.", 409);
  }

  const updatedAt = new Date().toISOString();
  const config = jsonRecord(integration.data.config);

  // The fallback delay and the PBX rotation are independent knobs and used to
  // have no relationship at all. Only the unambiguous conflict is fatal: a
  // fallback shorter than one rotation step redirects the caller before the
  // first workstation has finished ringing. Everything else is advice, because
  // the rotation value is our record of provider-owned behaviour and can lag.
  const rotationVerdict = validateFallbackAgainstRotation(
    afterSeconds,
    parseViptelRotationSettings(config),
  );
  if (rotationVerdict.level === "invalid") {
    throw new MutationError(rotationVerdict.message, 400);
  }
  const nextSettings = {
    schemaVersion: VIPTEL_FALLBACK_SCHEMA_VERSION,
    enabled: Boolean(destination),
    destination,
    afterSeconds,
    revision: randomUUID(),
    updatedAt,
    updatedBy: actor.profileId,
  };
  const updated = await client
    .from("motorist_organization_integrations")
    .update({
      config: { ...config, [VIPTEL_FALLBACK_CONFIG_KEY]: nextSettings } as Json,
    })
    .eq("id", current.integrationId)
    .eq("organization_id", actor.organizationId)
    .eq("provider", "viptel")
    .eq("updated_at", current.integrationUpdatedAt)
    .select("config")
    .maybeSingle();
  if (updated.error) throw new Error(`VIPTel fallback settings could not be saved: ${updated.error.message}`);
  if (!updated.data) {
    throw new MutationError("Nastavenie VIPTel sa medzitým zmenilo. Obnov stránku a skús to znova.", 409);
  }
  return parseViptelFallbackSettings(updated.data.config);
}

export function parseViptelFallbackSettings(configValue: unknown): ViptelFallbackSettings {
  const raw = jsonRecord(jsonRecord(configValue)[VIPTEL_FALLBACK_CONFIG_KEY]);
  const afterSeconds = integerInRange(
    raw.afterSeconds,
    MIN_VIPTEL_FALLBACK_SECONDS,
    MAX_VIPTEL_FALLBACK_SECONDS,
  ) ?? DEFAULT_VIPTEL_FALLBACK_SECONDS;
  const destination = dialTarget(raw.destination);
  const revision = uuid(raw.revision);
  const updatedBy = uuid(raw.updatedBy);
  const updatedAt = isoDate(raw.updatedAt);
  const valid = raw.schemaVersion === VIPTEL_FALLBACK_SCHEMA_VERSION && Boolean(destination && revision && updatedBy);
  return {
    enabled: raw.enabled === true && valid,
    destination: valid ? destination ?? null : null,
    afterSeconds,
    revision: valid ? revision ?? null : null,
    updatedAt: valid ? updatedAt : null,
    updatedBy: valid ? updatedBy ?? null : null,
  };
}

export function fallbackCommandMarker(value: unknown): ViptelFallbackCommandMarker | null {
  const marker = jsonRecord(value);
  const revision = uuid(marker.revision);
  const destination = dialTarget(marker.destination);
  const afterSeconds = integerInRange(
    marker.afterSeconds,
    MIN_VIPTEL_FALLBACK_SECONDS,
    MAX_VIPTEL_FALLBACK_SECONDS,
  );
  const trigger = marker.trigger === "no_available_operators" ? "no_available_operators" : "timeout";
  return marker.schemaVersion === VIPTEL_FALLBACK_SCHEMA_VERSION && revision && destination && afterSeconds
    ? { schemaVersion: 1, revision, destination, afterSeconds, trigger }
    : null;
}

export function isSystemFallbackRedirectPayload(value: unknown) {
  const payload = jsonRecord(value);
  const marker = fallbackCommandMarker(payload.systemFallback);
  return Boolean(
    marker &&
    payload.destinationKind === "phone" &&
    dialTarget(payload.destination) === marker.destination &&
    payload.assignmentGuard === undefined,
  );
}

export async function assertSystemFallbackRedirectAuthorized(
  client: AdminClient,
  organizationId: string,
  command: Pick<
    Database["public"]["Tables"]["motorist_telephony_commands"]["Row"],
    "call_id" | "command_type" | "extension_id" | "request_payload" | "requested_by"
  >,
  now = new Date(),
) {
  const payload = jsonRecord(command.request_payload);
  const marker = fallbackCommandMarker(payload.systemFallback);
  if (
    command.command_type !== "call.redirect" ||
    command.extension_id !== null ||
    !command.call_id ||
    !command.requested_by ||
    !marker ||
    !isSystemFallbackRedirectPayload(payload)
  ) {
    throw new Error("Záložné presmerovanie nemá platnú serverovú autorizáciu.");
  }
  const loaded = await loadViptelFallbackSettings(organizationId, client);
  const settings = loaded.settings;
  if (
    !settings.enabled ||
    settings.revision !== marker.revision ||
    settings.destination !== marker.destination ||
    settings.afterSeconds !== marker.afterSeconds ||
    settings.updatedBy !== command.requested_by
  ) {
    throw new Error("Nastavenie záložného presmerovania sa pred odoslaním zmenilo.");
  }

  const call = await client
    .from("motorist_calls")
    .select("id, direction, status, queue_number, viptel_unique_id, from_queue_unique_id, answered_at, ended_at, started_at, created_at")
    .eq("id", command.call_id)
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .maybeSingle();
  if (call.error || !call.data) throw new Error("Čakajúci hovor pre záložné presmerovanie už neexistuje.");
  const uniqueId = typeof payload.uniqueId === "string" ? payload.uniqueId.trim() : "";
  // `started_at` follows the current VIPTel agent leg and is rewritten on
  // every queue handoff. Fallback belongs to the one logical caller journey,
  // whose immutable clock is the database row creation time.
  const elapsedMs = fallbackCallElapsedMs(call.data, now);
  const triggerAuthorized = marker.trigger === "no_available_operators" || elapsedMs >= marker.afterSeconds * 1_000;
  if (
    call.data.direction !== "inbound" ||
    !["incoming", "ringing_agent", "abandoned_queue", "missed", "answered"].includes(call.data.status) ||
    call.data.ended_at ||
    !["601", "602", "603"].includes(call.data.queue_number ?? "") ||
    !triggerAuthorized ||
    ![call.data.from_queue_unique_id, call.data.viptel_unique_id].some((value) => value === uniqueId)
  ) {
    throw new Error("Hovor už nespĺňa podmienky záložného presmerovania.");
  }
  return call.data;
}

export function fallbackCallElapsedMs(
  call: Pick<Database["public"]["Tables"]["motorist_calls"]["Row"], "created_at" | "started_at">,
  now: Date,
) {
  return now.getTime() - Date.parse(call.created_at);
}

function dialTarget(value: unknown) {
  return typeof value === "string" && /^\d{9,18}$/.test(value) ? value : null;
}

function integerInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function uuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function isoDate(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
