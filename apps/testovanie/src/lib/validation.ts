import {
  statuses,
  type Command,
  type ResultInput,
  type RunInput,
} from "./model";

export class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputError("Neplatná požiadavka.");
  return value as Record<string, unknown>;
}
export function text(
  value: unknown,
  label: string,
  max: number,
  min = 0,
): string {
  if (typeof value !== "string")
    throw new InputError(`${label}: očakáva sa text.`);
  const result = value.trim();
  if (
    result.length < min ||
    result.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)
  )
    throw new InputError(
      `${label}: zadajte ${min ? `aspoň ${min} a najviac` : "najviac"} ${max} znakov.`,
    );
  return result;
}
export function identifier(value: unknown): string {
  const id = text(value, "Identifikátor", 80, 1);
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new InputError("Neplatný identifikátor.");
  return id;
}
export function url(value: unknown, label: string, optional = false): string {
  const str = text(value, label, 1500, optional ? 0 : 1);
  if (!str && optional) return "";
  try {
    const parsed = new URL(str);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new Error();
    return parsed.toString();
  } catch {
    throw new InputError(`${label}: použite platnú https:// adresu.`);
  }
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new InputError("Chýba platná revízia záznamu.");
  return value as number;
}
function runInput(value: unknown): RunInput {
  const input = record(value);
  if (input.stage !== "internal" && input.stage !== "client")
    throw new InputError("Vyberte interné alebo klientské kolo.");
  return {
    title: text(input.title, "Názov kola", 100, 3),
    stage: input.stage,
    targetUrl: url(input.targetUrl, "Testovaná aplikácia"),
    version: text(input.version, "Verzia aplikácie", 120, 2),
    device: text(input.device, "Testované zariadenie", 120, 2),
    conditions: text(input.conditions, "Podmienky kola", 3000),
  };
}
function resultInput(value: unknown): ResultInput {
  const input = record(value);
  if (!statuses.includes(input.status as ResultInput["status"]))
    throw new InputError("Vyberte výsledok testu.");
  if (!["", "minor", "major", "critical"].includes(input.severity as string))
    throw new InputError("Neplatná závažnosť.");
  const result: ResultInput = {
    status: input.status as ResultInput["status"],
    note: text(input.note, "Poznámka", 5000),
    severity: input.severity as ResultInput["severity"],
    owner: text(input.owner, "Riešiteľ / schválil", 100),
    issueUrl: url(input.issueUrl, "Odkaz na chybu", true),
  };
  if (
    ["reservation", "rejected", "blocked", "na"].includes(result.status) &&
    result.note.length < 3
  )
    throw new InputError("Pri tomto výsledku doplňte poznámku alebo dôvod.");
  if (
    (result.status === "reservation" || result.status === "na") &&
    result.owner.length < 2
  )
    throw new InputError(
      result.status === "na"
        ? "Uveďte meno koordinátora, ktorý potvrdil vyradenie z rozsahu."
        : "Uveďte, kto dorieši výhradu.",
    );
  if (result.status === "reservation" && result.severity !== "minor")
    throw new InputError(
      "S výhradou možno prijať iba drobný nedostatok pri splnenom cieli.",
    );
  if (result.status === "rejected" && !result.severity)
    throw new InputError("Pri chybe vyberte závažnosť.");
  if (!["rejected", "reservation"].includes(result.status))
    result.severity = "";
  return result;
}
export function parseCommand(value: unknown): Command {
  const input = record(value);
  const requestId = identifier(input.requestId);
  if (input.kind === "entry") return { kind: "entry", requestId };
  if (input.kind === "createRun")
    return { kind: "createRun", requestId, input: runInput(input.input) };
  const runId = identifier(input.runId);
  if (input.kind === "saveResult")
    return {
      kind: "saveResult",
      requestId,
      runId,
      runRevision: revision(input.runRevision),
      scenarioId: identifier(input.scenarioId),
      revision: revision(input.revision),
      input: resultInput(input.input),
    };
  if (input.kind === "updateRun")
    return {
      kind: "updateRun",
      requestId,
      runId,
      revision: revision(input.revision),
      input: runInput(input.input),
    };
  if (input.kind === "archiveRun" && typeof input.archived === "boolean")
    return {
      kind: "archiveRun",
      requestId,
      runId,
      revision: revision(input.revision),
      archived: input.archived,
    };
  throw new InputError("Nepodporovaná akcia.");
}
