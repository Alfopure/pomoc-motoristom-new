import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ViptelActiveCall,
  ViptelExtension,
  ViptelQueueStatus,
} from "@/lib/integrations/viptel/client";
import type { Database } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";
import {
  groupViptelProviderCallLegs,
  isLiveProviderCall,
  preferredViptelProviderCallLeg,
  providerCallMatchesKnownIdentity,
} from "./provider-call-state";
import {
  assertSystemFallbackRedirectAuthorized,
  fallbackCommandMarker,
  isSystemFallbackRedirectPayload,
  loadViptelFallbackSettings,
} from "./fallback-settings";
import { beginTelephonyCommand } from "./telephony-commands";

type AdminClient = SupabaseClient<Database>;
type TelephonyCommandRow = Database["public"]["Tables"]["motorist_telephony_commands"]["Row"];

const DISPATCH_QUEUES = ["601", "602", "603"];
const CANDIDATE_LIMIT = 25;
const SAFE_RETRY_DELAY_MS = 4_000;
const MAX_SAFE_FALLBACK_ATTEMPTS = 6;
const TIMEOUT_HANDOFF_GRACE_MS = 30_000;

type FallbackAvailabilitySnapshot = {
  extensions: ViptelExtension[];
  queueStatuses: ViptelQueueStatus[];
};

type FallbackProviderSnapshot = FallbackAvailabilitySnapshot & {
  activeCalls: ViptelActiveCall[];
};

export async function enqueueDueViptelFallbackRedirects(
  client: AdminClient,
  organizationId: string,
  now = new Date(),
  loadAvailability?: () => Promise<FallbackProviderSnapshot>,
) {
  const loaded = await loadViptelFallbackSettings(organizationId, client);
  const settings = loaded.settings;
  if (
    !settings.enabled ||
    !settings.destination ||
    !settings.revision ||
    !settings.updatedBy
  ) {
    return { eligible: 0, enqueued: 0 };
  }

  const candidates = await client
    .from("motorist_calls")
    .select("id, viptel_unique_id, from_queue_unique_id, status, answered_at, started_at, created_at, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .eq("direction", "inbound")
    // `queue.left` is only the end of one queue offer. VIPTel can expose the
    // next agent leg a few seconds later while the caller is still waiting.
    // Keep that provisional lifecycle eligible until an answer or an
    // authoritative end timestamp arrives.
    // VIPTel can mark the public queue parent as answered when the PBX takes
    // it into the queue. An answered *agent child* is what proves that a
    // dispatcher answered; the fresh provider snapshot below distinguishes
    // those cases safely.
    .in("status", ["incoming", "ringing_agent", "abandoned_queue", "missed", "answered"])
    .in("queue_number", DISPATCH_QUEUES)
    .is("ended_at", null)
    // The latest safe delivery is the hard deadline plus one short queue-leg
    // handoff window. Excluding older unresolved rows prevents historical CDR
    // gaps from causing permanent provider polling after every real call ends.
    .gte("created_at", new Date(
      now.getTime() - settings.afterSeconds * 1_000 - TIMEOUT_HANDOFF_GRACE_MS,
    ).toISOString())
    // Old queue.left rows can remain provisionally open until CDR catches up.
    // Newest-first prevents those historical rows from starving a new caller
    // once the bounded candidate limit is reached.
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_LIMIT);
  if (candidates.error) throw new Error(`Fallback call candidates could not be loaded: ${candidates.error.message}`);

  const waitingCalls = candidates.data ?? [];
  const existing = waitingCalls.length > 0
    ? await client
        .from("motorist_telephony_commands")
        .select("call_id, idempotency_key, status, provider_response, request_payload, updated_at")
        .eq("organization_id", organizationId)
        .eq("provider", "viptel")
        .eq("command_type", "call.redirect")
        .in("call_id", waitingCalls.map((call) => call.id))
        .order("updated_at", { ascending: false })
    : { data: [], error: null };
  if (existing.error) throw new Error(`Fallback command fences could not be loaded: ${existing.error.message}`);

  const commandsByCall = new Map<string, FallbackCommandFence[]>();
  for (const command of existing.data ?? []) {
    if (!command.call_id) continue;
    const commands = commandsByCall.get(command.call_id) ?? [];
    commands.push(command);
    commandsByCall.set(command.call_id, commands);
  }
  const potentialCalls = waitingCalls.filter((call) => {
    const commands = commandsByCall.get(call.id) ?? [];
    const timedOut = viptelFallbackTrigger(call.created_at, now, settings.afterSeconds, false) === "timeout";
    return timedOut
      ? nextSafeFallbackAttempt(commands, settings.revision as string, "timeout", now) !== null
      : nextSafeFallbackAttempt(commands, settings.revision as string, "no_available_operators", now) !== null;
  });
  if (potentialCalls.length === 0 || !loadAvailability) {
    return { eligible: 0, enqueued: 0, noAvailableOperators: false };
  }

  // One provider snapshot is shared by every candidate in this pump. Besides
  // deciding the zero-operator shortcut, it proves that a durable DB row still
  // has exactly one live queue leg. This keeps old queue.left rows out of the
  // command outbox instead of retrying them until they block real calls.
  const availability = await loadAvailability();
  const noAvailableOperators = availableViptelOperatorCount(availability) === 0;
  const dueCalls = potentialCalls.flatMap((call) => {
    const trigger = viptelFallbackTrigger(call.created_at, now, settings.afterSeconds, noAvailableOperators);
    if (!trigger) return [];
    const liveProviderIdentity = resolveWaitingFallbackProviderIdentity(call, availability.activeCalls);
    const providerIdentity = liveProviderIdentity ??
      (trigger === "timeout" && call.status !== "answered" && !call.answered_at
        ? resolveRecentTimeoutHandoffIdentity(call, now, settings.afterSeconds)
        : null);
    if (!providerIdentity) return [];
    return [{ call, trigger, ...providerIdentity }];
  });

  let enqueued = 0;
  for (const { call, confirmationUniqueIds, trigger, uniqueId } of dueCalls) {
    const attempt = nextSafeFallbackAttempt(
      commandsByCall.get(call.id) ?? [],
      settings.revision,
      trigger,
      now,
    );
    if (attempt === null) continue;
    const idempotencyKey = createHash("sha256")
      .update(`motorist.viptel.inbound-fallback.v2\n${organizationId}\n${call.id}\n${settings.revision}\n${trigger}\n${attempt}`)
      .digest("hex");
    try {
      await beginTelephonyCommand({
        organizationId,
        requestedBy: settings.updatedBy,
        commandType: "call.redirect",
        callId: call.id,
        idempotencyKey,
        systemFallback: true,
        uniqueConflictMessage: "Záložné presmerovanie tohto hovoru už bolo vytvorené.",
        requestPayload: {
          uniqueId,
          confirmationUniqueIds,
          destinationKind: "phone",
          destination: settings.destination,
          systemFallback: {
            schemaVersion: 1,
            revision: settings.revision,
            destination: settings.destination,
            afterSeconds: settings.afterSeconds,
            trigger,
          },
        },
      });
      enqueued += 1;
    } catch (error) {
      if (error instanceof MutationError && error.status === 409) continue;
      throw error;
    }
  }
  return { eligible: dueCalls.length, enqueued, noAvailableOperators };
}

