import type { CallCenterCall } from "@/data/dispatch-types";
import type { Operator } from "@/domain/types";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import {
  callIsCurrentAtTelephonyStation,
  collapseLogicalTelephonyCalls,
  exactTelephonyEndpoint,
  resolveTelephonyCallStations,
} from "@/lib/telephony/call-endpoints";
import type {
  TelephonyExtensionSnapshot,
  TelephonyOperatorPresence,
  TelephonyPresenceSnapshot,
} from "@/lib/telephony/presence";

export const WORKPLACE_EXTENSIONS = ["20", "21", "22", "23"] as const;
export const RINGING_QUEUES = ["601", "602", "603"] as const;

export type WorkplaceStationState =
  | "free"
  | "ready"
  | "ringing"
  | "on_call"
  | "paused"
  | "disconnected"
  | "unverified";

export type WorkplaceStation = {
  activeCalls: CallCenterCall[];
  extension: string;
  id: string;
  name: string;
  initials: string;
  position: number;
  profileId?: string;
  queue?: string;
  queueMemberships: string[];
  queuePriority?: number;
  state: WorkplaceStationState;
  stateDetail: string;
};

export type WorkplaceRouteStep = {
  station: WorkplaceStation;
  state: "accepted" | "current" | "planned" | "previous";
};

export type WorkplaceCallRoute = {
  call: CallCenterCall;
  currentStation?: WorkplaceStation;
  direction: CallCenterCall["direction"];
  mode: "outbound" | "queue_plan" | "transfer";
  steps: WorkplaceRouteStep[];
};

export type WorkplaceRoutingStatus = {
  detail: string;
  verified: boolean;
};

export type WorkplaceRoutingPlanSlot = {
  queue: (typeof RINGING_QUEUES)[number];
  extension: string | null;
};

type WorkplaceModelInput = {
  activeCalls: CallCenterCall[];
  health: TelephonyHealthSignal;
  operators: Operator[];
  operatorPresences: TelephonyOperatorPresence[];
  snapshot: TelephonyPresenceSnapshot | null;
};

export type WorkplaceWaitingCall = {
  call: CallCenterCall;
  station?: WorkplaceStation;
};

export function buildWorkplaceStations(input: WorkplaceModelInput): WorkplaceStation[] {
  const extensions = new Map((input.snapshot?.extensions ?? []).map((item) => [item.extension, item]));
  const operators = new Map(input.operators.map((operator) => [operator.id, operator]));
  const presences = new Map(input.operatorPresences.map((presence) => [presence.profileId, presence]));
  const memberships = queueMemberships(input.snapshot);
  const stationIdentities = WORKPLACE_EXTENSIONS.map((extension) => {
    const extensionSnapshot = extensions.get(extension);
    return {
      extension,
      profileId: extensionSnapshot?.active ? extensionSnapshot.profileId : undefined,
    };
  });

  return WORKPLACE_EXTENSIONS.map((extension, index) => {
    const extensionSnapshot = extensions.get(extension);
    const profileId = extensionSnapshot?.active ? extensionSnapshot.profileId : undefined;
    const operator = profileId ? operators.get(profileId) : undefined;
    const presence = profileId ? presences.get(profileId) : undefined;
    const extensionMemberships = memberships.get(extension) ?? [];
    const queue = extensionMemberships[0];
    const currentCalls = collapseLogicalTelephonyCalls(input.activeCalls.filter((call) =>
      callIsCurrentAtTelephonyStation(call, { extension, profileId }, stationIdentities),
    ));
    const name = profileId
      ? operator?.name ?? presence?.operatorName ?? "Priradený operátor"
      : "Neobsadené";
    const state = stationState({
      activeCalls: currentCalls,
      extensionSnapshot,
      health: input.health,
      presence,
      profileId,
    });

    return {
      activeCalls: currentCalls,
      extension,
      id: extensionSnapshot?.id ?? `workplace-${extension}`,
      initials: profileId ? initials(name) : "—",
      name,
      position: index + 1,
      profileId,
      queue,
      queueMemberships: extensionMemberships,
      queuePriority: queue ? RINGING_QUEUES.indexOf(queue as (typeof RINGING_QUEUES)[number]) + 1 : undefined,
      state,
      stateDetail: stationStateDetail(state, extension, name, extensionSnapshot, profileId),
    };
  });
}

