import { describe, expect, it } from "vitest";

import type { CaseTask, DispatchCase, DispatchNotification } from "@/domain/types";
import { hasLiveUpdates, mergeLiveUpdates } from "./live-updates";

function task(overrides: Partial<CaseTask> = {}): CaseTask {
  return {
    id: "task-1",
    caseId: "case-1",
    title: "Zavolať zákazníkovi",
    assignedTo: "operator-1",
    dueAt: "2026-09-10T12:50:00.000Z",
    status: "open",
    priority: "normal",
    kind: "callback",
    updatedAt: "2026-09-10T12:20:06.000Z",
    ...overrides,
  };
}

function dispatchCase(overrides: Partial<DispatchCase> = {}): DispatchCase {
  return {
    id: "case-1",
    tasks: [],
    timeline: [],
    ...overrides,
  } as unknown as DispatchCase;
}

function snapshot(cases: DispatchCase[], notifications: DispatchNotification[] = []) {
  return { dispatchCases: cases, notifications };
}

describe("live task updates", () => {
  it("adds a task a colleague created and leaves untouched cases identical", () => {
    const other = dispatchCase({ id: "case-2" });
    const current = snapshot([dispatchCase(), other]);
    const next = mergeLiveUpdates(current, { tasks: [task()] });
    expect(next.dispatchCases[0].tasks.map((entry) => entry.id)).toEqual(["task-1"]);
    expect(next.dispatchCases[1]).toBe(other);
    expect(next.notifications).toBe(current.notifications);
  });

  it("replaces a task with its newer copy and keeps a fresher local copy over a stale poll", () => {
    const local = task({ status: "open", updatedAt: "2026-09-10T12:21:26.000Z" });
    const current = snapshot([dispatchCase({ tasks: [local] })]);
    const finished = mergeLiveUpdates(current, { tasks: [task({ status: "done", updatedAt: "2026-09-10T12:22:00.000Z" })] });
    expect(finished.dispatchCases[0].tasks[0].status).toBe("done");

    const stale = mergeLiveUpdates(current, { tasks: [task({ status: "done", updatedAt: "2026-09-10T12:20:06.000Z" })] });
    expect(stale.dispatchCases[0]).toBe(current.dispatchCases[0]);
    expect(stale.dispatchCases[0].tasks[0].status).toBe("open");

    // The same version again (this tab's own action already applied it) is a no-op.
    const same = mergeLiveUpdates(current, { tasks: [task({ status: "done", updatedAt: local.updatedAt })] });
    expect(same.dispatchCases[0]).toBe(current.dispatchCases[0]);
  });

  it("ignores tasks of cases this snapshot does not hold", () => {
    const current = snapshot([dispatchCase()]);
    const next = mergeLiveUpdates(current, { tasks: [task({ id: "task-9", caseId: "case-unknown" })] });
    expect(next.dispatchCases[0]).toBe(current.dispatchCases[0]);
  });

  it("still folds in a newer customer location with its timeline event and new notifications", () => {
    const current = snapshot([dispatchCase({ timeline: [] })], [{ id: "n-1" } as DispatchNotification]);
    const next = mergeLiveUpdates(current, {
      notifications: [{ id: "n-1" } as DispatchNotification, { id: "n-2" } as DispatchNotification],
      updates: [{
        caseId: "case-1",
        event: { id: "location-submission:1", caseId: "case-1", time: "2026-09-10T12:00:00.000Z", actor: "Klient", title: "Poloha od klienta prijatá", body: "" },
        location: { label: "Poloha od klienta", lat: 48.1, lng: 17.1, submittedAt: "2026-09-10T12:00:00.000Z" },
      }],
    });
    expect(next.dispatchCases[0].customerSharedLocation?.submittedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(next.dispatchCases[0].timeline.map((event) => event.id)).toEqual(["location-submission:1"]);
    expect(next.notifications.map((notification) => notification.id)).toEqual(["n-2", "n-1"]);
  });

  it("reports whether a poll result carries anything worth merging", () => {
    expect(hasLiveUpdates({})).toBe(false);
    expect(hasLiveUpdates({ tasks: [task()] })).toBe(true);
    expect(hasLiveUpdates({ notifications: [{ id: "n-1" } as DispatchNotification] })).toBe(true);
  });
});

describe("live updates while the task workspace is active", () => {
  it("leaves the cases' task lists to the workspace store and still folds in notifications", () => {
    // With the workspace on, `dispatchData.tasks` exists and its store polls
    // `/api/tasks` itself; the plain case-task shape from this poll must not
    // overwrite the linked, revisioned tasks it writes into the cases.
    const current = { ...snapshot([dispatchCase({ tasks: [task({ title: "Z workspace" })] })]), tasks: [task()] };
    const incoming = task({ title: "Z pollu", updatedAt: "2026-09-10T13:00:00.000Z" });
    const notification = { id: "n-1", status: "unread", severity: "info", createdAt: "2026-09-10T13:00:00.000Z" } as unknown as DispatchNotification;

    const merged = mergeLiveUpdates(current, { tasks: [incoming], notifications: [notification] });

    expect(merged.dispatchCases[0]).toBe(current.dispatchCases[0]);
    expect(merged.dispatchCases[0].tasks[0].title).toBe("Z workspace");
    expect(merged.notifications.map((entry) => entry.id)).toEqual(["n-1"]);
    expect(merged.tasks).toBe(current.tasks);
  });

  it("merges polled tasks into the cases as before when the workspace list is absent", () => {
    const current = snapshot([dispatchCase()]);
    const merged = mergeLiveUpdates(current, { tasks: [task({ title: "Z pollu" })] });
    expect(merged.dispatchCases[0].tasks.map((entry) => entry.title)).toEqual(["Z pollu"]);
  });
});
