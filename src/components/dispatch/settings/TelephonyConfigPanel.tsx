"use client";

import { useCallback, useEffect, useState } from "react";
import { ListOrdered, Loader2, PhoneCall, RefreshCw, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { configErrorMessage, loadRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { RingGroupsEditor } from "./RingGroupsEditor";
import { RingPlanEditor } from "./RingPlanEditor";
import { SettingsNotice, SettingsSectionHeader } from "./settings-ui";

/**
 * "Telefonovanie" section of the settings view (plan "Fáza 3").
 *
 * The whole routing document arrives in one request because the editors
 * cross-reference each other, and every editor hands the freshly saved document
 * back so the neighbouring screens see the new world without a reload.
 */

type TelephonyConfigTab = "groups" | "plans";

const TABS: Array<{ icon: LucideIcon; label: string; value: TelephonyConfigTab }> = [
  { icon: Users, label: "Skupiny", value: "groups" },
  { icon: ListOrdered, label: "Plány zvonenia", value: "plans" },
];

export function TelephonyConfigPanel() {
  const [tab, setTab] = useState<TelephonyConfigTab>("groups");
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
        {TABS.map(({ icon: Icon, label, value }) => {
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

      {tab === "groups" && <RingGroupsEditor key={`groups-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
      {tab === "plans" && <RingPlanEditor key={`plans-${version}`} canEdit={state.canEdit} document={state.document} onSaved={applyResponse} />}
    </div>
  );
}
