import { MOTORIST_TIME_ZONE } from "@/domain/time";

export type ReportRangeKey = "today" | "7d" | "30d";

export type ReportChartPoint = {
  label: string;
  value: number;
};

export type ReportOperatorRow = {
  id: string;
  name: string;
  totalCalls: number;
  answeredCalls: number;
  outboundCalls: number;
  talkSeconds: number;
  averageDurationSeconds: number;
  linkedCases: number;
  completedTasks: number;
  workedMinutes: number;
};

export type ReportDashboardData = {
  generatedAt: string;
  range: {
    key: ReportRangeKey;
    label: string;
    from: string;
    to: string;
  };
  overview: {
    totalCalls: number;
    answerRate: number | null;
    answeredInboundCalls: number;
    completedInboundCalls: number;
    medianWaitSeconds: number | null;
    serviceLevel: number | null;
    newCases: number;
    completedCases: number;
    openTasks: number;
    overdueTasks: number;
    callsByDay: ReportChartPoint[];
    callResults: ReportChartPoint[];
    caseFlow: ReportChartPoint[];
  };
  calls: {
    inboundCalls: number;
    outboundCalls: number;
    answeredCalls: number;
    missedCalls: number;
    totalTalkSeconds: number;
    averageDurationSeconds: number;
    averageWaitSeconds: number | null;
    waitSampleSize: number;
    linkedToCaseRate: number;
    byDay: ReportChartPoint[];
    byHour: ReportChartPoint[];
    directions: ReportChartPoint[];
    results: ReportChartPoint[];
    waitBuckets: ReportChartPoint[];
  };
  operators: {
    rows: ReportOperatorRow[];
    callsByOperator: ReportChartPoint[];
    talkTimeByOperator: ReportChartPoint[];
  };
  cases: {
    created: number;
    completed: number;
    active: number;
    futileTrips: number;
    replacementVehicles: number;
    averageClosureHours: number;
    byDay: ReportChartPoint[];
    statuses: ReportChartPoint[];
    sources: ReportChartPoint[];
    priorities: ReportChartPoint[];
    jobTypes: ReportChartPoint[];
  };
};

export type ReportCallRow = {
  id: string;
  status: string;
  direction: "inbound" | "outbound" | "internal";
  operator_id: string | null;
  case_id: string | null;
  started_at: string | null;
  answered_at: string | null;
  wait_seconds: number | null;
  duration_seconds: number | null;
};

export type ReportCaseRow = {
  id: string;
  status: string;
  priority: string;
  source_type: string | null;
  owner_id: string | null;
  vehicle_details: unknown;
  replacement_vehicle_details: unknown;
  created_at: string;
  closed_at: string | null;
};

export type ReportTaskRow = {
  assigned_to: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
  due_at: string | null;
  status: string;
};

export type ReportAttendanceRow = {
  profile_id: string;
  started_at: string;
  ended_at: string | null;
};

export type ReportProfileRow = {
  id: string;
  display_name: string;
};

export function resolveReportRange(key: ReportRangeKey, now = new Date()) {
  const normalizedKey: ReportRangeKey = key === "today" || key === "30d" ? key : "7d";
  const today = localDateKey(now.toISOString()) ?? now.toISOString().slice(0, 10);
  const days = normalizedKey === "today" ? 1 : normalizedKey === "30d" ? 30 : 7;
  const fromDate = addLocalDays(today, -(days - 1));
  const toDate = addLocalDays(today, 1);

  return {
    key: normalizedKey,
    label: normalizedKey === "today" ? "Dnes" : normalizedKey === "30d" ? "Posledných 30 dní" : "Posledných 7 dní",
    from: localMidnightToIso(fromDate),
    to: localMidnightToIso(toDate),
  };
}

