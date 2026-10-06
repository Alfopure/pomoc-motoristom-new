import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAppEnvironment, isTestLiveDeployment, resolveAppEnvironment } from "@/lib/app-environment";
import type { Database } from "@/lib/supabase/database.types";
import { alertObject } from "./alert-evidence";
import type { TelephonyHealthCheck } from "./health";
import { getTelnyxConfig } from "./telnyx/env";

export const CALL_INTERRUPTION_GRACE_MS = 5 * 60_000;
const MAX_INCIDENTS = 20;
const MAX_PROVENANCE = 80;
const READ_BUDGET_MS = 1_500;

export type CallInterruptionConfiguration = {
  environment: "production" | "test";
  since: string;
  testConnectionIds: string[];
  testCallControlAppId: string | null;
};

/** An explicit activation boundary prevents copied or pre-pilot calls from generating mail. */
export function callInterruptionConfiguration(env: Record<string, string | undefined> = process.env): CallInterruptionConfiguration | null {
  try {
    assertAppEnvironment(env);
    if (env.DIAGNOSTICS_CLASSIFIER_ENABLED !== "true" || env.VERCEL_ENV !== "production") return null;
    const raw = env.DIAGNOSTICS_CALL_ALERTS_SINCE;
    if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) return null;
    const since = new Date(raw).toISOString();
    const environment = resolveAppEnvironment(env);
    if (environment === "test") {
      if (!isTestLiveDeployment(env)) return null;
      const config = getTelnyxConfig(env);
      if (!config.configured || !config.callControlAppId) return null;
      return { environment, since, testConnectionIds: [config.callControlAppId, config.credentialConnectionId].filter((id): id is string => Boolean(id)), testCallControlAppId: config.callControlAppId };
    }
    if (environment !== "production" || env.VERCEL_GIT_COMMIT_REF !== "main" || env.APP_BASE_URL !== "https://dispecing.linkapomoci.sk") return null;
    return { environment, since, testConnectionIds: [], testCallControlAppId: null };
  } catch { return null; }
}

