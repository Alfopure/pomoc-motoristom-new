import { describe, expect, it } from "vitest";
import { isCasePanelVisible } from "./case-panel-visibility";

describe("case panel presence follows the visible editor", () => {
  const visible = { workspaceActive: true, desktop: true, mobilePane: "workspace" as const, mode: "split" as const, toolsOpen: false };
  it("keeps a desktop editor visible beside tools, but stops on navigation or collapse", () => {
    expect(isCasePanelVisible(visible)).toBe(true);
    expect(isCasePanelVisible({ ...visible, toolsOpen: true, mobilePane: "cases" })).toBe(true);
    expect(isCasePanelVisible({ ...visible, workspaceActive: false })).toBe(false);
    expect(isCasePanelVisible({ ...visible, mode: "collapsed" })).toBe(false);
  });
  it("requires the expanded case pane on mobile and pauses behind tools", () => {
    const mobile = { ...visible, desktop: false, mode: "expanded" as const };
    expect(isCasePanelVisible(mobile)).toBe(true);
    expect(isCasePanelVisible({ ...mobile, mobilePane: "cases" })).toBe(false);
    expect(isCasePanelVisible({ ...mobile, mode: "split" })).toBe(false);
    expect(isCasePanelVisible({ ...mobile, toolsOpen: true })).toBe(false);
    expect(isCasePanelVisible({ ...mobile, workspaceActive: false })).toBe(false);
  });
});
