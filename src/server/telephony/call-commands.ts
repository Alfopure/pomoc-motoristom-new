import "server-only";

import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  type ViptelActiveCall,
  type ViptelExtension,
  type ViptelQueueStatus,
} from "@/lib/integrations/viptel/client";
import type { TelephonyTransferTarget } from "@/lib/telephony/commands";
import type { DtmfTransferMode } from "@/lib/telephony/dtmf-transfer";
import {
  cleanPhoneInput,
  formatViptelDialTarget,
  sameDialNumber,
  TelephonyPhoneInputError,
} from "@/lib/telephony/phone";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { listOwnedTelephonyExtensions } from "@/server/telephony-access";
import type { WorkplaceLeaseFence } from "@/server/telephony-access";
import {
  claimOwnedExtensionAction,
  releaseExtensionAssignmentGuard,
} from "./assignment-interlock";
import { requireImmutableAssignmentLifecycle } from "./assignment-lifecycle";
import {
  currentViptelProviderCallLegs,
  exactLiveProviderCallForExtension,
  groupViptelProviderCallLegs,
  isLiveProviderCall,
  preferredViptelProviderCallLeg,
  providerCallMatchesKnownIdentity,
  providerCallIsCurrentAtExtension,
} from "./provider-call-state";
import { requestViptelProviderSnapshot } from "./provider-snapshot-bridge";
import {
  beginBrowserDtmfTransferIntent,
  beginBrowserSipReferTransferIntent,
  beginTelephonyCommand,
} from "./telephony-commands";

type CallRow = Database["public"]["Tables"]["motorist_calls"]["Row"];
type OwnedExtension = Awaited<ReturnType<typeof listOwnedTelephonyExtensions>>[number];
type VerifiedTelephonyTransferTarget = TelephonyTransferTarget & { lifecycleEpoch: string };

const ACTIVE_CALL_STATUSES: CallRow["status"][] = ["incoming", "ringing_agent", "answered", "outbound"];
const ANSWERED_QUEUE_DECLINE_GRACE_MS = 90_000;
const TERMINAL_QUEUE_HANDOFF_CONTROL_GRACE_MS = 10_000;
const EXACT_PROVIDER_SNAPSHOT_MAX_AGE_MS = 10_000;

export async function enqueueHangupCommand(
  actor: MotoristActor,
  callId: string,
  leaseFence?: WorkplaceLeaseFence,
  options: { incomingQueueDecline?: boolean } = {},
) {
  const owned = await resolveOwnedActiveCall(actor, callId, {
    allowRecentInboundQueueOwner: options.incomingQueueDecline === true,
    requireExactProviderLeg: true,
  });
  const actionClaim = await claimOwnedExtensionAction(actor, owned.extension.id, "call.hangup", { leaseFence });
  try {
    const targetUniqueId = hangupProviderUniqueId(
      owned.call,
      owned.activeUniqueId,
      owned.activeFromQueueUniqueId,
    );
    return await beginTelephonyCommand({
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      commandType: "call.hangup",
      callId: owned.call.id,
      extensionId: actionClaim.id,
      assignmentGuard: actionClaim.assignmentGuard,
      requestPayload: {
        uniqueId: targetUniqueId,
        confirmationUniqueIds: owned.knownUniqueIds,
        sourceExtension: owned.extension.extension,
      },
    });
  } catch (error) {
    await releaseExtensionAssignmentGuard(createSupabaseAdminClient(), actor.organizationId, actionClaim.assignmentGuard);
    throw error;
  }
}

/**
 * Rejecting or ending a queued inbound call must target its queue parent. A
 * hangup sent only to the current agent leg behaves like a local SIP reject:
 * the caller remains connected and the PBX advances to the next workstation.
 */
export function hangupProviderUniqueId(
  call: Pick<CallRow, "direction" | "from_queue_unique_id">,
  activeUniqueId: string,
  activeFromQueueUniqueId?: string,
) {
  if (call.direction !== "inbound") return activeUniqueId;
  return call.from_queue_unique_id?.trim() || activeFromQueueUniqueId?.trim() || activeUniqueId;
}

export function providerRedirectIsSafe(direction: CallRow["direction"]) {
  // call.redirect replaces VIPTel's called party. For an outbound call that
  // party is the client, so redirecting it creates operator -> operator and
  // drops the client. Outbound browser calls transfer their live SIP dialog.
  return direction === "inbound";
}

