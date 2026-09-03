import type { CallerMatch } from "@/data/dispatch-types";
import type { CallLegRole, CallSessionState, Database, Json, OperatorPresenceStatus, RingAttemptResult } from "@/lib/supabase/database.types";

import type { BusinessHoursSchedule } from "../routing/business-hours";
import type { TelnyxClientState } from "../telnyx/client-state";

/**
 * Shared types of the telephony state machine (design §2.5/§2.6).
 *
 * The reducer (`transitions.ts`) is pure: it receives the session, its legs
 * and ring attempts, the incoming event and a pre-loaded routing context and
 * returns a transition (row patches) plus the Telnyx commands to execute and
 * their compensations. `effects.ts` persists and executes.
 */

type Tables = Database["public"]["Tables"];

export type SessionRow = Tables["motorist_call_sessions"]["Row"];
export type LegRow = Tables["motorist_call_legs"]["Row"];
export type AttemptRow = Tables["motorist_ring_attempts"]["Row"];
export type PresenceRow = Tables["motorist_operator_presence"]["Row"];
export type DeviceRow = Tables["motorist_operator_devices"]["Row"];
export type LineRow = Tables["motorist_telephony_lines"]["Row"];
export type CallRow = Tables["motorist_calls"]["Row"];
export type SettingsRow = Tables["motorist_telephony_settings"]["Row"];
export type IvrMenuRow = Tables["motorist_ivr_menus"]["Row"];
export type IvrOptionRow = Tables["motorist_ivr_options"]["Row"];
export type CallbackSource = Tables["motorist_callback_requests"]["Row"]["source"];

export type TelephonyEnvironment = "production" | "development";

// --- media -----------------------------------------------------------------

/** Pre-recorded Slovak prompts shipped in `public/telephony/` (served under `TELNYX_MEDIA_BASE_URL`). */
export const MEDIA_FILES = {
  moh: "moh.mp3",
  greeting: "greeting.mp3",
  afterHours: "after-hours.mp3",
  ivrMain: "ivr-main.mp3",
  callbackOffer: "callback-offer.mp3",
  callbackConfirmed: "callback-confirmed.mp3",
  allBusy: "all-busy.mp3",
  invalidInput: "invalid-input.mp3",
} as const;

export type MediaKey = keyof typeof MEDIA_FILES;

/** Either a well-known prompt or a file name stored on an IVR row. */
export type MediaRef = { key: MediaKey } | { file: string };

export function mediaFileName(ref: MediaRef): string {
  return "key" in ref ? MEDIA_FILES[ref.key] : ref.file;
}

