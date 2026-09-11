import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type RequestStep = "auth" | "db" | "lease" | "provider" | "checkpoint" | "read" | "write";
export type MeasuredRoute = "case.get" | "case.save" | "call.start" | "call.action" | "call.webhook" | "call.active" | "dispatch.refresh" | "fleet.refresh";

type Metric = { count: number; ms: number };
type RequestMetrics = {
  id: string;
  route: MeasuredRoute;
  started: number;
  now: () => number;
  steps: Partial<Record<RequestStep, Metric>>;
  finished: boolean;
};

const requests = new AsyncLocalStorage<RequestMetrics>();

/** Adds an aggregate only: arguments, URLs, query strings and identities never enter this log. */
export function recordRequestStep(name: RequestStep, durationMs: number): void {
  const scope = requests.getStore();
  if (!scope || scope.finished || !Number.isFinite(durationMs) || durationMs < 0) return;
  const metric = scope.steps[name] ?? { count: 0, ms: 0 };
  metric.count += 1;
  metric.ms += durationMs;
  scope.steps[name] = metric;
}

export async function measureRequestStep<T>(name: RequestStep, work: () => PromiseLike<T>): Promise<T> {
  const scope = requests.getStore();
  if (!scope || scope.finished) return work();
  const started = scope.now();
  try {
    return await work();
  } finally {
    recordRequestStep(name, scope.now() - started);
  }
}

/** Measure handler completion, not streaming-body delivery or end-to-end audio. */
export async function withRequestMetrics(
  route: MeasuredRoute,
  handler: () => Promise<Response>,
  options: { logger?: (entry: Record<string, unknown>) => void; now?: () => number } = {},
): Promise<Response> {
  const now = options.now ?? (() => performance.now());
  const scope: RequestMetrics = { id: randomUUID(), route, started: now(), now, steps: {}, finished: false };
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
      scope.finished = true;
      const steps = Object.fromEntries(Object.entries(scope.steps).map(([name, metric]) => [name, { count: metric.count, ms: Math.round(metric.ms * 10) / 10 }]));
      // Telemetry must never turn an accepted provider command or committed write into a failure.
      try {
        (options.logger ?? ((entry) => console.info(JSON.stringify(entry))))({
          scope: "request-performance", requestId: scope.id, route, status,
          ms: Math.max(0, Math.round((now() - scope.started) * 10) / 10), steps, responseBytes, timingHeaders,
        });
      } catch { /* The request result remains authoritative when a log sink is unavailable. */ }
    }
  });
}
