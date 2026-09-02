"use client";

import { useMemo, useState } from "react";
import type {
  AttendanceAvailabilityStatus,
  AttendanceData,
  AttendanceDaySummary,
  AttendanceRequestType,
  AttendanceShift,
  AttendanceShiftTemplate,
  AttendanceShiftTemplateKind,
  AttendanceUnavailabilityRequest,
  Operator,
} from "@/domain/types";
import { MOTORIST_TIME_ZONE } from "@/domain/time";
import type { CreateBulkAttendanceShiftsInput } from "@/data/attendance-inputs";
import type { DispatchData } from "@/data/dispatch-types";
import { addDays, formatShiftTimeRange, minutesBetween } from "@/lib/attendance";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  FileClock,
  Layers3,
  Loader2,
  Plus,
  Save,
  Send,
  UserCheck,
  X,
  XCircle,
} from "lucide-react";

type AttendanceModuleProps = {
  attendance: AttendanceData;
  operators: Operator[];
  onDataChange: (data: DispatchData) => void;
};

type AttendanceMutationResult = {
  dispatchData?: DispatchData;
  error?: string;
};

type AttendanceSection = "planning" | "requests" | "mine";
type WizardStep = 0 | 1 | 2 | 3;
type DayPickMode = "single" | "multi" | "range";

type WizardState = {
  open: boolean;
  step: WizardStep;
  dayPickMode: DayPickMode;
  rangeAnchor: string | null;
  selectedDates: string[];
  shiftMode: AttendanceShiftTemplateKind;
  selectedTemplateIds: string[];
  assignments: Record<string, string>;
  customStartTime: string;
  customEndTime: string;
  overridePendingRequests: boolean;
  notes: string;
};

type RequestFormState = {
  type: AttendanceRequestType;
  startDateLocal: string;
  endDateLocal: string;
  startTimeLocal: string;
  endTimeLocal: string;
  reason: string;
};

const WEEK_DAYS = ["Po", "Ut", "St", "Št", "Pi", "So", "Ne"];
const WIZARD_STEPS = ["Dni", "Smeny", "Ľudia", "Kontrola a publikovanie"];

