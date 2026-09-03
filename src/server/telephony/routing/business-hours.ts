/**
 * Business-hours evaluation (pure).
 *
 * A schedule is a set of weekly intervals (ISO weekday 1-7, wall-clock
 * `opens`/`closes`) plus dated exceptions that either close the whole day or
 * replace its intervals. Evaluation converts the instant to the schedule's
 * time zone with `Intl.DateTimeFormat`, so DST changes and the difference
 * between UTC and Europe/Bratislava are handled by the runtime, never by
 * hand-written offsets.
 */

export type BusinessHoursInterval = {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** `HH:MM` or `HH:MM:SS` local wall-clock time. */
  opens: string;
  closes: string;
};

export type BusinessHoursException = {
  /** `YYYY-MM-DD` in the schedule's time zone. */
  date: string;
  closed: boolean;
  /** Replacement intervals for that day when `closed` is false. */
  intervals?: Array<{ opens: string; closes: string }> | null;
  label?: string | null;
};

export type BusinessHoursSchedule = {
  timezone: string;
  intervals: BusinessHoursInterval[];
  exceptions: BusinessHoursException[];
};

export type LocalDateParts = {
  /** `YYYY-MM-DD` in the target zone. */
  date: string;
  /** ISO weekday 1-7. */
  weekday: number;
  /** Minutes since local midnight (0-1439). */
  minutes: number;
  hour: number;
  minute: number;
};

export type BusinessHoursDecision = {
  open: boolean;
  reason: "no_schedule" | "exception_closed" | "exception_open" | "exception_outside" | "interval" | "outside";
  local: LocalDateParts | null;
  exceptionLabel?: string | null;
};

export const DEFAULT_TIMEZONE = "Europe/Bratislava";

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of `at` in `timeZone`; falls back to Europe/Bratislava for an unknown zone. */
export function localDateParts(at: Date, timeZone: string = DEFAULT_TIMEZONE): LocalDateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = formatterFor(timeZone || DEFAULT_TIMEZONE);
  } catch {
    formatter = formatterFor(DEFAULT_TIMEZONE);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    minutes: hour * 60 + minute,
    hour,
    minute,
  };
}

/** Parses `HH:MM[:SS]` to minutes since midnight; returns null for malformed input. */
export function parseClock(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function withinAny(intervals: Array<{ opens: string; closes: string }>, minutes: number): boolean {
  return intervals.some((interval) => {
    const opens = parseClock(interval.opens);
    const closes = parseClock(interval.closes);
    if (opens === null || closes === null) return false;
    if (closes <= opens) return false;
    return minutes >= opens && minutes < closes;
  });
}

/** `true` when the instant falls inside the schedule (a missing schedule is always open). */
export function evaluateBusinessHours(schedule: BusinessHoursSchedule | null | undefined, at: Date): BusinessHoursDecision {
  if (!schedule) return { open: true, reason: "no_schedule", local: null };
  const local = localDateParts(at, schedule.timezone);

  const exception = schedule.exceptions.find((entry) => entry.date === local.date);
  if (exception) {
    if (exception.closed) return { open: false, reason: "exception_closed", local, exceptionLabel: exception.label ?? null };
    const replacement = Array.isArray(exception.intervals) ? exception.intervals : [];
    if (replacement.length === 0) return { open: true, reason: "exception_open", local, exceptionLabel: exception.label ?? null };
    return withinAny(replacement, local.minutes)
      ? { open: true, reason: "exception_open", local, exceptionLabel: exception.label ?? null }
      : { open: false, reason: "exception_outside", local, exceptionLabel: exception.label ?? null };
  }

  const todays = schedule.intervals.filter((interval) => interval.weekday === local.weekday);
  return withinAny(todays, local.minutes) ? { open: true, reason: "interval", local } : { open: false, reason: "outside", local };
}

export function isOpenAt(schedule: BusinessHoursSchedule | null | undefined, at: Date): boolean {
  return evaluateBusinessHours(schedule, at).open;
}

/**
 * Builds a schedule from database rows (`motorist_business_hours` +
 * intervals + exceptions). Exception intervals are stored as JSON
 * `[{"opens":"08:00","closes":"12:00"}]`; anything malformed is ignored.
 */
export function buildBusinessHoursSchedule(input: {
  timezone?: string | null;
  intervals: Array<{ weekday: number; opens: string; closes: string }>;
  exceptions: Array<{ date: string; closed: boolean; intervals?: unknown; label?: string | null }>;
}): BusinessHoursSchedule {
  return {
    timezone: input.timezone?.trim() || DEFAULT_TIMEZONE,
    intervals: input.intervals
      .filter((interval) => interval.weekday >= 1 && interval.weekday <= 7)
      .map((interval) => ({ weekday: interval.weekday, opens: interval.opens, closes: interval.closes })),
    exceptions: input.exceptions.map((exception) => ({
      date: exception.date,
      closed: exception.closed,
      label: exception.label ?? null,
      intervals: parseExceptionIntervals(exception.intervals),
    })),
  };
}

function parseExceptionIntervals(value: unknown): Array<{ opens: string; closes: string }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ opens: string; closes: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (parseClock(record.opens as string) === null || parseClock(record.closes as string) === null) continue;
    result.push({ opens: String(record.opens), closes: String(record.closes) });
  }
  return result;
}
