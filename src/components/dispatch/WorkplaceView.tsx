"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Armchair,
  BellRing,
  CheckCircle2,
  CirclePause,
  Clock3,
  Headphones,
  Loader2,
  PhoneCall,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOutgoing,
  RefreshCw,
  ShieldAlert,
  UserMinus,
  UserCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { CallCenterCall } from "@/data/dispatch-types";
import type { Operator } from "@/domain/types";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import type { TelephonyOperatorPresence, TelephonyPresenceSnapshot } from "@/lib/telephony/presence";
import type { BrowserWebphoneRegistrationStatus } from "@/lib/telephony/webphone-client";
import type { WorkplaceLease } from "@/lib/telephony/workplace-lease-client";
import { CallQueuePanel } from "./CallQueuePanel";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import type { WorkplaceTakeoverRequest, WorkplaceTakeoverSnapshot } from "@/lib/telephony/workplace-takeover";
import {
  buildWorkplaceCallRoute,
  buildWorkplaceStations,
  buildWorkplaceWaitingRoom,
  getWorkplaceRoutingStatus,
  type WorkplaceRouteStep,
  type WorkplaceStation,
  type WorkplaceStationState,
} from "./workplace-model";

/**
 * How long a routing activation may hold the seat controls disabled before the
 * UI stops treating it as live. The server keeps its own fences either way.
 */
const ROUTING_ACTIVATION_STALL_MS = 20_000;

export type WorkplaceSelectionInput = {
  extension: string;
  queue: "601" | "602" | "603";
};

export type WorkplaceSelectionActionResult = {
  message?: string;
  state?: "confirmed" | "disconnect_required" | "draft" | "pending" | "warning";
};

export type WorkplaceSeatStatus =
  | "free"
  | "mine"
  | "stale"
  | "active"
  | "transitioning"
  | "unknown"
  | "available"
  | "occupied"
  | "unavailable";

export type WorkplaceSelectionSnapshot = {
  checkedAt: string;
  lease?: WorkplaceLease | null;
  selection: {
    seatId?: string | null;
    extension: string | null;
    queue: WorkplaceSelectionInput["queue"] | null;
  };
  seats: Array<{
    seatId?: string;
    extension: string;
    status: WorkplaceSeatStatus;
    canSelect?: boolean;
    reasonCode?: string;
    reason?: string;
    heartbeatFresh?: boolean;
    hasActiveCall?: boolean;
    nextEligibleAt?: string;
    outboundOnly?: boolean;
    priority?: WorkplaceSelectionInput["queue"] | null;
    queueInUse?: boolean;
    version?: string;
    owner?: {
      profileId: string;
      profileName?: string;
    };
    profileId?: string;
    profileName?: string;
    registered?: boolean;
    management?: {
      takeover: "allowed" | "blocked";
      release: "allowed" | "blocked";
      reason?: string;
      refreshable?: boolean;
    };
  }>;
  priorities: Array<{
    queue: WorkplaceSelectionInput["queue"];
    order: 1 | 2 | 3;
    activeExtension: string | null;
    selectedExtension: string | null;
    status: "mine" | "available" | "occupied" | "pending_mine" | "pending_occupied" | "locked";
    selectionEffect?: "claim" | "swap" | "replace" | "mine";
    profileId?: string;
    profileName?: string;
    willDisplace?: {
      extension?: string;
      profileId?: string;
      profileName?: string;
    };
  }>;
  routingStatus: {
    state: "collecting" | "ready" | "activating" | "active" | "blocked";
    selectedCount: number;
    capacityCount: 3;
    operationId?: string;
    canRecover?: boolean;
    message: string;
  };
};

type WorkplaceViewProps = {
  activeCalls: CallCenterCall[];
  actions: (selectedCall?: CallCenterCall) => ReactNode;
  browserPhoneStatus: BrowserWebphoneRegistrationStatus;
  canControlCall: (call: CallCenterCall) => boolean;
  currentExtension: string;
  currentOperatorId?: string;
  health: TelephonyHealthSignal;
  operatorPresences: TelephonyOperatorPresence[];
  operators: Operator[];
  snapshot: TelephonyPresenceSnapshot | null;
  workplaceSelection: WorkplaceSelectionSnapshot | null;
  workplaceSelectionError: string | null;
  workplaceTakeover: WorkplaceTakeoverSnapshot | null;
  workplaceTakeoverError: string | null;
  waitingCallPickupState: (call: CallCenterCall) => { disabled: boolean; label: string; reason?: string };
  onCancelWorkplaceTakeover: (requestId: string) => Promise<WorkplaceSelectionActionResult | void>;
  onRefreshWorkplace: () => Promise<void>;
  onPickupWaitingCall: (call: CallCenterCall) => void;
  onRecoverWorkplacePriority: (operationId: string) => Promise<WorkplaceSelectionActionResult | void>;
  onRequestWorkplaceTakeover: (extension: string) => Promise<WorkplaceSelectionActionResult | void>;
  onReleaseOccupiedWorkplace: (extension: string) => Promise<WorkplaceSelectionActionResult | void>;
  onReleaseWorkplace: () => Promise<WorkplaceSelectionActionResult | void>;
  onSelectWorkplace: (selection: WorkplaceSelectionInput) => Promise<WorkplaceSelectionActionResult | void>;
  onTakeoverWorkplace: (extension: string) => Promise<WorkplaceSelectionActionResult | void>;
};

type WorkplaceSeat = WorkplaceSelectionSnapshot["seats"][number];

export type WorkplaceSeatUiState = {
  action: "mine" | "select" | "switch" | "take_stale" | "blocked" | "retry";
  ownerName?: string;
  reason: string;
  state: "free" | "mine" | "stale" | "active" | "transitioning" | "unknown";
};

type WorkplacePriority = WorkplaceSelectionSnapshot["priorities"][number];

export type WorkplacePriorityUiState = {
  kind: "available" | "foreign" | "locked" | "mine" | "transitioning" | "unknown" | "unowned";
  reason: string;
  selectable: boolean;
};

export function getWorkplacePriorityUiState(
  priority: WorkplacePriority | undefined,
  actorExtension: string,
  assignedSeat?: WorkplaceSeat,
): WorkplacePriorityUiState {
  if (!priority) {
    return {
      kind: "unknown",
      reason: "Stav tohto poradia sa nepodarilo načítať. Obnov dostupnosť.",
      selectable: false,
    };
  }

  const assignedExtension = priority.selectedExtension ?? priority.activeExtension;
  const mine = priority.status === "mine" ||
    priority.status === "pending_mine" ||
    Boolean(actorExtension && assignedExtension === actorExtension);
  if (mine) {
    return { kind: "mine", reason: "Toto poradie už patrí tvojmu pracovnému miestu.", selectable: true };
  }
  if (priority.status === "pending_occupied") {
    return {
      kind: "transitioning",
      reason: "Na tomto poradí práve prebieha zmena iného pracovného miesta. Počkaj na jej dokončenie.",
      selectable: false,
    };
  }
  if (priority.status === "locked") {
    return {
      kind: "locked",
      reason: "Najprv musí byť obsadené predchádzajúce poradie.",
      selectable: false,
    };
  }

  const ownerName = priority.willDisplace?.profileName ?? priority.profileName ?? assignedSeat?.owner?.profileName ?? assignedSeat?.profileName;
  const ownerId = priority.willDisplace?.profileId ?? priority.profileId ?? assignedSeat?.owner?.profileId ?? assignedSeat?.profileId;
  if (ownerId || ownerName) {
    return {
      kind: "foreign",
      reason: `Toto poradie patrí operátorovi ${ownerName ?? "na inom pracovnom mieste"}. Nedá sa mu odobrať voľbou poradia. Ak je offline, najprv obsad jeho pracovné miesto.`,
      selectable: false,
    };
  }

  if (!assignedExtension && priority.status === "available") {
    return { kind: "available", reason: "Poradie je voľné a môžeš ho použiť.", selectable: true };
  }
  const assignedSeatIsEmpty = assignedSeat?.status === "free" || assignedSeat?.status === "available" ||
    (assignedSeat?.status === "stale" && !assignedSeat.owner?.profileId && !assignedSeat.profileId);
  if (assignedExtension && assignedSeatIsEmpty) {
    return {
      kind: "unowned",
      reason: `Poradie je priradené k voľnému pracovnému miestu ${assignedExtension} bez operátora. Môžeš ho použiť.`,
      selectable: true,
    };
  }
  return {
    kind: "unknown",
    reason: "Nie je bezpečne potvrdené, že je toto poradie voľné. Obnov dostupnosť.",
    selectable: false,
  };
}

