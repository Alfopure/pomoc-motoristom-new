import { randomUUID } from "node:crypto";

import { createFakeSupabase, type FakeRow, type FakeSupabase } from "@/test/fake-supabase";
import { createFakeTelnyx, FAKE_TELNYX_ENV, type FakeTelnyx } from "@/test/fake-telnyx";
import { encodeClientState, type TelnyxClientState } from "@/server/telephony/telnyx/client-state";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { processTelnyxEvent, type ProcessorDeps, type ProcessorResult } from "@/server/telephony/telnyx/event-processor";
import { buildTelnyxEnvelope } from "@/server/telephony/state/events";
import type { TelephonyEnvironment } from "@/server/telephony/state/types";

/**
 * Seeded in-memory telephony world mirroring `supabase/seed.sql`: one
 * organisation, five operators, two lines, two ring groups, the "Denný" plan,
 * business hours, an IVR on the neutral line, presence and devices.
 */

export const ORG = "00000000-0000-4000-8000-000000000001";
export const PROFILES = {
  o1: "00000000-0000-4000-8000-000000000101",
  o2: "00000000-0000-4000-8000-000000000102",
  o3: "00000000-0000-4000-8000-000000000103",
  o4: "00000000-0000-4000-8000-000000000104",
  o5: "00000000-0000-4000-8000-000000000105",
} as const;
export const LINES = { neutral: "00000000-0000-4000-8000-000000000201", allianz: "00000000-0000-4000-8000-000000000202" } as const;
export const NUMBERS = { neutral: "+421232408700", allianz: "+421232408718", external: "+421900000000", customer: "+421905123456" } as const;
export const GROUPS = { a: "00000000-0000-4000-8000-000000002201", b: "00000000-0000-4000-8000-000000002202" } as const;
export const PLAN_ID = "00000000-0000-4000-8000-000000002301";
export const BUSINESS_HOURS_ID = "00000000-0000-4000-8000-000000002001";
export const IVR_MENU_ID = "00000000-0000-4000-8000-000000002401";
export const CASE_ID = "00000000-0000-4000-8000-000000000801";
export const CONNECTION_ID = "app-test";

/** Thursday 3 September 2026, 10:00 in Bratislava (inside business hours). */
export const DEFAULT_NOW = "2026-09-03T08:00:00.000Z";

export type HarnessOptions = {
  now?: string;
  environment?: TelephonyEnvironment;
  mediaBaseUrl?: string | null;
  liveCalls?: boolean;
  ivrOnNeutralLine?: boolean;
  fallbackKind?: "external_number" | "waiting_room" | "callback_prompt" | "hangup_message";
  sweepAfterEvent?: boolean;
  leaseWaitMs?: number;
};

export type TelephonyHarness = FakeSupabase & {
  telnyx: FakeTelnyx;
  deps: ProcessorDeps;
  logs: Array<Record<string, unknown>>;
  rows(table: string): FakeRow[];
  now(): Date;
  advance(ms: number): void;
  setNow(iso: string): void;
  nextEventId(): string;
  envelope(type: string, payload: Record<string, unknown>, id?: string): ReturnType<typeof buildTelnyxEnvelope>;
  process(envelope: unknown): Promise<ProcessorResult>;
  /** Sends a Telnyx event for a known leg (client_state taken from the leg row). */
  legEvent(callControlId: string, type: string, extra?: Record<string, unknown>, id?: string): Promise<ProcessorResult>;
  /** Runs `call.initiated` + `call.answered` for a customer leg on `to`. */
  inbound(input?: { from?: string; to?: string; callControlId?: string; telnyxSessionId?: string; answer?: boolean }): Promise<{ callControlId: string; sessionId: string; telnyxSessionId: string; results: ProcessorResult[] }>;
  session(sessionId: string): FakeRow;
  legs(sessionId: string): FakeRow[];
  legFor(sessionId: string, profileId: string): FakeRow | null;
  /** The operator's leg that has not ended yet (a session may hold several legs per operator). */
  openLegFor(sessionId: string, profileId: string): FakeRow | null;
  legByNumber(sessionId: string, toNumber: string): FakeRow | null;
  attempts(sessionId: string): FakeRow[];
  presence(profileId: string): FakeRow;
  call(sessionId: string): FakeRow | null;
  callEvents(sessionId: string): FakeRow[];
  setPresence(profileId: string, values: Partial<FakeRow>): void;
  touchDevice(profileId: string, agoMs?: number): void;
  clientStateOf(callControlId: string): TelnyxClientState;
};

