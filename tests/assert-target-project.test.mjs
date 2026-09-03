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
