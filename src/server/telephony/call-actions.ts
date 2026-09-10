import { resolveCallbackTarget } from "@/server/callback-targets";
import { confirmedCallbackTarget } from "@/lib/telephony/callback-target";
import { MONITOR_INVITATION_TTL_MS } from "@/lib/telephony/monitor-invitations";
import { requireMonitorInvitations } from "./monitor-invitation-gate";
import { randomUUID } from "node:crypto";
import type { AppRole } from "@/domain/types";
import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { canPickUpCall } from "@/lib/telephony/call-pickup";
import { canSuperviseRole } from "@/lib/telephony/supervisor-mode";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { isUuid } from "@/lib/telephony/uuid";

import { writeCallAudit } from "./audit";
import { deviceIsLive, deviceSipUri, getOperatorDevice, type DeviceDeps } from "./operator-devices";
import { presenceAllowsOffer } from "./routing/eligibility";
import { releaseOperator, reserveOperatorOwnership, reserveOperatorPickup, releaseOperatorPresence, type PresenceTransitionResult } from "./routing/reservation";
import { telephonyStabilityEnabled } from "./stability";
import { effectivePresenceStatus } from "@/lib/telephony/presence-policy";
import { effectsDeps, loadRoutingSettings, runSessionEvent, type SessionRunnerDeps, type SessionRunResult } from "./session-runner";
import { isOverLegCap, loadDailyUsage } from "./usage";
import { upsertCallRow, upsertDialedLeg, type CommandOutcome } from "./state/effects";
import { CallActionRejected } from "./state/transitions";
import {
  ACTIVE_SESSION_STATES,
  LEG_TIME_LIMIT_SECS,
  TALKING_STATES,
  toJson,
  type AppEvent,
  type AppEventType,
  type DeviceRow,
  type LegRow,
  type LineRow,
  type SessionRow,
  type SupervisorMode,
  type TransferTarget,
} from "./state/types";
import { TelnyxCommandError, TelnyxLiveCallsDisabledError } from "./telnyx/client";
import { encodeClientState } from "./telnyx/client-state";
import { commandId } from "./telnyx/command-id";
import { CallActionError } from "./service-errors";

export { CallActionError } from "./service-errors";

/**
 * Operator-facing call actions (design §4 Phase 2 `call-actions.ts`).
 *
 * Guards applied before anything touches Telnyx: configuration (503),
 * per-operator rate limit for outbound dials (10/min → 429), destination
 * allowlist (403), device liveness (409), presence reservation (409) and
 * call ownership (`answered_by_profile_id === actor` or role ≥ senior
 * dispatcher → 403). In-call actions go through the same per-session
 * pipeline as webhooks (`runSessionEvent`).
 */

export type CallActor = { profileId: string; role: AppRole; displayName?: string };

export type CallActionDeps = SessionRunnerDeps & {
  deviceKind?: "web" | "mobile";
  rateLimiter?: RateLimiter;
};

// --- rate limit --------------------------------------------------------------

export const OUTBOUND_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

export type RateLimiter = {
  /** Returns true when the call is allowed; counts it. */
  hit(key: string, limit: number, windowMs: number): boolean;
  reset(): void;
};

export function createRateLimiter(options: { now?: () => number } = {}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, limit, windowMs) {
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= current) {
        buckets.set(key, { count: 1, resetAt: current + windowMs });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}

const defaultRateLimiter = createRateLimiter();

/**
 * Serverless instances do not share the in-memory bucket above, so the limit is
 * also checked against the sessions this operator actually created (the source
 * of truth every instance sees).
 */
async function assertOutboundRate(deps: CallActionDeps, actor: CallActor): Promise<void> {
  const limiter = deps.rateLimiter ?? defaultRateLimiter;
  if (!limiter.hit(`dial:${actor.profileId}`, OUTBOUND_RATE_LIMIT.limit, OUTBOUND_RATE_LIMIT.windowMs)) {
    throw new CallActionError("Príliš veľa odchádzajúcich hovorov za minútu.", 429, "rate_limited");
  }
  const since = new Date(nowOf(deps).getTime() - OUTBOUND_RATE_LIMIT.windowMs).toISOString();
  const { count, error } = await deps.admin
    .from("motorist_call_sessions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", deps.organizationId)
    .eq("answered_by_profile_id", actor.profileId)
    .in("direction", ["outbound", "internal"])
    .gte("started_at", since);
  if (error) return; // never block a call on a failing counter
  if ((count ?? 0) >= OUTBOUND_RATE_LIMIT.limit) {
    throw new CallActionError("Príliš veľa odchádzajúcich hovorov za minútu.", 429, "rate_limited");
  }
}

/**
 * The same per-minute ceiling as a dial, on its own bucket: a supervisor
 * flipping between calls creates one leg per round, and nothing else stops a
 * client stuck in a supervise/stop loop.
 *
 * Backed by the legs this supervisor actually created, for the same reason
 * `assertOutboundRate` is: the in-memory bucket lives in one serverless
 * instance, so ten warm instances would otherwise allow ten times the limit.
 */
async function assertSuperviseRate(deps: CallActionDeps, actor: CallActor): Promise<void> {
  const limiter = deps.rateLimiter ?? defaultRateLimiter;
  if (!limiter.hit(`supervise:${actor.profileId}`, OUTBOUND_RATE_LIMIT.limit, OUTBOUND_RATE_LIMIT.windowMs)) {
    throw new CallActionError("Príliš veľa pokusov o dozor za minútu.", 429, "rate_limited");
  }
  const since = new Date(nowOf(deps).getTime() - OUTBOUND_RATE_LIMIT.windowMs).toISOString();
  const { count, error } = await deps.admin
    .from("motorist_call_legs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", deps.organizationId)
    .eq("profile_id", actor.profileId)
    .eq("role", "supervisor")
    .gte("created_at", since);
  if (error) return; // never block on a failing counter
  if ((count ?? 0) >= OUTBOUND_RATE_LIMIT.limit) {
    throw new CallActionError("Príliš veľa pokusov o dozor za minútu.", 429, "rate_limited");
  }
}