export async function enqueueRedirectCommand(
  actor: MotoristActor,
  callId: string,
  destinationInput: {
    destinationNumber?: unknown;
    destinationProfileId?: unknown;
  },
  leaseFence?: WorkplaceLeaseFence,
) {
  const destination = redirectDestination(destinationInput);
  const owned = await resolveOwnedActiveCall(actor, callId, {
    allowRecentInboundQueueOwner: true,
    requireExactProviderLeg: true,
  });
  if (!providerRedirectIsSafe(owned.call.direction)) {
    throw new MutationError(
      "Odchádzajúci hovor sa nedá bezpečne prepojiť cez VIPTel redirect. Použi prepojenie v aktívnom telefóne.",
      409,
    );
  }
  let requestPayload: Record<string, unknown>;

  if (destination.kind === "operator") {
    const targets = await listAvailableTransferTargets(actor, callId, owned);
    const target = targets.find((candidate) => candidate.profileId === destination.profileId);
    if (!target) {
      throw new MutationError("Cieľový operátor už nie je dostupný. Obnov zoznam a vyber inú klapku.", 409);
    }
    requestPayload = {
      uniqueId: owned.activeUniqueId,
      confirmationUniqueIds: owned.knownUniqueIds,
      sourceExtension: owned.extension.extension,
      destinationKind: "operator",
      destinationExtension: target.extension,
      destinationExtensionId: target.extensionId,
      destinationLifecycleEpoch: target.lifecycleEpoch,
      destinationProfileId: target.profileId,
    };
  } else {
    if (sameDialNumber(destination.number, owned.extension.extension)) {
      throw new MutationError("Hovor nie je možné prepojiť späť na tú istú klapku.", 400);
    }
    requestPayload = {
      uniqueId: owned.activeUniqueId,
      confirmationUniqueIds: owned.knownUniqueIds,
      sourceExtension: owned.extension.extension,
      destinationKind: "phone",
      destination: destination.number,
    };
  }
  const actionClaim = await claimOwnedExtensionAction(actor, owned.extension.id, "call.redirect", { leaseFence });

  try {
    return await beginTelephonyCommand({
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      commandType: "call.redirect",
      callId: owned.call.id,
      extensionId: actionClaim.id,
      assignmentGuard: actionClaim.assignmentGuard,
      requestPayload,
    });
  } catch (error) {
    await releaseExtensionAssignmentGuard(createSupabaseAdminClient(), actor.organizationId, actionClaim.assignmentGuard);
    throw error;
  }
}

export async function enqueueBrowserDtmfTransferCommand(
  actor: MotoristActor,
  callId: string,
  modeValue: unknown,
  destinationValue: unknown,
  leaseFence?: WorkplaceLeaseFence,
) {
  const mode = dtmfTransferMode(modeValue);
  if (typeof destinationValue !== "string") {
    throw new MutationError("Cieľ prepojenia je povinný.", 400);
  }

  const owned = await resolveOwnedActiveCall(actor, callId, { requireExactProviderLeg: true });
  const actionClaim = await claimOwnedExtensionAction(actor, owned.extension.id, "call.transfer.dtmf", { leaseFence });
  try {
    return await beginBrowserDtmfTransferIntent({
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      callId: owned.call.id,
      extensionId: actionClaim.id,
      authorizedViptelUniqueId: owned.activeUniqueId,
      assignmentGuard: actionClaim.assignmentGuard,
      destination: destinationValue,
      mode,
    });
  } catch (error) {
    await releaseExtensionAssignmentGuard(createSupabaseAdminClient(), actor.organizationId, actionClaim.assignmentGuard);
    throw error;
  }
}

/**
 * Moves one still-waiting inbound queue call to the authenticated operator's
 * current workplace. This is deliberately separate from normal transfer:
 * normal transfer requires ownership of the source call, while a waiting-room
 * pickup is allowed to claim a call that is currently offered to somebody
 * else. The destination workplace and the exact provider call are both
 * revalidated immediately before the outbox command is created.
 */