export function buildWorkplaceCallRoute(
  call: CallCenterCall,
  stations: WorkplaceStation[],
): WorkplaceCallRoute {
  const resolved = resolveTelephonyCallStations(call, stations);
  const currentStation = resolved.current[0];

  if (call.direction === "inbound") {
    const planned: WorkplaceStation[] = stations
      .filter((station) =>
        station.queuePriority !== undefined &&
        (station.id === currentStation?.id || station.state === "ready" || station.state === "ringing"),
      )
      .sort((left, right) => (left.queuePriority ?? 99) - (right.queuePriority ?? 99));
    if (currentStation && !planned.some((station) => station.id === currentStation.id)) {
      const receivedEndpoint = exactTelephonyEndpoint(call.receivedExtension);
      const receivedStation = receivedEndpoint
        ? stations.find((station) => station.extension === receivedEndpoint)
        : undefined;
      const direct = [receivedStation, currentStation]
        .filter((station): station is WorkplaceStation => Boolean(station))
        .filter((station, index, list) => list.findIndex((item) => item.id === station.id) === index);
      return {
        call,
        currentStation,
        direction: call.direction,
        mode: "transfer",
        steps: direct.map((station, index) => ({
          station,
          state: station.id === currentStation.id
            ? call.status === "answered" ? "accepted" : "current"
            : index === 0 ? "previous" : "planned",
        })),
      };
    }
    const currentIndex = currentStation ? planned.findIndex((station) => station.id === currentStation.id) : -1;

    return {
      call,
      currentStation,
      direction: call.direction,
      mode: "queue_plan",
      steps: planned.map((station, index) => ({
        station,
        state:
          station.id === currentStation?.id
            ? call.status === "answered"
              ? "accepted"
              : "current"
            : currentIndex >= 0 && index < currentIndex
              ? "previous"
              : "planned",
      })),
    };
  }

  const destination = resolved.destination;
  const source = resolved.source ?? currentStation;
  const steps = [source, destination]
    .filter((station): station is WorkplaceStation => Boolean(station))
    .filter((station, index, list) => list.findIndex((item) => item.id === station.id) === index)
    .map((station, index, list): WorkplaceRouteStep => ({
      station,
      state: index === list.length - 1 && call.status === "answered" ? "accepted" : "current",
    }));

  return {
    call,
    currentStation: destination ?? source,
    direction: call.direction,
    mode: call.direction === "internal" ? "transfer" : "outbound",
    steps,
  };
}

export function buildWorkplaceWaitingRoom(
  calls: CallCenterCall[],
  stations: WorkplaceStation[],
): WorkplaceWaitingCall[] {
  return collapseLogicalTelephonyCalls(calls
    .filter((call) => call.direction === "inbound" && ["incoming", "ringing_agent"].includes(call.status)))
    .map((call) => ({
      call,
      station: resolveTelephonyCallStations(call, stations).destination,
    }))
    .sort((left, right) => Date.parse(left.call.startedAt) - Date.parse(right.call.startedAt));
}

export function getWorkplaceRoutingStatus(
  stations: WorkplaceStation[],
  health: TelephonyHealthSignal,
  snapshot: TelephonyPresenceSnapshot | null,
  activePlan: WorkplaceRoutingPlanSlot[],
): WorkplaceRoutingStatus {
  if (health.state !== "live") {
    return { verified: false, detail: "Aktuálne poradie zvonenia sa nepodarilo overiť." };
  }

  const stationExtensions = new Set(stations.map((station) => station.extension));
  const expected = new Map(activePlan.map((slot) => [slot.queue, slot.extension]));
  const selectedExtensions = activePlan
    .map((slot) => slot.extension)
    .filter((extension): extension is string => Boolean(extension));
  const queueStatuses = new Map<string, TelephonyPresenceSnapshot["queueStatuses"]>();
  for (const queue of RINGING_QUEUES) {
    queueStatuses.set(queue, snapshot?.queueStatuses.filter((status) => status.queue === queue) ?? []);
  }
  const exactMembership =
    activePlan.length === RINGING_QUEUES.length &&
    selectedExtensions.length > 0 &&
    RINGING_QUEUES.every((queue) => {
      const statuses = queueStatuses.get(queue) ?? [];
      if (statuses.length !== 1) return false;
      const expectedExtension = expected.get(queue) ?? null;
      if (!expectedExtension) return statuses[0].members.length === 0;
      return statuses[0].members.length === 1 &&
        statuses[0].members[0].extension === expectedExtension &&
        stationExtensions.has(expectedExtension);
    });
  const uniqueMembers = new Set(selectedExtensions);
  const crossMembership = stations.some((station) => station.queueMemberships.length > 1);
  if (!exactMembership || uniqueMembers.size !== selectedExtensions.length || crossMembership) {
    return { verified: false, detail: "Aktívne členstvo radov nezodpovedá potvrdenému poradiu operátorov." };
  }

  return {
    verified: true,
    detail: routingVerificationDetail(activePlan),
  };
}