function timestamp(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function near(value: unknown, endedAt: number, beforeMs = 30_000): boolean {
  const at = timestamp(value);
  return at !== null && at >= endedAt - beforeMs && at <= endedAt + 1_000;
}

export type ConfirmedCallInterruption = {
  incidentId: string; sessionId: string; legId: string;
  interruptedAt: string; classifiedAt: string;
  environment: "production" | "test"; classification: "interruption_observed";
};

/** Bounded read-only corroboration: classification is evidence, never permission to trust copied TEST IDs. */
export async function getCallInterruptionHealth(deps: {
  admin: SupabaseClient<Database>; organizationId: string; now: Date;
  configuration?: CallInterruptionConfiguration | null;
}): Promise<TelephonyHealthCheck> {
  const configuration = deps.configuration === undefined ? callInterruptionConfiguration() : deps.configuration;
  if (!configuration) return { key: "interruptions", status: "skipped", detail: { reason: "not_activated", entries: [] } };
  const { environment } = configuration;
  const now = deps.now.getTime();
  if (Date.parse(configuration.since) > now) return { key: "interruptions", status: "skipped", detail: { reason: "activation_pending", entries: [] } };
  const since = new Date(Math.max(Date.parse(configuration.since), now - 24 * 60 * 60_000)).toISOString();
  const signal = AbortSignal.timeout(READ_BUDGET_MS);
  const unavailable = (reason: string): TelephonyHealthCheck => ({ key: "interruptions", status: "warn", detail: { environment, since, reason, entries: [], error: "interruption_evidence_unavailable" } });
  try {
    const incidents = await deps.admin.from("motorist_diagnostic_incidents")
      .select("id, call_session_id, leg_id, first_seen_at, classified_at")
      .eq("organization_id", deps.organizationId).eq("environment", environment)
      .eq("kind", "call_interruption").eq("classification", "interruption_observed")
      .in("status", ["new", "acknowledged"]).gte("first_seen_at", since)
      .lte("first_seen_at", new Date(now - CALL_INTERRUPTION_GRACE_MS).toISOString())
      .gte("classified_at", new Date(now - 10 * 60_000).toISOString())
      .order("first_seen_at", { ascending: false }).limit(MAX_INCIDENTS + 1).abortSignal(signal);
    if (incidents.error) return unavailable("incident_read_failed");
    const truncated = (incidents.data?.length ?? 0) > MAX_INCIDENTS;
    // At least one classifier pass must have incorporated evidence after the grace period.
    const candidates = (incidents.data ?? []).slice(0, MAX_INCIDENTS).filter(row => row.call_session_id && row.leg_id &&
      timestamp(row.classified_at) !== null && Date.parse(row.classified_at!) <= now &&
      Date.parse(row.classified_at!) >= Date.parse(row.first_seen_at) + CALL_INTERRUPTION_GRACE_MS);
    const empty = (): TelephonyHealthCheck => ({ key: "interruptions", status: truncated ? "warn" : "ok", detail: { environment, since, truncated, confirmed: 0, entries: [] } });
    if (!candidates.length) return empty();
    const sessionIds = [...new Set(candidates.map(row => row.call_session_id!))];
    const [sessions, operators] = await Promise.all([
      deps.admin.from("motorist_call_sessions").select("id, metadata, direction, customer_leg_id, termination_requested_at, parked_at, hold_started_at, telnyx_session_id")
        .eq("organization_id", deps.organizationId).in("id", sessionIds).contains("metadata", { environment: environment === "production" ? "production" : "development" })
        .limit(MAX_INCIDENTS).abortSignal(signal),
      deps.admin.from("motorist_call_legs").select("id, session_id, profile_id, role, bridged_at, ended_at, telnyx_call_control_id")
        .eq("organization_id", deps.organizationId).in("session_id", sessionIds).limit(MAX_PROVENANCE + 1).abortSignal(signal),
    ]);
    if (sessions.error || operators.error) return unavailable("call_read_failed");
    if ((operators.data?.length ?? 0) > MAX_PROVENANCE) return unavailable("call_read_truncated");
    const ownSessions = new Map((sessions.data ?? []).map(row => [row.id, row]));
    const ownOperators = new Map((operators.data ?? []).filter(row => ownSessions.has(row.session_id)).map(row => [row.id, row]));
    const customerIds = [...new Set((sessions.data ?? []).map(row => row.customer_leg_id).filter((id): id is string => Boolean(id)))];
    if (!customerIds.length) return empty();
    const controlIds = [...new Set([...ownOperators.values()].map(row => row.telnyx_call_control_id).filter((id): id is string => Boolean(id)))];
    const verifiedSessionIds = [...ownSessions.keys()];
    const providerSessionIds = [...new Set((sessions.data ?? []).map(row => row.telnyx_session_id).filter((id): id is string => Boolean(id)))];
    const [customers, intent, ledger, commands, departures] = await Promise.all([
      deps.admin.from("motorist_call_legs").select("id, session_id, answered_at, ended_at")
        .eq("organization_id", deps.organizationId).in("id", customerIds).limit(MAX_INCIDENTS).abortSignal(signal),
      deps.admin.from("motorist_diagnostic_events").select("call_session_id, profile_id, event")
        .eq("organization_id", deps.organizationId).eq("environment", environment).in("call_session_id", verifiedSessionIds)
        .in("event->>reason", ["hangup_intent", "hangup_requested"]).gte("received_at", new Date(now - 24 * 60 * 60_000).toISOString())
        .lte("received_at", deps.now.toISOString()).limit(MAX_PROVENANCE + 1).abortSignal(signal),
      environment === "test" && controlIds.length ? deps.admin.from("motorist_telnyx_webhook_events")
        .select("call_control_id").eq("organization_id", deps.organizationId).eq("event_type", "call.initiated")
        .in("call_control_id", controlIds).in("connection_id", configuration.testConnectionIds).limit(MAX_PROVENANCE + 1).abortSignal(signal)
        : Promise.resolve({ data: [], error: null }),
      environment === "test" && configuration.testCallControlAppId ? deps.admin.from("motorist_provider_commands")
        .select("session_id, result").in("session_id", verifiedSessionIds).eq("method", "POST").eq("path", "/calls").eq("outcome", "accepted")
        .contains("request_payload", { connection_id: configuration.testCallControlAppId }).limit(MAX_PROVENANCE + 1).abortSignal(signal)
        : Promise.resolve({ data: [], error: null }),
      providerSessionIds.length ? deps.admin.from("motorist_call_events")
        .select("provider_timestamp, payload, normalized_payload, event_type")
        .eq("organization_id", deps.organizationId).eq("provider", "telnyx").in("provider_session_id", providerSessionIds)
        .eq("handled_status", "processed").in("event_type", ["app.park", "app.blind_transfer", "app.complete_transfer", "app.leave_conference"])
        .gte("provider_timestamp", new Date(Date.parse(since) - 30_000).toISOString()).lte("provider_timestamp", deps.now.toISOString())
        .limit(MAX_PROVENANCE + 1).abortSignal(signal) : Promise.resolve({ data: [], error: null }),
    ]);
    if (customers.error || intent.error || ledger.error || commands.error || departures.error) return unavailable("corroboration_read_failed");
    if ([intent, ledger, commands, departures].some(result => (result.data?.length ?? 0) > MAX_PROVENANCE)) return unavailable("corroboration_read_truncated");
    const customerById = new Map((customers.data ?? []).map(row => [row.id, row]));
    const initiated = new Set((ledger.data ?? []).map(row => row.call_control_id));
    const dialed = new Set((commands.data ?? []).map(row => `${row.session_id}:${alertObject(alertObject(row.result).data).call_control_id}`));
    const entries: ConfirmedCallInterruption[] = [];
    for (const candidate of candidates) {
      const session = ownSessions.get(candidate.call_session_id!);
      const operator = ownOperators.get(candidate.leg_id!);
      const customer = session?.customer_leg_id ? customerById.get(session.customer_leg_id) : null;
      const ended = timestamp(operator?.ended_at);
      if (!session || !operator || operator.session_id !== session.id || operator.role !== "operator" ||
          timestamp(operator.bridged_at) === null || !operator.profile_id || ended === null || Date.parse(operator.bridged_at!) > ended || ended !== Date.parse(candidate.first_seen_at) ||
          !customer || customer.session_id !== session.id || timestamp(customer.answered_at) === null || Date.parse(customer.answered_at!) > ended ||
          customer.ended_at !== null && (timestamp(customer.ended_at) === null || Date.parse(customer.ended_at) <= ended + 10_000)) continue;
      if (environment === "test" && (!operator.telnyx_call_control_id ||
          !initiated.has(operator.telnyx_call_control_id) && !dialed.has(`${session.id}:${operator.telnyx_call_control_id}`))) continue;
      const metadata = alertObject(session.metadata);
      const transfer = alertObject(metadata.transfer);
      const park = alertObject(metadata.park);
      if (near(session.termination_requested_at, ended, 120_000) || near(session.parked_at, ended) || near(session.hold_started_at, ended) ||
          session.direction !== "internal" && near(alertObject(metadata.hangup).at, ended) ||
          (park.by === operator.profile_id && near(park.at, ended)) ||
          (transfer.by === operator.profile_id && (near(transfer.completed_at, ended) || transfer.kind === "blind" && near(transfer.at, ended)))) continue;
      if ([...ownOperators.values()].some(other => other.id !== operator.id && other.session_id === session.id && other.profile_id === operator.profile_id &&
          ["operator", "external"].includes(other.role) && timestamp(other.bridged_at) !== null && Date.parse(other.bridged_at!) <= ended &&
          (other.ended_at === null || timestamp(other.ended_at) !== null && Date.parse(other.ended_at) > ended + 10_000))) continue;
      if ((departures.data ?? []).some(row => {
        const normalized = alertObject(row.normalized_payload);
        const requiredKind = row.event_type === "app.park" ? ["hangup"] : row.event_type === "app.blind_transfer" ? ["transfer", "dial"] : ["conference_leave"];
        return alertObject(row.payload).actor === operator.profile_id && normalized.session_id === session.id && !normalized.error && near(row.provider_timestamp, ended) &&
          Array.isArray(normalized.commands) && normalized.commands.some(value => { const command = alertObject(value); return requiredKind.includes(String(command.kind)) && command.ok === true && command.skipped !== true; });
      })) continue;
      if ((intent.data ?? []).some(row => row.call_session_id === session.id && row.profile_id === operator.profile_id &&
          timestamp(alertObject(row.event).occurredAt) !== null &&
          timestamp(alertObject(row.event).occurredAt)! >= ended - 30_000 && timestamp(alertObject(row.event).occurredAt)! <= ended + 2_000)) continue;
      entries.push({ incidentId: candidate.id, sessionId: session.id, legId: operator.id, interruptedAt: candidate.first_seen_at,
        classifiedAt: candidate.classified_at!, environment, classification: "interruption_observed" });
    }
    return { key: "interruptions", status: entries.length ? "fail" : truncated ? "warn" : "ok", detail: { environment, since, truncated, confirmed: entries.length, entries } };
  } catch { return unavailable("corroboration_unavailable"); }
}