/** Refuses operator-initiated legs once the organisation reached its daily soft cap. */
async function assertLegBudget(deps: CallActionDeps): Promise<void> {
  const now = nowOf(deps);
  const [usage, settings] = await Promise.all([loadDailyUsage(deps.admin, { organizationId: deps.organizationId, now }), loadRoutingSettings(deps.admin, deps.organizationId)]);
  if (isOverLegCap(usage, settings.raw?.daily_leg_soft_cap ?? null)) {
    deps.logger?.({ level: "warn", scope: "call-actions", message: "daily leg cap reached", legs: usage.legs, cap: settings.raw?.daily_leg_soft_cap ?? null });
    throw new CallActionError("Denný limit hovorov bol vyčerpaný.", 429, "daily_cap_reached");
  }
}

// --- allowlist ---------------------------------------------------------------

// Re-exported for the existing server callers; the rule itself is shared with
// the browser (settings editors) and therefore lives in `src/lib/telephony`.
export { COUNTRY_DIAL_PREFIXES, isDestinationAllowed } from "@/lib/telephony/destinations";

// --- shared guards -----------------------------------------------------------

const ROLE_RANK: Record<AppRole, number> = { dispatcher: 0, senior_dispatcher: 1, manager: 2, admin: 3 };

export function canControlSession(session: Pick<SessionRow, "answered_by_profile_id">, actor: CallActor, extra: { openLegProfileIds?: string[] } = {}): boolean {
  if (session.answered_by_profile_id === actor.profileId) return true;
  if (extra.openLegProfileIds?.includes(actor.profileId)) return true;
  return ROLE_RANK[actor.role] >= ROLE_RANK.senior_dispatcher;
}

function requireConfigured(deps: CallActionDeps): NonNullable<CallActionDeps["telnyx"]> {
  if (!deps.config.configured || !deps.telnyx) throw new CallActionError(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503, "not_configured");
  return deps.telnyx;
}

function nowOf(deps: CallActionDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function deviceDeps(deps: CallActionDeps): DeviceDeps {
  return { admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment, now: deps.now, deviceKind: deps.deviceKind };
}

async function requireLiveDevice(deps: CallActionDeps, profileId: string, message = "Telefón operátora nie je pripojený."): Promise<DeviceRow & { sipUri: string }> {
  const device = await getOperatorDevice(deviceDeps(deps), { organizationId: deps.organizationId, profileId });
  const sipUri = device ? deviceSipUri(device) : null;
  if (!device || !sipUri || !deviceIsLive(device, nowOf(deps))) throw new CallActionError(message, 409, "device_offline");
  return { ...device, sipUri };
}

export async function loadSession(deps: CallActionDeps, sessionId: string): Promise<SessionRow> {
  if (!isUuid(sessionId)) throw new CallActionError("Hovor sa nenašiel.", 404, "not_found");
  const { data, error } = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", sessionId).maybeSingle();
  if (error) throw new CallActionError(`Hovor sa nepodarilo načítať: ${error.message}`, 500);
  if (!data) throw new CallActionError("Hovor sa nenašiel.", 404, "not_found");
  return data;
}

async function assertOwnership(deps: CallActionDeps, session: SessionRow, actor: CallActor): Promise<void> {
  const legs = await deps.admin.from("motorist_call_legs").select("profile_id").eq("session_id", session.id).neq("role", "supervisor").is("ended_at", null);
  const openLegProfileIds = (legs.data ?? []).map((leg) => leg.profile_id).filter((id): id is string => Boolean(id));
  if (!canControlSession(session, actor, { openLegProfileIds })) {
    throw new CallActionError("Na tento hovor nemáš oprávnenie.", 403, "forbidden");
  }
}

async function normalizeDestination(deps: CallActionDeps, raw: string): Promise<string> {
  const e164 = normalizeE164(raw);
  if (!e164) throw new CallActionError("Neplatné telefónne číslo.", 400, "invalid_number");
  const settings = await loadRoutingSettings(deps.admin, deps.organizationId);
  if (!isDestinationAllowed(e164, settings.raw?.destination_allowlist ?? null)) {
    throw new CallActionError("Cieľové číslo nie je povolené (allowlist).", 403, "destination_not_allowed");
  }
  return e164;
}

async function resolveFromLine(deps: CallActionDeps, profileId: string, lineId: string | null | undefined): Promise<{ line: LineRow | null; from: string }> {
  const { admin, organizationId } = deps;
  let line: LineRow | null = null;
  if (lineId) {
    const { data } = await admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId).eq("id", lineId).eq("active", true).maybeSingle();
    line = data ?? null;
    if (!line) throw new CallActionError("Zvolená linka neexistuje.", 400, "invalid_line");
  } else {
    const settings = await admin.from("motorist_operator_telephony_settings").select("default_from_line_id").eq("profile_id", profileId).maybeSingle();
    if (settings.data?.default_from_line_id) {
      const { data } = await admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId).eq("id", settings.data.default_from_line_id).eq("active", true).maybeSingle();
      line = data ?? null;
    }
  }
  const from = line?.phone_number ?? (deps.config.configured ? deps.config.defaultFromNumber : null);
  if (!from) throw new CallActionError("Chýba odchádzajúce číslo (TELNYX_DEFAULT_FROM_NUMBER).", 500, "missing_from");
  return { line, from };
}

