import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

/**
 * `auth` is the whole gate; `auth.token` and `auth.profile` are the two halves
 * it is made of.
 *
 * Knowing the gate costs 120 ms does not say which half to attack, and the two
 * are very different things: verifying the token is a network call to GoTrue
 * that local verification could replace, while the profile lookup is a
 * database read that also carries the "is this operator still active" check.
 * Trading the first away is a decision about revoked sessions; trading the
 * second away is a decision about deactivated operators. They should not be
 * decided on one number.
 */
export type RequestStep = "auth" | "auth.token" | "auth.profile" | "db" | "lease" | "provider" | "checkpoint" | "read" | "write"
  | "routing.snapshot" | "routing.configuration" | "routing.eligibility" | "guard.stage";
export type MeasuredRoute = "case.get" | "case.save" | "call.start" | "call.action" | "call.webhook" | "call.active" | "dispatch.refresh" | "fleet.refresh";

type Metric = { count: number; ms: number };
type RequestMetrics = {
  id: string;
  route: MeasuredRoute;
  started: number;
  now: () => number;
  steps: Partial<Record<RequestStep, Metric>>;
  finished: boolean;
  ingressAt: string;
  logger: (entry: Record<string, unknown>) => void;
  dbIssued: number;
  dbFirstMs: number | null;
  dbMaxMs: number | null;
  dbAborts: number;
  connectsAtStart: number;
  eluAtStart: ReturnType<typeof performance.eventLoopUtilization>;
};

const requests = new AsyncLocalStorage<RequestMetrics>();
const databaseHosts = new Set<string>();
let databaseConnects = 0;

// Undici pools sockets across requests. This is an instance-window count,
// deliberately not an attribution to whichever request happened to create it.
channel("undici:client:connected").subscribe((message) => {
  try {
    const host = (message as { connectParams?: { hostname?: string } }).connectParams?.hostname;
    if (host && databaseHosts.has(host)) databaseConnects += 1;
  } catch { /* Diagnostics callbacks must never affect the transport. */ }
});

export function registerDatabaseOrigin(input: RequestInfo | URL): void {
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.startsWith("/rest/v1/") && databaseHosts.size < 16) databaseHosts.add(url.hostname);
  } catch { /* No URLs or credentials enter the log. */ }
}

/** Observe only a transport-owned timeout, and detach when the fetch finishes. */
export function observeDatabaseTimeout(signal: AbortSignal): () => void {
  const scope = requests.getStore();
  const aborted = () => { if (scope && !scope.finished) scope.dbAborts += 1; };
  signal.addEventListener("abort", aborted, { once: true });
  return () => signal.removeEventListener("abort", aborted);
}

export function requestTimingContext(): { request_id: string; ingress_at: string } | null {
  const scope = requests.getStore();
  return scope && !scope.finished ? { request_id: scope.id, ingress_at: scope.ingressAt } : null;
}

function newScope(route: MeasuredRoute, now: () => number, logger: RequestMetrics["logger"], parent?: RequestMetrics): RequestMetrics {
  return { id: parent?.id ?? randomUUID(), ingressAt: parent?.ingressAt ?? new Date().toISOString(), route,
    started: now(), now, logger, steps: {}, finished: false, dbIssued: 0, dbFirstMs: null, dbMaxMs: null, dbAborts: 0,
    connectsAtStart: databaseConnects, eluAtStart: performance.eventLoopUtilization() };
}

function finish(scope: RequestMetrics, detail: Record<string, unknown>): void {
  scope.finished = true;
  const round = (value: number) => Math.round(value * 10) / 10;
  const steps = Object.fromEntries(Object.entries(scope.steps).map(([name, metric]) => [name, { count: metric.count, ms: round(metric.ms) }]));
  try {
    scope.logger({ scope: "request-performance", requestId: scope.id, route: scope.route,
      ms: Math.max(0, round(scope.now() - scope.started)), steps,
      dbFirstMs: scope.dbFirstMs === null ? null : round(scope.dbFirstMs),
      dbMaxMs: scope.dbMaxMs === null ? null : round(scope.dbMaxMs), dbAborts: scope.dbAborts,
      dbConnects: databaseConnects - scope.connectsAtStart, dbConnectsScope: "instance-window",
      instanceEventLoopUtilization: performance.eventLoopUtilization(scope.eluAtStart).utilization, ...detail });
  } catch { /* Telemetry must never change the result of a committed operation. */ }
}