export function createTelephonyHarness(options: HarnessOptions = {}): TelephonyHarness {
  let current = new Date(options.now ?? DEFAULT_NOW);
  const fake = createFakeSupabase({ now: () => current });
  const { db } = fake;
  const environment = options.environment ?? "development";
  const nowIso = () => current.toISOString();
  const seenAt = new Date(current.getTime() - 5_000).toISOString();

  db.seed("motorist_organizations", [{ id: ORG, slug: "pomoc-motoristom", name: "Pomoc motoristom", active: true }]);
  db.seed(
    "motorist_profiles",
    [
      [PROFILES.o1, "Jana Dispečerka", "dispatcher"],
      [PROFILES.o2, "Peter Dispečer", "dispatcher"],
      [PROFILES.o3, "Senior Dispečer", "senior_dispatcher"],
      [PROFILES.o4, "Manažér", "manager"],
      [PROFILES.o5, "Admin", "admin"],
    ].map(([id, display_name, role]) => ({ id, organization_id: ORG, display_name, role, active: true, access_status: "active", user_id: null, email: null })),
  );
  db.seed("motorist_cases", [{ id: CASE_ID, organization_id: ORG, case_number: "PM-2026-0001", status: "open", case_type: "odtah" }]);
  db.seed("motorist_telephony_settings", [
    {
      id: "00000000-0000-4000-8000-000000002601",
      organization_id: ORG,
      live_calls_enabled: options.liveCalls ?? true,
      sms_live_sends: false,
      daily_leg_soft_cap: 500,
      park_max_minutes: 30,
      destination_allowlist: ["SK", "CZ"],
      max_ring_fanout: 8,
      max_concurrent_legs: 9,
    },
  ]);
  db.seed("motorist_business_hours", [{ id: BUSINESS_HOURS_ID, organization_id: ORG, name: "Pracovný čas", timezone: "Europe/Bratislava", active: true }]);
  db.seed(
    "motorist_business_hours_intervals",
    [1, 2, 3, 4, 5].flatMap((weekday) => [
      { organization_id: ORG, business_hours_id: BUSINESS_HOURS_ID, weekday, opens: "07:00:00", closes: "12:00:00" },
      { organization_id: ORG, business_hours_id: BUSINESS_HOURS_ID, weekday, opens: "12:30:00", closes: "19:00:00" },
    ]),
  );
  db.seed("motorist_business_hours_exceptions", [{ organization_id: ORG, business_hours_id: BUSINESS_HOURS_ID, date: "2026-12-24", closed: true, intervals: [], label: "Štedrý deň" }]);
  db.seed("motorist_ring_groups", [
    { id: GROUPS.a, organization_id: ORG, name: "Dispečing A", active: true },
    { id: GROUPS.b, organization_id: ORG, name: "Dispečing B", active: true },
  ]);
  db.seed("motorist_ring_group_members", [
    { id: "00000000-0000-4000-8000-000000002211", organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "operator", profile_id: PROFILES.o1, external_number: null, position: 0, ring_secs: null },
    { id: "00000000-0000-4000-8000-000000002212", organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "operator", profile_id: PROFILES.o2, external_number: null, position: 1, ring_secs: null },
    { id: "00000000-0000-4000-8000-000000002213", organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "operator", profile_id: PROFILES.o5, external_number: null, position: 2, ring_secs: null },
    { id: "00000000-0000-4000-8000-000000002221", organization_id: ORG, ring_group_id: GROUPS.b, member_kind: "operator", profile_id: PROFILES.o4, external_number: null, position: 0, ring_secs: 15 },
    { id: "00000000-0000-4000-8000-000000002222", organization_id: ORG, ring_group_id: GROUPS.b, member_kind: "operator", profile_id: PROFILES.o3, external_number: null, position: 1, ring_secs: 15 },
    { id: "00000000-0000-4000-8000-000000002223", organization_id: ORG, ring_group_id: GROUPS.b, member_kind: "external_number", profile_id: null, external_number: NUMBERS.external, position: 2, ring_secs: 15 },
  ]);
  db.seed("motorist_ring_plans", [{ id: PLAN_ID, organization_id: ORG, name: "Denný", fallback_kind: options.fallbackKind ?? "callback_prompt", fallback_number: options.fallbackKind === "external_number" ? NUMBERS.external : null, active: true }]);
  db.seed("motorist_ring_plan_steps", [
    { id: "00000000-0000-4000-8000-000000002311", organization_id: ORG, ring_plan_id: PLAN_ID, step_index: 0, ring_group_id: GROUPS.a, timeout_secs: 20, strategy: "all" },
    { id: "00000000-0000-4000-8000-000000002312", organization_id: ORG, ring_plan_id: PLAN_ID, step_index: 1, ring_group_id: GROUPS.b, timeout_secs: 15, strategy: "ordered" },
  ]);
  db.seed("motorist_ivr_menus", [{ id: IVR_MENU_ID, organization_id: ORG, name: "Hlavné menu", prompt_media_url: "ivr-main.mp3", tts_text: "Stlačte 1 alebo 2.", invalid_media_url: "invalid-input.mp3", timeout_secs: 5, max_tries: 2, active: true }]);
  db.seed("motorist_ivr_options", [
    { id: "00000000-0000-4000-8000-000000002411", organization_id: ORG, ivr_menu_id: IVR_MENU_ID, digit: "1", action: "ring_plan", target_ring_plan_id: PLAN_ID, target_number: null, label: "Dispečing" },
    { id: "00000000-0000-4000-8000-000000002412", organization_id: ORG, ivr_menu_id: IVR_MENU_ID, digit: "2", action: "callback", target_ring_plan_id: null, target_number: null, label: "Spätné volanie", prompt_media_url: "callback-offer.mp3" },
  ]);
  db.seed("motorist_pause_reasons", [{ id: "00000000-0000-4000-8000-000000002501", organization_id: ORG, code: "obed", label: "Obed", max_minutes: 45, sort_order: 10, active: true }]);
  db.seed("motorist_telephony_lines", [
    {
      id: LINES.neutral,
      organization_id: ORG,
      provider: "telnyx",
      phone_number: NUMBERS.neutral,
      label: "Neutrálna linka",
      partner_name: null,
      ring_plan_id: PLAN_ID,
      ivr_menu_id: options.ivrOnNeutralLine === false ? null : IVR_MENU_ID,
      business_hours_id: BUSINESS_HOURS_ID,
      environment: "production",
      active: true,
      metadata: {},
    },
    {
      id: LINES.allianz,
      organization_id: ORG,
      provider: "telnyx",
      phone_number: NUMBERS.allianz,
      label: "Allianz Assistance",
      partner_name: "Allianz Assistance",
      ring_plan_id: PLAN_ID,
      ivr_menu_id: null,
      business_hours_id: BUSINESS_HOURS_ID,
      environment: "production",
      active: true,
      metadata: {},
    },
  ]);
  db.seed(
    "motorist_operator_presence",
    Object.values(PROFILES).map((profileId, index) => ({
      organization_id: ORG,
      profile_id: profileId,
      status: ([PROFILES.o3, PROFILES.o4] as string[]).includes(profileId) ? "offline" : "available",
      current_session_id: null,
      pause_reason_id: null,
      wrap_up_until: null,
      status_since: nowIso(),
      id: `00000000-0000-4000-8000-00000000270${index + 1}`,
    })),
  );
  db.seed(
    "motorist_operator_devices",
    [PROFILES.o1, PROFILES.o2, PROFILES.o5].map((profileId, index) => ({
      organization_id: ORG,
      profile_id: profileId,
      environment,
      telnyx_credential_id: `cred-${index + 1}`,
      sip_username: `gencred00${index + 1}`,
      credential_expires_at: null,
      last_token_issued_at: seenAt,
      token_expires_at: null,
      device_seen_at: seenAt,
      device_session_id: `dev-${index + 1}`,
      registration_state: "registered",
      user_agent: "vitest",
      metadata: {},
    })),
  );
  db.seed("motorist_operator_telephony_settings", [{ organization_id: ORG, profile_id: PROFILES.o1, default_from_line_id: LINES.allianz, wrap_up_seconds: 30, auto_answer_outbound: true, ring_device_volume: 80 }]);
  db.seed("motorist_job_controls", [
    { job_name: "telephony.telnyx.webhook", enabled: false },
    { job_name: "telephony.telnyx.commands", enabled: false },
    { job_name: "telephony.telnyx.actions", enabled: false },
  ]);

  const env = { ...FAKE_TELNYX_ENV, TELNYX_CALL_CONTROL_APP_ID: CONNECTION_ID, TELNYX_LIVE_CALLS_ENABLED: options.liveCalls === false ? "false" : "true" } as Record<string, string>;
  if (options.mediaBaseUrl === null) delete env.TELNYX_MEDIA_BASE_URL;
  else if (options.mediaBaseUrl) env.TELNYX_MEDIA_BASE_URL = options.mediaBaseUrl;
  const config = getTelnyxConfig(env);
  const telnyx = createFakeTelnyx({ config, liveGate: { callsEnabled: options.liveCalls !== false, smsEnabled: false } });
  const logs: Array<Record<string, unknown>> = [];
  let eventCounter = 0;

  const deps: ProcessorDeps = {
    admin: fake.admin,
    telnyx: telnyx.client,
    config,
    organizationId: ORG,
    environment,
    now: () => current,
    sleep: async (ms) => {
      current = new Date(current.getTime() + ms);
    },
    random: () => 0.5,
    logger: (entry) => logs.push(entry),
    sweepAfterEvent: options.sweepAfterEvent ?? false,
    leaseWaitMs: options.leaseWaitMs,
    findCallerMatches: async () => ({ degraded: true, matches: [] }),
  };

  const harness: TelephonyHarness = {
    ...fake,
    telnyx,
    deps,
    logs,
    rows: (table) => db.rows(table),
    now: () => current,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    setNow(iso) {
      current = new Date(iso);
    },
    nextEventId: () => `evt-${++eventCounter}`,
    envelope(type, payload, id) {
      return buildTelnyxEnvelope({ id: id ?? harness.nextEventId(), type, occurredAt: nowIso(), payload: { connection_id: CONNECTION_ID, ...payload } });
    },
    process: (envelope) => processTelnyxEvent(deps, envelope),
    async legEvent(callControlId, type, extra = {}, id) {
      const leg = db.find("motorist_call_legs", (row) => row.telnyx_call_control_id === callControlId);
      if (!leg) throw new Error(`no leg ${callControlId}`);
      const clientState = harness.clientStateOf(callControlId);
      const session = harness.session(String(leg.session_id));
      return harness.process(
        harness.envelope(
          type,
          {
            call_control_id: callControlId,
            call_leg_id: leg.telnyx_call_leg_id ?? `leg-${callControlId}`,
            call_session_id: session.telnyx_session_id ?? `tsess-${session.id}`,
            client_state: encodeClientState(clientState),
            from: leg.from_number,
            to: leg.to_number,
            ...extra,
          },
          id,
        ),
      );
    },
    async inbound(input = {}) {
      const callControlId = input.callControlId ?? `cc-cust-${randomUUID().slice(0, 8)}`;
      const telnyxSessionId = input.telnyxSessionId ?? `tsess-${callControlId}`;
      const from = input.from ?? NUMBERS.customer;
      const to = input.to ?? "+4210232408718".replace("+42102", "+4212");
      const results: ProcessorResult[] = [];
      results.push(
        await harness.process(
          harness.envelope("call.initiated", { call_control_id: callControlId, call_leg_id: `leg-${callControlId}`, call_session_id: telnyxSessionId, from, to, direction: "incoming", state: "parked" }),
        ),
      );
      const leg = db.find("motorist_call_legs", (row) => row.telnyx_call_control_id === callControlId);
      if (!leg) throw new Error("inbound: customer leg was not created");
      const sessionId = String(leg.session_id);
      if (input.answer !== false) {
        results.push(await harness.legEvent(callControlId, "call.answered", { direction: "incoming", state: "answered" }));
      }
      return { callControlId, sessionId, telnyxSessionId, results };
    },
    session(sessionId) {
      const row = db.find("motorist_call_sessions", (candidate) => candidate.id === sessionId);
      if (!row) throw new Error(`no session ${sessionId}`);
      return row;
    },
    legs: (sessionId) => db.rows("motorist_call_legs").filter((row) => row.session_id === sessionId),
    legFor: (sessionId, profileId) => db.find("motorist_call_legs", (row) => row.session_id === sessionId && row.profile_id === profileId),
    openLegFor: (sessionId, profileId) => db.find("motorist_call_legs", (row) => row.session_id === sessionId && row.profile_id === profileId && !row.ended_at),
    legByNumber: (sessionId, toNumber) => db.find("motorist_call_legs", (row) => row.session_id === sessionId && row.to_number === toNumber),
    attempts: (sessionId) => db.rows("motorist_ring_attempts").filter((row) => row.session_id === sessionId),
    presence(profileId) {
      const row = db.find("motorist_operator_presence", (candidate) => candidate.profile_id === profileId);
      if (!row) throw new Error(`no presence ${profileId}`);
      return row;
    },
    call: (sessionId) => db.find("motorist_calls", (row) => row.session_id === sessionId),
    callEvents: (sessionId) => {
      const call = harness.call(sessionId);
      return db.rows("motorist_call_events").filter((row) => (call ? row.call_id === call.id : false));
    },
    setPresence(profileId, values) {
      db.update("motorist_operator_presence", values, (row) => row.profile_id === profileId);
    },
    touchDevice(profileId, agoMs = 0) {
      db.update("motorist_operator_devices", { device_seen_at: new Date(current.getTime() - agoMs).toISOString() }, (row) => row.profile_id === profileId);
    },
    clientStateOf(callControlId) {
      const leg = db.find("motorist_call_legs", (row) => row.telnyx_call_control_id === callControlId);
      const state = leg?.client_state as TelnyxClientState | undefined;
      if (!state || !state.sid) throw new Error(`leg ${callControlId} has no client_state`);
      return state;
    },
  };
  return harness;
}

/** Call control id of the fake dial that targeted `to` (SIP uri or number). */
export function dialedCallControlId(harness: TelephonyHarness, sessionId: string, predicate: (leg: FakeRow) => boolean): string {
  const leg = harness.legs(sessionId).find(predicate);
  if (!leg) throw new Error("no dialed leg matches");
  return String(leg.telnyx_call_control_id);
}
