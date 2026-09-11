import { readPauseReturn } from "@/lib/telephony/presence-policy";
import { telephonyStabilityEnabled } from "./stability";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CallerMatch } from "@/data/dispatch-types";
import type { Database } from "@/lib/supabase/database.types";
import type { TelephonyPresenceSnapshot } from "@/lib/telephony/presence";
import { AUDIO_CONNECTION_WARNING_MS, type AudioConnectionView } from "@/lib/telephony/audio-connection";

import { deviceIsLive } from "./operator-devices";
import { effectivePresenceStatus, effectivePresenceSince } from "./presence-service";
import { ACTIVE_SESSION_STATES, isOpenLeg, readMeta, WAITING_STATES, type AttemptRow, type DeviceRow, type LegRow, type LineRow, type PresenceRow, type SessionRow } from "./state/types";
import type { TelephonyEnvironment } from "./state/types";

/**
 * Snapshot behind `GET /api/telephony/calls/active` (design §2.4).
 *
 * The console polls this endpoint (1 s engaged / 5 s idle), so it must be one
 * flat round trip: active sessions, their open legs, the open ring offers,
 * operator presence and browser-phone devices — no provider call, no joins
 * (PostgREST embeds are avoided so the fake-Supabase harness can drive the
 * same code path).
 */

type AdminClient = SupabaseClient<Database>;

export type ActiveCallLegView = {
  id: string;
  /** Browser correlation for the polling actor's operator/consult legs only. */
  callControlId?: string | null;
  role: LegRow["role"];
  profileId: string | null;
  state: LegRow["state"];
  toNumber: string | null;
  fromNumber: string | null;
  answeredAt: string | null;
  bridgedAt: string | null;
  /** `client_state.intent` (`party` marks a third party added to the conference). */
  intent: string | null;
  /** Conference mute flag written by the mute/unmute action. */
  muted: boolean;
  /** Telnyx `supervisor_role` of a supervisor leg (`monitor` / `whisper` / `barge`). */
  supervisorMode: string | null;
};

function legIntentOf(leg: LegRow): string | null {
  const state = leg.client_state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const intent = (state as Record<string, unknown>).intent;
  return typeof intent === "string" ? intent : null;
}

function legMetaOf(leg: LegRow): Record<string, unknown> {
  return leg.metadata && typeof leg.metadata === "object" && !Array.isArray(leg.metadata) ? (leg.metadata as Record<string, unknown>) : {};
}

export type ActiveCallView = {
  sessionId: string;
  /** `motorist_calls.id` of the log row, once one exists (link-case / outcome). */
  callId: string | null;
  state: SessionRow["state"];
  direction: SessionRow["direction"];
  callerNumber: string | null;
  calledNumber: string | null;
  lineId: string | null;
  lineLabel: string | null;
  partnerName: string | null;
  caseId: string | null;
  match: { top: CallerMatch | null; count: number; degraded: boolean } | null;
  startedAt: string;
  answeredAt: string | null;
  answeredByProfileId: string | null;
  audioConnection?: AudioConnectionView | null;
  holdStartedAt: string | null;
  parkedAt: string | null;
  /** Operator who put the caller in the waiting room (`meta.park.by`). */
  parkedByProfileId: string | null;
  waitingSince: string | null;
  /** Why the caller is waiting: `parked`, `transfer_timeout`, a ring fallback… */
  waitingReason: string | null;
  /** `park_max_minutes` frozen when the caller entered the waiting room. */
  waitingMaxMinutes: number | null;
  currentStep: number;
  ringMode: string | null;
  /** Operators with an open offer for this session (ringing right now). */
  offeredProfileIds: string[];
  legs: ActiveCallLegView[];
  /** True when the polling operator owns or is being offered this call. */
  mine: boolean;
};

export type ActiveCallsSnapshot = {
  checkedAt: string;
  configured: boolean;
  pausedPickupEnabled?: boolean;
  /** Topic key for the Realtime channel the console subscribes to (design §2.4). */
  organizationId: string;
  actorProfileId: string;
  calls: ActiveCallView[];
  waiting: ActiveCallView[];
  presence: TelephonyPresenceSnapshot;
  /** Private scheduling inputs for the polling operator's own timed pause. */
  ownPresence: {
    automaticOffersAllowed?: boolean;
    presenceRevision?: number;
    status: PresenceRow["status"];
    pauseReasonId: string | null;
    statusSince: string;
  } | null;
};

export type ActiveCallsDeps = {
  admin: AdminClient;
  organizationId: string;
  environment: TelephonyEnvironment;
  configured: boolean;
  now?: () => Date;
};

const ACTIVE_STATES = [...ACTIVE_SESSION_STATES];

