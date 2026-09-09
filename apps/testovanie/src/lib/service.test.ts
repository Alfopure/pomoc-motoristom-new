import { describe, expect, it, vi, afterEach } from "vitest";
import { catalog, areas } from "./catalog";
import { applyCommand, emptyStore } from "./service";
import { parseCommand } from "./validation";
import {
  metrics,
  csvCell,
  exportCsv,
  type Actor,
  type Command,
  type Store,
} from "./model";
import { decodeActor, encodeActor } from "./session";
import { mutate, WriteConflict, type Repository } from "./repository";

const alice: Actor = {
  id: "alice-session",
  name: "Alice",
  createdAt: new Date().toISOString(),
};
const bob: Actor = {
  id: "bob-session",
  name: "Bob",
  createdAt: new Date().toISOString(),
};
const input = {
  title: "Interné kolo",
  stage: "internal" as const,
  targetUrl: "https://dispecing-test.vercel.app",
  version: "build-123",
  device: "PC Chrome",
  conditions: "Syntetické dáta",
};
const result = {
  status: "accepted" as const,
  note: "Overené",
  severity: "" as const,
  owner: "",
  issueUrl: "",
};
const newStore = () =>
  applyCommand(
    emptyStore(),
    { kind: "createRun", requestId: "create-1", input },
    alice,
  );
const save = (
  store: Store,
  overrides: Partial<Extract<Command, { kind: "saveResult" }>> = {},
): Extract<Command, { kind: "saveResult" }> => ({
  kind: "saveResult",
  requestId: "save-1",
  runId: store.runs[0].id,
  runRevision: store.runs[0].revision,
  scenarioId: "AUTH-01",
  revision: 0,
  input: result,
  ...overrides,
});
afterEach(() => vi.unstubAllEnvs());

describe("catalogue coverage", () => {
  it("has unique scenarios with executable steps in every area and both levels", () => {
    expect(new Set(catalog.map((s) => s.id)).size).toBe(catalog.length);
    expect(catalog.filter((s) => s.level === 1).length).toBeGreaterThanOrEqual(
      30,
    );
    for (const area of areas) {
      expect(catalog.some((s) => s.area === area.id && s.level === 1)).toBe(
        true,
      );
      expect(catalog.some((s) => s.area === area.id && s.level === 2)).toBe(
        true,
      );
    }
    for (const s of catalog) {
      expect(s.steps.length).toBeGreaterThanOrEqual(3);
      expect(s.expected.length).toBeGreaterThan(30);
    }
  });
  it("separates client results and preserves scenario snapshots", () => {
    const first = newStore();
    const second = applyCommand(
      first,
      {
        kind: "createRun",
        requestId: "client-1",
        input: { ...input, stage: "client" },
      },
      alice,
    );
    expect(
      second.runs[0].scenarios.every((s) => s.audience !== "internal"),
    ).toBe(true);
    expect(second.runs[0].results).toEqual({});
    expect(first.runs[0].scenarios).not.toBe(catalog);
  });
});

describe("audit and concurrency", () => {
  it("atomically preserves old and new notes, actor, timestamp and revision", () => {
    const initial = newStore();
    const first = applyCommand(
      initial,
      save(initial),
      alice,
      "2026-09-09T12:00:00Z",
    );
    const second = applyCommand(
      first,
      save(first, {
        requestId: "save-2",
        revision: 1,
        input: {
          ...result,
          status: "rejected",
          note: "Chyba po opakovaní",
          severity: "major",
        },
      }),
      bob,
      "2026-09-09T12:01:00Z",
    );
    expect(initial.runs[0].results).toEqual({});
    expect(second.events.at(-1)).toMatchObject({
      actor: bob,
      before: { note: "Overené", actor: alice },
      after: { note: "Chyba po opakovaní", revision: 2 },
      at: "2026-09-09T12:01:00Z",
    });
  });
  it("rejects a stale edit without erasing either author's record", () => {
    const initial = newStore();
    const first = applyCommand(initial, save(initial), alice);
    expect(() =>
      applyCommand(first, save(initial, { requestId: "save-bob" }), bob),
    ).toThrow("medzitým upravil kolega");
    expect(first.events).toHaveLength(2);
    expect(first.runs[0].results["AUTH-01"].actor).toEqual(alice);
  });
  it("retries an identical request once, rejects changed payload or actor", () => {
    const initial = newStore();
    const cmd = save(initial);
    const first = applyCommand(initial, cmd, alice);
    expect(applyCommand(first, cmd, alice)).toBe(first);
    expect(() => applyCommand(first, cmd, bob)).toThrow("inému vstupu");
    expect(() =>
      applyCommand(
        first,
        { ...cmd, input: { ...result, note: "Iný text" } },
        alice,
      ),
    ).toThrow("iným obsahom");
  });
  it("requires the same run conditions and freezes metadata after any result", () => {
    const initial = newStore();
    const first = applyCommand(initial, save(initial), alice);
    expect(() =>
      applyCommand(
        first,
        {
          kind: "updateRun",
          requestId: "edit-1",
          runId: first.runs[0].id,
          revision: 1,
          input: { ...input, version: "different" },
        },
        alice,
      ),
    ).toThrow("už obsahuje výsledky");
    const modified = applyCommand(
      initial,
      {
        kind: "updateRun",
        requestId: "edit-2",
        runId: initial.runs[0].id,
        revision: 1,
        input: { ...input, version: "different" },
      },
      alice,
    );
    expect(() => applyCommand(modified, save(initial), alice)).toThrow(
      "Podmienky kola",
    );
  });
  it("archives without deleting history and disallows edits to archived runs", () => {
    const initial = newStore();
    const first = applyCommand(initial, save(initial), alice);
    const archived = applyCommand(
      first,
      {
        kind: "archiveRun",
        runId: first.runs[0].id,
        requestId: "archive-1",
        revision: 1,
        archived: true,
      },
      bob,
    );
    expect(archived.runs[0].results).toEqual(first.runs[0].results);
    expect(() =>
      applyCommand(
        archived,
        save(archived, { requestId: "save-2", revision: 1 }),
        bob,
      ),
    ).toThrow("Archivované");
    expect(archived.events).toHaveLength(3);
  });
  it("retries a storage CAS race and retains an unrelated concurrent edit", async () => {
    let current = newStore();
    let conflict = true;
    const repo: Repository = {
      async read() {
        return {
          value: structuredClone(current),
          etag: String(current.revision),
        };
      },
      async write(next, etag) {
        if (conflict) {
          conflict = false;
          current = applyCommand(
            current,
            save(current, { scenarioId: "AUTH-02", requestId: "other-save" }),
            bob,
          );
          throw new WriteConflict();
        }
        if (etag !== String(current.revision)) throw new WriteConflict();
        current = next;
      },
    };
    const cmd = save(current);
    const saved = await mutate(repo, (state) =>
      applyCommand(state, cmd, alice),
    );
    expect(Object.keys(saved.runs[0].results)).toEqual(
      expect.arrayContaining(["AUTH-01", "AUTH-02"]),
    );
    expect(saved.events.filter((e) => e.kind === "result_saved")).toHaveLength(
      2,
    );
  });
  it("does not acknowledge a failed storage write", async () => {
    const repo: Repository = {
      async read() {
        return { value: newStore(), etag: "1" };
      },
      async write() {
        throw new Error("storage offline");
      },
    };
    await expect(
      mutate(repo, (state) => applyCommand(state, save(state), alice)),
    ).rejects.toThrow("storage offline");
  });
});

