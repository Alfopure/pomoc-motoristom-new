import { PIN_LIMIT, isModuleId, type ModuleId } from "./modules";

/** Stored pins come from an older release or another role: keep only known,
 * currently available, unique modules. Anything unreadable uses the role default. */
export function normalizePins(value: unknown, available: readonly ModuleId[], fallback: readonly ModuleId[]): ModuleId[] {
  const allowed = (list: readonly unknown[]) => list.filter((id, index): id is ModuleId => isModuleId(id) && available.includes(id) && list.indexOf(id) === index).slice(0, PIN_LIMIT);
  return Array.isArray(value) ? allowed(value) : allowed(fallback);
}
export const pinsFull = (pins: readonly ModuleId[]) => pins.length >= PIN_LIMIT;
export function withPin(pins: readonly ModuleId[], id: ModuleId): ModuleId[] {
  return pins.includes(id) || pinsFull(pins) ? [...pins] : [...pins, id];
}
export function withoutPin(pins: readonly ModuleId[], id: ModuleId): ModuleId[] {
  return pins.filter(value => value !== id);
}
/** The replacement takes the replaced module's position in the bar. */
export function replacingPin(pins: readonly ModuleId[], replaced: ModuleId, next: ModuleId): ModuleId[] {
  if (!pins.includes(replaced) || pins.includes(next)) return [...pins];
  return pins.map(value => value === replaced ? next : value);
}
export function movingPin(pins: readonly ModuleId[], from: number, to: number): ModuleId[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= pins.length) return [...pins];
  const target = Math.max(0, Math.min(pins.length - 1, to));
  const next = [...pins];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}
export const samePins = (a: readonly ModuleId[], b: readonly ModuleId[]) => a.length === b.length && a.every((id, index) => b[index] === id);
