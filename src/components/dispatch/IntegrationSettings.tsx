"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Building2,
  Edit3,
  FolderDown,
  ListOrdered,
  Loader2,
  MapPinned,
  PhoneCall,
  PhoneForwarded,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { PlaceSelectionInput } from "@/data/case-inputs";
import type { DispatchData } from "@/data/dispatch-types";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";

/** Cadence for watching an in-flight routing operation, and when to give up. */
const ROUTING_WATCH_VISIBLE_MS = 3_000;
const ROUTING_WATCH_HIDDEN_MS = 15_000;
const ROUTING_WATCH_MAX_MS = 3 * 60_000;
import { partnerDirectoryKindLabels } from "@/domain/case-card";
import type { AccessUser, Branch, PartnerDirectoryEntry, PartnerDirectoryKind } from "@/domain/types";
import type { TelephonyHealthSignal } from "@/lib/telephony/health";
import type { TelephonyExtensionSnapshot, TelephonyPresenceSnapshot } from "@/lib/telephony/presence";
import { GooglePlaceAutocomplete } from "./GooglePlaceAutocomplete";
import {
  CallRoutingTimeline,
  TechnicalTermsDisclosure,
  TelephonyReadinessSummary,
} from "./telephony-settings-ui";
import { useReplacementVehicleAvailability } from "./useReplacementVehicleAvailability";
import { UserAccessSettings } from "./UserAccessSettings";

type IntegrationSettingsProps = {
  branches: Branch[];
  partnerDirectory: PartnerDirectoryEntry[];
  telephonyPresence: TelephonyPresenceSnapshot | null;
  telephonyPresenceHealth: TelephonyHealthSignal;
  users: AccessUser[];
  onDataChange: (dispatchData: DispatchData) => void;
  onRefreshTelephonyPresence: () => Promise<void>;
};

type ApiMutationResponse = {
  dispatchData?: DispatchData;
  error?: string;
};

type SettingsSection = "users" | "telephony" | "partners" | "branches";

type AssignmentAccessState =
  | { status: "loading" }
  | { status: "ready"; extensions: TelephonyExtensionSnapshot[] }
  | { status: "denied"; message: string }
  | { status: "error"; message: string };

type PriorityQueue = "601" | "602" | "603";

type PrioritySlot = {
  queue: PriorityQueue;
  extension: string | null;
};

type PriorityRoutingOperation = {
  operationId: string;
  status: "applying" | "degraded" | "rolling_back";
  baseRevision: number;
  targetRevision: number;
  previousPlan: PrioritySlot[];
  targetPlan: PrioritySlot[];
  currentStep: number;
  stepCount: number;
  fallback: { queue: PriorityQueue; extension: string };
  lastError?: string;
  initialBootstrap?: true;
  releasePending?: boolean;
  createdAt: string;
  updatedAt: string;
};

type PriorityRoutingSnapshot = {
  gate: {
    enabled: boolean;
    reason: "enabled" | "preview_blocked" | "flag_disabled" | "authority_missing";
  };
  catalog: {
    ready: boolean;
    queues: Array<{
      queue: PriorityQueue;
      label: string;
      id?: string;
      lineId?: string | null;
      action: "insert" | "update" | "noop";
    }>;
  };
  revision: number;
  currentPlan: PrioritySlot[];
  operation: PriorityRoutingOperation | null;
  candidates: Array<{
    extensionId: string;
    extension: string;
    profileId: string;
    profileName: string;
    registered?: boolean;
  }>;
  actualMemberships: Array<{
    queue: string;
    extension: string;
    paused: boolean;
    inUse: boolean;
  }>;
  waitingCalls: Array<{ queue: string; count: number; capturedAt?: string }>;
};

type PriorityRoutingAccessState =
  | { status: "loading" }
  | { status: "ready"; routing: PriorityRoutingSnapshot }
  | { status: "denied"; message: string }
  | { status: "error"; message: string };

type PriorityRoutingAction = "bootstrap" | "bootstrap-empty" | "apply" | "resume" | "rollback" | "reconcile";

type ViptelLinePlanItem = {
  action: "insert" | "update" | "noop" | "conflict";
  existingId?: string;
  label: string;
  phoneNumber: string;
  purpose: "neutral" | "insurer" | "reserve";
  reason?: string;
};

type ViptelLinePlanState =
  | { status: "loading" }
  | {
      status: "ready";
      plan: ViptelLinePlanItem[];
      dryRunKey: string;
      gate: PriorityRoutingSnapshot["gate"];
    }
  | { status: "denied"; message: string }
  | { status: "error"; message: string };

const priorityQueueSlots: Array<{ queue: PriorityQueue; label: string; detail: string }> = [
  { queue: "601", label: "1. volaný operátor", detail: "zvoní ako prvý" },
  { queue: "602", label: "2. volaný operátor", detail: "požadovaný prepad po 20 sekundách · nastavuje VIPTel" },
  { queue: "603", label: "3. volaný operátor", detail: "zvoní opakovane v slučke" },
];

const personalExtensionNumbers = ["20", "21", "22", "23"] as const;

const settingsSections: Array<{ icon: LucideIcon; label: string; shortLabel: string; value: SettingsSection }> = [
  { icon: Users, label: "Používatelia", shortLabel: "Používatelia", value: "users" },
  { icon: PhoneCall, label: "Telefonovanie", shortLabel: "Telefóny", value: "telephony" },
  { icon: Building2, label: "Firmy a asistencia", shortLabel: "Firmy", value: "partners" },
  { icon: MapPinned, label: "Pobočky", shortLabel: "Pobočky", value: "branches" },
];

