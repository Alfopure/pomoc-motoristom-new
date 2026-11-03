/** A receipt is recorded against the original record, even after its screen closes. */
export type DraftWrite = { finish(payload: object): Promise<boolean> };

export type DraftPort = {
  load(): unknown | null;
  changed(payload: object): void;
  prepare(payload: object | (() => object)): Promise<DraftWrite>;
  current(): boolean;
  settled(): boolean;
  reject(): void;
  acceptsScope(value: unknown): boolean;
};

/** Local preparation failed before transport; it is not an unknown server result. */
export class DraftNotSentError extends Error {
  constructor(message = "Koncept sa nepodarilo uložiť v zariadení. Požiadavka sa neodoslala. Skúste miestne uloženie znova.") {
    super(message);
  }
}

export function draftObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid draft");
  return value as Record<string, unknown>;
}

export function draftKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("Invalid draft fields");
}

export const draftId = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
export const draftText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !value.includes("\0");
export function draftDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (zone === "Z" || Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60);
}
