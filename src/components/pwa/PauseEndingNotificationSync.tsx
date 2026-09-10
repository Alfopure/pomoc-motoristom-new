"use client";

import { useEffect, useEffectEvent, useRef } from "react";

import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";
import { pushRequest } from "./push-client";

type PauseEndingAnswer = {
  status?: string;
  delivered?: boolean;
  phase?: "warning" | "overdue";
  warningAt?: string;
  plannedEndAt?: string;
};

/**
 * The open console owns the precise timers; the server owns the schedule.
 *
 * Each pause asks `/api/push/pause-ending` once right away. The answer carries
 * the warning and planned-end moments computed from the stored pause reason,
 * so a limit edited in settings a moment ago is honoured without a reload, and
 * the component only has to come back at those two moments. The server
 * validates and atomically claims every notice, so several tabs cannot create
 * or push duplicates; the existing cron remains the closed-app fallback.
 */
export function PauseEndingNotificationSync({
  enabled,
  onDelivered,
  pauseReasonId,
  status,
  statusSince,
}: {
  enabled: boolean;
  onDelivered: () => void;
  pauseReasonId: string | null | undefined;
  status: OperatorPresenceStatus | string | null | undefined;
  statusSince: string | null | undefined;
}) {
  const settledKeys = useRef(new Set<string>());
  const notifyDelivered = useEffectEvent(onDelivered);

  useEffect(() => {
    if (!enabled || status !== "paused" || !pauseReasonId) return;
    const startedAt = Date.parse(statusSince ?? "");
    if (!Number.isFinite(startedAt)) return;
    const pauseStartedAt = new Date(startedAt).toISOString();
    const key = `${pauseReasonId}:${pauseStartedAt}`;
    if (settledKeys.current.has(key)) return;

    let disposed = false;
    let timer: number | undefined;

    const comeBackAt = (moment: string) => {
      timer = window.setTimeout(() => void ask(), Math.max(0, Date.parse(moment) - Date.now() + 500));
    };

    const ask = async () => {
      if (disposed) return;
      try {
        const answer = await pushRequest<PauseEndingAnswer>("/api/push/pause-ending", "POST", { pauseStartedAt });
        if (disposed) return;
        if (answer.delivered) notifyDelivered();
        if (answer.status === "early" && answer.warningAt) return comeBackAt(answer.warningAt);
        // The warning is done (here or in another tab); the overdue notice is
        // still owed at the planned end.
        if (answer.plannedEndAt && Date.now() < Date.parse(answer.plannedEndAt)) return comeBackAt(answer.plannedEndAt);
        settledKeys.current.add(key);
      } catch {
        if (!disposed) timer = window.setTimeout(() => void ask(), 30_000);
      }
    };

    void ask();

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, pauseReasonId, status, statusSince]);

  return null;
}