/** Absolute prompt URL; `null` when no media base is configured. */
export function mediaUrl(base: string | null | undefined, ref: MediaRef): string | null {
  if (!base) return null;
  const file = mediaFileName(ref);
  if (/^https?:\/\//i.test(file)) return file;
  return `${base.replace(/\/+$/, "")}/${file.replace(/^\/+/, "")}`;
}

/** TTS fallback (used only when no prompt media is reachable). */
// The voice carries the locale; Telnyx has no `sk-SK` value for `language`.
export const DEFAULT_TTS_VOICE = "Azure.sk-SK-ViktoriaNeural";

// --- frozen ring plan ------------------------------------------------------

export type FrozenRingMember = {
  kind: "operator" | "external_number";
  profileId: string | null;
  externalNumber: string | null;
  position: number;
  /** Resolved ring time for `ordered` steps: `max(5, member.ring_secs ?? step.timeout_secs)`. */
  ringSecs: number;
  memberId: string | null;
};

export type FrozenRingStep = {
  index: number;
  groupId: string;
  groupName: string;
  strategy: "all" | "ordered";
  timeoutSecs: number;
  members: FrozenRingMember[];
};

export type FrozenRingPlan = {
  planId: string;
  name: string;
  fallback: { kind: "external_number" | "waiting_room" | "callback_prompt" | "hangup_message"; number: string | null };
  steps: FrozenRingStep[];
  frozenAt: string;
};

// --- events ----------------------------------------------------------------

export type TelephonyEvent = {
  kind: "telnyx";
  /** Telnyx event id (`data.id`), used as `event_fingerprint`. */
  id: string;
  type: string;
  occurredAt: string | null;
  callControlId: string | null;
  callLegId: string | null;
  /** Telnyx `call_session_id` (not our session id). */
  callSessionId: string | null;
  connectionId: string | null;
  clientState: TelnyxClientState | null;
  rawClientState: string | null;
  from: string | null;
  to: string | null;
  direction: "incoming" | "outgoing" | null;
  state: string | null;
  hangupCause: string | null;
  hangupSource: string | null;
  sipHangupCause: string | null;
  digits: string | null;
  status: string | null;
  conferenceId: string | null;
  customHeaders: Array<{ name: string; value: string }>;
  payload: Record<string, unknown>;
};

export type TransferTarget =
  | { kind: "operator"; profileId: string; sipUri: string; label: string }
  | { kind: "number"; number: string; label: string };

export type AppEventType =
  | "hold"
  | "unhold"
  | "park"
  | "pickup"
  | "blind_transfer"
  | "consult"
  | "complete_transfer"
  | "cancel_consult"
  | "hangup"
  | "sweep";

export type AppEvent = {
  kind: "app";
  /** Unique id of the action (fingerprint for command ids and the call event row). */
  id: string;
  type: AppEventType;
  actorProfileId: string | null;
  occurredAt: string;
  target?: TransferTarget;
  /** For `pickup`: the picking operator's device. */
  picker?: { profileId: string; sipUri: string };
};

export type SessionEvent = TelephonyEvent | AppEvent;

// --- commands --------------------------------------------------------------

/** A leg by Telnyx id, or the leg created by an earlier `dial` command of the same transition. */
export type LegRef = { callControlId: string; fromDial?: undefined } | { callControlId?: undefined; fromDial: string };

export type GatherSpec = {
  media: MediaRef;
  invalidMedia?: MediaRef | null;
  ttsText?: string | null;
  validDigits?: string;
  maximumDigits?: number;
  minimumDigits?: number;
  maximumTries?: number;
  timeoutMillis?: number;
  interDigitTimeoutMillis?: number;
  /** What the gather is for; echoed in `client_state.intent`. */
  purpose: "ivr" | "callback_offer" | "moh_tick";
};

export type DialCommand = CommandBase & {
  kind: "dial";
  commandId: string;
  to: string;
  from: string;
  role: CallLegRole;
  profileId: string | null;
  externalNumber: string | null;
  clientState: TelnyxClientState;
  linkTo: string | null;
  timeoutSecs: number;
  /** Ring attempt this dial belongs to (natural key, resolved by effects). */
  attempt?: { stepIndex: number; profileId: string | null; externalNumber: string | null } | null;
  autoAnswer?: boolean;
  fromDisplayName?: string;
};

export type AttemptPlan = {
  stepIndex: number;
  ringGroupId: string | null;
  memberKind: "operator" | "external_number";
  profileId: string | null;
  externalNumber: string | null;
  position: number;
  ringSecs: number;
};

export type RingFanout = CommandBase & {
  kind: "ring_fanout";
  step: number;
  /**
   * When set, `motorist_advance_ring_step(session, expectedStep)` must succeed
   * first (only the winner fans out); the winner then stores `setStep` as
   * `current_step` (= number of steps started so far).
   */
  guard: { expectedStep: number; setStep: number } | null;
  attempts: AttemptPlan[];
  dials: DialCommand[];
  /** Presence rows to move to `ringing` for the offered operators. */
  ringingProfileIds: string[];
  deadlineAt: string;
};

export type CommandBase = {
  /** Log and continue on failure instead of running compensations (e.g. `playback_stop` on an idle leg). */
  bestEffort?: boolean;
};

export type Command = CommandBase &
  (
  | { kind: "answer"; commandId: string; leg: LegRef; clientState: TelnyxClientState }
  | { kind: "hangup"; commandId: string; leg: LegRef; reason: string }
  | { kind: "bridge"; commandId: string; leg: LegRef; target: LegRef; parkAfterUnbridge?: "self"; playRingtone?: boolean }
  | { kind: "playback_start"; commandId: string; leg: LegRef; media: MediaRef; loop?: "infinity" | number }
  | { kind: "playback_stop"; commandId: string; leg: LegRef }
  | { kind: "gather"; commandId: string; leg: LegRef; spec: GatherSpec; clientState: TelnyxClientState }
  | { kind: "gather_stop"; commandId: string; leg: LegRef }
  | DialCommand
  | {
      kind: "transfer";
      commandId: string;
      leg: LegRef;
      to: string;
      from: string | null;
      targetClientState: TelnyxClientState;
      timeoutSecs: number;
    }
  | { kind: "conference_create"; commandId: string; leg: LegRef; name: string }
  | { kind: "conference_join"; commandId: string; leg: LegRef }
  | { kind: "conference_leave"; commandId: string; leg: LegRef }
  | { kind: "conference_hold"; commandId: string; legs: LegRef[]; media: MediaRef }
  | { kind: "conference_unhold"; commandId: string; legs: LegRef[] }
  | RingFanout
  );

export type CommandKind = Command["kind"];

export function commandKey(command: Command): string {
  return command.kind === "ring_fanout" ? `ring_fanout:${command.step}` : command.commandId;
}

// --- transition ------------------------------------------------------------

export type SessionPatch = Partial<
  Pick<
    SessionRow,
    | "state"
    | "line_id"
    | "ring_plan_id"
    | "current_step"
    | "conference_id"
    | "conference_name"
    | "customer_leg_id"
    | "answered_by_profile_id"
    | "case_id"
    | "caller_number"
    | "called_number"
    | "answered_at"
    | "ended_at"
    | "hold_started_at"
    | "parked_at"
    | "metadata"
  >
>;

export type LegValues = Partial<Omit<LegRow, "id" | "organization_id" | "session_id" | "created_at" | "updated_at">>;

export type LegPatch = {
  callControlId: string;
  values: LegValues;
  /** Create the row when it does not exist yet (webhooks may precede our own upsert). */
  createIfMissing?: boolean;
};

export type AttemptPatch = { id: string; values: Partial<Omit<AttemptRow, "id" | "organization_id" | "session_id" | "created_at" | "updated_at">> };

export type PresenceChange = {
  profileId: string;
  status: OperatorPresenceStatus;
  /** `null` clears `current_session_id`; `undefined` leaves it untouched. */
  sessionId?: string | null;
  /** Compute `wrap_up_until` from the operator's `wrap_up_seconds` (effects). */
  startWrapUp?: boolean;
  /** Only apply when `current_session_id` is null or equals this id. */
  onlyIfSession?: string;
  /** Only apply when the current status is one of these. */
  onlyIfStatus?: OperatorPresenceStatus[];
  reason: string;
};

export type CallbackPlan = {
  source: CallbackSource;
  callerNumber: string;
  createTask: boolean;
  notes?: string | null;
};

export type Transition = {
  session: SessionPatch;
  legs: LegPatch[];
  attempts: AttemptPatch[];
  presence: PresenceChange[];
  callbacks: CallbackPlan[];
  /** Overrides for the `motorist_calls` row (effects derives the rest from the session). */
  call: Partial<Pick<CallRow, "status" | "end_reason" | "summary" | "operator_id" | "answered_at" | "ended_at" | "ring_seconds" | "ring_group_id">>;
  /** Member rows to touch (`last_offered_at` / `last_answered_at`). */
  memberTouches: Array<{ memberId: string; field: "last_offered_at" | "last_answered_at" }>;
  notes: string[];
};

export type Compensation = {
  forCommand: string;
  description: string;
  commands: Command[];
  next: Transition | null;
};

export type ReservationGuard = {
  profileId: string;
  onRejected: { next: Transition; commands: Command[] };
};

export type ReduceResult = {
  next: Transition;
  commands: Command[];
  compensations: Compensation[];
  guard: ReservationGuard | null;
  /** Set when the event changes nothing (duplicate, foreign leg, wrong state). */
  ignored: string | null;
};

export function emptyTransition(): Transition {
  return { session: {}, legs: [], attempts: [], presence: [], callbacks: [], call: {}, memberTouches: [], notes: [] };
}

export function ignoredResult(reason: string): ReduceResult {
  return { next: emptyTransition(), commands: [], compensations: [], guard: null, ignored: reason };
}

// --- routing context --------------------------------------------------------

export type RoutingSettings = {
  parkMaxMinutes: number;
  maxRingFanout: number;
  maxConcurrentLegs: number;
  wrapUpSecondsDefault: number;
};

export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = {
  parkMaxMinutes: 30,
  maxRingFanout: 8,
  maxConcurrentLegs: 9,
  wrapUpSecondsDefault: 30,
};

export const MAX_RING_FANOUT = 8;
export const MAX_CONCURRENT_LEGS = 9;
/** Staleness window of the waiting-room tick (a tick re-arms after each MOH playback). */
export const MOH_TICK_MS = 60_000;
/** Silence tolerated after the MOH file before the gather ends and music is re-armed. */
export const MOH_TICK_TIMEOUT_MS = 2_000;
export const CALLBACK_OFFER_TIMEOUT_MS = 8_000;
export const DEFAULT_TRANSFER_TIMEOUT_SECS = 30;
export const RING_STEP_GRACE_SECS = 5;
export const TELNYX_SIP_DOMAIN = "sip.telnyx.com";

/** SIP URI of an operator's WebRTC credential (SRTP is requested via `media_encryption`). */
export function telnyxSipUri(sipUsername: string): string {
  return `sip:${sipUsername}@${TELNYX_SIP_DOMAIN}`;
}

export type RoutingContext = {
  now: Date;
  organizationId: string;
  environment: TelephonyEnvironment;
  line: LineRow | null;
  businessHours: BusinessHoursSchedule | null;
  ivr: { menu: IvrMenuRow; options: IvrOptionRow[] } | null;
  /** The plan frozen for this session (or the line's plan, materialised, when ringing has not started). */
  ringPlan: FrozenRingPlan | null;
  /** Other plans reachable from this line (IVR targets), keyed by plan id. */
  ringPlans: Record<string, FrozenRingPlan>;
  presence: PresenceRow[];
  devices: DeviceRow[];
  /** Profile ids holding an `offered` attempt in another session. */
  openOffers: string[];
  /** Open legs across the organisation (fan-out cap input). */
  activeLegCount: number;
  settings: RoutingSettings;
  /** Default caller id for outbound legs (line number or `TELNYX_DEFAULT_FROM_NUMBER`). */
  fromNumber: string | null;
  /** Whether prompt media can be served (`TELNYX_MEDIA_BASE_URL` set). */
  mediaAvailable: boolean;
};

// --- session metadata -------------------------------------------------------

export type RingMode = "plan" | "transfer" | "pickup" | "outbound" | "internal" | "consult";

export type SessionMeta = {
  match?: { top: CallerMatch | null; count: number; degraded: boolean } | null;
  ring?: {
    plan?: FrozenRingPlan | null;
    mode?: RingMode;
    active_step?: number | null;
    step_started_at?: string | null;
    step_deadline_at?: string | null;
    exhausted?: boolean;
    fallback?: string | null;
  } | null;
  outbound?: { to: string; by: string; from: string; case_id?: string | null } | null;
  internal?: { target_profile_id: string; target_sip: string; by: string } | null;
  transfer?: { kind: "blind" | "attended"; target: TransferTarget; by: string | null; at: string; completed_at?: string | null } | null;
  consult?: { target: TransferTarget; by: string | null; at: string; leg_call_control_id?: string | null; answered_at?: string | null } | null;
  callback?: { requested_at?: string | null; source?: CallbackSource | null; confirmed?: boolean; declined_at?: string | null } | null;
  hangup?: { by: string | null; at: string; scope: "session" } | null;
  conference?: { promoted_at: string; by: string | null } | null;
  park?: { by: string | null; at: string; timed_out_at?: string | null } | null;
  ivr?: { menu_id: string; tries: number; chosen?: string | null; action?: string | null } | null;
  after_hours?: { reason: string; at: string } | null;
  pickup?: { by: string; at: string } | null;
  waiting?: { since: string; reason: string; ticks: number; last_tick_at?: string | null } | null;
  previous_operator?: string | null;
  answered_external?: string | null;
  sdk_hold?: { leg: string; at: string } | null;
  line_label?: string | null;
  partner_name?: string | null;
  [key: string]: unknown;
};

export function readMeta(session: Pick<SessionRow, "metadata">): SessionMeta {
  const value = session.metadata;
  return value && typeof value === "object" && !Array.isArray(value) ? ({ ...(value as Record<string, unknown>) } as SessionMeta) : {};
}

export function mergeMeta(session: Pick<SessionRow, "metadata">, patch: Partial<SessionMeta>): Json {
  const merged: Record<string, unknown> = { ...readMeta(session) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return JSON.parse(JSON.stringify(merged)) as Json;
}

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

// --- derived helpers --------------------------------------------------------

export const ACTIVE_SESSION_STATES: ReadonlySet<CallSessionState> = new Set<CallSessionState>([
  "received",
  "greeting",
  "ivr",
  "ringing",
  "talking",
  "held",
  "consulting",
  "conference",
  "parked",
  "waiting",
  "after_hours",
  "callback_offered",
]);

export const TALKING_STATES: ReadonlySet<CallSessionState> = new Set<CallSessionState>(["talking", "held", "consulting", "conference"]);
export const TERMINAL_STATES: ReadonlySet<CallSessionState> = new Set<CallSessionState>(["ended", "failed"]);
export const WAITING_STATES: ReadonlySet<CallSessionState> = new Set<CallSessionState>(["waiting", "parked"]);

export function isOpenLeg(leg: Pick<LegRow, "ended_at" | "state">): boolean {
  return !leg.ended_at && leg.state !== "ended" && leg.state !== "failed";
}

export function isTerminalAttemptResult(result: RingAttemptResult): boolean {
  return result !== "pending" && result !== "offered";
}

/** `motorist_calls.status` derived from the session state and history. */
export function callStatusForSession(session: Pick<SessionRow, "state" | "direction" | "answered_at">): CallRow["status"] {
  switch (session.state) {
    case "received":
    case "greeting":
    case "ivr":
    case "after_hours":
    case "callback_offered":
      return session.direction === "outbound" || session.direction === "internal" ? "outbound" : "incoming";
    case "waiting":
      if (session.answered_at) return "answered";
      return session.direction === "outbound" || session.direction === "internal" ? "outbound" : "incoming";
    case "ringing":
      return session.direction === "inbound" ? "ringing_agent" : "outbound";
    case "talking":
    case "held":
    case "consulting":
    case "conference":
    case "parked":
      return "answered";
    case "missed":
      return "missed";
    case "failed":
      return "failed";
    case "wrap_up":
    case "ended":
      return session.answered_at ? "ended" : session.direction === "inbound" ? "missed" : "ended";
    default:
      return "incoming";
  }
}
