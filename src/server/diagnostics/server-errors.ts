import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { LightNodeClient } from "@sentry/node-core/light";
import { assertAppEnvironment, isTestLiveDeployment, PRODUCTION_SUPABASE_REF, resolveAppEnvironment } from "@/lib/app-environment";
import { diagnosticErrorText } from "@/lib/diagnostics/error-value";
import { isDiagnosticSafeId, isDiagnosticUuid } from "@/lib/diagnostics/types";
import { requestTimingContext } from "@/server/request-metrics";

export const SERVER_SENTRY_LIMITS = { transportMs: 1000, eventWaitMs: 1500, eventsPerMinute: 10, eventBytes: 24 * 1024, frames: 20 } as const;
const classes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "TimeoutError", "UnknownError", "MutationError", "CallActionError", "SessionEventDeferredError", "SessionLeaseLostError", "TelnyxCommandError", "PresenceServiceError", "OperatorDeviceError"]);
const codes = new Set(["ABORT_ERR", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "DIAGNOSTIC_TEST_CANARY", "session_event_deferred", "session_lease_unavailable", "session_checkpoint_failed", "provider_outcome_unknown", "timeout", "network", "deadline", "invalid_response", "recording_ack_invalid", "57014", "53300", "57P01", "08006", "PGRST000", "PGRST001", "PGRST002", "PGRST003", "webhook_processing_failed", "webhook_unresolved"]);
type ServerFrame = { filename: string; abs_path: string; lineno: number; colno: number; in_app: true };
export type ServerErrorContext = { requestId?: string; route?: string; status?: number; source?: "next" | "telephony" | "cron" | "canary"; callSessionId?: string; eventId?: string; commandId?: string; retryable?: boolean; attempt?: number; databaseTimeouts?: number };
export type PrivateServerEvent = {
  type: undefined; event_id: string; timestamp: number; platform: "node"; level: "error"; release: string; environment: "production" | "test";
  exception: { values: Array<{ type: string; value: string; stacktrace?: { frames: ServerFrame[] } }> };
  tags: { diagnostic_error_id: string; runtime: "server"; source: string; request_id?: string; route?: string; http_status?: string; error_code?: string; call_session_id?: string; provider_event_id?: string; command_id?: string; retryable?: string; attempt?: string; database_timeouts?: string };
  contexts?: { failure: { causes: Array<{ type: string; code?: string; status?: number }> } };
};
type ServerConfiguration = { dsn: string; environment: "production" | "test"; release: string };

/** No implicit local/Preview activation, and never point TEST diagnostics at the production project. */
export function serverSentryConfiguration(env: Record<string, string | undefined> = process.env): ServerConfiguration | null {
  try {
    assertAppEnvironment(env);
    const environment = resolveAppEnvironment(env);
    if (env.VERCEL_ENV !== "production") return null;
    if (environment === "test") {
      if (!isTestLiveDeployment(env) || env.SENTRY_PROJECT !== "dispecing-test") return null;
    } else if (environment === "production") {
      if (env.VERCEL_PROJECT_ID !== "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG" || env.VERCEL_GIT_COMMIT_REF !== "main" || env.SENTRY_PROJECT !== "sentry-beige-horizon" ||
          env.APP_BASE_URL !== "https://dispecing.linkapomoci.sk" ||
          ![env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL].includes(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)) return null;
    } else return null;
    const dsn = env.DIAGNOSTICS_SERVER_SENTRY_DSN;
    if (!dsn || dsn !== env.NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN) return null;
    const url = new URL(dsn);
    const expectedProject = environment === "test" ? "4512181071446096" : "4512180793638992";
    if (url.protocol !== "https:" || url.hostname !== "o4512180762640384.ingest.de.sentry.io" ||
        !/^[a-f0-9]{32}$/.test(url.username) || url.password || url.port || url.search || url.hash || url.pathname !== `/${expectedProject}`) return null;
    const release = env.DEPLOYMENT_VERSION || env.VERCEL_GIT_COMMIT_SHA;
    if (!isDiagnosticSafeId(release)) return null;
    return { dsn, environment, release };
  } catch { return null; }
}

function ownValue(value: unknown, key: string): unknown {
  try {
    if (!value || typeof value !== "object") return;
    const result = Object.getOwnPropertyDescriptor(value, key)?.value;
    return result;
  } catch { return; }
}

function ownedFrame(filename: unknown, line: unknown, column: unknown): ServerFrame | null {
  if (typeof filename !== "string" || !Number.isInteger(line) || Number(line) <= 0 || Number(line) > 1_000_000 ||
      !Number.isInteger(column) || Number(column) <= 0 || Number(column) > 10_000_000) return null;
  const relative = filename.startsWith("app:///server/") ? filename.slice(14) : filename.match(/(?:^|\/)\.next\/server\/(.+)$/)?.[1];
  if (!relative || relative.length > 240 || !/^[a-zA-Z0-9_./\[\]()-]+\.js$/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) return null;
  const canonical = `app:///server/${relative}`;
  return { filename: canonical, abs_path: canonical, lineno: Number(line), colno: Number(column), in_app: true };
}

