"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, ExternalLink, Headphones, PhoneIncoming, PhoneMissed, RefreshCw, Timer, Users } from "lucide-react";

import {
  abandonTone,
  elapsedSeconds,
  formatClock,
  longestWaitSeconds,
  serviceLevelTone,
  waitTone,
  WALLBOARD_STATE_LABELS,
  WALLBOARD_STATE_TONES,
  type WallboardOperator,
  type WallboardTone,
} from "@/lib/telephony/wallboard";

import { useTelephonyStats } from "./useTelephonyStats";
import { useTickingClock } from "./settings/settings-ui";

/**
 * The live call-centre widgets inside the reports view (plan "Fáza 4",
 * "widgety v reportoch").
 *
 * Same payload as the wall display, same definitions, different reader: this
 * one is sitting down and can act. Two things therefore differ from
 * `WallboardScreen`:
 *
 * * it is **explicitly labelled as live**, because everything else on the
 *   reports page follows the selected period and a "waiting now" number next to
 *   a 30-day chart would otherwise be read as part of it;
 * * it hides itself for a reader the statistics endpoint refuses, exactly as
 *   the QA panel does, instead of showing an error a dispatcher cannot fix.
 */

const TONE_CARD: Record<WallboardTone, string> = {
  ok: "border-emerald-200 bg-emerald-50",
  warn: "border-amber-200 bg-amber-50",
  alert: "border-red-200 bg-red-50",
  idle: "border-zinc-200 bg-white",
};

const TONE_VALUE: Record<WallboardTone, string> = {
  ok: "text-emerald-900",
  warn: "text-amber-900",
  alert: "text-red-900",
  idle: "text-zinc-950",
};

const TONE_BADGE: Record<WallboardTone, string> = {
  ok: "bg-emerald-100 text-emerald-900",
  warn: "bg-amber-100 text-amber-900",
  alert: "bg-red-100 text-red-900",
  idle: "bg-zinc-100 text-zinc-700",
};

export function TelephonyStatsWidgets() {
  const { error, forbidden, loaded, reload, stats } = useTelephonyStats();
  const clock = useTickingClock(5_000);
  const checkedAt = stats ? Date.parse(stats.checkedAt) : Number.NaN;
  const now = clock?.getTime() ?? (Number.isFinite(checkedAt) ? checkedAt : 0);

  if (forbidden) return null;
  if (!stats) {
    return loaded && error ? (
      <section className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs font-medium text-amber-900 xl:col-span-12">{error}</section>
    ) : null;
  }

  const longest = longestWaitSeconds(stats.live.waiting, now);
  const available = stats.operators.filter((operator) => operator.state === "available").length;

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white md:col-span-2 xl:col-span-12">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-950">Ústredňa teraz</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Živý stav a dnešok, nezávisle od zvoleného obdobia · aktualizované pred {elapsedSeconds(stats.checkedAt, now)} s
            {stats.source === "fallback" ? " · štatistické view zatiaľ nie je nasadené" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reload}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            <RefreshCw size={13} />
            Obnoviť
          </button>
          <a
            href="/wallboard"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800"
          >
            <ExternalLink size={13} />
            Wallboard
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
        <MetricCard
          icon={PhoneIncoming}
          label="Čaká v rade"
          value={String(stats.live.waiting.length)}
          detail={stats.live.parked > 0 ? `${stats.live.parked}× odložený operátorom` : `${available} voľných operátorov`}
          tone={stats.live.waiting.length === 0 ? "ok" : waitTone(longest)}
        />
        <MetricCard
          icon={Timer}
          label="Najdlhšie čakanie"
          value={stats.live.waiting.length === 0 ? "—" : formatClock(longest)}
          detail={stats.live.talking > 0 ? `${stats.live.talking}× práve na hovore` : "Nikto práve nehovorí"}
          tone={stats.live.waiting.length === 0 ? "idle" : waitTone(longest)}
        />
        <MetricCard
          icon={Headphones}
          label="Prijaté dnes"
          value={String(stats.today.answered)}
          detail={`${stats.today.calls} prichádzajúcich · ${stats.today.outbound} odchádzajúcich`}
          tone="idle"
        />
        <MetricCard
          icon={PhoneMissed}
          label="Zmeškané dnes"
          value={String(stats.today.unanswered)}
          detail={stats.today.systemHandled > 0 ? `${stats.today.systemHandled}× vybavené automaticky` : `${stats.today.abandoned}× volajúci zložil`}
          tone={stats.today.abandoned > 0 ? "warn" : "ok"}
        />
        <MetricCard
          icon={Timer}
          label="Priemerné prijatie"
          value={stats.today.averageAnswerSeconds === null ? "—" : `${stats.today.averageAnswerSeconds} s`}
          detail={stats.today.answeredWithWait > 0 ? `z ${stats.today.answeredWithWait} meraných hovorov` : "Dnes zatiaľ bez merania"}
          tone={stats.today.averageAnswerSeconds === null ? "idle" : waitTone(stats.today.averageAnswerSeconds)}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Prijaté do 20 s"
          value={stats.today.serviceLevel === null ? "—" : `${stats.today.serviceLevel} %`}
          detail="Úroveň služby podľa plánu"
          tone={serviceLevelTone(stats.today.serviceLevel)}
        />
        <MetricCard
          icon={PhoneMissed}
          label="Opustené hovory"
          value={stats.today.abandonRate === null ? "—" : `${stats.today.abandonRate} %`}
          detail={`${stats.today.abandoned} volajúcich zložilo pred prijatím`}
          tone={abandonTone(stats.today.abandonRate)}
        />
        <MetricCard
          icon={Users}
          label="Spätné volania"
          value={String(stats.callbacks.open)}
          detail={stats.callbacks.overdue > 0 ? `${stats.callbacks.overdue}× po 30-minútovom sľube` : `${stats.callbacks.unclaimed} bez dispečera`}
          tone={stats.callbacks.overdue > 0 ? "alert" : stats.callbacks.open > 0 ? "warn" : "ok"}
        />
      </div>

      <OperatorStrip operators={stats.operators} now={now} />
    </section>
  );
}

function MetricCard({ detail, icon: Icon, label, tone, value }: { detail: string; icon: LucideIcon; label: string; tone: WallboardTone; value: string }) {
  return (
    <div className={`rounded-md border p-3 ${TONE_CARD[tone]}`}>
      <div className="flex items-center justify-between gap-2 text-xs font-semibold text-zinc-600">
        <span>{label}</span>
        <Icon size={15} className="shrink-0 text-zinc-400" aria-hidden="true" />
      </div>
      <div className={`mt-2 text-3xl font-bold tabular-nums tracking-tight ${TONE_VALUE[tone]}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}

function OperatorStrip({ now, operators }: { now: number; operators: WallboardOperator[] }) {
  if (operators.length === 0) return null;
  return (
    <div className="border-t border-zinc-100 px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Stavy operátorov a čas v stave</h3>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {operators.map((operator) => {
          const tone = WALLBOARD_STATE_TONES[operator.state];
          return (
            <li key={operator.profileId} className="flex items-center justify-between gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm">
              <span className="min-w-0 truncate font-medium text-zinc-800">{operator.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${TONE_BADGE[tone]}`}>
                  {WALLBOARD_STATE_LABELS[operator.state]}
                  {operator.pauseReason ? ` · ${operator.pauseReason}` : ""}
                </span>
                <span className="tabular-nums text-xs text-zinc-500">{operator.since ? formatClock(elapsedSeconds(operator.since, now)) : "—"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
