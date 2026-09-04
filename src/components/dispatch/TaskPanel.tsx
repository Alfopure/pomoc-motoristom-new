"use client";

import { useMemo, useRef, useState } from "react";
import { CircleAlert, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Edit3, Inbox, ListTodo, Loader2, Plus, Save, Trash2, UserRound, X } from "lucide-react";
import type { CasePriority, CaseTask, DispatchCase, DispatchNotification, NotificationStatus, Operator, TaskReminderChannel } from "@/domain/types";
import { isNotificationForProfile, isNotificationUnread } from "@/domain/notifications";
import { compareOperationalTasks, isTaskDueToday, isTaskHandoverRelevant, isTaskOpen, isTaskOverdue, taskPriorities, taskPriorityLabels, taskPriorityTone, taskStatusLabel } from "@/domain/tasks";
import { formatTime } from "@/lib/dispatch-calculations";
import { NotificationCenter } from "./NotificationCenter";

export type TaskCreateInput = {
  assignedTo: string;
  caseId: string;
  taskDueAt: string;
  taskPriority: CasePriority;
  taskReminderChannels: TaskReminderChannel[];
  taskTitle: string;
};

export type TaskUpdateInput = {
  assignedTo?: string;
  caseId: string;
  note?: string;
  taskDueAt?: string;
  taskId: string;
  taskPriority?: CasePriority;
  taskStatus?: CaseTask["status"];
  taskTitle?: string;
};

export type TaskDeleteInput = {
  caseId: string;
  note?: string;
  taskId: string;
};

type TaskEditDraft = {
  assignedTo: string;
  dueAt: string;
  note: string;
  priority: CasePriority;
  status: "open" | "done";
  title: string;
};

type TaskPanelTask = CaseTask & {
  caseNumber: string;
  ownerName?: string;
};

type PendingCreatedTask = {
  caseId: string;
  previousTaskIds: Set<string>;
  title: string;
};

type TaskScope = "team" | "today" | "overdue" | "handover" | "done";
type SidebarTaskAudience = "mine" | "all";

const taskDuePresets = [
  { label: "O 5 min", minutes: 5 },
  { label: "O 30 min", minutes: 30 },
  { label: "O hodinu", minutes: 60 },
] as const;

const PAGE_TASK_LIMIT = 8;
const SIDEBAR_TASK_LIMIT = 6;

type TaskPanelProps = {
  activeTaskId?: string;
  cases: DispatchCase[];
  isNotificationSyncing?: boolean;
  lastNotificationSyncAt?: string;
  markingNotificationId?: string | null;
  notifications: DispatchNotification[];
  notificationSyncEnabled?: boolean;
  onCreateTask?: (input: TaskCreateInput) => Promise<void> | void;
  onDeleteTask?: (input: TaskDeleteInput) => Promise<void> | void;
  onMarkNotificationRead: (notificationId: string) => void;
  onOpenTask: (taskId: string, caseId: string) => void;
  onRefreshNotifications?: () => void;
  onUpdateTask?: (input: TaskUpdateInput) => Promise<void> | void;
  onUpdateNotificationStatus?: (notificationId: string, status: NotificationStatus) => Promise<void> | void;
  operators: Operator[];
  variant?: "page" | "sidebar";
  viewerProfileId?: string;
};

