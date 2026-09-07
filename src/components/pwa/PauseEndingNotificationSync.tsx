"use client";

import { useEffect, useEffectEvent, useRef } from "react";

import { pauseEndingSchedule, pauseEndingWindowStatus } from "@/lib/telephony/pause-ending";
import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";
import { pushRequest } from "./push-client";

type PauseReason = { id: string; maxMinutes: number | null };

/**
 * The open console owns the precise timer. The authenticated server still
 * validates and atomically claims the warning; multiple tabs therefore cannot
 * create or push duplicates. The existing cron remains a closed-app fallback.
 */
export function PauseEndingNotificationSync({
  enabled,
  onDelivered,
  pauseReasonId,
  pauseReasons,
  status,
  statusSince,
}: {
  enabled: boolean;
  onDelivered: () => void;
  pauseReasonId: string | null | undefined;
  pauseReasons: readonly PauseReason[];
  status: OperatorPresenceStatus | string | null | undefined;
  statusSince: string | null | undefined;
}) {
  const deliveredKeys = useRef(new Set<string>());
  const notifyDelivered = useEffectEvent(onDelivered);

  useEffect(() => {
    if (!enabled || !pauseReasonId) return;
    const reason = pauseReasons.find((candidate) => candidate.id === pauseReasonId);
    const schedule = pauseEndingSchedule({ status, statusSince, maxMinutes: reason?.maxMinutes });
    if (!schedule) return;
    const key = `${pauseReasonId}:${schedule.pauseStartedAt}`;
    if (deliveredKeys.current.has(key)) return;

    let disposed = false;
    let timer: number | undefined;
    const plannedEnd = Date.parse(schedule.plannedEndAt);

    const trigger = async () => {
      if (disposed || Date.now() >= plannedEnd) return;
      try {
        const result = await pushRequest<{ delivered?: boolean; status?: string }>("/api/push/pause-ending", "POST", {
          pauseStartedAt: schedule.pauseStartedAt,
        });
        if (disposed) return;
        if (result.delivered) notifyDelivered();
        if (result.status !== "early") {
          deliveredKeys.current.add(key);
          return;
        }
      } catch {
        if (disposed) return;
      }
      if (!disposed && Date.now() < plannedEnd) timer = window.setTimeout(() => void trigger(), 10_000);
    };

    const windowStatus = pauseEndingWindowStatus(schedule, new Date());
    if (windowStatus === "expired") return;
    const delay = windowStatus === "due" ? 0 : Math.max(0, Date.parse(schedule.warningAt) - Date.now() + 500);
    timer = window.setTimeout(() => void trigger(), delay);

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, pauseReasonId, pauseReasons, status, statusSince]);

  return null;
}
