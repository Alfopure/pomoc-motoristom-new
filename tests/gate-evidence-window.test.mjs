import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = resolve("deploy/bin/validate-gate-evidence-window.py");
const captureHelper = resolve("deploy/bin/capture-private-evidence.py");

function timestamp(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function run(started, components) {
  return spawnSync("python3", [helper, started, ...components], { encoding: "utf8" });
}

function runPython(script, args) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8" });
}

test("gate evidence window uses the oldest component as validated_at", () => {
  const now = Date.now();
  const started = timestamp(now - 10_000);
  const oldest = timestamp(now - 8_000);
  const result = run(started, [timestamp(now - 2_000), oldest, timestamp(now - 1_000)]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.validated_at_utc, oldest.replace(/\.\d{3}Z$/, "Z"));
  assert.equal(report.component_count, 3);
  assert.ok(report.maximum_component_age_seconds >= 8);
});

test("gate evidence window rejects a long run and a stale component", () => {
  const now = Date.now();
  assert.notEqual(
    run(timestamp(now - 31 * 60_000), [timestamp(now - 1_000)]).status,
    0,
  );
  assert.notEqual(
    run(timestamp(now - 5_000), [timestamp(now - 31 * 60_000)]).status,
    0,
  );
});

test("gate evidence window rejects reports from before this run or the future", () => {
  const now = Date.now();
  const started = timestamp(now - 5_000);
  assert.notEqual(run(started, [timestamp(now - 6_000)]).status, 0);
  assert.notEqual(run(started, [timestamp(now + 60_000)]).status, 0);
});

test("private evidence capture is immutable and rejects unsafe sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "motorist-gate-evidence-"));
  const source = join(directory, "source.json");
  const destination = join(directory, "captured.json");
  writeFileSync(source, '{"status":"pass"}\n', { mode: 0o600 });

  assert.equal(runPython(captureHelper, [source, destination]).status, 0);
  assert.equal(readFileSync(destination, "utf8"), readFileSync(source, "utf8"));
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  const captured = readFileSync(destination, "utf8");
  assert.notEqual(runPython(captureHelper, [source, destination]).status, 0);
  assert.equal(readFileSync(destination, "utf8"), captured);

  const publicSource = join(directory, "public.json");
  writeFileSync(publicSource, "{}\n", { mode: 0o644 });
  assert.notEqual(runPython(captureHelper, [publicSource, join(directory, "public-copy.json")]).status, 0);
  assert.equal(
    runPython(captureHelper, [publicSource, join(directory, "public-release-copy.json"), "--allow-public-source"]).status,
    0,
  );

  const hardLink = join(directory, "source-hardlink.json");
  linkSync(source, hardLink);
  assert.notEqual(runPython(captureHelper, [source, join(directory, "hardlink-copy.json")]).status, 0);

  const symlink = join(directory, "source-symlink.json");
  symlinkSync(publicSource, symlink);
  assert.notEqual(runPython(captureHelper, [symlink, join(directory, "symlink-copy.json")]).status, 0);
  chmodSync(publicSource, 0o600);
});

test("gate freshness window starts from completed immutable Storage evidence", () => {
  const gate = readFileSync(resolve("deploy/supabase/validate-cutover-gate.zsh"), "utf8");
  const storageRun = gate.indexOf('"${STORAGE_VALIDATOR}" "${snapshot_id}"');
  const storageCapture = gate.indexOf('"${generated_storage_report}" "${storage_report}"');
  const gateStart = gate.indexOf('gate_started_at_utc="$(jq -er \'.validated_at_utc\' "${storage_report}")"');
  const databaseRun = gate.indexOf('"${TARGET_VALIDATOR}" "${snapshot_id}"');

  assert.ok(storageRun >= 0);
  assert.ok(storageCapture > storageRun);
  assert.ok(gateStart > storageCapture);
  assert.ok(databaseRun > gateStart);
});
