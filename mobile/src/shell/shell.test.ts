import { describe, expect, it } from "vitest";
import { memoryStorage } from "../lib/session-storage";
import { MODULES, PIN_LIMIT, isModuleId, moduleAccess, moduleById, rolePins, type ModuleId } from "./modules";
import { movingPin, normalizePins, pinsFull, replacingPin, samePins, withPin, withoutPin } from "./pins";
import { barTabs, dispatchView, initialShell, openModule, reconcileShell, selectTab, shellBack, shellLocation, type ShellState } from "./navigation";
import { ShellPreferences, parseShellPreferences, shellPreferencesKey } from "./preferences";
import { ShellBackStore } from "./back-store";

const all: ModuleId[] = ["hovory", "pripady", "ulohy", "nastroje"];

describe("module registry", () => {
  it("has unique ids and readable names", () => {
    expect(new Set(MODULES.map(item => item.id)).size).toBe(MODULES.length);
    for (const item of MODULES) { expect(item.name.length).toBeGreaterThan(2); expect(item.short.length).toBeLessThanOrEqual(9); }
  });
  it("derives access and role defaults", () => {
    expect(moduleAccess("dispatcher")).toEqual(all);
    expect(rolePins("manager")).toEqual(["hovory", "pripady", "ulohy"]);
    expect(rolePins("dispatcher")).toHaveLength(PIN_LIMIT);
    expect(moduleAccess("unknown" as never)).toEqual([]);
    expect(rolePins("unknown" as never)).toEqual([]);
    expect(isModuleId("pripady")).toBe(true);
    expect(isModuleId("vozidla")).toBe(false);
    expect(moduleById("nastroje").short).toBe("Nástroje");
    expect(() => moduleById("x" as ModuleId)).toThrow();
  });
});

describe("pins", () => {
  it("normalizes stored values against access", () => {
    expect(normalizePins(["nastroje", "nastroje", "vozidla", 3, "hovory"], all, ["pripady"])).toEqual(["nastroje", "hovory"]);
    expect(normalizePins(["hovory", "pripady", "ulohy", "nastroje"], all, [])).toEqual(["hovory", "pripady", "ulohy"]);
    expect(normalizePins(null, all, ["ulohy", "vozidla" as ModuleId])).toEqual(["ulohy"]);
    expect(normalizePins([], all, ["ulohy"])).toEqual([]);
    expect(normalizePins(["nastroje"], ["hovory"], ["hovory"])).toEqual([]);
  });
  it("adds, removes, replaces and moves", () => {
    expect(withPin(["hovory"], "nastroje")).toEqual(["hovory", "nastroje"]);
    expect(withPin(["hovory", "pripady", "ulohy"], "nastroje")).toEqual(["hovory", "pripady", "ulohy"]);
    expect(withPin(["hovory"], "hovory")).toEqual(["hovory"]);
    expect(pinsFull(["hovory", "pripady", "ulohy"])).toBe(true);
    expect(withoutPin(["hovory", "pripady"], "hovory")).toEqual(["pripady"]);
    expect(replacingPin(["hovory", "pripady", "ulohy"], "pripady", "nastroje")).toEqual(["hovory", "nastroje", "ulohy"]);
    expect(replacingPin(["hovory", "pripady"], "ulohy", "nastroje")).toEqual(["hovory", "pripady"]);
    expect(replacingPin(["hovory", "pripady"], "hovory", "pripady")).toEqual(["hovory", "pripady"]);
    expect(movingPin(["hovory", "pripady", "ulohy"], 0, 2)).toEqual(["pripady", "ulohy", "hovory"]);
    expect(movingPin(["hovory", "pripady", "ulohy"], 2, -5)).toEqual(["ulohy", "hovory", "pripady"]);
    expect(movingPin(["hovory"], 3, 0)).toEqual(["hovory"]);
    expect(samePins(["hovory"], ["hovory"])).toBe(true);
    expect(samePins(["hovory"], ["pripady"])).toBe(false);
  });
});