describe("validation, metrics and attribution", () => {
  it("requires notes and owners for exceptions, and severity for failures", () => {
    const base = save(newStore());
    expect(() =>
      parseCommand({
        ...base,
        input: { ...result, status: "blocked", note: "" },
      }),
    ).toThrow("poznámku");
    expect(() =>
      parseCommand({ ...base, input: { ...result, status: "na" } }),
    ).toThrow("koordinátora");
    expect(() =>
      parseCommand({
        ...base,
        input: {
          ...result,
          status: "reservation",
          owner: "Bob",
          severity: "critical",
        },
      }),
    ).toThrow("drobný");
    expect(() =>
      parseCommand({ ...base, input: { ...result, status: "rejected" } }),
    ).toThrow("závažnosť");
    expect(() =>
      parseCommand({
        ...base,
        input: { ...result, issueUrl: "javascript:alert(1)" },
      }),
    ).toThrow("https");
    expect(() => parseCommand({ ...base, revision: -1 })).toThrow("revízia");
  });
  it("counts blocked tests in the denominator and never calls rejection acceptance", () => {
    const state = newStore();
    const scenarios = state.runs[0].scenarios.slice(0, 4);
    const assessment = {
      ...result,
      actor: alice,
      revision: 1,
      updatedAt: alice.createdAt,
    };
    const m = metrics(scenarios, {
      [scenarios[0].id]: assessment,
      [scenarios[1].id]: { ...assessment, status: "blocked" },
      [scenarios[2].id]: { ...assessment, status: "na" },
      [scenarios[3].id]: {
        ...assessment,
        status: "rejected",
        severity: "critical",
      },
    });
    expect(m).toMatchObject({
      relevant: 3,
      executed: 2,
      serious: 1,
      counts: { accepted: 1, rejected: 1, blocked: 1, na: 1 },
    });
  });
  it("exports Unicode and neutralizes spreadsheet formulas, quotes and newlines", () => {
    expect(csvCell("=1+1")).toBe('"\'=1+1"');
    expect(csvCell("  @SUM(A1)")).toBe('"\'  @SUM(A1)"');
    expect(csvCell('a;"b"\nc')).toBe('"a;""b""\nc"');
    const state = newStore();
    expect(exportCsv(state.runs[0], catalog)).toContain("\ufeff");
    expect(exportCsv(state.runs[0], catalog)).toContain(
      "Prihlásenie správnymi",
    );
  });
  it("rejects modified or expired self-declared identity cookies", () => {
    vi.stubEnv(
      "TRACKER_SESSION_SECRET",
      "local-test-secret-only-32-characters-long",
    );
    const cookie = encodeActor(alice);
    expect(decodeActor(cookie)).toEqual(alice);
    const parts = cookie.split(".");
    expect(
      decodeActor(
        Buffer.from(JSON.stringify(bob)).toString("base64url") + "." + parts[1],
      ),
    ).toBeNull();
    expect(
      decodeActor(encodeActor({ ...alice, createdAt: "2020-01-01T00:00:00Z" })),
    ).toBeNull();
  });
});
