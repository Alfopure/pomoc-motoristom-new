/**
 * Pure model behind `BusinessHoursEditor.tsx` (design §3, plan "Fáza 3").
 *
 * A schedule is a set of weekly intervals (ISO weekday 1-7) plus dated
 * exceptions. Several intervals on one weekday express a lunch break or a split
 * shift; an exception either closes the whole day (a public holiday) or
 * replaces its intervals for that date.
 *
 * The preview reuses `evaluateBusinessHours` from `src/lib/telephony`, the very
 * function the session runner uses to decide `after_hours`, so what the manager
 * reads here is what the call will do — including around a DST change, where
 * the wall-clock opening time must not move.
 *
 * The local validation is a *mirror* of `validateBusinessHours`; the server
 * validates the merged world again and stays the last word.
 */

import {
  DEFAULT_TIMEZONE,
  evaluateBusinessHours,
  localDateParts,
  parseClock,
  type BusinessHoursDecision,
  type BusinessHoursSchedule,
} from "@/lib/telephony/business-hours";
import type { BusinessHoursDoc, BusinessHoursInput, LineDoc, ValidationIssue } from "@/server/telephony/config-service";

import { nextDraftKey } from "./ring-groups-model";

export { DEFAULT_TIMEZONE };

/** Monday-first, matching the Slovak week and the ISO weekday numbers 1-7. */
export const WEEKDAYS: Array<{ weekday: number; label: string; short: string }> = [
  { weekday: 1, label: "Pondelok", short: "Po" },
  { weekday: 2, label: "Utorok", short: "Ut" },
  { weekday: 3, label: "Streda", short: "St" },
  { weekday: 4, label: "Štvrtok", short: "Št" },
  { weekday: 5, label: "Piatok", short: "Pi" },
  { weekday: 6, label: "Sobota", short: "So" },
  { weekday: 7, label: "Nedeľa", short: "Ne" },
];

export const DEFAULT_OPENS = "08:00";
export const DEFAULT_CLOSES = "16:00";

export type IntervalDraft = { key: string; opens: string; closes: string };

export type ExceptionDraft = {
  key: string;
  date: string;
  closed: boolean;
  label: string;
  intervals: IntervalDraft[];
};

export type ScheduleDraft = {
  /** Stable identity of the row for React keys; not a database id. */
  key: string;
  id: string | null;
  name: string;
  timezone: string;
  active: boolean;
  /** Weekday (1-7) → its intervals, in the order the manager sees them. */
  days: Map<number, IntervalDraft[]>;
  exceptions: ExceptionDraft[];
};

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

function emptyDays(): Map<number, IntervalDraft[]> {
  return new Map(WEEKDAYS.map(({ weekday }) => [weekday, [] as IntervalDraft[]]));
}

export function scheduleDraftsFromDocument(hours: readonly BusinessHoursDoc[]): ScheduleDraft[] {
  return hours.map((row) => {
    const days = emptyDays();
    for (const interval of [...row.intervals].sort((left, right) => left.weekday - right.weekday || left.opens.localeCompare(right.opens))) {
      const list = days.get(interval.weekday);
      if (!list) continue;
      list.push({ key: nextDraftKey("interval"), opens: interval.opens, closes: interval.closes });
    }
    return {
      key: `hours-${row.id}`,
      id: row.id,
      name: row.name,
      timezone: row.timezone || DEFAULT_TIMEZONE,
      active: row.active,
      days,
      exceptions: [...row.exceptions]
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((exception) => ({
          key: nextDraftKey("exception"),
          date: exception.date,
          closed: exception.closed,
          label: exception.label ?? "",
          intervals: exception.intervals.map((interval) => ({ key: nextDraftKey("interval"), opens: interval.opens, closes: interval.closes })),
        })),
    };
  });
}

export function newScheduleDraft(name = ""): ScheduleDraft {
  return { key: nextDraftKey("hours"), id: null, name, timezone: DEFAULT_TIMEZONE, active: true, days: emptyDays(), exceptions: [] };
}

export function newIntervalDraft(opens = DEFAULT_OPENS, closes = DEFAULT_CLOSES): IntervalDraft {
  return { key: nextDraftKey("interval"), opens, closes };
}

/** `today` is `YYYY-MM-DD` in the schedule's zone; a new exception defaults to "zatvorené". */
export function newExceptionDraft(date: string): ExceptionDraft {
  return { key: nextDraftKey("exception"), date, closed: true, label: "", intervals: [] };
}

