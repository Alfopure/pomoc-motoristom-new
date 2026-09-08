import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { canPickUpCall } from "@/lib/telephony/call-pickup";
import { sendCallPush } from "@/server/web-push";
import { presenceAllowsOffer } from "./routing/eligibility";
import { DEFAULT_ROUTING_SETTINGS, isOpenLeg, readMeta, type AttemptRow, type LegRow, type PresenceRow, type SessionRow, type TelephonyEnvironment } from "./state/types";

type AdminClient = SupabaseClient<Database>;
type ProfileRow = Database["public"]["Tables"]["motorist_profiles"]["Row"];
export type CallPushCandidate = {
  organizationId: string;
  recipientProfileId: string;
  sessionId: string;
  category: "incoming_call" | "available_call";
  title: string;
  body: string;
  expiresAt: string;
};
export type CallNotificationDeps = {
  admin: AdminClient;
  organizationId: string;
  environment: TelephonyEnvironment;
  now?: () => Date;
  send?: typeof sendCallPush;
  /** Shared deadline when several sessions are queued by the same request. */
  deadlineAt?: number;
};

const CALL_PUSH_TTL_MS = 30_000;
const PICKUP_PENDING_MS = 30_000; // Same reservation lifetime as appPickup.
const TELEPHONY_ROLES = new Set(["dispatcher", "senior_dispatcher", "manager", "admin"]);
const INCOMING_INTENTS = new Set(["ring", "internal", "transfer", "consult", "party"]);
const RELEVANT_STATES = new Set(["ringing", "waiting", "parked", "consulting", "conference", "talking", "held"]);
const PARALLEL_RECIPIENTS = 5;
const DELIVERY_BUDGET_MS = 15_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function timestamp(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function intentOf(leg: LegRow): string | null {
  const value = record(leg.client_state).intent ?? record(leg.metadata).intent;
  // Recorded blind transfers dial their target before playing its privacy notice.
  if (value === "transfer_recorded" || value === "transfer_safe") return "transfer";
  return typeof value === "string" ? value : null;
}

function planProfileIds(session: SessionRow): string[] {
  const steps = readMeta(session).ring?.plan?.steps;
  if (!Array.isArray(steps)) return [];
  return [...new Set(steps.flatMap((step) => Array.isArray(step.members)
    ? step.members.flatMap((member) => member.kind === "operator" && typeof member.profileId === "string" ? [member.profileId] : [])
    : []))];
}

function isPendingIncoming(leg: LegRow): boolean {
  return Boolean(leg.profile_id && (leg.role === "operator" || leg.role === "consult") && isOpenLeg(leg) && !leg.answered_at &&
    record(leg.client_state).autoAnswer !== true && INCOMING_INTENTS.has(intentOf(leg) ?? ""));
}

function isPickable(session: SessionRow): boolean {
  return canPickUpCall({ state: session.state, direction: session.direction, answered: Boolean(session.answered_at), operatorProfileId: session.answered_by_profile_id });
}

/** Pure audience rule: push wakes the app; it never pretends its SIP device is registered. */
export function callPushCandidates(input: {
  session: SessionRow;
  organizationId: string;
  environment: TelephonyEnvironment;
  legs: LegRow[];
  attempts: AttemptRow[];
  profiles: ProfileRow[];
  presence: PresenceRow[];
  busyProfileIds: ReadonlySet<string>;
  now: Date;
}): CallPushCandidate[] {
  const { session, now } = input;
  const meta = readMeta(session);
  if (session.organization_id !== input.organizationId || meta.environment !== input.environment || session.ended_at || !RELEVANT_STATES.has(session.state)) return [];
  const legs = input.legs.filter((leg) => leg.organization_id === input.organizationId && leg.session_id === session.id && isOpenLeg(leg));
  const hasCaller = legs.some((leg) => session.direction === "internal" ? intentOf(leg) === "internal_caller" : leg.role === "customer");
  if (!hasCaller) return [];

  const available = new Map<string, ProfileRow>();
  for (const profile of input.profiles) {
    if (profile.organization_id !== input.organizationId || !profile.active || profile.access_status === "disabled" || !TELEPHONY_ROLES.has(profile.role) || input.busyProfileIds.has(profile.id)) continue;
    const presence = input.presence.find((row) => row.organization_id === input.organizationId && row.profile_id === profile.id);
    if (presence?.current_session_id && presence.current_session_id !== session.id) continue;
    if (presenceAllowsOffer(presence ? {
      profileId: profile.id, status: presence.status, currentSessionId: presence.current_session_id, wrapUpUntil: presence.wrap_up_until, pauseReturn: presence.pause_return,
    } : undefined, now, session.id).eligible) available.set(profile.id, profile);
  }

  const number = session.caller_number?.trim() || "Neznáme číslo";
  const line = typeof meta.line_label === "string" && meta.line_label.trim() ? ` · ${meta.line_label.trim()}` : "";
  const candidates = new Map<string, CallPushCandidate>();
  for (const leg of legs) {
    if (!isPendingIncoming(leg) || !available.has(leg.profile_id!)) continue;
    // Recording holds the answered event until the target's notice completes.
    // The persisted continuation already proves this leg is no longer ringing.
    const continuation = meta.announcement_sequence?.continuation;
    if (continuation?.kind === "telnyx" && continuation.type === "call.answered" && continuation.callControlId === leg.telnyx_call_control_id) continue;
    const intent = intentOf(leg);
    if (intent === "internal" && (session.state !== "ringing" || meta.internal?.target_profile_id !== leg.profile_id)) continue;
    if (intent === "transfer" && (session.state !== "ringing" || meta.transfer?.target.kind !== "operator" || meta.transfer.target.profileId !== leg.profile_id)) continue;
    if (intent === "consult" && (session.state !== "consulting" || meta.consult?.target.kind !== "operator" || meta.consult.target.profileId !== leg.profile_id)) continue;
    if (intent === "party" && (meta.party_pending?.target.kind !== "operator" || meta.party_pending.target.profileId !== leg.profile_id)) continue;
    // A cancelled ring attempt may retain its leg until the hangup webhook arrives.
    const attempt = input.attempts.find((row) => row.organization_id === input.organizationId && row.session_id === session.id && row.leg_id === leg.id && row.profile_id === leg.profile_id && row.result === "offered" && !row.ended_at);
    if (intent === "ring" && (!attempt || session.state !== "ringing" || session.answered_by_profile_id)) continue;
    const initiated = timestamp(leg.initiated_at);
    if (initiated === null) continue;
    const deadline = intent === "ring"
      ? Math.min(timestamp(meta.ring?.step_deadline_at) ?? Infinity, (timestamp(attempt?.offered_at) ?? initiated) + (attempt?.ring_secs ?? 30) * 1_000)
      : initiated + CALL_PUSH_TTL_MS;
    const expires = Math.min(now.getTime() + CALL_PUSH_TTL_MS, deadline);
    if (expires <= now.getTime()) continue;
    candidates.set(leg.profile_id!, {
      organizationId: input.organizationId, sessionId: session.id, recipientProfileId: leg.profile_id!, category: "incoming_call",
      title: "Prichádzajúci hovor", body: `${number}${line} · Otvorte aplikáciu a prijmite hovor.`, expiresAt: new Date(expires).toISOString(),
    });
  }

  if (!isPickable(session)) return [...candidates.values()];
  if (session.answered_by_profile_id || (meta.pickup && (timestamp(meta.pickup.at) ?? now.getTime()) + PICKUP_PENDING_MS > now.getTime())) return [...candidates.values()];
  // The old ring plan continues while pickup connects, including external backup.
  // Its persisted deadline bounds how long the newly available alert is useful.
  let pickupDeadline: number;
  if (session.state === "ringing") {
    const ringDeadline = timestamp(meta.ring?.step_deadline_at);
    if (ringDeadline === null) return [...candidates.values()];
    pickupDeadline = ringDeadline;
  } else {
    const since = timestamp(session.parked_at ?? meta.waiting?.since);
    if (since === null) return [...candidates.values()];
    const maxMinutes = meta.waiting?.max_minutes;
    pickupDeadline = since + (typeof maxMinutes === "number" && Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes : DEFAULT_ROUTING_SETTINGS.parkMaxMinutes) * 60_000;
  }
  const expires = Math.min(now.getTime() + CALL_PUSH_TTL_MS, pickupDeadline);
  if (expires <= now.getTime()) return [...candidates.values()];
  // No device heartbeat filter: an available operator's closed PWA can receive
  // push, then register its browser phone before the existing pickup action.
  for (const profileId of planProfileIds(session)) {
    if (!available.has(profileId) || candidates.has(profileId)) continue;
    if (input.presence.some((row) => row.organization_id === input.organizationId && row.profile_id === profileId && row.status === "ringing")) continue;
    // An existing own media leg is not another opportunity to pick the call up.
    if (legs.some((leg) => leg.profile_id === profileId)) continue;
    // A browser is already trying to pick this call up; don't summon more people.
    if (legs.some((leg) => leg.role !== "customer" && intentOf(leg) === "pickup")) continue;
    candidates.set(profileId, {
      organizationId: input.organizationId, sessionId: session.id, recipientProfileId: profileId, category: "available_call",
      title: "Hovor čaká na prevzatie", body: `${number}${line} · Otvorte aplikáciu a prevezmite hovor.`, expiresAt: new Date(expires).toISOString(),
    });
  }
  return [...candidates.values()];
}

/** Only persisted current rows determine who receives private call information. */
export async function loadCallPushCandidates(deps: CallNotificationDeps, sessionId: string): Promise<CallPushCandidate[]> {
  const { admin, organizationId } = deps;
  const sessionResult = await admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).eq("id", sessionId).maybeSingle();
  if (sessionResult.error) throw new Error("Call push session unavailable");
  const session = sessionResult.data;
  if (!session || readMeta(session).environment !== deps.environment || session.ended_at || !RELEVANT_STATES.has(session.state)) return [];
  const [legsResult, attemptsResult] = await Promise.all([
    admin.from("motorist_call_legs").select("*").eq("organization_id", organizationId).eq("session_id", sessionId).is("ended_at", null),
    admin.from("motorist_ring_attempts").select("*").eq("organization_id", organizationId).eq("session_id", sessionId).eq("result", "offered"),
  ]);
  if (legsResult.error || attemptsResult.error) throw new Error("Call push routing unavailable");
  const legs = legsResult.data ?? [];
  const profileIds = [...new Set([
    ...legs.filter(isPendingIncoming).map((leg) => leg.profile_id!),
    ...(isPickable(session) ? planProfileIds(session) : []),
  ])];
  if (!profileIds.length) return [];
  const [profiles, presence, otherOffers, otherLegs] = await Promise.all([
    admin.from("motorist_profiles").select("*").eq("organization_id", organizationId).in("id", profileIds).eq("active", true),
    admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId).in("profile_id", profileIds),
    admin.from("motorist_ring_attempts").select("profile_id").eq("organization_id", organizationId).in("profile_id", profileIds).neq("session_id", sessionId).eq("result", "offered").is("ended_at", null),
    admin.from("motorist_call_legs").select("*").eq("organization_id", organizationId).in("profile_id", profileIds).neq("session_id", sessionId).is("ended_at", null),
  ]);
  if (profiles.error || presence.error || otherOffers.error || otherLegs.error) throw new Error("Call push audience unavailable");
  const busyProfileIds = new Set([
    ...(otherOffers.data ?? []).flatMap((row) => row.profile_id ? [row.profile_id] : []),
    ...(otherLegs.data ?? []).filter(isOpenLeg).flatMap((row) => row.profile_id ? [row.profile_id] : []),
  ]);
  return callPushCandidates({ session, organizationId, environment: deps.environment, legs, attempts: attemptsResult.data ?? [], profiles: profiles.data ?? [], presence: presence.data ?? [], busyProfileIds, now: (deps.now ?? (() => new Date()))() });
}

