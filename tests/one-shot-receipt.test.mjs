import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const writer = resolve("deploy/bin/write-one-shot-receipt.py");

function writeResult(directory, value) {
  const path = join(directory, "result.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function runWriter(receipt, result, job = "fleet.commander.catalog") {
  return spawnSync(
    "python3",
    [
      writer,
      receipt,
      result,
      "hetzner-20260716T235959Z",
      `sha256:${"a".repeat(64)}`,
      job,
      "b".repeat(64),
    ],
    { encoding: "utf8" },
  );
}

test("one-shot receipt stores only the validated aggregate result", () => {
  const directory = mkdtempSync(join(tmpdir(), "motorist-one-shot-"));
  const result = writeResult(directory, {
    schema: "motorist-one-shot/v1",
    ok: true,
    job: "fleet.commander.catalog",
    status: "success",
    summary: { createdCount: 0, errorCount: 0, fetchedCount: 4, status: "success" },
  });
  const receipt = join(directory, "receipt.json");

  assert.equal(runWriter(receipt, result).status, 0);
  assert.equal(statSync(receipt).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(receipt, "utf8"));
  assert.equal(stored.schema, "motorist-one-shot/v1");
  assert.equal(stored.ok, true);
  assert.equal(stored.targetProjectRef, "sjcsrygkkmersoczpunh");
  assert.equal(stored.runtimeEnvSha256, "b".repeat(64));
  assert.deepEqual(stored.summary, {
    createdCount: 0,
    errorCount: 0,
    fetchedCount: 4,
    status: "success",
  });
  assert.notEqual(runWriter(receipt, result).status, 0);
});

test("one-shot receipt rejects PII, URLs, project refs, and SWHouse", () => {
  const unsafeSummaries = [
    { email: "person@example.test" },
    { phone: "+421 900 123 456" },
    { url: "https://example.test/path" },
    { ref: "jcwbiulwuwyrnmzjjbgr" },
  ];

  for (const [index, summary] of unsafeSummaries.entries()) {
    const directory = mkdtempSync(join(tmpdir(), `motorist-one-shot-unsafe-${index}-`));
    const result = writeResult(directory, {
      schema: "motorist-one-shot/v1",
      ok: true,
      job: "fleet.commander.catalog",
      status: "success",
      summary,
    });
    assert.notEqual(runWriter(join(directory, "receipt.json"), result).status, 0);
  }

  const directory = mkdtempSync(join(tmpdir(), "motorist-one-shot-swhouse-"));
  const result = writeResult(directory, {
    schema: "motorist-one-shot/v1",
    ok: true,
    job: "fleet.swhouse.roster",
    status: "success",
    summary: {},
  });
  assert.notEqual(
    runWriter(join(directory, "receipt.json"), result, "fleet.swhouse.roster").status,
    0,
  );
});

test("one-shot wrapper keeps scheduler off and container locked down", () => {
  const wrapper = readFileSync(resolve("deploy/bin/run-one-shot-job.sh"), "utf8");
  assert.match(wrapper, /SCHEDULER_ENABLED.*false/);
  assert.match(wrapper, /--read-only/);
  assert.match(wrapper, /--cap-drop ALL/);
  assert.match(wrapper, /--cap-add DAC_OVERRIDE/);
  assert.doesNotMatch(wrapper, /DAC_READ_SEARCH/);
  assert.match(wrapper, /--cap-add SETGID/);
  assert.match(wrapper, /--cap-add SETUID/);
  assert.match(wrapper, /--security-opt no-new-privileges:true/);
  assert.match(wrapper, /timeout --signal=TERM --kill-after=15s 10m/);
  assert.equal((wrapper.match(/fleet\.swhouse/g) ?? []).length, 2);
  assert.doesNotMatch(
    wrapper.match(/case "\$job" in(?<allowlist>[\s\S]*?)esac/)?.groups?.allowlist ?? "",
    /fleet\.swhouse/,
  );
  assert.match(wrapper, />"\$result_file" 2>\/dev\/null/);
  assert.match(wrapper, /receipt directory must not traverse symlinks/);
  assert.match(wrapper, /script_dir.*release_dir\/bin/);
  assert.match(wrapper, /sha256sum -c SHA256SUMS/);
  assert.match(wrapper, /"\$expected_image_id" "\$\{command\[@\]\}"/);
  assert.doesNotMatch(wrapper, /"\$image" "\$\{command\[@\]\}"/);
  assert.match(wrapper, /hashlib\.sha256\(env_bytes\)\.hexdigest\(\)/);
  assert.match(wrapper, /capture-private-evidence\.py/);
  assert.match(wrapper, /source=\$\{runtime_snapshot\},target=\/run\/secrets\/runtime_env/);
  assert.doesNotMatch(wrapper, /source=\$\{runtime_dir\}\/worker\.env,target=\/run\/secrets\/runtime_env/);
});

test("one-shot wrapper requires an aggregate-only quiescent target before and after writes", () => {
  const wrapper = readFileSync(resolve("deploy/bin/run-one-shot-job.sh"), "utf8");

  const embeddedPython = [...wrapper.matchAll(/<<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)].map(
    (match) => match[1],
  );
  assert.ok(embeddedPython.length > 0);
  for (const source of embeddedPython) {
    const compiled = spawnSync(
      "python3",
      ["-c", "import sys; compile(sys.stdin.read(), '<embedded-python>', 'exec')"],
      { input: source, encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
  }

  assert.match(wrapper, /method="HEAD"/);
  assert.match(wrapper, /"Prefer": "count=exact"/);
  assert.match(wrapper, /"Range": "0-0"/);
  assert.match(wrapper, /require\(not response\.read\(1\), "target aggregate query returned a body"\)/);
  assert.match(wrapper, /"motorist_job_controls",\s*\(\),\s*len\(EXPECTED_JOBS\)/s);
  assert.match(wrapper, /\(\("job_name", expected_jobs_filter\),\)/);
  assert.match(wrapper, /\(\("enabled", "eq\.true"\),\)/);
  assert.match(wrapper, /\(\("heartbeat_at", f"gte\.\{fresh_after\}"\),\)/);
  assert.match(wrapper, /\("scheduler_tick_at", "not\.is\.null"/);
  assert.match(wrapper, /\("viptel_ws_status", "neq\.disabled"/);
  assert.match(wrapper, /\(\("instance_id", f"not\.\{expected_identities_filter\}"\),\)/);
  assert.match(wrapper, /ThreadPoolExecutor\(max_workers=len\(checks\)\)/);
  assert.equal((wrapper.match(/if ! target_is_quiescent; then/g) ?? []).length, 2);
  const armedAt = wrapper.indexOf("receipt_armed=true");
  const imageCheckAt = wrapper.indexOf("actual_image_id=$(docker image inspect", armedAt);
  const firstTargetCheckAt = wrapper.indexOf("if ! target_is_quiescent; then", imageCheckAt);
  assert.ok(armedAt > 0 && imageCheckAt > armedAt && firstTargetCheckAt > imageCheckAt);
  assert.match(wrapper, /write_failed_receipt >\/dev\/null 2>&1 \|\| true/);
  assert.match(wrapper, /"ok": False/);
  assert.match(wrapper, /"status": "failed"/);
  assert.match(wrapper, /"summary": \{\}/);
  assert.doesNotMatch(wrapper, /"summary": \{"errorCount": 1/);
});