export async function enqueueWaitingCallPickupCommand(
  actor: MotoristActor,
  callId: string,
  targetExtensionValue: unknown,
  leaseFence?: WorkplaceLeaseFence,
) {
  const id = requiredUuid(callId, "Hovor");
  const targetExtension = typeof targetExtensionValue === "string" ? targetExtensionValue.trim() : "";
  if (!/^\d{1,8}$/.test(targetExtension)) {
    throw new MutationError("Pracovné miesto nemá platnú internú linku.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const [callResult, ownedExtensions] = await Promise.all([
    supabase
      .from("motorist_calls")
      .select("*")
      .eq("id", id)
      .eq("organization_id", actor.organizationId)
      .eq("provider", "viptel")
      .maybeSingle(),
    listOwnedTelephonyExtensions(actor),
  ]);
  if (callResult.error) throw new Error(`Telephony call could not be loaded: ${callResult.error.message}`);
  const call = callResult.data;
  if (!call) throw new MutationError("Hovor sa už v čakárni nenašiel.", 404);
  const waitingStatus = ["incoming", "ringing_agent"].includes(call.status) || (
    ["abandoned_queue", "missed"].includes(call.status) && !call.answered_at && !call.ended_at
  ) || (
    // VIPTel marks the public queue parent answered when the PBX accepts it
    // into the queue. The fresh provider check below rejects only a real
    // answered agent child, so that parent must remain selectable here.
    call.status === "answered" && !call.ended_at && Boolean(call.queue_number)
  );
  if (call.direction !== "inbound" || !waitingStatus) {
    throw new MutationError("Hovor už nečaká na prijatie.", 409);
  }
  if (!call.viptel_unique_id && !call.from_queue_unique_id) {
    throw new MutationError("VIPTel ešte neposlal identifikátor potrebný na prevzatie hovoru.", 409);
  }

  const target = ownedExtensions.find((extension) => extension.extension === targetExtension);
  if (!target) {
    throw new MutationError("Toto pracovné miesto už nepatrí prihlásenému operátorovi.", 403);
  }
  const targetLifecycleResult = await supabase
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, metadata")
    .eq("id", target.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", "viptel")
    .eq("profile_id", actor.profileId)
    .eq("active", true)
    .maybeSingle();
  if (targetLifecycleResult.error) {
    throw new Error(`Telephony extension could not be loaded: ${targetLifecycleResult.error.message}`);
  }
  if (!targetLifecycleResult.data) {
    throw new MutationError("Toto pracovné miesto už nepatrí prihlásenému operátorovi.", 403);
  }

  const eventAliases = await supabase
    .from("motorist_call_events")
    .select("viptel_unique_id")
    .eq("organization_id", actor.organizationId)
    .eq("call_id", call.id)
    .not("viptel_unique_id", "is", null)
    .order("received_at", { ascending: false })
    .limit(20);
  if (eventAliases.error) throw new Error(`Telephony call aliases could not be loaded: ${eventAliases.error.message}`);
  const knownUniqueIds = new Set([
    call.viptel_unique_id,
    call.from_queue_unique_id,
    ...(eventAliases.data ?? []).map((event) => event.viptel_unique_id),
  ].filter((value): value is string => Boolean(value)));
  const snapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, {
    maxAgeMs: EXACT_PROVIDER_SNAPSHOT_MAX_AGE_MS,
    requireNewCapture: true,
  });
  const matchingProviderCalls = snapshot.activeCalls.filter((candidate) =>
    isLiveProviderCall(candidate) && providerCallMatchesKnownIdentity(candidate, knownUniqueIds),
  );
  const logicalCalls = groupViptelProviderCallLegs(matchingProviderCalls);
  if (logicalCalls.length === 0) {
    throw new MutationError("Hovor už vo VIPTel nečaká. Obnov čakáreň.", 409);
  }
  if (logicalCalls.length !== 1) {
    throw new MutationError("VIPTel nevrátil jednoznačnú identitu čakajúceho hovoru.", 409);
  }
  const logicalCall = logicalCalls[0] as ViptelActiveCall[];
  const answeredAgentLeg = logicalCall.some((candidate) =>
    candidate.status === "answered" && Boolean(candidate.fromQueueUniqueId),
  );
  if (answeredAgentLeg) {
    throw new MutationError("Hovor medzitým prijal iný operátor.", 409);
  }

  const providerExtension = snapshot.extensions.find((extension) => extension.extension === target.extension);
  if (providerExtension?.isRegistered !== true) {
    throw new MutationError("Telefón tohto pracovného miesta nie je vo VIPTel pripojený.", 409);
  }
  const targetHasAnotherCall = snapshot.activeCalls.some((candidate) =>
    isLiveProviderCall(candidate) &&
    providerCallIsCurrentAtExtension(candidate, target.extension) &&
    !providerCallMatchesKnownIdentity(candidate, knownUniqueIds),
  );
  if (targetHasAnotherCall) {
    throw new MutationError("Na tomto pracovnom mieste už zvoní alebo prebieha iný hovor.", 409);
  }

  const lifecycle = await requireImmutableAssignmentLifecycle(
    supabase,
    actor.organizationId,
    targetLifecycleResult.data,
    actor.profileId,
  );
  const queueParentUniqueId = call.from_queue_unique_id && logicalCall.some((candidate) =>
    candidate.viptelUniqueId === call.from_queue_unique_id ||
    candidate.fromQueueUniqueId === call.from_queue_unique_id,
  )
    ? call.from_queue_unique_id
    : logicalCall.find((candidate) => candidate.fromQueueUniqueId)?.fromQueueUniqueId ??
      preferredViptelProviderCallLeg(logicalCall).viptelUniqueId;
  if (!queueParentUniqueId) {
    throw new MutationError("VIPTel ešte neposlal bezpečný identifikátor čakajúceho hovoru.", 409);
  }
  const confirmationUniqueIds = [...new Set([
    ...knownUniqueIds,
    queueParentUniqueId,
    ...logicalCall.flatMap((candidate) => [candidate.viptelUniqueId, candidate.fromQueueUniqueId]),
  ].filter((value): value is string => Boolean(value)))];
  const actionClaim = await claimOwnedExtensionAction(actor, target.id, "call.redirect", { leaseFence });

  try {
    return await beginTelephonyCommand({
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      commandType: "call.redirect",
      callId: call.id,
      extensionId: actionClaim.id,
      assignmentGuard: actionClaim.assignmentGuard,
      // A short provider-identity bucket prevents two operators from winning
      // the same click race, while allowing a later explicit retry.
      idempotencyKey: `waiting-pickup:${call.id}:${queueParentUniqueId}:${Math.floor(Date.now() / 15_000)}`,
      uniqueConflictMessage: "Tento hovor už preberá iný operátor. Obnov čakáreň.",
      requestPayload: {
        uniqueId: queueParentUniqueId,
        confirmationUniqueIds,
        destinationKind: "operator",
        destinationExtension: target.extension,
        destinationExtensionId: target.id,
        destinationLifecycleEpoch: lifecycle.epoch,
        destinationProfileId: actor.profileId,
        waitingRoomPickup: true,
      },
    });
  } catch (error) {
    await releaseExtensionAssignmentGuard(supabase, actor.organizationId, actionClaim.assignmentGuard);
    throw error;
  }
}

