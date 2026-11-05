export type CaseSortKey =
  | "caseNumber" | "status" | "priority" | "createdAt" | "updatedAt"
  | "callStartedAt" | "answeredAt" | "caller" | "owner" | "caseType"
  | "vehicle" | "pickup" | "destination" | "branch" | "asset"
  | "nextStep" | "openTasks" | "latestActivityAt";

export type CaseSortState = { key: CaseSortKey; direction: "asc" | "desc" };

export const caseTableColumns: ReadonlyArray<{ key: CaseSortKey; label: string; width: number }> = [
  { key: "caseNumber", label: "Prípad", width: 164 },
  { key: "status", label: "Stav", width: 132 },
  { key: "priority", label: "Priorita", width: 86 },
  { key: "caller", label: "Volajúci / klient", width: 180 },
  { key: "vehicle", label: "Vozidlo", width: 164 },
  { key: "owner", label: "Operátor", width: 132 },
  { key: "updatedAt", label: "Upravené", width: 138 },
  { key: "createdAt", label: "Založené", width: 138 },
  { key: "caseType", label: "Typ / zdroj", width: 180 },
  { key: "pickup", label: "Miesto zásahu", width: 220 },
  { key: "destination", label: "Cieľ", width: 220 },
  { key: "branch", label: "Pobočka", width: 154 },
  { key: "asset", label: "Technika", width: 154 },
  { key: "nextStep", label: "Ďalší krok", width: 220 },
  { key: "openTasks", label: "Úlohy", width: 180 },
  { key: "latestActivityAt", label: "Posledná poznámka", width: 220 },
  { key: "callStartedAt", label: "Hovor", width: 138 },
  { key: "answeredAt", label: "Prijaté / ukončené", width: 156 },
];
export const defaultCaseTableColumns: CaseSortKey[] = ["caseNumber", "status", "priority", "caller", "vehicle", "owner", "updatedAt"];

/** Existing saved arrays retain their order; identity stays visible and first. */
export function parseCaseTableColumns(raw: string | null): CaseSortKey[] {
  if (!raw) return [...defaultCaseTableColumns];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...defaultCaseTableColumns];
    const columns = [...new Set(parsed.filter((key): key is CaseSortKey =>
      typeof key === "string" && caseTableColumns.some(column => column.key === key)))];
    return columns.length ? ["caseNumber", ...columns.filter(key => key !== "caseNumber")] : [...defaultCaseTableColumns];
  } catch {
    return [...defaultCaseTableColumns];
  }
}

export function moveCaseTableColumn(columns: CaseSortKey[], key: CaseSortKey, offset: -1 | 1): CaseSortKey[] {
  const index = columns.indexOf(key), target = index + offset;
  if (key === "caseNumber" || index < 1 || target < 1 || target >= columns.length) return columns;
  const next = [...columns];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
