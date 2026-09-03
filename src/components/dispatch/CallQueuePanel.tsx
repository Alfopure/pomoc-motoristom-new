"use client";

import { useState } from "react";
import { ChevronDown, Clock3, Loader2, Pause, PhoneIncoming } from "lucide-react";

import type { CallCenterCall } from "@/data/dispatch-types";
import type { WaitingRoomPark } from "@/lib/telephony/active-calls-model";

export type WaitingRoomStation = {
  extension: string;
  name: string;
};

export type WaitingRoomEntry = {
  call: CallCenterCall;
  /** Where the call is ringing right now; undefined while it waits unassigned. */
  station?: WaitingRoomStation;
  /** Who put the caller here and how long the park limit still allows. */
  park?: WaitingRoomPark;
};

export type WaitingCallPickupAction = {
  disabled: boolean;
  label: string;
  reason?: string;
};

type WaitingRoomEntries = WaitingRoomEntry[];

/**
 * The waiting room, shown wherever the dispatcher happens to be.
 *
 * It used to live only inside Ústredňa → Pracovisko, so a dispatcher working in
 * Dispečing, Prípady or the map could not see who was waiting, let alone choose
 * between two callers arriving at once. `variant="header"` is the always-present
 * surface, a dropdown sitting beside the operator-coverage pill; `variant="rail"`
 * is the same thing for narrow screens, where the header pills are hidden; and
 * `variant="embedded"` is the same list rendered inline on the workplace page.
 * All three share one implementation of the row.
 */