export async function enqueueBrowserSipReferTransferCommand(
  actor: MotoristActor,
  callId: string,
  destinationInput: {
    destinationNumber?: unknown;
    destinationProfileId?: unknown;
  },
  leaseFence?: WorkplaceLeaseFence,
) {
  const destination = redirectDestination(destinationInput);
  const owned = await resolveOwnedActiveCall(actor, callId, { requireExactProviderLeg: true });

  let target: string;
  let destinationMetadata: {
    destinationKind: "operator" | "phone";
    destinationExtensionId?: string;
    destinationLifecycleEpoch?: string;
    destinationProfileId?: string;
  };
  if (destination.kind === "operator") {
    const targets = await listAvailableTransferTargets(actor, callId, owned);
    const verified = targets.find((candidate) => candidate.profileId === destination.profileId);
    if (!verified) {
      throw new MutationError("Cieľový operátor už nie je dostupný. Obnov zoznam a vyber inú klapku.", 409);
    }
    target = verified.extension;
    destinationMetadata = {
      destinationKind: "operator",
      destinationExtensionId: verified.extensionId,
      destinationLifecycleEpoch: verified.lifecycleEpoch,
      destinationProfileId: verified.profileId,
    };
  } else {
    if (sameDialNumber(destination.number, owned.extension.extension)) {
      throw new MutationError("Hovor nie je možné prepojiť späť na tú istú klapku.", 400);
    }
    target = destination.number;
    destinationMetadata = { destinationKind: "phone" };
  }

  const actionClaim = await claimOwnedExtensionAction(actor, owned.extension.id, "call.transfer.sip_refer", { leaseFence });
  try {
    return await beginBrowserSipReferTransferIntent({
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      callId: owned.call.id,
      extensionId: actionClaim.id,
      authorizedViptelUniqueId: owned.activeUniqueId,
      destination: target,
      ...destinationMetadata,
      assignmentGuard: actionClaim.assignmentGuard,
    });
  } catch (error) {
    await releaseExtensionAssignmentGuard(createSupabaseAdminClient(), actor.organizationId, actionClaim.assignmentGuard);
    throw error;
  }
}

