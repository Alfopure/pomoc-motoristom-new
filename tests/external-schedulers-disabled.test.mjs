import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflowDirectory = resolve(".github/workflows");

test("GitHub is not an integration scheduler or Vercel runtime dependency", () => {
  const workflowFiles = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();

  // Mobile checks build/test JS bundles with synthetic public config. They
  // do not schedule integrations or become a Vercel runtime dependency.
  assert.deepEqual(workflowFiles, ["ci.yml", "mobile.yml"]);

  const combined = workflowFiles
    .map((name) => readFileSync(resolve(workflowDirectory, name), "utf8"))
    .join("\n");

  assert.doesNotMatch(combined, /^\s*schedule:/m);
  assert.doesNotMatch(combined, /pomoc-motoristom-dispecing\.vercel\.app/);
  assert.doesNotMatch(combined, /api\/integrations\/(?:commander|fleet\/webdispecink|swhouse)/);
  assert.doesNotMatch(combined, /api\/telephony\/(?:recordings\/sync|transcripts\/process)/);
});