function causalDetails(error: unknown): Array<{ type: string; code?: string; status?: number }> {
  const result: Array<{ type: string; code?: string; status?: number }> = [];
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === "object" && !seen.has(cause) && result.length < 4; cause = ownValue(cause, "cause")) {
    seen.add(cause);
    const name = diagnosticErrorText(cause, "name"), rawCode = ownValue(cause, "code"), status = ownValue(cause, "status");
    const type = classes.has(name) ? name : "UnknownError";
    const code = typeof rawCode === "string" && (codes.has(rawCode) || type === "TelnyxCommandError" && /^[0-9]{3,5}$/.test(rawCode)) ? rawCode : undefined;
    result.push({ type, ...(code ? { code } : {}), ...(Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? { status: Number(status) } : {}) });
  }
  return result;
}

export function sanitizeServerError(error: unknown, context: ServerErrorContext, configuration: Pick<ServerConfiguration, "environment" | "release">, id = randomUUID().replaceAll("-", "")): PrivateServerEvent | null {
  const name = diagnosticErrorText(error, "name");
  const type = classes.has(name) ? name : "UnknownError";
  const frames: ServerFrame[] = [];
  for (const line of diagnosticErrorText(error, "stack").split("\n").slice(0, 41)) {
    const match = line.match(/(?:\(|\s)((?:\/[^\s()]*|app:\/\/\/[^\s()]+)):(\d+):(\d+)\)?$/);
    if (!match) continue;
    const frame = ownedFrame(match[1], Number(match[2]), Number(match[3]));
    if (frame) frames.push(frame);
    if (frames.length >= SERVER_SENTRY_LIMITS.frames) break;
  }
  const rawCode = ownValue(error, "code");
  const code = typeof rawCode === "string" && (codes.has(rawCode) || type === "TelnyxCommandError" && /^[0-9]{3,5}$/.test(rawCode)) ? rawCode : undefined;
  return sanitizeOutboundServerEvent({ event_id: id, timestamp: Date.now() / 1000, platform: "node", level: "error", ...configuration,
    exception: { values: [{ type, value: code ? `${type}: ${code}` : type, ...(frames.length ? { stacktrace: { frames: frames.reverse() } } : {}) }] },
    tags: { diagnostic_error_id: id, runtime: "server", source: context.source ?? "next", request_id: context.requestId,
      route: context.route, http_status: context.status === undefined ? undefined : String(context.status), error_code: code,
      call_session_id: context.callSessionId, provider_event_id: context.eventId, command_id: context.commandId,
      retryable: context.retryable === undefined ? undefined : String(context.retryable), attempt: context.attempt === undefined ? undefined : String(context.attempt),
      database_timeouts: context.databaseTimeouts === undefined ? undefined : String(context.databaseTimeouts) },
    contexts: { failure: { causes: causalDetails(error) } },
  });
}

