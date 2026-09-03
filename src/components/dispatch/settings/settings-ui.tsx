"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useSyncExternalStore } from "react";
import { AlertTriangle } from "lucide-react";

import type { ValidationIssue } from "@/server/telephony/config-service";

/**
 * Small presentational pieces shared by the settings screens. They exist so the
 * telephony editors look like the rest of `IntegrationSettings.tsx` (yellow
 * section header, zinc cards, 10-tall inputs) instead of inventing a second
 * visual language.
 */

/**
 * Wall clock bucketed to `bucketMs`, `null` on the server.
 *
 * The business-hours preview needs "what time is it now" and the wrap-up
 * countdown needs it every second, but a clock read during render would differ
 * between the server pass and hydration. An external store solves exactly that:
 * the snapshot is the bucket index (stable inside a bucket, so no render loop)
 * and the server snapshot is `0`, which the callers read as "no clock yet".
 */
export function useTickingClock(bucketMs: number): Date | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      // Poll faster than the bucket so a change is at most a quarter of a
      // minute late; the snapshot itself is still bucketed, so a re-render only
      // happens when the value the caller reads actually changed.
      const timer = window.setInterval(onStoreChange, Math.min(bucketMs, 15_000));
      return () => window.clearInterval(timer);
    },
    [bucketMs],
  );
  const bucket = useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / bucketMs),
    () => 0,
  );
  return bucket === 0 ? null : new Date(bucket * bucketMs);
}

export function useMinuteClock(): Date | null {
  return useTickingClock(60_000);
}

/** Same store at one-second resolution, for the wrap-up countdown. */
export function useSecondClock(): Date | null {
  return useTickingClock(1_000);
}

export function SettingsSectionHeader({ description, icon: Icon, title }: { description: string; icon: LucideIcon; title: string }) {
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

export function SettingsField({ children, hint, label }: { children: ReactNode; hint?: string; label: string }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-normal text-zinc-500">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export const settingsInputClass =
  "h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none ring-yellow-300 transition focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500";

export function SettingsIssueList({ issues }: { issues: readonly ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-2 grid gap-1" role="alert">
      {issues.map((issue, index) => (
        <li key={`${issue.path}-${issue.code}-${index}`} className="flex items-start gap-2 text-xs font-medium text-red-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

export function SettingsNotice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" | "error" | "success" }) {
  const toneClass = {
    info: "border-blue-200 bg-blue-50 text-blue-900",
    warning: "border-amber-200 bg-amber-50 text-amber-950",
    error: "border-red-200 bg-red-50 text-red-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div role="status" className={`rounded-md border px-3 py-2 text-sm font-medium ${toneClass}`}>
      {children}
    </div>
  );
}