async function resolveTransferTarget(deps: CallActionDeps, actor: CallActor, target: { profileId?: string | null; number?: string | null }): Promise<TransferTarget> {
  if (target.profileId) {
    if (target.profileId === actor.profileId) throw new CallActionError("Hovor nie je možné prepojiť na seba.", 400, "self_transfer");
    const profile = await deps.admin.from("motorist_profiles").select("id, display_name, active").eq("organization_id", deps.organizationId).eq("id", target.profileId).maybeSingle();
    if (!profile.data || !profile.data.active) throw new CallActionError("Kolega sa nenašiel.", 404, "target_not_found");
    const presence = await deps.admin.from("motorist_operator_presence").select("*").eq("profile_id", target.profileId).maybeSingle();
    const allowed = presenceAllowsOffer(
      presence.data ? { profileId: target.profileId, status: effectivePresenceStatus(presence.data, nowOf(deps)), currentSessionId: presence.data.current_session_id, wrapUpUntil: presence.data.wrap_up_until } : undefined,
      nowOf(deps),
    );
    if (!allowed.eligible) throw new CallActionError("Kolega nie je dostupný.", 409, "target_unavailable");
    const device = await requireLiveDevice({ ...deps, deviceKind: "web" }, target.profileId, "Kolega nemá pripojený telefón.");
    return { kind: "operator", profileId: target.profileId, sipUri: device.sipUri, label: profile.data.display_name };
  }
  if (target.number) {
    // A PSTN transfer/consult target is a billable outbound leg: same guards as a dial.
    await assertOutboundRate(deps, actor);
    await assertLegBudget(deps);
    const number = await normalizeDestination(deps, target.number);
    const configured = await deps.admin.from("motorist_operator_telephony_settings").select("profile_id, default_mobile_number").eq("organization_id", deps.organizationId);
    if (configured.error) throw new CallActionError("Vlastníka osobného čísla sa nepodarilo overiť.", 500);
    const owners = new Set((configured.data ?? []).filter(row => normalizeE164(row.default_mobile_number ?? "") === number).map(row => row.profile_id));
    if (owners.size > 1) throw new CallActionError("Osobné číslo má viac vlastníkov. Opravte nastavenie operátorov.", 409, "ambiguous_target_owner");
    const ownerProfileId = [...owners][0];
    if (ownerProfileId) {
      if (ownerProfileId === actor.profileId) throw new CallActionError("Hovor nie je možné prepojiť na seba.", 400, "self_transfer");
      const owner = await deps.admin.from("motorist_operator_presence").select("*").eq("organization_id", deps.organizationId).eq("profile_id", ownerProfileId).maybeSingle();
      if (owner.error) throw new CallActionError("Dostupnosť vlastníka čísla sa nepodarilo overiť.", 500);
      if (!owner.data || effectivePresenceStatus(owner.data, nowOf(deps)) !== "available" || owner.data.current_session_id) throw new CallActionError("Kolega nie je dostupný.", 409, "target_unavailable");
    }
    return { kind: "number", number, label: number, ...(ownerProfileId ? { ownerProfileId } : {}) };
  }
  throw new CallActionError("Chýba cieľ prepojenia.", 400, "missing_target");
}

// --- outbound ----------------------------------------------------------------

export type StartOutboundInput = { to: string; caseId?: string | null; lineId?: string | null; callbackRequestId?: string; callbackTargetVerificationId?: string };
export type StartOutboundResult = { sessionId: string; operatorLegCallControlId: string; telnyxSessionId: string | null; to: string; from: string };

export async function startOutboundCall(deps: CallActionDeps, actor: CallActor, input: StartOutboundInput): Promise<StartOutboundResult> {
  const telnyx = requireConfigured(deps);
  await assertOutboundRate(deps, actor);
  await assertLegBudget(deps);
  const target = await resolveCallbackTarget(deps.admin, deps.organizationId, input.to);
  const confirmed = confirmedCallbackTarget(target, input.callbackTargetVerificationId);
  if (!confirmed) throw new CallActionError(target.status === "blocked" ? "Toto číslo neprijíma spätné volania. Doplňte overený cieľ v adresári." : "Potvrďte overený alternatívny cieľ volania.", 409, "callback_target_confirmation_required");
  const to = await normalizeDestination(deps, confirmed);
  const device = await requireLiveDevice(deps, actor.profileId);
  const { line, from } = await resolveFromLine(deps, actor.profileId, input.lineId);
  const now = nowOf(deps);

  const session = await createSession(deps, {
    direction: "outbound",
    callerNumber: from,
    calledNumber: to,
    lineId: line?.id ?? null,
    caseId: input.caseId ?? null,
    answeredBy: actor.profileId,
    metadata: { ...(input.callbackRequestId ? { callbackRequestId: input.callbackRequestId, effects_v1: { generation: 0 } } : {}), outbound: { to, by: actor.profileId, from, case_id: input.caseId ?? null }, line_label: line?.label ?? null, partner_name: line?.partner_name ?? null },
  });

  if (input.callbackRequestId) {
    const linked = await deps.admin.rpc("motorist_link_callback_outbound_v1", {
      p_organization_id: deps.organizationId, p_request_id: input.callbackRequestId,
      p_session_id: session.id, p_actor_id: actor.profileId,
    });
    if (linked.error || !linked.data) {
      await markSessionFailed(deps, session, "callback_link_rejected");
      throw new CallActionError("Požiadavka už bola vybavená alebo prebieha jej spätné volanie.", 409, "callback_link_rejected");
    }
  }

  const reservation = await reserveOperatorOwnership(deps.admin, { organizationId: deps.organizationId, profileId: actor.profileId, sessionId: session.id });
  if (!reservation.applied) {
    await markSessionFailed(deps, session, "operator_busy");
    throw new CallActionError("Operátor nie je dostupný (prebieha iný hovor).", 409, "operator_busy");
  }

  const dial = {
    kind: "dial" as const,
    commandId: commandId({ sessionId: session.id, legId: actor.profileId, step: 0, intent: "dial:own" }),
    to: device.sipUri,
    from,
    role: "operator" as const,
    profileId: actor.profileId,
    externalNumber: null,
    clientState: { sid: session.id, role: "operator" as const, operatorId: actor.profileId, intent: "outbound", autoAnswer: true, ...(reservation.offerToken ? { offerToken: reservation.offerToken } : {}) },
    linkTo: null,
    timeoutSecs: 30,
    autoAnswer: true,
  };
  try {
    const result = await telnyx.dial({
      commandId: dial.commandId,
      to: dial.to,
      from,
      clientState: encodeState(dial.clientState),
      timeoutSecs: dial.timeoutSecs,
      // Backstop: if this HTTP call times out while Telnyx did create the leg,
      // we never learn its id and could not hang it up.
      timeLimitSecs: LEG_TIME_LIMIT_SECS,
      sipRegion: "Europe",
      mediaEncryption: "SRTP",
      customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }],
      fromDisplayName: actor.displayName?.replace(/[^A-Za-z0-9 \-_~!.+]/g, "").slice(0, 128) || undefined,
    });
    const effects = effectsFor(deps);
    await upsertDialedLeg(effects, session, dial, result);
    const fresh = await loadSession(deps, session.id);
    await upsertCallRow(effects, fresh, { status: "outbound" });
    deps.logger?.({ scope: "call-actions", action: "start_outbound", sessionId: session.id, by: actor.profileId, to, from, ms: nowOf(deps).getTime() - now.getTime() });
    return { sessionId: session.id, operatorLegCallControlId: result.callControlId, telnyxSessionId: result.callSessionId, to, from };
  } catch (error) {
    await markSessionFailed(deps, session, error instanceof TelnyxLiveCallsDisabledError ? "live_calls_disabled" : "dial_failed");
    await releaseOperator(deps.admin, { profileId: actor.profileId, sessionId: session.id, status: "available", now: nowOf(deps), expectedToken: reservation.offerToken ?? undefined, expectedRevision: reservation.revision });
    throw toActionError(error, "Hovor sa nepodarilo vytočiť.");
  }
}

