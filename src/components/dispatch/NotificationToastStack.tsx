"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Check, ExternalLink, X } from "lucide-react";
import { compareNotifications, isNotificationUnread, notificationSeverityLabels } from "@/domain/notifications";
import type { DispatchNotification } from "@/domain/types";

const MAX_VISIBLE_TOASTS = 3;

type NotificationToastStackProps = {
  notifications: DispatchNotification[];
  onMarkRead: (notificationId: string) => void;
  onOpenCase: (caseId: string) => void;
  onOpenTask: (taskId: string, caseId: string) => void;
};

export function NotificationToastStack({ notifications, onMarkRead, onOpenCase, onOpenTask }: NotificationToastStackProps) {
  const knownIds = useRef(new Set(notifications.map((notification) => notification.id)));
  const [queuedIds, setQueuedIds] = useState<string[]>([]);

  useEffect(() => {
    const newlyArrived = notifications
      .filter((notification) => isNotificationUnread(notification) && !knownIds.current.has(notification.id))
      .sort(compareNotifications)
      .map((notification) => notification.id);

    for (const notification of notifications) {
      knownIds.current.add(notification.id);
    }

    if (newlyArrived.length > 0) {
      setQueuedIds((current) => [...current, ...newlyArrived.filter((id) => !current.includes(id))].slice(-20));
    }
  }, [notifications]);

  const notificationsById = useMemo(
    () => new Map(notifications.map((notification) => [notification.id, notification])),
    [notifications],
  );
  const queuedNotifications = queuedIds
    .map((id) => notificationsById.get(id))
    .filter((notification): notification is DispatchNotification => notification !== undefined && isNotificationUnread(notification));
  const visible = queuedNotifications.slice(0, MAX_VISIBLE_TOASTS);

  function dismiss(notificationId: string) {
    setQueuedIds((current) => current.filter((id) => id !== notificationId));
  }

  if (visible.length === 0) {
    return null;
  }

  return (
    <aside
      className="pointer-events-none fixed right-3 top-[calc(var(--dispatch-fixed-top,56px)+12px)] z-[2147483300] grid w-[min(380px,calc(100vw-24px))] gap-2"
      aria-label="Nové upozornenia"
      aria-live="polite"
    >
      {visible.map((notification) => {
        const urgent = notification.severity === "urgent";
        const warning = notification.severity === "warning";

        return (
          <article
            key={notification.id}
            className={`pointer-events-auto overflow-hidden rounded-xl border bg-white shadow-2xl ${
              urgent ? "border-red-300" : warning ? "border-orange-300" : "border-yellow-300"
            }`}
          >
            <div className={`h-1 ${urgent ? "bg-red-500" : warning ? "bg-orange-400" : "bg-[#FCD703]"}`} />
            <div className="p-3">
              <div className="flex items-start gap-3">
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${urgent ? "bg-red-100 text-red-700" : warning ? "bg-orange-100 text-orange-700" : "bg-yellow-100 text-zinc-900"}`}>
                  <BellRing size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Nové upozornenie · {notificationSeverityLabels[notification.severity]}</p>
                      <h2 className="mt-0.5 line-clamp-2 text-sm font-semibold leading-5 text-zinc-950">{notification.title}</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => dismiss(notification.id)}
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100"
                      aria-label="Zavrieť upozornenie"
                    >
                      <X size={15} />
                    </button>
                  </div>
                  {notification.body && <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-600">{notification.body}</p>}
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onMarkRead(notification.id);
                        dismiss(notification.id);
                      }}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
                    >
                      <Check size={13} />
                      Vybavené
                    </button>
                    {notification.taskId && notification.caseId && (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenTask(notification.taskId!, notification.caseId!);
                          dismiss(notification.id);
                        }}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800"
                      >
                        <ExternalLink size={13} />
                        Otvoriť úlohu
                      </button>
                    )}
                    {!notification.taskId && notification.caseId && (
                      <button
                        type="button"
                        onClick={() => {
                          onMarkRead(notification.id);
                          onOpenCase(notification.caseId!);
                          dismiss(notification.id);
                        }}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800"
                      >
                        <ExternalLink size={13} />
                        Otvoriť prípad
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </article>
        );
      })}
      {queuedNotifications.length > MAX_VISIBLE_TOASTS && (
        <div className="pointer-events-auto justify-self-end rounded-full bg-zinc-950 px-3 py-1 text-xs font-semibold text-white shadow-lg">
          +{queuedNotifications.length - MAX_VISIBLE_TOASTS} ďalšie
        </div>
      )}
    </aside>
  );
}