describe("shell navigation", () => {
  const pins: ModuleId[] = ["hovory", "pripady", "ulohy"];
  it("maps locations to existing module screens", () => {
    expect(barTabs(pins)).toEqual(["prehlad", "hovory", "pripady", "ulohy", "moduly"]);
    expect(dispatchView(initialShell)).toBe("home");
    expect(dispatchView({ ...initialShell, tab: "moduly" })).toBe("modules");
    expect(dispatchView({ ...initialShell, tab: "hovory", hovory: "callbacks" })).toBe("callbacks");
    expect(dispatchView({ ...initialShell, tab: "moduly", opened: "nastroje" })).toBe("tools");
    expect(dispatchView({ ...initialShell, tab: "pripady", account: true })).toBe("account");
    expect(shellLocation({ ...initialShell, tab: "moduly", opened: "ulohy" })).toBe("ulohy");
    expect(dispatchView({ ...initialShell, tab: "pripady", search: true })).toBe("search");
    expect(dispatchView({ ...initialShell, search: true, account: true })).toBe("account");
  });
  it("opens modules in their tab or inside Moduly and keeps stacks per tab", () => {
    const tools = openModule(initialShell, pins, "nastroje");
    expect(tools).toMatchObject({ tab: "moduly", opened: "nastroje" });
    const away = selectTab(tools, "prehlad");
    expect(away).toMatchObject({ tab: "prehlad", opened: "nastroje" });
    expect(shellLocation(selectTab(away, "moduly"))).toBe("nastroje");
    expect(selectTab(tools, "moduly")).toMatchObject({ tab: "moduly", opened: null });
    expect(openModule({ ...initialShell, account: true }, pins, "hovory", "callbacks")).toMatchObject({ tab: "hovory", hovory: "callbacks", account: false });
    expect(openModule(initialShell, pins, "pripady", "history")).toMatchObject({ tab: "pripady", hovory: "console" });
  });
  it("goes back from account, an opened module and other tabs", () => {
    const opened: ShellState = { ...initialShell, tab: "moduly", opened: "nastroje", account: true };
    expect(shellBack(opened)).toMatchObject({ account: false, opened: "nastroje" });
    expect(shellBack({ ...opened, account: false })).toMatchObject({ tab: "moduly", opened: null });
    expect(shellBack({ ...initialShell, tab: "moduly" })).toMatchObject({ tab: "prehlad" });
    expect(shellBack({ ...initialShell, tab: "pripady" })).toMatchObject({ tab: "prehlad" });
    expect(shellBack(initialShell)).toBeNull();
    expect(shellBack({ ...initialShell, search: true })).toMatchObject({ search: false, tab: "prehlad" });
    expect(selectTab({ ...initialShell, search: true }, "pripady")).toMatchObject({ tab: "pripady", search: false });
    expect(openModule({ ...initialShell, search: true }, ["pripady"], "pripady")).toMatchObject({ tab: "pripady", search: false });
  });
  it("keeps the visible screen when the bar or access changes", () => {
    expect(reconcileShell({ ...initialShell, tab: "pripady" }, ["hovory"], all)).toMatchObject({ tab: "moduly", opened: "pripady" });
    expect(reconcileShell({ ...initialShell, tab: "moduly", opened: "nastroje" }, ["nastroje"], all)).toMatchObject({ tab: "nastroje", opened: null });
    expect(reconcileShell({ ...initialShell, tab: "pripady" }, [], ["hovory"])).toMatchObject({ tab: "prehlad" });
    expect(reconcileShell({ ...initialShell, tab: "moduly", opened: "ulohy" }, [], ["hovory"])).toMatchObject({ tab: "moduly", opened: null });
    expect(reconcileShell({ ...initialShell, tab: "prehlad", opened: "nastroje" }, ["nastroje"], all)).toMatchObject({ tab: "prehlad", opened: null });
    const same = { ...initialShell, tab: "hovory" as const };
    expect(reconcileShell(same, pins, all)).toBe(same);
  });
});

