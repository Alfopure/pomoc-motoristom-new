"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, CalendarClock, Coffee, Hash, ListOrdered, ListTree, Loader2, PhoneCall, RefreshCw, ShieldAlert, Smartphone, Sparkles, Users, UserCog } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { TelephonySettingsDoc } from "@/server/telephony/config-service";

import type { DraftEditorState } from "../useDraftEditors";
import type { RoutingNavigationTarget } from "@/lib/telephony/routing-summary";
import { RoutingUnsavedDialog } from "./RoutingUnsavedDialog";
import { IncomingRoutingEditor, type IncomingEditorActions } from "./IncomingRoutingEditor";
import { MyPhonePanel, type MyPhoneTestCall } from "../MyPhonePanel";
import { AiTab } from "./AiTab";
import { AnnouncementsPanel } from "./AnnouncementsPanel";
import { BusinessHoursEditor } from "./BusinessHoursEditor";
import { IvrMenuEditor } from "./IvrMenuEditor";
import { NumbersPanel } from "./NumbersPanel";
import { OperatorsTelephonyPanel } from "./OperatorsTelephonyPanel";
import { PauseReasonsEditor } from "./PauseReasonsEditor";
import { ConfigRequestError, configErrorMessage, loadRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { RingGroupsEditor } from "./RingGroupsEditor";
import { RingPlanEditor } from "./RingPlanEditor";
import { SettingsNotice, SettingsSectionHeader } from "./settings-ui";
import { TelephonySettingsPanel } from "./TelephonySettingsPanel";
import { RecordingPolicyPanel } from "./RecordingPolicyPanel";

/**
 * "Telefonovanie" section of the settings view (plan "Fáza 3").
 *
 * The whole routing document arrives in one request because the editors
 * cross-reference each other, and every editor hands the freshly saved document
 * back so the neighbouring screens see the new world without a reload.
 */

type TelephonyConfigTab = "incoming" | "phone" | "groups" | "plans" | "ivr" | "announcements" | "hours" | "pauses" | "numbers" | "operators" | "recording" | "settings" | "ai";

const GUIDE_CHAPTERS: Record<TelephonyConfigTab, string> = {
  incoming: "plany-zvonenia", phone: "moj-telefon", groups: "skupiny-zvonenia", plans: "plany-zvonenia",
  ivr: "cisla-hodiny-a-ivr", announcements: "hlasky-a-nahravanie", hours: "cisla-hodiny-a-ivr",
  pauses: "pauza-a-zastupovanie", numbers: "cisla-hodiny-a-ivr", operators: "moj-telefon",
  recording: "hlasky-a-nahravanie", settings: "riesenie-problemov", ai: "riesenie-problemov",
};

const TABS: Array<{ icon: LucideIcon; label: string; value: TelephonyConfigTab; adminOnly?: boolean; managerOnly?: boolean; requiresAiDemo?: boolean }> = [
  // "Môj telefón" is first and open to every operator; everything after it is
  // configuration a manager owns.
  { icon: Smartphone, label: "Môj telefón", value: "phone" },
  { icon: ListOrdered, label: "Prichádzajúce hovory", value: "incoming" },
  { icon: Users, label: "Skupiny", value: "groups" },
  { icon: ListOrdered, label: "Plány zvonenia", value: "plans" },
  { icon: ListTree, label: "IVR menu", value: "ivr" },
  { icon: AudioLines, label: "Hlášky a jazyk", value: "announcements" },
  { icon: AudioLines, label: "Nahrávanie a kvalita", value: "recording", managerOnly: true },
  { icon: CalendarClock, label: "Otváracie hodiny", value: "hours" },
  { icon: Coffee, label: "Dôvody pauzy", value: "pauses" },
  { icon: Hash, label: "Čísla", value: "numbers" },
  { icon: UserCog, label: "Operátori", value: "operators", managerOnly: true },
  { icon: ShieldAlert, label: "Bezpečnosť", value: "settings", adminOnly: true },
  // Absent unless the deployment actually has the demo configured; every
  // `ai-demo` route re-checks the same switch server-side.
  { icon: Sparkles, label: "AI", value: "ai", adminOnly: true, requiresAiDemo: true },
];

export function TelephonyConfigPanel({ onTestCall, routingTarget, onRoutingDirtyChange, onRoutingEditorStateChange }: { onTestCall?: MyPhoneTestCall; routingTarget?: RoutingNavigationTarget | null; onRoutingDirtyChange?: (dirty: boolean) => void; onRoutingEditorStateChange?: (state: DraftEditorState | null) => void } = {}) {
  const [tab, setTab] = useState<TelephonyConfigTab>(routingTarget?.tab ?? "phone");
  const [focusPlanId, setFocusPlanId] = useState<string | null>(routingTarget?.planId ?? null);
  const [target, setTarget] = useState(routingTarget);
  const [coherent, setCoherent] = useState<boolean | null>(null);
  const [routingDirty, setRoutingDirty] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<{ tab: TelephonyConfigTab; target?: RoutingNavigationTarget } | null>(null);
  const actions = useRef<IncomingEditorActions | null>(null);
  const actionsChanged = useCallback((value: IncomingEditorActions | null) => { actions.current = value; }, []);
  const dirtyChanged = useCallback((dirty: boolean) => { setRoutingDirty(dirty); onRoutingDirtyChange?.(dirty); }, [onRoutingDirtyChange]);
  const [previousRoutingTarget, setPreviousRoutingTarget] = useState(routingTarget);
  if (routingTarget !== previousRoutingTarget) {
    setPreviousRoutingTarget(routingTarget);
    if (routingTarget) { setTarget(routingTarget); setFocusPlanId(routingTarget.planId ?? null); setTab(routingTarget.tab === "incoming" && coherent === false ? "plans" : routingTarget.tab); }
  }
  const [announcementsOpened, setAnnouncementsOpened] = useState(false);
  const [state, setState] = useState<RoutingConfigResponse | null>(null);
  // Bumped on every fresh document so the editors re-key and drop their drafts
  // instead of synchronising them from an effect.
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Reload is a token, not a call: setState must not run synchronously inside an
  // effect (React 19 lint), so the request lives in the effect and "Skúsiť
  // znova" only bumps the token.
  const [reloadToken, setReloadToken] = useState(0);

  const applyResponse = useCallback((response: RoutingConfigResponse) => {
    setState(response);
    setVersion((current) => current + 1);
  }, []);

  // The settings route answers with the saved row only (it is admin-only and
  // never widens its response), so its result is merged into the document the
  // panel already holds.
  const applySettings = useCallback((settings: TelephonySettingsDoc) => {
    setState((current) => (current ? { ...current, document: { ...current.document, settings, snapshotId: undefined } } : current));
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadRoutingConfig("incoming", { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setCoherent(true); return response; })
      .catch((caught: unknown) => {
        if (!(caught instanceof ConfigRequestError) || caught.code !== "config_snapshot_missing") throw caught;
        if (!controller.signal.aborted) { setCoherent(false); setTab(current => current === "incoming" ? "plans" : current); }
        return loadRoutingConfig("ringGroups", { signal: controller.signal });
      })
      .then((response) => {
        if (controller.signal.aborted) return;
        applyResponse(response);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(configErrorMessage(caught, "Nastavenia telefónie sa nepodarilo načítať."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applyResponse, reloadToken]);

  async function navigate(next: TelephonyConfigTab, nextTarget?: RoutingNavigationTarget, confirmed = false) {
    if (routingDirty && !confirmed && next !== tab) { setPendingTarget({ tab: next, target: nextTarget }); return; }
    if (next === "incoming" && coherent && !state?.document.snapshotId) {
      try { applyResponse(await loadRoutingConfig("incoming")); } catch (caught) { setError(configErrorMessage(caught, "Nastavenie sa nepodarilo overiť.")); return; }
    }
    if (next === "announcements") setAnnouncementsOpened(true);
    if (nextTarget) { setTarget(nextTarget); setFocusPlanId(nextTarget.planId ?? null); }
    setTab(next === "incoming" && !coherent ? "plans" : next);
  }
  useEffect(() => {
    if (tab !== "incoming" || coherent !== true || !state || state.document.snapshotId) return;
    const controller = new AbortController();
    loadRoutingConfig("incoming", { signal: controller.signal }).then(response => { if (!controller.signal.aborted) applyResponse(response); }).catch(caught => { if (!controller.signal.aborted) setError(configErrorMessage(caught, "Nastavenie sa nepodarilo overiť.")); });
    return () => controller.abort();
  }, [tab, coherent, state, applyResponse]);
  useEffect(() => {
    if (!state || !target) return;
    const id = tab === "numbers" ? target.lineId : tab === "ivr" ? target.ivrMenuId : tab === "hours" ? target.businessHoursId : null;
    if (!id) return;
    const frame = requestAnimationFrame(() => { const element = window.document.getElementById(`routing-${tab}-${id}`); element?.scrollIntoView({ block: "center" }); element?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [state, target, tab]);

  if (loading && !state) {
    return (
      <section className="rounded-md border border-zinc-200 bg-white">
        <SettingsSectionHeader icon={PhoneCall} title="Telefonovanie" description="Skupiny, plány zvonenia, linky a operátori." />
        <div className="flex items-center gap-2 p-4 text-sm text-zinc-600">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Načítavam nastavenia telefónie…
        </div>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="rounded-md border border-zinc-200 bg-white">
        <SettingsSectionHeader icon={PhoneCall} title="Telefonovanie" description="Skupiny, plány zvonenia, linky a operátori." />
        <div className="grid gap-3 p-4">
          <SettingsNotice tone="error">{error ?? "Nastavenia telefónie sa nepodarilo načítať."}</SettingsNotice>
          <div>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setReloadToken((current) => current + 1);
              }}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100"
            >
              <RefreshCw size={15} aria-hidden="true" />
              Skúsiť znova
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[190px_minmax(0,1fr)]">
      <div className="min-w-0 lg:col-start-2">
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <a href={`/navod/${GUIDE_CHAPTERS[tab]}`} target="_blank" rel="noopener noreferrer" className="justify-self-end rounded-md px-2 py-2 text-sm font-semibold text-zinc-600 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-950">
        Návod k tejto časti <span className="sr-only">(otvorí sa v novej karte)</span>
      </a>
      </div>

      <nav className="flex flex-wrap content-start gap-1 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:flex-col" aria-label="Nastavenia telefónie">
        {TABS.filter((entry) => (coherent ? entry.value !== "groups" && entry.value !== "plans" : entry.value !== "incoming") && (!entry.adminOnly || state.canManageSettings) && (!entry.managerOnly || state.canEdit) && (!entry.requiresAiDemo || state.aiDemoEnabled)).map(({ icon: Icon, label, value }) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => void navigate(value)}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-left text-[13px] font-medium transition-colors ${
                active ? "border-zinc-200 bg-white text-zinc-950 shadow-sm" : "border-transparent bg-transparent text-zinc-600 hover:bg-white/70"
              }`}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>
      <div className="grid min-w-0 gap-3 lg:col-start-2">
      {pendingTarget && <RoutingUnsavedDialog onCancel={() => setPendingTarget(null)} onSave={async () => { const next = pendingTarget; const saved = await actions.current?.save(); setPendingTarget(null); if (saved) await navigate(next.tab, next.target, true); }} onDiscard={() => { actions.current?.discard(); const next = pendingTarget; setPendingTarget(null); void navigate(next.tab, next.target, true); }} />}

      {target?.lineId && !state.document.lines.some(line => line.id === target.lineId) && <SettingsNotice tone="warning">Vybraná linka už neexistuje alebo k nej nemáš prístup.</SettingsNotice>}
      {tab === "incoming" && coherent && !state.document.snapshotId && <SettingsNotice tone="info">Overujem aktuálne nastavenie skupín a plánov…</SettingsNotice>}
      {tab === "incoming" && coherent && state.document.snapshotId && <IncomingRoutingEditor document={state.document} canEdit={state.canEdit} target={target} onSaved={applyResponse} onNavigate={next => void navigate(next.tab, next)} onDirtyChange={dirtyChanged} onActionsChange={actionsChanged} onEditorStateChange={onRoutingEditorStateChange} />}
      {tab === "phone" && <MyPhonePanel key={`phone-${version}`} document={state.document} onSaved={applyResponse} onTestCall={onTestCall} />}
      {tab === "groups" && (
        <RingGroupsEditor
          key={`groups-${version}`}
          canEdit={state.canEdit}
          document={state.document}
          onNavigateToPlan={(planId) => {
            setFocusPlanId(planId);
            setTab("plans");
          }}
          onSaved={applyResponse}
        />
      )}
      {tab === "plans" && (
        <RingPlanEditor
          key={`plans-${version}`}
          canEdit={state.canEdit}
          document={state.document}
          focusPlanId={focusPlanId}
          onNavigateToIvr={() => setTab("ivr")}
          onNavigateToNumbers={() => setTab("numbers")}
          onSaved={applyResponse}
        />
      )}
      {tab === "ivr" && <IvrMenuEditor key={`ivr-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {announcementsOpened && (
        <div hidden={tab !== "announcements"}>
          <AnnouncementsPanel active={tab === "announcements"} />
        </div>
      )}
      {tab === "recording" && state.canEdit && <RecordingPolicyPanel onOpenAnnouncements={() => { setAnnouncementsOpened(true); setTab("announcements"); }} />}
      {tab === "hours" && <BusinessHoursEditor key={`hours-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "pauses" && <PauseReasonsEditor key={`pauses-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "numbers" && <NumbersPanel key={`numbers-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "operators" && state.canEdit && (
        <OperatorsTelephonyPanel key={`operators-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />
      )}
      {tab === "ai" && state.canManageSettings && state.aiDemoEnabled && <AiTab onNavigateToSettings={() => setTab("settings")} />}
      {tab === "settings" && state.canManageSettings && state.document.settings && (
        <TelephonySettingsPanel
          key={`settings-${version}`}
          canEdit={state.canManageSettings}
          document={state.document}
          settings={state.document.settings}
          onSaved={applySettings}
        />
      )}
      </div>
    </div>
  );
}
