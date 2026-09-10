import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";

export const PAUSE_ENDING_WARNING_LEAD_MS = 60_000;
/** An overdue notice stops making sense for a pause nobody ended in half a day. */
export const PAUSE_OVERDUE_NOTICE_MAX_AGE_MS = 12 * 60 * 60_000;

export type PauseEndingSchedule = {
  pauseStartedAt: string;
  warningAt: string;
  plannedEndAt: string;
};

/**
 * The configured pause-reason maximum is the planned duration. It is only a
 * reminder boundary: reaching it never changes operator presence — the
 * operator gets a warning a minute ahead, an overdue notice once it passes,
 * and switches back to available by hand.
 */
export function pauseEndingSchedule(input: {
  status: OperatorPresenceStatus | string | null | undefined;
  statusSince: string | null | undefined;
  maxMinutes: number | null | undefined;
}): PauseEndingSchedule | null {
  if (input.status !== "paused" || !Number.isInteger(input.maxMinutes) || input.maxMinutes! <= 0) return null;
  const startedAt = Date.parse(input.statusSince ?? "");
  if (!Number.isFinite(startedAt)) return null;
  const plannedEndAt = startedAt + input.maxMinutes! * 60_000;
  return {
    pauseStartedAt: new Date(startedAt).toISOString(),
    warningAt: new Date(plannedEndAt - PAUSE_ENDING_WARNING_LEAD_MS).toISOString(),
    plannedEndAt: new Date(plannedEndAt).toISOString(),
  };
}

export function pauseEndingWindowStatus(schedule: PauseEndingSchedule, now: Date): "early" | "due" | "expired" {
  const timestamp = now.getTime();
  if (timestamp < Date.parse(schedule.warningAt)) return "early";
  if (timestamp >= Date.parse(schedule.plannedEndAt)) return "expired";
  return "due";
}

export type PausePlan = {
  plannedEndAt: string;
  /** The planned end has passed while the operator is still paused. */
  overdue: boolean;
  overdueMinutes: number;
};

/** What the console shows next to a timed pause: when it should end and how far past that we are. */
export function pausePlan(input: Parameters<typeof pauseEndingSchedule>[0], now: Date): PausePlan | null {
  const schedule = pauseEndingSchedule(input);
  if (!schedule) return null;
  const over = now.getTime() - Date.parse(schedule.plannedEndAt);
  return { plannedEndAt: schedule.plannedEndAt, overdue: over >= 0, overdueMinutes: Math.max(0, Math.floor(over / 60_000)) };
}