/** Reconstruct at both SDK and transport boundaries; added SDK scopes cannot expand the schema. */
export function sanitizeOutboundServerEvent(value: unknown): PrivateServerEvent | null {
  try {
    const input = value as PrivateServerEvent;
    const exception = input?.exception?.values?.[0];
    if (!/^[a-f0-9]{32}$/.test(input?.event_id) || !isDiagnosticSafeId(input.release) ||
        !["production", "test"].includes(input.environment) || !exception || !classes.has(exception.type)) return null;
    const code = input.tags?.error_code;
    const errorCode = code && (codes.has(code) || exception.type === "TelnyxCommandError" && /^[0-9]{3,5}$/.test(code)) ? code : undefined;
    const frames = (Array.isArray(exception.stacktrace?.frames) ? exception.stacktrace.frames : []).slice(-SERVER_SENTRY_LIMITS.frames)
      .flatMap(frame => { const safe = ownedFrame(frame?.filename, frame?.lineno, frame?.colno); return safe ? [safe] : []; });
    const tags: PrivateServerEvent["tags"] = { diagnostic_error_id: input.event_id, runtime: "server", source: ["next", "telephony", "cron", "canary"].includes(input.tags?.source) ? input.tags.source : "next" };
    if (isDiagnosticUuid(input.tags?.request_id)) tags.request_id = input.tags.request_id;
    // Framework route templates / fixed operation names, never request paths or query strings.
    if (typeof input.tags?.route === "string" && /^[a-zA-Z0-9_./\[\]()-]{1,160}$/.test(input.tags.route) && !input.tags.route.includes("..")) tags.route = input.tags.route;
    if (/^5[0-9]{2}$/.test(input.tags?.http_status ?? "")) tags.http_status = input.tags.http_status;
    if (errorCode) tags.error_code = errorCode;
    for (const key of ["call_session_id", "provider_event_id", "command_id"] as const) if (isDiagnosticUuid(input.tags?.[key])) tags[key] = input.tags[key];
    if (["true", "false"].includes(input.tags?.retryable ?? "")) tags.retryable = input.tags.retryable;
    for (const key of ["attempt", "database_timeouts"] as const) if (/^(?:0|[1-9][0-9]{0,3})$/.test(input.tags?.[key] ?? "")) tags[key] = input.tags[key];
    const causes = (Array.isArray(input.contexts?.failure?.causes) ? input.contexts.failure.causes : []).slice(0, 4).flatMap(cause => {
      if (!cause || !classes.has(cause.type)) return [];
      const code = typeof cause.code === "string" && (codes.has(cause.code) || cause.type === "TelnyxCommandError" && /^[0-9]{3,5}$/.test(cause.code)) ? cause.code : undefined;
      return [{ type: cause.type, ...(code ? { code } : {}), ...(Number.isInteger(cause.status) && Number(cause.status) >= 400 && Number(cause.status) <= 599 ? { status: cause.status } : {}) }];
    });
    return { type: undefined, event_id: input.event_id, timestamp: Number.isFinite(input.timestamp) && input.timestamp > 0 && input.timestamp <= Date.now() / 1000 + 60 ? input.timestamp : Date.now() / 1000,
      platform: "node", level: "error", release: input.release, environment: input.environment,
      exception: { values: [{ type: exception.type, value: errorCode ? `${exception.type}: ${errorCode}` : exception.type,
        ...(frames.length ? { stacktrace: { frames } } : {}) }] }, tags, ...(causes.length ? { contexts: { failure: { causes } } } : {}) };
  } catch { return null; }
}

type SentryEnvelope = Parameters<ReturnType<typeof import("@sentry/node-core/light")["createTransport"]>["send"]>[0];
/** Check-ins never inherit a global trace, raw request, monitor configuration or SDK metadata. */
export function sanitizeServerEnvelope(envelope: SentryEnvelope): SentryEnvelope {
  const header = envelope[0];
  const safeHeader: Record<string, unknown> = {};
  if (typeof header.event_id === "string" && /^[a-f0-9]{32}$/.test(header.event_id)) safeHeader.event_id = header.event_id;
  const items: Array<[{ type: "event" | "check_in" }, unknown]> = [];
  for (const [itemHeader, payload] of envelope[1]) {
    if (itemHeader.type === "event") {
      const safe = sanitizeOutboundServerEvent(payload);
      if (safe) items.push([{ type: "event" }, safe]);
    } else if (itemHeader.type === "check_in" && payload && typeof payload === "object") {
      const row = payload as Record<string, unknown>;
      if (typeof row.check_in_id !== "string" || !/^[a-f0-9]{32}$/.test(row.check_in_id) || typeof row.monitor_slug !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(row.monitor_slug) || !["in_progress", "ok", "error"].includes(String(row.status)) ||
          !["production", "test"].includes(String(row.environment)) || !isDiagnosticSafeId(row.release)) continue;
      items.push([{ type: "check_in" }, { check_in_id: row.check_in_id, monitor_slug: row.monitor_slug, status: row.status,
        environment: row.environment, release: row.release,
        ...(typeof row.duration === "number" && Number.isFinite(row.duration) && row.duration >= 0 && row.duration <= 600 ? { duration: row.duration } : {}) }]);
    }
  }
  // The SDK types envelopes as a union of homogeneous tuples. Only these two
  // explicitly validated item types leave this boundary; no SDK payload survives.
  return [safeHeader, items] as unknown as SentryEnvelope;
}

let client: { key: string; promise: Promise<LightNodeClient> } | undefined;
export async function getServerSentryClient(): Promise<LightNodeClient | null> {
  const configuration = serverSentryConfiguration();
  if (!configuration) return null;
  const key = JSON.stringify(configuration);
  if (client?.key !== key) {
    const promise = import("@sentry/node-core/light").then(sdk => {
      const result = new sdk.LightNodeClient({ ...configuration, integrations: [], stackParser: () => [],
        sendDefaultPii: false, sendClientReports: false, enableLogs: false, includeServerName: false, maxBreadcrumbs: 0,
        transport: options => {
          const transport = sdk.createTransport({ ...options, bufferSize: 2 }, async request => {
            if (new TextEncoder().encode(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body)).byteLength > SERVER_SENTRY_LIMITS.eventBytes) return { statusCode: 413 };
            const response = await fetch(options.url, { method: "POST", body: request.body as BodyInit, credentials: "omit", redirect: "error",
              headers: { "Content-Type": "application/x-sentry-envelope" }, signal: AbortSignal.timeout(SERVER_SENTRY_LIMITS.transportMs) });
            await response.body?.cancel();
            return { statusCode: response.status, headers: { "retry-after": response.headers.get("retry-after"), "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits") } };
          });
          return { flush: timeout => transport.flush(timeout), send: envelope => {
            const safe = sanitizeServerEnvelope(envelope);
            return safe[1].length ? transport.send(safe) : Promise.resolve({ statusCode: 400 });
          } };
        }, beforeSend: event => sanitizeOutboundServerEvent(event),
      });
      result.init();
      return result;
    });
    client = { key, promise };
    void promise.catch(() => { if (client?.promise === promise) client = undefined; });
  }
  try { return await client.promise; } catch { return null; }
}

