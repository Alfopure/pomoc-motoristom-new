import "server-only";
import { after } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TELEPHONY_NOT_CONFIGURED_CODE, TELEPHONY_NOT_CONFIGURED_MESSAGE, TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";
import type { MotoristActor } from "@/server/api-auth";
import { resolveDefaultOrganizationId } from "@/server/default-organization";
import { MutationError } from "@/server/mutation-error";

import type { CallActionDeps, CallActor } from "./call-actions";
import { CallActionError, OperatorDeviceError, PresenceServiceError } from "./service-errors";
import type { TelephonyEnvironment } from "./state/types";
import { createTelnyxClient, resolveTelnyxLiveGate, TelnyxCommandError, type TelnyxClient } from "./telnyx/client";
import { getTelnyxConfig, type EnvRecord, type TelnyxConfig } from "./telnyx/env";
import { createTelnyxRequestLogger } from "./telnyx/request-telemetry";
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
const CALL_PUSH_SESSION_CONCURRENCY = 3;
const CALL_PUSH_QUEUE_BUDGET_MS = 15_000;

/** `production` only on the Vercel production deployment; preview/dev share the dev credential connection. */
export function telephonyEnvironment(env: EnvRecord = process.env): TelephonyEnvironment {
  return env.VERCEL_ENV?.trim() === "production" ? "production" : "development";
}

export function isProductionDeployment(env: EnvRecord = process.env): boolean {
  return env.VERCEL_ENV?.trim() === "production";
}

export type CreateTelephonyDepsOptions = {
  deviceKind?: "web" | "mobile";
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
  const pendingCallNotifications = new Set<string>();
  let callNotificationsScheduled = false;

  let telnyx: TelnyxClient | null = null;
  if (config.configured) {
    const { data } = await admin
      .from("motorist_telephony_settings")
      .select("live_calls_enabled, sms_live_sends")
      .eq("organization_id", organizationId)
      .maybeSingle();
    telnyx = createTelnyxClient({ config, liveGate: resolveTelnyxLiveGate(config, data ?? null),
      onRequest: createTelnyxRequestLogger(options.logger ?? telephonyLogger) });
  }

  return {
    admin,
    telnyx,
    config,
    organizationId,
    environment,
    deviceKind: options.deviceKind,
    sweepAfterEvent: options.sweepAfterEvent,
    logger: options.logger ?? telephonyLogger,
    onCallTransition: (sessionId) => {
      pendingCallNotifications.add(sessionId);
      if (callNotificationsScheduled) return;
      callNotificationsScheduled = true;
      // Web Push runs after Telnyx has its response and every session lease has
      // been released. One queue also bounds a cron/sweep backlog across calls.
      try {
        after(async () => {
          const logger = options.logger ?? telephonyLogger;
          const sessions = [...pendingCallNotifications];
          const deadlineAt = Date.now() + CALL_PUSH_QUEUE_BUDGET_MS;
          let cursor = 0;
          try {
            const { notifyCallState } = await import("./call-notifications");
            const worker = async () => {
              while (cursor < sessions.length && Date.now() < deadlineAt) {
                const queuedSessionId = sessions[cursor++];
                try {
                  const result = await notifyCallState({ admin, organizationId, environment, deadlineAt }, queuedSessionId);
                  if (result.failed) logger({ level: "warn", scope: "call-push", sessionId: queuedSessionId, message: "notification delivery incomplete", failed: result.failed });
                } catch {
                  logger({ level: "warn", scope: "call-push", sessionId: queuedSessionId, message: "notification delivery unavailable" });
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(CALL_PUSH_SESSION_CONCURRENCY, sessions.length) }, worker));
          } catch {
            logger({ level: "warn", scope: "call-push", message: "notification delivery unavailable" });
          }
          // No claim has been made for skipped sessions: their next ordinary
          // webhook/poll sweep can retry them without losing a notification.
          if (cursor < sessions.length) logger({ level: "warn", scope: "call-push", message: "notification queue budget reached", skipped: sessions.length - cursor });
        });
      } catch {
        callNotificationsScheduled = false;
        (options.logger ?? telephonyLogger)({ level: "warn", scope: "call-push", sessionId, message: "notification scheduling unavailable" });
      }
    },
  };
}

export const TELEPHONY_ROUTE_ROLES: CallActor["role"][] = ["dispatcher", "senior_dispatcher", "manager", "admin"];

/** The session actor in the shape the call-action services expect. */
export function toCallActor(actor: MotoristActor): CallActor {
  return { profileId: actor.profileId, role: actor.role, displayName: actor.displayName };
}

export function notConfiguredResponse(): Response {
  return Response.json({ error: TELEPHONY_NOT_CONFIGURED_MESSAGE, code: TELEPHONY_NOT_CONFIGURED_CODE }, { status: 503 });
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
  if (error instanceof TelephonyNotConfiguredError) return notConfiguredResponse();
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