export async function listAvailableTransferTargets(
  actor: MotoristActor,
  callId: string,
  resolved?: { activeUniqueId: string; call: CallRow; extension: OwnedExtension },
): Promise<VerifiedTelephonyTransferTarget[]> {
  const source = resolved ?? await resolveOwnedActiveCall(actor, callId, {
    allowRecentInboundQueueOwner: true,
  });
  const supabase = createSupabaseAdminClient();
  const [extensionRows, profilesResult, snapshot] = await Promise.all([
    supabase
      .from("motorist_telephony_extensions")
      .select("id, extension, profile_id, metadata")
      .eq("organization_id", actor.organizationId)
      .eq("provider", "viptel")
      .eq("active", true)
      .not("profile_id", "is", null),
    supabase
      .from("motorist_profiles")
      .select("id, display_name")
      .eq("organization_id", actor.organizationId)
      .eq("active", true),
    requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 }),
  ]);
  if (extensionRows.error) throw new Error(`Telephony extensions could not be loaded: ${extensionRows.error.message}`);
  if (profilesResult.error) throw new Error(`Telephony operators could not be loaded: ${profilesResult.error.message}`);

  const verifiedTargets: Array<{
    extension: string;
    id: string;
    lifecycleEpoch: string;
    profile_id: string;
  }> = [];
  for (const extension of extensionRows.data ?? []) {
    if (!extension.profile_id) continue;
    try {
      const lifecycle = await requireImmutableAssignmentLifecycle(
        supabase,
        actor.organizationId,
        extension,
        extension.profile_id,
      );
      verifiedTargets.push({
        extension: extension.extension,
        id: extension.id,
        lifecycleEpoch: lifecycle.epoch,
        profile_id: extension.profile_id,
      });
    } catch {
      // A member-writable row without the matching service-only assignment
      // proof is not exposed as a transfer destination.
    }
  }

  const lifecycleByExtensionId = new Map(
    verifiedTargets.map((extension) => [extension.id, extension.lifecycleEpoch]),
  );
  return selectAvailableTransferTargets({
    actorProfileId: actor.profileId,
    activeCalls: snapshot.activeCalls,
    extensions: verifiedTargets,
    profiles: profilesResult.data ?? [],
    providerExtensions: snapshot.extensions,
    queueStatuses: snapshot.queueStatuses,
    sourceExtensionId: source.extension.id,
  }).map((target) => ({
    ...target,
    lifecycleEpoch: lifecycleByExtensionId.get(target.extensionId) as string,
  }));
}

export function selectAvailableTransferTargets(input: {
  actorProfileId: string;
  activeCalls: ViptelActiveCall[];
  extensions: Array<{ id: string; extension: string; profile_id: string | null }>;
  profiles: Array<{ id: string; display_name: string }>;
  providerExtensions: ViptelExtension[];
  queueStatuses: ViptelQueueStatus[];
  sourceExtensionId: string;
}): TelephonyTransferTarget[] {
  const providerByNumber = new Map(input.providerExtensions.map((extension) => [extension.extension, extension]));
  const profileById = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const membershipsByExtension = new Map<string, ViptelQueueStatus["members"]>();
  for (const status of input.queueStatuses) {
    for (const member of status.members) {
      const memberships = membershipsByExtension.get(member.extension) ?? [];
      memberships.push(member);
      membershipsByExtension.set(member.extension, memberships);
    }
  }

  return input.extensions
    .flatMap((extension): TelephonyTransferTarget[] => {
      if (!extension.profile_id || extension.profile_id === input.actorProfileId || extension.id === input.sourceExtensionId) return [];
      const profile = profileById.get(extension.profile_id);
      const provider = providerByNumber.get(extension.extension);
      const memberships = membershipsByExtension.get(extension.extension) ?? [];
      const availableInQueue = memberships.some((member) => !member.paused && !member.inUse);
      const busy = input.activeCalls.some((call) => providerCallIsCurrentAtExtension(call, extension.extension));
      if (!profile || provider?.isRegistered !== true || !availableInQueue || busy) return [];
      return [{
        profileId: profile.id,
        operatorName: profile.display_name,
        extensionId: extension.id,
        extension: extension.extension,
      }];
    })
    .sort((left, right) => left.operatorName.localeCompare(right.operatorName, "sk", { sensitivity: "base" }));
}