export async function assertFallbackProviderCallStillWaiting(
  client: AdminClient,
  organizationId: string,
  command: TelephonyCommandRow,
  provider: FallbackProviderSnapshot,
  now = new Date(),
) {
  if (!isSystemFallbackRedirectPayload(command.request_payload)) return;
  const call = await assertSystemFallbackRedirectAuthorized(client, organizationId, command, now);
  const payload = jsonRecord(command.request_payload);
  const marker = fallbackCommandMarker(payload.systemFallback);
  if (!marker) throw new Error("Záložné presmerovanie nemá platný snapshot nastavenia.");
  const identities = new Set([
    call.viptel_unique_id,
    call.from_queue_unique_id,
    typeof payload.uniqueId === "string" ? payload.uniqueId : null,
  ].filter((value): value is string => Boolean(value)));
  if (marker.trigger === "no_available_operators" && availableViptelOperatorCount(provider) !== 0) {
    throw new Error("Medzitým je dostupný operátor; okamžité záložné presmerovanie bolo zastavené.");
  }
  const matching = provider.activeCalls.filter((candidate) =>
    providerCallMatchesKnownIdentity(candidate, identities),
  );
  if (matching.some((leg) => ["ended", "failed"].includes(leg.status) || providerAgentLegIsAnswered(leg))) {
    throw new Error("Hovor medzitým prijal operátor alebo sa skončil; záložné presmerovanie bolo zastavené.");
  }
  const logicalCalls = groupViptelProviderCallLegs(matching.filter(isLiveProviderCall));
  if (
    logicalCalls.length === 0 &&
    marker.trigger === "timeout" &&
    call.status !== "answered" &&
    !call.answered_at
  ) {
    // VIPTel call statistics can briefly expose no agent leg while the queue
    // hands the same caller to its next member. At the configured hard timeout
    // the durable unanswered call and its exact queue-parent ID are sufficient
    // authority: redirecting an ID that has truly ended is a harmless provider
    // rejection, while rejecting here would strand a still-ringing caller.
    return;
  }
  if (logicalCalls.length !== 1) {
    throw new Error("VIPTel už nevrátil presne jeden čakajúci hovor pre záložné presmerovanie.");
  }
  const legs = logicalCalls[0] ?? [];
  if (legs.some(providerAgentLegIsAnswered)) {
    throw new Error("Hovor medzitým prijal operátor; záložné presmerovanie bolo zastavené.");
  }
  const requestedUniqueId = typeof payload.uniqueId === "string" ? payload.uniqueId : null;
  const queueParentIds = new Set([call.from_queue_unique_id, requestedUniqueId].filter((value): value is string => Boolean(value)));
  if (!legs.some((leg) => providerLegIsWaiting(leg, queueParentIds))) {
    throw new Error("VIPTel už hovor nevedie ako čakajúci v rade.");
  }
}

