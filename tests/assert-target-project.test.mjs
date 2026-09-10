import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { assertTargetProject } from "../scripts/assert-target-project.mjs";

const script = resolve("scripts/assert-target-project.mjs");

function run(env) {
  return spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

test("accepts this copy's own project", () => {
  assert.deepEqual(
    assertTargetProject({
      SUPABASE_PROJECT_REF: "ifpaeegaesdmljfkdvcn",
      SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co",
      APP_BASE_URL: "https://dispecing-test.vercel.app",
    }),
    [],
  );
  const result = run({ SUPABASE_PROJECT_REF: "ifpaeegaesdmljfkdvcn" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});

test("refuses the original production project in any inspected variable", () => {
  const problems = assertTargetProject({
    NEXT_PUBLIC_SUPABASE_URL: "https://sjcsrygkkmersoczpunh.supabase.co",
    NEXT_PUBLIC_APP_URL: "https://dev.dispecing.linkapomoci.sk",
  });
  assert.equal(problems.length, 2);
  const result = run({ SUPABASE_URL: "https://sjcsrygkkmersoczpunh.supabase.co" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to continue/);
});

test("refuses a project ref that differs from the expected one", () => {
  const problems = assertTargetProject({
    EXPECTED_SUPABASE_PROJECT_REF: "ifpaeegaesdmljfkdvcn",
    SUPABASE_PROJECT_REF: "someotherproject",
  });
  assert.equal(problems.length, 1);
});

test("accepts only the copy's exact application hostname, including an explicit port", () => {
  for (const value of [
    "https://test.dispecing.linkapomoci.sk",
    "https://test.dispecing.linkapomoci.sk:443/dispatch",
    "https://TEST.DISPECING.LINKAPOMOCI.SK:8443/dispatch?view=tasks",
  ]) {
    assert.deepEqual(assertTargetProject({ APP_BASE_URL: value }), [], value);
  }
  const result = run({ APP_BASE_URL: "https://test.dispecing.linkapomoci.sk" });
  assert.equal(result.status, 0, result.stderr);
});

test("the copy hostname cannot disguise an original or unapproved target", () => {
  for (const value of [
    "https://dispecing.linkapomoci.sk:443",
    "https://DISPECING.LINKAPOMOCI.SK",
    "https://dispecing.linkapomoci.sk.",
    "https://dev.dispecing.linkapomoci.sk",
    "https://other.test.dispecing.linkapomoci.sk",
    "https://test.dispecing.linkapomoci.sk.evil.example",
    "https://test.dispecing.linkapomoci.sk@dispecing.linkapomoci.sk:8443",
    "https://dispecing.linkapomoci.sk@test.dispecing.linkapomoci.sk",
    "https://test.dispecing.linkapomoci.sk/?next=https://dispecing.linkapomoci.sk",
    "https://%64ispecing.linkapomoci.sk",
    "dispecing.linkapomoci.sk:443",
  ]) {
    assert.equal(assertTargetProject({ APP_BASE_URL: value }).length, 1, value);
  }
});

test("the allowed copy hostname never exempts original project identifiers", () => {
  for (const value of [
    "https://sjcsrygkkmersoczpunh@test.dispecing.linkapomoci.sk",
    "https://test.dispecing.linkapomoci.sk/?project=sjcsrygkkmersoczpunh",
    "https://POMOC-MOTORISTOM-DISPECING.VERCEL.APP",
    "https://SJCSRYGKKMERSOCZPUNH.supabase.co",
  ]) {
    assert.equal(assertTargetProject({ SUPABASE_URL: value }).length, 1, value);
  }
});
