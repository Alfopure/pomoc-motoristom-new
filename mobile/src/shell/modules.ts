import type { MobileFieldMe, MobileRole } from "../../../src/lib/mobile-api";

/** Modules available in this native release. A new feature adds its manifest
 * here; the bar, Moduly and Prehľad assemble themselves from this list. */
export type ModuleId = "hovory" | "pripady" | "ulohy" | "nastroje" | "pristavenia" | "praca" | "pobocka";
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
  { id: "praca", name: "Moja práca", short: "Práca", group: "zasahy", color: "#FF9500", ink: "#FFFFFF", description: "Pridelené jazdy, odvozy, presuny a odťahy: kroky, doklady a fotky" },
  { id: "pobocka", name: "Pobočka", short: "Pobočka", group: "kancelaria", color: "#5856D6", ink: "#FFFFFF", description: "Požiadavky pobočky: prevziať, prideliť a sledovať prácu" },
];
export const GROUPS: readonly { id: ModuleGroup; name: string }[] = [
  { id: "komunikacia", name: "Komunikácia" }, { id: "zasahy", name: "Zásahy" },
  { id: "kancelaria", name: "Kancelária" }, { id: "nastroje", name: "Nástroje" },
];
/** Prehľad, three own modules and Moduly fit the five-item system bar. */
export const PIN_LIMIT = 3;

/** Field modules of a member: Pristavenia (legacy handoffs) and Moja práca with
 * `deliver`, Moja práca with `drive`, Pobočka with a lead seat. Presentation only. */
export type FieldModules = { delivery: boolean; work: boolean; branch: boolean };
export const NO_FIELD: FieldModules = { delivery: false, work: false, branch: false };
/** An older server sends no capabilities: then the member is a pristavovač as before. */
export function fieldModules(me: Pick<MobileFieldMe, "capabilities" | "branches"> | null | undefined): FieldModules {
  if (!me) return NO_FIELD;
  if (!Array.isArray(me.capabilities)) return { delivery: true, work: false, branch: false };
  const delivers = me.capabilities.includes("deliver");
  return { delivery: delivers, work: delivers || me.capabilities.includes("drive"), branch: Array.isArray(me.branches) && me.branches.length > 0 };
}
const asField = (field: boolean | FieldModules | undefined): FieldModules => field === true ? { delivery: true, work: false, branch: false } : field ? field : NO_FIELD;
export const hasField = (field: boolean | FieldModules | undefined) => { const value = asField(field); return value.delivery || value.work || value.branch; };

const everything: readonly ModuleId[] = MODULES.map(item => item.id);
/** Dispečing: its modules come with a dispatch role; the field modules with a
 * field membership. One person may have both and sees both in the one app. */
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
/** How the account names the field roles: "Pristavovač", "Vodič", "Miestny dispečer". */
export function fieldRoleLabel(field: boolean | FieldModules, capabilities?: readonly string[]): string {
  const value = asField(field);
  const names = [value.delivery ? DELIVERY_ROLE_NAME : null, value.work && capabilities?.includes("drive") ? "Vodič" : null, value.branch ? "Miestny dispečer" : null].filter(Boolean);
  return names.join(" · ") || (value.work ? "Vykonávateľ" : "");
}
/** "Dispečer", "Pristavovač" or both, as the account shows it. */
export function accessLabel(role: MobileRole | null, field: boolean | FieldModules, capabilities?: readonly string[]): string {
  return [role ? roleNames[role] : null, fieldRoleLabel(field, capabilities) || null].filter(Boolean).join(" · ") || "Bez prístupu";
}

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && MODULES.some(item => item.id === value);
}
export function moduleById(id: ModuleId): ShellModule {
  const found = MODULES.find(item => item.id === id);
  if (!found) throw new Error("Unknown module " + id);
  return found;
}
/** Registry order: the modules of a dispatch role and the member's field modules.
 * Unknown roles see nothing. `true` means a pristavovač of an older server. */
export function moduleAccess(role: MobileRole | null, field: boolean | FieldModules = false): ModuleId[] {
  const value = asField(field);
  const allowed = [...(role ? roleModules[role] ?? [] : []), ...(value.delivery ? ["pristavenia" as const] : []),
    ...(value.work ? ["praca" as const] : []), ...(value.branch ? ["pobocka" as const] : [])];
  return everything.filter(id => allowed.includes(id));
}
/** The bar a role starts with; a field member alone starts with their work modules. */
export function rolePins(role: MobileRole | null, field: boolean | FieldModules = false): ModuleId[] {
  const available = moduleAccess(role, field);
  const defaults = role ? rolePinDefaults[role] ?? [] : ["praca" as const, "pristavenia" as const, "pobocka" as const];
  return defaults.filter(id => available.includes(id)).slice(0, PIN_LIMIT);
}