describe("shell preferences", () => {
  const scope = { environment: "test", userId: "11111111-1111-4111-8111-111111111111", profileId: "22222222-2222-4222-8222-222222222222" };
  it("builds a storage-safe key and parses defensively", () => {
    expect(shellPreferencesKey(scope)).toBe("pm-shell-v1.test." + scope.userId + "." + scope.profileId);
    expect(() => shellPreferencesKey({ ...scope, userId: "a/b" })).toThrow();
    expect(parseShellPreferences(null)).toEqual({ version: 1, pins: null, tipDismissed: false });
    expect(parseShellPreferences("{")).toEqual({ version: 1, pins: null, tipDismissed: false });
    expect(parseShellPreferences(JSON.stringify({ version: 2, pins: ["hovory"] })).pins).toBeNull();
    expect(parseShellPreferences(JSON.stringify({ version: 1, pins: ["hovory", 4] })).pins).toBeNull();
    expect(parseShellPreferences(JSON.stringify({ version: 1, pins: [], tipDismissed: true }))).toEqual({ version: 1, pins: [], tipDismissed: true });
  });
  it("loads, changes, persists and resets", async () => {
    const storage = memoryStorage();
    const key = shellPreferencesKey(scope);
    await storage.setItem(key, JSON.stringify({ version: 1, pins: ["nastroje", "hovory"], tipDismissed: false }));
    const prefs = new ShellPreferences(storage, key, all, ["hovory", "pripady", "ulohy"]);
    let notified = 0;
    prefs.subscribe(() => { notified++; });
    expect(prefs.snapshot()).toMatchObject({ pins: ["hovory", "pripady", "ulohy"], loaded: false, customized: false });
    await prefs.load();
    expect(prefs.snapshot()).toMatchObject({ pins: ["nastroje", "hovory"], loaded: true, customized: true });
    prefs.setPins(["ulohy"]);
    prefs.dismissTip();
    await prefs.flush();
    expect(parseShellPreferences(await storage.getItem(key))).toEqual({ version: 1, pins: ["ulohy"], tipDismissed: true });
    prefs.reset();
    await prefs.flush();
    expect(prefs.snapshot()).toMatchObject({ pins: ["hovory", "pripady", "ulohy"], customized: false, tipDismissed: true });
    expect(notified).toBeGreaterThanOrEqual(4);
  });
  it("keeps a choice made during loading and reports failed saves", async () => {
    let release: () => void = () => {};
    const slow = { ...memoryStorage(), getItem: () => new Promise<string | null>(resolve => { release = () => resolve(JSON.stringify({ version: 1, pins: ["nastroje"], tipDismissed: false })); }) };
    const prefs = new ShellPreferences(slow, "k", all, ["hovory"]);
    const loading = prefs.load();
    prefs.setPins(["pripady"]);
    release();
    await loading;
    expect(prefs.snapshot()).toMatchObject({ pins: ["pripady"], loaded: true });
    const failing = { getItem: async () => null, setItem: async () => { throw new Error("full"); }, removeItem: async () => {} };
    const broken = new ShellPreferences(failing, "k", all, ["hovory"]);
    broken.setPins(["ulohy"]);
    await broken.flush();
    expect(broken.snapshot()).toMatchObject({ pins: ["ulohy"], saveError: true });
    broken.dispose();
    broken.setPins(["hovory"]);
    expect(broken.snapshot().pins).toEqual(["ulohy"]);
  });
  it("shows defaults for an unreadable value without treating it as loaded, then retries", async () => {
    let locked = true;
    const storage = { ...memoryStorage(), getItem: async () => { if (locked) throw new Error("locked"); return JSON.stringify({ version: 1, pins: ["nastroje"], tipDismissed: true }); } };
    const prefs = new ShellPreferences(storage, "k", all, ["hovory"]);
    await prefs.load();
    expect(prefs.snapshot()).toMatchObject({ pins: ["hovory"], loaded: false, readFailed: true, customized: false });
    locked = false;
    await prefs.load();
    expect(prefs.snapshot()).toMatchObject({ pins: ["nastroje"], loaded: true, readFailed: false, tipDismissed: true });
  });
});

describe("shell back store", () => {
  it("shows the latest active registration and notifies only on change", () => {
    const store = new ShellBackStore();
    let notified = 0;
    store.subscribe(() => { notified++; });
    const detail = store.nextId(), form = store.nextId();
    expect(store.snapshot()).toBeNull();
    const back = () => {};
    store.set(detail, { label: "Prípady", onBack: back, disabled: false });
    expect(store.snapshot()?.label).toBe("Prípady");
    store.set(form, { label: "Prípad", onBack: back, disabled: true });
    expect(store.snapshot()).toMatchObject({ label: "Prípad", disabled: true });
    store.set(form, null);
    expect(store.snapshot()?.label).toBe("Prípady");
    store.set(form, null);
    store.set(detail, null);
    expect(store.snapshot()).toBeNull();
    expect(notified).toBe(4);
  });
});
