/**
 * Guard against documentation that sends an agent to the wrong application.
 *
 * On 2026-09-21 the owner retired the VIPTel original and moved the production
 * hostname `dispecing.linkapomoci.sk` onto this project. `AGENTS.md` was updated,
 * but the rest of the documentation kept the old story: that this repository is
 * a side copy, that its production lives on `test.dispecing.linkapomoci.sk`, and
 * that `dispecing.linkapomoci.sk` must never be touched. An agent reading any of
 * those files reached the opposite conclusion from the one in `AGENTS.md` and
 * pointed a human tester at the wrong URL.
 *
 * Prose cannot be trusted to stay in sync by itself, so the build gate checks it.
 * The scope is deliberately the *instruction surface* — the files an agent reads
 * to decide where to deploy, point a webhook or send a person. Dated rollout
 * records under `docs/rollout/` and `.omx/` are history: they describe what was
 * true when written and are not rewritten.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Production, verified live on 2026-09-22. */
const PRODUCTION_HOST = "dispecing.linkapomoci.sk";

/** Never existed in DNS. It was a plan that the domain move superseded. */
const NEVER_EXISTED = "test.dispecing.linkapomoci.sk";

/** Dead since the Vercel project was renamed; it answers 404. */
const RETIRED_ALIASES = [
  "pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app",
  "pomoc-motoristom-dispatching.vercel.app",
];

/** The retired VIPTel application. Refusing to touch this one is still correct. */
const VIPTEL_HOST = "dev.dispecing.linkapomoci.sk";

/**
 * Dated records, not instructions. They are allowed to describe the old world.
 * `.context/` is untracked scratch space and never reaches this list.
 */
const HISTORY_PREFIXES = ["docs/rollout/", ".omx/"];

const SELF = "tests/documented-hostnames.test.mjs";

function trackedMarkdown() {
  const out = execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((file) => file !== SELF)
    .filter((file) => !HISTORY_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

function linesOf(file) {
  return readFileSync(path.join(repoRoot, file), "utf8")
    .split("\n")
    .map((text, index) => ({ file, line: index + 1, text }));
}

const instructionLines = trackedMarkdown().flatMap(linesOf);

/** A sentence that tells the reader to stay away from something. */
const NEGATION = /\b(never|must not|forbidden|do not use|nikdy|nesmie|nesmú|zakáz|neexistuje|nepoužívaj)\b/i;

/**
 * Naming a dead hostname in order to warn about it is the opposite of the
 * mistake this file guards against, so those sentences are allowed through.
 */
const OBITUARY = /404|zanik|retired|no longer|Otvorená úloha|Open task|prepíš|repoint|nesprevádzkovala/i;

/**
 * One line is often several claims. Judging a whole line flags a sentence that
 * correctly forbids the VIPTel host merely because the next sentence mentions
 * production — so the checks below look at one sentence at a time.
 */
function sentencesOf({ file, line, text }) {
  return text
    .split(/(?<=[.!?;])\s+/)
    .map((sentence) => ({ file, line, text: sentence }))
    .filter(({ text: sentence }) => sentence.trim().length > 0);
}

const instructionSentences = instructionLines.flatMap(sentencesOf);

describe("documented hostnames", () => {
  it("never points at a hostname that was never provisioned", () => {
    const hits = instructionSentences.filter(
      ({ text }) => text.includes(NEVER_EXISTED) && !OBITUARY.test(text),
    );
    assert.deepEqual(
      hits.map(({ file, line }) => `${file}:${line}`),
      [],
      `${NEVER_EXISTED} does not resolve and never did. Use https://${PRODUCTION_HOST}.`,
    );
  });

  it("never points at a Vercel alias that the project rename killed", () => {
    const hits = instructionSentences.filter(
      ({ text }) => RETIRED_ALIASES.some((alias) => text.includes(alias)) && !OBITUARY.test(text),
    );
    assert.deepEqual(
      hits.map(({ file, line, text }) => `${file}:${line} ${text.trim().slice(0, 80)}`),
      [],
      "These aliases return 404. Prefer the custom domain, which survives a project rename.",
    );
  });

  it("never tells the reader to avoid this project's own production domain", () => {
    const hits = instructionSentences.filter(({ text }) => {
      if (!text.includes(PRODUCTION_HOST)) return false;
      // `dev.dispecing.linkapomoci.sk` and `test.dispecing.linkapomoci.sk` both
      // contain the production host as a substring, and refusing *those* is the
      // correct instruction. Judge what is left once they are removed.
      const bare = text.split(VIPTEL_HOST).join("").split(NEVER_EXISTED).join("");
      if (!bare.includes(PRODUCTION_HOST)) return false;
      return NEGATION.test(bare);
    });
    assert.deepEqual(
      hits.map(({ file, line, text }) => `${file}:${line} ${text.trim().slice(0, 100)}`),
      [],
      `${PRODUCTION_HOST} belongs to this project since 2026-09-21. Only ${VIPTEL_HOST} is off limits.`,
    );
  });

  it("states the production domain in AGENTS.md", () => {
    const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    assert.ok(
      agents.includes(`https://${PRODUCTION_HOST}`),
      "AGENTS.md must name the production domain; it is the first file an agent reads.",
    );
  });
});
