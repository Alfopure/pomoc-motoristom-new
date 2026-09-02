import type { ViptelActiveCall } from "@/lib/integrations/viptel/client";

const LIVE_PROVIDER_CALL_STATUSES = new Set<ViptelActiveCall["status"]>([
  "incoming",
  "ringing_agent",
  "answered",
  "outbound",
]);

export type ExactLiveProviderCallResult =
  | { ok: true; call: ViptelActiveCall }
  | { ok: false; reason: "no_live_source_leg" | "multiple_live_source_legs" | "unique_id_mismatch" };

export function isLiveProviderCall(call: Pick<ViptelActiveCall, "status">) {
  return LIVE_PROVIDER_CALL_STATUSES.has(call.status);
}

/**
 * VIPTel can expose both a queue parent and its current agent leg in one
 * statistics response. Keep the leaf leg for UI/presence calculations, while
 * preserving unrelated calls even when their timestamps are identical.
 */
export function currentViptelProviderCallLegs(calls: ViptelActiveCall[]) {
  const supersededUniqueIds = new Set(calls
    .filter(isLiveProviderCall)
    .map((call) => call.fromQueueUniqueId)
    .filter((value): value is string => Boolean(value)));

  return calls.filter((call) =>
    !isLiveProviderCall(call) || !call.viptelUniqueId || !supersededUniqueIds.has(call.viptelUniqueId),
  );
}

/**
 * VIPTel can expose more than one row for one logical call. The relationship
 * is trusted only when provider identifiers overlap; caller number and time
 * are deliberately excluded because two callers can arrive simultaneously.
 */
export function sameViptelProviderCallIdentity(
  left: Pick<ViptelActiveCall, "fromQueueUniqueId" | "providerCallId" | "viptelUniqueId">,
  right: Pick<ViptelActiveCall, "fromQueueUniqueId" | "providerCallId" | "viptelUniqueId">,
) {
  if (left.providerCallId && left.providerCallId === right.providerCallId) return true;
  const leftIds = new Set([left.viptelUniqueId, left.fromQueueUniqueId].filter(Boolean));
  return [right.viptelUniqueId, right.fromQueueUniqueId]
    .some((identity) => Boolean(identity && leftIds.has(identity)));
}

export function groupViptelProviderCallLegs(calls: ViptelActiveCall[]) {
  const groups: ViptelActiveCall[][] = [];
  for (const call of calls) {
    const matchingIndexes = groups.flatMap((group, index) =>
      group.some((candidate) => sameViptelProviderCallIdentity(candidate, call)) ? [index] : [],
    );
    if (matchingIndexes.length === 0) {
      groups.push([call]);
      continue;
    }

    const firstIndex = matchingIndexes[0] as number;
    const merged = [call, ...matchingIndexes.flatMap((index) => groups[index] ?? [])];
    groups[firstIndex] = merged;
    for (const index of matchingIndexes.slice(1).sort((left, right) => right - left)) {
      groups.splice(index, 1);
    }
  }
  return groups;
}

export function providerCallUsesExtension(call: ViptelActiveCall, extension: string) {
  if (!isLiveProviderCall(call)) return false;
  return [
    call.callerExtension,
    call.receivedExtension,
    call.destinationExtension,
    call.callerNumber,
    call.calledNumber,
  ].some((value) => exactEndpoint(value) === extension);
}

/**
 * Whether the provider currently presents this call at an extension. Route
 * history such as `receivedExtension` must not leave the previous operator in
 * control after a redirect.
 */
