import type { MobileRole } from "../../../src/lib/mobile-api";

/** Modules available in this native release. A new feature adds its manifest
 * here; the bar, Moduly and Prehľad assemble themselves from this list. */
export type ModuleId = "hovory" | "pripady" | "ulohy" | "nastroje" | "pristavenia";
export type ModuleGroup = "komunikacia" | "zasahy" | "kancelaria" | "nastroje";
export type ShellModule = {
  id: ModuleId; name: string; short: string; group: ModuleGroup;
  color: string; ink: string; description: string;
};

export const MODULES: readonly ShellModule[] = [
  { id: "hovory", name: "Hovory", short: "Hovory", group: "komunikacia", color: "#34C759", ink: "#FFFFFF", description: "Ústredňa, história a spätné volania" },
  { id: "pripady", name: "Prípady", short: "Prípady", group: "zasahy", color: "#E6C200", ink: "#000000", description: "Asistenčné prípady, poznámky, prílohy a odovzdanie" },
  { id: "ulohy", name: "Moje úlohy", short: "Úlohy", group: "kancelaria", color: "#007AFF", ink: "#FFFFFF", description: "Úlohy naprieč prípadmi, ktoré riešite alebo kontrolujete" },
  { id: "nastroje", name: "Nástroje", short: "Nástroje", group: "nastroje", color: "#636366", ink: "#FFFFFF", description: "Vozidlo podľa EČV, trasa, mapa a flotila" },
  { id: "pristavenia", name: "Pristavenia", short: "Pristavenia", group: "zasahy", color: "#30B0C7", ink: "#FFFFFF", description: "Náhradné vozidlá: kam ísť, ktoré auto, kroky a poloha" },
];
export const GROUPS: readonly { id: ModuleGroup; name: string }[] = [
  { id: "komunikacia", name: "Komunikácia" }, { id: "zasahy", name: "Zásahy" },
  { id: "kancelaria", name: "Kancelária" }, { id: "nastroje", name: "Nástroje" },
];
/** Prehľad, three own modules and Moduly fit the five-item system bar. */
export const PIN_LIMIT = 3;

const everything: readonly ModuleId[] = MODULES.map(item => item.id);
/** Dispečing: its modules come with a dispatch role; Pristavenia with the role
 * pristavovač. One person may have both and sees both in the one app. */
const dispatchModules: readonly ModuleId[] = ["hovory", "pripady", "ulohy", "nastroje"];
// Presentation only: every module API still authorizes each request on the server.
const roleModules: Record<MobileRole, readonly ModuleId[]> = {
  dispatcher: dispatchModules, senior_dispatcher: dispatchModules, manager: dispatchModules, admin: dispatchModules,
};
const rolePinDefaults: Record<MobileRole, readonly ModuleId[]> = {
  dispatcher: ["hovory", "pripady", "ulohy"], senior_dispatcher: ["hovory", "pripady", "ulohy"],
  manager: ["hovory", "pripady", "ulohy"], admin: ["hovory", "pripady", "ulohy"],
};
export const roleNames: Record<MobileRole, string> = {
  dispatcher: "Dispečer", senior_dispatcher: "Vedúci dispečer", manager: "Manažér", admin: "Administrátor",
};
export const DELIVERY_ROLE_NAME = "Pristavovač";
/** "Dispečer", "Pristavovač" or both, as the account shows it. */
export function accessLabel(role: MobileRole | null, delivery: boolean): string {
  return [role ? roleNames[role] : null, delivery ? DELIVERY_ROLE_NAME : null].filter(Boolean).join(" · ") || "Bez prístupu";
}

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && MODULES.some(item => item.id === value);
}
export function moduleById(id: ModuleId): ShellModule {
  const found = MODULES.find(item => item.id === id);
  if (!found) throw new Error("Unknown module " + id);
  return found;
}
/** Registry order: the modules of a dispatch role and, for a pristavovač,
 * Pristavenia. Unknown roles see nothing. */
export function moduleAccess(role: MobileRole | null, delivery = false): ModuleId[] {
  const allowed = [...(role ? roleModules[role] ?? [] : []), ...(delivery ? ["pristavenia" as const] : [])];
  return everything.filter(id => allowed.includes(id));
}
/** The bar a role starts with; a pristavovač alone starts with Pristavenia. */
export function rolePins(role: MobileRole | null, delivery = false): ModuleId[] {
  const available = moduleAccess(role, delivery);
  const defaults = role ? rolePinDefaults[role] ?? [] : ["pristavenia" as const];
  return defaults.filter(id => available.includes(id)).slice(0, PIN_LIMIT);
}
