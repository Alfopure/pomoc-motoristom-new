import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { maskDiagnostic } from "../../../src/lib/diagnostic-mask";
import type { MobileConfig } from "./config";
import type { MobileTransport } from "./api";
import { appVersion } from "./app-version";

export type ErrorKind = "fatal" | "error" | "render";
type Report = { kind: ErrorKind; message: string; stack: string | null; component: string | null; version: string; build: string | null; platform: "ios" | "android"; osVersion: string; preview: boolean };
export type ErrorReporter = {
  report: (kind: ErrorKind, error: unknown, component?: string | null) => void;
  /** Keeps a fatal error on the device, since the app stops before any request leaves. */
  keep: (error: unknown) => void;
  /** The signed-in user a kept crash belongs to; null while nobody is signed in. */
  setUser: (userId: string | null) => void;
  /** Sends a kept fatal error once its own user is signed in again. */
  flushKept: () => Promise<void>;
};
const KEPT = "pm-kept-error-v1", KEPT_DAYS = 7;
type Kept = { userId: string | null; keptAt: number; report: Report };

/** Synchronous, for the moment the app stops; usable before any reporter exists. */
export function keepError(error: unknown, userId: string | null) {
  try {
    const report = describe("fatal", error);
    // The keychain item stays small: the start of the stack is enough to find the place.
    const kept: Kept = { userId, keptAt: Date.now(), report: { ...report, stack: report.stack?.slice(0, 1200) ?? null } };
    SecureStore.setItem?.(KEPT, JSON.stringify(kept), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  } catch { /* Nothing more can be done while the app stops. */ }
}

/** A short, masked report: numbers, e-mails, plates and VINs never leave the phone. */
function describe(kind: ErrorKind, error: unknown, component?: string | null): Report {
  const version = appVersion();
  const message = error instanceof Error ? error.name + ": " + error.message : typeof error === "string" ? error : "Neznáma chyba";
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : null;
  return { kind, message: maskDiagnostic(message).slice(0, 1000), stack: stack ? maskDiagnostic(stack).slice(0, 8000) : null,
    component: component ? maskDiagnostic(component).slice(0, 4000) : null, version: version.version, build: version.build,
    platform: Platform.OS === "android" ? "android" : "ios", osVersion: String(Platform.Version).slice(0, 40), preview: version.preview };
}

/** Reports app errors of the signed-in operator to the dispatch server, which keeps only
 * a log line. Reporting never throws and never blocks the app. */
export function createErrorReporter(config: MobileConfig, getToken: () => Promise<string | null>, transport: MobileTransport = fetch): ErrorReporter {
  let sent = 0, windowStart = 0, user: string | null = null;
  /** The response status; 0 when nothing could be sent. */
  async function send(body: Report): Promise<number> {
    try {
      const token = await getToken();
      if (!token) return 0;
      const response = await transport(config.apiOrigin + "/api/mobile/v1/diagnostics/errors", { method: "POST", credentials: "omit",
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return response.status;
    } catch { return 0; }
  }
  return {
    report: (kind, error, component) => {
      const now = Date.now();
      if (now - windowStart > 60_000) { windowStart = now; sent = 0; }
      if (++sent > 5) return;
      try { void send(describe(kind, error, component)); } catch { /* A report is best effort. */ }
    },
    keep: error => keepError(error, user),
    setUser: userId => { user = userId; },
    flushKept: async () => {
      if (!user) return;
      let raw: string | null = null;
      try { raw = SecureStore.getItem?.(KEPT) ?? null; } catch { raw = null; }
      if (!raw) return;
      let kept: Kept | null = null;
      try { kept = JSON.parse(raw) as Kept; } catch { kept = null; }
      const drop = () => SecureStore.deleteItemAsync(KEPT).catch(() => undefined);
      // Another account's crash, an old one or an unreadable one is not sent.
      if (!kept?.report || typeof kept.keptAt !== "number" || Date.now() - kept.keptAt > KEPT_DAYS * 86_400_000 || kept.userId && kept.userId !== user) { await drop(); return; }
      const status = await send(kept.report);
      // Sent, or refused for good; a missing token, a limit or a server failure tries again later.
      if (status >= 200 && status < 300 || status >= 400 && status < 500 && status !== 401 && status !== 429) await drop();
    },
  };
}

/** Reports uncaught JavaScript errors, then lets React Native handle them as before.
 * Outside React Native (tests, the browser preview) there is no global handler to wrap. */
export function installGlobalErrorReporting(reporter: ErrorReporter): () => void {
  const utils = (globalThis as { ErrorUtils?: typeof ErrorUtils }).ErrorUtils;
  if (!utils) return () => undefined;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    try {
      if (isFatal) reporter.keep(error);
      else reporter.report("error", error);
    } catch { /* Reporting must never hide the original error. */ }
    finally { previous(error, isFatal); }
  });
  return () => utils.setGlobalHandler(previous);
}
