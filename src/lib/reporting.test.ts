import { describe, expect, it } from "vitest";
import { buildReportDashboard, resolveReportRange } from "./reporting";

describe("reporting dashboard", () => {
  it("resolves Bratislava reporting days including the current day", () => {
    expect(resolveReportRange("7d", new Date("2026-07-27T12:00:00.000Z"))).toEqual({
      key: "7d",
      label: "Posledných 7 dní",
      from: "2026-07-20T22:00:00.000Z",
      to: "2026-07-27T22:00:00.000Z",
    });
  });

  it("builds truthful call, operator, task, and case aggregates", () => {
    const range = resolveReportRange("7d", new Date("2026-07-27T12:00:00.000Z"));
    const report = buildReportDashboard({
      range,
      now: new Date("2026-07-27T12:00:00.000Z"),
      profiles: [{ id: "operator-1", display_name: "Jakub" }],
      calls: [
        {
          id: "call-1",
          status: "answered",
          direction: "inbound",
          operator_id: "operator-1",
          case_id: "case-1",
          started_at: "2026-07-21T08:00:00.000Z",
          answered_at: "2026-07-21T08:00:12.000Z",
          wait_seconds: null,
          duration_seconds: 120,
        },
        {
          id: "call-2",
          status: "missed",
          direction: "inbound",
          operator_id: null,
          case_id: null,
          started_at: "2026-07-22T17:00:00.000Z",
          answered_at: null,
          wait_seconds: 45,
          duration_seconds: null,
        },
        {
          id: "call-3",
          status: "ended",
          direction: "outbound",
          operator_id: "operator-1",
          case_id: "case-1",
          started_at: "2026-07-23T10:00:00.000Z",
          answered_at: null,
          wait_seconds: 0,
          duration_seconds: 60,
        },
      ],
      cases: [
        {
          id: "case-1",
          status: "in_progress",
          priority: "high",
          source_type: "assistance",
          owner_id: "operator-1",
          vehicle_details: { jobTypes: ["tow"] },
          replacement_vehicle_details: { needed: true },
          created_at: "2026-07-21T08:05:00.000Z",
          closed_at: null,
        },
        {
          id: "case-2",
          status: "completed_assisted",
          priority: "normal",
          source_type: "client",
          owner_id: "operator-1",
          vehicle_details: { jobTypes: ["onsite_assistance"] },
          replacement_vehicle_details: { needed: false },
          created_at: "2026-07-19T08:00:00.000Z",
          closed_at: "2026-07-24T08:00:00.000Z",
        },
      ],
      tasks: [
        {
          assigned_to: "operator-1",
          completed_by: null,
          completed_at: null,
          created_at: "2026-07-18T08:00:00.000Z",
          due_at: "2026-07-20T08:00:00.000Z",
          status: "open",
        },
        {
          assigned_to: "operator-1",
          completed_by: "operator-1",
          completed_at: "2026-07-25T08:00:00.000Z",
          created_at: "2026-07-23T08:00:00.000Z",
          due_at: "2026-07-26T08:00:00.000Z",
          status: "done",
        },
      ],
      attendance: [
        {
          profile_id: "operator-1",
          started_at: "2026-07-21T07:00:00.000Z",
          ended_at: "2026-07-21T09:00:00.000Z",
        },
      ],
    });

    expect(report.overview).toMatchObject({
      totalCalls: 3,
      answerRate: 50,
      medianWaitSeconds: 12,
      serviceLevel: 100,
      newCases: 1,
      completedCases: 1,
      openTasks: 1,
      overdueTasks: 1,
    });
    expect(report.calls).toMatchObject({
      inboundCalls: 2,
      outboundCalls: 1,
      answeredCalls: 1,
      missedCalls: 1,
      totalTalkSeconds: 180,
      averageDurationSeconds: 90,
      averageWaitSeconds: 12,
      waitSampleSize: 1,
      linkedToCaseRate: 67,
    });
    expect(report.operators.rows[0]).toMatchObject({
      id: "operator-1",
      totalCalls: 2,
      talkSeconds: 180,
      linkedCases: 1,
      completedTasks: 1,
      workedMinutes: 120,
    });
    expect(report.cases).toMatchObject({
      created: 1,
      completed: 1,
      active: 1,
      replacementVehicles: 1,
    });
    expect(report.cases.jobTypes).toContainEqual({ label: "Odťah", value: 1 });
  });

  it("does not present missing wait-time data as zero seconds", () => {
    const range = resolveReportRange("today", new Date("2026-07-27T12:00:00.000Z"));
    const report = buildReportDashboard({
      range,
      now: new Date("2026-07-27T12:00:00.000Z"),
      profiles: [],
      calls: [{
        id: "call-without-timestamps",
        status: "answered",
        direction: "inbound",
        operator_id: null,
        case_id: null,
        started_at: null,
        answered_at: null,
        wait_seconds: null,
        duration_seconds: 30,
      }],
      cases: [],
      tasks: [],
      attendance: [],
    });

    expect(report.overview.medianWaitSeconds).toBeNull();
    expect(report.overview.serviceLevel).toBeNull();
    expect(report.calls.averageWaitSeconds).toBeNull();
    expect(report.calls.waitSampleSize).toBe(0);
    expect(report.calls.waitBuckets.every((bucket) => bucket.value === 0)).toBe(true);
  });
});