export function buildReportDashboard(input: {
  range: ReturnType<typeof resolveReportRange>;
  calls: ReportCallRow[];
  cases: ReportCaseRow[];
  tasks: ReportTaskRow[];
  attendance: ReportAttendanceRow[];
  profiles: ReportProfileRow[];
  now?: Date;
}): ReportDashboardData {
  const { attendance, calls, cases, profiles, range, tasks } = input;
  const now = input.now ?? new Date();
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const inRange = (value: string | null | undefined) => {
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) && time >= fromMs && time < toMs;
  };
  const periodCalls = calls.filter((call) => inRange(call.started_at));
  const createdCases = cases.filter((caseItem) => inRange(caseItem.created_at));
  const completedCases = cases.filter((caseItem) => inRange(caseItem.closed_at));
  const inboundCalls = periodCalls.filter((call) => call.direction === "inbound");
  const outboundCalls = periodCalls.filter((call) => call.direction === "outbound");
  const answeredInbound = inboundCalls.filter(isAnsweredCall);
  const missedInbound = inboundCalls.filter(isMissedCall);
  const answeredOrMissed = answeredInbound.length + missedInbound.length;
  const answeredWaits = answeredInbound.map(callWaitSeconds).filter(isFiniteNumber);
  const connectedCalls = periodCalls.filter(isAnsweredCall);
  const durations = connectedCalls.map((call) => safeNonNegative(call.duration_seconds)).filter(isFiniteNumber);
  const totalTalkSeconds = sum(durations);
  const openTasks = tasks.filter((task) => task.status === "open" || task.status === "overdue");
  const overdueTasks = openTasks.filter((task) => task.status === "overdue" || Boolean(task.due_at && Date.parse(task.due_at) < now.getTime()));
  const completedInRange = tasks.filter((task) => task.status === "done" && inRange(task.completed_at));
  const activeCases = createdCases.filter((caseItem) => !terminalCaseStatuses.has(caseItem.status));
  const completedCreatedCases = createdCases.filter((caseItem) => completedCaseStatuses.has(caseItem.status));
  const futileTrips = createdCases.filter((caseItem) => caseItem.status === "futile_trip");
  const closureHours = completedCases
    .map((caseItem) => elapsedHours(caseItem.created_at, caseItem.closed_at))
    .filter(isFiniteNumber);
  const dateKeys = dateKeysInRange(range.from, range.to);
  const callsByDate = countBy(periodCalls, (call) => localDateKey(call.started_at));
  const casesByDate = countBy(createdCases, (caseItem) => localDateKey(caseItem.created_at));
  const operatorRows = profiles
    .map((profile) => buildOperatorRow({
      profile,
      calls: periodCalls,
      cases: createdCases,
      tasks: completedInRange,
      attendance,
      fromMs,
      toMs,
    }))
    .filter((row) => row.totalCalls > 0 || row.linkedCases > 0 || row.completedTasks > 0 || row.workedMinutes > 0)
    .sort((left, right) => right.totalCalls - left.totalCalls || right.talkSeconds - left.talkSeconds || left.name.localeCompare(right.name, "sk"));
  const unassignedCalls = periodCalls.filter((call) => !call.operator_id);

  if (unassignedCalls.length > 0) {
    operatorRows.push({
      id: "unassigned",
      name: "Nepriradené",
      totalCalls: unassignedCalls.length,
      answeredCalls: unassignedCalls.filter(isAnsweredCall).length,
      outboundCalls: unassignedCalls.filter((call) => call.direction === "outbound").length,
      talkSeconds: sum(unassignedCalls.map((call) => safeNonNegative(call.duration_seconds)).filter(isFiniteNumber)),
      averageDurationSeconds: roundedAverage(unassignedCalls.map((call) => safeNonNegative(call.duration_seconds)).filter(isFiniteNumber)),
      linkedCases: unassignedCalls.filter((call) => call.case_id).length,
      completedTasks: 0,
      workedMinutes: 0,
    });
  }

  return {
    generatedAt: now.toISOString(),
    range,
    overview: {
      totalCalls: periodCalls.length,
      answerRate: answeredOrMissed > 0 ? percentage(answeredInbound.length, answeredOrMissed) : null,
      answeredInboundCalls: answeredInbound.length,
      completedInboundCalls: answeredOrMissed,
      medianWaitSeconds: answeredWaits.length > 0 ? Math.round(median(answeredWaits)) : null,
      serviceLevel: answeredWaits.length > 0
        ? percentage(answeredWaits.filter((seconds) => seconds <= 30).length, answeredWaits.length)
        : null,
      newCases: createdCases.length,
      completedCases: completedCases.length,
      openTasks: openTasks.length,
      overdueTasks: overdueTasks.length,
      callsByDay: dateKeys.map((key) => ({ label: shortDateLabel(key), value: callsByDate.get(key) ?? 0 })),
      callResults: callResultPoints(periodCalls),
      caseFlow: [
        { label: "Aktívne", value: activeCases.length },
        { label: "Ukončené", value: completedCreatedCases.length },
        { label: "Márny výjazd", value: futileTrips.length },
        { label: "Zrušené", value: createdCases.filter((caseItem) => caseItem.status === "cancelled" || caseItem.status === "rejected").length },
      ],
    },
    calls: {
      inboundCalls: inboundCalls.length,
      outboundCalls: outboundCalls.length,
      answeredCalls: answeredInbound.length,
      missedCalls: missedInbound.length,
      totalTalkSeconds,
      averageDurationSeconds: roundedAverage(durations),
      averageWaitSeconds: answeredWaits.length > 0 ? roundedAverage(answeredWaits) : null,
      waitSampleSize: answeredWaits.length,
      linkedToCaseRate: percentage(periodCalls.filter((call) => call.case_id).length, periodCalls.length),
      byDay: dateKeys.map((key) => ({ label: shortDateLabel(key), value: callsByDate.get(key) ?? 0 })),
      byHour: twoHourBuckets(periodCalls),
      directions: [
        { label: "Prichádzajúce", value: inboundCalls.length },
        { label: "Odchádzajúce", value: outboundCalls.length },
        { label: "Interné", value: periodCalls.filter((call) => call.direction === "internal").length },
      ],
      results: callResultPoints(periodCalls),
      waitBuckets: [
        { label: "0–10 s", value: answeredWaits.filter((seconds) => seconds <= 10).length },
        { label: "11–30 s", value: answeredWaits.filter((seconds) => seconds > 10 && seconds <= 30).length },
        { label: "31–60 s", value: answeredWaits.filter((seconds) => seconds > 30 && seconds <= 60).length },
        { label: "> 60 s", value: answeredWaits.filter((seconds) => seconds > 60).length },
      ],
    },
    operators: {
      rows: operatorRows,
      callsByOperator: operatorRows.slice(0, 10).map((row) => ({ label: row.name, value: row.totalCalls })),
      talkTimeByOperator: operatorRows.slice(0, 10).map((row) => ({ label: row.name, value: Math.round(row.talkSeconds / 60) })),
    },
    cases: {
      created: createdCases.length,
      completed: completedCases.length,
      active: activeCases.length,
      futileTrips: futileTrips.length,
      replacementVehicles: createdCases.filter(replacementVehicleNeeded).length,
      averageClosureHours: roundedAverage(closureHours),
      byDay: dateKeys.map((key) => ({ label: shortDateLabel(key), value: casesByDate.get(key) ?? 0 })),
      statuses: topCounts(createdCases, (caseItem) => caseStatusLabel(caseItem.status), 7),
      sources: topCounts(createdCases, (caseItem) => sourceLabel(caseItem.source_type), 6),
      priorities: topCounts(createdCases, (caseItem) => priorityLabel(caseItem.priority), 4),
      jobTypes: topCounts(createdCases.flatMap(caseJobTypes), (jobType) => jobTypeLabel(jobType), 6),
    },
  };
}