async function resolveOwnedActiveCall(
  actor: MotoristActor,
  callId: string,
  options: { allowRecentInboundQueueOwner?: boolean; requireExactProviderLeg?: boolean } = {},
) {
  const id = requiredUuid(callId, "Hovor");
  const [callResult, ownedExtensions] = await Promise.all([
    createSupabaseAdminClient()
      .from("motorist_calls")
      .select("*")
      .eq("id", id)
      .eq("organization_id", actor.organizationId)
      .eq("provider", "viptel")
      .maybeSingle(),
    listOwnedTelephonyExtensions(actor),
  ]);
  if (callResult.error) throw new Error(`Telephony call could not be loaded: ${callResult.error.message}`);
  const call = callResult.data;
  if (!call) throw new MutationError("Hovor sa už v aktívnom call logu nenašiel.", 404);
  const recentTerminalQueueHandoff = options.allowRecentInboundQueueOwner === true &&
    storedCallCanAuthorizeIncomingQueueDecline(call);
  if (!ACTIVE_CALL_STATUSES.includes(call.status) && !recentTerminalQueueHandoff) {
    throw new MutationError("Hovor už nie je aktívny.", 409);
  }
  if (!call.viptel_unique_id) throw new MutationError("VIPTel ešte neposlal identifikátor potrebný na ovládanie hovoru.", 409);

  const eventAliases = await createSupabaseAdminClient()
    .from("motorist_call_events")
    .select("viptel_unique_id")
    .eq("organization_id", actor.organizationId)
    .eq("call_id", call.id)
    .not("viptel_unique_id", "is", null)
    .order("received_at", { ascending: false })
    .limit(20);
  if (eventAliases.error) throw new Error(`Telephony call aliases could not be loaded: ${eventAliases.error.message}`);
  const knownUniqueIds = new Set([
    call.viptel_unique_id,
    call.from_queue_unique_id,
    ...(eventAliases.data ?? []).map((event) => event.viptel_unique_id),
  ].filter((value): value is string => Boolean(value)));
  const correlate = (requireNewCapture: boolean) =>
    correlateOwnedProviderLeg({ actor, call, knownUniqueIds, options, ownedExtensions, requireNewCapture });
  try {
    return await correlate(options.requireExactProviderLeg === true);
  } catch (error) {
    // The queue rotation replaces the live agent leg every few seconds, so a
    // correlation built on a cached snapshot -- or on a fresh one captured a
    // beat before the rotation moved -- regularly describes the previous leg
    // at the previous workstation. That surfaced as "Aktuálny VIPTel leg už
    // patrí inému pracovnému miestu" on the first click and success on the
    // second, because the second click saw newer data. Do that second look
    // here instead: one retry against a forced-fresh capture. Every fence is
    // re-evaluated in full; only the staleness is removed.
    if (error instanceof MutationError && RETRYABLE_LEG_CORRELATION_CODES.has(error.code ?? "")) {
      return await correlate(true);
    }
    throw error;
  }
}

const RETRYABLE_LEG_CORRELATION_CODES = new Set([
  "call_leg_ambiguous",
  "call_leg_not_active",
  "call_leg_other_workstation",
]);

