"use client";

import { useState } from "react";
import { Archive, BellRing, Check, ChevronLeft, ChevronRight, Inbox, Loader2, RefreshCw, RotateCcw, UserRound, UsersRound } from "lucide-react";
import {
  compareNotifications,
  formatNotificationReminderTime,
  isNotificationForProfile,
  isNotificationReady,
  isNotificationSnoozed,
  isNotificationUnread,
  notificationSeverityLabels,
  notificationSeverityTone,
} from "@/domain/notifications";
import type {
  DispatchCase,
  DispatchNotification,
  NotificationSeverity,
  NotificationStatus,
  Operator,
} from "@/domain/types";
import { formatTime } from "@/lib/dispatch-calculations";
import { NotificationSnoozeButton } from "./NotificationSnoozeButton";

type NotificationStateFilter = "pending" | "snoozed" | "past";
type NotificationSeverityFilter = "all" | NotificationSeverity;
type NotificationAudience = "mine" | "all";

type NotificationCenterProps = {
  cases: DispatchCase[];
  isRefreshing?: boolean;
  lastSyncAt?: string;
  limit?: number;
  markingNotificationId?: string | null;
  notifications: DispatchNotification[];
  now: number;
  operators: Operator[];
  refreshEnabled?: boolean;
  onMarkRead: (notificationId: string) => void;
  onOpenTask: (taskId: string, caseId: string) => void;
  onRefresh?: () => void;
  onSnooze?: (notificationId: string, snoozedUntil: string) => boolean | Promise<boolean>;
  onUpdateStatus?: (notificationId: string, status: NotificationStatus) => Promise<void> | void;
  viewerProfileId?: string;
};