function buildOperatorRow(input: {
  profile: ReportProfileRow;
  calls: ReportCallRow[];
  cases: ReportCaseRow[];
  tasks: ReportTaskRow[];
  attendance: ReportAttendanceRow[];
  fromMs: number;
  toMs: number;
}): ReportOperatorRow {
  const operatorCalls = input.calls.filter((call) => call.operator_id === input.profile.id);
  const durations = operatorCalls
    .filter(isAnsweredCall)
    .map((call) => safeNonNegative(call.duration_seconds))
    .filter(isFiniteNumber);
  const workedMs = input.attendance
    .filter((session) => session.profile_id === input.profile.id)
    .reduce((total, session) => {
      const start = Math.max(Date.parse(session.started_at), input.fromMs);
      const rawEnd = session.ended_at ? Date.parse(session.ended_at) : input.toMs;
      const end = Math.min(Number.isFinite(rawEnd) ? rawEnd : input.toMs, input.toMs);
      return end > start ? total + end - start : total;
    }, 0);

  return {
    id: input.profile.id,
    name: input.profile.display_name,
    totalCalls: operatorCalls.length,
    answeredCalls: operatorCalls.filter(isAnsweredCall).length,
    outboundCalls: operatorCalls.filter((call) => call.direction === "outbound").length,
    talkSeconds: sum(durations),
    averageDurationSeconds: roundedAverage(durations),
    linkedCases: new Set([
      ...operatorCalls.map((call) => call.case_id).filter(Boolean),
      ...input.cases.filter((caseItem) => caseItem.owner_id === input.profile.id).map((caseItem) => caseItem.id),
    ]).size,
    completedTasks: input.tasks.filter((task) => (task.completed_by ?? task.assigned_to) === input.profile.id).length,
    workedMinutes: Math.round(workedMs / 60_000),
  };
}

