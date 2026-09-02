import type { CallCenterCall } from "@/data/dispatch-types";
import { sameDialNumber } from "@/lib/telephony/phone";

export type TelephonyExtensionIdentity = {
  extension: string;
  id?: string;
  profileId?: string;
};

const LIVE_CALL_STATUSES = new Set<CallCenterCall["status"]>([
  "incoming",
  "ringing_agent",
  "answered",
  "outbound",
]);

export function partitionLiveTelephonyCalls(calls: CallCenterCall[]) {
  return {
    active: calls.filter((call) => LIVE_CALL_STATUSES.has(call.status)),
    completed: calls.filter((call) => !LIVE_CALL_STATUSES.has(call.status)),
  };
}

/**
 * A successful provider snapshot is authoritative for calls that can be
 * controlled now. Supabase remains the source for completed history, but an
 * empty provider array must not be interpreted as "not loaded" and must not
 * leave a stale active history row on screen.
 */
export function mergeProviderCallsWithHistory(
  historyCalls: CallCenterCall[],
  providerCalls: CallCenterCall[] | null,
) {
  const normalizedHistory = historyCalls.map(terminalPresentationInvariant);
  if (providerCalls === null) return normalizedHistory;

  const completedHistory = normalizedHistory.filter((call) => !LIVE_CALL_STATUSES.has(call.status));
  const historyWithoutProviderDuplicates = completedHistory.filter((historical) =>
    !providerCalls.some((live) => sameTelephonyCallIdentity(historical, live)),
  );
  return [...providerCalls, ...historyWithoutProviderDuplicates];
}

function terminalPresentationInvariant(call: CallCenterCall): CallCenterCall {
  if (!call.endedAt || !LIVE_CALL_STATUSES.has(call.status)) return call;
  const status: CallCenterCall["status"] = call.answeredAt
    ? "ended"
    : call.direction === "outbound"
      ? "failed"
      : "missed";
  return { ...call, status };
}

export function resolveTelephonyCallStations<T extends TelephonyExtensionIdentity>(
  call: CallCenterCall,
  stations: T[],
) {
  const byEndpoint = (...values: Array<string | undefined>) => {
    for (const value of values) {
      const endpoint = exactTelephonyEndpoint(value);
      const station = endpoint ? stations.find((candidate) => candidate.extension === endpoint) : undefined;
      if (station) return station;
    }
    return undefined;
  };
  const byOperator = () => call.operatorId
    ? stations.find((station) => station.profileId === call.operatorId)
    : undefined;

  if (call.direction === "inbound") {
    const currentDestinationValues = [
      call.destinationExtension,
      call.destinationNumber,
      call.calledNumber,
    ];
    const destination = byEndpoint(...currentDestinationValues) ?? (
      currentDestinationValues.some(hasEndpointValue)
        ? undefined
        : byOperator() ?? byEndpoint(call.receivedExtension)
    );
    return { current: destination ? [destination] : [], destination, source: undefined };
  }

  const source = byEndpoint(call.callerExtension, call.callerNumber, call.receivedExtension)
    ?? byOperator();
  if (call.direction === "outbound") {
    return { current: source ? [source] : [], destination: undefined, source };
  }

  const destination = byEndpoint(call.destinationExtension, call.destinationNumber, call.calledNumber);
  const current = [source, destination]
    .filter((station): station is T => Boolean(station))
    .filter((station, index, list) => list.findIndex((item) => item.extension === station.extension) === index);
  return { current, destination, source };
}

export function callIsCurrentAtTelephonyStation(
  call: CallCenterCall,
  station: TelephonyExtensionIdentity,
  stations: TelephonyExtensionIdentity[],
) {
  if (call.direction === "inbound") {
    return currentInboundDestinationExtensions(call, stations).includes(station.extension);
  }
  return resolveTelephonyCallStations(call, stations).current.some(
    (candidate) => candidate.extension === station.extension,
  );
}