export function getWorkplaceSeatUiState(
  seat: WorkplaceSeat | undefined,
  actorExtension: string,
): WorkplaceSeatUiState {
  if (!seat) {
    return { action: "retry", reason: "Dostupnosť pracovného miesta ešte nie je načítaná.", state: "unknown" };
  }
  const ownerName = seat.owner?.profileName ?? seat.profileName;
  const canonicalStatus = seat.status === "available"
    ? "free"
    : seat.status === "occupied"
      ? seat.management?.takeover === "allowed" ? "stale" : "active"
      : seat.status === "unavailable"
        ? "unknown"
        : seat.status;
  const defaultReason: Record<WorkplaceSeatUiState["state"], string> = {
    active: ownerName
      ? `${ownerName} je aktívny. Počas pripojenia, zvonenia alebo hovoru miesto nemožno prevziať.`
      : "Operátor je aktívny. Počas pripojenia, zvonenia alebo hovoru miesto nemožno prevziať.",
    free: "Miesto je voľné a môžeš ho použiť.",
    mine: "Toto pracovné miesto práve používaš.",
    stale: ownerName
      ? `${ownerName} je offline. Miesto môžeš bezpečne obsadiť.`
      : "Pôvodný operátor je offline. Miesto môžeš bezpečne obsadiť.",
    transitioning: "Práve prebieha bezpečné prihlásenie alebo odhlásenie. Chvíľu počkaj.",
    unknown: "Aktuálny stav sa nepodarilo bezpečne overiť. Obnov dostupnosť.",
  };
  const state = canonicalStatus as WorkplaceSeatUiState["state"];
  const reason = seat.reason ?? seat.management?.reason ?? defaultReason[state];
  if (state === "mine") return { action: "mine", ownerName, reason, state };
  if (state === "free") {
    return seat.canSelect === false
      ? { action: "blocked", ownerName, reason, state: "free" }
      : { action: actorExtension ? "switch" : "select", ownerName, reason, state };
  }
  if (state === "stale" && seat.canSelect !== false) {
    return { action: "take_stale", ownerName, reason, state };
  }
  if (state === "transitioning") return { action: "retry", ownerName, reason, state };
  return { action: "blocked", ownerName, reason, state: state === "active" ? "active" : "unknown" };
}

type WorkplaceManagementAction = "release" | "takeover";

type WorkplaceManagementIntent = {
  action: WorkplaceManagementAction;
  extension: string;
  ownerName: string;
  position: number;
  priority?: {
    order: 1 | 2 | 3;
    queue: WorkplaceSelectionInput["queue"];
  };
};

export function getWorkplaceManagementState(
  seat?: WorkplaceSeat,
  live?: { hasActiveCall?: boolean; state: WorkplaceStationState },
) {
  const management = seat?.status === "occupied" ? seat.management : undefined;
  if (!management) {
    return {
      reason: undefined,
      refreshable: false,
      releaseAllowed: false,
      takeoverAllowed: false,
      takeoverBlocked: false,
    };
  }

  const liveReason = liveManagementBlockReason(live);
  if (liveReason) {
    return {
      reason: liveReason,
      refreshable: true,
      releaseAllowed: false,
      takeoverAllowed: false,
      takeoverBlocked: true,
    };
  }

  return {
    reason: management?.reason,
    refreshable: management.refreshable === true,
    releaseAllowed: management?.release === "allowed",
    takeoverAllowed: management?.takeover === "allowed",
    takeoverBlocked: management?.takeover === "blocked",
  };
}

function liveManagementBlockReason(live?: { hasActiveCall?: boolean; state: WorkplaceStationState }) {
  if (!live) return undefined;
  if (live.state === "ringing") return "Na pracovnom mieste práve zvoní hovor.";
  if (live.state === "on_call" || live.hasActiveCall) return "Na pracovnom mieste práve prebieha hovor.";
  if (live.state === "ready") return "Telefón je stále pripojený vo VIPTel.";
  if (live.state === "paused") {
    return "Pracovné miesto je vo VIPTel v stave Pauza. Pred prevzatím musí byť nastavené ako Dostupné.";
  }
  if (live.state === "unverified") return "Živý stav telefónu nie je potvrdený. Obnov stav.";
  return undefined;
}

export function buildTakeoverPhoneHandshakeResult(input: {
  detail?: string;
  extension: string;
  outcome: "confirmed" | "failed" | "maintenance" | "outbound_only" | "refresh_failed" | "timeout";
  serverMessage?: string;
}): WorkplaceSelectionActionResult {
  if (input.outcome === "confirmed") {
    return {
      message: input.serverMessage
        ? `${input.serverMessage} Telefón v prehliadači je pripojený.`
        : `Pracovné miesto ${input.extension} je prevzaté a telefón v prehliadači je pripojený.`,
      state: "confirmed",
    };
  }
  if (input.outcome === "outbound_only") {
    return {
      message: `${input.serverMessage ? `${input.serverMessage} ` : ""}Telefón pracovného miesta ${input.extension} je pripojený pre odchádzajúce a interné hovory. Pre prichádzajúce hovory ešte vyber a potvrď poradie zvonenia.`,
      state: "confirmed",
    };
  }
  if (input.outcome === "maintenance") {
    return {
      message: `Telefón pracovného miesta ${input.extension} je pripojený, ale VIPTel ho ponechal v stave Pauza. Zatiaľ používaj iba odchádzajúce alebo interné hovory. Pre príjem hovorov zvoľ Dostupný a obnov stav.${input.detail ? ` ${input.detail}` : ""}`,
      state: "warning",
    };
  }

  const nextStep = "Pri telefóne použi tlačidlo Skúsiť znova; pracovné miesto už nepreberaj opakovane.";
  const reason = input.outcome === "timeout"
    ? "Pripojenie sa nepotvrdilo do 15 sekúnd."
    : input.outcome === "failed"
      ? "Prehliadač telefón nepripojil."
      : "Po prevzatí sa nepodarilo obnoviť stav telefónu.";
  return {
    message: `Pracovné miesto ${input.extension} je prevzaté, ale telefón sa nepripojil. ${reason} ${nextStep}${input.detail ? ` ${input.detail}` : ""}`,
    state: "warning",
  };
}

const stationStatePresentation: Record<
  WorkplaceStationState,
  { badge: string; card: string; icon: typeof Wifi; label: string; pulse?: boolean }
> = {
  free: {
    badge: "border-sky-200 bg-sky-50 text-sky-800",
    card: "border-sky-200",
    icon: Armchair,
    label: "Voľné",
  },
  ready: {
    badge: "border-emerald-200 bg-emerald-50 text-emerald-800",
    card: "border-emerald-200",
    icon: Wifi,
    label: "Dostupné pre hovory",
  },
  ringing: {
    badge: "border-amber-300 bg-amber-50 text-amber-900",
    card: "border-amber-300 ring-2 ring-amber-200/70",
    icon: BellRing,
    label: "Zvoní",
    pulse: true,
  },
  on_call: {
    badge: "border-violet-200 bg-violet-50 text-violet-800",
    card: "border-violet-300",
    icon: PhoneCall,
    label: "Na hovore",
  },
  paused: {
    badge: "border-orange-200 bg-orange-50 text-orange-800",
    card: "border-orange-200",
    icon: CirclePause,
    label: "Pauza",
  },
  disconnected: {
    badge: "border-zinc-200 bg-zinc-100 text-zinc-700",
    card: "border-zinc-200",
    icon: WifiOff,
    label: "Odpojený",
  },
  unverified: {
    badge: "border-red-200 bg-red-50 text-red-800",
    card: "border-red-200",
    icon: ShieldAlert,
    label: "Stav neoverený",
  },
};