export function IntegrationSettings({
  branches,
  onDataChange,
  onRefreshTelephonyPresence,
  partnerDirectory,
  telephonyPresence,
  telephonyPresenceHealth,
  users,
}: IntegrationSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("users");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <main className="flex-1 bg-zinc-50 p-3 pb-[calc(84px+env(safe-area-inset-bottom))] sm:p-4 sm:pb-6">
      <h1 className="sr-only">Nastavenia</h1>

      <nav className="sticky top-0 z-30 mx-auto mb-4 max-w-7xl bg-zinc-50/95 py-2 backdrop-blur" aria-label="Sekcie nastavení">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {settingsSections.map(({ icon: Icon, label, shortLabel, value }) => {
            const active = activeSection === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setActiveSection(value)}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 ${
                  active
                    ? "border-yellow-400 bg-[#FCD703] text-zinc-950 shadow-sm"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-100"
                }`}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="sm:hidden">{shortLabel}</span>
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="mx-auto max-w-7xl">
        {message && <div role="status" aria-live="polite" className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{message}</div>}

        {activeSection === "users" && (
          <UserAccessSettings users={users} onDataChange={onDataChange} onNotice={setMessage} />
        )}

        {activeSection === "telephony" && (
          <ViptelFoundationPanel
            telephonyPresence={telephonyPresence}
            telephonyPresenceHealth={telephonyPresenceHealth}
            users={users}
            onRefreshTelephonyPresence={onRefreshTelephonyPresence}
          />
        )}

        {activeSection === "partners" && (
          <PartnerDirectoryForm
            entries={partnerDirectory}
            onSaved={(dispatchData) => {
              onDataChange(dispatchData);
              setMessage("Adresár firiem a asistenčných služieb je aktualizovaný.");
            }}
          />
        )}

        {activeSection === "branches" && (
          <BranchForm
            branches={branches}
            onSaved={(dispatchData) => {
              onDataChange(dispatchData);
              setMessage("Pobočka je uložená a mapa pracuje s novou kapacitou.");
            }}
          />
        )}
      </div>
    </main>
  );
}

function ViptelFoundationPanel({
  onRefreshTelephonyPresence,
  telephonyPresence,
  telephonyPresenceHealth,
  users,
}: {
  telephonyPresence: TelephonyPresenceSnapshot | null;
  telephonyPresenceHealth: TelephonyHealthSignal;
  users: AccessUser[];
  onRefreshTelephonyPresence: () => Promise<void>;
}) {
  const [assignmentAccess, setAssignmentAccess] = useState<AssignmentAccessState>({ status: "loading" });
  const [refreshingFoundation, setRefreshingFoundation] = useState(false);
  const [routingRefreshVersion, setRoutingRefreshVersion] = useState(0);
  const [routingChangeActive, setRoutingChangeActive] = useState(false);
  const [routingSlotsConfigured, setRoutingSlotsConfigured] = useState(0);
  const [publicNumberSummary, setPublicNumberSummary] = useState({ count: 0, ready: false });
  const loadAssignments = useCallback(async () => {
    setAssignmentAccess(await fetchAssignmentAccessState());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAssignmentAccessState().then((state) => {
      if (!cancelled) setAssignmentAccess(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const canManageAssignments =
    assignmentAccess.status === "ready" ||
    (assignmentAccess.status !== "denied" && telephonyPresence?.canManageAssignments === true);
  const extensions = assignmentAccess.status === "ready"
    ? assignmentAccess.extensions
    : telephonyPresence?.extensions ?? [];
  const liveStatusAvailable = telephonyPresenceHealth.state === "live" && telephonyPresence != null;

  const refreshAll = useCallback(async () => {
    if (refreshingFoundation) return;
    setRefreshingFoundation(true);
    let refreshError: unknown;
    try {
      await onRefreshTelephonyPresence();
    } catch (caught) {
      refreshError = caught;
    }
    await loadAssignments();
    setRoutingRefreshVersion((current) => current + 1);
    setRefreshingFoundation(false);
    if (refreshError) throw refreshError;
  }, [loadAssignments, onRefreshTelephonyPresence, refreshingFoundation]);

  const handleRoutingSnapshot = useCallback((routing: PriorityRoutingSnapshot) => {
    setRoutingSlotsConfigured(routing.currentPlan.filter((slot) => Boolean(slot.extension)).length);
    setRoutingChangeActive(routing.operation !== null);
  }, []);

  const handlePublicNumberSummary = useCallback((summary: { count: number; ready: boolean }) => {
    setPublicNumberSummary(summary);
  }, []);

  const personalExtensionByNumber = new globalThis.Map(
    extensions
      .filter((extension) => extension.assignmentEligible === true)
      .map((extension) => [extension.extension, extension]),
  );
  const assignedCount = personalExtensionNumbers.filter(
    (extension) => Boolean(personalExtensionByNumber.get(extension)?.profileId),
  ).length;

  return (
    <div className="space-y-4">
      <TelephonyReadinessSummary
        connectionState={telephonyPresenceHealth.state}
        connectionDetail={telephonyPresenceHealth.detail}
        assignedCount={assignedCount}
        extensionCount={personalExtensionNumbers.length}
        routingChangeActive={routingChangeActive}
        routingSlotsConfigured={routingSlotsConfigured}
        publicNumberCount={publicNumberSummary.count}
        publicNumbersReady={publicNumberSummary.ready}
        refreshing={refreshingFoundation}
        onRefresh={refreshAll}
      />

      <section className="rounded-md border border-zinc-200 bg-white">
        {canManageAssignments ? (
          <>
            <ExtensionAssignmentPanel
              extensions={extensions}
              liveStatusAvailable={liveStatusAvailable}
              users={users}
              onRefresh={refreshAll}
            />
            <PriorityRoutingPanel
              refreshVersion={routingRefreshVersion}
              onSnapshot={handleRoutingSnapshot}
            />
            <ViptelLineCatalogPanel onSummary={handlePublicNumberSummary} />
          </>
        ) : assignmentAccess.status === "loading" ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 p-4 text-sm font-medium text-zinc-600">
            <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" />
            Overujem oprávnenie a načítavam klapky…
          </div>
        ) : assignmentAccess.status === "denied" ? (
          <div className="p-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
              <div className="font-semibold">Priradenia môže meniť manažér alebo administrátor.</div>
              <div className="mt-1 text-xs">{assignmentAccess.message}</div>
            </div>
          </div>
        ) : (
          <div className="p-4">
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-900">
              <div className="font-semibold">Klapky sa nepodarilo načítať.</div>
              <div className="mt-1 text-xs">{assignmentAccess.message}</div>
              {telephonyPresenceHealth.detail && <div className="mt-1 text-xs">{telephonyPresenceHealth.detail}</div>}
              <button
                type="button"
                onClick={() => {
                  setAssignmentAccess({ status: "loading" });
                  void loadAssignments();
                }}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-900 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
              >
                <RefreshCw size={14} aria-hidden="true" />
                Skúsiť znova
              </button>
            </div>
          </div>
        )}
      </section>

      <TechnicalTermsDisclosure />
    </div>
  );
}

async function fetchAssignmentAccessState(): Promise<AssignmentAccessState> {
  try {
    const response = await telephonyFetch("/api/telephony/extension-assignments", {
      label: "priradenie klapiek",
      timeoutMs: TELEPHONY_TIMEOUT_MS.read,
    });
    const result = (await response.json().catch(() => null)) as {
      error?: string;
      extensions?: TelephonyExtensionSnapshot[];
      ok?: boolean;
    } | null;

    if (response.status === 401 || response.status === 403) {
      return { status: "denied", message: result?.error ?? "Na správu klapiek nemáte oprávnenie." };
    }

    if (!response.ok || !result?.ok || !Array.isArray(result.extensions)) {
      throw new Error(result?.error ?? "Priradenia klapiek sa nepodarilo načítať.");
    }

    return { status: "ready", extensions: result.extensions };
  } catch (caught) {
    return {
      status: "error",
      message: caught instanceof Error ? caught.message : "Priradenia klapiek sa nepodarilo načítať.",
    };
  }
}

function ExtensionAssignmentPanel({
  extensions,
  liveStatusAvailable,
  users,
  onRefresh,
}: {
  extensions: TelephonyExtensionSnapshot[];
  liveStatusAvailable: boolean;
  users: AccessUser[];
  onRefresh: () => Promise<void>;
}) {
  const [pendingExtensionId, setPendingExtensionId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftProfileIds, setDraftProfileIds] = useState<Record<string, string>>({});
  const [initialProvisioningAttested, setInitialProvisioningAttested] = useState<Record<string, boolean>>({});
  const [unassignmentAttested, setUnassignmentAttested] = useState<Record<string, boolean>>({});
  const [rotationAttested, setRotationAttested] = useState<Record<string, boolean>>({});
  const [rotationReferences, setRotationReferences] = useState<Record<string, string>>({});

  const userById = new globalThis.Map(users.map((user) => [user.id, user]));
  const assignedExtensionByProfile = new globalThis.Map(
    extensions.flatMap((extension) => (extension.profileId ? [[extension.profileId, extension.extension] as const] : [])),
  );
  const assignableUsers = users
    .filter((user) => user.active)
    .sort((left, right) => left.name.localeCompare(right.name, "sk"));

  async function assign(extension: TelephonyExtensionSnapshot, profileId: string) {
    if (pendingExtensionId) return;
    const assigning = Boolean(profileId);
    const initialProvisioning = extension.assignmentRequirement === "initial_provisioning";
    const rotationReference = rotationReferences[extension.id]?.trim() ?? "";
    if (assigning && initialProvisioning && !initialProvisioningAttested[extension.id]) {
      setError("Potvrď prvotné pridelenie doteraz nepoužitej klapky.");
      return;
    }
    if (assigning && !initialProvisioning && (rotationReference.length < 6 || !rotationAttested[extension.id])) {
      setError("Pred ďalším priradením potvrďte bezpečnú zmenu SIP prístupu a zadajte jej referenciu, nie heslo.");
      return;
    }
    setPendingExtensionId(extension.id);
    setError(null);
    setNotice(null);

    try {
      const response = await telephonyFetch("/api/telephony/extension-assignments", {
        label: "zmena priradenia klapky",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extensionId: extension.id,
          profileId: profileId || null,
          ...(assigning && initialProvisioning
            ? { initialProvisioningAttested: true }
            : assigning ? { rotationAttested: true, rotationReference } : {}),
        }),
      });
      const result = (await response.json().catch(() => null)) as { error?: string; ok?: boolean } | null;

      if (!response.ok || !result?.ok) {
        throw new Error(result?.error ?? "Priradenie klapky sa nepodarilo uložiť.");
      }

      setRotationAttested((current) => ({ ...current, [extension.id]: false }));
      setInitialProvisioningAttested((current) => ({ ...current, [extension.id]: false }));
      setUnassignmentAttested((current) => ({ ...current, [extension.id]: false }));
      setRotationReferences((current) => ({ ...current, [extension.id]: "" }));
      setDraftProfileIds((current) => ({ ...current, [extension.id]: profileId }));
      setNotice(
        assigning
          ? `Operátor bol priradený ku klapke ${extension.extension}. Poradie volania sa automaticky obnovuje.`
          : `Operátor bol od klapky ${extension.extension} odpojený. Poradie volania sa automaticky obnovuje.`,
      );
      try {
        await onRefresh();
      } catch {
        setError("Priradenie je uložené, ale nový prehľad sa nepodarilo načítať. Použite Obnoviť stav; zmenu neopakujte.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Priradenie klapky sa nepodarilo uložiť.");
      try {
        await onRefresh();
      } catch {
        // The mutation error remains primary; a manual refresh is still available.
      }
      setDraftProfileIds((current) => {
        const next = { ...current };
        delete next[extension.id];
        return next;
      });
    } finally {
      setPendingExtensionId(null);
    }
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      await onRefresh();
      setDraftProfileIds({});
    } catch {
      setError("Klapky sa nepodarilo obnoviť. Skúste to znova.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div id="viptel-operators" className="scroll-mt-24 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-950">
            <UserRound size={18} aria-hidden="true" />
            Operátori a ich klapky
          </h3>
          <p className="mt-1 text-sm text-zinc-600">Tu určíte, komu patrí osobná klapka. Poradie zvonenia nastavíte v nasledujúcom kroku.</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <RefreshCw size={15} aria-hidden="true" className={refreshing ? "motion-safe:animate-spin" : ""} />
          {refreshing ? "Obnovujem…" : "Obnoviť stav"}
        </button>
      </div>

      {!liveStatusAvailable && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
          <div className="font-semibold">Zobrazený stav VIPTel nie je čerstvo overený.</div>
          <p className="mt-1">Priradenie môžete pripraviť. Pri uložení systém načíta nový stav VIPTel a zmenu vykoná iba vtedy, keď je bezpečná.</p>
        </div>
      )}
      {notice && <div role="status" aria-live="polite" className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-950">{notice}</div>}
      {error && <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-900">{error}</div>}

      <div className="grid gap-2">
        {extensions.length === 0 ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 text-sm text-zinc-600">
            Nie sú dostupné žiadne aktívne klapky.
          </div>
        ) : (
          extensions.map((extension) => {
            const currentOwner = extension.profileId ? userById.get(extension.profileId) : undefined;
            const pending = pendingExtensionId === extension.id;
            const assignmentEligible = extension.assignmentEligible === true;
            const initialProvisioning = extension.assignmentRequirement === "initial_provisioning";
            const draftProfileId = draftProfileIds[extension.id] ?? extension.profileId ?? "";
            const assignmentChanged = draftProfileId !== (extension.profileId ?? "");
            const assigning = Boolean(draftProfileId);
            const assignmentConfirmationReady = !assignmentChanged
              ? false
              : !assigning
                ? Boolean(unassignmentAttested[extension.id])
                : initialProvisioning
                  ? Boolean(initialProvisioningAttested[extension.id])
                  : Boolean(rotationAttested[extension.id]) && (rotationReferences[extension.id]?.trim().length ?? 0) >= 6;
            const ownerSelectId = `viptel-owner-${extension.id}`;
            const ownerHelpId = `viptel-owner-help-${extension.id}`;
            const confirmationHelpId = `viptel-owner-confirmation-${extension.id}`;
            const confirmationHelp = !assigning
              ? unassignmentAttested[extension.id]
                ? "Odpojenie je pripravené na bezpečné uloženie."
                : "Najprv potvrďte, že operátor stratí túto klapku."
              : initialProvisioning
                ? initialProvisioningAttested[extension.id]
                  ? "Prvé pridelenie je pripravené na bezpečné uloženie."
                  : "Najprv potvrďte prvé pridelenie klapky."
                : assignmentConfirmationReady
                  ? "Zmena je pripravená na bezpečné uloženie."
                  : "Zadajte referenciu s aspoň 6 znakmi a potvrďte zmenu prihlasovacích údajov.";

            return (
              <div
                key={extension.id}
                className="grid items-start gap-4 rounded-lg border border-zinc-200 bg-white px-3 py-4 md:grid-cols-[minmax(170px,0.75fr)_minmax(250px,1.35fr)_minmax(180px,0.7fr)]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-zinc-950">Klapka {extension.extension}</span>
                    {!assignmentEligible && <StatusBadge label="Klapku nemožno priradiť" tone="bad" />}
                    {liveStatusAvailable && (
                      <StatusBadge label={extension.registered ? "Pripravená na hovory" : "Telefón nie je pripojený"} tone={extension.registered ? "ok" : "bad"} />
                    )}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">Technický názov vo VIPTel: <span className="font-medium text-zinc-700">{extension.displayName || "bez názvu"}</span></div>
                  {!liveStatusAvailable && <div className="mt-1 text-xs text-amber-800">Pripojenie sa overí pri uložení.</div>}
                </div>

                <div className="min-w-0">
                  <label htmlFor={ownerSelectId} className="mb-1 block text-sm font-semibold text-zinc-700">
                    Operátor pre klapku {extension.extension}
                  </label>
                  <select
                    id={ownerSelectId}
                    name={`operator-extension-${extension.extension}`}
                    value={draftProfileId}
                    onChange={(event) => {
                      setDraftProfileIds((current) => ({ ...current, [extension.id]: event.target.value }));
                      setInitialProvisioningAttested((current) => ({ ...current, [extension.id]: false }));
                      setUnassignmentAttested((current) => ({ ...current, [extension.id]: false }));
                      setRotationAttested((current) => ({ ...current, [extension.id]: false }));
                      setError(null);
                      setNotice(null);
                    }}
                    disabled={pending || !assignmentEligible}
                    aria-describedby={ownerHelpId}
                    className="h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-100 disabled:text-zinc-500"
                  >
                    <option value="">Bez operátora</option>
                    {currentOwner && !currentOwner.active && (
                      <option value={currentOwner.id} disabled>
                        {currentOwner.name} · neaktívny účet
                      </option>
                    )}
                    {assignableUsers.map((user) => {
                      const assignedElsewhere = assignedExtensionByProfile.get(user.id);
                      const requiresHandoff = Boolean(currentOwner && currentOwner.id !== user.id);
                      return (
                        <option
                          key={user.id}
                          value={user.id}
                          disabled={requiresHandoff || Boolean(assignedElsewhere && assignedElsewhere !== extension.extension)}
                        >
                          {user.name}
                          {requiresHandoff
                            ? " · najprv odovzdajte klapku"
                            : assignedElsewhere && assignedElsewhere !== extension.extension
                              ? ` · klapka ${assignedElsewhere}`
                              : ""}
                        </option>
                      );
                    })}
                  </select>
                  <p id={ownerHelpId} className="mt-1.5 text-xs text-zinc-500">
                    Výber iba pripraví návrh. VIPTel sa zmení až po potvrdení tlačidlom.
                  </p>

                  {assignmentChanged && assignmentEligible && (
                    <div className="mt-3 space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                      {!assigning ? (
                        <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-700">
                          <input
                            type="checkbox"
                            checked={unassignmentAttested[extension.id] ?? false}
                            onChange={(event) =>
                              setUnassignmentAttested((current) => ({ ...current, [extension.id]: event.target.checked }))
                            }
                            disabled={pending}
                            className="mt-0.5 size-4"
                          />
                          <span>Rozumiem, že operátor po odpojení stratí túto osobnú klapku.</span>
                        </label>
                      ) : initialProvisioning ? (
                        <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-700">
                          <input
                            type="checkbox"
                            checked={initialProvisioningAttested[extension.id] ?? false}
                            onChange={(event) =>
                              setInitialProvisioningAttested((current) => ({ ...current, [extension.id]: event.target.checked }))
                            }
                            disabled={pending}
                            className="mt-0.5 size-4"
                          />
                          <span>Potvrdzujem prvé pridelenie tejto doteraz nepoužitej klapky.</span>
                        </label>
                      ) : (
                        <>
                          <label className="block">
                            <span className="mb-1 block text-xs font-semibold text-zinc-700">Potvrdenie zmeny SIP prístupu</span>
                            <input
                              type="text"
                              name={`sip-change-reference-${extension.extension}`}
                              autoComplete="off"
                              value={rotationReferences[extension.id] ?? ""}
                              onChange={(event) =>
                                setRotationReferences((current) => ({ ...current, [extension.id]: event.target.value }))
                              }
                              maxLength={120}
                              placeholder="Napríklad VIPTEL-2026-08-04-20…"
                              disabled={pending}
                              className="h-10 w-full rounded-md border border-zinc-300 bg-white px-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-100"
                            />
                          </label>
                          <p className="text-xs text-zinc-600"><strong>SIP prístup</strong> sú prihlasovacie údaje telefónnej klapky. Do potvrdenia nikdy nepíšte heslo.</p>
                          <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-700">
                            <input
                              type="checkbox"
                              checked={rotationAttested[extension.id] ?? false}
                              onChange={(event) =>
                                setRotationAttested((current) => ({ ...current, [extension.id]: event.target.checked }))
                              }
                              disabled={pending}
                              className="mt-0.5 size-4"
                            />
                            <span>Potvrdzujem, že prihlasovacie údaje klapky boli vo VIPTel bezpečne zmenené.</span>
                          </label>
                        </>
                      )}

                      <p id={confirmationHelpId} className="text-xs font-medium text-zinc-600">{confirmationHelp}</p>
                      <button
                        type="button"
                        onClick={() => void assign(extension, draftProfileId)}
                        disabled={pending || !assignmentConfirmationReady}
                        aria-describedby={confirmationHelpId}
                        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600 sm:w-auto"
                      >
                        {pending ? <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" /> : <Save size={16} aria-hidden="true" />}
                        {pending
                          ? "Ukladám…"
                          : assigning
                            ? "Uložiť priradenie"
                            : "Odpojiť operátora"}
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex min-w-0 items-center gap-2 pt-1 text-xs text-zinc-600">
                  {pending ? <Loader2 size={14} aria-hidden="true" className="shrink-0 motion-safe:animate-spin" /> : <PhoneForwarded size={14} aria-hidden="true" className="shrink-0 text-zinc-400" />}
                  <span className="truncate">Presmerovanie: {forwardingLabel(extension.callForwarding)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function PriorityRoutingPanel({
  onSnapshot,
  refreshVersion,
}: {
  onSnapshot: (routing: PriorityRoutingSnapshot) => void;
  refreshVersion: number;
}) {
  const [access, setAccess] = useState<PriorityRoutingAccessState>({ status: "loading" });
  const [draft, setDraft] = useState<Record<PriorityQueue, string>>({ "601": "", "602": "", "603": "" });
  const [fallbackKey, setFallbackKey] = useState("");
  const [pendingAction, setPendingAction] = useState<PriorityRoutingAction | null>(null);
  const [lastDryRun, setLastDryRun] = useState<{
    action: "apply" | "bootstrap" | "bootstrap-empty";
    key: string;
    previewDigest?: string;
    steps?: Array<{ action: "add" | "remove" | "pause" | "unpause"; queue: PriorityQueue; extension: string }>;
    stepCount?: number;
    targetRevision?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const hasLoadedRouting = useRef(false);
  const [routingWatchExhausted, setRoutingWatchExhausted] = useState(false);
  const routingRequestSequence = useRef(0);

  const loadRouting = useCallback(async (syncDraft: boolean, clearExistingError = true) => {
    const requestSequence = ++routingRequestSequence.current;
    try {
      const response = await telephonyFetch("/api/telephony/routing/priority", {
        label: "poradie pracovísk",
        timeoutMs: TELEPHONY_TIMEOUT_MS.snapshot,
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        ok?: boolean;
        routing?: PriorityRoutingSnapshot;
      } | null;
      if (requestSequence !== routingRequestSequence.current) return;

      if (response.status === 401 || response.status === 403) {
        setAccess({ status: "denied", message: result?.error ?? "Na správu poradia nemáte oprávnenie." });
        return;
      }
      if (!response.ok || !result?.ok || !result.routing) {
        throw new Error(result?.error ?? "Poradie volania sa nepodarilo načítať.");
      }

      setAccess({ status: "ready", routing: result.routing });
      onSnapshot(result.routing);
      hasLoadedRouting.current = true;
      if (syncDraft) {
        const sourcePlan = result.routing.operation?.targetPlan ?? result.routing.currentPlan;
        setDraft(priorityDraftFromSlots(sourcePlan));
        setFallbackKey(
          result.routing.operation
            ? priorityFallbackKey(result.routing.operation.fallback.queue, result.routing.operation.fallback.extension)
            : "",
        );
      }
      setLastDryRun(null);
      if (clearExistingError) setError(null);
    } catch (caught) {
      if (requestSequence !== routingRequestSequence.current) return;
      const message = caught instanceof Error ? caught.message : "Poradie volania sa nepodarilo načítať.";
      setAccess((current) => (current.status === "ready" ? current : { status: "error", message }));
      setError(message);
    }
  }, [onSnapshot]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRouting(!hasLoadedRouting.current), 0);
    return () => window.clearTimeout(timer);
  }, [loadRouting, refreshVersion]);

  const routing = access.status === "ready" ? access.routing : null;
  const activeOperationId = routing?.operation?.operationId;

  useEffect(() => {
    if (!activeOperationId) return;
    // A routing operation is not infinite. Watching it every 3 s forever, in
    // every open settings tab, kept a heavy provider-backed read running long
    // after the operation had stopped progressing. Slow down when nobody is
    // looking, and stop entirely after a few minutes rather than polling for
    // the rest of the session.
    let cancelled = false;
    let timeoutId: number | undefined;
    const startedAt = Date.now();
    const schedule = () => {
      if (cancelled) return;
      if (Date.now() - startedAt > ROUTING_WATCH_MAX_MS) {
        setRoutingWatchExhausted(true);
        return;
      }
      timeoutId = window.setTimeout(async () => {
        await loadRouting(true, false);
        schedule();
      }, document.visibilityState === "hidden" ? ROUTING_WATCH_HIDDEN_MS : ROUTING_WATCH_VISIBLE_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [activeOperationId, loadRouting]);

  if (access.status === "loading") {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 border-t border-zinc-200 p-4 text-sm font-medium text-zinc-600">
        <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" />
        Načítavam poradie zvonenia…
      </div>
    );
  }

  if (access.status === "denied") {
    return (
      <div className="border-t border-zinc-200 p-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
          <div className="font-semibold">Poradie môže meniť iba manažér alebo administrátor.</div>
          <div className="mt-1 text-xs">{access.message}</div>
        </div>
      </div>
    );
  }

  if (access.status === "error" || !routing) {
    return (
      <div className="border-t border-zinc-200 p-4">
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-900">
          <div className="font-semibold">Poradie volania sa nepodarilo načítať.</div>
          <div className="mt-1 text-xs">{access.status === "error" ? access.message : "Chýba serverový stav poradia."}</div>
          <button
            type="button"
            onClick={() => {
              setAccess({ status: "loading" });
              void loadRouting(true);
            }}
            className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-900 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
          >
            <RefreshCw size={13} />
            Skúsiť znova
          </button>
        </div>
      </div>
    );
  }

  const routingSnapshot = routing;
  const operation = routingSnapshot.operation;
  const routingRevision = routing.revision;
  const selectedExtensions = Object.values(draft).filter(Boolean);
  const duplicateExtension = new Set(selectedExtensions).size !== selectedExtensions.length;
  const completePlan = priorityQueueSlots.every(({ queue }) => Boolean(draft[queue]));
  const slots = priorityQueueSlots.map(({ queue }) => ({ queue, extension: draft[queue] || null }));
  const [fallbackQueue, fallbackExtension] = fallbackKey.split(":") as [PriorityQueue | undefined, string | undefined];
  const applyKey = priorityApplyKey(routing.revision, slots, fallbackKey);
  const emptyBootstrapKey = priorityEmptyBootstrapKey(routing.revision, slots);
  const bootstrapKey = priorityBootstrapKey(routing);
  const applyDryRunCurrent = lastDryRun?.action === "apply" && lastDryRun.key === applyKey;
  const emptyBootstrapDryRunCurrent = lastDryRun?.action === "bootstrap-empty" && lastDryRun.key === emptyBootstrapKey;
  const bootstrapDryRunCurrent = lastDryRun?.action === "bootstrap" && lastDryRun.key === bootstrapKey;
  const candidateByExtension = new globalThis.Map(routing.candidates.map((candidate) => [candidate.extension, candidate]));
  const currentByQueue = new globalThis.Map(routing.currentPlan.map((slot) => [slot.queue, slot.extension]));
  const fallbackOptions = routing.actualMemberships
    .filter(
      (membership) =>
        isPriorityQueue(membership.queue) &&
        !membership.paused &&
        !membership.inUse &&
        candidateByExtension.get(membership.extension)?.registered === true,
    )
    .filter(
      (membership, index, items) =>
        items.findIndex((item) => item.queue === membership.queue && item.extension === membership.extension) === index,
    );
  const fallbackAvailable = Boolean(
    fallbackQueue &&
    fallbackExtension &&
    fallbackOptions.some(
      (item) => priorityFallbackKey(item.queue as PriorityQueue, item.extension) === fallbackKey,
    ),
  );
  const canEditPlan = routing.catalog.ready && !operation && pendingAction === null;
  const currentPlanEmpty = routing.currentPlan.every((slot) => slot.extension === null);
  const canDryRunApply = canEditPlan && completePlan && !duplicateExtension && fallbackAvailable;
  const canApply = canDryRunApply && routing.gate.enabled && applyDryRunCurrent && Boolean(lastDryRun?.previewDigest);
  const canDryRunEmptyBootstrap = canEditPlan && currentPlanEmpty && completePlan && !duplicateExtension;
  const canApplyEmptyBootstrap =
    canDryRunEmptyBootstrap &&
    routing.gate.enabled &&
    emptyBootstrapDryRunCurrent &&
    Boolean(lastDryRun?.previewDigest);
  const routingActionHelp = duplicateExtension
    ? "Každé miesto musí mať iného operátora."
    : !completePlan
      ? "Najprv vyberte operátora pre všetky tri miesta."
      : currentPlanEmpty
        ? !emptyBootstrapDryRunCurrent
          ? "Najprv skontrolujte prvé nastavenie bez uloženia."
          : !routing.gate.enabled
            ? "Kontrola prešla, ale toto prostredie nesmie uložiť živú zmenu."
            : "Prvé nastavenie je pripravené na uloženie."
        : !fallbackKey
          ? "Vyberte záložného operátora, ktorý zostane dostupný počas zmeny."
          : !fallbackAvailable
            ? "Vybraný záložný operátor už nie je dostupný. Vyberte iného."
            : !applyDryRunCurrent
              ? "Najprv skontrolujte zmenu bez uloženia."
              : !routing.gate.enabled
                ? "Kontrola prešla, ale toto prostredie nesmie uložiť živú zmenu."
                : "Poradie je pripravené na uloženie.";

  function changeSlot(queue: PriorityQueue, extension: string) {
    setDraft((current) => ({ ...current, [queue]: extension }));
    setLastDryRun(null);
    setNotice(null);
    setError(null);
  }

  function changeFallback(value: string) {
    setFallbackKey(value);
    setLastDryRun(null);
    setNotice(null);
    setError(null);
  }

  function renderRoutingStep({ queue, label }: (typeof priorityQueueSlots)[number]) {
    const currentExtension = currentByQueue.get(queue);
    const currentCandidate = currentExtension ? candidateByExtension.get(currentExtension) : undefined;
    const waiting = routingSnapshot.waitingCalls.find((item) => item.queue === queue)?.count ?? 0;
    const currentMembership = currentExtension
      ? routingSnapshot.actualMemberships.find((item) => item.queue === queue && item.extension === currentExtension)
      : undefined;
    const selectedElsewhere = new Set(
      priorityQueueSlots
        .filter((item) => item.queue !== queue)
        .map((item) => draft[item.queue])
        .filter(Boolean),
    );
    const selectedCandidate = draft[queue] ? candidateByExtension.get(draft[queue]) : undefined;
    const selectId = `priority-operator-${queue}`;
    const helpId = `priority-operator-help-${queue}`;

    return (
      <div>
        {waiting > 0 && (
          <div className="mb-2 inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
            {waiting} {waiting === 1 ? "hovor čaká" : "hovory čakajú"}
          </div>
        )}
        <label htmlFor={selectId} className="mb-1 block text-sm font-semibold text-zinc-700">
          {label} – rad {queue}
        </label>
        <select
          id={selectId}
          name={`priority-operator-${queue}`}
          value={draft[queue]}
          onChange={(event) => changeSlot(queue, event.target.value)}
          disabled={!canEditPlan}
          aria-describedby={helpId}
          className="h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-100 disabled:text-zinc-500"
        >
          <option value="">Vyberte operátora</option>
          {selectedCandidate == null && draft[queue] && (
            <option value={draft[queue]} disabled>Klapka {draft[queue]} · operátor nie je dostupný</option>
          )}
          {routingSnapshot.candidates.map((candidate) => (
            <option key={candidate.extensionId} value={candidate.extension} disabled={selectedElsewhere.has(candidate.extension)}>
              {candidate.profileName} · klapka {candidate.extension}{candidate.registered === false ? " · telefón nie je pripojený" : ""}
            </option>
          ))}
        </select>

        <div id={helpId} className="mt-2 text-xs leading-5 text-zinc-600">
          <span className="font-semibold">Aktuálne potvrdené:</span>{" "}
          {currentExtension
            ? `${currentCandidate?.profileName ?? "Operátor nie je dostupný"} · klapka ${currentExtension}`
            : "bez operátora"}
          <span className="mt-0.5 block text-zinc-500">
            {!canEditPlan
              ? operation
                ? "Poradie nemožno meniť, kým sa nedokončí rozpracovaná zmena."
                : "Poradie momentálne nemožno upravovať."
              : currentMembership
                ? currentMembership.inUse
                  ? "Operátor práve telefonuje."
                  : currentMembership.paused
                    ? "Operátor je v rade pozastavený."
                    : "Zaradenie operátora je potvrdené."
                : "Zaradenie operátora ešte nie je potvrdené."}
          </span>
        </div>
      </div>
    );
  }

  async function requestAction(action: PriorityRoutingAction, dryRun?: boolean) {
    if (pendingAction) return;
    if (action === "rollback") setConfirmRollback(false);
    setPendingAction(action);
    setError(null);
    setNotice(null);

    const requestKey = action === "bootstrap"
      ? bootstrapKey
      : action === "bootstrap-empty"
        ? emptyBootstrapKey
        : applyKey;
    const body = action === "bootstrap"
      ? { action, dryRun: dryRun !== false }
      : action === "bootstrap-empty"
        ? {
            action,
            dryRun: dryRun !== false,
            baseRevision: routingRevision,
            slots,
            previewDigest: lastDryRun?.action === "bootstrap-empty" && lastDryRun.key === emptyBootstrapKey
              ? lastDryRun.previewDigest
              : undefined,
          }
      : action === "apply"
        ? {
            action,
            dryRun: dryRun !== false,
            baseRevision: routingRevision,
            slots,
            fallback: { queue: fallbackQueue, extension: fallbackExtension },
            previewDigest: lastDryRun?.action === "apply" && lastDryRun.key === applyKey
              ? lastDryRun.previewDigest
              : undefined,
          }
        : { action };

    try {
      const response = await telephonyFetch("/api/telephony/routing/priority", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        label: "zmena poradia pracovísk",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const result = (await response.json().catch(() => null)) as {
        error?: string;
        ok?: boolean;
        preview?: { steps?: unknown[]; targetRevision?: number };
        previewDigest?: string;
        routing?: PriorityRoutingSnapshot;
      } | null;

      if (!response.ok || !result?.ok) {
        if (response.status === 409) {
          await loadRouting(false, false);
        }
        throw new Error(result?.error ?? "Zmenu poradia sa nepodarilo vykonať.");
      }

      if (dryRun !== false && (action === "apply" || action === "bootstrap" || action === "bootstrap-empty")) {
        const planAction = action === "apply" || action === "bootstrap-empty";
        const parsedSteps = planAction ? parsePriorityPreviewSteps(result.preview?.steps) : undefined;
        if (
          planAction &&
          (!Array.isArray(result.preview?.steps) ||
            parsedSteps?.length !== result.preview.steps.length ||
            typeof result.previewDigest !== "string" ||
            !/^[0-9a-f]{64}$/.test(result.previewDigest))
        ) {
          throw new Error("Kontrola bez uloženia vrátila neúplné údaje. Poradie preto nemožno bezpečne uložiť.");
        }
        setLastDryRun({
          action,
          key: requestKey,
          previewDigest: typeof result.previewDigest === "string" ? result.previewDigest : undefined,
          steps: parsedSteps,
          stepCount: Array.isArray(result.preview?.steps) ? result.preview.steps.length : undefined,
          targetRevision: typeof result.preview?.targetRevision === "number" ? result.preview.targetRevision : undefined,
        });
        setNotice(
          action === "apply"
            ? "Kontrola bez uloženia prešla. Pred uložením systém bezpečnostné podmienky overí znova."
            : action === "bootstrap-empty"
              ? "Prvé nastavenie poradia je pripravené. Server pred každým krokom znova overí prázdne rady, pripojenie telefónov a hovory."
            : "Kontrola radov prešla. Zatiaľ sa nič nezmenilo.",
        );
      } else {
        setLastDryRun(null);
        setNotice("Server požiadavku prijal. Nižšie zobrazujem až znovu načítaný stav, nie optimistický výsledok.");
        await loadRouting(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Zmenu poradia sa nepodarilo vykonať.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div id="viptel-routing" className="scroll-mt-24 border-t border-zinc-200 p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-950">
            <ListOrdered size={18} aria-hidden="true" />
            Poradie zvonenia prichádzajúcich hovorov
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-zinc-600">
            Hovor najprv zvoní prvému operátorovi, cieľovo po 20 sekundách druhému a potom tretiemu, kde sa zvonenie opakuje v slučke. Samotný čas prepadu riadi konfigurácia VIPTel.
          </p>
          <p className="mt-1 max-w-3xl text-xs font-medium text-zinc-700">Poradie platí iba pre prichádzajúce hovory. Každý prihlásený operátor môže samostatne volať von.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void loadRouting(false)}
            disabled={pendingAction !== null}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            <RefreshCw size={14} aria-hidden="true" />
            Obnoviť poradie
          </button>
        </div>
      </div>

      <div className={`mb-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${routing.gate.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
        {routing.gate.enabled ? <ShieldCheck size={15} aria-hidden="true" className="mt-0.5 shrink-0" /> : <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />}
        <div>
          <div className="font-semibold">{routing.gate.enabled ? "Ukladanie zmien je pripravené" : "Ukladanie zmien momentálne nie je dostupné"}</div>
          <div id="viptel-routing-gate-detail" className="mt-0.5">{priorityGateDetail(routing.gate.reason)}</div>
        </div>
      </div>

      <details className="mb-4 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
        <summary className="min-h-8 cursor-pointer select-none py-1 font-semibold text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400">
          Technické informácie o verzii nastavenia
        </summary>
        <p className="mt-2">Aktuálna verzia poradia: {routing.revision}. Cieľová verzia po uložení: {operation?.targetRevision ?? routing.revision + 1}.</p>
        <p className="mt-1"><strong>Verzia nastavenia (revision)</strong> chráni novšie poradie pred prepísaním staršou otvorenou obrazovkou.</p>
      </details>

      {operation && (
        <div className={`mb-4 rounded-md border px-3 py-3 text-sm ${operation.status === "degraded" ? "border-red-200 bg-red-50 text-red-950" : "border-blue-200 bg-blue-50 text-blue-950"}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-semibold">
                {operation.releasePending
                  ? "Dokončuje sa bezpečné uvoľnenie klapiek"
                  : operation.initialBootstrap
                    ? `Prvé nastavenie poradia: ${priorityOperationLabel(operation.status).toLocaleLowerCase("sk")}`
                    : priorityOperationLabel(operation.status)}
              </div>
              <div className="mt-1 text-xs">
                Verzia {operation.baseRevision} → {operation.targetRevision} · krok {Math.min(operation.currentStep + 1, operation.stepCount)} z {operation.stepCount}
              </div>
              <div className="mt-1 text-xs">
                Záložný operátor: rad {operation.fallback.queue}, klapka {operation.fallback.extension}
              </div>
              <div id="viptel-routing-recovery-help" className="mt-2 max-w-xl text-xs">
                Obnovu, pokračovanie alebo návrat použite iba pri zastavenej zmene. Server akciu odmietne, kým pôvodný príkaz ešte beží alebo nemožno bezpečne potvrdiť stav VIPTel.
              </div>
              {operation.lastError && <div className="mt-2 font-medium">{operation.lastError}</div>}
              {routingWatchExhausted && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs font-semibold text-amber-950">
                  <span>Automatické sledovanie zmeny som po niekoľkých minútach zastavil. Stav si obnov ručne.</span>
                  <button
                    type="button"
                    onClick={() => {
                      setRoutingWatchExhausted(false);
                      void loadRouting(true, false);
                    }}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 font-bold text-amber-950 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    Obnoviť stav
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {operation.status === "degraded" && !operation.releasePending && (
                <button
                  type="button"
                  onClick={() => void requestAction("reconcile")}
                  disabled={pendingAction !== null || !routing.gate.enabled}
                  aria-describedby="viptel-routing-recovery-help viptel-routing-gate-detail"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-blue-200 bg-white px-3 text-sm font-semibold text-blue-900 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  {pendingAction === "reconcile" ? <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" /> : <RefreshCw size={13} aria-hidden="true" />}
                  Zosúladiť stav
                </button>
              )}
              <button
                type="button"
                onClick={() => void requestAction("resume")}
                disabled={pendingAction !== null || !routing.gate.enabled}
                aria-describedby="viptel-routing-recovery-help viptel-routing-gate-detail"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {pendingAction === "resume" ? <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" /> : <Play size={13} aria-hidden="true" />}
                {operation.releasePending ? "Dokončiť uvoľnenie" : "Obnoviť / pokračovať"}
              </button>
              {!operation.releasePending && !confirmRollback && (
                <button
                  type="button"
                  onClick={() => setConfirmRollback(true)}
                  disabled={pendingAction !== null || !routing.gate.enabled}
                  aria-describedby="viptel-routing-recovery-help viptel-routing-gate-detail"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-900 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  {pendingAction === "rollback" ? <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" /> : <RotateCcw size={13} aria-hidden="true" />}
                  Vrátiť zmenu
                </button>
              )}
              {!operation.releasePending && confirmRollback && (
                <div role="group" aria-label="Potvrdenie návratu poradia" className="w-full rounded-md border border-red-200 bg-white p-3 text-red-950 sm:w-auto">
                  <p className="max-w-sm text-xs font-medium">Naozaj chcete obnoviť posledné potvrdené poradie? Server návrat vykoná iba po novej bezpečnostnej kontrole.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmRollback(false)}
                      className="inline-flex min-h-11 items-center rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2"
                    >
                      Zrušiť
                    </button>
                    <button
                      type="button"
                      onClick={() => void requestAction("rollback")}
                      disabled={pendingAction !== null || !routing.gate.enabled}
                      aria-describedby="viptel-routing-recovery-help viptel-routing-gate-detail"
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-red-700 px-3 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:bg-zinc-300 disabled:text-zinc-600"
                    >
                      {pendingAction === "rollback" ? <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" /> : <RotateCcw size={13} aria-hidden="true" />}
                      Potvrdiť návrat
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!routing.catalog.ready ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <div className="font-semibold">Najprv treba pripraviť telefonovanie v radoch 601–603.</div>
          <p className="mt-1 text-xs">Ide o jednorazové technické vytvorenie troch radov, nie o zmenu ich poradia.</p>
          <div className="mt-2 grid gap-1 text-xs sm:grid-cols-3">
            {routing.catalog.queues.map((queue) => (
              <div key={queue.queue} className="rounded border border-amber-200 bg-white/70 px-2 py-1.5">
                Rad {queue.queue}: {priorityCatalogActionLabel(queue.action)}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void requestAction("bootstrap", true)}
              disabled={pendingAction !== null}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-950 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {pendingAction === "bootstrap" ? <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" /> : <ShieldCheck size={13} aria-hidden="true" />}
              Skontrolovať bez uloženia
            </button>
            <button
              type="button"
              onClick={() => void requestAction("bootstrap", false)}
              disabled={pendingAction !== null || !routing.gate.enabled || !bootstrapDryRunCurrent}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              <Save size={13} />
              Vytvoriť rady
            </button>
          </div>
        </div>
      ) : routing.candidates.length === 0 && !operation ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-blue-950">
          <h4 className="font-semibold">Zatiaľ nie je koho zaradiť do poradia.</h4>
          <p className="mt-1 text-sm">Najprv priraďte aspoň troch operátorov ku klapkám 20–23. Potom sa tu zobrazia automaticky.</p>
          <a
            href="#viptel-operators"
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2"
          >
            Prejsť na operátorov
          </a>
        </div>
      ) : (
        <>
          <CallRoutingTimeline
            queueMetadata={[
              priorityQueueSlots[0],
              priorityQueueSlots[1],
              priorityQueueSlots[2],
            ]}
            stepContents={[
              renderRoutingStep(priorityQueueSlots[0]),
              renderRoutingStep(priorityQueueSlots[1]),
              renderRoutingStep(priorityQueueSlots[2]),
            ]}
          />

          {!currentPlanEmpty && <div className="mt-3 rounded-md border border-zinc-200 bg-white p-3">
            <label className="block max-w-xl">
              <span className="mb-1 block text-sm font-semibold text-zinc-700">Záložný operátor počas zmeny</span>
              <select
                value={fallbackKey}
                onChange={(event) => changeFallback(event.target.value)}
                disabled={!canEditPlan}
                className="h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-100 disabled:text-zinc-500"
              >
                <option value="">Vyberte dostupného záložného operátora</option>
                {fallbackKey && !fallbackAvailable && (
                  <option value={fallbackKey} disabled>
                    {fallbackExtension && fallbackQueue
                      ? `Klapka ${fallbackExtension} · rad ${fallbackQueue} · už nie je dostupná`
                      : "Predtým vybraný operátor už nie je dostupný"}
                  </option>
                )}
                {fallbackOptions.map((membership) => {
                  const candidate = candidateByExtension.get(membership.extension);
                  const queue = membership.queue as PriorityQueue;
                  return (
                    <option key={priorityFallbackKey(queue, membership.extension)} value={priorityFallbackKey(queue, membership.extension)}>
                      {candidate?.profileName ?? "Záložný operátor"} · klapka {membership.extension} · rad {queue}
                    </option>
                  );
                })}
              </select>
            </label>
            <p className="mt-1 text-xs text-zinc-500">
              Tento operátor zostane dostupný počas ukladania. Server overí, že je pripojený, netelefonuje a nie je pozastavený.
            </p>
          </div>}

          {duplicateExtension && (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">
              Jedna osobná klapka nemôže byť vo viacerých prioritách.
            </div>
          )}
          {!completePlan && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-950">
              Vyberte osobnú klapku pre všetky tri rady.
            </div>
          )}
          {!currentPlanEmpty && completePlan && fallbackOptions.length === 0 && !operation && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-950">
              Nie je dostupný žiadny nezávislý záložný operátor. Kontrolu ani uloženie preto nemožno bezpečne spustiť.
            </div>
          )}

          {!operation && (
            <p id="viptel-routing-action-help" className="mt-3 text-sm font-medium text-zinc-600">
              {routingActionHelp}
            </p>
          )}

          {!operation && currentPlanEmpty && (
            <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
              <div className="font-semibold">Prvé nastavenie poradia</div>
              <p className="mt-1 text-xs">
                Systém ho povolí iba raz, keď sú rady 601–603 úplne prázdne, všetky tri telefóny sú pripojené a neprebieha žiadny hovor. Technicky sa tento jednorazový krok nazýva bootstrap.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void requestAction("bootstrap-empty", true)}
                  disabled={!canDryRunEmptyBootstrap}
                  aria-describedby="viptel-routing-action-help"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-blue-300 bg-white px-3 text-sm font-semibold text-blue-950 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingAction === "bootstrap-empty" ? <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" /> : <ShieldCheck size={14} aria-hidden="true" />}
                  Skontrolovať prvé nastavenie
                </button>
                <button
                  type="button"
                  onClick={() => void requestAction("bootstrap-empty", false)}
                  disabled={!canApplyEmptyBootstrap}
                  aria-describedby="viptel-routing-action-help"
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
                >
                  <Play size={14} />
                  Spustiť prvé nastavenie
                </button>
                {emptyBootstrapDryRunCurrent && (
                  <div className="w-full rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-950">
                    <div className="font-semibold">
                      Overené pre verziu {routing.revision}
                      {lastDryRun?.targetRevision !== undefined ? ` → ${lastDryRun.targetRevision}` : ""}
                      {lastDryRun?.stepCount !== undefined ? ` · ${lastDryRun.stepCount} krokov` : ""}
                    </div>
                    <ol className="mt-1.5 grid gap-1">
                      {lastDryRun?.steps?.map((step, index) => (
                        <li key={`${index}-${step.action}-${step.queue}-${step.extension}`}>
                          {index + 1}. {priorityStepActionLabel(step.action)} · rad {step.queue} · klapka {step.extension}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            </div>
          )}

          {!operation && !currentPlanEmpty && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void requestAction("apply", true)}
                disabled={!canDryRunApply}
                aria-describedby="viptel-routing-action-help"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pendingAction === "apply" ? <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" /> : <ShieldCheck size={14} aria-hidden="true" />}
                Skontrolovať zmenu
              </button>
              <button
                type="button"
                onClick={() => void requestAction("apply", false)}
                disabled={!canApply}
                aria-describedby="viptel-routing-action-help"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {pendingAction === "apply" ? <Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" /> : <Play size={14} aria-hidden="true" />}
                Uložiť poradie volania
              </button>
              {applyDryRunCurrent && (
                <div className="w-full rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-950">
                  <div className="font-semibold">
                    Overené pre verziu {routing.revision}
                    {lastDryRun?.targetRevision !== undefined ? ` → ${lastDryRun.targetRevision}` : ""}
                    {lastDryRun?.stepCount !== undefined ? ` · ${lastDryRun.stepCount} krokov` : ""}
                  </div>
                  {(lastDryRun?.steps?.length ?? 0) > 0 ? (
                    <ol className="mt-1.5 grid gap-1">
                      {lastDryRun?.steps?.map((step, index) => (
                        <li key={`${index}-${step.action}-${step.queue}-${step.extension}`}>
                          {index + 1}. {priorityStepActionLabel(step.action)} · rad {step.queue} · klapka {step.extension}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="mt-1">VIPTel nevyžaduje žiadnu zmenu.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {notice && <div role="status" aria-live="polite" className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">{notice}</div>}
      {error && <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">{error}</div>}
    </div>
  );
}

function priorityDraftFromSlots(slots: PrioritySlot[]) {
  const draft: Record<PriorityQueue, string> = { "601": "", "602": "", "603": "" };
  for (const slot of slots) draft[slot.queue] = slot.extension ?? "";
  return draft;
}

function priorityFallbackKey(queue: PriorityQueue, extension: string) {
  return `${queue}:${extension}`;
}

function priorityApplyKey(revision: number, slots: PrioritySlot[], fallbackKey: string) {
  return `${revision}|${slots.map((slot) => `${slot.queue}:${slot.extension ?? ""}`).join("|")}|${fallbackKey}`;
}

function priorityEmptyBootstrapKey(revision: number, slots: PrioritySlot[]) {
  return `empty-bootstrap|${revision}|${slots.map((slot) => `${slot.queue}:${slot.extension ?? ""}`).join("|")}`;
}

function parsePriorityPreviewSteps(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      !["add", "remove", "pause", "unpause"].includes(String(record.action)) ||
      !isPriorityQueue(String(record.queue)) ||
      typeof record.extension !== "string" ||
      !/^\d{1,8}$/.test(record.extension)
    ) return [];
    return [{
      action: record.action as "add" | "remove" | "pause" | "unpause",
      queue: record.queue as PriorityQueue,
      extension: record.extension,
    }];
  });
}

function priorityStepActionLabel(action: "add" | "remove" | "pause" | "unpause") {
  if (action === "add") return "pridať";
  if (action === "remove") return "odobrať";
  if (action === "pause") return "pozastaviť";
  return "obnoviť";
}

function priorityBootstrapKey(routing: PriorityRoutingSnapshot) {
  return `${routing.revision}|${routing.catalog.queues.map((item) => `${item.queue}:${item.action}`).join("|")}`;
}

function isPriorityQueue(value: string): value is PriorityQueue {
  return value === "601" || value === "602" || value === "603";
}

function priorityGateDetail(reason: PriorityRoutingSnapshot["gate"]["reason"]) {
  if (reason === "enabled") return "Každý zápis sa ešte overí serverom tesne pred vykonaním.";
  if (reason === "preview_blocked") return "V testovacom náhľade možno údaje čítať a kontrolovať, ale nie ukladať do VIPTel.";
  if (reason === "flag_disabled") return "Prevádzkový prepínač živých zmien nie je zapnutý.";
  return "Tomuto prostrediu chýba oprávnenie na živé telekomunikačné zmeny.";
}

function priorityOperationLabel(status: PriorityRoutingOperation["status"]) {
  if (status === "degraded") return "Zmena je zastavená a vyžaduje zásah";
  if (status === "rolling_back") return "Prebieha návrat na predchádzajúce poradie";
  return "Prebieha aplikovanie nového poradia";
}

function priorityCatalogActionLabel(action: PriorityRoutingSnapshot["catalog"]["queues"][number]["action"]) {
  if (action === "insert") return "treba vytvoriť";
  if (action === "update") return "treba opraviť";
  return "bez zmeny";
}

function ViptelLineCatalogPanel({ onSummary }: { onSummary: (summary: { count: number; ready: boolean }) => void }) {
  const [state, setState] = useState<ViptelLinePlanState>({ status: "loading" });
  const [verifiedDryRunKey, setVerifiedDryRunKey] = useState<string | null>(null);
  const [pending, setPending] = useState<"dry-run" | "apply" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDryRun = useCallback(async (announce: boolean) => {
    try {
      const response = await telephonyFetch("/api/telephony/routing/lines", {
        label: "plán liniek",
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      });
      const result = await parseViptelLinePlanResponse(response);
      const key = viptelLinePlanKey(result.plan);
      setState({ status: "ready", plan: result.plan, dryRunKey: key, gate: result.gate });
      onSummary(viptelLineSummary(result.plan));
      setVerifiedDryRunKey(key);
      setError(null);
      if (announce) setNotice("Kontrola bez uloženia bola obnovená. Zatiaľ sa nič nezmenilo.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Telefónne čísla sa nepodarilo načítať.";
      onSummary({ count: 0, ready: false });
      if (caught instanceof ViptelLinePlanAccessError) {
        setState({ status: "denied", message });
      } else {
        setState((current) => (current.status === "ready" ? current : { status: "error", message }));
      }
      setError(message);
      setVerifiedDryRunKey(null);
    }
  }, [onSummary]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDryRun(false), 0);
    return () => window.clearTimeout(timer);
  }, [loadDryRun]);

  if (state.status === "loading") {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 border-t border-zinc-200 p-4 text-sm font-medium text-zinc-600">
        <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" />
        Načítavam telefónne čísla poisťovní…
      </div>
    );
  }

  if (state.status === "denied") {
    return (
      <div className="border-t border-zinc-200 p-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-950">{state.message}</div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="border-t border-zinc-200 p-4">
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-900">
          <div className="font-semibold">Prehľad verejných čísel sa nepodarilo načítať.</div>
          <div className="mt-1 text-xs">{state.message}</div>
          <button
            type="button"
            onClick={() => {
              setState({ status: "loading" });
              void loadDryRun(false);
            }}
            className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-900 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
          >
            <RefreshCw size={13} />
            Skúsiť znova
          </button>
        </div>
      </div>
    );
  }

  const conflicts = state.plan.filter((item) => item.action === "conflict");
  const changes = state.plan.filter((item) => item.action === "insert" || item.action === "update");
  const dryRunCurrent = verifiedDryRunKey === state.dryRunKey;

  async function applyCatalog() {
    if (pending || !dryRunCurrent || conflicts.length > 0 || changes.length === 0) return;
    setPending("apply");
    setVerifiedDryRunKey(null);
    setNotice(null);
    setError(null);

    try {
      const response = await telephonyFetch("/api/telephony/routing/lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
        label: "uloženie plánu liniek",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      await parseViptelLinePlanResponse(response);

      const confirmationResponse = await telephonyFetch("/api/telephony/routing/lines", {
        label: "overenie plánu liniek",
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      });
      const confirmation = await parseViptelLinePlanResponse(confirmationResponse);
      const confirmedKey = viptelLinePlanKey(confirmation.plan);
      setState({ status: "ready", plan: confirmation.plan, dryRunKey: confirmedKey, gate: confirmation.gate });
      onSummary(viptelLineSummary(confirmation.plan));
      setVerifiedDryRunKey(confirmedKey);
      if (confirmation.plan.every((item) => item.action === "noop")) {
        setNotice("Následná kontrola potvrdila, že telefónne čísla sú aktuálne.");
      } else {
        setError("Uloženie bolo prijaté, ale následná kontrola ešte vidí rozdiel. Pred ďalším pokusom skontrolujte plán.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Telefónne čísla sa nepodarilo uložiť.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="min-w-0 border-t border-zinc-200 p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-950">
            <PhoneCall size={18} aria-hidden="true" />
            Telefónne čísla poisťovní
          </h3>
          <p className="mt-1 text-sm text-zinc-600">Podľa čísla, na ktoré klient zavolá, aplikácia rozpozná príslušnú poisťovňu.</p>
        </div>
        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-700">{state.plan.length} čísel</span>
      </div>

      <div className="grid min-w-0 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {state.plan.map((item) => (
          <div key={item.phoneNumber} className={`min-w-0 max-w-full rounded-md border px-3 py-2 ${item.action === "conflict" ? "border-red-200 bg-red-50" : "border-zinc-200 bg-zinc-50"}`}>
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-words text-xs font-semibold leading-4 text-zinc-950">{item.label}</div>
                <div className="mt-1 inline-flex min-h-5 items-center rounded bg-white px-1.5 py-0.5 text-xs font-semibold leading-4 text-zinc-700 tabular-nums">
                  {item.phoneNumber}
                </div>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${viptelLineActionTone(item.action)}`}>
                {viptelLineActionLabel(item.action)}
              </span>
            </div>
            <div className="mt-1 break-words text-xs text-zinc-500">{viptelLinePurposeLabel(item.purpose)}</div>
            {item.reason && <div className="mt-1 break-words text-xs font-medium text-red-900">{item.reason}</div>}
          </div>
        ))}
      </div>

      {!state.gate.enabled && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-950">
          Ukladanie telefónnych čísel je zablokované: {priorityGateDetail(state.gate.reason)}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (pending) return;
            setPending("dry-run");
            setNotice(null);
            void loadDryRun(true).finally(() => setPending(null));
          }}
          disabled={pending !== null}
          aria-describedby="viptel-line-action-help"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:opacity-50"
        >
          {pending === "dry-run" ? <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" /> : <ShieldCheck size={13} aria-hidden="true" />}
          Skontrolovať čísla
        </button>
        <button
          type="button"
          onClick={() => void applyCatalog()}
          disabled={pending !== null || !state.gate.enabled || !dryRunCurrent || conflicts.length > 0 || changes.length === 0}
          aria-describedby="viptel-line-action-help"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:bg-zinc-300 disabled:text-zinc-600"
        >
          {pending === "apply" ? <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" /> : <Save size={13} aria-hidden="true" />}
          Uložiť telefónne čísla
        </button>
        <span id="viptel-line-action-help" className="text-xs text-zinc-600">
          {conflicts.length > 0
            ? `${conflicts.length} konfliktov blokuje zápis`
            : changes.length > 0
              ? `${changes.length} zmien čaká na explicitné potvrdenie`
              : "Telefónne čísla nevyžadujú žiadnu zmenu"}
        </span>
      </div>

      {notice && <div role="status" aria-live="polite" className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">{notice}</div>}
      {error && <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">{error}</div>}
    </div>
  );
}

class ViptelLinePlanAccessError extends Error {}

async function parseViptelLinePlanResponse(response: Response) {
  const result = (await response.json().catch(() => null)) as {
    applied?: boolean;
    error?: string;
    ok?: boolean;
    plan?: ViptelLinePlanItem[];
    gate?: PriorityRoutingSnapshot["gate"];
  } | null;
  if (response.status === 401 || response.status === 403) {
    throw new ViptelLinePlanAccessError(result?.error ?? "Na správu verejných čísel nemáte oprávnenie.");
  }
  if (!response.ok || !result?.ok || !Array.isArray(result.plan) || !result.gate) {
    throw new Error(result?.error ?? "Telefónne čísla sa nepodarilo načítať.");
  }
  return { applied: result.applied === true, plan: result.plan, gate: result.gate };
}

function viptelLinePlanKey(plan: ViptelLinePlanItem[]) {
  return plan.map((item) => `${item.phoneNumber}:${item.action}:${item.label}:${item.reason ?? ""}`).join("|");
}

function viptelLineSummary(plan: ViptelLinePlanItem[]) {
  return {
    count: plan.length,
    ready: plan.length >= 7 && plan.every((item) => item.action === "noop"),
  };
}

function viptelLineActionLabel(action: ViptelLinePlanItem["action"]) {
  if (action === "insert") return "vytvoriť";
  if (action === "update") return "upraviť";
  if (action === "conflict") return "konflikt";
  return "aktuálne";
}

function viptelLineActionTone(action: ViptelLinePlanItem["action"]) {
  if (action === "conflict") return "bg-red-100 text-red-800";
  if (action === "insert" || action === "update") return "bg-amber-100 text-amber-800";
  return "bg-emerald-100 text-emerald-800";
}

function viptelLinePurposeLabel(purpose: ViptelLinePlanItem["purpose"]) {
  if (purpose === "neutral") return "Neutrálne / predvolené odchádzajúce číslo";
  if (purpose === "reserve") return "Rezervné číslo";
  return "Vstupná linka poisťovne";
}

function BranchForm({ branches, onSaved }: { branches: Branch[]; onSaved: (dispatchData: DispatchData) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [availableReplacementCars, setAvailableReplacementCars] = useState(0);
  const [location, setLocation] = useState<PlaceSelectionInput | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = useReplacementVehicleAvailability();

  async function saveBranch() {
    if (!name.trim() || !location || isSaving) return;
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, availableReplacementCars, location }),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Pobočku sa nepodarilo uložiť.");
      }

      setName("");
      setPhone("");
      setAvailableReplacementCars(0);
      setLocation(null);
      onSaved(result.dispatchData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Pobočku sa nepodarilo uložiť.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white">
      <SettingsSectionHeader icon={MapPinned} title="Pobočky" description="Adresy, kontakty a kapacita náhradných vozidiel." />
      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)]">
        <div>
          <h3 className="mb-3 text-sm font-semibold text-zinc-950">Nová pobočka</h3>
          <div className="grid gap-3">
            <TextField label="Názov" value={name} onChange={setName} />
            <TextField label="Telefón" type="tel" value={phone} onChange={setPhone} />
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">Náhradné vozidlá</span>
              <input
                type="number"
                min={0}
                value={availableReplacementCars}
                onChange={(event) => setAvailableReplacementCars(Math.max(0, Number(event.target.value)))}
                className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
              />
            </label>
            <GooglePlaceAutocomplete label="Adresa pobočky" value={location} onSelect={setLocation} />
            {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">{error}</div>}
            <button
              type="button"
              onClick={() => void saveBranch()}
              disabled={!name.trim() || !location || isSaving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Uložiť pobočku
            </button>
          </div>
        </div>

        <div className="min-w-0 border-t border-zinc-200 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-zinc-950">Uložené pobočky</h3>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">{branches.length}</span>
          </div>
          <div className="grid gap-2">
            {branches.map((branch) => {
              const live = availability.byBranch[branch.id];
              const isLive = availability.source === "swhouse" && live != null;
              const count = isLive ? live : branch.availableReplacementCars;
              return (
                <MiniRow
                  key={branch.id}
                  icon={Building2}
                  title={branch.name}
                  detail={`${branch.address} · ${count} NV${isLive ? " · live" : ""}`}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

type PartnerEntryDraft = {
  name: string;
  ico: string;
  phone: string;
  email: string;
  note: string;
};

function PartnerDirectoryForm({ entries, onSaved }: { entries: PartnerDirectoryEntry[]; onSaved: (dispatchData: DispatchData) => void }) {
  const [kind, setKind] = useState<PartnerDirectoryKind>("assistance");
  const [name, setName] = useState("");
  const [ico, setIco] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [entryDraft, setEntryDraft] = useState<PartnerEntryDraft | null>(null);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveEntry() {
    if (!name.trim() || isSaving) return;
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/partner-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ico, kind, name, note, phone }),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Záznam adresára sa nepodarilo uložiť.");
      }

      setName("");
      setIco("");
      setPhone("");
      setEmail("");
      setNote("");
      onSaved(result.dispatchData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Záznam adresára sa nepodarilo uložiť.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteEntry(entryId: string) {
    if (pendingDeleteId) return;
    setPendingDeleteId(entryId);
    setError(null);

    try {
      const response = await fetch(`/api/partner-directory/${entryId}`, { method: "DELETE" });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Záznam adresára sa nepodarilo deaktivovať.");
      }

      onSaved(result.dispatchData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Záznam adresára sa nepodarilo deaktivovať.");
    } finally {
      setPendingDeleteId(null);
    }
  }

  async function patchEntry(entryId: string, payload: Record<string, unknown>, failureMessage: string) {
    if (pendingEntryId) return false;
    setPendingEntryId(entryId);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/partner-directory/${entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as ApiMutationResponse;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? failureMessage);
      }

      onSaved(result.dispatchData);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failureMessage);
      return false;
    } finally {
      setPendingEntryId(null);
    }
  }

  function startEntryEdit(entry: PartnerDirectoryEntry) {
    setEditingEntryId(entry.id);
    setEntryDraft({
      name: entry.name,
      ico: entry.ico ?? "",
      phone: entry.phone ?? "",
      email: entry.email ?? "",
      note: entry.note ?? "",
    });
    setError(null);
    setNotice(null);
  }

  async function saveEntryEdit(entryId: string) {
    if (!entryDraft || !entryDraft.name.trim()) {
      setError("Záznam adresára potrebuje názov.");
      return;
    }

    const saved = await patchEntry(entryId, entryDraft, "Záznam adresára sa nepodarilo upraviť.");

    if (saved) {
      setEditingEntryId(null);
      setEntryDraft(null);
      setNotice("Záznam adresára upravený.");
    }
  }

  async function reactivateEntry(entryId: string) {
    const saved = await patchEntry(entryId, { active: true }, "Záznam adresára sa nepodarilo reaktivovať.");

    if (saved) {
      setNotice("Záznam adresára je znova aktívny.");
    }
  }

  async function backfillFromCases() {
    if (isBackfilling) return;
    setIsBackfilling(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/partner-directory/backfill-assistance", { method: "POST" });
      const result = (await response.json()) as ApiMutationResponse & { created?: string[] };

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Asistenčné služby sa nepodarilo prevziať z prípadov.");
      }

      onSaved(result.dispatchData);
      setNotice(
        result.created && result.created.length > 0
          ? `Prevzaté z prípadov: ${result.created.join(", ")}.`
          : "Všetky asistenčné služby z prípadov už v adresári sú.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Asistenčné služby sa nepodarilo prevziať z prípadov.");
    } finally {
      setIsBackfilling(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white">
      <SettingsSectionHeader icon={Building2} title="Firmy a asistenčné služby" description="Kontakty, ktoré zamestnanci používajú pri práci s prípadmi." />
      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)]">
        <div>
          <h3 className="mb-3 text-sm font-semibold text-zinc-950">Nový kontakt</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <SelectField
                label="Typ záznamu"
                value={kind}
                onChange={(value) => setKind(value as PartnerDirectoryKind)}
                options={(['assistance', 'company'] as const).map((value) => [value, partnerDirectoryKindLabels[value]])}
              />
            </div>
            <div className="sm:col-span-2"><TextField label="Názov" value={name} onChange={setName} /></div>
            <TextField label="IČO" value={ico} onChange={setIco} />
            <TextField label="Telefón" type="tel" value={phone} onChange={setPhone} />
            <div className="sm:col-span-2"><TextField label="Email" type="email" value={email} onChange={setEmail} /></div>
            <div className="sm:col-span-2"><TextField label="Poznámka" value={note} onChange={setNote} /></div>
            {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 sm:col-span-2">{error}</div>}
            <button
              type="button"
              onClick={() => void saveEntry()}
              disabled={!name.trim() || isSaving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600 sm:col-span-2"
            >
              {isSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Uložiť kontakt
            </button>
          </div>
        </div>

        <div className="min-w-0 border-t border-zinc-200 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-zinc-950">Uložené kontakty</h3>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">{entries.length}</span>
            </div>
            <button
              type="button"
              onClick={() => void backfillFromCases()}
              disabled={isBackfilling}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-60"
              title="Nájde asistenčné služby použité v prípadoch, ktoré v adresári chýbajú, a založí ich"
            >
              {isBackfilling ? <Loader2 size={13} className="animate-spin" /> : <FolderDown size={13} />}
              Prevziať asistenčky z prípadov
            </button>
          </div>
          {notice && <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">{notice}</div>}
          <div className="grid gap-2">
            {entries.length > 0 ? (
              entries.map((entry) => {
                const busy = pendingEntryId === entry.id || pendingDeleteId === entry.id;

                if (editingEntryId === entry.id && entryDraft) {
                  return (
                    <div key={entry.id} className="grid gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="sm:col-span-2"><TextField label="Názov" value={entryDraft.name} onChange={(value) => setEntryDraft((current) => (current ? { ...current, name: value } : current))} /></div>
                        <TextField label="IČO" value={entryDraft.ico} onChange={(value) => setEntryDraft((current) => (current ? { ...current, ico: value } : current))} />
                        <TextField label="Telefón" type="tel" value={entryDraft.phone} onChange={(value) => setEntryDraft((current) => (current ? { ...current, phone: value } : current))} />
                        <TextField label="Email" type="email" value={entryDraft.email} onChange={(value) => setEntryDraft((current) => (current ? { ...current, email: value } : current))} />
                        <TextField label="Poznámka" value={entryDraft.note} onChange={(value) => setEntryDraft((current) => (current ? { ...current, note: value } : current))} />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => { setEditingEntryId(null); setEntryDraft(null); }}
                          disabled={busy}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          <X size={13} />
                          Zrušiť
                        </button>
                        <button
                          type="button"
                          onClick={() => void saveEntryEdit(entry.id)}
                          disabled={busy || !entryDraft.name.trim()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300 disabled:text-zinc-600"
                        >
                          {pendingEntryId === entry.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                          Uložiť
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={entry.id} className="flex items-start justify-between gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-zinc-900">{entry.name}</span>
                      <span className="block truncate">
                        {partnerDirectoryKindLabels[entry.kind]}{entry.ico ? ` · IČO ${entry.ico}` : ""}{entry.phone ? ` · ${entry.phone}` : ""}{entry.active ? "" : " · neaktívne"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEntryEdit(entry)}
                        disabled={busy}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Upraviť záznam ${entry.name}`}
                        title="Upraviť záznam"
                      >
                        <Edit3 size={14} />
                      </button>
                      {entry.active ? (
                        <button
                          type="button"
                          onClick={() => void deleteEntry(entry.id)}
                          disabled={busy}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Deaktivovať záznam ${entry.name}`}
                          title="Deaktivovať záznam"
                        >
                          {pendingDeleteId === entry.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void reactivateEntry(entry.id)}
                          disabled={busy}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Reaktivovať záznam ${entry.name}`}
                          title="Reaktivovať záznam"
                        >
                          {pendingEntryId === entry.id ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-md bg-zinc-50 px-3 py-3 text-xs font-medium text-zinc-500">Adresár je zatiaľ prázdny.</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SettingsSectionHeader({ description, icon: Icon, title }: { description: string; icon: LucideIcon; title: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-yellow-200 bg-yellow-50 px-4 py-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#FCD703] text-zinc-950">
        <Icon size={20} />
      </div>
      <div>
        <h2 className="text-base font-semibold text-zinc-950">{title}</h2>
        <p className="mt-0.5 text-sm text-zinc-600">{description}</p>
      </div>
    </div>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: "ok" | "bad" }) {
  const className = tone === "ok" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800";
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${className}`}>{label}</span>;
}

function SelectField({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<readonly [string, string]>;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium outline-none ring-yellow-300 transition focus:ring-2"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function TextField({ label, onChange, type = "text", value }: { label: string; onChange: (value: string) => void; type?: "text" | "email" | "tel"; value: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2"
      />
    </label>
  );
}

function MiniRow({ detail, icon: Icon, title }: { detail: string; icon: LucideIcon; title: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
      <Icon size={14} className="mt-0.5 shrink-0 text-zinc-500" />
      <span className="min-w-0">
        <span className="block truncate font-semibold text-zinc-900">{title}</span>
        <span className="block truncate">{detail}</span>
      </span>
    </div>
  );
}

function forwardingLabel(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "false" || normalized === "off" || normalized === "0" ? "vypnuté" : value;
}
