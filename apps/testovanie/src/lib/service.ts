import { createHash, randomUUID } from "node:crypto";
import { catalog, catalogVersion } from "./catalog";
import type { Actor, AuditEvent, Command, Store } from "./model";
import { InputError } from "./validation";

export function emptyStore(): Store {
  return { schema: 1, revision: 0, runs: [], events: [] };
}

export function applyCommand(
  current: Store,
  command: Command,
  actor: Actor,
  now = new Date().toISOString(),
): Store {
  const commandHash = createHash("sha256")
    .update(JSON.stringify(command))
    .digest("hex");
  const previous = current.events.find(
    (e) => e.requestId === command.requestId,
  );
  if (previous) {
    if (previous.actor.id !== actor.id)
      throw new InputError("Táto požiadavka už patrí inému vstupu.", 409);
    if (previous.commandHash !== commandHash)
      throw new InputError(
        "Identifikátor požiadavky už bol použitý s iným obsahom.",
        409,
      );
    return current; // Safe replay after a lost response; the original audit remains intact.
  }
  const next = structuredClone(current);
  const event: AuditEvent = {
    id: randomUUID(),
    requestId: command.requestId,
    commandHash,
    actor,
    at: now,
    kind: "entry",
    before: null,
    after: null,
  };
  if (command.kind === "entry") event.after = { name: actor.name };
  else if (command.kind === "createRun") {
    const run = {
      ...command.input,
      id: randomUUID(),
      catalogVersion,
      scenarios: structuredClone(
        catalog.filter(
          (s) =>
            command.input.stage === "internal" || s.audience !== "internal",
        ),
      ),
      results: {},
      createdAt: now,
      createdBy: actor,
      archived: false,
      revision: 1,
    };
    next.runs.unshift(run);
    event.kind = "run_created";
    event.runId = run.id;
    event.after = {
      ...command.input,
      catalogVersion,
      scenarioCount: run.scenarios.length,
    };
  } else {
    const run = next.runs.find((r) => r.id === command.runId);
    if (!run) throw new InputError("Testovacie kolo sa nenašlo.", 404);
    event.runId = run.id;
    if (command.kind === "saveResult") {
      if (run.archived)
        throw new InputError(
          "Archivované kolo už neprijíma výsledky. Najprv ho obnovte.",
          409,
        );
      if (run.revision !== command.runRevision)
        throw new InputError(
          "Podmienky kola sa medzitým zmenili. Skontrolujte ich a otvorte test znova.",
          409,
        );
      if (!run.scenarios.some((s) => s.id === command.scenarioId))
        throw new InputError("Test nepatrí do tohto kola.", 404);
      const before = run.results[command.scenarioId];
      if ((before?.revision ?? 0) !== command.revision)
        throw new InputError(
          "Tento test medzitým upravil kolega. Váš text zostal zachovaný. Načítajte jeho zmenu a porovnajte ju pred uložením.",
          409,
        );
      const after = {
        ...command.input,
        revision: command.revision + 1,
        actor,
        updatedAt: now,
      };
      run.results[command.scenarioId] = after;
      event.kind = "result_saved";
      event.scenarioId = command.scenarioId;
      event.before = before ?? null;
      event.after = after;
    } else {
      if (run.revision !== command.revision)
        throw new InputError(
          "Kolo medzitým upravil kolega. Obnovte prehľad a skúste to znova.",
          409,
        );
      if (command.kind === "updateRun") {
        if (run.archived)
          throw new InputError("Archivované kolo najprv obnovte.", 409);
        if (Object.keys(run.results).length)
          throw new InputError(
            "Kolo už obsahuje výsledky. Pre inú verziu, zariadenie alebo podmienky vytvorte nové kolo.",
            409,
          );
        event.before = {
          title: run.title,
          stage: run.stage,
          targetUrl: run.targetUrl,
          version: run.version,
          device: run.device,
          conditions: run.conditions,
        };
        Object.assign(run, command.input);
        run.scenarios = structuredClone(
          catalog.filter(
            (s) => run.stage === "internal" || s.audience !== "internal",
          ),
        );
        run.catalogVersion = catalogVersion;
        event.kind = "run_updated";
        event.after = command.input;
      } else {
        event.before = { archived: run.archived };
        run.archived = command.archived;
        event.kind = command.archived ? "run_archived" : "run_restored";
        event.after = { archived: run.archived };
      }
      run.revision++;
    }
  }
  next.revision++;
  next.events.push(event);
  return next;
}