export function resolveWaitingFallbackProviderIdentity(
  call: Pick<TelephonyCommandCall, "from_queue_unique_id" | "viptel_unique_id">,
  activeCalls: ViptelActiveCall[],
) {
  const storedIdentities = new Set([
    call.viptel_unique_id?.trim(),
    call.from_queue_unique_id?.trim(),
  ].filter((value): value is string => Boolean(value)));
  if (storedIdentities.size === 0) return null;
  const matching = activeCalls.filter((candidate) =>
    isLiveProviderCall(candidate) && providerCallMatchesKnownIdentity(candidate, storedIdentities),
  );
  const logicalCalls = groupViptelProviderCallLegs(matching);
  if (logicalCalls.length !== 1) return null;
  const logicalCall = logicalCalls[0] ?? [];
  const queueParentIds = new Set([
    call.from_queue_unique_id?.trim(),
  ].filter((value): value is string => Boolean(value)));
  const waitingLegs = logicalCall.filter((candidate) => providerLegIsWaiting(candidate, queueParentIds));
  if (waitingLegs.length === 0 || logicalCall.some(providerAgentLegIsAnswered)) return null;
  const preferred = preferredViptelProviderCallLeg(waitingLegs);
  const liveQueueParent = [
    call.from_queue_unique_id?.trim(),
    ...waitingLegs.map((candidate) => candidate.fromQueueUniqueId?.trim()),
  ].find((candidate): candidate is string => Boolean(
    candidate && waitingLegs.some((leg) =>
      leg.viptelUniqueId === candidate || leg.fromQueueUniqueId === candidate,
    ),
  ));
  const uniqueId = liveQueueParent ?? preferred.viptelUniqueId;
  if (!uniqueId) return null;
  return {
    uniqueId,
    confirmationUniqueIds: [...new Set([
      uniqueId,
      ...storedIdentities,
      ...logicalCall.flatMap((candidate) => [candidate.viptelUniqueId, candidate.fromQueueUniqueId]),
    ].filter((value): value is string => Boolean(value)))],
  };
}

function providerAgentLegIsAnswered(call: ViptelActiveCall) {
  return call.status === "answered" && Boolean(call.fromQueueUniqueId?.trim());
}

function providerLegIsWaiting(call: ViptelActiveCall, queueParentIds: ReadonlySet<string>) {
  if (call.direction !== "inbound") return false;
  if (["incoming", "ringing_agent"].includes(call.status)) return true;
  // VIPTel answers the public line into its queue before an operator answers.
  // That queue parent has no `fromQueueUniqueId`; only an answered child leg
  // proves that a dispatcher actually picked the call up.
  return call.status === "answered" &&
    !call.fromQueueUniqueId &&
    Boolean(call.viptelUniqueId && queueParentIds.has(call.viptelUniqueId));
}

/**
 * VIPTel can briefly omit every agent leg while moving one queue parent to the
 * next member. At the hard deadline we may still redirect that stable parent,
 * but only inside a short, recent handoff window. A later stale DB row can no
 * longer generate an endless stream of 404 commands.
 */