export function providerCallIsCurrentAtExtension(call: ViptelActiveCall, extension: string) {
  if (!isLiveProviderCall(call)) return false;
  const matches = (...values: Array<string | undefined>) =>
    values.some((value) => exactEndpoint(value) === extension);

  if (call.direction === "inbound") {
    const currentDestinationValues = [call.destinationExtension, call.destinationNumber, call.calledNumber];
    if (matches(...currentDestinationValues)) return true;
    // VIPTel can omit direction for a browser-originated call. The normalizer
    // then labels it inbound even though the workstation is clearly the
    // source and there is no queue/received endpoint.
    if (!call.receivedExtension && !call.queueNumber && matches(call.callerExtension, call.callerNumber)) {
      return true;
    }
    // An explicit current provider destination is authoritative even when it
    // is a queue, public DID or another extension. `receivedExtension` can be
    // the historical agent leg and must not grant control to that workstation.
    if (currentDestinationValues.some((value) => Boolean(value?.trim()))) return false;
    if (matches(call.receivedExtension)) return true;
    // Some browser-originated VIPTel statistics rows have no direction and
    // are therefore normalized as inbound. With no queue/received endpoint,
    // an exact internal caller endpoint is the current browser source.
    return matches(call.callerExtension);
  }
  if (call.direction === "outbound") {
    return matches(call.callerExtension, call.callerNumber, call.receivedExtension);
  }
  return matches(
    call.callerExtension,
    call.callerNumber,
    call.destinationExtension,
    call.destinationNumber,
    call.calledNumber,
  );
}

export function exactLiveProviderCallForExtension(
  calls: ViptelActiveCall[],
  extension: string,
  knownUniqueIds: ReadonlySet<string>,
): ExactLiveProviderCallResult {
  const sourceLegs = currentViptelProviderCallLegs(calls)
    .filter((call) => providerCallIsCurrentAtExtension(call, extension));
  if (sourceLegs.length === 0) return { ok: false, reason: "no_live_source_leg" };
  const logicalCalls = groupViptelProviderCallLegs(sourceLegs);
  if (logicalCalls.length !== 1) return { ok: false, reason: "multiple_live_source_legs" };

  const logicalCall = logicalCalls[0] as ViptelActiveCall[];
  if (!logicalCall.some((call) => providerCallMatchesKnownIdentity(call, knownUniqueIds))) {
    return { ok: false, reason: "unique_id_mismatch" };
  }
  const call = preferredViptelProviderCallLeg(logicalCall);
  return { ok: true, call };
}

export function preferredViptelProviderCallLeg(calls: ViptelActiveCall[]) {
  const sorted = [...calls].sort((left, right) => {
    const childDifference = Number(Boolean(right.fromQueueUniqueId)) - Number(Boolean(left.fromQueueUniqueId));
    if (childDifference !== 0) return childDifference;
    const endpointDifference = providerEndpointScore(right) - providerEndpointScore(left);
    if (endpointDifference !== 0) return endpointDifference;
    const statusDifference = providerStatusScore(right.status) - providerStatusScore(left.status);
    if (statusDifference !== 0) return statusDifference;
    return providerStableIdentity(left).localeCompare(providerStableIdentity(right));
  });
  return sorted[0] as ViptelActiveCall;
}

/**
 * A queue offer has its own agent-leg unique id. During the small ingestion
 * window before that alias is persisted, VIPTel can already expose the stable
 * queue-parent id on the live row. Either exact id safely ties the leg to the
 * same logical call; endpoint ownership is checked separately.
 */
export function providerCallMatchesKnownIdentity(
  call: Pick<ViptelActiveCall, "fromQueueUniqueId" | "viptelUniqueId">,
  knownUniqueIds: ReadonlySet<string>,
) {
  return [call.viptelUniqueId, call.fromQueueUniqueId]
    .some((value) => Boolean(value && knownUniqueIds.has(value)));
}

function exactEndpoint(value: string | undefined) {
  return value?.trim().replace(/^sip:/i, "").split("@")[0];
}

function providerEndpointScore(call: ViptelActiveCall) {
  return [call.destinationExtension, call.destinationNumber, call.calledNumber, call.callerExtension]
    .filter(Boolean).length;
}

function providerStatusScore(status: ViptelActiveCall["status"]) {
  if (status === "answered" || status === "outbound") return 3;
  if (status === "ringing_agent") return 2;
  if (status === "incoming") return 1;
  return 0;
}

function providerStableIdentity(call: ViptelActiveCall) {
  return [call.providerCallId, call.viptelUniqueId, call.fromQueueUniqueId].filter(Boolean).join("\n");
}