let attempts: number[] = [];
const recent = new Map<string, { at: number; id: string }>();
export type ServerErrorReceipt = { eventId: string | null; accepted: boolean };
function reportOutcome(outcome: "disabled" | "invalid" | "deduplicated" | "limited" | "accepted" | "unacknowledged" | "unretained", event?: PrivateServerEvent): void {
  try { console.info(JSON.stringify({ scope: "diagnostics-delivery", transport: "sentry-server", outcome,
    ...(event ? { eventId: event.event_id, release: event.release, requestId: event.tags.request_id, route: event.tags.route, callSessionId: event.tags.call_session_id } : {}) })); } catch { /* no-throw */ }
}
export async function captureServerError(error: unknown, context: ServerErrorContext = {}): Promise<ServerErrorReceipt> {
  const unavailable = { eventId: null, accepted: false };
  try {
    if (process.env.DIAGNOSTICS_SERVER_ERRORS_ENABLED !== "true") return unavailable;
    const configuration = serverSentryConfiguration();
    if (!configuration) { reportOutcome("disabled"); return unavailable; }
    const timing = requestTimingContext();
    const safe = sanitizeServerError(error, { ...context, route: context.route ?? timing?.route, requestId: context.requestId ?? timing?.request_id, databaseTimeouts: context.databaseTimeouts ?? timing?.database_timeouts }, configuration);
    if (!safe) { reportOutcome("invalid"); return unavailable; }
    const now = Date.now();
    attempts = attempts.filter(at => at > now - 60_000);
    const fingerprint = JSON.stringify([safe.release, safe.exception, safe.tags.route, safe.tags.source, safe.tags.call_session_id, safe.tags.command_id, safe.contexts?.failure, safe.tags.database_timeouts]);
    const duplicate = recent.get(fingerprint);
    if (duplicate && duplicate.at > now - 60_000) { reportOutcome("deduplicated", { ...safe, event_id: duplicate.id }); return { eventId: duplicate.id, accepted: false }; }
    if (attempts.length >= SERVER_SENTRY_LIMITS.eventsPerMinute) { reportOutcome("limited", safe); return unavailable; }
    attempts.push(now); recent.set(fingerprint, { at: now, id: safe.event_id });
    while (recent.size > 100) recent.delete(recent.keys().next().value!);
    // The timeout includes a cold SDK import; no detached retry loop is created.
    return await new Promise<ServerErrorReceipt>(resolve => {
      let done = false;
      let unsubscribe = () => {};
      const finish = (accepted: boolean) => { if (done) return; done = true; clearTimeout(timer); unsubscribe();
        // A failed representative must not suppress the next real occurrence.
        if (!accepted && recent.get(fingerprint)?.id === safe.event_id) recent.delete(fingerprint);
        reportOutcome(accepted ? "accepted" : "unacknowledged", safe);
        resolve({ eventId: safe.event_id, accepted }); };
      const timer = setTimeout(() => finish(false), SERVER_SENTRY_LIMITS.eventWaitMs);
      void getServerSentryClient().then(active => {
        if (!active || done) { finish(false); return; }
        unsubscribe = active.on("afterSendEvent", (event, response) => { if (event.event_id === safe.event_id) finish(Boolean(response && response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300)); });
        active.captureEvent(safe);
      }).catch(() => finish(false));
    });
  } catch { return unavailable; }
}

/** Freeze only safe context while the request is active; no SDK import/network in call control. */
export function deferServerError(error: unknown, context: ServerErrorContext = {}): void {
  if (process.env.DIAGNOSTICS_SERVER_ERRORS_ENABLED !== "true") return;
  try {
    const timing = requestTimingContext();
    const requestId = context.requestId ?? timing?.request_id;
    const frozen = { ...context, requestId, route: context.route ?? timing?.route, databaseTimeouts: context.databaseTimeouts ?? timing?.database_timeouts };
    after(async () => { await captureServerError(error, frozen); });
  } catch { reportOutcome("unretained"); /* No request lifecycle: do not launch an unretained task. */ }
}
