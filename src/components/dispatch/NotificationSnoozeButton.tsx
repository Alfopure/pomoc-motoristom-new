"use client";

import { useEffect, useState } from "react";
import { AlarmClock, CalendarClock, Loader2, X } from "lucide-react";

type NotificationSnoozeButtonProps = {
  disabled?: boolean;
  notificationId: string;
  notificationTitle: string;
  onSnooze: (notificationId: string, snoozedUntil: string) => boolean | Promise<boolean>;
  onSnoozed?: () => void;
  variant?: "compact" | "icon";
};

const quickChoices = [
  { label: "O 10 min", minutes: 10 },
  { label: "O 30 min", minutes: 30 },
  { label: "O 1 hodinu", minutes: 60 },
] as const;

export function NotificationSnoozeButton({
  disabled,
  notificationId,
  notificationTitle,
  onSnooze,
  onSnoozed,
  variant = "compact",
}: NotificationSnoozeButtonProps) {
  const [open, setOpen] = useState(false);
  const [customTime, setCustomTime] = useState(() => dateTimeLocalValue(new Date(Date.now() + 60 * 60 * 1_000)));
  const [minimumTime, setMinimumTime] = useState(() => dateTimeLocalValue(new Date(Date.now() + 60_000)));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, pending]);

  function openDialog() {
    const now = Date.now();
    setCustomTime(dateTimeLocalValue(new Date(now + 60 * 60 * 1_000)));
    setMinimumTime(dateTimeLocalValue(new Date(now + 60_000)));
    setError(null);
    setOpen(true);
  }

  async function schedule(date: Date) {
    if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 30_000) {
      setError("Vyberte dátum a čas v budúcnosti.");
      return;
    }

    setPending(true);
    setError(null);
    let saved = false;
    try {
      saved = await onSnooze(notificationId, date.toISOString());
    } catch {
      saved = false;
    } finally {
      setPending(false);
    }

    if (saved) {
      setOpen(false);
      onSnoozed?.();
      return;
    }

    setError("Pripomenutie sa nepodarilo uložiť.");
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openDialog();
        }}
        disabled={disabled || pending}
        className={variant === "icon"
          ? "inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-yellow-50 hover:text-zinc-950 disabled:cursor-wait disabled:text-zinc-300"
          : "inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white px-2.5 text-zinc-700 hover:bg-yellow-50 disabled:cursor-wait disabled:text-zinc-300"}
        aria-label="Pripomenúť upozornenie neskôr"
        title="Pripomenúť neskôr"
      >
        {pending ? <Loader2 size={13} className="animate-spin" /> : variant === "icon" ? <AlarmClock size={14} /> : (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
            <AlarmClock size={13} />
            Pripomenúť
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[2147483640] grid place-items-center bg-zinc-950/45 p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={`notification-snooze-title-${notificationId}`}
            className="w-full max-w-sm overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-2xl"
          >
            <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#FCD703] text-zinc-950">
                  <AlarmClock size={16} />
                </span>
                <div className="min-w-0">
                  <h2 id={`notification-snooze-title-${notificationId}`} className="text-sm font-bold">Pripomenúť neskôr</h2>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-zinc-500">{notificationTitle}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 disabled:text-zinc-300"
                aria-label="Zavrieť výber pripomenutia"
              >
                <X size={15} />
              </button>
            </header>

            <div className="grid gap-3 p-4">
              <div className="grid grid-cols-2 gap-2" aria-label="Rýchle pripomenutie">
                {quickChoices.map((choice) => (
                  <button
                    key={choice.minutes}
                    type="button"
                    onClick={() => void schedule(new Date(Date.now() + choice.minutes * 60 * 1_000))}
                    disabled={pending}
                    className="h-9 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-zinc-700 hover:border-yellow-400 hover:bg-yellow-50 disabled:cursor-wait disabled:text-zinc-300"
                  >
                    <span className="text-xs font-semibold">{choice.label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void schedule(tomorrowAtNine())}
                  disabled={pending}
                  className="h-9 rounded-md border border-zinc-200 bg-zinc-50 px-2 text-zinc-700 hover:border-yellow-400 hover:bg-yellow-50 disabled:cursor-wait disabled:text-zinc-300"
                >
                  <span className="text-xs font-semibold">Zajtra 09:00</span>
                </button>
              </div>

              <form
                className="grid gap-2 border-t border-zinc-100 pt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void schedule(new Date(customTime));
                }}
              >
                <label className="grid gap-1.5 text-xs font-semibold text-zinc-700">
                  Vlastný dátum a čas
                  <span className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-300 bg-white px-2">
                    <CalendarClock size={14} className="shrink-0 text-zinc-500" />
                    <input
                      type="datetime-local"
                      value={customTime}
                      min={minimumTime}
                      onChange={(event) => setCustomTime(event.target.value)}
                      disabled={pending}
                      className="h-10 min-w-0 flex-1 bg-transparent text-sm font-medium text-zinc-900 outline-none disabled:text-zinc-400"
                      aria-label="Vlastný dátum a čas pripomenutia"
                    />
                  </span>
                </label>
                {error && <p role="alert" className="text-xs font-semibold text-red-700">{error}</p>}
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-zinc-950 px-3 text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300"
                >
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                    {pending && <Loader2 size={13} className="animate-spin" />}
                    Nastaviť pripomenutie
                  </span>
                </button>
              </form>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function tomorrowAtNine() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date;
}

function dateTimeLocalValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