/** Scheduled after the request; bounded batches recheck routing before delivery. */
export async function notifyCallState(deps: CallNotificationDeps, sessionId: string): Promise<{ sent: number; failed: number }> {
  const started = Date.now();
  const deadline = Math.min(started + DELIVERY_BUDGET_MS, deps.deadlineAt ?? Infinity);
  const totals = { sent: 0, failed: 0 };
  const initial = await loadCallPushCandidates(deps, sessionId);
  for (let offset = 0; offset < initial.length && Date.now() < deadline; offset += PARALLEL_RECIPIENTS) {
    const fresh = await loadCallPushCandidates(deps, sessionId);
    if (Date.now() >= deadline) break;
    const results = await Promise.all(initial.slice(offset, offset + PARALLEL_RECIPIENTS).map(async (candidate) => {
      const current = fresh.find((row) => row.recipientProfileId === candidate.recipientProfileId && row.category === candidate.category);
      if (!current || Date.now() >= deadline) return { sent: 0, failed: 0 };
      // A job that starts late in the request inherits the remaining lifetime,
      // including the push provider timeout, instead of starting another budget.
      const expiresAt = new Date(Math.min(Date.parse(current.expiresAt), deadline)).toISOString();
      try { return await (deps.send ?? sendCallPush)(deps.admin, { ...current, expiresAt }); }
      catch { return { sent: 0, failed: 1 }; }
    }));
    for (const result of results) { totals.sent += result.sent; totals.failed += result.failed; }
  }
  return totals;
}