async function correlateOwnedProviderLeg({ actor, call, knownUniqueIds, options, ownedExtensions, requireNewCapture }: {
  actor: MotoristActor;
  call: CallRow;
  knownUniqueIds: Set<string>;
  options: { allowRecentInboundQueueOwner?: boolean; requireExactProviderLeg?: boolean };
  ownedExtensions: OwnedExtension[];
  requireNewCapture: boolean;
}) {
  const providerSnapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, {
    // A newly requested capture is already bounded by `requireNewCapture`.
    // Give the listener enough time to persist and return that exact capture;
    // a two-second age ceiling incorrectly rejected valid snapshots under
    // concurrent call load.
    maxAgeMs: EXACT_PROVIDER_SNAPSHOT_MAX_AGE_MS,
    requireNewCapture,
  });
  const providerActiveCalls = providerSnapshot.activeCalls;
  const matchingProviderCalls = providerActiveCalls.filter((candidate) =>
    isLiveProviderCall(candidate) && providerCallMatchesKnownIdentity(candidate, knownUniqueIds),
  );
  const correlatedUniqueIds = new Set([
    ...knownUniqueIds,
    ...matchingProviderCalls.flatMap((candidate) => [candidate.viptelUniqueId, candidate.fromQueueUniqueId]),
  ].filter((value): value is string => Boolean(value)));
  const matchingOwnedCurrentLegs = currentLogicalProviderLegsAtExtensions(
    matchingProviderCalls,
    ownedExtensions,
  );
  if (matchingOwnedCurrentLegs.length > 1) {
    throw new MutationError("Aktuálny VIPTel leg nie je jednoznačne priradený k jednému pracovnému miestu.", 409, "call_leg_ambiguous");
  }
  const recentQueueOwner = options.allowRecentInboundQueueOwner
    ? recentStoredInboundQueueOwner(actor, call, ownedExtensions)
    : undefined;
  if (matchingOwnedCurrentLegs.length === 0 && matchingProviderCalls.length > 0 && recentQueueOwner) {
    const relatedWorkplaceLegs = relatedLiveWorkplaceLegs(
      providerActiveCalls,
      matchingProviderCalls,
      providerSnapshot.personalExtensions,
    );
    if (relatedWorkplaceLegs.some((leg) => leg.extension !== recentQueueOwner.extension)) {
      throw new MutationError("Aktuálny VIPTel leg už patrí inému pracovnému miestu.", 403, "call_leg_other_workstation");
    }
    const currentOwnerLegs = relatedWorkplaceLegs.filter((leg) => leg.extension === recentQueueOwner.extension);
    if (currentOwnerLegs.length > 1) {
      throw new MutationError("Aktuálny VIPTel leg nie je jednoznačne priradený k jednému pracovnému miestu.", 409, "call_leg_ambiguous");
    }
    const correlated = currentOwnerLegs[0]?.call
      ?? matchingProviderCalls.find((candidate) => candidate.fromQueueUniqueId === call.from_queue_unique_id)
      ?? matchingProviderCalls.find((candidate) => candidate.viptelUniqueId === call.from_queue_unique_id)
      ?? matchingProviderCalls[0];
    if (!correlated?.viptelUniqueId) {
      throw new MutationError("VIPTel ešte neposlal identifikátor živého queue legu.", 409);
    }
    return {
      activeUniqueId: correlated.viptelUniqueId,
      activeFromQueueUniqueId: correlated.fromQueueUniqueId,
      call,
      extension: recentQueueOwner,
      knownUniqueIds: [...new Set([
        ...correlatedUniqueIds,
        correlated.viptelUniqueId,
        correlated.fromQueueUniqueId,
      ].filter((value): value is string => Boolean(value)))],
    };
  }
  if (options.requireExactProviderLeg) {
    if (matchingOwnedCurrentLegs.length === 0 && matchingProviderCalls.length > 0) {
      throw new MutationError("Aktuálny VIPTel leg už patrí inému pracovnému miestu.", 403, "call_leg_other_workstation");
    }

    const currentOwnedExtensions = ownedExtensions.filter((ownedExtension) =>
      providerActiveCalls.some((candidate) =>
        providerCallIsCurrentAtExtension(candidate, ownedExtension.extension),
      ),
    );
    const currentOwnedExtension = matchingOwnedCurrentLegs[0]?.extension ?? (
      currentOwnedExtensions.length === 1 ? currentOwnedExtensions[0] : null
    );
    if (!currentOwnedExtension) {
      if (currentOwnedExtensions.length > 1) {
        throw new MutationError("Na prihlásených pracovných miestach je viac než jeden aktívny hovor.", 409);
      }
      throw new MutationError("VIPTel už tento hovor nevedie ako aktívny. Obnov stav pred ďalšou akciou.", 409, "call_leg_not_active");
    }

    const exact = exactLiveProviderCallForExtension(
      providerActiveCalls,
      currentOwnedExtension.extension,
      correlatedUniqueIds,
    );
    if (!exact.ok) {
      if (exact.reason === "multiple_live_source_legs") {
        throw new MutationError(
          "VIPTel vedie na osobnej klapke viac než jeden aktívny hovor. DTMF prepojenie by nebolo jednoznačné.",
          409,
        );
      }
      if (exact.reason === "unique_id_mismatch") {
        throw new MutationError(
          "Aktívny VIPTel hovor nezodpovedá bezpečnej identite hovoru v aplikácii.",
          409,
        );
      }
      throw new MutationError("VIPTel už tento hovor nevedie ako aktívny. Obnov stav pred ďalšou akciou.", 409, "call_leg_not_active");
    }
    return {
      activeUniqueId: exact.call.viptelUniqueId as string,
      activeFromQueueUniqueId: exact.call.fromQueueUniqueId,
      call,
      extension: currentOwnedExtension,
      knownUniqueIds: [...correlatedUniqueIds],
    };
  }
  if (matchingOwnedCurrentLegs.length === 0) {
    if (matchingProviderCalls.length > 0) {
      throw new MutationError("Aktuálny VIPTel leg už patrí inému pracovnému miestu.", 403, "call_leg_other_workstation");
    }
    throw new MutationError("VIPTel už tento hovor nevedie ako aktívny. Obnov stav pred ďalšou akciou.", 409, "call_leg_not_active");
  }
  if (matchingOwnedCurrentLegs.length !== 1) {
    throw new MutationError("Aktuálny VIPTel leg nie je jednoznačne priradený k jednému pracovnému miestu.", 409, "call_leg_ambiguous");
  }
  const [{ call: currentProviderCall, extension: currentOwnedExtension }] = matchingOwnedCurrentLegs;
  const activeCall = currentProviderCall;
  if (!activeCall?.viptelUniqueId) {
    throw new MutationError("VIPTel už tento hovor nevedie ako aktívny. Obnov stav pred ďalšou akciou.", 409, "call_leg_not_active");
  }
  if (!providerCallIsCurrentAtExtension(activeCall, currentOwnedExtension.extension)) {
    throw new MutationError("Aktuálny VIPTel leg už nepoužíva osobnú klapku prihláseného operátora.", 403);
  }
  return {
    activeUniqueId: activeCall.viptelUniqueId,
    activeFromQueueUniqueId: activeCall.fromQueueUniqueId,
    call,
    extension: currentOwnedExtension,
    knownUniqueIds: [...correlatedUniqueIds],
  };
}

function relatedLiveWorkplaceLegs(
  providerActiveCalls: ViptelActiveCall[],
  identityMatches: ViptelActiveCall[],
  workplaceExtensions: string[],
) {
  const related = providerActiveCalls.filter((candidate) =>
    isLiveProviderCall(candidate) && identityMatches.includes(candidate),
  );
  return currentLogicalProviderLegsAtExtensions(
    related,
    workplaceExtensions.map((extension) => ({ extension })),
  ).map((leg) => ({ call: leg.call, extension: leg.extension.extension }));
}