function routingVerificationDetail(activePlan: WorkplaceRoutingPlanSlot[]) {
  const occupied = activePlan.filter((slot) => Boolean(slot.extension)).map((slot) => slot.queue);
  const empty = activePlan.filter((slot) => !slot.extension).map((slot) => slot.queue);
  if (occupied.join(",") === "601") {
    return "VIPTel potvrdil prvého operátora v rade 601. Druhé a tretie poradie môže zostať zatiaľ voľné.";
  }
  if (occupied.join(",") === "601,602") {
    return "VIPTel potvrdil prvého a druhého operátora. Tretie poradie môže zostať zatiaľ voľné.";
  }
  if (occupied.join(",") === "601,602,603") {
    return "VIPTel potvrdil celé poradie 601 → 602 → 603. Časy prepadu a finálnu slučku potvrdí testovací hovor.";
  }
  return `VIPTel potvrdil členstvo radov ${occupied.join(" a ")}; ${empty.length === 1 ? "rad" : "rady"} ${empty.join(" a ")} ${empty.length === 1 ? "je" : "sú"} bez operátora.`;
}

function queueMemberships(snapshot: TelephonyPresenceSnapshot | null) {
  const result = new Map<string, string[]>();

  for (const status of snapshot?.queueStatuses ?? []) {
    if (!RINGING_QUEUES.includes(status.queue as (typeof RINGING_QUEUES)[number])) continue;
    for (const member of status.members) {
      const current = result.get(member.extension) ?? [];
      if (!current.includes(status.queue)) current.push(status.queue);
      current.sort((left, right) => RINGING_QUEUES.indexOf(left as (typeof RINGING_QUEUES)[number]) - RINGING_QUEUES.indexOf(right as (typeof RINGING_QUEUES)[number]));
      result.set(member.extension, current);
    }
  }

  return result;
}

function stationState(input: {
  activeCalls: CallCenterCall[];
  extensionSnapshot?: TelephonyExtensionSnapshot;
  health: TelephonyHealthSignal;
  presence?: TelephonyOperatorPresence;
  profileId?: string;
}): WorkplaceStationState {
  if (input.health.state !== "live") return "unverified";
  if (!input.extensionSnapshot?.active) return "disconnected";
  if (input.activeCalls.some((call) => call.status === "incoming" || call.status === "ringing_agent")) return "ringing";
  if (input.activeCalls.some((call) => ["answered", "outbound"].includes(call.status))) return "on_call";
  if (!input.profileId) {
    return input.extensionSnapshot.registered === false &&
      input.extensionSnapshot.assignmentRequirement === "initial_provisioning"
      ? "free"
      : "unverified";
  }

  switch (input.presence?.state) {
    case "available":
      return "ready";
    case "ringing":
      return "ringing";
    case "on_call":
      return "on_call";
    case "paused":
      return "paused";
    case "error":
    case "stale":
      return "unverified";
    default:
      return "disconnected";
  }
}

function stationStateDetail(
  state: WorkplaceStationState,
  extension: string,
  name: string,
  extensionSnapshot: TelephonyExtensionSnapshot | undefined,
  profileId: string | undefined,
) {
  if (!profileId && (state === "ringing" || state === "on_call")) {
    return `Na internej linke ${extension} je aktívny hovor, ale linka nemá potvrdeného vlastníka. Vyžaduje okamžitú kontrolu správcu.`;
  }
  if (!profileId && state === "unverified") {
    if (extensionSnapshot?.registered) {
      return `Interná linka ${extension} nemá vlastníka, ale VIPTel ju stále hlási ako registrovanú. Nepoužívajte ju bez kontroly správcu.`;
    }
    if (extensionSnapshot?.assignmentRequirement === "rotation_required") {
      return `Interná linka ${extension} vyžaduje pred ďalším použitím bezpečnú zmenu SIP prístupu.`;
    }
    return `Bezpečne voľný stav internej linky ${extension} sa nepodarilo potvrdiť.`;
  }

  switch (state) {
    case "free":
      return `Interná linka ${extension} je nepoužitá, odregistrovaná a pripravená na prvé bezpečné priradenie.`;
    case "ready":
      return `${name} je pripojený a pripravený prijať hovor.`;
    case "ringing":
      return `${name} práve prijíma zvonenie.`;
    case "on_call":
      return `${name} práve telefonuje.`;
    case "paused":
      return `${name} je pripojený, ale má pozastavené prijímanie hovorov.`;
    case "unverified":
      return "Aktuálny stav sa nepodarilo spoľahlivo overiť.";
    case "disconnected":
      return `${name === "Neobsadené" ? `Interná linka ${extension}` : name} nie je pripravený na prijatie hovoru.`;
  }
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("sk-SK"))
    .join("") || "—";
}