/** Capture at scheduling time; each retained callback receives fresh counters. */
export function withBackgroundRequestMetrics<T>(work: () => Promise<T>): () => Promise<T> {
  const parent = requests.getStore();
  if (!parent) return work;
  return () => {
    const scope = newScope(parent.route, parent.now, parent.logger, parent);
    return requests.run(scope, async () => {
      let outcome = "completed";
      try { return await work(); }
      catch (error) { outcome = "failed"; throw error; }
      finally { finish(scope, { phase: "after", outcome }); }
    });
  };
}

/** Adds an aggregate only: arguments, URLs, query strings and identities never enter this log. */
export function recordRequestStep(name: RequestStep, durationMs: number, firstDatabaseRequest?: boolean): void {
  const scope = requests.getStore();
  if (!scope || scope.finished || !Number.isFinite(durationMs) || durationMs < 0) return;
  const metric = scope.steps[name] ?? { count: 0, ms: 0 };
  metric.count += 1;
  metric.ms += durationMs;
  scope.steps[name] = metric;
  if (name === "db") {
    if (firstDatabaseRequest ?? scope.dbIssued++ === 0) scope.dbFirstMs = durationMs;
    scope.dbMaxMs = Math.max(scope.dbMaxMs ?? 0, durationMs);
  }
}

/**
 * How many requests of a step this handler has issued so far. The number of
 * sequential database round trips before `bridge` reaches the provider is the
 * quantity the latency work is trying to reduce; reading it off a real call in
 * the command audit beats inferring it from a test harness. Parallel requests
 * are counted too, so this is an issue count, not a depth.
 */
export function requestStepCount(name: RequestStep): number | null {
  const scope = requests.getStore();
  if (!scope || scope.finished) return null;
  return scope.steps[name]?.count ?? null;
}

export async function measureRequestStep<T>(name: RequestStep, work: () => PromiseLike<T>): Promise<T> {
  const scope = requests.getStore();
  if (!scope || scope.finished) return work();
  const started = scope.now();
  const first = name === "db" ? scope.dbIssued++ === 0 : undefined;
  try {
    return await work();
  } finally {
    recordRequestStep(name, scope.now() - started, first);
  }
}

/** Measure handler completion, not streaming-body delivery or end-to-end audio. */
export async function withRequestMetrics(
  route: MeasuredRoute,
  handler: () => Promise<Response>,
  options: { logger?: (entry: Record<string, unknown>) => void; now?: () => number } = {},
): Promise<Response> {
  const now = options.now ?? (() => performance.now());
  const scope = newScope(route, now, options.logger ?? ((entry) => console.info(JSON.stringify(entry))));
  return requests.run(scope, async () => {
    let status = 500;
    let responseBytes: number | null = null;
    let timingHeaders = false;
    try {
      const response = await handler();
      status = response.status;
      const length = response.headers.get("content-length");
      if (length !== null && /^\d+$/.test(length)) responseBytes = Number(length);
      const timings = [`total;dur=${Math.max(0, now() - scope.started).toFixed(1)}`,
        ...Object.entries(scope.steps).map(([name, metric]) => `${name};dur=${metric.ms.toFixed(1)}`)];
      try {
        response.headers.set("server-timing", timings.join(", "));
        response.headers.set("x-request-id", scope.id);
        timingHeaders = true;
      } catch { /* Redirects may have immutable headers; preserve the original response. */ }
      return response;
    } finally {
      finish(scope, { phase: "response", status, responseBytes, timingHeaders });
    }
  });
}