function currentLogicalProviderLegsAtExtensions<T extends { extension: string }>(
  calls: ViptelActiveCall[],
  extensions: T[],
) {
  const currentLegs = currentViptelProviderCallLegs(calls);
  return extensions.flatMap((extension) =>
    groupViptelProviderCallLegs(currentLegs.filter((call) =>
      providerCallIsCurrentAtExtension(call, extension.extension),
    )).map((logicalCall) => ({
      call: preferredViptelProviderCallLeg(logicalCall),
      extension,
    })),
  );
}

function recentStoredInboundQueueOwner(
  actor: MotoristActor,
  call: CallRow,
  ownedExtensions: OwnedExtension[],
) {
  if (!storedCallCanAuthorizeIncomingQueueDecline(call)) return undefined;
  const exactCandidates = ownedExtensions.filter((extension) =>
    call.extension_id === extension.id ||
    [call.received_extension, call.destination_extension]
      .some((value) => exactEndpoint(value) === extension.extension),
  );
  if (exactCandidates.length > 0) return exactCandidates.length === 1 ? exactCandidates[0] : undefined;
  return call.operator_id === actor.profileId && ownedExtensions.length === 1
    ? ownedExtensions[0]
    : undefined;
}

/**
 * VIPTel can mark an offered agent leg as answered a few moments before the
 * browser has actually accepted its SIP INVITE. Keep that narrow race usable,
 * but never let an old answered row authorize termination after ownership has
 * moved to another workstation.
 */
export function storedCallCanAuthorizeIncomingQueueDecline(
  call: Pick<CallRow, "answered_at" | "direction" | "ended_at" | "from_queue_unique_id" | "status" | "updated_at">,
  now = Date.now(),
) {
  if (call.direction !== "inbound" || !call.from_queue_unique_id || call.ended_at) return false;
  if (call.status === "incoming" || call.status === "ringing_agent") return true;
  if (["abandoned_queue", "missed"].includes(call.status) && !call.answered_at) {
    const handoffAt = Date.parse(call.updated_at);
    return Number.isFinite(handoffAt) && handoffAt <= now + 5_000 &&
      now - handoffAt <= TERMINAL_QUEUE_HANDOFF_CONTROL_GRACE_MS;
  }
  if (call.status !== "answered") return false;
  const providerTransitionAt = Date.parse(call.answered_at ?? call.updated_at);
  return Number.isFinite(providerTransitionAt) &&
    providerTransitionAt <= now + 5_000 &&
    now - providerTransitionAt <= ANSWERED_QUEUE_DECLINE_GRACE_MS;
}

function exactEndpoint(value: string | null | undefined) {
  return value?.trim().replace(/^sip:/i, "").split("@")[0];
}

function requiredUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw new MutationError(`${label} nemá platný identifikátor.`, 400);
  }
  return value.trim();
}

export function redirectDestination(input: {
  destinationNumber?: unknown;
  destinationProfileId?: unknown;
}): { kind: "operator"; profileId: string } | { kind: "phone"; number: string } {
  const profileId = typeof input.destinationProfileId === "string" ? input.destinationProfileId.trim() : "";
  const rawNumber = typeof input.destinationNumber === "string" ? input.destinationNumber.trim() : "";
  if (Boolean(profileId) === Boolean(rawNumber)) {
    throw new MutationError("Vyber práve jedno cieľové pracovisko alebo zadaj jedno telefónne číslo.", 400);
  }
  if (profileId) return { kind: "operator", profileId: requiredUuid(profileId, "Cieľový operátor") };

  try {
    const parsed = cleanPhoneInput(rawNumber, "Telefónne číslo");
    if (parsed.kind !== "phone") {
      throw new TelephonyPhoneInputError("Klapku je potrebné vybrať zo zoznamu overených pracovísk.");
    }
    const number = formatViptelDialTarget(rawNumber, "Telefónne číslo");
    if (!/^\d{2,18}$/.test(number)) {
      throw new TelephonyPhoneInputError("Telefónne číslo musí mať 2 až 18 číslic.");
    }
    return { kind: "phone", number };
  } catch (error) {
    if (error instanceof TelephonyPhoneInputError) {
      throw new MutationError(error.message, 400);
    }
    throw error;
  }
}

function dtmfTransferMode(value: unknown): DtmfTransferMode {
  if (value === "blind" || value === "attended") return value;
  throw new MutationError("Spôsob prepojenia musí byť bez ohlásenia alebo s ohlásením.", 400);
}
