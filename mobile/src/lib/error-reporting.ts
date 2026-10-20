import { Platform } from "react-native";
import type { MobileConfig } from "./config";
import type { MobileTransport } from "./api";
import { appVersion } from "./app-version";

export type ErrorKind = "fatal" | "error" | "render";
export type ErrorReporter = (kind: ErrorKind, error: unknown, component?: string | null) => void;

/** Sends a short report of an app error for the signed-in operator; the server masks
 * numbers and e-mail addresses and keeps only a log line. Reporting never throws. */
export function createErrorReporter(config: MobileConfig, getToken: () => Promise<string | null>, transport: MobileTransport = fetch): ErrorReporter {
  let sent = 0, windowStart = 0;
  return (kind, error, component) => {
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; sent = 0; }
    if (++sent > 5) return;
    const version = appVersion();
    const message = error instanceof Error ? error.name + ": " + error.message : typeof error === "string" ? error : "Neznáma chyba";
    const body = { kind, message: message.slice(0, 1000), stack: error instanceof Error && error.stack ? error.stack.slice(0, 8000) : null,
      component: component ? component.slice(0, 4000) : null, version: version.version, build: version.build,
      platform: Platform.OS === "android" ? "android" : "ios", osVersion: String(Platform.Version).slice(0, 40), preview: version.preview };
    void (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        await transport(config.apiOrigin + "/api/mobile/v1/diagnostics/errors", { method: "POST", credentials: "omit",
          headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch { /* A report is best effort; the app keeps working. */ }
    })();
  };
}

/** Reports uncaught JavaScript errors, then lets React Native handle them as before.
 * Outside React Native (tests, the browser preview) there is no global handler to wrap. */
export function installGlobalErrorReporting(report: ErrorReporter): () => void {
  const utils = (globalThis as { ErrorUtils?: typeof ErrorUtils }).ErrorUtils;
  if (!utils) return () => undefined;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    report(isFatal ? "fatal" : "error", error);
    previous(error, isFatal);
  });
  return () => utils.setGlobalHandler(previous);
}
