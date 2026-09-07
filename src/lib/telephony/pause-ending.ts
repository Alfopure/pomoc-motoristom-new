import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";

export const PAUSE_ENDING_WARNING_LEAD_MS = 60_000;

export type PauseEndingSchedule = {
  pauseStartedAt: string;
  warningAt: string;
  plannedEndAt: string;
};

/**
 * The configured pause-reason maximum is the planned duration. It is only a
 * reminder boundary: reaching it never changes operator presence.
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