// ---------------------------------------------------------------------------
// List operations (the component only forwards events)
// ---------------------------------------------------------------------------

function mapSchedule(schedules: readonly ScheduleDraft[], scheduleKey: string, change: (schedule: ScheduleDraft) => ScheduleDraft): ScheduleDraft[] {
  return schedules.map((schedule) => (schedule.key === scheduleKey ? change(schedule) : schedule));
}

export function addSchedule(schedules: readonly ScheduleDraft[]): ScheduleDraft[] {
  return [...schedules, newScheduleDraft()];
}

export function updateSchedule(
  schedules: readonly ScheduleDraft[],
  scheduleKey: string,
  patch: Partial<Pick<ScheduleDraft, "name" | "timezone" | "active">>,
): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => ({ ...schedule, ...patch }));
}

export function removeSchedule(schedules: readonly ScheduleDraft[], scheduleKey: string): ScheduleDraft[] {
  return schedules.filter((schedule) => schedule.key !== scheduleKey);
}

function withDays(schedule: ScheduleDraft, weekday: number, change: (intervals: IntervalDraft[]) => IntervalDraft[]): ScheduleDraft {
  const days = new Map(schedule.days);
  days.set(weekday, change(days.get(weekday) ?? []));
  return { ...schedule, days };
}

export function addInterval(schedules: readonly ScheduleDraft[], scheduleKey: string, weekday: number): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) =>
    withDays(schedule, weekday, (intervals) => {
      // A second interval on the same day is the lunch break: start it after
      // the last one closes so the manager only adjusts the end.
      const last = intervals[intervals.length - 1];
      const opens = last ? last.closes : DEFAULT_OPENS;
      const closes = last ? laterOf(last.closes, DEFAULT_CLOSES) : DEFAULT_CLOSES;
      return [...intervals, newIntervalDraft(opens, closes)];
    }),
  );
}

function laterOf(left: string, right: string): string {
  // `24:00` and not `23:59`: the evaluator is `minutes < closes`, so 23:59 would
  // leave the last minute of the day after-hours.
  return left >= right ? MIDNIGHT_CLOSE : right;
}

export function updateInterval(
  schedules: readonly ScheduleDraft[],
  scheduleKey: string,
  weekday: number,
  intervalKey: string,
  patch: Partial<Pick<IntervalDraft, "opens" | "closes">>,
): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) =>
    withDays(schedule, weekday, (intervals) => intervals.map((interval) => (interval.key === intervalKey ? { ...interval, ...patch } : interval))),
  );
}

export function removeInterval(schedules: readonly ScheduleDraft[], scheduleKey: string, weekday: number, intervalKey: string): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) =>
    withDays(schedule, weekday, (intervals) => intervals.filter((interval) => interval.key !== intervalKey)),
  );
}

/** Copies one weekday's intervals onto the given weekdays (the source day is skipped). */
export function copyDayToWeekdays(schedules: readonly ScheduleDraft[], scheduleKey: string, weekday: number, targets: readonly number[]): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => {
    const source = schedule.days.get(weekday) ?? [];
    const days = new Map(schedule.days);
    for (const target of targets) {
      if (target === weekday) continue;
      days.set(
        target,
        source.map((interval) => newIntervalDraft(interval.opens, interval.closes)),
      );
    }
    return { ...schedule, days };
  });
}

export function addException(schedules: readonly ScheduleDraft[], scheduleKey: string, date: string): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => ({ ...schedule, exceptions: [...schedule.exceptions, newExceptionDraft(date)] }));
}

export function updateException(
  schedules: readonly ScheduleDraft[],
  scheduleKey: string,
  exceptionKey: string,
  patch: Partial<Pick<ExceptionDraft, "date" | "closed" | "label">>,
): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => ({
    ...schedule,
    exceptions: schedule.exceptions.map((exception) => {
      if (exception.key !== exceptionKey) return exception;
      const next = { ...exception, ...patch };
      // "Otvorené inak" needs at least one interval to mean anything; an empty
      // list would be stored as "open all day", which is rarely the intent.
      if (patch.closed === false && next.intervals.length === 0) next.intervals = [newIntervalDraft()];
      return next;
    }),
  }));
}

export function removeException(schedules: readonly ScheduleDraft[], scheduleKey: string, exceptionKey: string): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => ({ ...schedule, exceptions: schedule.exceptions.filter((exception) => exception.key !== exceptionKey) }));
}

