import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Cold-start guard for the webhook route (design §Phase 5, "latency: the
 * webhook import graph").
 *
 * Every inbound call starts with a Telnyx webhook, and Telnyx gives the app
 * `first_command_timeout_secs` to answer. On a cold Vercel function the module
 * graph is loaded before the handler runs, so an innocent-looking import in a
 * shared helper is paid for by the caller listening to silence. This test walks
 * the static imports and fails when the hot path grows a dependency on the
 * heavy parts of the app.
 *
 * `await import(...)` is deliberately not followed: the caller-matching seam in
 * `runtime.ts` is lazy precisely so that the dispatch repository stays off this
 * path, and a lazy import costs nothing until an inbound call needs it.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const ENTRY = "src/app/api/telephony/telnyx/webhook/route.ts";

/** Static, non-type imports only — `import type` is erased before it can cost anything. */
const IMPORT_RE = /^\s*import\s+(?!type\b)(?:[^'"]*?from\s+)?["']([^"']+)["']/gm;

function resolveModule(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(importer), specifier);
  else return null; // node_modules and bare builtins are not ours to police
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [path.join(ROOT, entry)];
  seen.add(queue[0]);
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const target = resolveModule(match[1], file);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen].map((file) => path.relative(ROOT, file)).sort();
}

/**
 * Modules that must never be on the hot path, with the reason, so a future
 * failure is a decision rather than a puzzle.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^src\/server\/motorist-mutations\.ts$/, why: "4 000 lines of case/task/attendance mutations; import MutationError from @/server/mutation-error instead" },
  { pattern: /^src\/server\/integrations\//, why: "external integration clients (SW House, Commander) have nothing to do with answering a call" },
  { pattern: /^src\/server\/telephony-workflow\.ts$/, why: "pulls the dispatch repository; runtime.ts loads it lazily for caller matching" },
  { pattern: /^src\/data\/dispatch-repository\.ts$/, why: "the whole dispatch read model" },
  { pattern: /^src\/server\/email-delivery\.ts$/, why: "e-mail transport; alerts run on the cron, not on the webhook" },
  { pattern: /^src\/components\//, why: "React components are never needed by a webhook" },
];

/**
 * Ceiling with room to grow, not a target. Raising it is fine — noticing that
 * it moved is the point.
 */
const MAX_MODULES = 45;

describe("telnyx webhook cold path", () => {
  const graph = importGraph(ENTRY);

  it("does not reach the heavy parts of the application", () => {
    const offenders = FORBIDDEN.flatMap(({ pattern, why }) => graph.filter((module) => pattern.test(module)).map((module) => `${module} — ${why}`));
    expect(offenders).toEqual([]);
  });

  it("stays small enough to load inside the first-command timeout", () => {
    expect(graph.length, `webhook import graph:\n${graph.join("\n")}`).toBeLessThanOrEqual(MAX_MODULES);
  });

  it("walks a real graph (guards the test itself against a resolver regression)", () => {
    // If the resolver silently stopped following imports, the checks above
    // would pass on an empty graph.
    expect(graph).toContain("src/server/telephony/telnyx/event-processor.ts");
    expect(graph).toContain("src/server/telephony/state/transitions.ts");
    expect(graph.length).toBeGreaterThan(20);
  });
});
