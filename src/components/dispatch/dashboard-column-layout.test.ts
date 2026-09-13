import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_COLUMNS, fitDashboardColumns, parseDashboardColumnWidths, resizeDashboardColumn } from "./dashboard-column-layout";

describe("dashboard column preferences", () => {
  it("temporarily fits small screens without losing the wide-screen choice", () => {
    const preferred = { left: 480, right: 480 };
    expect(fitDashboardColumns(preferred, 1600, true)).toEqual(preferred);
    expect(fitDashboardColumns(preferred, 1280, true)).toEqual({ left: 480, right: 320 });
    expect(fitDashboardColumns(preferred, 390, false)).toEqual({ left: 260, right: 480 });
    expect(fitDashboardColumns(preferred, 1600, true)).toEqual({ left: 480, right: 480 });
    expect(preferred).toEqual({ left: 480, right: 480 });
  });

  it("resizing one rail retains the other rail's saved width even when it is fitted", () => {
    const preferred = { left: 480, right: 480 };
    const next = resizeDashboardColumn(preferred, "left", 420, 1280, true);
    expect(next).toEqual({ left: 420, right: 480 });
    expect(fitDashboardColumns(next, 1280, true)).toEqual({ left: 420, right: 380 });
    expect(fitDashboardColumns(next, 1600, true)).toEqual({ left: 420, right: 480 });
  });

  it("bounds user changes to the currently available space", () => {
    expect(resizeDashboardColumn({ left: 480, right: 480 }, "right", 600, 1280, true)).toEqual({ left: 480, right: 320 });
    expect(resizeDashboardColumn({ left: 330, right: 480 }, "left", -100, 1600, true)).toEqual({ left: 260, right: 480 });
  });

  it.each([null, "", "broken", "null", "[]", "23", "{}"])("uses defaults for a missing or invalid actor preference: %s", raw => {
    expect(parseDashboardColumnWidths(raw)).toEqual(DEFAULT_DASHBOARD_COLUMNS);
  });

  it("recovers valid rail preferences independently", () => {
    expect(parseDashboardColumnWidths('{"left":420,"right":"480"}')).toEqual({ left: 420, right: 330 });
    expect(parseDashboardColumnWidths('{"left":1e999,"right":999}')).toEqual({ left: 330, right: 480 });
  });
});
