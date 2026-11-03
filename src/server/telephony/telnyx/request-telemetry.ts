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
  return /^TelnyxCommandError: Telnyx (\d{5}|timeout|network|http_[1-5]\d{2}|cloudflare_1010) \([1-5]\d{2}\)(?::|$)/.exec(error)?.[1] ?? "provider_error";
}

function duration(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function status(value: number | null): number | null {
  return Number.isInteger(value) && value! >= 100 && value! <= 599 ? value : null;
}

export function createTelnyxRequestLogger(logger: (entry: Record<string, unknown>) => unknown): (entry: TelnyxRequestLog) => void {
  return (entry) => {
    try {
      const code = errorCode(entry.error);
      // A Cloudflare 1010 is a deployment configuration error (S5), not a provider hiccup.
      const safe = { scope: "telnyx-http", level: code === "cloudflare_1010" ? "error" : code ? "warn" : "info",
        method: METHODS.has(entry.method) ? entry.method : "OTHER", path: resourcePath(entry.path),
        // S5: compare `.com` and `.eu` headersMs per command on TEST.
        region: entry.region === "eu" ? "eu" : "us",
        commandId: isUuid(entry.commandId) ? entry.commandId : null,
        ms: duration(entry.ms), status: status(entry.status),
        retried: entry.retried === true, errorCode: code,
        cached: entry.cached === true,
        attempts: (entry.attempts ?? []).slice(0, 2).map((attempt) => ({
          startedAtMs: Number.isSafeInteger(attempt.startedAtMs) && attempt.startedAtMs > 0 ? attempt.startedAtMs : null,
          dispatchAfterMs: duration(attempt.dispatchAfterMs), headersMs: duration(attempt.headersMs),
          ms: duration(attempt.ms), status: status(attempt.status),
          // S4 stop criterion: a reset or timeout on a kept-alive socket, beside the journal's `unknown`.
          ...(attempt.reusedSocketReset === true ? { reusedSocketReset: true } : {}),
          ...(attempt.reusedSocketTimeout === true ? { reusedSocketTimeout: true } : {}),
        })) };
      // Logging is outside the call's success contract, including injected
      // asynchronous loggers that reject after the provider response returns.
      void Promise.resolve(logger(safe)).catch(() => undefined);
    } catch {
      // A broken log sink must never turn an accepted provider command into a retry.
    }
  };
}
