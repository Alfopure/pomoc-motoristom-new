/** A mounted draft can survive navigation without remaining visibly edited. */
export function isCasePanelVisible({ workspaceActive, desktop, mobilePane, mode, toolsOpen }: {
  workspaceActive: boolean;
  desktop: boolean;
  mobilePane: "cases" | "workspace";
  mode: "collapsed" | "split" | "expanded";
  toolsOpen: boolean;
}) {
  if (!workspaceActive || mode === "collapsed") return false;
  // Desktop centre tabs and the right tool rail can coexist with the editor.
  if (desktop) return true;
  return mobilePane === "workspace" && mode === "expanded" && !toolsOpen;
}