export async function callColleague(deps: CallActionDeps, actor: CallActor, input: { targetProfileId: string }): Promise<StartOutboundResult> {
  const telnyx = requireConfigured(deps);
  if (input.targetProfileId === actor.profileId) throw new CallActionError("Nie je možné volať sám sebe.", 400, "self_call");
  await assertOutboundRate(deps, actor);
  await assertLegBudget(deps);
  const target = await resolveTransferTarget(deps, actor, { profileId: input.targetProfileId });
  if (target.kind !== "operator") throw new CallActionError("Kolega sa nenašiel.", 404);
  const device = await requireLiveDevice(deps, actor.profileId);
  const { line, from } = await resolveFromLine(deps, actor.profileId, null);

  const session = await createSession(deps, {
    direction: "internal",
    callerNumber: from,
    calledNumber: target.sipUri,
    lineId: line?.id ?? null,
    caseId: null,
    answeredBy: actor.profileId,
    metadata: { internal: { target_profile_id: target.profileId, target_sip: target.sipUri, by: actor.profileId }, line_label: line?.label ?? null },
  });
  const reservation = await reserveOperatorOwnership(deps.admin, { organizationId: deps.organizationId, profileId: actor.profileId, sessionId: session.id });
  if (!reservation.applied) {
    await markSessionFailed(deps, session, "operator_busy");
    throw new CallActionError("Operátor nie je dostupný (prebieha iný hovor).", 409, "operator_busy");
  }
  const dial = {
    kind: "dial" as const,
    commandId: commandId({ sessionId: session.id, legId: actor.profileId, step: 0, intent: "dial:own" }),
    to: device.sipUri,
    from,
    role: "operator" as const,
    profileId: actor.profileId,
    externalNumber: null,
    clientState: { sid: session.id, role: "operator" as const, operatorId: actor.profileId, intent: "internal_caller", autoAnswer: true, ...(reservation.offerToken ? { offerToken: reservation.offerToken } : {}) },
    linkTo: null,
    timeoutSecs: 30,
    autoAnswer: true,
  };
  try {
    const result = await telnyx.dial({
      commandId: dial.commandId,
      to: dial.to,
      from,
      clientState: encodeState(dial.clientState),
      timeoutSecs: dial.timeoutSecs,
      // Backstop: if this HTTP call times out while Telnyx did create the leg,
      // we never learn its id and could not hang it up.
      timeLimitSecs: LEG_TIME_LIMIT_SECS,
      sipRegion: "Europe",
      mediaEncryption: "SRTP",
      customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }],
    });
    const effects = effectsFor(deps);
    await upsertDialedLeg(effects, session, dial, result);
    const fresh = await loadSession(deps, session.id);
    await upsertCallRow(effects, fresh, { status: "outbound" });
    return { sessionId: session.id, operatorLegCallControlId: result.callControlId, telnyxSessionId: result.callSessionId, to: target.sipUri, from };
  } catch (error) {
    await markSessionFailed(deps, session, error instanceof TelnyxLiveCallsDisabledError ? "live_calls_disabled" : "dial_failed");
    await releaseOperator(deps.admin, { profileId: actor.profileId, sessionId: session.id, status: "available", now: nowOf(deps), expectedToken: reservation.offerToken ?? undefined, expectedRevision: reservation.revision });
    throw toActionError(error, "Interný hovor sa nepodarilo vytočiť.");
  }
}

// --- in-call actions ---------------------------------------------------------

export type CallActionResult = {
  sessionId: string;
  state: SessionRow["state"];
  commands: Array<{ kind: string; ok: boolean; error: string | null }>;
  ignored: string | null;
  /**
   * Call-control id of an operator leg this action dialled (pickup). The tab
   * needs it to auto-answer exactly that invite (design §2.2) instead of
   * trusting the `X-PM-Auto-Answer` header alone.
   */
  operatorLegCallControlId?: string;
};

/** `detail.callControlId` of the first successful `dial` command of a transition. */
function dialedLegCallControlId(commands: CommandOutcome[]): string | undefined {
  for (const command of commands) {
    if (command.kind !== "dial" || !command.ok) continue;
    const id = command.detail?.callControlId;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

async function runAction(deps: CallActionDeps, session: SessionRow, event: AppEvent, failureMessage: string): Promise<CallActionResult> {
  requireConfigured(deps);
  let run: SessionRunResult;
  try {
    run = await runSessionEvent(deps, session.id, event);
  } catch (error) {
    if (error instanceof CallActionRejected) throw new CallActionError(error.message, error.status, error.code ?? "rejected");
    throw toActionError(error, failureMessage);
  }
  if (run.outcome === "ignored") return { sessionId: session.id, state: run.session.state, commands: [], ignored: run.reason };
  const commands = run.commands.map((command) => ({ kind: command.kind, ok: command.ok, error: command.error }));
  if (run.apply.failed) {
    // The caller hung up in the second before the button was pressed. That is an
    // ordinary end of a call, so the operator gets a plain sentence and a 409,
    // not a provider error code and a 502.
    if (run.apply.failure?.callGone) {
      throw new CallActionError("Hovor už medzitým skončil.", 409, "call_gone");
    }
    if (run.apply.failure?.prerequisiteRejected) {
      throw new CallActionError("Cieľ hovoru už nie je dostupný. Vyberte iného operátora.", 409, "target_unavailable");
    }
    throw new CallActionError(`${failureMessage} (${run.apply.failure?.error ?? "neznáma chyba"})`, 502, "command_failed");
  }
  return { sessionId: session.id, state: run.session.state, commands, ignored: null, operatorLegCallControlId: dialedLegCallControlId(run.commands) };
}

function appEvent(type: AppEventType, actor: CallActor | null, deps: CallActionDeps, extra: Partial<AppEvent> = {}): AppEvent {
  return { kind: "app", id: randomUUID(), type, actorProfileId: actor?.profileId ?? null, occurredAt: nowOf(deps).toISOString(), ...extra };
}

async function ownedActiveSession(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<SessionRow> {
  const session = await loadSession(deps, sessionId);
  if (!ACTIVE_SESSION_STATES.has(session.state)) throw new CallActionError("Hovor už nie je aktívny.", 409, "not_active");
  await assertOwnership(deps, session, actor);
  return session;
}

export async function holdCall(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  return runAction(deps, session, appEvent("hold", actor, deps), "Podržanie hovoru zlyhalo. Rozšírené funkcie hovoru nie sú dostupné.");
}

/** An objection survives holds, transfers and retries for this logical call. */
export async function stopCallRecording(deps: CallActionDeps, actor: CallActor, sessionId: string, retry = false): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  return runAction(deps, session, appEvent(retry ? "recording_retry_stop" : "recording_stop", actor, deps), "Vypnutie nahrávania nie je potvrdené. Súkromnú konzultáciu zatiaľ nezačínajte.");
}

/** Server-only policy convergence; the resolver must confirm capture is disabled. */
export async function reconcileCallRecordingPolicy(deps: CallActionDeps, sessionId: string): Promise<SessionRunResult> {
  const session = await loadSession(deps, sessionId);
  return runSessionEvent(deps, session.id, { kind: "app", id: randomUUID(), type: "recording_policy_stop", actorProfileId: null, occurredAt: nowOf(deps).toISOString() });
}

export async function unholdCall(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  return runAction(deps, session, appEvent("unhold", actor, deps), "Obnovenie hovoru zlyhalo.");
}

export async function parkCall(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  return runAction(deps, session, appEvent("park", actor, deps), "Zaparkovanie hovoru zlyhalo.");
}

export async function hangupCall(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  return runAction(deps, session, appEvent("hangup", actor, deps), "Ukončenie hovoru zlyhalo.");
}

export async function blindTransfer(deps: CallActionDeps, actor: CallActor, sessionId: string, target: { profileId?: string | null; number?: string | null }): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  const resolved = await resolveTransferTarget(deps, actor, target);
  return runAction(deps, session, appEvent("blind_transfer", actor, deps, { target: resolved }), "Prepojenie zlyhalo.");
}

export async function startConsult(deps: CallActionDeps, actor: CallActor, sessionId: string, target: { profileId?: string | null; number?: string | null }): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  const resolved = await resolveTransferTarget(deps, actor, target);
  return runAction(deps, session, appEvent("consult", actor, deps, { target: resolved }), "Konzultáciu sa nepodarilo začať.");
}