export function resolveRecentTimeoutHandoffIdentity(
  call: Pick<TelephonyCommandCall, "from_queue_unique_id" | "viptel_unique_id"> & {
    created_at: string;
    updated_at: string;
  },
  now: Date,
  afterSeconds: number,
) {
  const createdAt = Date.parse(call.created_at);
  const updatedAt = Date.parse(call.updated_at);
  const elapsed = now.getTime() - createdAt;
  if (
    !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) ||
    elapsed < afterSeconds * 1_000 || elapsed > afterSeconds * 1_000 + TIMEOUT_HANDOFF_GRACE_MS ||
    now.getTime() - updatedAt > TIMEOUT_HANDOFF_GRACE_MS
  ) return null;
  const uniqueId = call.from_queue_unique_id?.trim() || call.viptel_unique_id?.trim();
  if (!uniqueId) return null;
  return {
    uniqueId,
    confirmationUniqueIds: [...new Set([
      uniqueId,
      call.viptel_unique_id?.trim(),
      call.from_queue_unique_id?.trim(),
    ].filter((value): value is string => Boolean(value)))],
  };
}

/**
 * Counts registered, unpaused dispatch members. `inUse` is deliberately not
 * excluded: VIPTel may mark the operator in-use while this very call rings,
 * and that operator must still prevent an incorrect immediate fallback.
 */
export function availableViptelOperatorCount(snapshot: FallbackAvailabilitySnapshot) {
  const statuses = DISPATCH_QUEUES.map((queue) => snapshot.queueStatuses.filter((status) => status.queue === queue));
  if (statuses.some((matches) => matches.length !== 1)) {
    throw new Error("VIPTel nevrátil úplný stav radov 601–603.");
  }
  const registered = new Set(
    snapshot.extensions
      .filter((extension) => extension.isRegistered === true)
      .map((extension) => extension.extension),
  );
  const active = new Set<string>();
  for (const [status] of statuses) {
    for (const member of status?.members ?? []) {
      if (member.dynamic && !member.paused && registered.has(member.extension)) {
        active.add(member.extension);
      }
    }
  }
  return active.size;
}

export function viptelFallbackTrigger(
  callCreatedAt: string,
  now: Date,
  afterSeconds: number,
  noAvailableOperators: boolean,
) {
  const createdAt = Date.parse(callCreatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(now.getTime())) return null;
  if (now.getTime() - createdAt >= afterSeconds * 1_000) return "timeout" as const;
  return noAvailableOperators ? "no_available_operators" as const : null;
}

type FallbackCommandFence = Pick<
  TelephonyCommandRow,
  "call_id" | "provider_response" | "request_payload" | "status" | "updated_at"
>;

/**
 * Returns the next attempt number only when every previous delivery is known
 * to have failed before reaching VIPTel. Queued, sent, confirmed, or uncertain
 * commands are permanent fences against duplicate redirects.
 */
export function nextSafeFallbackAttempt(
  commands: FallbackCommandFence[],
  revision: string,
  trigger: "no_available_operators" | "timeout",
  now = new Date(),
): number | null {
  const sameRevision = commands.filter((command) => {
    const marker = fallbackCommandMarker(jsonRecord(command.request_payload).systemFallback);
    return marker?.revision === revision;
  });
  if (sameRevision.some((command) => command.status !== "failed")) return null;
  if (sameRevision.some((command) => jsonRecord(command.provider_response).deliveryUncertain === true)) return null;
  // A synchronous 4xx response proves VIPTel received and rejected the exact
  // identifier. Replaying it cannot repair the call and used to monopolize the
  // listener long enough for newer fallback/workplace commands to expire.
  const relevant = sameRevision.filter((command) =>
    fallbackCommandMarker(jsonRecord(command.request_payload).systemFallback)?.trigger === trigger,
  );
  if (relevant.some((command) => jsonRecord(command.provider_response).reason === "provider_rejected")) return null;
  if (relevant.length >= MAX_SAFE_FALLBACK_ATTEMPTS) return null;
  const latestFailureAt = Math.max(...relevant.map((command) => Date.parse(command.updated_at)).filter(Number.isFinite));
  if (Number.isFinite(latestFailureAt) && now.getTime() - latestFailureAt < SAFE_RETRY_DELAY_MS) return null;
  return relevant.length;
}

type TelephonyCommandCall = Pick<
  Database["public"]["Tables"]["motorist_calls"]["Row"],
  "from_queue_unique_id" | "viptel_unique_id"
>;

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
