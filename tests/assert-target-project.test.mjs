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

test("accepts this project's own production hostname", () => {
  // It used to be refused: while the VIPTel original served it, pointing here
  // at `dispecing.linkapomoci.sk` really did mean reaching the other project.
  // The owner moved the hostname on 2026-09-21, so refusing it now would fail
  // the build for naming our own production domain.
  for (const value of [
    "https://dispecing.linkapomoci.sk",
    "https://dispecing.linkapomoci.sk:443/dispatch",
    "https://DISPECING.LINKAPOMOCI.SK:8443/dispatch?view=tasks",
    "https://test.dispecing.linkapomoci.sk",
  ]) {
    assert.deepEqual(assertTargetProject({ APP_BASE_URL: value }), [], value);
  }
  const result = run({ APP_BASE_URL: "https://dispecing.linkapomoci.sk" });
  assert.equal(result.status, 0, result.stderr);
});

test("still refuses the hostname the retired application answers on", () => {
  for (const value of [
    "https://dev.dispecing.linkapomoci.sk",
    "https://DEV.DISPECING.LINKAPOMOCI.SK",
    "https://dev.dispecing.linkapomoci.sk:8443/dispatch",
    // Smuggled through user-info or a redirect rather than as the host.
    "https://dispecing.linkapomoci.sk@dev.dispecing.linkapomoci.sk",
    "https://dispecing.linkapomoci.sk/?next=https://dev.dispecing.linkapomoci.sk",
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
