import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = resolve("deploy/bin/compute-build-context-sha256.py");
const dockerignore = `.git
.github
.next
.context
.omx
.vercel
node_modules
dist
coverage
deploy/env
deploy/releases
supabase/.temp
.env
.env.*
*.log
*.tsbuildinfo
`;

function compute(root) {
  const result = spawnSync("python3", [helper, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const digest = result.stdout.trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  return digest;
}

test("build context hash tracks content and executable mode but ignores protected paths", () => {
  const root = mkdtempSync(join(tmpdir(), "motorist-build-context-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".context"));
  writeFileSync(join(root, ".dockerignore"), dockerignore);
  writeFileSync(join(root, "src", "app.js"), "export const value = 1;\n");

  const initial = compute(root);
  writeFileSync(join(root, ".context", "secret.env"), "ignored\n");
  assert.equal(compute(root), initial);

  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const contentChanged = compute(root);
  assert.notEqual(contentChanged, initial);

  chmodSync(join(root, "src", "app.js"), 0o755);
  assert.notEqual(compute(root), contentChanged);
});

test("build context hash refuses an unreviewed dockerignore contract", () => {
  const root = mkdtempSync(join(tmpdir(), "motorist-build-context-contract-"));
  writeFileSync(join(root, ".dockerignore"), `${dockerignore}unexpected\n`);
  const result = spawnSync("python3", [helper, root], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
});
