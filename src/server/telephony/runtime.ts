import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE, TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";
import type { MotoristActor } from "@/server/api-auth";
import { resolveDefaultOrganizationId } from "@/server/default-organization";
import { MutationError } from "@/server/mutation-error";

import { CallActionError, type CallActionDeps, type CallActor } from "./call-actions";
import { OperatorDeviceError } from "./operator-devices";
import { PresenceServiceError } from "./presence-service";
import type { TelephonyEnvironment } from "./state/types";
import { createTelnyxClient, resolveTelnyxLiveGate, TelnyxCommandError, type TelnyxClient } from "./telnyx/client";
import { getTelnyxConfig, type EnvRecord, type TelnyxConfig } from "./telnyx/env";
import type { ProcessorDeps } from "./telnyx/event-processor";

/**
 * Shared wiring for the telephony API routes (design §4 Phase 2).
 *
 * Every route builds the same dependency bundle — admin Supabase client,
 * environment, Telnyx client (or `null` when telephony is not configured) and
 * the caller-matching seam — and maps the service-layer error classes onto
 * HTTP responses with Slovak messages. Nothing here throws when Telnyx is
 * missing: `telnyx` is simply `null` and the routes answer 503.
 */

export type TelephonyRuntimeDeps = CallActionDeps & ProcessorDeps;

/** `production` only on the Vercel production deployment; preview/dev share the dev credential connection. */
export function telephonyEnvironment(env: EnvRecord = process.env): TelephonyEnvironment {
  return env.VERCEL_ENV?.trim() === "production" ? "production" : "development";
}

export function isProductionDeployment(env: EnvRecord = process.env): boolean {
  return env.VERCEL_ENV?.trim() === "production";
}

export type CreateTelephonyDepsOptions = {
  /** Skips the organisation lookup when the caller already resolved it (session routes). */
  organizationId?: string;
  /** Webhook processing sweeps by default; routes that sweep themselves pass `false`. */
  sweepAfterEvent?: boolean;
  logger?: (entry: Record<string, unknown>) => void;
  config?: TelnyxConfig;
};

/** Structured one-line log; the webhook route uses it for its per-event record (design §2.3 item 10). */
export function telephonyLogger(entry: Record<string, unknown>): void {
  const level = typeof entry.level === "string" ? entry.level : "info";
  const line = JSON.stringify({ scope: "telephony", ...entry });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export async function createTelephonyDeps(options: CreateTelephonyDepsOptions = {}): Promise<TelephonyRuntimeDeps> {
  const admin = createSupabaseAdminClient();
  const organizationId = options.organizationId ?? (await resolveDefaultOrganizationId());
  const config = options.config ?? getTelnyxConfig();
  const environment = telephonyEnvironment();

  let telnyx: TelnyxClient | null = null;
  if (config.configured) {
    const { data } = await admin
      .from("motorist_telephony_settings")
      .select("live_calls_enabled, sms_live_sends")
      .eq("organization_id", organizationId)
      .maybeSingle();
    telnyx = createTelnyxClient({ config, liveGate: resolveTelnyxLiveGate(config, data ?? null) });
  }

  return {
    admin,
    telnyx,
    config,
    organizationId,
    environment,
    sweepAfterEvent: options.sweepAfterEvent,
    logger: options.logger ?? telephonyLogger,
    // Loaded lazily: `telephony-workflow` pulls in the whole dispatch repository,
    // which must stay off the webhook cold path until an inbound call needs a match.
    findCallerMatches: async (number: string) => {
      const { findCallerMatches } = await import("@/server/telephony-workflow");
      return findCallerMatches(number);
    },
  };
}

export const TELEPHONY_ROUTE_ROLES: CallActor["role"][] = ["dispatcher", "senior_dispatcher", "manager", "admin"];

/** The session actor in the shape the call-action services expect. */
export function toCallActor(actor: MotoristActor): CallActor {
  return { profileId: actor.profileId, role: actor.role, displayName: actor.displayName };
}

export function notConfiguredResponse(): Response {
  return Response.json({ error: TELEPHONY_NOT_CONFIGURED_MESSAGE }, { status: 503 });
}

/** Guard for routes that need a live provider; returns a 503 response or `null`. */
export function telephonyConfiguredOrResponse(config: TelnyxConfig = getTelnyxConfig()): Response | null {
  return config.configured ? null : notConfiguredResponse();
}

function errorJson(message: string, status: number, code?: string | null): Response {
  return Response.json(code ? { error: message, code } : { error: message }, { status });
}

/** Maps the telephony service error classes onto responses; anything else is a logged 500. */
export function telephonyErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof MutationError) return errorJson(error.message, error.status);
  if (error instanceof CallActionError) return errorJson(error.message, error.status, error.code);
  if (error instanceof PresenceServiceError) return errorJson(error.message, error.status);
  if (error instanceof OperatorDeviceError) return errorJson(error.message, error.status);
  if (error instanceof TelephonyNotConfiguredError) return errorJson(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503);
  if (error instanceof TelnyxCommandError) return errorJson(`${fallback} (${error.code})`, error.status === 423 ? 423 : 502, error.code);

  console.error(fallback, error);
  return errorJson(fallback, 500);
}

/** Tolerant JSON body reader: a missing or invalid body is an empty object, never a 500. */
export async function readJsonBody<T extends Record<string, unknown>>(request: Request): Promise<T> {
  const parsed = await request.json().catch(() => null);
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as T;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