function hasEndpointValue(value: string | undefined) {
  return Boolean(value?.trim());
}

/**
 * Ringing UI must only follow the provider's current destination. Historical
 * fields such as `receivedExtension` and the stored operator are useful for
 * call history, but can belong to the previous queue leg after a reject or
 * redirect. Using them here would show actionable incoming-call UI to an
 * operator whose phone is not ringing.
 */
export function callIsRingingAtTelephonyStation(
  call: CallCenterCall,
  station: TelephonyExtensionIdentity,
  stations: TelephonyExtensionIdentity[],
) {
  if (call.direction !== "inbound" || !["incoming", "ringing_agent"].includes(call.status)) {
    return false;
  }

  return currentInboundDestinationExtensions(call, stations).includes(station.extension);
}

/**
 * Correlates an actual inbound browser SIP session with the provider row used
 * for audited call control. VIPTel may report an already offered browser leg
 * as `answered` while SIP.js is still presenting the INVITE locally, so the
 * provider status alone is not a reliable ringing signal.
 *
 * This resolver must only be called while this browser has a live inbound SIP
 * session. It fails closed when more than one provider call could own that
 * session and never returns a terminal or non-persisted row.
 */
export function resolveIncomingBrowserProviderCall(
  calls: CallCenterCall[],
  station: TelephonyExtensionIdentity | undefined,
  stations: TelephonyExtensionIdentity[],
) {
  const candidates = calls.filter(isSafeIncomingBrowserProviderCall);
  if (candidates.length === 0) return undefined;

  if (station) {
    const exactStationCandidates = candidates.filter((call) =>
      currentInboundDestinationExtensions(call, stations).includes(station.extension),
    );
    const exactStationCall = uniqueBestIncomingCandidate(exactStationCandidates);
    if (exactStationCall) return exactStationCall;
    if (exactStationCandidates.length > 0) return undefined;

    // A browser may use the single provider row only when VIPTel omitted every
    // known workstation endpoint. Never borrow a leg that is explicitly
    // ringing at another workstation: the local SIP INVITE can outlive that
    // provider leg briefly after a queue handoff.
    const unassignedCandidates = candidates.filter((call) =>
      currentInboundDestinationExtensions(call, stations).length === 0,
    );
    return uniqueBestIncomingCandidate(unassignedCandidates);
  }

  return uniqueBestIncomingCandidate(candidates);
}

/**
 * Returns the one live provider call that belongs to a workstation. A single
 * SIP.js SimpleUser can control only one dialog, so two different provider
 * identities at the same workstation are deliberately treated as ambiguous.
 * Timestamps are never used as identity: simultaneous calls remain separate.
 */
export function resolveUniqueCurrentTelephonyCall(
  calls: CallCenterCall[],
  station: TelephonyExtensionIdentity | undefined,
  stations: TelephonyExtensionIdentity[],
) {
  if (!station) return undefined;
  return uniqueCallCandidate(calls.filter((call) =>
    isLiveProviderCall(call) && callIsCurrentAtTelephonyStation(call, station, stations),
  ));
}

/**
 * Correlates the browser's one outbound SIP dialog to one provider row. Some
 * VIPTel snapshots describe a browser-originated call as an inbound-looking
 * leg, therefore an exact source extension plus the exact dialled destination
 * is accepted. No array-order fallback is allowed.
 */