/** A SIP answer/recorder START does not prove the customer and operator joined. */
function audioConnectionView(session: SessionRow, legs: LegRow[], now: Date): AudioConnectionView | null {
  if (!["talking", "conference"].includes(session.state) || session.ended_at) return null;
  const recording = readMeta(session).recording;
  const pending = recording?.pendingAudio;
  if (pending?.commands.length) {
    const startedAt = pending.startedAt ?? pending.readyAt;
    const expired = now.getTime() - Date.parse(startedAt) >= AUDIO_CONNECTION_WARNING_MS;
    return { status: expired ? "failed" : "connecting", startedAt, confirmedAt: null,
      error: expired ? "connection_confirmation_timeout" : null };
  }
  const connection = recording?.connection;
  // A silent outgoing call may bridge directly without recorder metadata.
  // Customer answer changes the session to talking before that bridge finishes;
  // require both current legs' provider confirmations before claiming audio.
  if (!connection && session.direction === "outbound" && session.state === "talking") {
    const customer = legs.find(leg => leg.role === "customer" && isOpenLeg(leg) && leg.answered_at);
    const operator = legs.find(leg => leg.role === "operator" && leg.profile_id === session.answered_by_profile_id && isOpenLeg(leg) && leg.answered_at);
    const confirmedAt = customer?.bridged_at && operator?.bridged_at
      ? (Date.parse(customer.bridged_at) > Date.parse(operator.bridged_at) ? customer.bridged_at : operator.bridged_at)
      : null;
    const startedAt = session.answered_at ?? session.started_at;
    const expired = now.getTime() - Date.parse(startedAt) >= AUDIO_CONNECTION_WARNING_MS;
    return { status: confirmedAt ? "connected" : expired ? "failed" : "connecting", startedAt, confirmedAt,
      error: !confirmedAt && expired ? "connection_confirmation_timeout" : null };
  }
  if (!connection || connection.operatorProfileId !== session.answered_by_profile_id ||
    !connection.callControlIds.every((id) => legs.some((leg) => leg.telnyx_call_control_id === id && isOpenLeg(leg) && leg.answered_at))) return null;
  if (!connection.confirmedAt) return { status: "failed", startedAt: connection.startedAt, confirmedAt: null, error: "connection_interrupted" };
  if (connection.epoch !== recording?.epoch || connection.conferenceId !== session.conference_id) return null;
  return { status: "connected", startedAt: connection.startedAt, confirmedAt: connection.confirmedAt, error: null };
}

