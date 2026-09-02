import type {
  AttendanceAvailabilityStatus,
  AttendanceAvailabilityLevel,
  AttendanceCoverageGap,
  AttendanceData,
  AttendanceDaySummary,
  AttendanceEmployeeSettings,
  AttendancePlanningWarning,
  AttendancePlanningWarningCode,
  AttendanceScheduleBatch,
  AttendanceSession,
  AttendanceShift,
  AttendanceShiftStatus,
  AttendanceShiftTemplate,
  AttendanceTimeOffBalance,
  AttendanceUnavailabilityRequest,
  Operator,
} from "@/domain/types";

type AttendanceOverviewInput = {
  timezone: string;
  templates: AttendanceShiftTemplate[];
  shifts: AttendanceShift[];
  sessions: AttendanceSession[];
  operators?: Operator[];
  employeeSettings?: AttendanceEmployeeSettings[];
  unavailabilityRequests?: AttendanceUnavailabilityRequest[];
  timeOffBalances?: AttendanceTimeOffBalance[];
  scheduleBatches?: AttendanceScheduleBatch[];
  referenceDate?: Date;
};

const COVERAGE_STATUSES = new Set<AttendanceShiftStatus>(["published", "confirmed", "completed"]);

export function buildAttendanceOverview({
  timezone,
  templates,
  shifts,
  sessions,
  operators = [],
  employeeSettings = [],
  unavailabilityRequests = [],
  timeOffBalances = [],
  scheduleBatches = [],
  referenceDate = new Date(),
}: AttendanceOverviewInput): AttendanceData {
  const today = formatDateInTimeZone(referenceDate, timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const days = datesInMonth(monthStart).map((dateLocal) => buildDaySummary(dateLocal, timezone, shifts, today));
  const normalizedEmployeeSettings = normalizeEmployeeSettings(operators, employeeSettings);
  const availabilityByDate = buildAvailabilityByDate({
    days,
    employeeSettings: normalizedEmployeeSettings,
    requests: unavailabilityRequests,
    shifts,
  });
  const planningWarnings = Object.values(availabilityByDate).flatMap((availability) => availability.flatMap((item) => item.reasons));

  return {
    timezone,
    monthStart,
    templates,
    shifts,
    sessions,
    employeeSettings: normalizedEmployeeSettings,
    unavailabilityRequests,
    timeOffBalances,
    scheduleBatches,
    availabilityByDate,
    planningWarnings,
    days,
  };
}

export function formatDateInTimeZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));

  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

export function formatMinuteRange(startMinute: number, endMinute: number) {
  return `${formatMinute(startMinute)}-${formatMinute(endMinute)}`;
}

export function formatShiftTimeRange(shift: Pick<AttendanceShift, "plannedStartAt" | "plannedEndAt" | "timezone">) {
  const start = zonedDateTimeParts(new Date(shift.plannedStartAt), shift.timezone);
  const end = zonedDateTimeParts(new Date(shift.plannedEndAt), shift.timezone);

  return `${start.time}-${end.time}`;
}

export function localDateTimeToIso(dateLocal: string, timeLocal: string) {
  const value = new Date(`${dateLocal}T${timeLocal}`);

  if (!Number.isFinite(value.getTime())) {
    return null;
  }

  return value.toISOString();
}

export function addDays(dateLocal: string, days: number) {
  const date = new Date(`${dateLocal}T00:00:00`);
  date.setDate(date.getDate() + days);

  return toInputDate(date);
}

export function toInputDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function minutesBetween(startAt: string, endAt: string) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();

  return Math.max(0, Math.round((end - start) / 60_000));
}

function buildDaySummary(dateLocal: string, timezone: string, allShifts: AttendanceShift[], today: string): AttendanceDaySummary {
  const shifts = allShifts
    .filter((shift) => shiftOverlapsDate(shift, dateLocal, timezone))
    .sort((left, right) => new Date(left.plannedStartAt).getTime() - new Date(right.plannedStartAt).getTime());
  const gaps = coverageGaps(dateLocal, timezone, shifts);
  const confirmedCount = shifts.filter((shift) => shift.status === "confirmed" || shift.status === "completed").length;
  const pendingCount = shifts.filter((shift) => shift.status === "published").length;

  return {
    dateLocal,
    isToday: dateLocal === today,
    shifts,
    gaps,
    status: gaps.length > 0 ? "gap" : pendingCount > 0 ? "pending" : "covered",
    plannedCount: shifts.length,
    confirmedCount,
    pendingCount,
  };
}