export function CallQueuePanel({
  calls,
  now,
  onPickup,
  pickupState,
  variant,
}: {
  calls: WaitingRoomEntries;
  now: number;
  onPickup: (call: CallCenterCall) => void;
  pickupState: (call: CallCenterCall) => WaitingCallPickupAction;
  variant: "rail" | "embedded" | "header";
}) {
  const waitingCount = calls.length;
  const list = (
    <div className={`grid gap-2 overflow-y-auto pr-1 ${
      variant === "embedded"
        ? "max-h-[min(50vh,420px)] sm:grid-cols-2"
        : "max-h-[min(60vh,520px)]"
    }`}>
      {calls.map(({ call, station, park }) => {
        const startedAt = Date.parse(call.startedAt);
        const elapsed = Number.isFinite(startedAt)
          ? Math.max(call.waitSeconds ?? 0, Math.floor((now - startedAt) / 1_000))
          : call.waitSeconds ?? 0;
        const callerName = call.callerName?.trim();
        const pickup = pickupState(call);
        return (
          <div key={call.id} className="min-w-0 rounded-lg border border-amber-200 bg-white px-3 py-2 shadow-sm">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate text-sm font-bold text-zinc-950">{callerName || call.callerNumber}</span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-zinc-600">
                <Clock3 size={12} aria-hidden="true" />
                {formatWaitingDuration(elapsed)}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-zinc-600">
                {callerName ? call.callerNumber : call.lineLabel ?? "Prichádzajúci hovor"}
              </span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 font-bold ${
                station ? "bg-yellow-100 text-yellow-900" : park?.parked ? "bg-sky-100 text-sky-900" : "bg-zinc-100 text-zinc-700"
              }`}>
                {station ? `Zvoní: ${station.name}` : park?.parked ? "Odložený hovor" : "Čaká na pridelenie"}
              </span>
            </div>
            {park && <ParkedNote park={park} />}
            <button
              type="button"
              onClick={() => onPickup(call)}
              disabled={pickup.disabled}
              title={pickup.reason}
              className="mt-2 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 text-xs font-bold text-white outline-none transition hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500"
            >
              {pickup.label.endsWith("…") && <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />}
              {pickup.label}
            </button>
            {pickup.disabled && pickup.reason && (
              <p className="mt-1.5 text-[11px] font-medium leading-4 text-zinc-500">{pickup.reason}</p>
            )}
          </div>
        );
      })}
    </div>
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-yellow-300 text-zinc-950">
          <PhoneIncoming size={16} aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-sm font-bold text-zinc-950">Čakáreň hovorov</h3>
          <p className="text-xs text-zinc-600">Každý dispečer si môže vybrať konkrétny čakajúci hovor.</p>
        </div>
      </div>
      <span className="rounded-full bg-zinc-950 px-2.5 py-1 text-xs font-bold text-white" aria-live="polite">
        {waitingCount} {waitingCount === 1 ? "hovor" : waitingCount < 5 ? "hovory" : "hovorov"}
      </span>
    </div>
  );

  const body = waitingCount === 0 ? (
    <div className="mt-3 rounded-lg border border-dashed border-amber-200 bg-white/70 px-3 py-2.5 text-xs font-medium text-zinc-600">
      Momentálne nečaká žiadny prichádzajúci hovor.
    </div>
  ) : <div className="mt-3">{list}</div>;

  if (variant === "embedded") {
    return (
      <section className="border-b border-zinc-200 bg-amber-50/70 px-4 py-3 sm:px-5" aria-label="Čakáreň hovorov">
        {header}
        {body}
      </section>
    );
  }

  if (variant === "header") {
    // Matches the operator-coverage pill it sits beside: same height, same
    // shape, same open-downwards panel, so the two read as one status group.
    const tone = waitingCount > 0
      ? "border-amber-400 bg-amber-500/15 text-amber-100"
      : "border-white/15 bg-white/10 text-zinc-200";
    return (
      // Stays closed until the dispatcher opens it. The count on the summary is
      // the always-visible signal; a panel that opened itself covered the page
      // every time a call arrived.
      <details className="group relative">
        <summary
          className={`flex h-9 cursor-pointer list-none items-center justify-center gap-2 rounded-md border px-2 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-amber-300 [&::-webkit-details-marker]:hidden ${tone}`}
          title={waitingCount > 0 ? "Zobraziť čakajúce hovory" : "Žiadny čakajúci hovor"}
        >
          <PhoneIncoming size={14} className="shrink-0" aria-hidden="true" />
          <span>Čakáreň</span>
          <span
            className={`rounded px-1.5 py-0.5 ${waitingCount > 0 ? "bg-white/20" : "bg-white/10"}`}
            aria-live="polite"
          >
            {waitingCount}
          </span>
          <ChevronDown size={13} className="shrink-0 transition group-open:rotate-180" aria-hidden="true" />
        </summary>
        <section
          // Distinct from the workplace page's own "Čakáreň hovorov" section:
          // both are on screen together in Ústredňa → Pracovisko, and two
          // landmarks sharing one name is ambiguous to a screen reader.
          aria-label="Čakajúce hovory"
          className="absolute right-0 top-[calc(100%+8px)] z-[80] w-80 overflow-hidden rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-zinc-950 shadow-2xl"
        >
          {header}
          {body}
        </section>
      </details>
    );
  }

  return (
    // Keyed on whether anyone is waiting, so the collapse state resets when the
    // queue refills. A dispatcher who hides an empty panel still gets it back
    // the moment a caller arrives, rather than silently missing them.
    <QueueRail key={waitingCount > 0 ? "waiting" : "quiet"} waitingCount={waitingCount}>
      {body}
    </QueueRail>
  );
}

function QueueRail({
  children,
  waitingCount,
}: {
  children: React.ReactNode;
  waitingCount: number;
}) {
  const [collapsed, setCollapsed] = useState(waitingCount === 0);

  return (
    <aside
      aria-label="Čakáreň hovorov"
      className="pointer-events-none fixed inset-x-2 bottom-[calc(78px+env(safe-area-inset-bottom))] z-[2147483300] xl:inset-x-auto xl:right-4 xl:top-24 xl:bottom-auto xl:w-80"
    >
      <div className="pointer-events-auto overflow-hidden rounded-xl border border-amber-200 bg-amber-50/95 shadow-lg backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
        >
          <span className="flex items-center gap-2 text-sm font-bold text-zinc-950">
            <PhoneIncoming size={16} aria-hidden="true" />
            Čakáreň
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${
              waitingCount > 0 ? "bg-zinc-950 text-white" : "bg-zinc-200 text-zinc-700"
            }`} aria-live="polite">
              {waitingCount}
            </span>
          </span>
          <ChevronDown size={16} className={collapsed ? "" : "rotate-180"} aria-hidden="true" />
        </button>
        {!collapsed && <div className="border-t border-amber-200 px-4 pb-3 pt-2">{children}</div>}
      </div>
    </aside>
  );
}

/**
 * The waiting room half of the park limit: who odložil the caller and how long
 * they still have before the state machine stops waiting for a rescue and
 * offers them a callback instead (`park_max_minutes`, frozen on entry).
 */
function ParkedNote({ park }: { park: WaitingRoomPark }) {
  const limit = park.secondsToLimit;
  if (!park.parked && limit === null) return null;
  const expired = limit !== null && limit <= 0;
  return (
    <p className={`mt-1 flex min-w-0 items-center gap-1 text-[11px] font-medium leading-4 ${expired ? "text-red-700" : "text-zinc-500"}`}>
      <Pause size={11} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {park.parked ? `Odložil ${park.byName ?? "iný dispečer"} · ${formatWaitingDuration(park.seconds)}` : `V čakárni ${formatWaitingDuration(park.seconds)}`}
        {limit === null
          ? ""
          : expired
            ? " · limit vypršal, ponúkame spätné volanie"
            : ` · spätné volanie o ${Math.ceil(limit / 60)} min`}
      </span>
    </p>
  );
}

export function formatWaitingDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