function isAnsweredCall(call: ReportCallRow) {
  return Boolean(call.answered_at) || call.status === "answered" || call.status === "ended";
}

function callWaitSeconds(call: ReportCallRow) {
  const storedWait = safeNonNegative(call.wait_seconds);
  const startedAt = call.started_at ? Date.parse(call.started_at) : Number.NaN;
  const answeredAt = call.answered_at ? Date.parse(call.answered_at) : Number.NaN;
  const timestampWait = Number.isFinite(startedAt) && Number.isFinite(answeredAt) && answeredAt >= startedAt
    ? (answeredAt - startedAt) / 1000
    : Number.NaN;

  if (Number.isFinite(timestampWait) && (!Number.isFinite(storedWait) || (storedWait === 0 && timestampWait > 0))) {
    return timestampWait;
  }

  return storedWait;
}

function isMissedCall(call: ReportCallRow) {
  return !isAnsweredCall(call) && ["missed", "abandoned_queue", "failed"].includes(call.status);
}

function callResultPoints(calls: ReportCallRow[]): ReportChartPoint[] {
  const answered = calls.filter((call) => call.direction === "inbound" && isAnsweredCall(call)).length;
  const missed = calls.filter((call) => call.direction === "inbound" && isMissedCall(call)).length;
  const outbound = calls.filter((call) => call.direction === "outbound").length;
  return [
    { label: "Prijaté", value: answered },
    { label: "Zmeškané", value: missed },
    { label: "Odchádzajúce", value: outbound },
    { label: "Ostatné", value: Math.max(0, calls.length - answered - missed - outbound) },
  ];
}

function twoHourBuckets(calls: ReportCallRow[]): ReportChartPoint[] {
  const counts = Array.from({ length: 12 }, () => 0);
  for (const call of calls) {
    if (!call.started_at) continue;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: MOTORIST_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(new Date(call.started_at)));
    if (Number.isFinite(hour)) counts[Math.min(11, Math.floor(hour / 2))] += 1;
  }
  return counts.map((value, index) => ({
    label: `${String(index * 2).padStart(2, "0")}–${String(index * 2 + 2).padStart(2, "0")}`,
    value,
  }));
}

