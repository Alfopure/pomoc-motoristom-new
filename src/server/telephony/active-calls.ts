import type { SupabaseClient } from "@supabase/supabase-js";

import type { CallerMatch } from "@/data/dispatch-types";
import type { Database } from "@/lib/supabase/database.types";
import type { TelephonyPresenceSnapshot } from "@/lib/telephony/presence";

import { deviceIsLive } from "./operator-devices";
import { effectivePresenceStatus } from "./presence-service";
import { ACTIVE_SESSION_STATES, readMeta, WAITING_STATES, type AttemptRow, type DeviceRow, type LegRow, type LineRow, type PresenceRow, type SessionRow } from "./state/types";
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
  role: LegRow["role"];
  profileId: string | null;
  state: LegRow["state"];
  toNumber: string | null;
  fromNumber: string | null;
  answeredAt: string | null;
  bridgedAt: string | null;
};

export type ActiveCallView = {
  sessionId: string;
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
  holdStartedAt: string | null;
  parkedAt: string | null;
  waitingSince: string | null;
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
  actorProfileId: string;
  calls: ActiveCallView[];
  waiting: ActiveCallView[];
  presence: TelephonyPresenceSnapshot;
};

export type ActiveCallsDeps = {
  admin: AdminClient;
  organizationId: string;
  environment: TelephonyEnvironment;
  configured: boolean;
  now?: () => Date;
};

const ACTIVE_STATES = [...ACTIVE_SESSION_STATES];

export async function loadActiveCalls(
  deps: ActiveCallsDeps,
  actor: { profileId: string; canManageAssignments: boolean },
): Promise<ActiveCallsSnapshot> {
  const now = (deps.now ?? (() => new Date()))();
  const { admin, organizationId } = deps;

  const [sessionsResult, presenceResult, devicesResult, linesResult] = await Promise.all([
    admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).in("state", ACTIVE_STATES).order("started_at", { ascending: true }),
    admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId),
    admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId).eq("environment", deps.environment),
    admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId),
  ]);
  if (sessionsResult.error) throw new Error(`active sessions load failed: ${sessionsResult.error.message}`);
  if (presenceResult.error) throw new Error(`presence load failed: ${presenceResult.error.message}`);
  if (devicesResult.error) throw new Error(`devices load failed: ${devicesResult.error.message}`);
  if (linesResult.error) throw new Error(`lines load failed: ${linesResult.error.message}`);

  const sessions = (sessionsResult.data ?? []) as SessionRow[];
  const sessionIds = sessions.map((session) => session.id);

  const [legsResult, attemptsResult] = sessionIds.length
    ? await Promise.all([
        admin.from("motorist_call_legs").select("*").in("session_id", sessionIds).is("ended_at", null),
        admin.from("motorist_ring_attempts").select("*").in("session_id", sessionIds).eq("result", "offered"),
      ])
    : [
        { data: [] as LegRow[], error: null },
        { data: [] as AttemptRow[], error: null },
      ];
  if (legsResult.error) throw new Error(`legs load failed: ${legsResult.error.message}`);
  if (attemptsResult.error) throw new Error(`ring attempts load failed: ${attemptsResult.error.message}`);

  const legs = (legsResult.data ?? []) as LegRow[];
  const attempts = (attemptsResult.data ?? []) as AttemptRow[];
  const lines = new Map(((linesResult.data ?? []) as LineRow[]).map((line) => [line.id, line]));

  const legsBySession = new Map<string, ActiveCallLegView[]>();
  for (const leg of legs) {
    const list = legsBySession.get(leg.session_id) ?? [];
    list.push({
      id: leg.id,
      role: leg.role,
      profileId: leg.profile_id,
      state: leg.state,
      toNumber: leg.to_number,
      fromNumber: leg.from_number,
      answeredAt: leg.answered_at,
      bridgedAt: leg.bridged_at,
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
      state: session.state,
      direction: session.direction,
      callerNumber: session.caller_number,
      calledNumber: session.called_number,
      lineId: session.line_id,
      lineLabel: line?.label ?? meta.line_label ?? null,
      partnerName: line?.partner_name ?? meta.partner_name ?? null,
      caseId: session.case_id,
      match: meta.match ?? null,
      startedAt: session.started_at,
      answeredAt: session.answered_at,
      answeredByProfileId: session.answered_by_profile_id,
      holdStartedAt: session.hold_started_at,
      parkedAt: session.parked_at,
      waitingSince: meta.waiting?.since ?? null,
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

  return {
    checkedAt: now.toISOString(),
    configured: deps.configured,
    actorProfileId: actor.profileId,
    calls,
    waiting: calls.filter((call) => WAITING_STATES.has(call.state)),
    presence: buildPresenceSnapshot({ actor, now, presence: presenceRows, devices: deviceRows }),
  };
}

/** Provider-neutral presence snapshot consumed by `src/lib/telephony/presence.ts`. */
export function buildPresenceSnapshot(input: {
  actor: { profileId: string; canManageAssignments: boolean };
  now: Date;
  presence: PresenceRow[];
  devices: DeviceRow[];
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
    })),
  };
}
