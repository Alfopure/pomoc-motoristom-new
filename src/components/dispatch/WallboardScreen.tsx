"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Clock3, Headphones, PauseCircle, PhoneCall, PhoneIncoming, PhoneMissed, Timer, Users } from "lucide-react";

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
  type WallboardPayload,
  type WallboardTone,
  type WallboardWaitingCall,
} from "@/lib/telephony/wallboard";

import { useTelephonyStats } from "./useTelephonyStats";
import { useTickingClock } from "./settings/settings-ui";

/**
 * The wall display (design §4 Phase 4, plan "wallboard `src/app/wallboard/page.tsx`").
 *
 * This screen is read from four metres away by people who are doing something
 * else, so it is built to three rules the in-console panels do not follow:
 *
 * 1. **No chart.** Every number here is a single current value — how many are
 *    waiting, how long the worst one has waited, what share we answered in
 *    twenty seconds. A stat tile answers that in one glance; a plot of it would
 *    only add ink. (Trends live in the reports view, where somebody is sitting
 *    down.)
 * 2. **Colour is never the message.** Amber and red repeat something the tile
 *    already says in words and in the number itself. A room where one person in
 *    twelve cannot separate the two hues still reads the same board.
 * 3. **The clock keeps moving between polls.** Durations are re-derived every
 *    second from the timestamps in the payload against the browser's own clock,
 *    so a five-second poll does not produce a board that freezes and jumps.
 */

/**
 * The caller's number, masked.
 *
 * The threat model of a wall display is not the session — the page is
 * senior-dispatcher gated — but everybody who walks past the television:
 * visitors, contractors, anyone with a phone camera. The scope of this screen
 * is *how many* are waiting and *how long*, so the last three digits are enough
 * for an operator standing at the board to recognise the call they just picked
 * up. The full number stays in the payload and in the console widgets, where it
 * is on somebody's own desk and is needed to work the call.
 */
function maskedCaller(callerNumber: string | null): string {
  if (!callerNumber) return "Neznáme číslo";
  const digits = callerNumber.replace(/\D/g, "");
  return digits.length >= 3 ? `••• ${digits.slice(-3)}` : "•••";
}

const TONE_TILE: Record<WallboardTone, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10",
  warn: "border-amber-400/50 bg-amber-400/10",
  alert: "border-red-500/50 bg-red-500/15",
  idle: "border-white/10 bg-white/5",
};

const TONE_VALUE: Record<WallboardTone, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  alert: "text-red-300",
  idle: "text-white",
};

const TONE_BADGE: Record<WallboardTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-200",
  warn: "bg-amber-400/15 text-amber-200",
  alert: "bg-red-500/20 text-red-200",
  idle: "bg-white/10 text-zinc-300",
};

/** Once the snapshot is older than this, the board says so instead of lying quietly. */
const STALE_AFTER_SECONDS = 30;