export function resolveOutboundBrowserProviderCall(
  calls: CallCenterCall[],
  station: TelephonyExtensionIdentity | undefined,
  stations: TelephonyExtensionIdentity[],
  target: string | null | undefined,
) {
  if (!station) return undefined;
  const normalizedTarget = target?.trim();
  const candidates = calls.filter((call) => {
    if (!isLiveProviderCall(call)) return false;
    if (callIsCurrentAtTelephonyStation(call, station, stations)) return true;
    if (!normalizedTarget) return false;

    const exactSource = [call.callerExtension, call.callerNumber, call.receivedExtension]
      .some((value) => exactTelephonyEndpoint(value) === station.extension);
    return exactSource && callMatchesDialTarget(call, normalizedTarget);
  });

  if (normalizedTarget) {
    const exactTarget = candidates.filter((call) => callMatchesDialTarget(call, normalizedTarget));
    const explicitOutbound = exactTarget.filter((call) => call.direction === "outbound");
    if (explicitOutbound.length > 0) return uniqueCallCandidate(explicitOutbound);
    return uniqueCallCandidate(exactTarget);
  }

  const explicitOutbound = candidates.filter((call) => call.direction === "outbound");
  if (explicitOutbound.length > 0) return uniqueCallCandidate(explicitOutbound);
  return uniqueCallCandidate(candidates);
}

function currentInboundDestinationExtensions(
  call: Pick<CallCenterCall, "calledNumber" | "destinationExtension" | "destinationNumber">,
  stations: TelephonyExtensionIdentity[],
) {
  return [call.destinationExtension, call.destinationNumber, call.calledNumber]
    .map(exactTelephonyEndpoint)
    .filter((value): value is string => Boolean(value))
    .filter((value) => stations.some((candidate) => candidate.extension === value));
}

function isSafeIncomingBrowserProviderCall(call: CallCenterCall) {
  return call.direction === "inbound" &&
    ["incoming", "ringing_agent", "answered"].includes(call.status) &&
    UUID_PATTERN.test(call.id) &&
    Boolean(call.viptelUniqueId?.trim());
}

function uniqueBestIncomingCandidate(calls: CallCenterCall[]) {
  if (calls.length === 0) return undefined;
  const bestRank = Math.min(...calls.map(incomingStatusRank));
  const best = calls.filter((call) => incomingStatusRank(call) === bestRank);
  return uniqueCallCandidate(best);
}

function incomingStatusRank(call: CallCenterCall) {
  return call.status === "incoming" || call.status === "ringing_agent" ? 0 : 1;
}

function isLiveProviderCall(call: CallCenterCall) {
  return LIVE_CALL_STATUSES.has(call.status);
}

function callMatchesDialTarget(call: CallCenterCall, target: string) {
  return [call.destinationNumber, call.calledNumber]
    .some((value) => sameDialNumber(value, target));
}