export function WorkplaceView({
  activeCalls,
  actions,
  browserPhoneStatus,
  canControlCall,
  currentExtension,
  currentOperatorId,
  health,
  operatorPresences,
  operators,
  snapshot,
  workplaceSelection,
  workplaceSelectionError,
  workplaceTakeover,
  workplaceTakeoverError,
  waitingCallPickupState,
  onCancelWorkplaceTakeover,
  onRefreshWorkplace,
  onPickupWaitingCall,
  onRecoverWorkplacePriority,
  onRequestWorkplaceTakeover,
  onReleaseOccupiedWorkplace,
  onReleaseWorkplace,
  onSelectWorkplace,
  onTakeoverWorkplace,
}: WorkplaceViewProps) {
  const calls = useMemo(() => [...activeCalls].sort(compareLiveCalls), [activeCalls]);
  const [selectionPending, setSelectionPending] = useState<"release" | "save" | null>(null);
  const [selectionPendingExtension, setSelectionPendingExtension] = useState<string | null>(null);
  const [selectionFeedback, setSelectionFeedback] = useState<{ tone: "error" | "pending" | "success" | "warning"; message: string } | null>(null);
  const [managementIntent, setManagementIntent] = useState<WorkplaceManagementIntent | null>(null);
  const [managementPending, setManagementPending] = useState<WorkplaceManagementIntent | null>(null);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [takeoverRequestPending, setTakeoverRequestPending] = useState<string | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [priorityRecoveryPending, setPriorityRecoveryPending] = useState(false);
  const managementTriggerRef = useRef<HTMLElement | null>(null);
  const selectionFeedbackRef = useRef<HTMLDivElement>(null);
  const previousAvailabilityErrorRef = useRef(workplaceSelectionError);
  const [now, setNow] = useState(() => Date.now());
  const [routingActivationAge, setRoutingActivationAge] = useState<{ key: string; elapsedMs: number } | null>(null);
  const [fallbackNumber, setFallbackNumber] = useState("");
  const [fallbackDelay, setFallbackDelay] = useState("60");
  const [fallbackEnabled, setFallbackEnabled] = useState(false);
  const [fallbackCanManage, setFallbackCanManage] = useState(false);
  const [fallbackLoaded, setFallbackLoaded] = useState(false);
  const [fallbackDirty, setFallbackDirty] = useState(false);
  const [fallbackSaving, setFallbackSaving] = useState(false);
  const [fallbackMessage, setFallbackMessage] = useState<{ error: boolean; text: string } | null>(null);
  const stations = useMemo(() => {
    const built = buildWorkplaceStations({ activeCalls: calls, health, operators, operatorPresences, snapshot });
    const seats = new Map(workplaceSelection?.seats.map((seat) => [seat.extension, seat]) ?? []);
    return built.map((station) => {
      const seat = seats.get(station.extension);
      const seatProfileId = seat?.owner?.profileId ?? seat?.profileId;
      if (!seat || !seatProfileId) return station;
      const name = seat.owner?.profileName || seat.profileName || station.name;
      const activePriority = workplaceSelection?.priorities.find(
        (priority) => priority.activeExtension === station.extension,
      );
      const activeMember = activePriority
        ? snapshot?.queueStatuses
            .find((status) => status.queue === activePriority.queue)
            ?.members.find((member) => member.extension === station.extension)
        : undefined;
      const browserPhoneReady =
        health.state === "live" &&
        seat.status === "mine" &&
        station.extension === currentExtension &&
        browserPhoneStatus === "registered" &&
        Boolean(activeMember && !activeMember.paused) &&
        (station.state === "disconnected" || station.state === "unverified");
      return {
        ...station,
        profileId: seatProfileId,
        name,
        initials: operatorInitials(name),
        ...(browserPhoneReady
          ? {
              state: "ready" as const,
              stateDetail: "Telefón v prehliadači je pripojený. Prichádzajúce hovory závisia od potvrdeného poradia nižšie.",
            }
          : {}),
      };
    });
  }, [browserPhoneStatus, calls, currentExtension, health, operatorPresences, operators, snapshot, workplaceSelection?.priorities, workplaceSelection?.seats]);
  const activeRoutingPlan = useMemo(
    () => workplaceSelection?.priorities.map((priority) => ({
      queue: priority.queue,
      extension: priority.activeExtension,
    })) ?? [],
    [workplaceSelection?.priorities],
  );
  const routing = useMemo(
    () => getWorkplaceRoutingStatus(stations, health, snapshot, activeRoutingPlan),
    [activeRoutingPlan, health, snapshot, stations],
  );
  const waitingRoom = useMemo(() => buildWorkplaceWaitingRoom(calls, stations), [calls, stations]);
  const selectedWorkplaceExtension = workplaceSelection
    ? workplaceSelection.selection.extension ?? ""
    : currentExtension;
  const routingActivating = workplaceSelection?.routingStatus.state === "activating";
  // `routingStatus` carries no timestamp, so remember locally when this exact
  // activation was first seen. Keyed by operation id, a new activation always
  // gets a fresh window.
  const routingActivationKey = routingActivating
    ? workplaceSelection?.routingStatus.operationId ?? "activating"
    : null;
  const routingActivationStalled = Boolean(
    routingActivating &&
    routingActivationAge?.key === routingActivationKey &&
    routingActivationAge.elapsedMs > ROUTING_ACTIVATION_STALL_MS,
  );
  // Keep disabling the seat controls only while the activation still looks
  // live. This lockout is a UI courtesy, not a provider fence -- the server's
  // CAS and interlocks are what actually prevent an unsafe seat change -- so
  // an activation that never resolves must not strand every operator.
  const routingChangePending = routingActivating && !routingActivationStalled;
  const hotdeskMode = Boolean(workplaceSelection?.seats.some((seat) =>
    ["free", "stale", "active", "transitioning", "unknown"].includes(seat.status),
  ));
  const controlledCalls = calls.filter(canControlCall);
  // Never show another employee's call just because it happens to be first in
  // the provider array. A browser can safely own exactly one live SIP dialog.
  const selectedCall = controlledCalls.length === 1 ? controlledCalls[0] : undefined;
  const selectedRoute = selectedCall ? buildWorkplaceCallRoute(selectedCall, stations) : undefined;
  const selectedRouteStep = selectedRoute?.steps.find((step) => step.state === "current" || step.state === "accepted");
  const routingNeedsAttention = !routing.verified ||
    workplaceSelection?.routingStatus.state === "activating" ||
    workplaceSelection?.routingStatus.state === "blocked";

  useEffect(() => {
    if (
      calls.length === 0 && workplaceTakeover?.outgoing?.status !== "pending" &&
      !(workplaceTakeover?.cooldowns?.length) && !workplaceSelection?.lease
    ) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [calls.length, workplaceSelection?.lease, workplaceTakeover?.cooldowns?.length, workplaceTakeover?.outgoing?.status]);

  useEffect(() => {
    if (!routingActivationKey) return;
    // Timed from inside the effect, and published from the interval callback
    // rather than the effect body, so no state is written synchronously during
    // the render pass. A new activation id restarts the clock.
    const startedAt = Date.now();
    const interval = window.setInterval(
      () => setRoutingActivationAge({ key: routingActivationKey, elapsedMs: Date.now() - startedAt }),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, [routingActivationKey]);

  useEffect(() => {
    if (selectionFeedback?.tone === "error" && !managementIntent) {
      selectionFeedbackRef.current?.focus();
    }
  }, [managementIntent, selectionFeedback]);

  useEffect(() => {
    const previousError = previousAvailabilityErrorRef.current;
    previousAvailabilityErrorRef.current = workplaceSelectionError;
    if (!previousError || previousError === workplaceSelectionError) return;
    setSelectionFeedback((current) =>
      current?.tone === "error" && current.message === previousError ? null : current);
    setManagementError((current) => current === previousError ? null : current);
  }, [workplaceSelectionError]);

  useEffect(() => {
    const controller = new AbortController();
    void telephonyFetch("/api/telephony/fallback", {
      label: "záložné presmerovanie",
      signal: controller.signal,
      timeoutMs: TELEPHONY_TIMEOUT_MS.read,
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as {
        canManage?: boolean;
        error?: string;
        settings?: { afterSeconds?: number; destination?: string | null; enabled?: boolean };
      };
      if (!response.ok) throw new Error(body.error || "Záložné presmerovanie sa nepodarilo načítať.");
      setFallbackNumber(body.settings?.destination ?? "");
      setFallbackDelay(String(body.settings?.afterSeconds ?? 60));
      setFallbackEnabled(body.settings?.enabled === true);
      setFallbackCanManage(body.canManage === true);
      setFallbackDirty(false);
      setFallbackLoaded(true);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setFallbackLoaded(true);
      setFallbackMessage({
        error: true,
        text: error instanceof Error ? error.message : "Záložné presmerovanie sa nepodarilo načítať.",
      });
    });
    return () => controller.abort();
  }, []);

  async function saveFallbackSettings() {
    if (!fallbackCanManage || fallbackSaving) return;
    setFallbackSaving(true);
    setFallbackMessage(null);
    try {
      const response = await telephonyFetch("/api/telephony/fallback", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination: fallbackNumber, afterSeconds: Number(fallbackDelay) }),
        label: "uloženie záložného presmerovania",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        settings?: { afterSeconds?: number; destination?: string | null; enabled?: boolean };
      };
      if (!response.ok) throw new Error(body.error || "Záložné presmerovanie sa nepodarilo uložiť.");
      setFallbackNumber(body.settings?.destination ?? "");
      setFallbackDelay(String(body.settings?.afterSeconds ?? 60));
      setFallbackEnabled(body.settings?.enabled === true);
      setFallbackDirty(false);
      setFallbackMessage({
        error: false,
        text: body.settings?.enabled
          ? `Po ${body.settings.afterSeconds ?? 60} sekundách sa čakajúci hovor presmeruje na ${body.settings.destination}.`
          : "Záložné presmerovanie je vypnuté.",
      });
    } catch (error) {
      setFallbackMessage({
        error: true,
        text: error instanceof Error ? error.message : "Záložné presmerovanie sa nepodarilo uložiť.",
      });
    } finally {
      setFallbackSaving(false);
    }
  }

  async function configureStation(station: WorkplaceStation) {
    if (selectionPending) return;
    const seat = workplaceSelection?.seats.find((candidate) => candidate.extension === station.extension);
    const uiState = getWorkplaceSeatUiState(seat, selectedWorkplaceExtension);
    if (uiState.action === "blocked" || uiState.action === "retry") return;
    const firstAvailablePriority = workplaceSelection?.priorities.find((priority) => {
      const assignedExtension = priority.selectedExtension ?? priority.activeExtension;
      const assignedSeat = workplaceSelection.seats.find((candidate) => candidate.extension === assignedExtension);
      return getWorkplacePriorityUiState(priority, selectedWorkplaceExtension, assignedSeat).selectable;
    });
    const currentQueue = workplaceSelection?.selection.extension === station.extension
      ? workplaceSelection.selection.queue
      : null;
    const queue = currentQueue ?? firstAvailablePriority?.queue ?? "601";
    await saveSelection({ extension: station.extension, queue });
  }

  function focusSelectionFeedback() {
    window.requestAnimationFrame(() => selectionFeedbackRef.current?.focus());
  }

  function openManagementConfirmation(
    action: WorkplaceManagementAction,
    station: WorkplaceStation,
    seat: WorkplaceSelectionSnapshot["seats"][number],
    priority?: WorkplaceSelectionSnapshot["priorities"][number],
  ) {
    managementTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setManagementError(null);
    setManagementIntent({
      action,
      extension: station.extension,
      ownerName: seat.profileName || station.name || "Pôvodný operátor",
      position: station.position,
      priority: priority
        ? { order: priority.order, queue: priority.queue }
        : undefined,
    });
  }

  function closeManagementConfirmation() {
    // Closing is always allowed. A pending request keeps running on the server
    // and reports through the selection feedback banner; refusing to close
    // here turned one stalled PATCH into a permanently modal-locked app.
    const trigger = managementTriggerRef.current;
    const extension = managementIntent?.extension;
    setManagementIntent(null);
    setManagementError(null);
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) {
        trigger.focus();
        return;
      }
      const fallback = extension ? document.getElementById(`configure-workplace-${extension}`) : null;
      if (fallback instanceof HTMLElement) fallback.focus();
    });
  }

  async function confirmManagementAction() {
    if (!managementIntent || managementPending) return;
    const intent = managementIntent;
    setManagementPending(intent);
    setManagementError(null);
    setSelectionFeedback({
      tone: "pending",
      message: intent.action === "takeover"
        ? `Preberám pracovné miesto ${intent.extension} a obnovujem telefón…`
        : `Uvoľňujem pracovné miesto ${intent.extension}…`,
    });

    try {
      const result = intent.action === "takeover"
        ? await onTakeoverWorkplace(intent.extension)
        : await onReleaseOccupiedWorkplace(intent.extension);
      const pending = result?.state === "draft" || result?.state === "pending";
      const warning = result?.state === "warning";
      setManagementIntent(null);
      setManagementError(null);
      setSelectionFeedback({
        tone: warning ? "warning" : pending ? "pending" : "success",
        message: result?.message ?? (intent.action === "takeover"
          ? pending
            ? `Pracovné miesto ${intent.extension} je prevzaté. Telefón sa ešte pripája.`
            : `Pracovné miesto ${intent.extension} je prevzaté. Telefón sa pripája v tomto prehliadači.`
          : `Pracovné miesto ${intent.extension} je uvoľnené.`),
      });
      window.requestAnimationFrame(() => selectionFeedbackRef.current?.focus());
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : intent.action === "takeover"
          ? "Pracovné miesto sa nepodarilo prevziať. Obnov stav a skús to znova."
          : "Pracovné miesto sa nepodarilo uvoľniť. Obnov stav a skús to znova.";
      setManagementError(message);
      setSelectionFeedback({ tone: "error", message });
    } finally {
      setManagementPending(null);
    }
  }

  async function refreshAvailability() {
    if (refreshPending) return;
    setRefreshPending(true);
    try {
      await onRefreshWorkplace();
      setSelectionFeedback(null);
      setManagementError(null);
    } catch {
      // Parent refresh keeps the actionable error in `workplaceSelectionError`.
    } finally {
      setRefreshPending(false);
    }
  }

  async function requestOnlineTakeover(extension: string) {
    if (takeoverRequestPending) return;
    setTakeoverRequestPending(extension);
    setSelectionFeedback({
      tone: "pending",
      message: `Posielam bezpečnú žiadosť používateľovi pracovného miesta ${extension}…`,
    });
    try {
      await onRequestWorkplaceTakeover(extension);
      // The station card owns the live countdown and handoff state. Keeping
      // the one-time API response here made the obsolete "30 seconds" text
      // remain visible long after the request had already advanced.
      setSelectionFeedback(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Žiadosť o pracovné miesto sa nepodarilo odoslať.";
      setSelectionFeedback({ tone: "error", message });
      focusSelectionFeedback();
    } finally {
      setTakeoverRequestPending(null);
    }
  }

  async function cancelOnlineTakeover(requestId: string, extension: string) {
    if (takeoverRequestPending) return;
    setTakeoverRequestPending(extension);
    try {
      const result = await onCancelWorkplaceTakeover(requestId);
      setSelectionFeedback({
        tone: "success",
        message: result?.message ?? `Žiadosť o pracovné miesto ${extension} je zrušená.`,
      });
      focusSelectionFeedback();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Žiadosť sa nepodarilo zrušiť.";
      setSelectionFeedback({ tone: "error", message });
      focusSelectionFeedback();
    } finally {
      setTakeoverRequestPending(null);
    }
  }

  async function recoverPriority() {
    const operationId = workplaceSelection?.routingStatus.operationId;
    if (!operationId || priorityRecoveryPending) return;
    setPriorityRecoveryPending(true);
    setSelectionFeedback({ tone: "pending", message: "Obnovujem poradie zvonenia vo VIPTel…" });
    try {
      const result = await onRecoverWorkplacePriority(operationId);
      setSelectionFeedback({
        tone: result?.state === "pending" ? "pending" : "success",
        message: result?.message ?? "Poradie zvonenia sa obnovuje.",
      });
    } catch (error) {
      setSelectionFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Poradie zvonenia sa nepodarilo obnoviť.",
      });
      focusSelectionFeedback();
    } finally {
      setPriorityRecoveryPending(false);
    }
  }

  async function saveSelection(selection: WorkplaceSelectionInput) {
    if (selectionPending) return;
    const prioritySelectionIsSubmitted = selectedWorkplaceExtension === selection.extension || !hotdeskMode;
    if (prioritySelectionIsSubmitted) {
      const priority = workplaceSelection?.priorities.find((candidate) => candidate.queue === selection.queue);
      const assignedExtension = priority?.selectedExtension ?? priority?.activeExtension;
      const assignedSeat = workplaceSelection?.seats.find((candidate) => candidate.extension === assignedExtension);
      const priorityUi = getWorkplacePriorityUiState(priority, selectedWorkplaceExtension, assignedSeat);
      if (!priorityUi.selectable) {
        setSelectionFeedback({ tone: "error", message: priorityUi.reason });
        focusSelectionFeedback();
        return;
      }
    }
    setSelectionPending("save");
    setSelectionPendingExtension(selection.extension);
    setSelectionFeedback({
      tone: "pending",
      message: `Pripájame pracovné miesto ${selection.extension}, telefón a poradie zvonenia. Hneď potom ťa systém automaticky nastaví ako Dostupný.`,
    });
    try {
      const result = await onSelectWorkplace(selection);
      setSelectionFeedback({
        tone: result?.state === "warning" ? "warning" : result?.state === "pending" ? "pending" : "success",
        message: result?.message ?? `Pracovné miesto ${selection.extension} je pripravené.`,
      });
      focusSelectionFeedback();
    } catch (error) {
      setSelectionFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Pracovné miesto sa nepodarilo nastaviť. Skús to znova.",
      });
      focusSelectionFeedback();
    } finally {
      setSelectionPending(null);
      setSelectionPendingExtension(null);
    }
  }

  async function releaseSelection() {
    if (!selectedWorkplaceExtension || selectionPending) return;
    setSelectionPending("release");
    setSelectionFeedback({
      tone: "pending",
      message: `Bezpečne odpájame pracovné miesto ${selectedWorkplaceExtension} a vyraďujeme ho z príjmu hovorov.`,
    });
    try {
      const result = await onReleaseWorkplace();
      const pending = result?.state === "draft" || result?.state === "pending";
      const warning = result?.state === "warning";
      setSelectionFeedback({
        tone: warning ? "warning" : pending ? "pending" : "success",
        message: result?.message ?? (pending ? "Zmena čaká na potvrdenie VIPTel." : "Pracovné miesto je uvoľnené."),
      });
      focusSelectionFeedback();
    } catch (error) {
      setSelectionFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Pracovné miesto sa nepodarilo uvoľniť. Skús to znova.",
      });
      focusSelectionFeedback();
    } finally {
      setSelectionPending(null);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_390px]">
      <p className="sr-only" aria-live="polite">
        {selectedCall
          ? `Vybraný hovor: ${callPartyLabel(selectedCall)}. ${selectedRouteStep ? `Aktuálne pracovné miesto: ${selectedRouteStep.station.name}.` : "Aktuálne pracovné miesto zatiaľ nie je potvrdené."}`
          : "Momentálne neprebieha žiadny hovor."}
      </p>
      <section className="min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm" aria-label="Pracoviská a hovory">
        {(routingNeedsAttention || !workplaceSelection || Boolean(workplaceSelectionError) || (selectionFeedback && selectionFeedback.tone !== "success") || Boolean(workplaceTakeoverError)) && (
        <header className="border-b border-zinc-200 bg-white px-4 py-2 sm:px-5">
          {routingNeedsAttention && workplaceSelection?.routingStatus && selectionFeedback?.tone !== "pending" && (
            <div className={`mt-2 rounded-lg border px-3 py-2 text-xs font-semibold leading-5 ${
              workplaceSelection.routingStatus.state === "active" && routing.verified
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : workplaceSelection.routingStatus.state === "blocked"
                  ? "border-red-200 bg-red-50 text-red-900"
                  : "border-amber-200 bg-amber-50 text-amber-950"
            }`} role={workplaceSelection.routingStatus.state === "blocked" ? "alert" : "status"}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1">
                  {workplaceSelection.routingStatus.state === "active"
                    ? "Príjem hovorov sa nepodarilo potvrdiť. Obnov stav pracovísk."
                    : routingActivationStalled
                      ? "VIPTel zatiaľ nepotvrdil poradie zvonenia. Pracoviská sú znova odomknuté; stav si môžeš obnoviť."
                      : workplaceSelection.routingStatus.message}
                </p>
                {routingActivationStalled && (
                  <button
                    type="button"
                    onClick={() => void refreshAvailability()}
                    disabled={refreshPending}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-amber-300 bg-white px-3 text-xs font-bold text-amber-950 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-amber-500"
                  >
                    <RefreshCw size={14} className={refreshPending ? "motion-safe:animate-spin" : ""} aria-hidden="true" />
                    {refreshPending ? "Obnovujem…" : "Obnoviť stav"}
                  </button>
                )}
                {workplaceSelection.routingStatus.state === "blocked" &&
                  workplaceSelection.routingStatus.canRecover &&
                  workplaceSelection.routingStatus.operationId && (
                  <button
                    type="button"
                    onClick={() => void recoverPriority()}
                    disabled={priorityRecoveryPending}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 text-xs font-bold text-red-900 outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-red-500"
                  >
                    <RefreshCw size={14} className={priorityRecoveryPending ? "motion-safe:animate-spin" : ""} aria-hidden="true" />
                    {priorityRecoveryPending ? "Obnovujem poradie…" : "Obnoviť poradie"}
                  </button>
                )}
              </div>
            </div>
          )}
          {(!workplaceSelection || workplaceSelectionError) && (
            <div
              className={`mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-semibold leading-5 ${
                workplaceSelectionError
                  ? "border-red-200 bg-red-50 text-red-900"
                  : "border-zinc-200 bg-zinc-50 text-zinc-600"
              }`}
              role={workplaceSelectionError ? "alert" : "status"}
            >
              <span className="inline-flex items-center gap-2">
                {!workplaceSelection && !workplaceSelectionError && (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-zinc-200">
                    <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />
                  </span>
                )}
                {workplaceSelectionError ?? "Načítavam pracovné miesta a overujem, kto môže prijímať hovory…"}
              </span>
              {workplaceSelectionError && (
                <button
                  type="button"
                  onClick={() => void refreshAvailability()}
                  disabled={refreshPending}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 text-xs font-bold text-red-900 outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-red-500"
                >
                  {refreshPending && <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />}
                  {refreshPending ? "Obnovujem dostupnosť…" : "Obnoviť dostupnosť"}
                </button>
              )}
            </div>
          )}
          {selectionFeedback && selectionFeedback.tone !== "success" && selectionFeedback.message !== workplaceSelectionError && (
            <div
              ref={selectionFeedbackRef}
              tabIndex={-1}
              aria-live="polite"
              className={`mt-2 flex items-start gap-3 rounded-xl border px-3 py-3 text-sm ${
                selectionFeedback.tone === "pending" || selectionFeedback.tone === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-950"
                    : "border-red-200 bg-red-50 text-red-900"
              } outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2`}
              role={selectionFeedback.tone === "error" ? "alert" : "status"}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/80 ring-1 ring-current/15">
                {selectionFeedback.tone === "pending"
                    ? <Loader2 size={18} className="motion-safe:animate-spin" aria-hidden="true" />
                    : <ShieldAlert size={18} aria-hidden="true" />}
              </span>
              <span className="min-w-0">
                <span className="block font-bold">
                  {selectionFeedback.tone === "pending"
                      ? "Pracujem na tom"
                      : selectionFeedback.tone === "warning"
                        ? "Treba skontrolovať"
                        : "Akcia sa nepodarila"}
                </span>
                <span className="mt-0.5 block font-medium leading-5">{selectionFeedback.message}</span>
              </span>
            </div>
          )}
          {workplaceTakeoverError && workplaceTakeoverError !== selectionFeedback?.message && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900" role="alert">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{workplaceTakeoverError}</span>
            </div>
          )}

        </header>
        )}

        {/* Same component as the always-visible rail, so the row and its
            pickup rules exist in exactly one place. */}
        <CallQueuePanel
          calls={waitingRoom}
          now={now}
          pickupState={waitingCallPickupState}
          onPickup={onPickupWaitingCall}
          variant="embedded"
        />

        <div className="bg-zinc-50 p-3 sm:p-5">
          <div className="mb-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-700" aria-label="Záložné presmerovanie">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-2 font-bold text-zinc-950">
                <PhoneForwarded size={15} className="text-amber-600" aria-hidden="true" />
                Záložné presmerovanie
              </span>
              <label className="flex min-w-[190px] flex-1 items-center gap-2">
                <span className="sr-only">Záložné telefónne číslo</span>
                <input
                  type="tel"
                  inputMode="tel"
                  value={fallbackNumber}
                  onChange={(event) => {
                    setFallbackNumber(event.target.value);
                    setFallbackDirty(true);
                    setFallbackMessage(null);
                  }}
                  placeholder="Záložné telefónne číslo"
                  disabled={!fallbackCanManage || !fallbackLoaded || fallbackSaving}
                  className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-xs font-semibold text-zinc-900 outline-none focus:border-yellow-400 focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:text-zinc-500"
                />
              </label>
              <label className="inline-flex shrink-0 items-center gap-1.5 font-semibold">
                po
                <input
                  type="number"
                  min="10"
                  max="3600"
                  step="5"
                  value={fallbackDelay}
                  onChange={(event) => {
                    setFallbackDelay(event.target.value);
                    setFallbackDirty(true);
                    setFallbackMessage(null);
                  }}
                  disabled={!fallbackCanManage || !fallbackLoaded || fallbackSaving}
                  className="h-8 w-16 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-center text-xs font-bold text-zinc-900 outline-none focus:border-yellow-400 focus:ring-2 focus:ring-yellow-200 disabled:cursor-not-allowed disabled:text-zinc-500"
                />
                sekundách
              </label>
              <span className={`shrink-0 rounded-full px-2 py-1 font-bold ${
                fallbackDirty
                  ? "bg-amber-100 text-amber-900"
                  : fallbackEnabled
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-zinc-100 text-zinc-500"
              }`}>
                {!fallbackLoaded ? "načítavam…" : fallbackDirty ? "neuložené" : fallbackEnabled ? "aktívne" : "vypnuté"}
              </span>
              {fallbackCanManage && (
                <button
                  type="button"
                  onClick={() => void saveFallbackSettings()}
                  disabled={!fallbackLoaded || fallbackSaving || !fallbackDirty}
                  className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-zinc-950 px-3 font-bold text-white outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500"
                >
                  {fallbackSaving && <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />}
                  {fallbackSaving ? "Ukladám…" : "Uložiť"}
                </button>
              )}
            </div>
            {(fallbackMessage || (fallbackLoaded && !fallbackCanManage)) && (
              <p className={`mt-1.5 text-[11px] font-semibold ${fallbackMessage?.error ? "text-red-700" : "text-zinc-500"}`} role={fallbackMessage?.error ? "alert" : "status"}>
                {fallbackMessage?.text ?? "Globálne nastavenie môže zmeniť manažér alebo administrátor."}
              </p>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
            {stations.map((station) => {
              const routeStep = selectedRoute?.steps.find((step) =>
                step.station.id === station.id && (step.state === "current" || step.state === "accepted"),
              );
              const seat = workplaceSelection?.seats.find((candidate) => candidate.extension === station.extension);
              const activePriority = workplaceSelection?.priorities.find((priority) =>
                priority.activeExtension === station.extension || priority.selectedExtension === station.extension,
              );
              return (
                <StationCard
                  browserPhoneStatus={browserPhoneStatus}
                  key={station.extension}
                  currentOperatorId={currentOperatorId}
                  currentWorkplaceExtension={selectedWorkplaceExtension}
                  currentWorkplaceLease={workplaceSelection?.lease}
                  hotdeskMode={hotdeskMode}
                  configurationPending={Boolean(selectionPending) || Boolean(managementPending) || Boolean(takeoverRequestPending) || refreshPending || routingChangePending}
                  routingChangePending={routingChangePending}
                  selectionPending={selectionPending === "save" && selectionPendingExtension === station.extension}
                  selectionDataReady={Boolean(workplaceSelection)}
                  now={now}
                  onConfigure={(nextStation) => void configureStation(nextStation)}
                  onCancelTakeover={(requestId) => void cancelOnlineTakeover(requestId, station.extension)}
                  onManage={(action) => {
                    if (seat) openManagementConfirmation(action, station, seat, activePriority);
                  }}
                  onRefresh={() => void refreshAvailability()}
                  onRelease={() => void releaseSelection()}
                  onRequestTakeover={() => void requestOnlineTakeover(station.extension)}
                  routeStep={routeStep}
                  selectedPriority={activePriority}
                  station={station}
                  seat={seat}
                  takeoverRequest={workplaceTakeover?.outgoing}
                  takeoverCooldownUntil={workplaceTakeover?.cooldowns?.find((cooldown) => cooldown.extension === station.extension)?.until}
                  takeoverRequestPending={takeoverRequestPending === station.extension}
                />
              );
            })}
          </div>
        </div>
      </section>

      <aside className="grid min-w-0 content-start gap-4" aria-label="Detail a ovládanie hovoru">
        <SelectedCallDetail
          ambiguousCallCount={controlledCalls.length > 1 ? controlledCalls.length : 0}
          call={selectedCall}
          now={now}
          route={selectedRoute?.steps ?? []}
          routeMode={selectedRoute?.mode}
          routingVerified={routing.verified}
        />
        {actions(selectedCall)}
      </aside>

      {managementIntent && (
        <WorkplaceManagementDialog
          error={managementError}
          intent={managementIntent}
          pending={Boolean(managementPending)}
          onCancel={closeManagementConfirmation}
          onConfirm={() => void confirmManagementAction()}
        />
      )}
    </div>
  );
}