export function WallboardScreen() {
  const { error, forbidden, loaded, signedOut, stats } = useTelephonyStats();
  // One second: this is the only surface in the application where a caller's
  // waiting time is watched as it runs.
  const clock = useTickingClock(1_000);
  const checkedAt = stats ? Date.parse(stats.checkedAt) : Number.NaN;
  const now = clock?.getTime() ?? (Number.isFinite(checkedAt) ? checkedAt : 0);

  if (forbidden) {
    return <WallboardNotice title="Wallboard nie je dostupný" detail="Nástenný prehľad vidia služobne starší dispečeri, manažéri a administrátori." />;
  }
  // An expired session on a screen nobody types on would otherwise leave hours-old
  // numbers on the wall behind a small "Neaktuálne" badge. The board blanks and
  // asks for a sign-in instead.
  if (signedOut) {
    return <WallboardNotice title="Relácia vypršala" detail="Prihlás sa znova, aby nástenný prehľad ukazoval aktuálne čísla." />;
  }
  if (!stats) {
    return <WallboardNotice title={loaded ? "Údaje sa nepodarilo načítať" : "Načítavam prehľad…"} detail={loaded ? (error ?? "Skúste to o chvíľu znova.") : "Ústredňa práve zbiera aktuálne čísla."} />;
  }

  const staleSeconds = elapsedSeconds(stats.checkedAt, now);
  const longest = longestWaitSeconds(stats.live.waiting, now);

  return (
    <main className="min-h-dvh bg-zinc-950 px-4 py-4 text-white sm:px-6 sm:py-6">
      <h1 className="sr-only">Nástenný prehľad ústredne</h1>

      <WallboardHeader stats={stats} now={now} staleSeconds={staleSeconds} error={error} />

      <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          icon={PhoneIncoming}
          label="Čakajúci volajúci"
          value={String(stats.live.waiting.length)}
          detail={stats.live.parked > 0 ? `${stats.live.parked}× odložený operátorom` : "Nikto nečaká na prevzatie"}
          tone={stats.live.waiting.length === 0 ? "ok" : waitTone(longest)}
          status={stats.live.waiting.length === 0 ? "Prázdna čakáreň" : waitStatusLabel(longest)}
        />
        <StatTile
          icon={Timer}
          label="Najdlhšie čakanie"
          value={stats.live.waiting.length === 0 ? "—" : formatClock(longest)}
          detail={stats.live.waiting.length === 0 ? "Žiadny volajúci v čakárni" : "Od vstupu do čakárne"}
          tone={stats.live.waiting.length === 0 ? "idle" : waitTone(longest)}
          status={stats.live.waiting.length === 0 ? undefined : waitStatusLabel(longest)}
        />
        <StatTile
          icon={Headphones}
          label="Na hovore"
          value={String(stats.live.talking)}
          detail={`${stats.live.ringing}× zvoní · ${stats.operators.filter((operator) => operator.state === "available").length} voľných`}
          tone="idle"
        />
        <StatTile
          icon={Clock3}
          label="Spätné volania"
          value={String(stats.callbacks.open)}
          detail={stats.callbacks.unclaimed > 0 ? `${stats.callbacks.unclaimed} bez dispečera` : "Všetky prevzaté"}
          tone={stats.callbacks.overdue > 0 ? "alert" : stats.callbacks.open > 0 ? "warn" : "ok"}
          status={stats.callbacks.overdue > 0 ? `${stats.callbacks.overdue}× po termíne` : undefined}
        />

        <StatTile
          icon={PhoneCall}
          label="Prijaté dnes"
          value={String(stats.today.answered)}
          detail={`${stats.today.calls} prichádzajúcich spolu`}
          tone="idle"
        />
        <StatTile
          icon={PhoneMissed}
          label="Zmeškané dnes"
          value={String(stats.today.unanswered)}
          detail={stats.today.systemHandled > 0 ? `z toho ${stats.today.systemHandled}× vybavené automaticky` : "Žiadne automaticky vybavené"}
          tone={stats.today.abandoned > 0 ? "warn" : "ok"}
          status={stats.today.abandoned > 0 ? `${stats.today.abandoned}× volajúci zložil` : undefined}
        />
        <StatTile
          icon={Timer}
          label="Priemerné prijatie"
          value={stats.today.averageAnswerSeconds === null ? "—" : `${stats.today.averageAnswerSeconds} s`}
          detail={stats.today.answeredWithWait > 0 ? `z ${stats.today.answeredWithWait} prijatých hovorov` : "Dnes zatiaľ bez merania"}
          tone={stats.today.averageAnswerSeconds === null ? "idle" : waitTone(stats.today.averageAnswerSeconds)}
          status={stats.today.averageAnswerSeconds === null ? undefined : waitStatusLabel(stats.today.averageAnswerSeconds)}
        />
        <StatTile
          icon={AlertTriangle}
          label="Prijaté do 20 s"
          value={stats.today.serviceLevel === null ? "—" : `${stats.today.serviceLevel} %`}
          detail={stats.today.abandonRate === null ? "Opustené: bez údaja" : `Opustené ${stats.today.abandonRate} %`}
          tone={serviceLevelTone(stats.today.serviceLevel)}
          status={stats.today.abandonRate === null ? undefined : abandonStatusLabel(stats.today.abandonRate)}
        />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <WaitingList waiting={stats.live.waiting} now={now} />
        <OperatorGrid operators={stats.operators} now={now} />
      </div>
    </main>
  );
}

function WallboardHeader({ error, now, staleSeconds, stats }: { error: string | null; now: number; staleSeconds: number; stats: WallboardPayload }) {
  const stale = staleSeconds > STALE_AFTER_SECONDS;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-baseline gap-3">
        <span className="text-lg font-bold tracking-tight sm:text-2xl">Ústredňa</span>
        <span className="text-sm text-zinc-400 sm:text-base">{formatDay(stats.day)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        {!stats.configured && <HeaderBadge tone="warn">Telefónia nie je nakonfigurovaná</HeaderBadge>}
        {stats.source === "fallback" && <HeaderBadge tone="warn">Štatistické view chýba — počítané z hovorov</HeaderBadge>}
        {error && <HeaderBadge tone="alert">{error}</HeaderBadge>}
        <HeaderBadge tone={stale ? "alert" : "idle"}>
          {stale ? `Neaktuálne · ${formatClock(staleSeconds)}` : `Aktualizované pred ${staleSeconds} s`}
        </HeaderBadge>
        <span className="rounded-md bg-white/10 px-2.5 py-1.5 tabular-nums text-zinc-100">{formatTimeOfDay(now)}</span>
      </div>
    </header>
  );
}

