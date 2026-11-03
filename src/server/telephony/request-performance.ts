import "server-only";
import { resolveAppEnvironment } from "@/lib/app-environment";
import { readRequestPerformance } from "@/lib/telephony/request-performance";
import { getAppVersion } from "@/server/app-version";

/** Called after the route's existing authentication. No queries, writes or provider calls. */
export function logRequestPerformance(value: unknown, dropped: unknown, logger = (entry: Record<string, unknown>) => console.info(JSON.stringify(entry))): { performanceIds: string[]; performanceDropped: number } {
  const performanceIds: string[] = [];
  let performanceDropped = 0;
  try {
    const context = { schemaVersion: 2, source: "browser", environment: resolveAppEnvironment(), serverBuild: getAppVersion(),
      timestamp: new Date().toISOString(), sampleRate: 1 };
    for (const row of readRequestPerformance(value)) {
      logger({ scope: "call-request-performance", ...context, ...row, measurement: "request_roundtrip" });
      performanceIds.push(row.id);
    }
    if (typeof dropped === "number" && Number.isInteger(dropped) && dropped > 0 && dropped <= 10_000) {
      logger({ scope: "call-performance-coverage", ...context, dropped });
      performanceDropped = dropped;
    }
  } catch { /* Logging is best effort; acknowledge only emitted observations. */ }
  return { performanceIds, performanceDropped };
}