function StationCard({
  browserPhoneStatus,
  configurationPending,
  currentOperatorId,
  currentWorkplaceExtension,
  currentWorkplaceLease,
  hotdeskMode,
  now,
  onCancelTakeover,
  onConfigure,
  onManage,
  onRefresh,
  onRelease,
  onRequestTakeover,
  routeStep,
  routingChangePending,
  seat,
  selectionPending,
  selectionDataReady,
  selectedPriority,
  station,
  takeoverRequest,
  takeoverCooldownUntil,
  takeoverRequestPending,
}: {
  browserPhoneStatus: BrowserWebphoneRegistrationStatus;
  configurationPending: boolean;
  currentOperatorId?: string;
  currentWorkplaceExtension: string;
  currentWorkplaceLease?: WorkplaceLease | null;
  hotdeskMode: boolean;
  now: number;
  onCancelTakeover: (requestId: string) => void;
  onConfigure: (station: WorkplaceStation) => void;
  onManage: (action: WorkplaceManagementAction) => void;
  onRefresh: () => void;
  onRelease: () => void;
  onRequestTakeover: () => void;
  routeStep?: WorkplaceRouteStep;
  routingChangePending: boolean;
  seat?: WorkplaceSelectionSnapshot["seats"][number];
  selectionPending: boolean;
  selectionDataReady: boolean;
  selectedPriority?: WorkplaceSelectionSnapshot["priorities"][number];
  station: WorkplaceStation;
  takeoverRequest?: WorkplaceTakeoverRequest;
  takeoverCooldownUntil?: string;
  takeoverRequestPending: boolean;
}) {
  const seatStatus = seat?.status;
  const seatUi = getWorkplaceSeatUiState(seat, currentWorkplaceExtension);
  const stationTakeoverRequest = takeoverRequest?.extension === station.extension ? takeoverRequest : undefined;
  const requestPending = stationTakeoverRequest?.status === "pending";
  const requestAccepted = stationTakeoverRequest?.status === "accepted";
  const cooldownSecondsLeft = takeoverCooldownUntil
    ? Math.max(0, Math.ceil((Date.parse(takeoverCooldownUntil) - now) / 1_000))
    : 0;
  const cooldownActive = cooldownSecondsLeft > 0;
  const activeRequestElsewhere = Boolean(
    takeoverRequest && takeoverRequest.extension !== station.extension &&
    (takeoverRequest.status === "pending" || takeoverRequest.status === "accepted"),
  );
  const onlineRequestBlockReason = getOnlineTakeoverRequestBlockReason(station);
  const onlineRequestAllowed = hotdeskMode && seatUi.state === "active" && !onlineRequestBlockReason && !activeRequestElsewhere && !cooldownActive;
  const visualState: WorkplaceStationState = seatUi.state === "free"
    ? "free"
    : seatUi.state === "transitioning" || seatUi.state === "unknown"
      ? "unverified"
      : station.state;
  const basePresentation = seatUi.state === "stale"
    ? {
        badge: "border-sky-200 bg-sky-50 text-sky-800",
        card: "border-sky-200",
        icon: WifiOff,
        label: "Offline · možno obsadiť",
        pulse: false,
      }
    : seatUi.state === "active"
      ? stationStatePresentation[visualState]
      : seatUi.state === "transitioning"
        ? {
            badge: "border-amber-200 bg-amber-50 text-amber-900",
            card: "border-amber-200",
            icon: Loader2,
            label: "Prebieha zmena",
            pulse: true,
          }
        : seatUi.state === "unknown"
          ? { ...stationStatePresentation.unverified, label: "Stav neznámy" }
          : stationStatePresentation[visualState];
  const presentation = station.activeCalls.length > 1
    ? {
        badge: "border-sky-200 bg-sky-50 text-sky-900",
        card: "border-sky-200 ring-1 ring-sky-100",
        icon: PhoneCall,
        label: `${station.activeCalls.length} hovory na tomto mieste`,
        pulse: false,
      }
    : selectionPending
    ? {
        badge: "border-amber-300 bg-amber-50 text-amber-900",
        card: "border-amber-300 ring-2 ring-amber-200/70",
        icon: Loader2,
        label: "Pripájam · potom Dostupný",
        pulse: true,
      }
    : requestPending
      ? {
        badge: "border-amber-300 bg-amber-50 text-amber-900",
        card: "border-amber-300",
        icon: Clock3,
        label: "Čaká na odpoveď",
        pulse: true,
      }
    : requestAccepted
      ? {
          badge: "border-emerald-300 bg-emerald-50 text-emerald-900",
          card: "border-emerald-300",
          icon: CheckCircle2,
          label: "Odovzdanie schválené",
          pulse: false,
        }
      : basePresentation;
  const StateIcon = presentation.icon;
  const isMine = seatUi.state === "mine" || (seatStatus === undefined && Boolean(currentOperatorId && station.profileId === currentOperatorId));
  const occupiedByAnother = seatUi.state === "active" || seatUi.state === "stale";
  const unavailable = seatUi.state === "unknown" || seatUi.state === "transitioning";
  const managementState = getWorkplaceManagementState(
    occupiedByAnother ? seat : undefined,
    { hasActiveCall: station.activeCalls.length > 0, state: station.state },
  );
  const refreshable = seatUi.state === "active" || seatUi.state === "transitioning" || seatUi.state === "unknown" || managementState.refreshable;
  const takeoverAllowed = seatUi.action === "take_stale";
  const takeoverBlocked = (seatUi.action === "blocked" || seatUi.action === "retry") &&
    !onlineRequestAllowed && !requestPending && !requestAccepted && !cooldownActive;
  const legacyReleaseAllowed = !hotdeskMode && managementState.releaseAllowed;
  const releaseAllowed = isMine || legacyReleaseAllowed;
  const ownLeaseIsCurrent = Boolean(
    !hotdeskMode || (
      currentWorkplaceLease?.extension === station.extension && Date.parse(currentWorkplaceLease.expiresAt) > now
    ),
  );
  const ownWorkplaceNeedsSetup = Boolean(
    isMine && (!ownLeaseIsCurrent || !selectedPriority || selectedPriority.activeExtension !== station.extension),
  );
  const highlighted = routeStep?.state === "current" || routeStep?.state === "accepted";
  const requestSecondsLeft = requestPending && stationTakeoverRequest
    ? Math.max(0, Math.ceil((Date.parse(stationTakeoverRequest.expiresAt) - now) / 1_000))
    : 0;
  const requestMessage = requestPending
    ? requestSecondsLeft > 0
      ? `${station.name} môže žiadosť ešte ${requestSecondsLeft} s odmietnuť. Potom sa začne bezpečné odovzdanie.`
      : "Čas na odmietnutie uplynul. Spúšťame bezpečné odovzdanie."
    : requestAccepted
      ? stationTakeoverRequest?.acceptedBy === "timeout"
        ? `${station.name} žiadosť neodmietol. Bezpečné prevzatie už prebieha automaticky.`
        : `${station.name} odovzdanie schválil. Bezpečné prevzatie už prebieha automaticky.`
      : cooldownActive
        ? `Žiadosť bola odmietnutá. Ďalšiu môžeš poslať o ${formatShortCountdown(cooldownSecondsLeft)}.`
      : onlineRequestAllowed
        ? `${station.name} je online. Má 30 sekúnd na odmietnutie; potom sa miesto začne bezpečne odovzdávať.`
        : activeRequestElsewhere
          ? `Najprv dokonči žiadosť o pracovné miesto ${takeoverRequest?.extension}.`
          : onlineRequestBlockReason;

  return (
    <article
      aria-labelledby={`station-${station.extension}-title`}
      data-workplace-station={station.extension}
      className={`relative min-w-0 rounded-2xl border p-3.5 shadow-[0_14px_30px_rgba(24,24,27,0.10)] backdrop-blur-sm lg:min-h-[210px] ${
        isMine ? "bg-amber-50/70" : "bg-white/95"
      } ${presentation.card} ${
        highlighted ? "outline outline-2 outline-offset-2 outline-yellow-400" : ""
      }`}
    >
      <div className="absolute -bottom-2 left-6 right-6 h-4 rounded-[50%] bg-zinc-900/10 blur-md" aria-hidden="true" />
      <div className="relative flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 id={`station-${station.extension}-title`} className="text-sm font-bold text-zinc-950">Pracovné miesto {station.position}</h3>
            {isMine && <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-bold text-white">Moje miesto</span>}
          </div>
          <p className="mt-0.5 text-xs font-semibold text-zinc-600">Interná linka {station.extension}</p>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold ${presentation.badge}`}>
          <StateIcon size={13} className={selectionPending ? "motion-safe:animate-spin" : presentation.pulse ? "motion-safe:animate-pulse" : ""} aria-hidden="true" />
          {presentation.label}
        </span>
      </div>

      <div className="relative mt-4 flex min-w-0 items-center gap-3 rounded-xl border border-zinc-100 bg-zinc-50/90 p-2.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-black text-white shadow-sm">
          {station.initials}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-zinc-950">{station.name}</p>
          <p className="mt-0.5 text-xs leading-4 text-zinc-500">
            {requestMessage ?? (hotdeskMode
              ? takeoverBlocked ? station.stateDetail : seatUi.reason
              : seatStatus === "available"
                ? "Miesto je voľné a môžeš si ho vybrať."
                : station.stateDetail)}
          </p>
        </div>
      </div>

      {isMine && browserPhoneStatus === "registered" && !["ready", "ringing", "on_call"].includes(station.state) && (
        <div className={`relative mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11px] font-semibold leading-4 ${station.state === "paused" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-sky-200 bg-sky-50 text-sky-900"}`}>
          <Headphones size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{station.state === "paused"
            ? "Telefón je pripojený iba pre odchádzajúce a interné hovory. Pre príjem hovorov zvoľ Dostupný a obnov stav."
            : "Telefón v prehliadači je pripojený. Stav prijímania z poradia sa overuje samostatne."}</span>
        </div>
      )}

      {takeoverBlocked && seatUi.reason && (
        <div id={`workplace-management-reason-${station.extension}`} className="relative mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] font-semibold leading-4 text-amber-950">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{seatUi.reason}</span>
        </div>
      )}

      {(requestPending || requestAccepted) && stationTakeoverRequest && (
        <div className={`relative mt-2 rounded-lg border px-2.5 py-2 text-[11px] font-semibold leading-4 ${
          requestAccepted
            ? "border-emerald-200 bg-emerald-50 text-emerald-950"
            : "border-amber-200 bg-amber-50 text-amber-950"
        }`}>
          <div className="flex items-start justify-between gap-2">
            <span>{requestAccepted
              ? stationTakeoverRequest.acceptedBy === "timeout"
                ? "30 sekúnd uplynulo. Miesto preberieme automaticky hneď, ako VIPTel potvrdí bezpečný stav."
                : "Odovzdanie je schválené. Miesto preberieme automaticky hneď, ako VIPTel potvrdí bezpečný stav."
              : "Aktuálny používateľ môže žiadosť odmietnuť. Ak nič neurobí, prevzatie sa spustí automaticky."}</span>
            {requestPending && (
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 font-black tabular-nums ring-1 ring-amber-300">
                {requestSecondsLeft} s
              </span>
            )}
          </div>
          {requestPending && (
            <button
              type="button"
              onClick={() => onCancelTakeover(stationTakeoverRequest.requestId)}
              // Withdrawing your own request is always a legitimate intent, so
              // the client never blocks it; the server decides whether the
              // handover has gone too far. Disabling this past the decision
              // window left the requester with no way out for up to 5 minutes.
              disabled={configurationPending || takeoverRequestPending}
              className="mt-1.5 min-h-9 rounded-md px-2 font-bold text-amber-950 underline decoration-amber-400 underline-offset-2 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-wait disabled:text-amber-500"
            >
              {takeoverRequestPending ? "Ruším žiadosť…" : "Zrušiť moju žiadosť"}
            </button>
          )}
        </div>
      )}

      <div className="relative mt-3 flex min-w-0 items-center justify-between gap-2">
        {selectedPriority && selectedPriority.activeExtension !== station.extension ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-bold text-amber-800">
            <Loader2 size={14} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" />
            <span className="truncate">Vybrané {selectedPriority.order}. poradie · čaká na aktiváciu</span>
          </span>
        ) : station.queuePriority ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-bold text-zinc-700">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-yellow-100 text-[11px] text-yellow-900">{station.queuePriority}</span>
            <span className="truncate">{station.queuePriority}. v poradí</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-500">
            <CirclePause size={14} aria-hidden="true" /> Mimo poradia
          </span>
        )}
        {routeStep && <RouteStepBadge step={routeStep} />}
      </div>

      <div className={`relative mt-3 grid gap-2 ${releaseAllowed && (!isMine || ownWorkplaceNeedsSetup) ? "sm:grid-cols-2" : ""}`}>
        {(!isMine || ownWorkplaceNeedsSetup) && <button
          type="button"
          id={`configure-workplace-${station.extension}`}
          aria-describedby={takeoverBlocked && seatUi.reason ? `workplace-management-reason-${station.extension}` : undefined}
          aria-label={isMine
            ? ownWorkplaceNeedsSetup
              ? `Obnoviť pracovné miesto ${station.position}, interná linka ${station.extension}`
              : `Používaš pracovné miesto ${station.position}, interná linka ${station.extension}`
            : takeoverAllowed
              ? hotdeskMode
                ? `Obsadiť pracovné miesto ${station.position}, interná linka ${station.extension}, po offline operátorovi ${seatUi.ownerName ?? station.name}`
                : `Prevziať pracovné miesto ${station.position}, interná linka ${station.extension}, od operátora ${seat?.profileName ?? station.name}`
              : onlineRequestAllowed
                ? `Požiadať operátora ${station.name} o pracovné miesto ${station.position}, interná linka ${station.extension}`
              : cooldownActive
                ? `Žiadosť o pracovné miesto ${station.position}, interná linka ${station.extension}, bola odmietnutá; ďalšia žiadosť bude dostupná o ${formatShortCountdown(cooldownSecondsLeft)}`
              : occupiedByAnother
                ? `Pracovné miesto ${station.position}, interná linka ${station.extension}, je obsadené`
                : unavailable
                  ? `Pracovné miesto ${station.position}, interná linka ${station.extension}, nie je dostupné`
                  : `Vybrať pracovné miesto ${station.position}, interná linka ${station.extension}`}
          disabled={
            (isMine && !ownWorkplaceNeedsSetup) || configurationPending || requestPending || requestAccepted ||
            (occupiedByAnother && !takeoverAllowed && !onlineRequestAllowed) ||
            unavailable || !selectionDataReady
          }
          onClick={() => {
            if (!hotdeskMode && seat?.status === "occupied" && takeoverAllowed) {
              onManage("takeover");
              return;
            }
            if (onlineRequestAllowed) {
              onRequestTakeover();
              return;
            }
            onConfigure(station);
          }}
          className={`inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-3 text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed ${
            isMine
              ? "border-yellow-300 bg-yellow-50 text-yellow-950"
              : takeoverAllowed
                ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800"
                : onlineRequestAllowed
                  ? "border-sky-700 bg-sky-700 text-white hover:bg-sky-800"
                : occupiedByAnother || unavailable
                  ? "border-zinc-200 bg-zinc-100 text-zinc-500"
                  : "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800"
          }`}
        >
          {selectionPending
            ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />
            : isMine || takeoverAllowed
              ? <UserCheck size={16} aria-hidden="true" />
              : requestPending
                ? <Clock3 size={16} aria-hidden="true" />
                : <Armchair size={16} aria-hidden="true" />}
          {selectionPending
            ? "Pripájam a nastavujem Dostupný…"
            : routingChangePending
            ? "VIPTel potvrdzuje poradie…"
            : !selectionDataReady
              ? "Načítavam dostupnosť…"
              : isMine
                ? ownWorkplaceNeedsSetup ? "Obnoviť pracovisko" : "Používaš toto miesto"
                : requestPending
                  ? "Čakám na odpoveď"
                : requestAccepted
                  ? "Bezpečne odovzdávame miesto"
                : cooldownActive
                  ? `Počkaj ${formatShortCountdown(cooldownSecondsLeft)}`
                : takeoverAllowed
                  ? hotdeskMode ? "Obsadiť toto miesto" : "Prevziať pracovné miesto"
                  : onlineRequestAllowed
                    ? "Požiadať o toto miesto"
                  : takeoverBlocked
                    ? "Prevzatie nie je dostupné"
                    : occupiedByAnother
                      ? "Miesto je obsadené"
                      : unavailable
                        ? "Miesto nie je dostupné"
                        : "Vybrať toto miesto"}
        </button>}
        {releaseAllowed && (
          <button
            type="button"
            onClick={isMine ? onRelease : () => onManage("release")}
            disabled={configurationPending}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-3 text-sm font-bold text-red-800 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-red-400"
          >
            <UserMinus size={16} aria-hidden="true" />
            Uvoľniť pracovné miesto
          </button>
        )}
      </div>
      {takeoverBlocked && seatUi.reason && refreshable && (
        <div className="relative mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600">
          <span>Stav sa mohol zmeniť od poslednej kontroly.</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={configurationPending}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 font-bold text-zinc-800 outline-none hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-wait disabled:text-zinc-400"
          >
            <RefreshCw size={14} className={configurationPending ? "motion-safe:animate-spin" : ""} aria-hidden="true" />
            Obnoviť stav
          </button>
        </div>
      )}
    </article>
  );
}

