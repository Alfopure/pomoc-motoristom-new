import { isUuid } from "@/lib/telephony/uuid";
import type { TelnyxRequestLog } from "./client";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const RESOURCES = new Set(["calls", "conferences", "phone_numbers", "telephony_credentials", "messages"]);
const CALL_ACTIONS = new Set(["answer", "hangup", "bridge", "transfer", "gather", "gather_stop", "gather_using_audio", "gather_using_speak",
  "playback_start", "playback_stop", "speak", "record_start", "record_stop", "send_dtmf", "switch_supervisor_role"]);
const CONFERENCE_ACTIONS = new Set(["join", "leave", "update", "hold", "unhold", "mute", "unmute", "play", "stop", "speak", "send_dtmf", "gather_using_audio", "end"]);

function resourcePath(path: string): string {
  const segments = path.split(/[?#]/, 1)[0].split("/");
  const [, resource, , kind, action] = segments;
  if (segments[0] !== "" || !RESOURCES.has(resource)) return "/other";
  if (segments.length === 2) return `/${resource}`;
  if (segments.length === 3) return `/${resource}/:id`;
  if (segments.length === 4 && (resource === "conferences" && kind === "participants" || resource === "telephony_credentials" && kind === "token")) {
    return `/${resource}/:id/${kind}`;
  }
  if (segments.length === 5 && kind === "actions" && (resource === "calls" || resource === "conferences")) {
    const known = (resource === "calls" ? CALL_ACTIONS : CONFERENCE_ACTIONS).has(action);
    return `/${resource}/:id/actions/${known ? action : ":action"}`;
  }
  return "/other";
}

/** Only the client's generated error prefix is inspected; provider prose is never logged. */
function errorCode(error: string | null): string | null {
  if (!error) return null;
  return /^TelnyxCommandError: Telnyx (\d{5}|timeout|network|http_[1-5]\d{2}) \([1-5]\d{2}\)(?::|$)/.exec(error)?.[1] ?? "provider_error";
}

export function createTelnyxRequestLogger(logger: (entry: Record<string, unknown>) => unknown): (entry: TelnyxRequestLog) => void {
  return (entry) => {
    try {
      const code = errorCode(entry.error);
      const safe = { scope: "telnyx-http", level: code ? "warn" : "info",
        method: METHODS.has(entry.method) ? entry.method : "OTHER", path: resourcePath(entry.path),
        commandId: isUuid(entry.commandId) ? entry.commandId : null,
        ms: Number.isFinite(entry.ms) ? Math.max(0, Math.round(entry.ms)) : null,
        status: Number.isInteger(entry.status) && entry.status! >= 100 && entry.status! <= 599 ? entry.status : null,
        retried: entry.retried === true, errorCode: code };
      // Logging is outside the call's success contract, including injected
      // asynchronous loggers that reject after the provider response returns.
      void Promise.resolve(logger(safe)).catch(() => undefined);
    } catch {
      // A broken log sink must never turn an accepted provider command into a retry.
    }
  };
}
