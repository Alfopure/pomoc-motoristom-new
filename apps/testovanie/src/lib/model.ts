export const statuses = [
  "untested",
  "accepted",
  "reservation",
  "rejected",
  "blocked",
  "na",
] as const;
export type Status = (typeof statuses)[number];
export const statusLabels: Record<Status, string> = {
  untested: "Neotestované",
  accepted: "Akceptované",
  reservation: "S výhradou",
  rejected: "Neakceptované",
  blocked: "Blokované",
  na: "Nevzťahuje sa",
};
export const statusHelp: Record<Status, string> = {
  untested: "Skúška ešte nebola vykonaná.",
  accepted: "Očakávaný výsledok bol overený a splnený.",
  reservation:
    "Cieľ je splnený, zostal iba drobný nedostatok. Uveďte ho aj s riešiteľom.",
  rejected: "Očakávaný výsledok sa nesplnil. Popíšte skutočné správanie.",
  blocked: "Skúšku sa nepodarilo vykonať. Napíšte, čo jej bráni.",
  na: "Test nepatrí do rozsahu kola. Uveďte dôvod a meno koordinátora, ktorý to potvrdil.",
};
export type Severity = "" | "minor" | "major" | "critical";
export const severityLabels: Record<Severity, string> = {
  "": "Bez závažnosti",
  minor: "Drobná",
  major: "Závažná",
  critical: "Kritická",
};
export type Area = {
  id: string;
  name: string;
  short: string;
  description: string;
};
export type Scenario = {
  id: string;
  area: string;
  level: 1 | 2;
  title: string;
  role: string;
  setup: string;
  steps: string[];
  expected: string;
  cleanup: string;
  audience: "everyone" | "internal";
  source: string;
};
export type Actor = { id: string; name: string; createdAt: string };
export type Assessment = {
  status: Status;
  note: string;
  severity: Severity;
  owner: string;
  issueUrl: string;
  revision: number;
  actor: Actor;
  updatedAt: string;
};
export type Run = {
  id: string;
  title: string;
  stage: "internal" | "client";
  targetUrl: string;
  version: string;
  device: string;
  conditions: string;
  catalogVersion: string;
  scenarios: Scenario[];
  results: Record<string, Assessment>;
  createdAt: string;
  createdBy: Actor;
  archived: boolean;
  revision: number;
};
export type AuditEvent = {
  id: string;
  requestId: string;
  commandHash: string;
  at: string;
  actor: Actor;
  kind:
    | "entry"
    | "run_created"
    | "run_updated"
    | "result_saved"
    | "run_archived"
    | "run_restored";
  runId?: string;
  scenarioId?: string;
  before: unknown;
  after: unknown;
};
export type Store = {
  schema: 1;
  revision: number;
  runs: Run[];
  events: AuditEvent[];
};
export type RunInput = Pick<
  Run,
  "title" | "stage" | "targetUrl" | "version" | "device" | "conditions"
>;
export type ResultInput = Pick<
  Assessment,
  "status" | "note" | "severity" | "owner" | "issueUrl"
>;
export type Command =
  | { kind: "entry"; requestId: string }
  | { kind: "createRun"; requestId: string; input: RunInput }
  | {
      kind: "updateRun";
      requestId: string;
      runId: string;
      revision: number;
      input: RunInput;
    }
  | {
      kind: "archiveRun";
      requestId: string;
      runId: string;
      revision: number;
      archived: boolean;
    }
  | {
      kind: "saveResult";
      requestId: string;
      runId: string;
      runRevision: number;
      scenarioId: string;
      revision: number;
      input: ResultInput;
    };

export function metrics(
  scenarios: Scenario[],
  results: Record<string, Assessment>,
) {
  const counts = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<
    Status,
    number
  >;
  let serious = 0;
  for (const s of scenarios) {
    const r = results[s.id];
    counts[r?.status ?? "untested"]++;
    if (
      r?.status === "rejected" &&
      (r.severity === "major" || r.severity === "critical")
    )
      serious++;
  }
  const relevant = scenarios.length - counts.na;
  const executed = counts.accepted + counts.reservation + counts.rejected;
  return {
    counts,
    relevant,
    executed,
    serious,
    percent: relevant ? Math.round((executed / relevant) * 100) : 0,
  };
}

// Spreadsheet formulas must stay inert when names/notes are opened in Excel.
export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function exportCsv(run: Run, scenarios: Scenario[]) {
  const rows: unknown[][] = [
    [
      "Kolo",
      "Etapa",
      "Verzia aplikácie",
      "URL",
      "Zariadenie",
      "Katalóg",
      "ID",
      "Oblasť",
      "Úroveň",
      "Test",
      "Predpoklady",
      "Kroky",
      "Očakávaný výsledok",
      "Výsledok",
      "Závažnosť",
      "Poznámka",
      "Riešiteľ / schválil",
      "Odkaz na chybu",
      "Tester",
      "Čas UTC",
      "Revízia",
    ],
  ];
  for (const s of scenarios) {
    const r = run.results[s.id];
    rows.push([
      run.title,
      run.stage,
      run.version,
      run.targetUrl,
      run.device,
      run.catalogVersion,
      s.id,
      s.area,
      s.level,
      s.title,
      s.setup,
      s.steps.map((x, i) => `${i + 1}. ${x}`).join("\n"),
      s.expected,
      statusLabels[r?.status ?? "untested"],
      severityLabels[r?.severity ?? ""],
      r?.note,
      r?.owner,
      r?.issueUrl,
      r?.actor.name,
      r?.updatedAt,
      r?.revision,
    ]);
  }
  return "\ufeff" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