export function TaskPanel({
  activeTaskId,
  cases,
  isNotificationSyncing,
  lastNotificationSyncAt,
  markingNotificationId,
  notifications,
  notificationSyncEnabled,
  onCreateTask,
  onDeleteTask,
  onMarkNotificationRead,
  onOpenTask,
  onRefreshNotifications,
  onUpdateTask,
  onUpdateNotificationStatus,
  operators,
  variant = "sidebar",
  viewerProfileId,
}: TaskPanelProps) {
  const [view, setView] = useState<TaskScope>("team");
  const [sidebarAudience, setSidebarAudience] = useState<SidebarTaskAudience>("mine");
  const [selectedOperatorId, setSelectedOperatorId] = useState("all");
  const [createCaseId, setCreateCaseId] = useState(cases[0]?.id ?? "");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskAssignee, setNewTaskAssignee] = useState(viewerProfileId ?? "unassigned");
  const [newTaskDueAt, setNewTaskDueAt] = useState(() => dateTimeLocalInMinutes(30));
  const [newTaskPriority, setNewTaskPriority] = useState<CasePriority>("normal");
  const [sendTaskReminderEmail, setSendTaskReminderEmail] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TaskEditDraft | null>(null);
  const [pendingTaskAction, setPendingTaskAction] = useState<string | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<TaskPanelTask | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [recentCreation, setRecentCreation] = useState<PendingCreatedTask | null>(null);
  const [taskPage, setTaskPage] = useState(1);
  const taskListRef = useRef<HTMLElement | null>(null);
  const now = new Date();
  const effectiveOperatorId = selectedOperatorId === "all" || selectedOperatorId === "unassigned" || operators.some((operator) => operator.id === selectedOperatorId) ? selectedOperatorId : "all";
  const effectiveCreateCaseId = cases.some((caseItem) => caseItem.id === createCaseId) ? createCaseId : cases[0]?.id ?? "";
  const effectiveNewTaskAssignee = newTaskAssignee === "unassigned" || operators.some((operator) => operator.id === newTaskAssignee) ? newTaskAssignee : "unassigned";
  const tasks: TaskPanelTask[] = useMemo(
    () =>
      cases.flatMap((caseItem) =>
        caseItem.tasks.map((task) => ({
          ...task,
          caseId: caseItem.id,
          caseNumber: caseItem.caseNumber,
          ownerName: caseItem.ownerName,
        })),
      ),
    [cases],
  );
  const recentlyCreatedTaskId = recentCreation
    ? tasks.find(
        (task) =>
          !recentCreation.previousTaskIds.has(task.id) &&
          task.caseId === recentCreation.caseId &&
          task.title === recentCreation.title,
      )?.id ?? null
    : null;
  const operatorTasks = effectiveOperatorId === "all" ? tasks : tasks.filter((task) => task.assignedTo === effectiveOperatorId);
  const openTasks = operatorTasks.filter(isTaskOpen);
  const allOpenTasks = tasks.filter(isTaskOpen);
  const myOpenTasks = viewerProfileId ? allOpenTasks.filter((task) => task.assignedTo === viewerProfileId) : [];
  const attentionTaskIds = new Set(
    notifications
      .filter((notification) => isNotificationUnread(notification) && isNotificationForProfile(notification, viewerProfileId) && notification.taskId)
      .map((notification) => notification.taskId!),
  );
  const effectiveSidebarAudience: SidebarTaskAudience = viewerProfileId ? sidebarAudience : "all";
  const allOpenTaskCount = allOpenTasks.length;
  const viewCounts: Record<TaskScope, number> = {
    team: openTasks.length,
    today: openTasks.filter((task) => isTaskDueToday(task, now)).length,
    overdue: openTasks.filter((task) => isTaskOverdue(task, now)).length,
    handover: openTasks.filter((task) => isTaskHandoverRelevant(task, now)).length,
    done: operatorTasks.filter((task) => task.status === "done").length,
  };
  const sidebarTasks = effectiveSidebarAudience === "mine" ? myOpenTasks : allOpenTasks;
  const pageTasks = (view === "done" ? operatorTasks.filter((task) => task.status === "done") : openTasks).filter((task) => {
    if (view === "today") return isTaskDueToday(task, now);
    if (view === "overdue") return isTaskOverdue(task, now);
    if (view === "handover") return isTaskHandoverRelevant(task, now);
    if (view === "done") return task.status === "done";

    return true;
  });
  const visibleTasks = [...(variant === "sidebar" ? sidebarTasks : pageTasks)].sort((left, right) =>
    variant === "sidebar" ? compareSidebarTasks(left, right, now) : compareOperationalTasks(left, right, now));
  const orderedTasks = recentlyCreatedTaskId
    ? [
        ...visibleTasks.filter((task) => task.id === recentlyCreatedTaskId),
        ...visibleTasks.filter((task) => task.id !== recentlyCreatedTaskId),
      ]
    : visibleTasks;
  const taskPageLimit = variant === "page" ? PAGE_TASK_LIMIT : SIDEBAR_TASK_LIMIT;
  const taskPageCount = Math.max(1, Math.ceil(orderedTasks.length / taskPageLimit));
  const effectiveTaskPage = Math.min(taskPage, taskPageCount);
  const paginatedTasks = orderedTasks.slice((effectiveTaskPage - 1) * taskPageLimit, effectiveTaskPage * taskPageLimit);
  const taskGroups = createTaskGroups(paginatedTasks, variant === "sidebar" ? "team" : view, now, recentlyCreatedTaskId);
  const views: Array<{ id: TaskScope; label: string }> = [
    { id: "team", label: "Otvorené" },
    { id: "today", label: "Dnes" },
    { id: "overdue", label: "Po termíne" },
    { id: "handover", label: "Odovzdanie" },
    { id: "done", label: "Vybavené" },
  ];
  const rootClassName =
    variant === "page"
      ? "min-h-[520px] min-w-0 rounded-md border border-zinc-200 bg-white shadow-sm"
      : "flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-white";
  const bodyClassName = variant === "page" ? "min-w-0 p-3 sm:p-4" : "min-h-0 flex-1 overflow-auto p-1.5";
  const canMutateTasks = Boolean(onUpdateTask);

  async function runTaskAction(actionId: string, action: () => Promise<void> | void) {
    if (pendingTaskAction) {
      return false;
    }

    setPendingTaskAction(actionId);
    setTaskError(null);
    setTaskNotice(null);

    try {
      await action();
      return true;
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Akciu s úlohou sa nepodarilo vykonať.");
      return false;
    } finally {
      setPendingTaskAction(null);
    }
  }

  async function createTask() {
    if (!onCreateTask || !effectiveCreateCaseId) {
      return;
    }

    const dueAt = isoFromLocalDateTime(newTaskDueAt);
    if (!dueAt) {
      setTaskError("Termín úlohy musí byť platný dátum a čas.");
      return;
    }

    const taskTitle = newTaskTitle.trim() || "Nová úloha";
    const selectedCase = cases.find((caseItem) => caseItem.id === effectiveCreateCaseId);
    const pendingCreatedTask: PendingCreatedTask = {
      caseId: effectiveCreateCaseId,
      previousTaskIds: new Set(tasks.map((task) => task.id)),
      title: taskTitle,
    };
    setRecentCreation(pendingCreatedTask);

    const created = await runTaskAction("create", async () => {
      await onCreateTask({
        assignedTo: effectiveNewTaskAssignee,
        caseId: effectiveCreateCaseId,
        taskDueAt: dueAt,
        taskPriority: newTaskPriority,
        taskReminderChannels: sendTaskReminderEmail ? ["in_app", "email"] : ["in_app"],
        taskTitle,
      });
    });

    if (!created) {
      setRecentCreation((current) => (current === pendingCreatedTask ? null : current));
      return;
    }

    setView("team");
    setSelectedOperatorId("all");
    setTaskPage(1);
    setTaskNotice(`Úloha „${taskTitle}“ bola vytvorená${selectedCase ? ` pre prípad ${selectedCase.caseNumber}` : ""}.`);
    setNewTaskTitle("");
    setNewTaskDueAt(dateTimeLocalInMinutes(30));
    setSendTaskReminderEmail(false);

    window.requestAnimationFrame(() => {
      taskListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function updateTask(input: TaskUpdateInput) {
    if (!onUpdateTask) {
      return;
    }

    await runTaskAction(`update:${input.taskId}`, () => onUpdateTask(input));
  }

  async function deleteTask(input: TaskDeleteInput) {
    if (!onDeleteTask) {
      return false;
    }

    return runTaskAction(`delete:${input.taskId}`, () => onDeleteTask(input));
  }

  function startTaskEdit(task: TaskPanelTask) {
    setTaskError(null);
    setEditingTaskId(task.id);
    setEditDraft({
      assignedTo: task.assignedTo || "unassigned",
      dueAt: dateTimeLocalFromIso(task.dueAt),
      note: "",
      priority: task.priority,
      status: task.status === "done" ? "done" : "open",
      title: task.title,
    });
  }

  function cancelTaskEdit() {
    setEditingTaskId(null);
    setEditDraft(null);
  }

  async function saveTaskEdit(task: TaskPanelTask) {
    if (!editDraft) {
      return;
    }

    const taskTitle = editDraft.title.trim();
    const taskDueAt = isoFromLocalDateTime(editDraft.dueAt);

    if (!taskTitle) {
      setTaskError("Úloha potrebuje názov.");
      return;
    }

    if (!taskDueAt) {
      setTaskError("Termín úlohy musí byť platný dátum a čas.");
      return;
    }

    await updateTask({
      assignedTo: editDraft.assignedTo,
      caseId: task.caseId,
      note: editDraft.note.trim() || undefined,
      taskDueAt,
      taskId: task.id,
      taskPriority: editDraft.priority,
      taskStatus: editDraft.status,
      taskTitle,
    });
    cancelTaskEdit();
  }

  async function toggleTaskStatus(task: TaskPanelTask) {
    await updateTask({
      caseId: task.caseId,
      taskId: task.id,
      taskStatus: task.status === "done" ? "open" : "done",
    });
  }

  async function confirmDeleteTask() {
    if (!pendingDeleteTask) return;

    const task = pendingDeleteTask;
    const deleted = await deleteTask({ caseId: task.caseId, taskId: task.id });
    if (!deleted) return;

    setPendingDeleteTask(null);
    setTaskNotice(`Úloha „${task.title}“ bola vymazaná.`);
    if (editingTaskId === task.id) {
      cancelTaskEdit();
    }
  }

  return (
    <aside className={`${rootClassName} max-w-full overflow-x-hidden`}>
      {variant === "page" && <header className="shrink-0 border-b border-zinc-200 px-3 py-3.5 sm:px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#FCD703] text-zinc-950">
                <ListTodo size={16} strokeWidth={2.4} />
              </span>
              <h2 className="text-base font-semibold tracking-tight text-zinc-950">Úlohy</h2>
              <span className="rounded-full bg-zinc-950 px-2 py-0.5 text-xs font-semibold text-white">{allOpenTaskCount}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">Naplánujte prácu tímu a sledujte, čo treba vybaviť.</p>
          </div>
        </div>
      </header>}

      <div className={`${bodyClassName} max-w-full overflow-x-hidden`}>
        <div className={variant === "page" ? "grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_320px]" : "grid gap-2"}>
          <div className={`grid min-w-0 content-start ${variant === "page" ? "gap-3" : "gap-2"}`}>
            {variant === "page" && onCreateTask && (
              <section className="grid min-w-0 content-start gap-4 overflow-hidden rounded-xl border border-yellow-300 bg-yellow-50/70 p-3 shadow-sm sm:p-4" aria-labelledby="new-task-heading">
                <div className="flex items-center gap-3 border-b border-yellow-200 pb-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#FCD703] text-zinc-950">
                    <Plus size={17} strokeWidth={2.5} />
                  </span>
                  <div className="min-w-0">
                    <h3 id="new-task-heading" className="text-sm font-semibold text-zinc-950">Nová úloha</h3>
                    <p className="mt-0.5 text-xs leading-5 text-zinc-600">Vyberte prípad, zodpovednú osobu a termín.</p>
                  </div>
                </div>

                <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-12">
                  <label className="grid min-w-0 gap-1.5 text-xs font-semibold text-zinc-700 xl:col-span-5">
                    Prípad
                    <select
                      value={effectiveCreateCaseId}
                      onChange={(event) => setCreateCaseId(event.target.value)}
                      className="h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 outline-none ring-yellow-300 transition focus:ring-2"
                    >
                      {cases.map((caseItem) => (
                        <option key={caseItem.id} value={caseItem.id}>
                          {caseItem.caseNumber} · {caseItem.contact.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid min-w-0 gap-1.5 text-xs font-semibold text-zinc-700 xl:col-span-7">
                    Názov úlohy
                    <textarea
                      value={newTaskTitle}
                      onChange={(event) => setNewTaskTitle(event.target.value)}
                      placeholder="Nová úloha"
                      rows={3}
                      className="min-h-20 w-full min-w-0 resize-y rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium leading-5 text-zinc-900 outline-none placeholder:font-normal placeholder:text-zinc-400 focus:ring-2 focus:ring-yellow-300"
                    />
                  </label>
                  <label className="grid min-w-0 gap-1.5 text-xs font-semibold text-zinc-700 xl:col-span-3">
                    Priradiť
                    <select
                      value={effectiveNewTaskAssignee}
                      onChange={(event) => setNewTaskAssignee(event.target.value)}
                      className="h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 outline-none ring-yellow-300 transition focus:ring-2"
                    >
                      <option value="unassigned">Bez priradenia</option>
                      {operators.map((operator) => (
                        <option key={operator.id} value={operator.id}>
                          {operator.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid min-w-0 gap-1.5 text-xs font-semibold text-zinc-700 xl:col-span-3">
                    Termín
                    <input
                      type="datetime-local"
                      value={newTaskDueAt}
                      onChange={(event) => setNewTaskDueAt(event.target.value)}
                      className="h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 outline-none ring-yellow-300 transition focus:ring-2"
                    />
                  </label>
                  <label className="grid min-w-0 gap-1.5 text-xs font-semibold text-zinc-700 xl:col-span-6">
                    Priorita
                    <select
                      value={newTaskPriority}
                      onChange={(event) => setNewTaskPriority(event.target.value as CasePriority)}
                      className="h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-900 outline-none ring-yellow-300 transition focus:ring-2"
                    >
                      {taskPriorities.map((priority) => (
                        <option key={priority} value={priority}>
                          {taskPriorityLabels[priority]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="flex min-w-0 flex-col gap-3 border-t border-yellow-200 pt-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <span className="flex flex-wrap gap-1.5" role="group" aria-label="Rýchle nastavenie termínu">
                      {taskDuePresets.map((preset) => (
                        <button
                          key={preset.minutes}
                          type="button"
                          onClick={() => setNewTaskDueAt(dateTimeLocalInMinutes(preset.minutes))}
                          className="h-8 rounded-md border border-yellow-300 bg-white px-2.5 text-[11px] font-semibold text-zinc-700 hover:bg-yellow-100"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </span>
                    <label className="inline-flex min-h-8 items-center gap-2 text-xs font-semibold text-zinc-700 sm:border-l sm:border-yellow-200 sm:pl-3">
                    <input
                      type="checkbox"
                      checked={sendTaskReminderEmail}
                      onChange={(event) => setSendTaskReminderEmail(event.target.checked)}
                      className="size-4 rounded border-zinc-300 text-zinc-950"
                    />
                    Poslať pripomienku aj emailom
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => void createTask()}
                    disabled={pendingTaskAction === "create" || !effectiveCreateCaseId}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300"
                  >
                    {pendingTaskAction === "create" ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                    Vytvoriť úlohu
                  </button>
                </div>
              </section>
            )}

            <section ref={taskListRef} className={variant === "page" ? "min-w-0 scroll-mt-3 rounded-lg border border-zinc-200 bg-white p-4" : "grid gap-2"} aria-labelledby={`task-list-heading-${variant}`}>
              {variant === "sidebar" && <h3 id="task-list-heading-sidebar" className="sr-only">Zoznam úloh</h3>}
              {variant === "page" && (
                <div className="mb-3">
                  <h3 id="task-list-heading-page" className="text-sm font-semibold text-zinc-950">Zoznam úloh</h3>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">Vyberte stav a podľa potreby zúžte výsledky na operátora.</p>
                </div>
              )}
              <div className={`grid min-w-0 rounded-md border border-zinc-200 bg-zinc-50 ${variant === "page" ? "mb-4 gap-3 p-3" : "gap-1.5 p-1.5"}`}>
                {variant === "page" ? (
                  <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)] xl:items-end">
                    <fieldset className="min-w-0 flex-1">
                      <legend className="mb-1.5 text-xs font-semibold text-zinc-600">Stav úlohy</legend>
                      <div className="grid min-w-0 grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-5">
                      {views.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setView(item.id);
                          setTaskPage(1);
                        }}
                        className={`flex min-h-9 min-w-0 items-center justify-between gap-1.5 rounded-md border px-2 text-xs font-semibold transition ${
                          view === item.id ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                        }`}
                      >
                        <span className="truncate">{item.label}</span>
                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${view === item.id ? "bg-white text-zinc-950" : "bg-zinc-100 text-zinc-600"}`}>
                          {viewCounts[item.id]}
                        </span>
                      </button>
                    ))}
                      </div>
                    </fieldset>
                    <label className="grid min-w-0 gap-1.5 text-xs font-semibold text-zinc-600">
                      Operátor
                      <select
                        value={effectiveOperatorId}
                        onChange={(event) => {
                          setSelectedOperatorId(event.target.value);
                          setTaskPage(1);
                        }}
                        className="h-9 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-2 pr-8 text-sm font-medium text-zinc-900 outline-none ring-yellow-300 transition focus:ring-2"
                      >
                        <option value="all">Všetci operátori</option>
                        <option value="unassigned">Bez priradenia</option>
                        {operators.map((operator) => (
                            <option key={operator.id} value={operator.id}>
                              {operator.name}
                            </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Filtrovanie úloh podľa priradenia">
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarAudience("mine");
                        setTaskPage(1);
                      }}
                      disabled={!viewerProfileId}
                      aria-pressed={effectiveSidebarAudience === "mine"}
                      className={`flex min-h-8 min-w-0 items-center justify-between gap-1 rounded-md border px-1.5 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                        effectiveSidebarAudience === "mine" ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                      }`}
                    >
                      <span className="truncate">Moje</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${effectiveSidebarAudience === "mine" ? "bg-white text-zinc-950" : "bg-zinc-100 text-zinc-600"}`}>
                        {myOpenTasks.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarAudience("all");
                        setTaskPage(1);
                      }}
                      aria-pressed={effectiveSidebarAudience === "all"}
                      className={`flex min-h-8 min-w-0 items-center justify-between gap-1 rounded-md border px-1.5 text-[11px] font-semibold transition ${
                        effectiveSidebarAudience === "all" ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                      }`}
                    >
                      <span className="truncate">Všetky</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${effectiveSidebarAudience === "all" ? "bg-white text-zinc-950" : "bg-zinc-100 text-zinc-600"}`}>
                        {allOpenTaskCount}
                      </span>
                    </button>
                  </div>
                )}
                {taskError && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{taskError}</div>}
              </div>
              {taskNotice && (
                <div role="status" aria-live="polite" className="mb-4 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1 font-medium">{taskNotice}</span>
                  <button type="button" onClick={() => setTaskNotice(null)} className="shrink-0 rounded p-0.5 text-emerald-700 hover:bg-emerald-100" aria-label="Skryť potvrdenie">
                    <X size={15} />
                  </button>
                </div>
              )}
              <div className={variant === "page" ? "grid gap-4" : "grid gap-2"}>
              {visibleTasks.length > 0 ? (
                taskGroups.map((group) => (
                  <section key={group.id} className={variant === "page" ? "grid gap-2" : "grid gap-1"} aria-labelledby={`task-group-${variant}-${group.id}`}>
                    <div className={`flex items-start justify-between gap-3 border-b border-zinc-200 ${variant === "page" ? "pb-2" : "pb-1"}`}>
                      <div>
                        <h4 id={`task-group-${variant}-${group.id}`} className={`${variant === "page" ? "text-xs" : "text-[11px]"} font-semibold uppercase tracking-wide ${group.headingClassName}`}>{group.label}</h4>
                        {variant === "page" && <p className="mt-0.5 text-[11px] leading-4 text-zinc-500">{group.description}</p>}
                      </div>
                      <span className={`rounded-full bg-zinc-100 px-1.5 py-0.5 font-semibold text-zinc-700 ${variant === "page" ? "text-xs" : "text-[10px]"}`}>{group.tasks.length}</span>
                    </div>
                              <div className={`grid min-w-0 ${variant === "page" ? "gap-2" : "gap-1.5"}`}>
                    {group.tasks.map((task) => {
                  const active = activeTaskId === task.id;
                  const overdue = isTaskOverdue(task, now);
                  const assignee = task.assignedTo === "unassigned" ? "Nepriradené" : operators.find((operator) => operator.id === task.assignedTo)?.name ?? "Neznáma osoba";
                  const taskEditDraft = editingTaskId === task.id ? editDraft : null;
                  const taskActionBusy = pendingTaskAction === `update:${task.id}` || pendingTaskAction === `delete:${task.id}`;
                  const recentlyCreated = recentlyCreatedTaskId === task.id;
                  const requiresAttention = variant === "sidebar" && attentionTaskIds.has(task.id);

                  return (
                    <div
                      key={task.id}
                      data-testid={`task-card-${variant}`}
                      className={`min-w-0 overflow-hidden rounded-md border text-left transition ${variant === "page" ? "p-3" : "px-2 py-1.5"} ${
                        recentlyCreated
                          ? "border-yellow-400 bg-yellow-50 ring-2 ring-yellow-200"
                          : requiresAttention
                            ? "border-yellow-400 bg-yellow-50 ring-1 ring-yellow-200"
                          : active
                            ? "border-yellow-300 bg-yellow-50 ring-1 ring-yellow-300"
                            : overdue
                              ? "border-red-200 bg-red-50 hover:bg-white"
                              : "border-zinc-200 bg-zinc-50 hover:bg-white"
                      }`}
                    >
                      <div className={`flex items-start justify-between ${variant === "page" ? "gap-2" : "gap-1.5"}`}>
                        <button type="button" onClick={() => onOpenTask(task.id, task.caseId)} className="min-w-0 flex-1 text-left">
                          <span className={`${variant === "page" ? "text-sm" : "text-[11px] leading-4"} line-clamp-2 font-semibold text-zinc-950`}>{task.title}</span>
                        </button>
                        <span className={`flex shrink-0 items-center ${variant === "page" ? "gap-1.5" : "gap-1"}`}>
                          {requiresAttention && (
                            <span className="inline-flex size-5 items-center justify-center rounded-full bg-[#FCD703] text-zinc-950 shadow-sm motion-safe:animate-pulse" title="Nová pridelená úloha">
                              <CircleAlert size={12} aria-label="Nová pridelená úloha" />
                            </span>
                          )}
                          {recentlyCreated && <span className="rounded-full bg-zinc-950 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Nová</span>}
                          <span className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-[9px] font-semibold leading-4 text-zinc-900">{task.caseNumber}</span>
                          {onDeleteTask && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setPendingDeleteTask(task);
                              }}
                              disabled={pendingTaskAction !== null}
                              className={`inline-flex items-center justify-center rounded-md border border-red-200 bg-white text-red-600 transition hover:bg-red-50 disabled:cursor-wait disabled:text-red-300 ${variant === "page" ? "size-7" : "size-6"}`}
                              aria-label={`Vymazať úlohu ${task.title}`}
                              title="Vymazať úlohu"
                            >
                              {pendingTaskAction === `delete:${task.id}` ? <Loader2 size={variant === "page" ? 14 : 12} className="animate-spin" /> : <Trash2 size={variant === "page" ? 14 : 12} />}
                            </button>
                          )}
                        </span>
                      </div>
                      {variant === "sidebar" ? (
                        <button type="button" onClick={() => onOpenTask(task.id, task.caseId)} className="mt-1 flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-left">
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-4 ${taskPriorityTone[task.priority]}`}>{taskPriorityLabels[task.priority]}</span>
                          <span className={`inline-flex min-w-0 items-center gap-1 text-[10px] font-medium leading-4 ${overdue ? "text-red-700" : "text-zinc-600"}`}>
                            <Clock3 size={11} className="shrink-0" />
                            <span className="truncate">{taskStatusLabel(task, now)} · {formatTime(task.dueAt)}</span>
                          </span>
                          <span className="inline-flex min-w-0 items-center gap-1 text-[10px] leading-4 text-zinc-500">
                            <UserRound size={11} className="shrink-0" />
                            <span className="truncate">{assignee}</span>
                          </span>
                        </button>
                      ) : (
                        <button type="button" onClick={() => onOpenTask(task.id, task.caseId)} className="block w-full text-left">
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${taskPriorityTone[task.priority]}`}>{taskPriorityLabels[task.priority]}</span>
                          </div>
                          <div className={`mt-1.5 flex items-center gap-1.5 text-[11px] font-medium ${overdue ? "text-red-700" : "text-zinc-600"}`}>
                            <Clock3 size={12} />
                            {taskStatusLabel(task, now)} · {formatTime(task.dueAt)}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                            <UserRound size={12} />
                            {assignee}
                          </div>
                        </button>
                      )}
                      {canMutateTasks && (
                        <div className={`${variant === "page" ? "mt-3 pt-3" : "mt-1.5 pt-1.5"} border-t border-white/70`}>
                          {taskEditDraft ? (
                            <div className="grid gap-2">
                              <textarea
                                value={taskEditDraft.title}
                                onChange={(event) => setEditDraft((current) => (current ? { ...current, title: event.target.value } : current))}
                                disabled={pendingTaskAction !== null}
                                rows={3}
                                className="min-h-20 min-w-0 resize-y rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs font-semibold leading-4 text-zinc-900 outline-none ring-yellow-300 transition focus:ring-2 disabled:cursor-wait disabled:text-zinc-400"
                                aria-label={`Názov úlohy ${task.title}`}
                              />
                              <div className={`grid min-w-0 gap-2 ${variant === "page" ? "sm:grid-cols-2" : "grid-cols-1"}`}>
                                <select
                                  value={taskEditDraft.assignedTo}
                                  onChange={(event) => setEditDraft((current) => (current ? { ...current, assignedTo: event.target.value } : current))}
                                  disabled={pendingTaskAction !== null}
                                  className="h-9 min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-800 outline-none ring-yellow-300 transition focus:ring-2 disabled:cursor-wait disabled:text-zinc-400"
                                  aria-label={`Priradenie úlohy ${task.title}`}
                                >
                                  <option value="unassigned">Nepriradené</option>
                                  {task.assignedTo !== "unassigned" && !operators.some((operator) => operator.id === task.assignedTo) && <option value={task.assignedTo}>{assignee}</option>}
                                  {operators.map((operator) => (
                                    <option key={operator.id} value={operator.id}>
                                      {operator.name}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  value={taskEditDraft.status}
                                  onChange={(event) => setEditDraft((current) => (current ? { ...current, status: event.target.value as TaskEditDraft["status"] } : current))}
                                  disabled={pendingTaskAction !== null}
                                  className="h-9 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-800 outline-none ring-yellow-300 transition focus:ring-2 disabled:cursor-wait disabled:text-zinc-400"
                                  aria-label={`Stav úlohy ${task.title}`}
                                >
                                  <option value="open">Otvorená</option>
                                  <option value="done">Vybavené</option>
                                </select>
                                <input
                                  type="datetime-local"
                                  value={taskEditDraft.dueAt}
                                  onChange={(event) => setEditDraft((current) => (current ? { ...current, dueAt: event.target.value } : current))}
                                  disabled={pendingTaskAction !== null}
                                  className="h-9 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-800 outline-none ring-yellow-300 transition focus:ring-2 disabled:cursor-wait disabled:text-zinc-400"
                                  aria-label={`Termín úlohy ${task.title}`}
                                />
                                <select
                                  value={taskEditDraft.priority}
                                  onChange={(event) => setEditDraft((current) => (current ? { ...current, priority: event.target.value as CasePriority } : current))}
                                  disabled={pendingTaskAction !== null}
                                  className="h-9 w-full min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-xs font-semibold text-zinc-800 outline-none ring-yellow-300 transition focus:ring-2 disabled:cursor-wait disabled:text-zinc-400"
                                  aria-label={`Priorita úlohy ${task.title}`}
                                >
                                  {taskPriorities.map((priority) => (
                                    <option key={priority} value={priority}>
                                      {taskPriorityLabels[priority]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <input
                                value={taskEditDraft.note}
                                onChange={(event) => setEditDraft((current) => (current ? { ...current, note: event.target.value } : current))}
                                disabled={pendingTaskAction !== null}
                                placeholder="Poznámka k zmene"
                                className="h-9 min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-800 outline-none ring-yellow-300 transition focus:ring-2 disabled:cursor-wait disabled:text-zinc-400"
                                aria-label={`Poznámka k zmene úlohy ${task.title}`}
                              />
                              <div className="flex flex-wrap justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={cancelTaskEdit}
                                  disabled={pendingTaskAction !== null}
                                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-400"
                                >
                                  <X size={13} />
                                  Zrušiť
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void saveTaskEdit(task)}
                                  disabled={!onUpdateTask || pendingTaskAction !== null}
                                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:bg-zinc-300"
                                >
                                  {pendingTaskAction === `update:${task.id}` ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                                  Uložiť
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className={`flex flex-wrap justify-end ${variant === "page" ? "gap-2" : "gap-1"}`}>
                              {onUpdateTask && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void toggleTaskStatus(task)}
                                    disabled={pendingTaskAction !== null}
                                    className={`inline-flex items-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-400 ${variant === "page" ? "h-8 px-2.5" : "h-7 px-2"}`}
                                  >
                                    <span className={`inline-flex items-center font-semibold ${variant === "page" ? "gap-1.5 text-xs" : "gap-1 text-[11px]"}`}>
                                      {taskActionBusy && pendingTaskAction?.startsWith("update:") ? <Loader2 size={variant === "page" ? 13 : 12} className="animate-spin" /> : <CheckCircle2 size={variant === "page" ? 13 : 12} />}
                                      {task.status === "done" ? "Otvoriť" : "Vybaviť"}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => startTaskEdit(task)}
                                    disabled={pendingTaskAction !== null}
                                    className={`inline-flex items-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:cursor-wait disabled:text-zinc-400 ${variant === "page" ? "h-8 px-2.5" : "h-7 px-2"}`}
                                  >
                                    <span className={`inline-flex items-center font-semibold ${variant === "page" ? "gap-1.5 text-xs" : "gap-1 text-[11px]"}`}>
                                      <Edit3 size={variant === "page" ? 13 : 12} />
                                      Upraviť
                                    </span>
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                    </div>
                  </section>
                ))
              ) : (
                <div className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-sm font-medium text-zinc-500">
                  <Inbox size={20} className="mx-auto mb-2 text-zinc-400" />
                  Žiadne úlohy nevyhovujú filtru.
                </div>
              )}
              {orderedTasks.length > taskPageLimit && (
                <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-3">
                  <span className="text-xs font-semibold text-zinc-500">
                    Strana {effectiveTaskPage} z {taskPageCount} · {orderedTasks.length} úloh
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setTaskPage(Math.max(1, effectiveTaskPage - 1))}
                      disabled={effectiveTaskPage === 1}
                      className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300"
                      aria-label="Predchádzajúca strana úloh"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setTaskPage(Math.min(taskPageCount, effectiveTaskPage + 1))}
                      disabled={effectiveTaskPage === taskPageCount}
                      className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300"
                      aria-label="Nasledujúca strana úloh"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
          </div>

          {variant === "page" && (
            <div className="grid min-w-0 content-start gap-3">
              <NotificationCenter
                cases={cases}
                isRefreshing={Boolean(isNotificationSyncing)}
                lastSyncAt={lastNotificationSyncAt}
                limit={6}
                markingNotificationId={markingNotificationId}
                notifications={notifications}
                operators={operators}
                refreshEnabled={Boolean(notificationSyncEnabled)}
                onMarkRead={onMarkNotificationRead}
                onOpenTask={onOpenTask}
                onRefresh={onRefreshNotifications}
                onUpdateStatus={onUpdateNotificationStatus}
                viewerProfileId={viewerProfileId}
              />
            </div>
          )}
        </div>
      </div>
      {pendingDeleteTask && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-zinc-950/45 p-4 backdrop-blur-[1px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && pendingTaskAction !== `delete:${pendingDeleteTask.id}`) {
              setPendingDeleteTask(null);
            }
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-task-title"
            aria-describedby="delete-task-description"
            className="w-full max-w-sm overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl"
          >
            <div className="flex items-start gap-3 border-b border-zinc-100 p-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
                <Trash2 size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 id="delete-task-title" className="text-base font-semibold text-zinc-950">Vymazať úlohu?</h3>
                <p id="delete-task-description" className="mt-1 text-sm leading-5 text-zinc-600">
                  Úloha „{pendingDeleteTask.title}“ sa odstráni natrvalo. Túto akciu nemožno vrátiť späť.
                </p>
              </div>
            </div>
            <div className="flex flex-col-reverse gap-2 bg-zinc-50 p-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                autoFocus
                onClick={() => setPendingDeleteTask(null)}
                disabled={pendingTaskAction === `delete:${pendingDeleteTask.id}`}
                className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:cursor-wait disabled:text-zinc-400"
              >
                Nie, ponechať
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteTask()}
                disabled={pendingTaskAction === `delete:${pendingDeleteTask.id}`}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-wait disabled:bg-red-300"
              >
                {pendingTaskAction === `delete:${pendingDeleteTask.id}` ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                Áno, vymazať
              </button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}

function dateTimeLocalInMinutes(minutes: number) {
  const date = new Date(Date.now() + minutes * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

function dateTimeLocalFromIso(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

  return local.toISOString().slice(0, 16);
}

function isoFromLocalDateTime(value: string) {
  const date = new Date(value);

  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function createTaskGroups(tasks: TaskPanelTask[], view: TaskScope, now: Date, recentlyCreatedTaskId: string | null) {
  const recentlyCreatedTask = recentlyCreatedTaskId ? tasks.find((task) => task.id === recentlyCreatedTaskId) : undefined;
  const remainingTasks = recentlyCreatedTask ? tasks.filter((task) => task.id !== recentlyCreatedTask.id) : tasks;

  if (view === "done") {
    return remainingTasks.length > 0
      ? [{ id: "done", label: "Vybavené", description: "Dokončené úlohy vo vybranom filtri.", headingClassName: "text-emerald-700", tasks: remainingTasks }]
      : [];
  }

  const overdue = remainingTasks.filter((task) => isTaskOverdue(task, now));
  const today = remainingTasks.filter((task) => !isTaskOverdue(task, now) && isTaskDueToday(task, now));
  const later = remainingTasks.filter((task) => !isTaskOverdue(task, now) && !isTaskDueToday(task, now));

  return [
    ...(recentlyCreatedTask
      ? [{ id: "recent", label: "Práve vytvorené", description: "Nová úloha je uložená a pripravená na spracovanie.", headingClassName: "text-amber-700", tasks: [recentlyCreatedTask] }]
      : []),
    { id: "today", label: "Dnes", description: "Treba vybaviť počas dnešnej služby.", headingClassName: "text-amber-700", tasks: today },
    { id: "overdue", label: "Po termíne", description: "Vyžadujú okamžitú pozornosť.", headingClassName: "text-red-700", tasks: overdue },
    { id: "later", label: "Naplánované", description: "Ďalšia práca zoradená podľa priority a termínu.", headingClassName: "text-zinc-700", tasks: later },
  ].filter((group) => group.tasks.length > 0);
}

function compareSidebarTasks(left: TaskPanelTask, right: TaskPanelTask, now: Date) {
  const groupRank = (task: TaskPanelTask) => {
    if (!isTaskOverdue(task, now) && isTaskDueToday(task, now)) return 0;
    if (isTaskOverdue(task, now)) return 1;
    return 2;
  };
  return groupRank(left) - groupRank(right) || compareOperationalTasks(left, right, now);
}