function HeaderBadge({ children, tone }: { children: React.ReactNode; tone: WallboardTone }) {
  return <span className={`rounded-md px-2.5 py-1.5 ${TONE_BADGE[tone]}`}>{children}</span>;
}

function StatTile({ detail, icon: Icon, label, status, tone, value }: {
  detail: string;
  icon: LucideIcon;
  label: string;
  /** Repeats the colour in words; the tone alone never carries the meaning. */
  status?: string;
  tone: WallboardTone;
  value: string;
}) {
  return (
    <section className={`rounded-lg border p-4 ${TONE_TILE[tone]}`}>
      <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-300 sm:text-sm">
        <span>{label}</span>
        <Icon size={18} className="shrink-0 text-zinc-400" aria-hidden="true" />
      </div>
      <div className={`mt-3 text-4xl font-bold tabular-nums tracking-tight sm:text-5xl ${TONE_VALUE[tone]}`}>{value}</div>
      {status ? <div className={`mt-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${TONE_BADGE[tone]}`}>{status}</div> : null}
      <div className="mt-1.5 text-xs text-zinc-400 sm:text-sm">{detail}</div>
    </section>
  );
}

function WaitingList({ now, waiting }: { now: number; waiting: WallboardWaitingCall[] }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/5">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold sm:text-base">
          <PhoneIncoming size={17} aria-hidden="true" />
          Čakáreň
        </h2>
        <span className="text-xs font-semibold text-zinc-400">{waiting.length === 0 ? "prázdna" : `${waiting.length} volajúcich`}</span>
      </div>
      {waiting.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-zinc-400">Nikto nečaká na spojenie.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {waiting.map((call) => {
            const seconds = elapsedSeconds(call.since, now);
            const tone = waitTone(seconds);
            return (
              <li key={call.sessionId} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold sm:text-lg">{call.lineLabel ?? "Volajúci"}</div>
                  <div className="truncate text-xs text-zinc-400 sm:text-sm">
                    {maskedCaller(call.callerNumber)}
                    {call.parkedByName ? ` · odložil ${call.parkedByName}` : ""}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-2xl font-bold tabular-nums sm:text-3xl ${TONE_VALUE[tone]}`}>{formatClock(seconds)}</div>
                  <div className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${TONE_BADGE[tone]}`}>{waitStatusLabel(seconds)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OperatorGrid({ now, operators }: { now: number; operators: WallboardOperator[] }) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/5">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold sm:text-base">
          <Users size={17} aria-hidden="true" />
          Operátori
        </h2>
        <span className="text-xs font-semibold text-zinc-400">
          {operators.filter((operator) => operator.state !== "offline").length} prihlásených z {operators.length}
        </span>
      </div>
      {operators.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-zinc-400">Žiadny operátor nie je nastavený.</p>
      ) : (
        <ul className="grid gap-2 p-3 sm:grid-cols-2">
          {operators.map((operator) => {
            const tone = WALLBOARD_STATE_TONES[operator.state];
            const seconds = elapsedSeconds(operator.since, now);
            return (
              <li key={operator.profileId} className={`rounded-md border px-3 py-2.5 ${TONE_TILE[tone]}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold sm:text-base">{operator.name}</span>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${TONE_BADGE[tone]}`}>
                    {WALLBOARD_STATE_LABELS[operator.state]}
                    {operator.pauseReason ? ` · ${operator.pauseReason}` : ""}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span className="tabular-nums">
                    {operator.since ? `v stave ${formatClock(seconds)}` : "bez údaja o zmene stavu"}
                  </span>
                  <span className="flex items-center gap-2">
                    {!operator.registered && operator.state !== "offline" ? (
                      <span className="inline-flex items-center gap-1 text-amber-200" title="Prehliadačový telefón nie je prihlásený">
                        <PauseCircle size={12} aria-hidden="true" />
                        bez telefónu
                      </span>
                    ) : null}
                    <span className="tabular-nums" title="Prijaté prichádzajúce hovory dnes">
                      {operator.answeredToday}× dnes
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function WallboardNotice({ detail, title }: { detail: string; title: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-zinc-950 px-6 text-center text-white">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-zinc-400">{detail}</p>
      </div>
    </main>
  );
}

/** The words behind the colour: a board must be readable without hue. */
function waitStatusLabel(seconds: number): string {
  const tone = waitTone(seconds);
  return tone === "alert" ? "kritické" : tone === "warn" ? "nad limit" : "v limite";
}

function abandonStatusLabel(rate: number): string {
  const tone = abandonTone(rate);
  return tone === "alert" ? "veľa opustených" : tone === "warn" ? "zvýšené opustené" : "opustené v norme";
}

function formatDay(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(parsed)) return day;
  return new Date(parsed).toLocaleDateString("sk-SK", { weekday: "long", day: "numeric", month: "long" });
}

function formatTimeOfDay(now: number): string {
  if (!now) return "--:--";
  return new Date(now).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
}
