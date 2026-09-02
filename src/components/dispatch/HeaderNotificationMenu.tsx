"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, ChevronRight, Inbox } from "lucide-react";
import { compareNotifications, isNotificationUnread, notificationSeverityTone } from "@/domain/notifications";
import type { DispatchCase, DispatchNotification } from "@/domain/types";
import { formatTime } from "@/lib/dispatch-calculations";

type HeaderNotificationMenuProps = {
  cases: DispatchCase[];
  notifications: DispatchNotification[];
  onMarkRead: (notificationId: string) => void;
  onOpenCase: (caseId: string) => void;
  onOpenTask: (taskId: string, caseId: string) => void;
};

const HISTORY_LIMIT = 12;

export function HeaderNotificationMenu({
  cases,
  notifications,
  onMarkRead,
  onOpenCase,
  onOpenTask,
}: HeaderNotificationMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sortedNotifications = useMemo(
    () => [...notifications].filter((notification) => notification.status !== "archived").sort(compareNotifications),
    [notifications],
  );
  const visibleNotifications = sortedNotifications.slice(0, HISTORY_LIMIT);
  const unreadCount = sortedNotifications.filter(isNotificationUnread).length;
  const casesById = useMemo(() => new Map(cases.map((caseItem) => [caseItem.id, caseItem.caseNumber])), [cases]);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function openNotification(notification: DispatchNotification) {
    if (notification.taskId && notification.caseId) {
      onOpenTask(notification.taskId, notification.caseId);
    } else if (notification.caseId) {
      if (isNotificationUnread(notification)) onMarkRead(notification.id);
      onOpenCase(notification.caseId);
    } else if (isNotificationUnread(notification)) {
      onMarkRead(notification.id);
    }
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unreadCount > 0 ? `Upozornenia, ${unreadCount} nových` : "Upozornenia"}
        className={`relative inline-flex size-9 items-center justify-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300 ${
          open ? "border-yellow-300 bg-yellow-300 text-zinc-950" : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
        }`}
      >
        <Bell size={17} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-black leading-5 text-white ring-2 ring-zinc-950">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <section
          role="dialog"
          aria-label="História upozornení"
          className="absolute right-0 top-[calc(100%+0.55rem)] z-[2147483400] w-[min(390px,calc(100vw-24px))] overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-2xl"
        >
          <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-3.5 py-3">
            <div>
              <h2 className="text-sm font-bold">Upozornenia</h2>
              <p className="mt-0.5 text-xs text-zinc-500">Tvoje nové aj vybavené upozornenia</p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${unreadCount > 0 ? "bg-red-500 text-white" : "bg-zinc-100 text-zinc-600"}`}>
              {unreadCount} nových
            </span>
          </header>

          <div className="max-h-[min(460px,70vh)] divide-y divide-zinc-100 overflow-y-auto overscroll-contain">
            {visibleNotifications.length > 0 ? visibleNotifications.map((notification) => {
              const unread = isNotificationUnread(notification);
              const hasTarget = Boolean(notification.caseId);
              const caseNumber = notification.caseId ? casesById.get(notification.caseId) : undefined;

              return (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => openNotification(notification)}
                  className={`grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 px-3.5 py-3 text-left transition hover:bg-zinc-50 ${unread ? "bg-yellow-50/70" : "bg-white"}`}
                >
                  <span className={`mt-1 size-2.5 rounded-full ${unread ? "bg-[#F4C900] ring-4 ring-yellow-100" : "bg-zinc-200"}`} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`line-clamp-2 min-w-0 flex-1 text-sm leading-5 ${unread ? "font-bold text-zinc-950" : "font-semibold text-zinc-700"}`}>{notification.title}</span>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold ring-1 ${notificationSeverityTone[notification.severity]}`}>
                        {notification.severity === "urgent" ? "Urgentné" : notification.severity === "warning" ? "Pozor" : "Info"}
                      </span>
                    </span>
                    {notification.body && <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-zinc-500">{notification.body}</span>}
                    <span className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                      {caseNumber && <span>{caseNumber}</span>}
                      {caseNumber && <span aria-hidden="true">·</span>}
                      <span>{formatTime(notification.createdAt)}</span>
                      {!unread && <><span aria-hidden="true">·</span><Check size={11} /><span>Vybavené</span></>}
                    </span>
                  </span>
                  {hasTarget ? <ChevronRight size={15} className="mt-1 text-zinc-400" aria-hidden="true" /> : <span />}
                </button>
              );
            }) : (
              <div className="px-4 py-10 text-center text-sm font-medium text-zinc-500">
                <Inbox size={22} className="mx-auto mb-2 text-zinc-300" />
                Zatiaľ nemáš žiadne upozornenia.
              </div>
            )}
          </div>

          {sortedNotifications.length > HISTORY_LIMIT && (
            <footer className="border-t border-zinc-200 bg-zinc-50 px-3.5 py-2 text-center text-[11px] font-semibold text-zinc-500">
              Zobrazených posledných {HISTORY_LIMIT} z {sortedNotifications.length}
            </footer>
          )}
        </section>
      )}
    </div>
  );
}