export function AttendanceModule({ attendance, onDataChange, operators }: AttendanceModuleProps) {
  const fallbackDate = attendance.days.find((day) => day.isToday)?.dateLocal ?? attendance.days[0]?.dateLocal ?? "";
  const [activeSection, setActiveSection] = useState<AttendanceSection>("planning");
  const [selectedDate, setSelectedDate] = useState(fallbackDate);
  const [selectedProfileId, setSelectedProfileId] = useState(attendance.employeeSettings[0]?.profileId ?? operators[0]?.id ?? "");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState>(() => initialWizardState(attendance, fallbackDate, operators, false));
  const [requestForm, setRequestForm] = useState<RequestFormState>(() => ({
    type: "vacation",
    startDateLocal: fallbackDate,
    endDateLocal: fallbackDate,
    startTimeLocal: "",
    endTimeLocal: "",
    reason: "",
  }));
  const selectedDay = attendance.days.find((day) => day.dateLocal === selectedDate) ?? attendance.days.find((day) => day.isToday) ?? attendance.days[0];
  const monthLabel = selectedDay ? monthTitle(selectedDay.dateLocal) : "Dochádzka";
  const calendarCells = useMemo(() => createCalendarCells(attendance.days), [attendance.days]);
  const coverageState = useMemo(() => summarizeCoverage(attendance.days), [attendance.days]);
  const selectedProfile = attendance.employeeSettings.find((setting) => setting.profileId === selectedProfileId) ?? attendance.employeeSettings[0];
  const selectedProfileShifts = attendance.shifts
    .filter((shift) => shift.profileId === selectedProfile?.profileId)
    .sort((left, right) => new Date(left.plannedStartAt).getTime() - new Date(right.plannedStartAt).getTime());
  const selectedProfileRequests = attendance.unavailabilityRequests
    .filter((request) => request.profileId === selectedProfile?.profileId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const selectedProfileBalance = attendance.timeOffBalances.find((balance) => balance.profileId === selectedProfile?.profileId);
  const selectedDayAvailability = selectedDay ? attendance.availabilityByDate[selectedDay.dateLocal] ?? [] : [];

  async function mutate({
    body,
    busy,
    method = "POST",
    success,
    url,
  }: {
    body?: unknown;
    busy: string;
    method?: "POST" | "PATCH";
    success: string;
    url: string;
  }) {
    setBusyKey(busy);
    setNotice(null);

    try {
      const response = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = (await response.json().catch(() => ({}))) as AttendanceMutationResult;

      if (!response.ok || !result.dispatchData) {
        throw new Error(result.error ?? "Dochádzkovú zmenu sa nepodarilo uložiť.");
      }

      onDataChange(result.dispatchData);
      setNotice(success);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Dochádzkovú zmenu sa nepodarilo uložiť.");
      return false;
    } finally {
      setBusyKey(null);
    }
  }

  function openWizard() {
    setWizard(initialWizardState(attendance, selectedDate || fallbackDate, operators, true));
  }

  function handleSelectDay(day: AttendanceDaySummary) {
    setSelectedDate(day.dateLocal);
    setRequestForm((current) => ({ ...current, startDateLocal: day.dateLocal, endDateLocal: day.dateLocal }));
  }

  function setWizardStep(direction: 1 | -1) {
    setWizard((current) => ({ ...current, step: clampWizardStep(current.step + direction) }));
  }

  function handleWizardDateClick(dateLocal: string) {
    setWizard((current) => {
      if (current.dayPickMode === "single") {
        return { ...current, selectedDates: [dateLocal], rangeAnchor: null };
      }

      if (current.dayPickMode === "multi") {
        const selected = new Set(current.selectedDates);
        if (selected.has(dateLocal)) {
          selected.delete(dateLocal);
        } else {
          selected.add(dateLocal);
        }
        return { ...current, selectedDates: [...selected].sort(), rangeAnchor: null };
      }

      if (!current.rangeAnchor) {
        return { ...current, selectedDates: [dateLocal], rangeAnchor: dateLocal };
      }

      return { ...current, selectedDates: datesBetween(current.rangeAnchor, dateLocal), rangeAnchor: null };
    });
  }

  function handleShiftModeChange(shiftMode: AttendanceShiftTemplateKind) {
    setWizard((current) => {
      const selectedTemplateIds = defaultTemplateIdsForMode(attendance.templates, shiftMode);
      return {
        ...current,
        shiftMode,
        selectedTemplateIds,
        assignments: defaultAssignments(selectedTemplateIds, attendance, current.selectedDates, operators),
      };
    });
  }

  function toggleWizardTemplate(templateId: string) {
    setWizard((current) => {
      const selected = new Set(current.selectedTemplateIds);

      if (selected.has(templateId) && selected.size > 1) {
        selected.delete(templateId);
      } else {
        selected.add(templateId);
      }

      const selectedTemplateIds = [...selected];
      return {
        ...current,
        selectedTemplateIds,
        assignments: { ...defaultAssignments(selectedTemplateIds, attendance, current.selectedDates, operators), ...current.assignments },
      };
    });
  }

  async function saveWizard(publish: boolean) {
    const assignments = buildBulkAssignments(wizard, attendance.templates);

    if (assignments.length === 0) {
      setNotice("Vyber dni, smeny a operátorov.");
      return;
    }

    const body: CreateBulkAttendanceShiftsInput = {
      name: `Plán ${wizard.selectedDates[0]}-${wizard.selectedDates.at(-1) ?? wizard.selectedDates[0]}`,
      shiftMode: wizard.shiftMode,
      assignments,
      publish,
      overridePendingRequests: wizard.overridePendingRequests,
      notes: wizard.notes,
    };
    const saved = await mutate({
      busy: publish ? "wizard-publish" : "wizard-draft",
      body,
      success: publish ? "Plán smien je publikovaný." : "Koncept plánu smien je uložený.",
      url: "/api/attendance/planning/bulk-shifts",
    });

    if (saved) {
      setWizard((current) => ({ ...current, open: false }));
    }
  }

  async function submitRequest() {
    if (!selectedProfile) {
      setNotice("Vyber zamestnanca pre žiadosť.");
      return;
    }

    await mutate({
      busy: "request-create",
      body: {
        profileId: selectedProfile.profileId,
        type: requestForm.type,
        status: "pending",
        startDateLocal: requestForm.startDateLocal,
        endDateLocal: requestForm.endDateLocal,
        startTimeLocal: requestForm.startTimeLocal || null,
        endTimeLocal: requestForm.endTimeLocal || null,
        reason: requestForm.reason,
      },
      success: "Žiadosť je odoslaná na schválenie.",
      url: "/api/attendance/requests",
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white p-3">
        <div className="flex flex-wrap gap-2">
          <SectionButton active={activeSection === "planning"} icon={CalendarDays} label="Plánovanie" onClick={() => setActiveSection("planning")} />
          <SectionButton active={activeSection === "requests"} icon={FileClock} label="Žiadosti" onClick={() => setActiveSection("requests")} />
          <SectionButton active={activeSection === "mine"} icon={UserCheck} label="Moja dochádzka" onClick={() => setActiveSection("mine")} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill label={`${coverageState.coveredDays}/${attendance.days.length} dní pokrytých`} tone={coverageState.gapDays > 0 ? "warn" : "ok"} />
          <StatusPill label={`${attendance.unavailabilityRequests.filter((request) => request.status === "pending").length} pending žiadostí`} tone="warn" />
        </div>
      </div>

      {notice && <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-900">{notice}</div>}

      {activeSection === "planning" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
          <section className="min-w-0 rounded-md border border-zinc-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
                <CalendarDays size={17} />
                {monthLabel}
              </div>
              <ActionButton busy={false} icon={Plus} label="Naplánovať smeny" onClick={openWizard} />
            </div>
            <div className="grid grid-cols-7 border-b border-zinc-200 bg-zinc-50 text-center text-xs font-semibold uppercase tracking-normal text-zinc-500">
              {WEEK_DAYS.map((day) => (
                <div key={day} className="px-2 py-2">
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-7">
              {calendarCells.map((cell, index) =>
                cell ? (
                  <DayCell key={cell.dateLocal} day={cell} selected={selectedDate === cell.dateLocal} onSelect={() => handleSelectDay(cell)} />
                ) : (
                  <div key={`blank-${index}`} className="hidden min-h-[128px] border-b border-r border-zinc-100 bg-zinc-50/60 sm:block" />
                ),
              )}
            </div>
          </section>

          <aside className="grid content-start gap-4">
            {selectedDay && (
              <section className="rounded-md border border-zinc-200 bg-white">
                <div className="flex items-center justify-between gap-3 border-b border-zinc-200 p-3">
                  <div>
                    <h2 className="text-sm font-semibold text-zinc-950">{dayTitle(selectedDay.dateLocal)}</h2>
                    <p className="text-xs text-zinc-500">{daySubtitle(selectedDay)}</p>
                  </div>
                  <StatusPill label={dayStatusLabel[selectedDay.status]} tone={dayTone(selectedDay.status)} />
                </div>
                <div className="grid gap-3 p-3">
                  {selectedDay.gaps.length > 0 && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-950">
                        <AlertTriangle size={16} />
                        Chýba pokrytie
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedDay.gaps.map((gap) => (
                          <span key={gap.id} className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">
                            {gap.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <ShiftList shifts={selectedDay.shifts} />
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      busy={busyKey === "copy-day"}
                      icon={ClipboardCopy}
                      label="Kopírovať deň"
                      variant="secondary"
                      onClick={() =>
                        void mutate({
                          busy: "copy-day",
                          body: { sourceDateLocal: selectedDay.dateLocal, targetDateLocal: addDays(selectedDay.dateLocal, 1), mode: "day" },
                          success: "Deň je skopírovaný ako draft.",
                          url: "/api/attendance/copy",
                        })
                      }
                    />
                    <ActionButton
                      busy={busyKey === "copy-week"}
                      icon={ClipboardCopy}
                      label="Kopírovať týždeň"
                      variant="secondary"
                      onClick={() =>
                        void mutate({
                          busy: "copy-week",
                          body: { sourceDateLocal: selectedDay.dateLocal, targetDateLocal: addDays(selectedDay.dateLocal, 7), mode: "week" },
                          success: "Týždeň je skopírovaný ako draft.",
                          url: "/api/attendance/copy",
                        })
                      }
                    />
                  </div>
                </div>
              </section>
            )}

            <section className="rounded-md border border-zinc-200 bg-white">
              <div className="border-b border-zinc-200 p-3 text-sm font-semibold text-zinc-950">Dostupnosť ľudí</div>
              <div className="grid gap-2 p-3">
                {selectedDayAvailability.slice(0, 6).map((availability) => (
                  <AvailabilityRow key={`${availability.dateLocal}-${availability.profileId}`} availability={availability} />
                ))}
              </div>
            </section>
          </aside>
        </div>
      )}

      {activeSection === "requests" && (
        <section className="rounded-md border border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
              <FileClock size={17} />
              Žiadosti o voľno a nedostupnosť
            </div>
            <StatusPill label={`${attendance.unavailabilityRequests.filter((request) => request.status === "approved").length} schválené`} tone="ok" />
          </div>
          <div className="grid gap-2 p-3">
            {attendance.unavailabilityRequests.map((request) => (
              <RequestRow
                key={request.id}
                busyKey={busyKey}
                request={request}
                onApprove={() =>
                  void mutate({
                    busy: `approve-${request.id}`,
                    body: {},
                    success: "Žiadosť je schválená.",
                    url: `/api/attendance/requests/${request.id}/approve`,
                  })
                }
                onDecline={() =>
                  void mutate({
                    busy: `decline-${request.id}`,
                    body: { note: "Zamietnuté v dispečingu." },
                    success: "Žiadosť je zamietnutá.",
                    url: `/api/attendance/requests/${request.id}/decline`,
                  })
                }
              />
            ))}
          </div>
        </section>
      )}

      {activeSection === "mine" && selectedProfile && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-md border border-zinc-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
                <UserCheck size={17} />
                Moja dochádzka
              </div>
              <select
                value={selectedProfile.profileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
                className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
              >
                {attendance.employeeSettings.map((setting) => (
                  <option key={setting.profileId} value={setting.profileId}>
                    {setting.operatorName}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-3 p-3">
              <div className="grid gap-2 sm:grid-cols-4">
                <Kpi label="Plánované hodiny" value={formatHours(selectedProfileShifts.reduce((total, shift) => total + minutesBetween(shift.plannedStartAt, shift.plannedEndAt), 0))} />
                <Kpi label="Publikované/potvrdené" value={String(selectedProfileShifts.filter((shift) => shift.status === "published" || shift.status === "confirmed").length)} />
                <Kpi label="Dovolenka čerpaná" value={String(selectedProfileBalance?.vacationDaysUsed ?? 0)} tone="warn" />
                <Kpi label="Dovolenka zostáva" value={String(selectedProfileBalance?.vacationDaysRemaining ?? selectedProfile.vacationDaysPerYear)} tone="ok" />
              </div>
              <div className="grid gap-2">
                {selectedProfileShifts.map((shift) => (
                  <ShiftCard key={shift.id} shift={shift} />
                ))}
              </div>
            </div>
          </section>

          <aside className="grid content-start gap-4">
            <section className="rounded-md border border-zinc-200 bg-white">
              <div className="border-b border-zinc-200 p-3 text-sm font-semibold text-zinc-950">Nová žiadosť</div>
              <div className="grid gap-3 p-3">
                <select
                  value={requestForm.type}
                  onChange={(event) => setRequestForm((current) => ({ ...current, type: event.target.value as AttendanceRequestType }))}
                  className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                >
                  {Object.entries(requestTypeLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    value={requestForm.startDateLocal}
                    onChange={(event) => setRequestForm((current) => ({ ...current, startDateLocal: event.target.value }))}
                    className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                  />
                  <input
                    type="date"
                    value={requestForm.endDateLocal}
                    onChange={(event) => setRequestForm((current) => ({ ...current, endDateLocal: event.target.value }))}
                    className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                  />
                </div>
                {requestForm.type === "unavailable" && (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="time"
                      value={requestForm.startTimeLocal}
                      onChange={(event) => setRequestForm((current) => ({ ...current, startTimeLocal: event.target.value }))}
                      className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                    />
                    <input
                      type="time"
                      value={requestForm.endTimeLocal}
                      onChange={(event) => setRequestForm((current) => ({ ...current, endTimeLocal: event.target.value }))}
                      className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                    />
                  </div>
                )}
                <input
                  value={requestForm.reason}
                  onChange={(event) => setRequestForm((current) => ({ ...current, reason: event.target.value }))}
                  className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                  placeholder="Dôvod"
                />
                <ActionButton busy={busyKey === "request-create"} icon={Send} label="Odoslať žiadosť" onClick={() => void submitRequest()} />
              </div>
            </section>

            <section className="rounded-md border border-zinc-200 bg-white">
              <div className="border-b border-zinc-200 p-3 text-sm font-semibold text-zinc-950">Moje žiadosti</div>
              <div className="grid gap-2 p-3">
                {selectedProfileRequests.map((request) => (
                  <RequestRow
                    key={request.id}
                    busyKey={busyKey}
                    request={request}
                    selfService
                    onCancel={() =>
                      void mutate({
                        busy: `cancel-${request.id}`,
                        body: {},
                        success: "Žiadosť je zrušená.",
                        url: `/api/attendance/requests/${request.id}/cancel`,
                      })
                    }
                  />
                ))}
              </div>
            </section>
          </aside>
        </div>
      )}

      {wizard.open && (
        <AttendanceShiftWizard
          attendance={attendance}
          busyKey={busyKey}
          calendarCells={calendarCells}
          onClose={() => setWizard((current) => ({ ...current, open: false }))}
          onDateClick={handleWizardDateClick}
          onModeChange={handleShiftModeChange}
          onNext={() => setWizardStep(1)}
          onPrevious={() => setWizardStep(-1)}
          onSave={saveWizard}
          onTemplateToggle={toggleWizardTemplate}
          onWizardChange={setWizard}
          operators={operators}
          wizard={wizard}
        />
      )}
    </div>
  );
}

function AttendanceShiftWizard({
  attendance,
  busyKey,
  calendarCells,
  onClose,
  onDateClick,
  onModeChange,
  onNext,
  onPrevious,
  onSave,
  onTemplateToggle,
  onWizardChange,
  operators,
  wizard,
}: {
  attendance: AttendanceData;
  busyKey: string | null;
  calendarCells: Array<AttendanceDaySummary | null>;
  onClose: () => void;
  onDateClick: (dateLocal: string) => void;
  onModeChange: (mode: AttendanceShiftTemplateKind) => void;
  onNext: () => void;
  onPrevious: () => void;
  onSave: (publish: boolean) => Promise<void>;
  onTemplateToggle: (templateId: string) => void;
  onWizardChange: (next: WizardState | ((current: WizardState) => WizardState)) => void;
  operators: Operator[];
  wizard: WizardState;
}) {
  const selectedTemplates = attendance.templates.filter((template) => wizard.selectedTemplateIds.includes(template.id));
  const availability = aggregateAvailability(attendance, wizard.selectedDates);
  const blockedCount = availability.filter((item) => item.status === "blocked").length;
  const warningCount = availability.filter((item) => item.status === "warning").length;
  const assignmentCount = buildBulkAssignments(wizard, attendance.templates).length;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/45 p-2 sm:p-4">
      <div className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-md bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-zinc-200 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-zinc-950">
              <Layers3 size={18} />
              Naplánovať smeny
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {WIZARD_STEPS.map((label, index) => (
                <span
                  key={label}
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    wizard.step === index ? "bg-zinc-950 text-white" : index < wizard.step ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"
                  }`}
                >
                  {index + 1}. {label}
                </span>
              ))}
            </div>
          </div>
          <button type="button" title="Zavrieť" onClick={onClose} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-700 hover:bg-zinc-50">
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 overflow-auto p-4">
          {wizard.step === 0 && (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
              <div className="rounded-md border border-zinc-200">
                <div className="grid grid-cols-7 border-b border-zinc-200 bg-zinc-50 text-center text-xs font-semibold uppercase tracking-normal text-zinc-500">
                  {WEEK_DAYS.map((day) => (
                    <div key={day} className="px-2 py-2">
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-7">
                  {calendarCells.map((cell, index) =>
                    cell ? (
                      <button
                        key={cell.dateLocal}
                        type="button"
                        onClick={() => onDateClick(cell.dateLocal)}
                        className={`min-h-[92px] border-b border-r border-zinc-100 p-2 text-left transition hover:bg-zinc-50 ${
                          wizard.selectedDates.includes(cell.dateLocal) ? "bg-yellow-50 ring-2 ring-inset ring-yellow-300" : "bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-zinc-950">{Number(cell.dateLocal.slice(-2))}</span>
                          <span className={`h-2.5 w-2.5 rounded-full ${dayDotClass[cell.status]}`} />
                        </div>
                        <div className="mt-2 text-xs font-semibold text-zinc-600">{cell.shifts.length} smeny</div>
                      </button>
                    ) : (
                      <div key={`wizard-blank-${index}`} className="hidden min-h-[92px] border-b border-r border-zinc-100 bg-zinc-50/60 sm:block" />
                    ),
                  )}
                </div>
              </div>
              <div className="grid content-start gap-3">
                <SegmentedControl
                  value={wizard.dayPickMode}
                  options={[
                    { label: "Jeden deň", value: "single" },
                    { label: "Viac dní", value: "multi" },
                    { label: "Rozsah", value: "range" },
                  ]}
                  onChange={(value) => onWizardChange((current) => ({ ...current, dayPickMode: value as DayPickMode, rangeAnchor: null }))}
                />
                <SummaryBox label="Vybrané dni" value={wizard.selectedDates.length ? wizard.selectedDates.join(", ") : "Žiadne"} />
                <ActionButton
                  busy={false}
                  icon={XCircle}
                  label="Vyčistiť"
                  variant="secondary"
                  onClick={() => onWizardChange((current) => ({ ...current, selectedDates: [], rangeAnchor: null }))}
                />
              </div>
            </div>
          )}

          {wizard.step === 1 && (
            <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
              <div className="grid content-start gap-3">
                <SegmentedControl
                  value={wizard.shiftMode}
                  options={[
                    { label: "12h", value: "fixed_12h" },
                    { label: "8h", value: "fixed_8h" },
                    { label: "Custom", value: "custom" },
                  ]}
                  onChange={(value) => onModeChange(value as AttendanceShiftTemplateKind)}
                />
                {wizard.shiftMode === "custom" && (
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="time"
                      value={wizard.customStartTime}
                      onChange={(event) => onWizardChange((current) => ({ ...current, customStartTime: event.target.value }))}
                      className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                    />
                    <input
                      type="time"
                      value={wizard.customEndTime}
                      onChange={(event) => onWizardChange((current) => ({ ...current, customEndTime: event.target.value }))}
                      className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                    />
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {attendance.templates
                  .filter((template) => template.kind === wizard.shiftMode)
                  .map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => onTemplateToggle(template.id)}
                      className={`rounded-md border p-3 text-left transition ${
                        wizard.selectedTemplateIds.includes(template.id) ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white text-zinc-950 hover:bg-zinc-50"
                      }`}
                    >
                      <div className="text-sm font-semibold">{template.label}</div>
                      <div className={`mt-1 text-xs ${wizard.selectedTemplateIds.includes(template.id) ? "text-zinc-300" : "text-zinc-500"}`}>
                        {templateTimeLabel(template, wizard)}
                      </div>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {wizard.step === 2 && (
            <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
              <div className="grid content-start gap-3">
                {selectedTemplates.map((template) => (
                  <label key={template.id} className="grid gap-1 text-xs font-semibold text-zinc-600">
                    {template.label}
                    <select
                      value={wizard.assignments[template.id] ?? ""}
                      onChange={(event) => onWizardChange((current) => ({ ...current, assignments: { ...current.assignments, [template.id]: event.target.value } }))}
                      className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm font-medium text-zinc-950"
                    >
                      {operators.map((operator) => (
                        <option key={operator.id} value={operator.id}>
                          {operator.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label className="flex items-center gap-2 text-sm font-semibold text-zinc-700">
                  <input
                    type="checkbox"
                    checked={wizard.overridePendingRequests}
                    onChange={(event) => onWizardChange((current) => ({ ...current, overridePendingRequests: event.target.checked }))}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                  Prekonať pending warning
                </label>
              </div>
              <div className="grid content-start gap-2">
                {availability.map((item) => (
                  <AvailabilityRow key={`${item.dateLocal}-${item.profileId}`} availability={item} compact />
                ))}
              </div>
            </div>
          )}

          {wizard.step === 3 && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="grid gap-2">
                {wizard.selectedDates.map((dateLocal) =>
                  selectedTemplates.map((template) => {
                    const profileId = wizard.assignments[template.id];
                    const operator = operators.find((candidate) => candidate.id === profileId);
                    return (
                      <div key={`${dateLocal}-${template.id}`} className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                        <div>
                          <div className="text-sm font-semibold text-zinc-950">{dateLabel(dateLocal)} · {template.label}</div>
                          <div className="text-xs font-medium text-zinc-500">{templateTimeLabel(template, wizard)}</div>
                        </div>
                        <StatusPill label={operator?.name ?? "bez operátora"} tone={operator ? "neutral" : "bad"} />
                      </div>
                    );
                  }),
                )}
              </div>
              <div className="grid content-start gap-3">
                <SummaryBox label="Smeny" value={String(assignmentCount)} />
                <SummaryBox label="Blokované konflikty" value={String(blockedCount)} tone={blockedCount > 0 ? "bad" : "ok"} />
                <SummaryBox label="Warningy" value={String(warningCount)} tone={warningCount > 0 ? "warn" : "ok"} />
                <textarea
                  value={wizard.notes}
                  onChange={(event) => onWizardChange((current) => ({ ...current, notes: event.target.value }))}
                  className="min-h-24 rounded-md border border-zinc-200 bg-white p-2 text-sm font-medium text-zinc-950"
                  placeholder="Poznámka k batchu"
                />
              </div>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 p-4">
          <div className="flex gap-2">
            <ActionButton busy={false} icon={ChevronLeft} label="Späť" variant="secondary" onClick={onPrevious} />
            <ActionButton busy={false} icon={ChevronRight} label="Ďalej" variant="secondary" onClick={onNext} />
          </div>
          <div className="flex gap-2">
            <ActionButton busy={busyKey === "wizard-draft"} icon={Save} label="Uložiť koncept" variant="secondary" onClick={() => void onSave(false)} />
            <ActionButton busy={busyKey === "wizard-publish"} icon={Send} label="Publikovať plán" onClick={() => void onSave(true)} />
          </div>
        </footer>
      </div>
    </div>
  );
}

function DayCell({ day, onSelect, selected }: { day: AttendanceDaySummary; onSelect: () => void; selected: boolean }) {
  const visibleShifts = day.shifts.slice(0, 3);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`min-h-[128px] border-b border-r border-zinc-100 p-2 text-left transition hover:bg-zinc-50 ${
        selected ? "bg-yellow-50 ring-2 ring-inset ring-yellow-300" : day.isToday ? "bg-blue-50/70" : "bg-white"
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={`flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold ${day.isToday ? "bg-zinc-950 text-white" : "text-zinc-950"}`}>
          {Number(day.dateLocal.slice(-2))}
        </span>
        <span className={`h-2.5 w-2.5 rounded-full ${dayDotClass[day.status]}`} />
      </div>
      <div className="grid gap-1">
        {visibleShifts.map((shift) => (
          <div key={shift.id} className="truncate rounded bg-zinc-100 px-1.5 py-1 text-xs font-semibold text-zinc-800">
            {timeShort(shift)} {shift.operatorName}
          </div>
        ))}
        {day.shifts.length > visibleShifts.length && <div className="text-xs font-semibold text-zinc-500">+{day.shifts.length - visibleShifts.length}</div>}
        {day.gaps.length > 0 && <div className="truncate text-xs font-semibold text-amber-700">{day.gaps.length} medzera</div>}
      </div>
    </button>
  );
}

function ShiftList({ shifts }: { shifts: AttendanceShift[] }) {
  if (shifts.length === 0) {
    return <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm font-medium text-zinc-500">Bez smien.</div>;
  }

  return (
    <div className="grid gap-2">
      {shifts.map((shift) => (
        <ShiftCard key={shift.id} shift={shift} />
      ))}
    </div>
  );
}

function ShiftCard({ shift }: { shift: AttendanceShift }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-950">{shift.operatorName}</span>
            <StatusPill label={shiftStatusLabel[shift.status]} tone={shiftTone(shift.status)} />
          </div>
          <div className="mt-1 text-xs font-medium text-zinc-600">
            {formatShiftTimeRange(shift)} · {shift.templateLabel ?? "Custom"} · klapka {shift.operatorExtension}
          </div>
          {shift.notes && <div className="mt-1 text-xs text-zinc-500">{shift.notes}</div>}
        </div>
        {shift.scheduleBatchId && <StatusPill label="batch" tone="neutral" />}
      </div>
    </div>
  );
}

function AvailabilityRow({ availability, compact = false }: { availability: AttendanceAvailabilityStatus; compact?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${availability.status === "available" ? "border-emerald-200 bg-emerald-50" : availability.status === "warning" ? "border-amber-200 bg-amber-50" : "border-red-200 bg-red-50"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-950">{availability.operatorName}</div>
          {!compact && <div className="text-xs font-medium text-zinc-600">{formatHours(availability.plannedMinutesInMonth)} v mesiaci</div>}
        </div>
        <StatusPill label={availabilityStatusLabel[availability.status]} tone={availabilityTone(availability.status)} />
      </div>
      {availability.reasons.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {availability.reasons.map((reason) => (
            <span key={reason.id} className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-zinc-700 ring-1 ring-zinc-200">
              {reason.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RequestRow({
  busyKey,
  onApprove,
  onCancel,
  onDecline,
  request,
  selfService = false,
}: {
  busyKey: string | null;
  onApprove?: () => void;
  onCancel?: () => void;
  onDecline?: () => void;
  request: AttendanceUnavailabilityRequest;
  selfService?: boolean;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-950">{request.operatorName}</span>
            <StatusPill label={requestTypeLabel[request.type]} tone="neutral" />
            <StatusPill label={requestStatusLabel[request.status]} tone={requestStatusTone(request.status)} />
          </div>
          <div className="mt-1 text-xs font-medium text-zinc-600">
            {dateLabel(request.startDateLocal)}-{dateLabel(request.endDateLocal)}
            {request.startTimeLocal && request.endTimeLocal ? ` · ${request.startTimeLocal}-${request.endTimeLocal}` : ""}
          </div>
          {request.reason && <div className="mt-1 text-xs text-zinc-500">{request.reason}</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!selfService && request.status === "pending" && (
            <>
              <ActionButton busy={busyKey === `approve-${request.id}`} icon={CheckCircle2} label="Approve" onClick={onApprove ?? (() => undefined)} />
              <ActionButton busy={busyKey === `decline-${request.id}`} icon={XCircle} label="Decline" variant="secondary" onClick={onDecline ?? (() => undefined)} />
            </>
          )}
          {selfService && ["draft", "pending"].includes(request.status) && (
            <ActionButton busy={busyKey === `cancel-${request.id}`} icon={XCircle} label="Zrušiť" variant="secondary" onClick={onCancel ?? (() => undefined)} />
          )}
        </div>
      </div>
    </div>
  );
}

function SectionButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold transition ${
        active ? "bg-zinc-950 text-white" : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

function ActionButton({
  busy,
  icon: Icon,
  label,
  onClick,
  variant = "primary",
}: {
  busy: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-70 ${
        variant === "primary" ? "bg-zinc-950 text-white hover:bg-zinc-800" : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
      }`}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
      {label}
    </button>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "ok" | "warn" | "neutral" | "bad" }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${pillClass[tone]}`}>{label}</span>;
}

function Kpi({ label, tone = "neutral", value }: { label: string; tone?: "ok" | "warn" | "neutral" | "bad"; value: string }) {
  return (
    <div className={`rounded-md border p-3 ${kpiClass[tone]}`}>
      <div className="text-xs font-semibold text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function SegmentedControl({ onChange, options, value }: { onChange: (value: string) => void; options: Array<{ label: string; value: string }>; value: string }) {
  return (
    <div className="grid grid-cols-3 rounded-md border border-zinc-200 bg-zinc-100 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`h-9 rounded text-sm font-semibold ${value === option.value ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-950"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SummaryBox({ label, tone = "neutral", value }: { label: string; tone?: "ok" | "warn" | "neutral" | "bad"; value: string }) {
  return (
    <div className={`rounded-md border p-3 ${kpiClass[tone]}`}>
      <div className="text-xs font-semibold text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function initialWizardState(attendance: AttendanceData, dateLocal: string, operators: Operator[], open: boolean): WizardState {
  const selectedTemplateIds = defaultTemplateIdsForMode(attendance.templates, "fixed_12h");

  return {
    open,
    step: 0,
    dayPickMode: "range",
    rangeAnchor: null,
    selectedDates: dateLocal ? [dateLocal] : [],
    shiftMode: "fixed_12h",
    selectedTemplateIds,
    assignments: defaultAssignments(selectedTemplateIds, attendance, dateLocal ? [dateLocal] : [], operators),
    customStartTime: "09:00",
    customEndTime: "17:00",
    overridePendingRequests: false,
    notes: "",
  };
}

function defaultTemplateIdsForMode(templates: AttendanceShiftTemplate[], shiftMode: AttendanceShiftTemplateKind) {
  const ids = templates.filter((template) => template.kind === shiftMode).map((template) => template.id);
  return ids.length > 0 ? ids : templates.slice(0, 1).map((template) => template.id);
}

function defaultAssignments(templateIds: string[], attendance: AttendanceData, dateLocals: string[], operators: Operator[]) {
  const availability = aggregateAvailability(attendance, dateLocals);
  const firstAvailable = availability.find((item) => item.status !== "blocked")?.profileId ?? operators[0]?.id ?? "";

  return templateIds.reduce<Record<string, string>>((assignments, templateId, index) => {
    assignments[templateId] = availability[index]?.status !== "blocked" ? availability[index]?.profileId ?? firstAvailable : firstAvailable;
    return assignments;
  }, {});
}

function aggregateAvailability(attendance: AttendanceData, dateLocals: string[]) {
  const byProfile = new Map<string, AttendanceAvailabilityStatus>();
  const dates = dateLocals.length > 0 ? dateLocals : [attendance.days.find((day) => day.isToday)?.dateLocal ?? attendance.days[0]?.dateLocal ?? ""];

  dates.forEach((dateLocal) => {
    (attendance.availabilityByDate[dateLocal] ?? []).forEach((availability) => {
      const existing = byProfile.get(availability.profileId);
      if (!existing) {
        byProfile.set(availability.profileId, { ...availability, reasons: [...availability.reasons] });
        return;
      }

      existing.reasons.push(...availability.reasons);
      existing.status = existing.status === "blocked" || availability.status === "blocked" ? "blocked" : existing.status === "warning" || availability.status === "warning" ? "warning" : "available";
      existing.plannedMinutesInMonth = Math.max(existing.plannedMinutesInMonth, availability.plannedMinutesInMonth);
    });
  });

  return [...byProfile.values()]
    .map((availability) => ({ ...availability, reasons: dedupeWarnings(availability.reasons) }))
    .sort((left, right) => availabilityRank[left.status] - availabilityRank[right.status] || left.plannedMinutesInMonth - right.plannedMinutesInMonth || left.operatorName.localeCompare(right.operatorName, "sk"));
}

function buildBulkAssignments(wizard: WizardState, templates: AttendanceShiftTemplate[]): CreateBulkAttendanceShiftsInput["assignments"] {
  const assignments: CreateBulkAttendanceShiftsInput["assignments"] = [];

  wizard.selectedDates.forEach((dateLocal) => {
    wizard.selectedTemplateIds.forEach((templateId) => {
      const template = templates.find((candidate) => candidate.id === templateId);
      const profileId = wizard.assignments[templateId];

      if (!template || !profileId) {
        return;
      }

      assignments.push({
        dateLocal,
        templateId,
        profileId,
        startTimeLocal: template.kind === "custom" ? wizard.customStartTime : template.startsAtLocal,
        endTimeLocal: template.kind === "custom" ? wizard.customEndTime : template.endsAtLocal,
        notes: wizard.notes,
      });
    });
  });

  return assignments;
}

function templateTimeLabel(template: AttendanceShiftTemplate, wizard?: Pick<WizardState, "customStartTime" | "customEndTime">) {
  if (template.kind === "custom") {
    return `${wizard?.customStartTime ?? "09:00"}-${wizard?.customEndTime ?? "17:00"}`;
  }

  return `${template.startsAtLocal ?? "??"}-${template.endsAtLocal ?? "??"}`;
}

function datesBetween(start: string, end: string) {
  const direction = start <= end ? 1 : -1;
  const dates: string[] = [];
  let cursor = start;

  while ((direction === 1 && cursor <= end) || (direction === -1 && cursor >= end)) {
    dates.push(cursor);
    cursor = addDays(cursor, direction);
  }

  return dates.sort();
}

function createCalendarCells(days: AttendanceDaySummary[]) {
  if (days.length === 0) {
    return [];
  }

  const first = new Date(`${days[0].dateLocal}T12:00:00`);
  const blanks = (first.getDay() + 6) % 7;

  return [...Array.from<null>({ length: blanks }).fill(null), ...days];
}

function summarizeCoverage(days: AttendanceDaySummary[]) {
  return days.reduce(
    (summary, day) => ({
      coveredDays: summary.coveredDays + (day.status !== "gap" ? 1 : 0),
      gapDays: summary.gapDays + (day.status === "gap" ? 1 : 0),
      pendingShifts: summary.pendingShifts + day.pendingCount,
    }),
    { coveredDays: 0, gapDays: 0, pendingShifts: 0 },
  );
}

function dedupeWarnings(warnings: AttendanceAvailabilityStatus["reasons"]) {
  return [...new Map(warnings.map((warning) => [warning.id, warning])).values()];
}

function dayTitle(dateLocal: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "long",
    timeZone: MOTORIST_TIME_ZONE,
    weekday: "long",
  }).format(new Date(`${dateLocal}T12:00:00`));
}

function daySubtitle(day: AttendanceDaySummary) {
  const hours = Math.round(day.shifts.reduce((total, shift) => total + minutesBetween(shift.plannedStartAt, shift.plannedEndAt), 0) / 60);

  return `${day.plannedCount} služby · ${hours} plán. hod. · ${day.confirmedCount} potvrdené`;
}

function monthTitle(dateLocal: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    month: "long",
    timeZone: MOTORIST_TIME_ZONE,
    year: "numeric",
  }).format(new Date(`${dateLocal}T12:00:00`));
}

function dateLabel(dateLocal: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "numeric",
    timeZone: MOTORIST_TIME_ZONE,
  }).format(new Date(`${dateLocal}T12:00:00`));
}

function timeShort(shift: AttendanceShift) {
  return formatShiftTimeRange(shift).replace("-", " ");
}

function formatHours(minutes: number) {
  return `${Math.round(minutes / 60)} h`;
}

function clampWizardStep(value: number): WizardStep {
  return Math.min(3, Math.max(0, value)) as WizardStep;
}

function dayTone(status: AttendanceDaySummary["status"]): "ok" | "warn" | "bad" {
  if (status === "covered") {
    return "ok";
  }

  return status === "pending" ? "warn" : "bad";
}

function shiftTone(status: AttendanceShift["status"]): "ok" | "warn" | "neutral" | "bad" {
  if (status === "confirmed" || status === "completed") {
    return "ok";
  }

  if (status === "published" || status === "draft") {
    return "warn";
  }

  if (status === "declined" || status === "cancelled" || status === "no_show") {
    return "bad";
  }

  return "neutral";
}

function requestStatusTone(status: AttendanceUnavailabilityRequest["status"]): "ok" | "warn" | "neutral" | "bad" {
  if (status === "approved") {
    return "ok";
  }

  if (status === "pending" || status === "draft") {
    return "warn";
  }

  if (status === "declined" || status === "cancelled") {
    return "bad";
  }

  return "neutral";
}

function availabilityTone(status: AttendanceAvailabilityStatus["status"]): "ok" | "warn" | "bad" {
  if (status === "available") {
    return "ok";
  }

  return status === "warning" ? "warn" : "bad";
}

const dayStatusLabel: Record<AttendanceDaySummary["status"], string> = {
  covered: "pokryté",
  pending: "čaká potvrdenie",
  gap: "chýba pokrytie",
};

const shiftStatusLabel: Record<AttendanceShift["status"], string> = {
  draft: "draft",
  published: "publikované",
  confirmed: "potvrdené",
  declined: "odmietnuté",
  completed: "uzavreté",
  cancelled: "zrušené",
  no_show: "no-show",
};

const requestTypeLabel: Record<AttendanceRequestType, string> = {
  vacation: "Dovolenka",
  unavailable: "Nedostupnosť",
  sick_leave: "PN",
  doctor: "Lekár",
  other: "Iné",
};

const requestStatusLabel: Record<AttendanceUnavailabilityRequest["status"], string> = {
  draft: "draft",
  pending: "pending",
  approved: "approved",
  declined: "declined",
  cancelled: "cancelled",
};

const availabilityStatusLabel: Record<AttendanceAvailabilityStatus["status"], string> = {
  available: "dostupný",
  warning: "warning",
  blocked: "blokované",
};

const availabilityRank: Record<AttendanceAvailabilityStatus["status"], number> = {
  available: 0,
  warning: 1,
  blocked: 2,
};

const dayDotClass: Record<AttendanceDaySummary["status"], string> = {
  covered: "bg-emerald-500",
  pending: "bg-amber-500",
  gap: "bg-red-500",
};

const pillClass = {
  ok: "bg-emerald-100 text-emerald-800",
  warn: "bg-amber-100 text-amber-900",
  neutral: "bg-zinc-100 text-zinc-700",
  bad: "bg-red-100 text-red-800",
};

const kpiClass = {
  ok: "border-emerald-200 bg-emerald-50",
  warn: "border-amber-200 bg-amber-50",
  neutral: "border-zinc-200 bg-zinc-50",
  bad: "border-red-200 bg-red-50",
};
