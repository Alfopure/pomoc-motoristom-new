"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Coffee, Hash, ListOrdered, Loader2, PhoneCall, RefreshCw, ShieldAlert, Smartphone, Users, UserCog } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { TelephonySettingsDoc } from "@/server/telephony/config-service";

import { MyPhonePanel, type MyPhoneTestCall } from "../MyPhonePanel";
import { BusinessHoursEditor } from "./BusinessHoursEditor";
import { NumbersPanel } from "./NumbersPanel";
import { OperatorsTelephonyPanel } from "./OperatorsTelephonyPanel";
import { PauseReasonsEditor } from "./PauseReasonsEditor";
import { configErrorMessage, loadRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { RingGroupsEditor } from "./RingGroupsEditor";
import { RingPlanEditor } from "./RingPlanEditor";
import { SettingsNotice, SettingsSectionHeader } from "./settings-ui";
import { TelephonySettingsPanel } from "./TelephonySettingsPanel";

/**
 * "Telefonovanie" section of the settings view (plan "Fáza 3").
 *
 * The whole routing document arrives in one request because the editors
 * cross-reference each other, and every editor hands the freshly saved document
 * back so the neighbouring screens see the new world without a reload.
 */

type TelephonyConfigTab = "phone" | "groups" | "plans" | "hours" | "pauses" | "numbers" | "operators" | "settings";

const TABS: Array<{ icon: LucideIcon; label: string; value: TelephonyConfigTab; adminOnly?: boolean; managerOnly?: boolean }> = [
  // "Môj telefón" is first and open to every operator; everything after it is
  // configuration a manager owns.
  { icon: Smartphone, label: "Môj telefón", value: "phone" },
  { icon: Users, label: "Skupiny", value: "groups" },
  { icon: ListOrdered, label: "Plány zvonenia", value: "plans" },
  { icon: CalendarClock, label: "Otváracie hodiny", value: "hours" },
  { icon: Coffee, label: "Dôvody pauzy", value: "pauses" },
  { icon: Hash, label: "Čísla", value: "numbers" },
  { icon: UserCog, label: "Operátori", value: "operators", managerOnly: true },
  { icon: ShieldAlert, label: "Bezpečnosť", value: "settings", adminOnly: true },
];

export function TelephonyConfigPanel({ onTestCall }: { onTestCall?: MyPhoneTestCall } = {}) {
  const [tab, setTab] = useState<TelephonyConfigTab>("phone");
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
    setState((current) => (current ? { ...current, document: { ...current.document, settings } } : current));
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadRoutingConfig("ringGroups", { signal: controller.signal })
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
    <div className="grid gap-3">
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <nav className="flex flex-wrap gap-2" aria-label="Nastavenia telefónie">
        {TABS.filter((entry) => (!entry.adminOnly || state.canManageSettings) && (!entry.managerOnly || state.canEdit)).map(({ icon: Icon, label, value }) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              aria-current={active ? "page" : undefined}
              className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors ${
                active ? "border-yellow-400 bg-[#FCD703] text-zinc-950" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      {tab === "phone" && <MyPhonePanel key={`phone-${version}`} document={state.document} onSaved={applyResponse} onTestCall={onTestCall} />}
      {tab === "groups" && <RingGroupsEditor key={`groups-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "plans" && <RingPlanEditor key={`plans-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "hours" && <BusinessHoursEditor key={`hours-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "pauses" && <PauseReasonsEditor key={`pauses-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "numbers" && <NumbersPanel key={`numbers-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "operators" && state.canEdit && (
        <OperatorsTelephonyPanel key={`operators-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />
      )}
      {tab === "settings" && state.canManageSettings && state.document.settings && (
        <TelephonySettingsPanel key={`settings-${version}`} canEdit={state.canManageSettings} settings={state.document.settings} onSaved={applySettings} />
      )}
    </div>
  );
}