export function NotificationCenter({
  cases,
  isRefreshing,
  lastSyncAt,
  limit = 5,
  markingNotificationId,
  notifications,
  now,
  operators,
  refreshEnabled,
  onMarkRead,
  onOpenTask,
  onRefresh,
  onSnooze,
  onUpdateStatus,
  viewerProfileId,
}: NotificationCenterProps) {
  const [audience, setAudience] = useState<NotificationAudience>("mine");
  const [stateFilter, setStateFilter] = useState<NotificationStateFilter>("pending");
  const [severityFilter, setSeverityFilter] = useState<NotificationSeverityFilter>("all");
  const [page, setPage] = useState(1);
  const casesById = new Map(cases.map((caseItem) => [caseItem.id, caseItem]));
  const operatorsById = new Map(operators.map((operator) => [operator.id, operator.name]));
  const allAvailableNotifications = notifications
    .filter((notification) => notification.status !== "archived")
    .sort(compareNotifications);
  const personalNotifications = allAvailableNotifications.filter((notification) =>
    isNotificationForProfile(notification, viewerProfileId));
  const availableNotifications = audience === "mine" ? personalNotifications : allAvailableNotifications;
  const unreadCount = availableNotifications.filter((notification) => isNotificationReady(notification, now)).length;
  const snoozedCount = availableNotifications.filter((notification) => isNotificationSnoozed(notification, now)).length;
  const pastCount = availableNotifications.filter((notification) => !isNotificationUnread(notification)).length;
  const filteredNotifications = availableNotifications.filter((notification) => {
    const stateMatches = stateFilter === "pending"
      ? isNotificationReady(notification, now)
      : stateFilter === "snoozed"
        ? isNotificationSnoozed(notification, now)
        : !isNotificationUnread(notification);
    const severityMatches = severityFilter === "all" || notification.severity === severityFilter;
    return stateMatches && severityMatches;
  });
  const pageCount = Math.max(1, Math.ceil(filteredNotifications.length / limit));
  const effectivePage = Math.min(page, pageCount);
  const visibleNotifications = filteredNotifications.slice((effectivePage - 1) * limit, effectivePage * limit);

  function chooseState(next: NotificationStateFilter) {
    setStateFilter(next);
    setPage(1);
  }

  function chooseAudience(next: NotificationAudience) {
    setAudience(next);
    setPage(1);
  }

  function updateStatus(notificationId: string, status: NotificationStatus) {
    if (status === "read" && !onUpdateStatus) {
      onMarkRead(notificationId);
      return;
    }

    onUpdateStatus?.(notificationId, status);
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm" aria-labelledby="notification-center-heading">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-2.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-zinc-950">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-yellow-100 text-zinc-950">
            <BellRing size={14} />
          </span>
          <h3 id="notification-center-heading" className="truncate">Upozornenia</h3>
          <span className="rounded-full bg-zinc-950 px-2 py-0.5 text-xs font-semibold text-white" aria-label={`${unreadCount} neprečítaných upozornení`}>
            {unreadCount}
          </span>
        </div>
        {refreshEnabled && onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-300"
            aria-label="Obnoviť upozornenia"
            title={lastSyncAt ? `Naposledy obnovené o ${formatTime(lastSyncAt)}` : "Obnoviť upozornenia"}
          >
            <RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} />
          </button>
        )}
      </div>

      <div className="grid min-w-0 gap-1.5 border-b border-zinc-100 bg-zinc-50/70 p-2">
        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Komu patria upozornenia">
          {([
            { id: "mine", label: "Moje", count: personalNotifications.length, icon: UserRound },
            { id: "all", label: "Všetky", count: allAvailableNotifications.length, icon: UsersRound },
          ] as const).map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => chooseAudience(item.id)}
                aria-pressed={audience === item.id}
                className={`flex min-h-8 min-w-0 items-center justify-between gap-2 rounded-md border px-2 text-[11px] font-semibold transition ${
                  audience === item.id
                    ? "border-yellow-400 bg-yellow-100 text-zinc-950"
                    : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5"><Icon size={13} className="shrink-0" /><span className="truncate">{item.label}</span></span>
                <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-zinc-600">{item.count}</span>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Stav upozornení">
          {([
            { id: "pending", label: "Na vybavenie", count: unreadCount },
            { id: "snoozed", label: "Odložené", count: snoozedCount },
            { id: "past", label: "Vybavené", count: pastCount },
          ] as const).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => chooseState(item.id)}
              aria-pressed={stateFilter === item.id}
              className={`flex min-h-8 min-w-0 items-center justify-between gap-2 rounded-md border px-2 text-[11px] font-semibold transition ${
                stateFilter === item.id
                  ? "border-zinc-950 bg-zinc-950 text-white"
                  : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <span className="truncate">{item.label}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${stateFilter === item.id ? "bg-white text-zinc-950" : "bg-zinc-100 text-zinc-600"}`}>
                {item.count}
              </span>
            </button>
          ))}
        </div>
        <label className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs font-semibold text-zinc-600">
          Naliehavosť
          <select
            value={severityFilter}
            onChange={(event) => {
              setSeverityFilter(event.target.value as NotificationSeverityFilter);
              setPage(1);
            }}
            className="h-8 min-w-0 rounded-md border border-zinc-200 bg-white px-2 pr-8 text-[11px] font-semibold text-zinc-800 outline-none ring-yellow-300 focus:ring-2"
          >
            <option value="all">Všetky</option>
            <option value="urgent">Urgentné</option>
            <option value="warning">Dôležité</option>
            <option value="info">Bežné</option>
          </select>
        </label>
      </div>

      <div className="grid min-w-0 gap-1.5 p-2">
        {visibleNotifications.length > 0 ? (
          visibleNotifications.map((notification) => {
            const caseId = notification.caseId;
            const caseItem = caseId ? casesById.get(caseId) : undefined;
            const canOpenTask = Boolean(notification.taskId && caseId);
            const busy = markingNotificationId === notification.id;
            const isMine = isNotificationForProfile(notification, viewerProfileId);
            const snoozed = isNotificationSnoozed(notification, now);
            const recipientLabel = notification.recipientProfileId
              ? operatorsById.get(notification.recipientProfileId) ?? "Iný používateľ"
              : "Tímové upozornenie";

            return (
              <article
                key={notification.id}
                className={`min-w-0 rounded-md border p-2 ${snoozed ? "border-sky-200 bg-sky-50" : isNotificationUnread(notification) ? "border-yellow-200 bg-yellow-50" : "border-zinc-200 bg-zinc-50"}`}
              >
                <button
                  type="button"
                  onClick={() => notification.taskId && caseId && onOpenTask(notification.taskId, caseId)}
                  disabled={!canOpenTask}
                  className={`block min-w-0 w-full text-left ${canOpenTask ? "hover:opacity-80" : "cursor-default"}`}
                >
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="line-clamp-2 min-w-0 text-sm font-semibold leading-5 text-zinc-950">{notification.title}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${notificationSeverityTone[notification.severity]}`}>
                      {notificationSeverityLabels[notification.severity]}
                    </span>
                  </div>
                  {notification.body && <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-zinc-600">{notification.body}</p>}
                </button>

                <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-1.5 border-t border-black/5 pt-1.5">
                  <span className="min-w-0 truncate text-[11px] font-medium text-zinc-500">
                    {snoozed ? `Pripomenie ${formatNotificationReminderTime(notification.snoozedUntil!)} · ` : ""}{audience === "all" ? `${recipientLabel} · ` : ""}{caseItem?.caseNumber ?? "Bez prípadu"} · {formatTime(notification.createdAt)}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {isMine && isNotificationUnread(notification) && onSnooze && (
                      <NotificationSnoozeButton
                        disabled={busy}
                        notificationId={notification.id}
                        notificationTitle={notification.title}
                        onSnooze={onSnooze}
                        variant="icon"
                      />
                    )}
                    {isMine && (
                      isNotificationUnread(notification) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => updateStatus(notification.id, "read")}
                          className="inline-flex h-7 items-center gap-1 rounded-md bg-white px-2 text-[11px] font-semibold text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-400"
                        >
                          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                          Vybavené
                        </button>
                      ) : onUpdateStatus ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => updateStatus(notification.id, "unread")}
                          className="inline-flex h-7 items-center gap-1 rounded-md bg-white px-2 text-[11px] font-semibold text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-400"
                        >
                          {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                          Vrátiť
                        </button>
                      ) : null
                    )}
                    {isMine && onUpdateStatus && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => updateStatus(notification.id, "archived")}
                        className="inline-flex size-7 items-center justify-center rounded-md bg-white text-zinc-500 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-300"
                        aria-label="Archivovať upozornenie"
                        title="Archivovať"
                      >
                        {busy ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })
        ) : (
          <div className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-sm font-medium text-zinc-500">
            <Inbox size={20} className="mx-auto mb-2 text-zinc-400" />
            {audience === "mine"
              ? stateFilter === "pending" ? "Nemáš žiadne upozornenia na vybavenie." : stateFilter === "snoozed" ? "Nemáš žiadne odložené upozornenia." : "Nemáš žiadne vybavené upozornenia."
              : stateFilter === "pending" ? "Žiadne upozornenia na vybavenie." : stateFilter === "snoozed" ? "Žiadne odložené upozornenia." : "Žiadne vybavené upozornenia."}
          </div>
        )}

        {filteredNotifications.length > limit && (
          <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-2">
            <span className="text-[11px] font-semibold text-zinc-500">Strana {effectivePage} z {pageCount}</span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setPage(Math.max(1, effectivePage - 1))}
                disabled={effectivePage === 1}
                className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300"
                aria-label="Predchádzajúca strana upozornení"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => setPage(Math.min(pageCount, effectivePage + 1))}
                disabled={effectivePage === pageCount}
                className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300"
                aria-label="Nasledujúca strana upozornení"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
