import type { ModuleId } from "./modules";

/** Bar tabs: Prehľad, the user's modules and Moduly. A module that is not in
 * the bar opens inside Moduly, like an app opened from the iPhone Home Screen. */
export type ShellTab = "prehlad" | "moduly" | ModuleId;
export type HovoryView = "console" | "history" | "callbacks";
/** account, search and alerts are full-screen layers over the current tab. */
export type ShellState = { tab: ShellTab; opened: ModuleId | null; account: boolean; search: boolean; alerts: boolean; hovory: HovoryView };
export type ShellLocation = "prehlad" | "moduly" | ModuleId;
/** Screen identifiers understood by the existing module components. */
export type DispatchView = "home" | "modules" | "console" | "history" | "callbacks" | "cases" | "tasks" | "tools" | "account" | "search" | "alerts";

export const initialShell: ShellState = { tab: "prehlad", opened: null, account: false, search: false, alerts: false, hovory: "console" };

export function barTabs(pins: readonly ModuleId[]): ShellTab[] { return ["prehlad", ...pins, "moduly"]; }
export function shellLocation(state: ShellState): ShellLocation {
  return state.tab === "moduly" ? state.opened ?? "moduly" : state.tab;
}
export function dispatchView(state: ShellState): DispatchView {
  if (state.account) return "account";
  if (state.search) return "search";
  if (state.alerts) return "alerts";
  const location = shellLocation(state);
  switch (location) {
    case "prehlad": return "home";
    case "moduly": return "modules";
    case "hovory": return state.hovory;
    case "pripady": return "cases";
    case "ulohy": return "tasks";
    case "nastroje": return "tools";
  }
}
/** Re-selecting Moduly returns to the module grid; other tabs keep their screen.
 * Leaving Moduly keeps the module opened inside it for the next visit. */
export function selectTab(state: ShellState, tab: ShellTab): ShellState {
  if (state.tab === tab) return { ...state, opened: tab === "moduly" ? null : state.opened, account: false, search: false, alerts: false };
  return { ...state, tab, account: false, search: false, alerts: false };
}
/** Opens a module where it lives: its own tab, otherwise inside Moduly. */
export function openModule(state: ShellState, pins: readonly ModuleId[], id: ModuleId, hovory?: HovoryView): ShellState {
  const base = { ...state, account: false, search: false, alerts: false, hovory: id === "hovory" && hovory ? hovory : state.hovory };
  return pins.includes(id) ? { ...base, tab: id } : { ...base, tab: "moduly", opened: id };
}
/** Null means the shell has nothing to close; the system may leave the app. */
export function shellBack(state: ShellState): ShellState | null {
  if (state.account) return { ...state, account: false };
  if (state.search) return { ...state, search: false };
  if (state.alerts) return { ...state, alerts: false };
  if (state.tab === "moduly" && state.opened) return { ...state, opened: null };
  if (state.tab !== "prehlad") return { ...state, tab: "prehlad" };
  return null;
}
/** Keeps the visible screen when the bar or access changes: an unpinned
 * module stays open inside Moduly; a newly pinned one moves to its tab. */
export function reconcileShell(state: ShellState, pins: readonly ModuleId[], available: readonly ModuleId[]): ShellState {
  let next = state;
  if (next.opened && !available.includes(next.opened)) next = { ...next, opened: null };
  if (next.tab !== "prehlad" && next.tab !== "moduly") {
    if (!available.includes(next.tab)) next = { ...next, tab: "prehlad" };
    else if (!pins.includes(next.tab)) next = { ...next, tab: "moduly", opened: next.tab };
  }
  if (next.opened && pins.includes(next.opened)) next = next.tab === "moduly" ? { ...next, tab: next.opened, opened: null } : { ...next, opened: null };
  return next;
}