export async function loadActiveCalls(
  deps: ActiveCallsDeps,
  actor: { profileId: string; canManageAssignments: boolean },
): Promise<ActiveCallsSnapshot> {
  const now = (deps.now ?? (() => new Date()))();
  const { admin, organizationId } = deps;

  const [sessionsResult, presenceResult, devicesResult, linesResult, operatorSettingsResult] = await Promise.all([
    admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).in("state", ACTIVE_STATES).order("started_at", { ascending: true }),
    admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId),
    admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId).eq("environment", deps.environment),
    admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId),
    admin.from("motorist_operator_telephony_settings").select("*").eq("organization_id", organizationId),
  ]);
  if (sessionsResult.error) throw new Error(`active sessions load failed: ${sessionsResult.error.message}`);
  if (presenceResult.error) throw new Error(`presence load failed: ${presenceResult.error.message}`);
  if (devicesResult.error) throw new Error(`devices load failed: ${devicesResult.error.message}`);
  if (operatorSettingsResult.error) throw new Error(`operator settings load failed: ${operatorSettingsResult.error.message}`);
  if (linesResult.error) throw new Error(`lines load failed: ${linesResult.error.message}`);

  const sessions = (sessionsResult.data ?? []) as SessionRow[];
  const sessionIds = sessions.map((session) => session.id);

  const [legsResult, attemptsResult, callRowsResult] = sessionIds.length
    ? await Promise.all([
        admin.from("motorist_call_legs").select("*").in("session_id", sessionIds).is("ended_at", null),
        admin.from("motorist_ring_attempts").select("*").in("session_id", sessionIds).eq("result", "offered"),
        // The console links a live call to a case and stores its outcome
        // through the existing `motorist_calls` routes, which are keyed on the
        // log row, not on the session.
        admin.from("motorist_calls").select("id, session_id").in("session_id", sessionIds),
      ])
    : [
        { data: [] as LegRow[], error: null },
        { data: [] as AttemptRow[], error: null },
        { data: [] as Array<{ id: string; session_id: string | null }>, error: null },
      ];
  if (legsResult.error) throw new Error(`legs load failed: ${legsResult.error.message}`);
  if (attemptsResult.error) throw new Error(`ring attempts load failed: ${attemptsResult.error.message}`);
  if (callRowsResult.error) throw new Error(`call rows load failed: ${callRowsResult.error.message}`);

  const callIdBySession = new Map(
    (callRowsResult.data ?? []).flatMap((row) => (row.session_id ? [[row.session_id, row.id] as const] : [])),
  );

  const legs = (legsResult.data ?? []) as LegRow[];
  const attempts = (attemptsResult.data ?? []) as AttemptRow[];
  const lines = new Map(((linesResult.data ?? []) as LineRow[]).map((line) => [line.id, line]));

  const legsBySession = new Map<string, ActiveCallLegView[]>();
  for (const leg of legs) {
    const list = legsBySession.get(leg.session_id) ?? [];
    const meta = legMetaOf(leg);
    list.push({
      id: leg.id,
      callControlId: leg.profile_id === actor.profileId && (leg.role === "operator" || leg.role === "consult")
        ? leg.telnyx_call_control_id
        : null,
      role: leg.role,
      profileId: leg.profile_id,
      state: leg.state,
      toNumber: leg.to_number,
      fromNumber: leg.from_number,
      answeredAt: leg.answered_at,
      bridgedAt: leg.bridged_at,
      intent: legIntentOf(leg),
      muted: meta.muted === true,
      supervisorMode: typeof meta.supervisor_mode === "string" ? meta.supervisor_mode : null,
    });
    legsBySession.set(leg.session_id, list);
  }

  const offersBySession = new Map<string, string[]>();
  for (const attempt of attempts) {
    if (!attempt.profile_id) continue;
    const list = offersBySession.get(attempt.session_id) ?? [];
    list.push(attempt.profile_id);
    offersBySession.set(attempt.session_id, list);
  }

  const calls = sessions.map((session) => {
    const meta = readMeta(session);
    const line = session.line_id ? lines.get(session.line_id) : undefined;
    const offeredProfileIds = offersBySession.get(session.id) ?? [];
    const sessionLegs = legsBySession.get(session.id) ?? [];
    return {
      sessionId: session.id,
      callId: callIdBySession.get(session.id) ?? null,
      state: session.state,
      direction: session.direction,
      callerNumber: session.caller_number,
      calledNumber: session.called_number,
      lineId: session.line_id,
      lineLabel: line?.label ?? meta.line_label ?? null,
      partnerName: line?.partner_name ?? meta.partner_name ?? null,
      caseId: session.case_id,
      // Keep the field for client compatibility, but never expose a stale
      // number-only match left on a session by an older deployment.
      match: null,
      startedAt: session.started_at,
      answeredAt: session.answered_at,
      answeredByProfileId: session.answered_by_profile_id,
      audioConnection: audioConnectionView(session, legs.filter((leg) => leg.session_id === session.id), now),
      holdStartedAt: session.hold_started_at,
      parkedAt: session.parked_at,
      parkedByProfileId: meta.park?.by ?? null,
      waitingSince: meta.waiting?.since ?? null,
      waitingReason: meta.waiting?.reason ?? null,
      waitingMaxMinutes: typeof meta.waiting?.max_minutes === "number" ? meta.waiting.max_minutes : null,
      currentStep: session.current_step,
      ringMode: meta.ring?.mode ?? null,
      offeredProfileIds,
      legs: sessionLegs,
      mine:
        session.answered_by_profile_id === actor.profileId ||
        offeredProfileIds.includes(actor.profileId) ||
        sessionLegs.some((leg) => leg.profileId === actor.profileId),
    } satisfies ActiveCallView;
  });

  const presenceRows = (presenceResult.data ?? []) as PresenceRow[];
  const deviceRows = (devicesResult.data ?? []) as DeviceRow[];
  const ownPresence = presenceRows.find((row) => row.profile_id === actor.profileId);

  return {
    checkedAt: now.toISOString(),
    configured: deps.configured,
    pausedPickupEnabled: telephonyStabilityEnabled(),
    organizationId,
    actorProfileId: actor.profileId,
    calls,
    waiting: calls.filter((call) => WAITING_STATES.has(call.state)),
    presence: buildPresenceSnapshot({ actor, now, presence: presenceRows, devices: deviceRows, personalMobileProfileIds: new Set((operatorSettingsResult.data ?? []).filter((row) => telephonyStabilityEnabled() && row.delivery_mode === "personal_mobile" && row.default_mobile_number).map((row) => row.profile_id)) }),
    ownPresence: ownPresence ? {
      presenceRevision: ownPresence.presence_revision ?? 0,
      automaticOffersAllowed: !readPauseReturn(ownPresence.pause_return) && ["available", "ringing"].includes(effectivePresenceStatus(ownPresence, now)),
      status: effectivePresenceStatus(ownPresence, now),
      pauseReasonId: ownPresence.pause_reason_id,
      statusSince: effectivePresenceSince(ownPresence, now),
    } : null,
  };
}

/** Provider-neutral presence snapshot consumed by `src/lib/telephony/presence.ts`. */
export function buildPresenceSnapshot(input: {
  actor: { profileId: string; canManageAssignments: boolean };
  now: Date;
  presence: PresenceRow[];
  devices: DeviceRow[];
  personalMobileProfileIds?: ReadonlySet<string>;
}): TelephonyPresenceSnapshot {
  return {
    actorProfileId: input.actor.profileId,
    canManageAssignments: input.actor.canManageAssignments,
    checkedAt: input.now.toISOString(),
    devices: input.devices.map((device) => ({
      profileId: device.profile_id,
      registered: deviceIsLive(device, input.now),
      ...(device.device_seen_at ? { seenAt: device.device_seen_at } : {}),
    })),
    presence: input.presence.map((row) => ({
      profileId: row.profile_id,
      status: effectivePresenceStatus(row, input.now),
      currentSessionId: row.current_session_id,
      ...(input.personalMobileProfileIds?.has(row.profile_id) ? { deliveryMode: "personal_mobile" as const } : {}),
    })),
  };
}