function topCounts<T>(items: T[], key: (item: T) => string, limit: number): ReportChartPoint[] {
  return [...countBy(items, key).entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, "sk"))
    .slice(0, limit);
}

function countBy<T>(items: T[], key: (item: T) => string | undefined) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function replacementVehicleNeeded(caseItem: ReportCaseRow) {
  return readJsonObject(caseItem.replacement_vehicle_details)?.needed === true;
}

function caseJobTypes(caseItem: ReportCaseRow) {
  const values = readJsonObject(caseItem.vehicle_details)?.jobTypes;
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

function readJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function elapsedHours(start: string, end: string | null) {
  if (!end) return Number.NaN;
  const elapsed = Date.parse(end) - Date.parse(start);
  return elapsed >= 0 ? elapsed / 3_600_000 : Number.NaN;
}

function safeNonNegative(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

function isFiniteNumber(value: number): value is number {
  return Number.isFinite(value);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function roundedAverage(values: number[]) {
  return values.length > 0 ? Math.round(sum(values) / values.length) : 0;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentage(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

/** Local (Europe/Bratislava) calendar day of an instant, `YYYY-MM-DD`. Exported for the
 * telephony statistics, which group by the same day the wall clock shows. */
export function localDateKey(value: string | null | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MOTORIST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateKeysInRange(from: string, to: string) {
  const first = localDateKey(from);
  const lastExclusive = localDateKey(to);
  if (!first || !lastExclusive) return [];
  const keys: string[] = [];
  for (let key = first; key < lastExclusive; key = addLocalDays(key, 1)) keys.push(key);
  return keys;
}

function addLocalDays(dateLocal: string, days: number) {
  const [year, month, day] = dateLocal.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function localMidnightToIso(dateLocal: string) {
  const [year, month, day] = dateLocal.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: MOTORIST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const represented = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    guess -= represented - target;
  }

  return new Date(guess).toISOString();
}

function shortDateLabel(dateLocal: string) {
  const [, month, day] = dateLocal.split("-");
  return `${day}.${month}.`;
}

function caseStatusLabel(value: string) {
  const labels: Record<string, string> = {
    new: "Nové",
    triage: "Triedenie",
    open: "Otvorené",
    waiting_for_client: "Čaká na klienta",
    scheduled: "Naplánované",
    assigned: "Priradené",
    dispatched: "Vyslané",
    in_progress: "Prebieha",
    waiting_for_docs: "Čaká na doklady",
    completed_assisted: "Ukončené s pomocou",
    completed_no_assistance: "Ukončené bez pomoci",
    rejected: "Odmietnuté",
    cancelled: "Zrušené",
    futile_trip: "Márny výjazd",
  };
  return labels[value] ?? value;
}

function sourceLabel(value: string | null) {
  const labels: Record<string, string> = {
    client: "Klient",
    assistance: "Asistenčná služba",
    samoplatca: "Samoplatca",
    partner: "Partner",
    internal: "Interné",
  };
  return value ? labels[value] ?? value : "Nezadané";
}

function priorityLabel(value: string) {
  const labels: Record<string, string> = { urgent: "Urgentné", high: "Vysoké", normal: "Normálne", low: "Nízke" };
  return labels[value] ?? value;
}

function jobTypeLabel(value: string) {
  const labels: Record<string, string> = {
    tow: "Odťah",
    replacement_vehicle: "Náhradné vozidlo",
    onsite_assistance: "Pomoc na mieste",
    vehicle_recovery: "Vyslobodenie vozidla",
  };
  return labels[value] ?? value;
}

const completedCaseStatuses = new Set(["completed_assisted", "completed_no_assistance"]);
const terminalCaseStatuses = new Set(["completed_assisted", "completed_no_assistance", "rejected", "cancelled", "futile_trip"]);