function coverageGaps(dateLocal: string, timezone: string, shifts: AttendanceShift[]): AttendanceCoverageGap[] {
  const intervals = shifts
    .filter((shift) => COVERAGE_STATUSES.has(shift.status))
    .map((shift) => shiftIntervalForDate(shift, dateLocal, timezone))
    .filter(isPositiveInterval)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = mergeIntervals(intervals);
  const gaps: AttendanceCoverageGap[] = [];
  let cursor = 0;

  merged.forEach((interval, index) => {
    if (interval.start > cursor) {
      gaps.push({
        id: `${dateLocal}-gap-${index}`,
        dateLocal,
        startMinute: cursor,
        endMinute: interval.start,
        label: formatMinuteRange(cursor, interval.start),
      });
    }

    cursor = Math.max(cursor, interval.end);
  });

  if (cursor < 1440) {
    gaps.push({
      id: `${dateLocal}-gap-end`,
      dateLocal,
      startMinute: cursor,
      endMinute: 1440,
      label: formatMinuteRange(cursor, 1440),
    });
  }

  return gaps;
}

function isPositiveInterval(interval: { start: number; end: number } | null): interval is { start: number; end: number } {
  return interval ? interval.end > interval.start : false;
}

function shiftOverlapsDate(shift: AttendanceShift, dateLocal: string, timezone: string) {
  return Boolean(shiftIntervalForDate(shift, dateLocal, timezone));
}

function shiftIntervalForDate(shift: AttendanceShift, dateLocal: string, timezone: string) {
  const start = zonedDateTimeParts(new Date(shift.plannedStartAt), timezone);
  const end = zonedDateTimeParts(new Date(shift.plannedEndAt), timezone);

  if (end.date < dateLocal || start.date > dateLocal) {
    return null;
  }

  if (end.date === dateLocal && end.minuteOfDay === 0 && start.date < dateLocal) {
    return { start: 0, end: 0 };
  }

  const startMinute = start.date < dateLocal ? 0 : start.minuteOfDay;
  const endMinute = end.date > dateLocal ? 1440 : end.minuteOfDay === 0 && end.date > start.date ? 1440 : end.minuteOfDay;

  return { start: Math.max(0, startMinute), end: Math.min(1440, endMinute) };
}

function zonedDateTimeParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const hour = byType.get("hour") === "24" ? "00" : (byType.get("hour") ?? "00");
  const minute = byType.get("minute") ?? "00";

  return {
    date: `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
    minuteOfDay: Number(hour) * 60 + Number(minute),
    time: `${hour}:${minute}`,
  };
}

function mergeIntervals(intervals: Array<{ start: number; end: number }>) {
  return intervals.reduce<Array<{ start: number; end: number }>>((merged, interval) => {
    const previous = merged.at(-1);

    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
      return merged;
    }

    previous.end = Math.max(previous.end, interval.end);
    return merged;
  }, []);
}

function datesInMonth(monthStart: string) {
  const [year, month] = monthStart.split("-").map(Number);
  const count = new Date(year, month, 0).getDate();

  return Array.from({ length: count }, (_, index) => `${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`);
}

function normalizeEmployeeSettings(operators: Operator[], settings: AttendanceEmployeeSettings[]) {
  const settingsByProfile = new Map(settings.map((setting) => [setting.profileId, setting]));
  const fromOperators = operators.map((operator) => {
    const existing = settingsByProfile.get(operator.id);

    return {
      id: existing?.id ?? `settings-${operator.id}`,
      profileId: operator.id,
      operatorName: existing?.operatorName ?? operator.name,
      operatorExtension: existing?.operatorExtension ?? operator.extension,
      defaultAvailable: existing?.defaultAvailable ?? true,
      active: existing?.active ?? operator.status !== "offline",
      vacationDaysPerYear: existing?.vacationDaysPerYear ?? 20,
      maxWeeklyMinutes: existing?.maxWeeklyMinutes,
      notes: existing?.notes,
    };
  });
  const operatorIds = new Set(operators.map((operator) => operator.id));
  const extraSettings = settings.filter((setting) => !operatorIds.has(setting.profileId));

  return [...fromOperators, ...extraSettings];
}

function buildAvailabilityByDate({
  days,
  employeeSettings,
  requests,
  shifts,
}: {
  days: AttendanceDaySummary[];
  employeeSettings: AttendanceEmployeeSettings[];
  requests: AttendanceUnavailabilityRequest[];
  shifts: AttendanceShift[];
}) {
  const plannedMinutesByProfile = new Map<string, number>();

  shifts.forEach((shift) => {
    plannedMinutesByProfile.set(shift.profileId, (plannedMinutesByProfile.get(shift.profileId) ?? 0) + minutesBetween(shift.plannedStartAt, shift.plannedEndAt));
  });

  return days.reduce<Record<string, AttendanceAvailabilityStatus[]>>((byDate, day) => {
    byDate[day.dateLocal] = employeeSettings
      .map((setting) => {
        const reasons = availabilityReasonsForDate(day.dateLocal, setting, requests, shifts);
        const hasBlocked = reasons.some((reason) => reason.severity === "blocked");
        const status: AttendanceAvailabilityLevel = hasBlocked ? "blocked" : reasons.length > 0 ? "warning" : "available";

        return {
          dateLocal: day.dateLocal,
          profileId: setting.profileId,
          operatorName: setting.operatorName,
          status,
          plannedMinutesInMonth: plannedMinutesByProfile.get(setting.profileId) ?? 0,
          reasons,
        };
      })
      .sort(compareAvailability);

    return byDate;
  }, {});
}

function availabilityReasonsForDate(
  dateLocal: string,
  setting: AttendanceEmployeeSettings,
  requests: AttendanceUnavailabilityRequest[],
  shifts: AttendanceShift[],
): AttendancePlanningWarning[] {
  const reasons: AttendancePlanningWarning[] = [];

  if (!setting.active || !setting.defaultAvailable) {
    reasons.push(planningWarning(dateLocal, setting, "inactive_profile", "Neaktívny profil", "blocked"));
  }

  requests
    .filter((request) => request.profileId === setting.profileId && requestOverlapsDate(request, dateLocal))
    .forEach((request) => {
      if (request.status === "approved") {
        reasons.push(
          planningWarning(
            dateLocal,
            setting,
            request.type === "unavailable" ? "approved_unavailability" : "approved_vacation",
            request.type === "unavailable" ? "Nedostupnosť" : "Dovolenka",
            "blocked",
            { requestId: request.id },
          ),
        );
      }

      if (request.status === "pending") {
        reasons.push(planningWarning(dateLocal, setting, "pending_time_off", "Pending voľno", "warning", { requestId: request.id }));
      }
    });

  shifts
    .filter((shift) => shift.profileId === setting.profileId && shift.dateLocal === dateLocal && !["cancelled", "declined"].includes(shift.status))
    .forEach((shift) => {
      reasons.push(planningWarning(dateLocal, setting, "existing_shift", "Už má smenu", "blocked", { shiftId: shift.id }));
    });

  const dayStart = new Date(`${dateLocal}T00:00:00`).getTime();
  shifts
    .filter((shift) => shift.profileId === setting.profileId && !["cancelled", "declined"].includes(shift.status))
    .forEach((shift) => {
      const shiftEnd = new Date(shift.plannedEndAt).getTime();
      const shiftStart = new Date(shift.plannedStartAt).getTime();

      if (shiftStart < dayStart && shiftEnd > dayStart) {
        reasons.push(planningWarning(dateLocal, setting, "previous_night_shift", "Nočná predtým", "warning", { shiftId: shift.id }));
        return;
      }

      if (shiftEnd <= dayStart && dayStart - shiftEnd < 12 * 60 * 60 * 1000) {
        reasons.push(planningWarning(dateLocal, setting, "previous_night_shift", "Nočná predtým", "warning", { shiftId: shift.id }));
      }
    });

  return dedupeWarnings(reasons);
}

function requestOverlapsDate(request: AttendanceUnavailabilityRequest, dateLocal: string) {
  return request.startDateLocal <= dateLocal && request.endDateLocal >= dateLocal && ["approved", "pending"].includes(request.status);
}

function planningWarning(
  dateLocal: string,
  setting: AttendanceEmployeeSettings,
  code: AttendancePlanningWarningCode,
  label: string,
  severity: AttendancePlanningWarning["severity"],
  extra: Pick<AttendancePlanningWarning, "requestId" | "shiftId"> = {},
): AttendancePlanningWarning {
  return {
    id: `${dateLocal}-${setting.profileId}-${code}-${extra.requestId ?? extra.shiftId ?? "profile"}`,
    dateLocal,
    profileId: setting.profileId,
    operatorName: setting.operatorName,
    code,
    label,
    severity,
    ...extra,
  };
}

function dedupeWarnings(warnings: AttendancePlanningWarning[]) {
  const byId = new Map(warnings.map((warning) => [warning.id, warning]));
  return [...byId.values()];
}

function compareAvailability(left: AttendanceAvailabilityStatus, right: AttendanceAvailabilityStatus) {
  const statusRank = { available: 0, warning: 1, blocked: 2 };

  return (
    statusRank[left.status] - statusRank[right.status] ||
    left.plannedMinutesInMonth - right.plannedMinutesInMonth ||
    left.operatorName.localeCompare(right.operatorName, "sk")
  );
}

function formatMinute(minute: number) {
  if (minute >= 1440) {
    return "24:00";
  }

  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