export async function completeTransfer(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  return runAction(deps, session, appEvent("complete_transfer", actor, deps), "Dokončenie prepojenia zlyhalo.");
}

export async function cancelConsult(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  const session = await ownedActiveSession(deps, actor, sessionId);
  return runAction(deps, session, appEvent("cancel_consult", actor, deps), "Zrušenie konzultácie zlyhalo.");
}

export async function pickupWaitingCall(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  requireConfigured(deps);
  await assertLegBudget(deps);
  const session = await loadSession(deps, sessionId);
  const priorPickup = session.presence_pickup as { profileId?: string } | null;
  const resumingOwnPickup = priorPickup?.profileId === actor.profileId && (!session.answered_by_profile_id || session.answered_by_profile_id === actor.profileId);
  if (deps.deviceKind !== "mobile" && !resumingOwnPickup && !canPickUpCall({ state: session.state, direction: session.direction, answered: Boolean(session.answered_at), operatorProfileId: session.answered_by_profile_id })) {
    throw new CallActionError("Hovor už nie je možné prevziať.", 409, "not_waiting");
  }
  const presence = await deps.admin.from("motorist_operator_presence").select("*").eq("organization_id", session.organization_id).eq("profile_id", actor.profileId).maybeSingle();
  if (presence.error) throw new CallActionError(`Prezenciu sa nepodarilo overiť: ${presence.error.message}`, 500);
  const device = await requireLiveDevice(deps, actor.profileId);
  const continuingOwnership = presence.data?.current_session_id === sessionId && Boolean(presence.data?.pause_return || presence.data?.offer_token);
  // Schema compatibility is independent of new-feature admission. In particular,
  // creation-off still requires availability; it must nevertheless retain the
  // token created by the migrated reservation RPC before dialing the picker.
  if (!telephonyStabilityEnabled() && !continuingOwnership) {
    const allowed = presenceAllowsOffer(presence.data ? { profileId: actor.profileId,
      status: presence.data.status, currentSessionId: presence.data.current_session_id,
      wrapUpUntil: presence.data.wrap_up_until, pauseReturn: presence.data.pause_return } : undefined, nowOf(deps), session.id);
    if (!allowed.eligible) throw new CallActionError("Prevziať hovor je možné len v stave dostupný.", 409, "operator_unavailable");
  }
  // A legacy automatic offer already owns this session without a token. Keep
  // that identity when its browser/mobile accepts; a second dispatch cannot
  // take over its current_session_id. New pickups must acquire before dialing.
  const needsTokenizedPickup = presence.data?.presence_revision !== undefined && !presence.data.current_session_id;
  if (telephonyStabilityEnabled() || needsTokenizedPickup || continuingOwnership) {
    const reservation = await reserveOperatorPickup(deps.admin, { organizationId: session.organization_id,
      profileId: actor.profileId, sessionId, expectedRevision: presence.data?.presence_revision });
    if (!reservation.applied) throw new CallActionError("Operátor alebo hovor už má inú rezerváciu.", 409, "operator_unavailable");
    if (reservation.reused) {
      const fresh = await loadSession(deps, sessionId);
      const claim = fresh.presence_pickup as { profileId?: string; offerToken?: string } | null;
      if (claim?.profileId === actor.profileId && claim.offerToken === reservation.offerToken) {
        const legs = await deps.admin.from("motorist_call_legs").select("telnyx_call_control_id, client_state").eq("session_id", sessionId).eq("profile_id", actor.profileId).is("ended_at", null);
        if (legs.error) throw new CallActionError("Prevzatie sa nepodarilo načítať.", 500);
        const leg = legs.data?.find(row => {
          const state = row.client_state as { intent?: string; offerToken?: string } | null;
          return state?.intent === "pickup" && state.offerToken === reservation.offerToken;
        });
        return { sessionId, state: fresh.state, commands: [], ignored: "pickup_in_progress", operatorLegCallControlId: leg?.telnyx_call_control_id };
      }
    }
    try {
      return await runAction(deps, session, appEvent("pickup", actor, deps, { picker: { profileId: actor.profileId,
        sipUri: device.sipUri, offerToken: reservation.offerToken ?? undefined, ...(deps.deviceKind === "mobile" ? { mobile: true } : {}) } }), "Prevzatie hovoru zlyhalo.");
    } catch (error) {
      // Revision + token prevent an old failed click from releasing a winner.
      if (!reservation.reused) await releaseOperatorPresence(deps.admin, { organizationId: session.organization_id, profileId: actor.profileId,
        sessionId, status: "available", expectedToken: reservation.offerToken, expectedRevision: reservation.revision });
      throw error;
    }
  }
  const allowed = presenceAllowsOffer(
    presence.data ? { profileId: actor.profileId, status: effectivePresenceStatus(presence.data, nowOf(deps)), currentSessionId: presence.data.current_session_id, wrapUpUntil: presence.data.wrap_up_until } : undefined,
    nowOf(deps), session.id,
  );
  if (!allowed.eligible) throw new CallActionError("Prevziať hovor je možné len v stave dostupný.", 409, "operator_unavailable");
  return runAction(deps, session, appEvent("pickup", actor, deps, { picker: { profileId: actor.profileId, sipUri: device.sipUri, ...(deps.deviceKind === "mobile" ? { mobile: true } : {}) } }), "Prevzatie hovoru zlyhalo.");
}