function uniqueCallCandidate(calls: CallCenterCall[]) {
  const logicalCalls = groupTelephonyCallLegs(calls);
  return logicalCalls.length === 1
    ? preferredTelephonyCallLeg(logicalCalls[0] as CallCenterCall[])
    : undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function callTouchesTelephonyStation(
  call: CallCenterCall,
  station: TelephonyExtensionIdentity,
  stations: TelephonyExtensionIdentity[],
) {
  const endpointStations = [
    call.callerExtension,
    call.receivedExtension,
    call.destinationExtension,
    call.callerNumber,
    call.calledNumber,
  ].map(exactTelephonyEndpoint)
    .filter((value): value is string => Boolean(value))
    .filter((value) => stations.some((candidate) => candidate.extension === value));
  if (endpointStations.length > 0) return endpointStations.includes(station.extension);
  return Boolean(station.profileId && call.operatorId === station.profileId);
}

export function sameTelephonyCallIdentity(
  left: Pick<CallCenterCall, "fromQueueUniqueId" | "id" | "providerCallId" | "viptelUniqueId">,
  right: Pick<CallCenterCall, "fromQueueUniqueId" | "id" | "providerCallId" | "viptelUniqueId">,
) {
  if (left.providerCallId && left.providerCallId === right.providerCallId) return true;

  const leftViptelIds = new Set([left.viptelUniqueId, left.fromQueueUniqueId].filter(Boolean));
  const rightViptelIds = [right.viptelUniqueId, right.fromQueueUniqueId].filter(Boolean);
  if (rightViptelIds.some((identity) => leftViptelIds.has(identity))) return true;

  if (UUID_PATTERN.test(left.id) && left.id === right.id) {
    // The stored id is a useful fallback only while one side has no provider
    // identity. If both snapshots have disjoint provider identities, merging
    // them would let one simultaneous call replace another in the browser.
    return leftViptelIds.size === 0 || rightViptelIds.length === 0;
  }
  return false;
}

/**
 * Stable React key for a call row.
 *
 * `call.id` alone is not unique by contract: `mergeProviderCallsWithHistory`
 * deduplicates by `sameTelephonyCallIdentity`, and that function deliberately
 * refuses to treat two rows sharing a stored id as the same call once both
 * carry disjoint provider identities. Two simultaneous callers can therefore
 * legitimately reach the browser with the same id and must render as separate
 * rows instead of colliding into one duplicate key.
 *
 * Positions are fixed and absent values render as an empty segment, so a
 * missing provider identity can never shift another value into its slot.
 */
export function telephonyCallReactKey(
  call: Pick<CallCenterCall, "fromQueueUniqueId" | "id" | "providerCallId" | "viptelUniqueId">,
) {
  return [
    call.id,
    call.providerCallId ?? "",
    call.viptelUniqueId ?? "",
    call.fromQueueUniqueId ?? "",
  ].join("|");
}

/**
 * Groups only provider-proven legs of the same logical call. Time and caller
 * number are intentionally not identities: separate callers can arrive in the
 * same millisecond and must remain independently controllable.
 */
export function groupTelephonyCallLegs(calls: CallCenterCall[]) {
  const groups: CallCenterCall[][] = [];
  for (const call of calls) {
    const matchingIndexes = groups.flatMap((group, index) =>
      group.some((candidate) => sameTelephonyCallIdentity(candidate, call)) ? [index] : [],
    );
    if (matchingIndexes.length === 0) {
      groups.push([call]);
      continue;
    }

    const firstIndex = matchingIndexes[0] as number;
    groups[firstIndex] = [call, ...matchingIndexes.flatMap((index) => groups[index] ?? [])];
    for (const index of matchingIndexes.slice(1).sort((left, right) => right - left)) {
      groups.splice(index, 1);
    }
  }
  return groups;
}

export function collapseLogicalTelephonyCalls(calls: CallCenterCall[]) {
  return groupTelephonyCallLegs(calls).map(preferredTelephonyCallLeg);
}

function preferredTelephonyCallLeg(calls: CallCenterCall[]) {
  return [...calls].sort((left, right) => {
    // A queue parent can remain live while the just-finished agent offer is
    // already `missed`. Lifecycle wins before topology so a terminal child
    // can never hide the still-waiting logical call.
    const statusDifference = telephonyPresentationStatusScore(right.status) - telephonyPresentationStatusScore(left.status);
    if (statusDifference !== 0) return statusDifference;
    const childDifference = Number(Boolean(right.fromQueueUniqueId)) - Number(Boolean(left.fromQueueUniqueId));
    if (childDifference !== 0) return childDifference;
    const endpointDifference = telephonyEndpointScore(right) - telephonyEndpointScore(left);
    if (endpointDifference !== 0) return endpointDifference;
    return telephonyStableIdentity(left).localeCompare(telephonyStableIdentity(right));
  })[0] as CallCenterCall;
}

function telephonyEndpointScore(call: CallCenterCall) {
  return [call.destinationExtension, call.destinationNumber, call.calledNumber, call.callerExtension]
    .filter(Boolean).length;
}

function telephonyPresentationStatusScore(status: CallCenterCall["status"]) {
  if (status === "incoming" || status === "ringing_agent") return 3;
  if (status === "answered" || status === "outbound") return 2;
  return 0;
}

function telephonyStableIdentity(call: CallCenterCall) {
  return [call.providerCallId, call.viptelUniqueId, call.fromQueueUniqueId, call.id].filter(Boolean).join("\n");
}

export function exactTelephonyEndpoint(value: string | undefined) {
  return value?.trim().replace(/^sip:/i, "").split("@")[0];
}
