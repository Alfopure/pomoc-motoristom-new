import "server-only";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { mobileEnvironment } from "./auth";

// The iPhone voice device log (LinkaPhone.diag and DispatchPhone's lines, prefixed "js.").
// A new event name or field key is added here too; anything else is dropped.
const NATIVE_EVENTS = ["call.answer", "call.answer_sdk", "call.authorize", "call.end", "call.expect_outgoing", "call.finish", "call.mute", "call.outgoing",
  "call.outgoing_timeout", "call.recovery", "call.reject", "callkit.answer", "callkit.audio", "callkit.end", "callkit.held", "callkit.mute",
  "callkit.outgoing_connected", "callkit.placeholder", "callkit.report_incoming", "callkit.request", "callkit.reset", "callkit.start", "callkit.timeout",
  "callkit.update", "emit", "hold.cancelled", "hold.claim", "hold.detach", "hold.media", "hold.mirror_failed", "hold.mirror_request", "hold.request",
  "hold.resolve", "phone.connect", "phone.connect_error", "phone.disconnect", "phone.start", "push.accepted", "push.cleanup", "push.received", "push.refused",
  "pushkit.token", "pushkit.token_invalidated", "sdk.error", "sdk.invite", "sdk.ready", "sdk.remote_ended", "sdk.socket_disconnected", "sdk.state", "voice.enabled"];
const JS_EVENTS = ["hold.cancelled", "hold.claim", "hold.failure", "hold.ignored", "hold.request", "hold.request_error", "hold.result", "hold.skip",
  "offer.authorize_retry", "offer.authorized", "offer.done", "offer.error", "offer.prepare", "phone.connect_end", "phone.connect_error", "phone.connect_native",
  "phone.connect_start", "phone.disconnect", "phone.disconnect_error", "phone.event", "phone.event_error", "phone.fail", "phone.foreground", "phone.init",
  "phone.inputs", "push.rejected", "session.end"];
export const VOICE_DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set([...NATIVE_EVENTS, ...JS_EVENTS.map(name => "js." + name)]);
export const VOICE_DIAGNOSTIC_KEYS: ReadonlySet<string> = new Set(["action", "action_live", "active", "alert", "answer_pending", "answered", "answering",
  "attempt", "attempts", "authorized", "automatic", "busy", "call", "call_id_valid", "calls", "can_hold", "changed", "claimed", "cleanup", "client", "code",
  "config", "connected", "control", "current", "direction", "early_invites", "enabled", "error", "established", "expected", "finished", "foreground",
  "generic", "had_client", "has_call_id", "has_leg_id", "has_name", "has_number", "has_profile", "has_reason", "has_voice_sdk_id", "held", "holdable",
  "holds", "intent", "invite", "invited", "keys", "known", "leg", "listener", "media", "mirror", "muted", "on_hold", "outbound", "outcome", "outgoing",
  "own_call", "own_invite", "own_request", "path", "payload_keys", "pending", "pending_hold", "phase", "prepared", "profile", "push_registered",
  "push_rejection", "push_token", "pushed", "pushed_leg", "pushes", "pushkit", "ready", "reason", "rebind", "recovering", "registration", "replaced",
  "replay", "reported", "reporter", "requested", "result", "revoke", "role", "same_control", "same_session", "sdk_state", "session", "source", "state",
  "status", "step", "sync_pending", "system_held", "takeover", "termination", "timed_out", "token", "tracked", "type", "user", "valid", "value",
  "version", "was", "was_enabled", "was_ready"]);
export const MAX_VOICE_DIAGNOSTIC_EVENTS = 100;
const VALUE = /^[A-Za-z0-9_.:,-]{1,400}$/;
// A phone number: seven or more digits, each pair split by at most one separator.
const PHONE_LIKE = /\d(?:[._:,-]?\d){6,}/;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export type VoiceDiagnosticEvent = { id: number; at: string; event: string; fields: Record<string, string> };
export type VoiceDiagnosticBatch = { deviceSession: string | null; build: string | null; events: VoiceDiagnosticEvent[]; dropped: number };

/** TEST always; production only when the project sets MOBILE_VOICE_DIAGNOSTICS_ENABLED=true. */
export function voiceDiagnosticsEnabled(env: Record<string, string | undefined> = process.env) {
  return mobileEnvironment() === "test" || env.MOBILE_VOICE_DIAGNOSTICS_ENABLED?.trim() === "true";
}

const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** The app sanitizes first; the server keeps only known names and keys and the same value rules again.
 * A malformed event is dropped, a phone-number-like value is redacted. */
export function readVoiceDiagnostics(value: unknown): VoiceDiagnosticBatch {
  const body = record(value);
  const invalid = () => new MutationError("Neplatná diagnostika telefónu.", 400);
  if (!body || Object.keys(body).some(key => !["deviceSession", "build", "events"].includes(key))) throw invalid();
  const deviceSession = body.deviceSession ?? null, build = body.build ?? null;
  if (deviceSession !== null && !(typeof deviceSession === "string" && UUID.test(deviceSession))
    || build !== null && !(typeof build === "string" && /^[\w.-]{1,20}$/.test(build))
    || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_VOICE_DIAGNOSTIC_EVENTS) throw invalid();
  const events: VoiceDiagnosticEvent[] = [];
  for (const item of body.events) {
    const event = record(item), fields = record(event?.fields ?? {});
    if (!event || !fields || !Number.isSafeInteger(event.id) || (event.id as number) < 0 || !Number.isSafeInteger(event.at) || (event.at as number) < 0
      || (event.at as number) > 8_640_000_000_000_000 || typeof event.event !== "string" || !VOICE_DIAGNOSTIC_EVENTS.has(event.event)) continue;
    const kept: Record<string, string> = {};
    for (const [key, field] of Object.entries(fields).slice(0, 32)) {
      if (!VOICE_DIAGNOSTIC_KEYS.has(key) || typeof field !== "string" || !VALUE.test(field)) continue;
      kept[key] = PHONE_LIKE.test(field) ? "redacted" : field;
    }
    events.push({ id: event.id as number, at: new Date(event.at as number).toISOString(), event: event.event, fields: kept });
  }
  return { deviceSession: typeof deviceSession === "string" ? deviceSession.slice(0, 8).toLowerCase() : null, build: build as string | null, events,
    dropped: body.events.length - events.length };
}

/** One structured runtime log line per batch; nothing is stored in the database. */
export function logVoiceDiagnostics(actor: MotoristActor, batch: VoiceDiagnosticBatch, log: (line: string) => void = console.info) {
  log(JSON.stringify({ scope: "mobile-voice-diag", profile: actor.profileId, deviceSession: batch.deviceSession, build: batch.build,
    events: batch.events, ...(batch.dropped ? { dropped: batch.dropped } : {}) }));
}