// --- conference and supervision ---------------------------------------------

// One source of truth with the console (`PhoneBar` hides the action for the
// roles this refuses), re-exported so the server callers keep one import.
export { canSuperviseRole as canSupervise, SUPERVISOR_ROLES } from "@/lib/telephony/supervisor-mode";

/**
 * Audit trail for the conference and supervision actions (design §4 Phase 4:
 * "every supervision writes an audit row"). The row itself is written by
 * `audit.ts`, which the session runner shares so a supervision that ends
 * without anybody clicking still produces its closing row.
 */
async function auditAction(
  deps: CallActionDeps,
  actor: CallActor,
  input: { action: string; sessionId: string; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null },
): Promise<void> {
  await writeCallAudit(deps, { action: input.action, actorProfileId: actor.profileId, entityId: input.sessionId, before: input.before, after: input.after });
}

/**
 * The session for a conference action, with the tighter ownership rule those
 * actions need.
 *
 * `ownedActiveSession` lets any senior dispatcher act on any live call, which
 * is right for the visible, destructive actions (hang up, transfer) but wrong
 * here: adding a leg and muting it is silent listening, and silent listening is
 * `superviseCall`, which is manager/admin only and writes a supervision audit
 * row. So a conference action requires the actor to be *on* the call — they
 * answered it or they hold an open leg — and anybody else has to clear the
 * supervision bar.
 */