function WorkplaceManagementDialog({
  error,
  intent,
  onCancel,
  onConfirm,
  pending,
}: {
  error: string | null;
  intent: WorkplaceManagementIntent;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const takeover = intent.action === "takeover";

  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      return;
    }
    cancelRef.current?.focus();
  }, [error]);

  function keepDialogFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === errorRef.current || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[2147483600] grid place-items-center bg-zinc-950/60 p-3 backdrop-blur-[2px] sm:p-4"
      onMouseDown={(event) => {
        // Dismissing hides the dialog; it never cancels a request already sent.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="workplace-management-title"
        aria-describedby="workplace-management-description"
        aria-busy={pending}
        tabIndex={-1}
        onKeyDown={keepDialogFocus}
        onMouseDown={(event) => event.stopPropagation()}
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none sm:max-h-[calc(100dvh-2rem)]"
      >
        <div className={`border-b px-5 py-4 ${takeover ? "border-amber-200 bg-amber-50" : "border-red-200 bg-red-50"}`}>
          <div className="flex items-start gap-3">
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${takeover ? "bg-amber-100 text-amber-900" : "bg-red-100 text-red-800"}`}>
              <UserMinus size={20} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="workplace-management-title" className="text-pretty text-base font-black text-zinc-950">
                {takeover ? "Prevziať pracovné miesto?" : "Uvoľniť pracovné miesto?"}
              </h2>
              <p id="workplace-management-description" className="mt-1 text-sm leading-5 text-zinc-700">
                {takeover
                  ? `${intent.ownerName} stratí priradenie a ovládanie telefónu v aplikácii. Jeho účet zostane prihlásený a ostatné údaje sa nezmenia.`
                  : `${intent.ownerName} stratí priradenie k tomuto telefónu. Miesto zostane voľné pre ďalšieho operátora.`}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          <dl className="grid gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs font-semibold text-zinc-500">Terajší operátor</dt>
              <dd className="mt-0.5 break-words font-bold text-zinc-950">{intent.ownerName}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-zinc-500">Pracovné miesto</dt>
              <dd className="mt-0.5 font-bold text-zinc-950">Miesto {intent.position} · interná linka {intent.extension}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold text-zinc-500">Poradie zvonenia</dt>
              <dd className="mt-0.5 font-bold text-zinc-950">
                {intent.priority
                  ? `${intent.priority.order}. v poradí${takeover ? " zostane nezmenené" : ""}`
                  : "Mimo poradia zvonenia"}
              </dd>
            </div>
          </dl>

          <div className={`mt-3 rounded-xl border px-3 py-2.5 text-sm font-semibold leading-5 ${takeover ? "border-blue-200 bg-blue-50 text-blue-950" : "border-red-200 bg-red-50 text-red-900"}`}>
            {takeover
              ? "Po prevzatí aplikácia obnoví stav VIPTel a automaticky pripojí telefón v tomto prehliadači."
              : "Uvoľnenie je možné iba pri mieste mimo poradia a bez aktívneho hovoru."}
          </div>

          {error && (
            <div
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-semibold leading-5 text-red-900 outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              {error}
            </div>
          )}

          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="min-h-11 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-bold text-zinc-700 outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-zinc-400"
            >
              Ponechať bez zmeny
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-black text-white outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait ${takeover ? "bg-zinc-950 hover:bg-zinc-800 disabled:bg-zinc-500" : "bg-red-700 hover:bg-red-800 disabled:bg-red-400"}`}
            >
              {pending && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
              {pending
                ? takeover ? "Preberám miesto…" : "Uvoľňujem miesto…"
                : takeover ? "Áno, prevziať miesto" : "Áno, uvoľniť miesto"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getOnlineTakeoverRequestBlockReason(station: WorkplaceStation) {
  if (station.state === "ringing") return "Na pracovnom mieste práve zvoní hovor. Žiadosť môžeš poslať po jeho skončení.";
  if (station.state === "on_call" || station.activeCalls.length > 0) {
    return "Na pracovnom mieste práve prebieha hovor. Počas hovoru sa odovzdanie nezačína.";
  }
  if (station.state === "unverified") {
    return "Živý stav telefónu nie je potvrdený. Pred žiadosťou obnov dostupnosť.";
  }
  return undefined;
}

function RouteStepBadge({ step }: { step: WorkplaceRouteStep }) {
  const labels: Record<WorkplaceRouteStep["state"], string> = {
    accepted: "Hovor prijal",
    current: "Práve tu",
    planned: "Podľa plánu",
    previous: "Skoršia priorita",
  };
  const active = step.state === "current" || step.state === "accepted";
  return (
    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${active ? "bg-yellow-100 text-yellow-900" : "bg-zinc-100 text-zinc-600"}`}>
      {labels[step.state]}
    </span>
  );
}

function SelectedCallDetail({
  ambiguousCallCount,
  call,
  now,
  route,
  routeMode,
  routingVerified,
}: {
  ambiguousCallCount: number;
  call?: CallCenterCall;
  now: number;
  route: WorkplaceRouteStep[];
  routeMode?: "outbound" | "queue_plan" | "transfer";
  routingVerified: boolean;
}) {
  if (!call) {
    if (ambiguousCallCount > 1) {
      return (
        <section className="rounded-xl border border-red-300 bg-white p-4 shadow-sm" role="alert">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-100 text-red-800">
              <ShieldAlert size={17} aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-zinc-950">Treba skontrolovať pridelenie hovorov</h3>
              <p className="mt-1 text-sm leading-5 text-red-800">
                VIPTel hlási {ambiguousCallCount} rôzne hovory na tomto pracovnom mieste naraz. Ovládanie zostáva zablokované, aby sa neukončil alebo neprepojil nesprávny hovor.
              </p>
            </div>
          </div>
        </section>
      );
    }
    return (
      <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600"><PhoneCall size={17} aria-hidden="true" /></span>
          <div>
            <h3 className="text-sm font-bold text-zinc-950">Detail hovoru</h3>
            <p className="mt-1 text-sm leading-5 text-zinc-600">Keď začne hovor, tu sa zobrazí klient, volaná linka, čakanie a aktuálny operátor.</p>
          </div>
        </div>
      </section>
    );
  }

  const current = route.find((step) => step.state === "current" || step.state === "accepted");
  const currentIndex = current ? route.indexOf(current) : -1;
  const inbound = call.direction === "inbound";
  const next = inbound && routeMode === "queue_plan" && routingVerified
    ? (currentIndex >= 0 ? route[currentIndex + 1] : route[0])
    : undefined;
  const lineLabel = meaningfulLineLabel(call);

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm" aria-labelledby="selected-call-title">
      <div className="border-b border-zinc-200 bg-zinc-950 p-4 text-white">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-zinc-300">
            {inbound ? <PhoneIncoming size={14} aria-hidden="true" /> : <PhoneOutgoing size={14} aria-hidden="true" />}
            {inbound ? "Prichádzajúci hovor" : call.direction === "internal" ? "Interný hovor" : "Odchádzajúci hovor"}
          </span>
          <span className="rounded-md bg-white/10 px-2 py-1 font-mono text-xs font-bold tabular-nums">{formatCallClock(call, now)}</span>
        </div>
        <h3 id="selected-call-title" className="mt-3 break-words text-lg font-black">
          {inbound ? call.callerName ?? "Klient" : call.destinationNumber ?? call.calledNumber}
        </h3>
        <p className="mt-1 break-all text-sm font-medium text-zinc-300">{inbound ? call.callerNumber : call.destinationNumber ?? call.calledNumber}</p>
      </div>
      <dl className="grid gap-0 divide-y divide-zinc-100 p-4 pt-1">
        <DetailRow label={inbound ? "Volá na" : "Volá z"} value={inbound ? lineLabel : `Interná linka ${call.callerExtension ?? "—"}`} />
        {inbound && <DetailRow label="Verejné číslo linky" value={call.receivedNumber ?? call.calledNumber ?? "Nezistené"} />}
        <DetailRow label={inbound && !call.answeredAt ? "Čas čakania" : "Trvanie hovoru"} value={formatCallClock(call, now)} />
        <DetailRow
          label={inbound ? call.status === "answered" ? "Hovor prijal" : "Práve zvoní" : "Aktuálne miesto"}
          value={current?.station.name ?? call.operatorName ?? "VIPTel zatiaľ neposlal cieľ"}
        />
        {inbound && routeMode === "queue_plan" && call.status !== "answered" && (
          <DetailRow
            label="Ďalšie miesto v pláne"
            value={routingVerified
              ? next
                ? `${next.station.name} · ${stationStatePresentation[next.station.state].label}`
                : "Posledné miesto plánu"
              : "Nie je overené"}
          />
        )}
      </dl>
      <div className="border-t border-zinc-100 bg-zinc-50 px-4 py-3 text-xs leading-5 text-zinc-600">
        Trasa ukazuje potvrdený aktuálny stav a nastavený plán. Neoznačuje operátora ako „nezdvihol“, kým takú udalosť nepotvrdí VIPTel.
      </div>
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-2.5 text-sm">
      <dt className="font-medium text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words text-right font-bold text-zinc-900">{value}</dd>
    </div>
  );
}

function meaningfulLineLabel(call: CallCenterCall) {
  if (!call.lineLabel || call.lineLabel.trim().toLocaleLowerCase("sk-SK") === "viptel live") {
    return call.receivedNumber ? "Hlavná telefónna linka" : "Linka nerozpoznaná";
  }
  return call.lineLabel;
}

function callPartyLabel(call: CallCenterCall) {
  if (call.direction === "outbound") return call.destinationNumber ?? call.calledNumber;
  return call.callerName ?? call.callerNumber;
}

function compareLiveCalls(left: CallCenterCall, right: CallCenterCall) {
  const priority: Record<CallCenterCall["status"], number> = {
    ringing_agent: 0,
    incoming: 1,
    answered: 2,
    outbound: 3,
    ended: 4,
    missed: 4,
    abandoned_queue: 4,
    failed: 4,
  };
  return priority[left.status] - priority[right.status] || new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime();
}

function formatShortCountdown(seconds: number) {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function formatCallClock(call: CallCenterCall, now: number) {
  const start = call.answeredAt ?? call.startedAt;
  const elapsed = Number.isFinite(new Date(start).getTime())
    ? Math.max(0, Math.floor((now - new Date(start).getTime()) / 1_000))
    : 0;
  const seconds = call.endedAt
    ? call.durationSeconds ?? elapsed
    : call.answeredAt
      ? Math.max(call.durationSeconds ?? 0, elapsed)
      : Math.max(call.waitSeconds, elapsed);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function operatorInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("sk-SK"))
    .join("") || "—";
}
