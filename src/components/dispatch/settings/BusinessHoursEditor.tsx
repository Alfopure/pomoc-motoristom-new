"use client";

import { useMemo, useState } from "react";
import { CalendarClock, CalendarPlus, Clock, Copy, Loader2, Plus, Save, Trash2 } from "lucide-react";

import type { RoutingDocument, ValidationIssue } from "@/server/telephony/config-service";

import {
  DEFAULT_TIMEZONE,
  WEEKDAYS,
  addException,
  addExceptionInterval,
  addInterval,
  addSchedule,
  businessHoursDirty,
  businessHoursPayload,
  clearDay,
  copyDayToWeekdays,
  describeException,
  describeNow,
  describeWeek,
  isAroundTheClock,
  isEmptySchedule,
  MIDNIGHT_CLOSE,
  linesUsingSchedule,
  overlappingWeekdays,
  removeException,
  removeExceptionInterval,
  removeInterval,
  removeSchedule,
  scheduleDraftsFromDocument,
  setDayAroundTheClock,
  todayInSchedule,
  updateException,
  updateExceptionInterval,
  updateInterval,
  updateSchedule,
  validateScheduleDrafts,
  type ScheduleDraft,
} from "./business-hours-model";
import { ConfigRequestError, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { issuesByPath } from "./ring-groups-model";
import { SettingsField, SettingsIssueList, SettingsNotice, SettingsSectionHeader, settingsInputClass, useMinuteClock } from "./settings-ui";

/**
 * Business hours screen (plan "Fáza 3"): when a line is open, when it is not,
 * and which dates are different. Several intervals on one weekday express a
 * lunch break or a split shift; an exception closes a public holiday or gives
 * it its own hours.
 *
 * The component only renders and forwards events; drafting, validation, the
 * payload and the preview live in `business-hours-model.ts`, which previews
 * through the same evaluator the session runner uses.
 */
export function BusinessHoursEditor({
  canEdit,
  document,
  onSaved,
}: {
  canEdit: boolean;
  document: RoutingDocument;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [schedules, setSchedules] = useState<ScheduleDraft[]>(() => scheduleDraftsFromDocument(document.businessHours));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // `null` until the browser has a clock: the "open right now" preview must not
  // be rendered on the server, where "now" means something else.
  const now = useMinuteClock();

  const issues = useMemo(() => validateScheduleDrafts(schedules, { lines: document.lines }), [document.lines, schedules]);
  const issuesFor = useMemo(() => issuesByPath(issues), [issues]);
  const formIssues = [...(issuesFor.get("") ?? []), ...serverIssues];
  const dirty = businessHoursDirty(schedules, document.businessHours);

  async function save() {
    if (saving || !canEdit) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setServerIssues([]);
    try {
      const response = await saveRoutingConfig("businessHours", { businessHours: businessHoursPayload(schedules), version: document.routingVersion });
      onSaved(response);
      const saved = "Otváracie hodiny sú uložené. Prebiehajúce hovory sa nemenia.";
      setNotice(response.warning ? `${saved} ${response.warning}` : saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Otváracie hodiny sa nepodarilo uložiť.");
      if (caught instanceof ConfigRequestError) setServerIssues(caught.issues);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white" aria-labelledby="business-hours-heading">
      <SettingsSectionHeader
        icon={CalendarClock}
        title="Otváracie hodiny"
        description={`Kedy linka zvoní a kedy ponúkne spätné volanie. Časy sú v pásme ${DEFAULT_TIMEZONE}.`}
      />

      <div className="grid gap-4 p-4">
        <h3 id="business-hours-heading" className="sr-only">
          Otváracie hodiny
        </h3>

        {!canEdit && <SettingsNotice tone="info">Nastavenia vidíš len na čítanie. Zmeny môže uložiť manažér alebo admin.</SettingsNotice>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
        {formIssues.length > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
            <SettingsIssueList issues={formIssues} />
          </div>
        )}

        {schedules.length === 0 && (
          <SettingsNotice tone="warning">Zatiaľ nie sú vytvorené žiadne otváracie hodiny. Linka bez nich zvoní nonstop.</SettingsNotice>
        )}

        {schedules.map((schedule) => {
          const usedBy = linesUsingSchedule(schedule.id, document.lines);
          const overlapping = overlappingWeekdays(schedule);
          const week = describeWeek(schedule);

          return (
            <div key={schedule.key} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,220px)_auto_auto]">
                <SettingsField label="Názov">
                  <input
                    className={settingsInputClass}
                    disabled={!canEdit}
                    value={schedule.name}
                    onChange={(event) => setSchedules((current) => updateSchedule(current, schedule.key, { name: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Časové pásmo" hint="Pásmo sa nastavuje pri zavedení organizácie.">
                  <input className={settingsInputClass} value={schedule.timezone} readOnly disabled />
                </SettingsField>
                <div className="flex items-end pb-1">
                  <label className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#FCD703]"
                      disabled={!canEdit}
                      checked={schedule.active}
                      onChange={(event) => setSchedules((current) => updateSchedule(current, schedule.key, { active: event.target.checked }))}
                    />
                    Aktívne
                  </label>
                </div>
                <div className="flex items-end pb-1">
                  <button
                    type="button"
                    disabled={!canEdit || usedBy.length > 0}
                    title={usedBy.length > 0 ? `Používajú ich linky: ${usedBy.join(", ")}.` : undefined}
                    onClick={() => setSchedules((current) => removeSchedule(current, schedule.key))}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Zmazať
                  </button>
                </div>
              </div>

              <div className="mt-2 grid gap-1 text-xs">
                {now && <p className={schedule.active ? "text-zinc-600" : "text-amber-700"}>{describeNow(schedule, now)}</p>}
                {!schedule.active && <p className="text-amber-700">Rozvrh je vypnutý — linka s ním zvoní nonstop.</p>}
                {schedule.active && isEmptySchedule(schedule) && schedule.exceptions.length > 0 && (
                  <p className="text-amber-700">Rozvrh nemá žiadny týždenný interval, otvorené budú len dni s výnimkou.</p>
                )}
                {usedBy.length > 0 && <p className="text-zinc-600">Používajú ich linky: {usedBy.join(", ")}.</p>}
                {overlapping.length > 0 && (
                  <p className="text-amber-700">
                    Prekrývajúce sa intervaly: {overlapping.map((weekday) => WEEKDAYS[weekday - 1].label).join(", ")}.
                  </p>
                )}
              </div>

              <SettingsIssueList issues={issuesFor.get(schedule.key) ?? []} />

              <div className="mt-3 grid gap-2">
                <span className="text-xs font-semibold uppercase text-zinc-500">Týždenný rozvrh</span>
                {WEEKDAYS.map(({ weekday, label }) => {
                  const intervals = schedule.days.get(weekday) ?? [];
                  // `00:00 – 24:00` is the only honest "open around the clock":
                  // the evaluator is `minutes < closes`, so 23:59 would leave
                  // the last minute of the day after-hours. `<input type="time">`
                  // cannot express 24:00, hence the dedicated toggle.
                  const aroundTheClock = isAroundTheClock(schedule, weekday);
                  return (
                    <div key={weekday} className="grid gap-2 rounded-md border border-zinc-200 bg-white p-2 sm:grid-cols-[110px_minmax(0,1fr)_auto] sm:items-start">
                      <div className="pt-2 text-sm font-semibold text-zinc-800">
                        {label}
                        {intervals.length === 0 && <span className="ml-2 text-xs font-normal text-zinc-500">Zatvorené</span>}
                      </div>

                      <div className="grid gap-2">
                        {aroundTheClock ? (
                          <p className="pt-2 text-sm font-medium text-emerald-800">Otvorené nonstop (00:00 – {MIDNIGHT_CLOSE}).</p>
                        ) : (
                          intervals.map((interval) => (
                          <div key={interval.key}>
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="time"
                                aria-label={`${label} – otvorenie`}
                                className={`${settingsInputClass} w-32`}
                                disabled={!canEdit}
                                value={interval.opens}
                                onChange={(event) => setSchedules((current) => updateInterval(current, schedule.key, weekday, interval.key, { opens: event.target.value }))}
                              />
                              <span className="text-sm text-zinc-500">–</span>
                              <input
                                type="time"
                                aria-label={`${label} – zatvorenie`}
                                className={`${settingsInputClass} w-32`}
                                disabled={!canEdit}
                                value={interval.closes}
                                onChange={(event) => setSchedules((current) => updateInterval(current, schedule.key, weekday, interval.key, { closes: event.target.value }))}
                              />
                              <button
                                type="button"
                                disabled={!canEdit}
                                aria-label={`Odobrať interval (${label})`}
                                onClick={() => setSchedules((current) => removeInterval(current, schedule.key, weekday, interval.key))}
                                className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            </div>
                            <SettingsIssueList issues={issuesFor.get(interval.key) ?? []} />
                          </div>
                          ))
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={!canEdit || aroundTheClock}
                          onClick={() => setSchedules((current) => addInterval(current, schedule.key, weekday))}
                          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Plus size={14} aria-hidden="true" />
                          Interval
                        </button>
                        <button
                          type="button"
                          disabled={!canEdit}
                          title={`Otvorené celý deň, 00:00 – ${MIDNIGHT_CLOSE}. Zatvorenie o 23:59 by nechalo poslednú minútu dňa mimo otváracích hodín.`}
                          onClick={() =>
                            setSchedules((current) => (aroundTheClock ? clearDay(current, schedule.key, weekday) : setDayAroundTheClock(current, schedule.key, weekday)))
                          }
                          className={`inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-xs font-semibold hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 ${
                            aroundTheClock ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-zinc-200 bg-white text-zinc-800"
                          }`}
                        >
                          <Clock size={14} aria-hidden="true" />
                          {aroundTheClock ? "Zrušiť nonstop" : "Nonstop"}
                        </button>
                        {intervals.length > 0 && !aroundTheClock && (
                          <button
                            type="button"
                            disabled={!canEdit}
                            title="Skopíruje tento deň na pondelok až piatok."
                            onClick={() => setSchedules((current) => copyDayToWeekdays(current, schedule.key, weekday, [1, 2, 3, 4, 5]))}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Copy size={14} aria-hidden="true" />
                            Po–Pi
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase text-zinc-500">Výnimky ({schedule.exceptions.length})</span>
                  <button
                    type="button"
                    disabled={!canEdit || !now}
                    onClick={() => setSchedules((current) => addException(current, schedule.key, now ? todayInSchedule(schedule, now) : ""))}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <CalendarPlus size={15} aria-hidden="true" />
                    Pridať výnimku
                  </button>
                </div>

                {schedule.exceptions.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-600">
                    Žiadna výnimka. Sviatok alebo skrátený deň pridaj tu — v ten dátum platí výnimka namiesto týždenného rozvrhu.
                  </p>
                ) : (
                  <div className="grid gap-2">
                    {schedule.exceptions.map((exception) => (
                      <div key={exception.key} className="rounded-md border border-zinc-200 bg-white p-2">
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,170px)_minmax(0,180px)_minmax(0,1fr)_auto] sm:items-end">
                          <SettingsField label="Dátum">
                            <input
                              type="date"
                              className={settingsInputClass}
                              disabled={!canEdit}
                              value={exception.date}
                              onChange={(event) => setSchedules((current) => updateException(current, schedule.key, exception.key, { date: event.target.value }))}
                            />
                          </SettingsField>
                          <SettingsField label="Režim">
                            <select
                              className={settingsInputClass}
                              disabled={!canEdit}
                              value={exception.closed ? "closed" : "open"}
                              onChange={(event) => setSchedules((current) => updateException(current, schedule.key, exception.key, { closed: event.target.value === "closed" }))}
                            >
                              <option value="closed">Zatvorené celý deň</option>
                              <option value="open">Otvorené inak</option>
                            </select>
                          </SettingsField>
                          <SettingsField label="Popis">
                            <input
                              className={settingsInputClass}
                              disabled={!canEdit}
                              placeholder="Napríklad Štedrý deň"
                              value={exception.label}
                              onChange={(event) => setSchedules((current) => updateException(current, schedule.key, exception.key, { label: event.target.value }))}
                            />
                          </SettingsField>
                          <button
                            type="button"
                            disabled={!canEdit}
                            aria-label={`Odobrať výnimku ${exception.date}`}
                            onClick={() => setSchedules((current) => removeException(current, schedule.key, exception.key))}
                            className="mb-1 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Odobrať
                          </button>
                        </div>

                        {!exception.closed && (
                          <div className="mt-2 grid gap-2">
                            {exception.intervals.map((interval) => (
                              <div key={interval.key}>
                                <div className="flex flex-wrap items-center gap-2">
                                  <input
                                    type="time"
                                    aria-label={`Výnimka ${exception.date} – otvorenie`}
                                    className={`${settingsInputClass} w-32`}
                                    disabled={!canEdit}
                                    value={interval.opens}
                                    onChange={(event) =>
                                      setSchedules((current) => updateExceptionInterval(current, schedule.key, exception.key, interval.key, { opens: event.target.value }))
                                    }
                                  />
                                  <span className="text-sm text-zinc-500">–</span>
                                  <input
                                    type="time"
                                    aria-label={`Výnimka ${exception.date} – zatvorenie`}
                                    className={`${settingsInputClass} w-32`}
                                    disabled={!canEdit}
                                    value={interval.closes}
                                    onChange={(event) =>
                                      setSchedules((current) => updateExceptionInterval(current, schedule.key, exception.key, interval.key, { closes: event.target.value }))
                                    }
                                  />
                                  <button
                                    type="button"
                                    disabled={!canEdit}
                                    aria-label={`Odobrať interval výnimky ${exception.date}`}
                                    onClick={() => setSchedules((current) => removeExceptionInterval(current, schedule.key, exception.key, interval.key))}
                                    className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <Trash2 size={14} aria-hidden="true" />
                                  </button>
                                </div>
                                <SettingsIssueList issues={issuesFor.get(interval.key) ?? []} />
                              </div>
                            ))}
                            <div>
                              <button
                                type="button"
                                disabled={!canEdit}
                                onClick={() => setSchedules((current) => addExceptionInterval(current, schedule.key, exception.key))}
                                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <Plus size={14} aria-hidden="true" />
                                Interval výnimky
                              </button>
                            </div>
                          </div>
                        )}

                        <p className="mt-1 text-xs text-zinc-600">{describeException(exception)}</p>
                        <SettingsIssueList issues={issuesFor.get(exception.key) ?? []} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-md border border-zinc-200 bg-white p-2">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-zinc-500">
                  <Clock size={14} aria-hidden="true" />
                  Zhrnutie týždňa
                </div>
                <ul className="grid gap-0.5 text-xs text-zinc-700 sm:grid-cols-2">
                  {week.map((day) => (
                    <li key={day.weekday} className={day.open ? "" : "text-zinc-500"}>
                      <span className="font-medium">{day.label}:</span> {day.text}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-3">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => setSchedules((current) => addSchedule(current))}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" />
            Pridať rozvrh
          </button>
          <button
            type="button"
            disabled={!canEdit || saving || !dirty || issues.length > 0}
            onClick={() => void save()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
            Uložiť otváracie hodiny
          </button>
          {dirty && issues.length === 0 && <span className="text-xs font-medium text-amber-700">Neuložené zmeny.</span>}
          {issues.length > 0 && <span className="text-xs font-medium text-red-700">Najprv oprav označené polia.</span>}
        </div>
      </div>
    </section>
  );
}