function mapExceptionIntervals(
  schedules: readonly ScheduleDraft[],
  scheduleKey: string,
  exceptionKey: string,
  change: (intervals: IntervalDraft[]) => IntervalDraft[],
): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => ({
    ...schedule,
    exceptions: schedule.exceptions.map((exception) => (exception.key === exceptionKey ? { ...exception, intervals: change(exception.intervals) } : exception)),
  }));
}

export function addExceptionInterval(schedules: readonly ScheduleDraft[], scheduleKey: string, exceptionKey: string): ScheduleDraft[] {
  return mapExceptionIntervals(schedules, scheduleKey, exceptionKey, (intervals) => [...intervals, newIntervalDraft()]);
}

export function updateExceptionInterval(
  schedules: readonly ScheduleDraft[],
  scheduleKey: string,
  exceptionKey: string,
  intervalKey: string,
  patch: Partial<Pick<IntervalDraft, "opens" | "closes">>,
): ScheduleDraft[] {
  return mapExceptionIntervals(schedules, scheduleKey, exceptionKey, (intervals) =>
    intervals.map((interval) => (interval.key === intervalKey ? { ...interval, ...patch } : interval)),
  );
}

export function removeExceptionInterval(schedules: readonly ScheduleDraft[], scheduleKey: string, exceptionKey: string, intervalKey: string): ScheduleDraft[] {
  return mapExceptionIntervals(schedules, scheduleKey, exceptionKey, (intervals) => intervals.filter((interval) => interval.key !== intervalKey));
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export function businessHoursPayload(schedules: readonly ScheduleDraft[]): BusinessHoursInput[] {
  return schedules.map((schedule) => ({
    id: schedule.id,
    name: schedule.name.trim(),
    timezone: schedule.timezone.trim() || DEFAULT_TIMEZONE,
    active: schedule.active,
    intervals: WEEKDAYS.flatMap(({ weekday }) =>
      (schedule.days.get(weekday) ?? []).map((interval) => ({ weekday, opens: interval.opens.trim(), closes: interval.closes.trim() })),
    ),
    exceptions: schedule.exceptions.map((exception) => ({
      date: exception.date.trim(),
      closed: exception.closed,
      label: exception.label.trim() ? exception.label.trim() : null,
      intervals: exception.closed ? [] : exception.intervals.map((interval) => ({ opens: interval.opens.trim(), closes: interval.closes.trim() })),
    })),
  }));
}

export function businessHoursDirty(schedules: readonly ScheduleDraft[], original: readonly BusinessHoursDoc[]): boolean {
  return JSON.stringify(businessHoursPayload(schedules)) !== JSON.stringify(businessHoursPayload(scheduleDraftsFromDocument(original)));
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
/**
 * A closing time may also be `24:00` — "open until midnight".
 *
 * `withinAny` compares `minutes < closes`, so `23:59` leaves the last minute of
 * the day after-hours; on a 24/7 assistance line that is one silently closed
 * minute every day. Postgres `time` and `parseClock` both accept `24:00`, and
 * `config-service.ts` mirrors this pattern.
 */
const CLOSE_TIME_PATTERN = /^(([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
export const MIDNIGHT_CLOSE = "24:00";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export type BusinessHoursValidationContext = {
  /** Lines keep a schedule alive: an assigned schedule may not be deleted. */
  lines: readonly LineDoc[];
};

/**
 * Local mirror of `validateBusinessHours`. Paths are draft keys (schedule,
 * interval or exception key) so the editor can hang the message on the row that
 * caused it; `""` belongs to the form as a whole.
 */
export function validateScheduleDrafts(schedules: readonly ScheduleDraft[], context: BusinessHoursValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = new Set<string>();
  const keptIds = new Set(schedules.map((schedule) => schedule.id).filter((id): id is string => Boolean(id)));

  for (const schedule of schedules) {
    const name = schedule.name.trim();
    if (!name) issues.push(issue(schedule.key, "name_required", "Otváracie hodiny potrebujú názov."));
    const nameKey = name.toLocaleLowerCase("sk");
    if (nameKey && names.has(nameKey)) issues.push(issue(schedule.key, "duplicate_name", `Otváracie hodiny s názvom „${name}" už existujú.`));
    names.add(nameKey);

    for (const { weekday, label } of WEEKDAYS) {
      const intervals = schedule.days.get(weekday) ?? [];
      const seen = new Set<string>();
      for (const interval of intervals) {
        if (!TIME_PATTERN.test(interval.opens) || !CLOSE_TIME_PATTERN.test(interval.closes)) {
          issues.push(issue(interval.key, "time_invalid", `${label}: čas musí byť v tvare HH:MM (zatvorenie smie byť aj ${MIDNIGHT_CLOSE}).`));
          continue;
        }
        if (interval.opens >= interval.closes) {
          issues.push(issue(interval.key, "time_order", `${label}: otvorenie musí byť skôr ako zatvorenie.`));
          continue;
        }
        if (seen.has(interval.opens)) issues.push(issue(interval.key, "duplicate_interval", `${label}: rovnaký interval je v zozname dvakrát.`));
        seen.add(interval.opens);
      }
    }

    const seenDates = new Set<string>();
    for (const exception of schedule.exceptions) {
      const date = exception.date.trim();
      if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(date))) {
        issues.push(issue(exception.key, "date_invalid", "Dátum výnimky musí byť v tvare RRRR-MM-DD."));
        continue;
      }
      if (seenDates.has(date)) issues.push(issue(exception.key, "duplicate_date", `Dátum ${date} je vo výnimkách dvakrát.`));
      seenDates.add(date);
      if (exception.closed) continue;
      if (exception.intervals.length === 0) {
        issues.push(issue(exception.key, "exception_intervals_required", "Otvorená výnimka potrebuje aspoň jeden interval, inak by deň platil ako otvorený nonstop."));
        continue;
      }
      for (const interval of exception.intervals) {
        if (!TIME_PATTERN.test(interval.opens) || !CLOSE_TIME_PATTERN.test(interval.closes) || interval.opens >= interval.closes) {
          issues.push(issue(interval.key, "time_invalid", `Interval výnimky musí byť platný (HH:MM, otvorenie pred zatvorením; zatvorenie smie byť aj ${MIDNIGHT_CLOSE}).`));
        }
      }
    }
  }

  for (const line of context.lines) {
    if (line.businessHoursId && !keptIds.has(line.businessHoursId)) {
      issues.push(issue("", "business_hours_in_use", `Otváracie hodiny používa linka ${line.label || line.phoneNumber}, najprv ju prepni na iné.`));
    }
  }

  return issues;
}

/** Weekday intervals that overlap: legal, but almost always a typo — shown as a note. */
export function overlappingWeekdays(schedule: ScheduleDraft): number[] {
  const result: number[] = [];
  for (const { weekday } of WEEKDAYS) {
    const intervals = (schedule.days.get(weekday) ?? [])
      .map((interval) => ({ opens: parseClock(interval.opens), closes: parseClock(interval.closes) }))
      .filter((interval): interval is { opens: number; closes: number } => interval.opens !== null && interval.closes !== null && interval.closes > interval.opens)
      .sort((left, right) => left.opens - right.opens);
    for (let index = 1; index < intervals.length; index += 1) {
      if (intervals[index].opens < intervals[index - 1].closes) {
        result.push(weekday);
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Preview (same evaluator the session runner uses)
// ---------------------------------------------------------------------------

export function scheduleFromDraft(schedule: ScheduleDraft): BusinessHoursSchedule {
  return {
    timezone: schedule.timezone.trim() || DEFAULT_TIMEZONE,
    intervals: WEEKDAYS.flatMap(({ weekday }) => (schedule.days.get(weekday) ?? []).map((interval) => ({ weekday, opens: interval.opens, closes: interval.closes }))),
    exceptions: schedule.exceptions.map((exception) => ({
      date: exception.date.trim(),
      closed: exception.closed,
      label: exception.label.trim() || null,
      intervals: exception.closed ? [] : exception.intervals.map((interval) => ({ opens: interval.opens, closes: interval.closes })),
    })),
  };
}

export function evaluateDraft(schedule: ScheduleDraft, at: Date): BusinessHoursDecision {
  return evaluateBusinessHours(scheduleFromDraft(schedule), at);
}

/** `YYYY-MM-DD` of `at` in the schedule's zone — the default date for a new exception. */
export function todayInSchedule(schedule: ScheduleDraft, at: Date): string {
  return localDateParts(at, schedule.timezone.trim() || DEFAULT_TIMEZONE).date;
}

/** One line per weekday: `Pondelok: 07:00 – 12:00, 12:30 – 19:00` / `Zatvorené`. */
export function describeWeek(schedule: ScheduleDraft): Array<{ weekday: number; label: string; text: string; open: boolean }> {
  return WEEKDAYS.map(({ weekday, label }) => {
    const intervals = (schedule.days.get(weekday) ?? []).filter((interval) => TIME_PATTERN.test(interval.opens) && CLOSE_TIME_PATTERN.test(interval.closes));
    if (intervals.length === 0) return { weekday, label, text: "Zatvorené", open: false };
    const text = [...intervals]
      .sort((left, right) => left.opens.localeCompare(right.opens))
      .map((interval) => `${interval.opens} – ${interval.closes}`)
      .join(", ");
    return { weekday, label, text, open: true };
  });
}

/** `true` when no weekday has an interval — such a schedule closes the line every day. */
export function isEmptySchedule(schedule: ScheduleDraft): boolean {
  return WEEKDAYS.every(({ weekday }) => (schedule.days.get(weekday) ?? []).length === 0);
}

/** Sentence under the schedule header: is it open right now, and why. */
export function describeNow(schedule: ScheduleDraft, at: Date): string {
  if (isEmptySchedule(schedule) && schedule.exceptions.length === 0) {
    return "Rozvrh nemá žiadny interval — linka s ním by bola zatvorená každý deň.";
  }
  const decision = evaluateDraft(schedule, at);
  const clock = decision.local ? `${String(decision.local.hour).padStart(2, "0")}:${String(decision.local.minute).padStart(2, "0")}` : "";
  const zone = schedule.timezone.trim() || DEFAULT_TIMEZONE;
  const stamp = clock ? ` (${clock}, ${zone})` : "";
  switch (decision.reason) {
    case "exception_closed":
      return `Teraz zatvorené — výnimka${decision.exceptionLabel ? ` „${decision.exceptionLabel}"` : ""}${stamp}.`;
    case "exception_open":
      return `Teraz otvorené podľa výnimky${decision.exceptionLabel ? ` „${decision.exceptionLabel}"` : ""}${stamp}.`;
    case "exception_outside":
      return `Teraz zatvorené — mimo intervalov výnimky${decision.exceptionLabel ? ` „${decision.exceptionLabel}"` : ""}${stamp}.`;
    case "interval":
      return `Teraz otvorené${stamp}.`;
    case "outside":
      return `Teraz zatvorené — mimo otváracích hodín${stamp}.`;
    default:
      return "Rozvrh sa nedá vyhodnotiť.";
  }
}

/** Short label for one exception row. */
export function describeException(exception: ExceptionDraft): string {
  if (exception.closed) return "Zatvorené celý deň";
  const valid = exception.intervals.filter((interval) => TIME_PATTERN.test(interval.opens) && CLOSE_TIME_PATTERN.test(interval.closes));
  if (valid.length === 0) return "Otvorené (bez intervalu)";
  return `Otvorené ${valid.map((interval) => `${interval.opens} – ${interval.closes}`).join(", ")}`;
}

/** Replaces one weekday with a single `00:00 – 24:00` interval ("otvorené nonstop"). */
export function setDayAroundTheClock(schedules: readonly ScheduleDraft[], scheduleKey: string, weekday: number): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => withDays(schedule, weekday, () => [newIntervalDraft("00:00", MIDNIGHT_CLOSE)]));
}

/** Empties one weekday (the counterpart of "otvorené nonstop"). */
export function clearDay(schedules: readonly ScheduleDraft[], scheduleKey: string, weekday: number): ScheduleDraft[] {
  return mapSchedule(schedules, scheduleKey, (schedule) => withDays(schedule, weekday, () => []));
}

/** `true` when the weekday is a single interval covering the whole day. */
export function isAroundTheClock(schedule: ScheduleDraft, weekday: number): boolean {
  const intervals = schedule.days.get(weekday) ?? [];
  return intervals.length === 1 && intervals[0].opens === "00:00" && intervals[0].closes === MIDNIGHT_CLOSE;
}

/** Names of the lines that use a saved schedule; the editor shows it as a note. */
export function linesUsingSchedule(scheduleId: string | null, lines: readonly LineDoc[]): string[] {
  if (!scheduleId) return [];
  return lines.filter((line) => line.businessHoursId === scheduleId).map((line) => line.label || line.phoneNumber);
}
