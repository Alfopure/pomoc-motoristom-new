import { describe, expect, it } from "vitest";
import { defaultWorkspacePreferences, moveWidget, parseWorkspacePreferences, workspacePreferenceStorageKey, WIDGET_IDS } from "./workspace-preferences";

describe("workspace preferences", () => {
  it("keeps familiar tools visible initially", () => {
    expect(defaultWorkspacePreferences().widgets.filter(widget => widget.visible).map(widget => widget.id)).toEqual(["phone", "tasks"]);
  });
  it.each([null, "", "[]", "broken", "null", "3"])("recovers invalid preferences %s", raw => {
    expect(parseWorkspacePreferences(raw)).toEqual(defaultWorkspacePreferences());
  });
  it("deduplicates valid tools, ignores unknown ids and restores missing tools", () => {
    const parsed = parseWorkspacePreferences(JSON.stringify({ widgets: [{ id: "calculator", visible: true, collapsed: true }, { id: "calculator" }, { id: "evil", visible: true }], centerView: "notes", leftCollapsed: "true" }));
    expect(parsed.widgets[0]).toEqual({ id: "calculator", visible: true, collapsed: true });
    expect(new Set(parsed.widgets.map(item => item.id)).size).toBe(WIDGET_IDS.length);
    expect(parsed.centerView).toBe("notes");
    expect(parsed.leftCollapsed).toBe(false);
  });
  it("moves without mutating or dropping preferences", () => {
    const widgets = defaultWorkspacePreferences().widgets;
    const moved = moveWidget(widgets, "route", 0);
    expect(moved[0].id).toBe("route");
    expect(widgets[0].id).toBe("phone");
    expect(moveWidget(widgets, "route", -1)).toBe(widgets);
    expect(parseWorkspacePreferences(JSON.stringify({ widgets: moved })).widgets).toEqual(moved);
  });
  it("isolates both organization and profile", () => {
    expect(new Set([workspacePreferenceStorageKey("a", "p"), workspacePreferenceStorageKey("b", "p"), workspacePreferenceStorageKey("a", "q")]).size).toBe(3);
  });
});