async function conferenceSession(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<SessionRow> {
  const session = await loadSession(deps, sessionId);
  if (!ACTIVE_SESSION_STATES.has(session.state)) throw new CallActionError("Hovor už nie je aktívny.", 409, "not_active");
  if (session.answered_by_profile_id === actor.profileId) return session;
  const legs = await deps.admin.from("motorist_call_legs").select("profile_id").eq("session_id", session.id).neq("role", "supervisor").is("ended_at", null);
  const openLegProfileIds = (legs.data ?? []).map((leg) => leg.profile_id).filter((id): id is string => Boolean(id));
  if (openLegProfileIds.includes(actor.profileId)) return session;
  if (canSuperviseRole(actor.role)) return session;
  throw new CallActionError("Účastníkov hovoru môže meniť len operátor na tomto hovore.", 403, "forbidden");
}

/** An open leg of this session, addressed by its row id (never by a call-control id from the browser). */
async function loadSessionLeg(deps: CallActionDeps, sessionId: string, legId: string): Promise<LegRow> {
  if (!isUuid(legId)) throw new CallActionError("Účastník už nie je v hovore.", 404, "party_not_found");
  const { data, error } = await deps.admin.from("motorist_call_legs").select("*").eq("session_id", sessionId).eq("id", legId).maybeSingle();
  if (error) throw new CallActionError(`Účastníka sa nepodarilo načítať: ${error.message}`, 500);
  if (!data || data.ended_at) throw new CallActionError("Účastník už nie je v hovore.", 404, "party_not_found");
  return data;
}

async function partyLabel(deps: CallActionDeps, leg: LegRow): Promise<string> {
  if (leg.profile_id) {
    const { data } = await deps.admin.from("motorist_profiles").select("display_name").eq("id", leg.profile_id).maybeSingle();
    if (data?.display_name) return data.display_name;
  }
  return leg.to_number ?? leg.from_number ?? "Účastník";
}

/** Adds a colleague or an external number to the live call as a third party. */
export async function addCallParty(deps: CallActionDeps, actor: CallActor, sessionId: string, target: { profileId?: string | null; number?: string | null }): Promise<CallActionResult> {
  const session = await conferenceSession(deps, actor, sessionId);
  const resolved = await resolveTransferTarget(deps, actor, target);
  const result = await runAction(deps, session, appEvent("add_party", actor, deps, { target: resolved }), "Účastníka sa nepodarilo pridať.");
  await auditAction(deps, actor, { action: "telephony.conference.add_party", sessionId, after: { target: resolved.label, kind: resolved.kind } });
  return result;
}

/** Mutes or unmutes one added participant of the conference. */
export async function setCallPartyMuted(deps: CallActionDeps, actor: CallActor, sessionId: string, legId: string, muted: boolean): Promise<CallActionResult> {
  const session = await conferenceSession(deps, actor, sessionId);
  const leg = await loadSessionLeg(deps, sessionId, legId);
  const label = await partyLabel(deps, leg);
  const result = await runAction(
    deps,
    session,
    appEvent(muted ? "mute_party" : "unmute_party", actor, deps, { party: { callControlId: leg.telnyx_call_control_id, label } }),
    muted ? "Účastníka sa nepodarilo stlmiť." : "Účastníka sa nepodarilo odtlmiť.",
  );
  await auditAction(deps, actor, { action: muted ? "telephony.conference.mute_party" : "telephony.conference.unmute_party", sessionId, before: { muted: !muted }, after: { participant: label, muted } });
  return result;
}

/** Removes an added participant from the call (their leg leaves the conference and hangs up). */
export async function removeCallParty(deps: CallActionDeps, actor: CallActor, sessionId: string, legId: string): Promise<CallActionResult> {
  const session = await conferenceSession(deps, actor, sessionId);
  const leg = await loadSessionLeg(deps, sessionId, legId);
  const label = await partyLabel(deps, leg);
  const result = await runAction(deps, session, appEvent("remove_party", actor, deps, { party: { callControlId: leg.telnyx_call_control_id, label } }), "Účastníka sa nepodarilo odpojiť.");
  await auditAction(deps, actor, { action: "telephony.conference.remove_party", sessionId, after: { participant: label } });
  return result;
}

/** The operator steps out of a three-way; the caller and the remaining party keep talking. */
export async function leaveConferenceCall(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  const session = await conferenceSession(deps, actor, sessionId);
  // Unlike the other conference actions, this one is not "change a participant"
  // but "remove *me*": the reducer always takes the answering operator's leg
  // out. A manager or a supervisor passing the bar above would therefore eject
  // the dispatcher who is on the call and sign the audit row with their own
  // name. Only the operator on the call may leave it.
  if (session.answered_by_profile_id !== actor.profileId) {
    throw new CallActionError("Z konferencie môže odísť len operátor, ktorý je na hovore.", 403, "forbidden");
  }
  const result = await runAction(deps, session, appEvent("leave_conference", actor, deps), "Z konferencie sa nepodarilo odísť.");
  await auditAction(deps, actor, { action: "telephony.conference.leave", sessionId, after: { state: result.state } });
  return result;
}

/**
 * Starts (or re-points) supervision of somebody else's live call.
 *
 * Manager/admin only. The supervisor's own browser phone is dialled and joins
 * the call's conference with the Telnyx `supervisor_role`: `monitor` listens,
 * `whisper` is heard only by the operator, `barge` by everyone. Their presence
 * is reserved best-effort so an *available* supervisor is not offered a call
 * mid-supervision — a manager who is paused or logged out may still supervise.
 */
export async function superviseCall(deps: CallActionDeps, actor: CallActor, sessionId: string, mode: SupervisorMode, invitationId?: string): Promise<CallActionResult> {
  requireConfigured(deps);
  if (invitationId) {
    await requireMonitorInvitations(deps);
    if (mode !== "monitor") throw new CallActionError("Pozvaný poslucháč smie iba počúvať.", 403, "monitor_only");
    await requireActiveMonitorProfile(deps, actor.profileId);
  }
  if (!invitationId && !canSuperviseRole(actor.role)) throw new CallActionError("Dozor nad hovorom je dostupný len pre manažéra alebo administrátora.", 403, "forbidden");
  const session = await loadSession(deps, sessionId);
  if (!TALKING_STATES.has(session.state)) throw new CallActionError("Dozor je možný len pri prebiehajúcom hovore.", 409, "not_active");
  if (invitationId) {
    const invitation = (session.metadata as import("./state/types").SessionMeta).monitorInvitations?.[invitationId];
    if (!invitation || invitation.recipientProfileId !== actor.profileId || invitation.acceptedAt || invitation.revokedAt || Date.parse(invitation.expiresAt) <= nowOf(deps).getTime()) {
      throw new CallActionError("Pozvánka už nie je platná alebo bola použitá.", 403, "invitation_invalid");
    }
  }
  if (session.answered_by_profile_id === actor.profileId) throw new CallActionError("Na vlastný hovor sa dozerať nedá.", 409, "own_call");
  // A call whose operator already stepped out (a three-way handed over to an
  // external number) has nobody to whisper to: the remaining leg is the outside
  // party, and whispering to them would put the manager in the caller's ear.
  if (!session.answered_by_profile_id) throw new CallActionError("Hovor nemá pripojeného operátora.", 409, "no_operator");
  // Supervision dials a real leg, so it is inside the same budgets as every
  // other operator-initiated leg: the daily soft cap and a per-supervisor rate
  // limit (its own bucket, so listening in does not eat an operator's dials).
  await assertSuperviseRate(deps, actor);
  await assertLegBudget(deps);
  const device = await requireLiveDevice(deps, actor.profileId, "Tvoj telefón nie je pripojený.");

  const already = await deps.admin.from("motorist_call_legs").select("id").eq("session_id", sessionId).eq("profile_id", actor.profileId).eq("role", "supervisor").is("ended_at", null).maybeSingle();
  let reservation: PresenceTransitionResult = { applied: false };
  if (!already.data) {
    // Best effort: a paused or logged-out manager is still allowed to supervise,
    // an available one is taken out of the ring plan while they listen.
    try {
      reservation = await reserveOperatorOwnership(deps.admin, { organizationId: deps.organizationId, profileId: actor.profileId, sessionId });
    } catch (error) {
      deps.logger?.({ level: "warn", scope: "call-actions", message: "supervisor reservation failed", sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (invitationId && !already.data && !reservation.applied) throw new CallActionError("Tvoj telefón je obsadený iným hovorom.", 409, "operator_busy");

  try {
    const result = await runAction(
      deps,
      session,
      appEvent("supervise", actor, deps, { supervisor: { profileId: actor.profileId, sipUri: device.sipUri, mode, label: actor.displayName ?? actor.profileId, ...(invitationId ? { invitationId } : {}), ...(reservation.offerToken ? { offerToken: reservation.offerToken } : {}) } }),
      "Dozor nad hovorom sa nepodarilo spustiť.",
    );
    await auditAction(deps, actor, {
      action: already.data ? "telephony.supervise.switch" : "telephony.supervise.start",
      sessionId,
      after: { mode, operator: session.answered_by_profile_id, supervisor: actor.profileId },
    });
    return result;
  } catch (error) {
    if (reservation.applied && !reservation.reused) await releaseOperator(deps.admin, { profileId: actor.profileId, sessionId, status: "available", now: nowOf(deps), expectedToken: reservation.offerToken ?? undefined, expectedRevision: reservation.revision });
    throw error;
  }
}

/** Ends this supervisor's own supervision of the call. */
export async function stopSupervisingCall(deps: CallActionDeps, actor: CallActor, sessionId: string): Promise<CallActionResult> {
  requireConfigured(deps);
  const session = await loadSession(deps, sessionId);
  const meta = session.metadata as import("./state/types").SessionMeta;
  if (!canSuperviseRole(actor.role) && !Object.values(meta.monitorInvitations ?? {}).some(item => item.recipientProfileId === actor.profileId && item.acceptedAt)) {
    throw new CallActionError("Na ukončenie tohto počúvania nemáš oprávnenie.", 403, "forbidden");
  }
  // No audit row here: `telephony.supervise.stop` is written by the session
  // runner for *every* way a supervision ends (this button, the supervisor's
  // browser leg dropping, the call ending under them, a refused conference
  // join), so the log can answer "how long did the manager listen".
  return runAction(deps, session, appEvent("stop_supervise", actor, deps, { supervisor: { profileId: actor.profileId, sipUri: "", mode: "monitor", label: actor.displayName ?? actor.profileId } }), "Dozor sa nepodarilo ukončiť.");
}

async function requireActiveMonitorProfile(deps: CallActionDeps, profileId: string) {
  if (!isUuid(profileId)) throw new CallActionError("Operátor sa nenašiel.", 404);
  const { data, error } = await deps.admin.from("motorist_profiles").select("id, display_name, role, active, access_status")
    .eq("organization_id", deps.organizationId).eq("id", profileId).maybeSingle();
  if (error || !data?.active || data.access_status !== "active" || !["dispatcher", "senior_dispatcher", "manager", "admin"].includes(data.role)) {
    throw new CallActionError("Operátor nie je aktívny v tejto organizácii.", 403, "recipient_unavailable");
  }
  return data;
}

export async function inviteCallMonitor(deps: CallActionDeps, actor: CallActor, sessionId: string, recipientProfileId: string): Promise<CallActionResult> {
  await requireMonitorInvitations(deps);
  const session = await conferenceSession(deps, actor, sessionId);
  if (recipientProfileId === actor.profileId) throw new CallActionError("Nemôžeš pozvať seba.", 400);
  const recipient = await requireActiveMonitorProfile(deps, recipientProfileId);
  await requireLiveDevice(deps, recipientProfileId, "Telefón poslucháča nie je pripojený.");
  const now = nowOf(deps);
  return runAction(deps, session, appEvent("invite_monitor", actor, deps, { monitorInvitation: {
    id: randomUUID(), sessionId, inviterProfileId: actor.profileId, inviterName: actor.displayName ?? actor.profileId,
    recipientProfileId, recipientName: recipient.display_name, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + MONITOR_INVITATION_TTL_MS).toISOString(),
  } }), "Pozvánku sa nepodarilo vytvoriť.");
}

export async function revokeCallMonitorInvitation(deps: CallActionDeps, actor: CallActor, sessionId: string, invitationId: string): Promise<CallActionResult> {
  // Revocation remains possible after the feature is disabled.
  const session = await loadSession(deps, sessionId);
  return runAction(deps, session, appEvent("revoke_monitor", actor, deps, { invitationId }), "Poslucháča sa nepodarilo odpojiť.");
}

export type TransferTargetOption = { profileId: string; displayName: string; role: AppRole; available: boolean; status: string; deviceLive: boolean };

/** Colleagues that can receive a transfer/consult right now (plus the rest, flagged unavailable). */
export async function listTransferTargets(deps: CallActionDeps, actor: CallActor): Promise<TransferTargetOption[]> {
  const { admin, organizationId } = deps;
  const now = nowOf(deps);
  const [profiles, presence, devices] = await Promise.all([
    admin.from("motorist_profiles").select("id, display_name, role, active").eq("organization_id", organizationId).eq("active", true),
    admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId),
    admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId).eq("environment", deps.environment),
  ]);
  const presenceById = new Map((presence.data ?? []).map((row) => [row.profile_id, row]));
  const deviceById = new Map((devices.data ?? []).map((row) => [row.profile_id, row]));
  return (profiles.data ?? [])
    .filter((profile) => profile.id !== actor.profileId)
    .map((profile) => {
      const row = presenceById.get(profile.id);
      const device = deviceById.get(profile.id) ?? null;
      const live = deviceIsLive(device, now);
      const allowed = row ? presenceAllowsOffer({ profileId: profile.id, status: effectivePresenceStatus(row, now), currentSessionId: row.current_session_id, wrapUpUntil: row.wrap_up_until }, now) : { eligible: false as const, reason: "no_presence" as const };
      return { profileId: profile.id, displayName: profile.display_name, role: profile.role, available: allowed.eligible && live, status: row ? effectivePresenceStatus(row, now) : "offline", deviceLive: live };
    })
    .sort((left, right) => Number(right.available) - Number(left.available) || left.displayName.localeCompare(right.displayName, "sk"));
}

// --- internals ---------------------------------------------------------------

function encodeState(state: { sid: string; role: "operator"; operatorId: string; intent: string; autoAnswer: boolean; offerToken?: string }): string {
  return encodeClientState(state);
}

function effectsFor(deps: CallActionDeps) {
  return effectsDeps(deps);
}

async function createSession(
  deps: CallActionDeps,
  input: {
    direction: "outbound" | "internal";
    callerNumber: string;
    calledNumber: string;
    lineId: string | null;
    caseId: string | null;
    answeredBy: string;
    metadata: Record<string, unknown>;
  },
): Promise<SessionRow> {
  const inserted = await deps.admin
    .from("motorist_call_sessions")
    .insert({
      organization_id: deps.organizationId,
      direction: input.direction,
      state: "received",
      version: 0,
      current_step: 0,
      line_id: input.lineId,
      case_id: input.caseId,
      answered_by_profile_id: input.answeredBy,
      caller_number: input.callerNumber,
      called_number: input.calledNumber,
      started_at: nowOf(deps).toISOString(),
      metadata: toJson({ ...input.metadata, environment: deps.environment }),
    })
    .select("*")
    .single();
  if (inserted.error) throw new CallActionError(`Hovor sa nepodarilo založiť: ${inserted.error.message}`, 500);
  return inserted.data;
}

async function markSessionFailed(deps: CallActionDeps, session: SessionRow, reason: string): Promise<void> {
  const now = nowOf(deps).toISOString();
  await deps.admin.from("motorist_call_sessions").update({ state: "failed", ended_at: now, metadata: toJson({ ...(session.metadata as object), failure: reason }) }).eq("id", session.id);
  // Close any leg the failed attempt left open: an open leg row counts against
  // the org-wide `max_concurrent_legs` gate until something ends it.
  await deps.admin.from("motorist_call_legs").update({ state: "ended", ended_at: now, hangup_cause: reason }).eq("session_id", session.id).is("ended_at", null);
  await upsertCallRow(effectsFor(deps), { ...session, state: "failed", ended_at: now }, { status: "failed", end_reason: reason });
}

function toActionError(error: unknown, fallback: string): CallActionError {
  if (error instanceof CallActionError) return error;
  if (error instanceof TelnyxLiveCallsDisabledError) return new CallActionError(error.message, 423, "live_calls_disabled");
  if (error instanceof TelnyxCommandError) return new CallActionError(`${fallback} (${error.code})`, 502, error.code);
  return new CallActionError(error instanceof Error ? `${fallback} (${error.message})` : fallback, 500);
}
